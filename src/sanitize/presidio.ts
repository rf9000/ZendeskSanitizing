import { isValidCpr, type AdHocRecognizer } from "./cpr.ts";
import { codePointToUtf16Map } from "./offsets.ts";
import { SanitizerError, type Chunk, type EntityType, type Pass1Client, type Span } from "./types.ts";

export const PRESIDIO_ENTITY_MAP: Record<string, EntityType> = {
  PERSON: "PERSON",
  EMAIL_ADDRESS: "EMAIL",
  PHONE_NUMBER: "PHONE",
  DK_PHONE: "PHONE",
  INTL_PHONE: "PHONE",
  IBAN_CODE: "IBAN",
  CREDIT_CARD: "CARD",
  DK_CPR: "CPR",
};

const NER_TYPES = new Set<EntityType>(["PERSON", "ORG"]);

export interface PresidioClientOptions {
  baseUrl: string;
  recognizers: AdHocRecognizer[];
  nerThreshold?: number;
  patternThreshold?: number;
  fetchImpl?: typeof fetch;
}

interface PresidioResult { entity_type: string; start: number; end: number; score: number }

export class PresidioClient implements Pass1Client {
  private readonly opts: Required<PresidioClientOptions>;

  constructor(opts: PresidioClientOptions) {
    this.opts = {
      nerThreshold: 0.4,
      patternThreshold: 0.7,
      fetchImpl: fetch,
      ...opts,
      baseUrl: opts.baseUrl.replace(/\/$/, ""),
    };
  }

  async analyze(chunk: Chunk, { signal }: { signal: AbortSignal }): Promise<Span[]> {
    if (chunk.text.length === 0) return []; // Presidio returns HTTP 500 for text: "" — belt and braces alongside the session-level skip
    const language = chunk.lang ?? "en";
    const body = {
      text: chunk.text,
      language,
      ad_hoc_recognizers: this.opts.recognizers.map((r) => ({ ...r, supported_language: language })),
      return_decision_process: false,
    };

    let results: unknown;
    try {
      const res = await this.opts.fetchImpl(`${this.opts.baseUrl}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new SanitizerError("SANITIZER_UNAVAILABLE", `presidio analyze returned HTTP ${res.status}`);
      results = await res.json();
    } catch (e) {
      if (e instanceof SanitizerError) throw e;
      throw new SanitizerError("SANITIZER_UNAVAILABLE", `presidio unreachable: ${(e as Error).name}`);
    }
    if (!Array.isArray(results)) throw new SanitizerError("SANITIZER_UNAVAILABLE", "presidio returned a non-array body");

    // Presidio reports offsets as Unicode code points; translate to UTF-16 indices before slicing.
    const map = codePointToUtf16Map(chunk.text);
    const spans: Span[] = [];
    for (const r of results as PresidioResult[]) {
      const type = PRESIDIO_ENTITY_MAP[r.entity_type];
      if (!type) continue;
      const threshold = NER_TYPES.has(type) ? this.opts.nerThreshold : this.opts.patternThreshold;
      if (typeof r.score !== "number" || r.score < threshold) continue;
      if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end > map.length - 1 || r.end <= r.start) continue;
      const start = map[r.start]!;
      const end = map[r.end]!;
      if (type === "CPR" && !isValidCpr(chunk.text.slice(start, end))) continue;
      spans.push({ start, end, type, score: r.score, source: "presidio" });
    }
    return spans;
  }
}
