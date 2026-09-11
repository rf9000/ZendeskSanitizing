import { codePointToUtf16Map } from "../offsets.ts";
import { SanitizerError, type Chunk, type EntityType, type Span, type SpanDetector } from "../types.ts";

export interface GlinerConfig {
  threshold: number;
  labels: string[];
  labelMap: Record<string, EntityType>;
}

export async function loadGlinerConfig(path: string): Promise<GlinerConfig> {
  const raw = (await Bun.file(path).json()) as Partial<GlinerConfig>;
  if (
    typeof raw.threshold !== "number" || raw.threshold <= 0 ||
    !Array.isArray(raw.labels) || raw.labels.length === 0 ||
    typeof raw.labelMap !== "object" || raw.labelMap === null
  ) {
    throw new Error(`invalid gliner config at ${path}`);
  }
  return raw as GlinerConfig;
}

interface GlinerSpan { start: number; end: number; label: string; score: number }

export interface GlinerDetectorOptions { baseUrl: string; config: GlinerConfig; fetchImpl?: typeof fetch }

export class GlinerDetector implements SpanDetector {
  readonly name = "gliner";
  private readonly baseUrl: string;
  private readonly config: GlinerConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GlinerDetectorOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async detect(chunk: Chunk, { signal }: { signal: AbortSignal }): Promise<Span[]> {
    if (chunk.text.length === 0) return [];
    let body: unknown;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/detect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: chunk.text, labels: this.config.labels, threshold: this.config.threshold }),
        signal,
      });
      if (!res.ok) throw new SanitizerError("SANITIZER_UNAVAILABLE", `gliner returned HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      if (e instanceof SanitizerError) throw e;
      throw new SanitizerError("SANITIZER_UNAVAILABLE", `gliner unreachable: ${e instanceof Error ? e.name : typeof e}`);
    }
    const spansRaw = (body as { spans?: unknown })?.spans;
    if (!Array.isArray(spansRaw)) throw new SanitizerError("SANITIZER_UNAVAILABLE", "gliner returned a malformed body");

    const map = codePointToUtf16Map(chunk.text);
    const spans: Span[] = [];
    for (const r of spansRaw as GlinerSpan[]) {
      const type = this.config.labelMap[r?.label];
      if (!type) continue;
      if (typeof r.score !== "number" || r.score < this.config.threshold) continue;
      if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end > map.length - 1 || r.end <= r.start) continue;
      spans.push({ start: map[r.start]!, end: map[r.end]!, type, score: r.score, source: "gliner" });
    }
    return spans;
  }
}

export async function verifyGlinerSidecar(baseUrl: string, expectedModelRef: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const [repo, revision] = expectedModelRef.split("@");
  let body: { model_id?: string; revision?: string };
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/healthz`);
    if (!res.ok) throw new SanitizerError("SANITIZER_UNAVAILABLE", `gliner healthz returned HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (e) {
    if (e instanceof SanitizerError) throw e;
    throw new SanitizerError("SANITIZER_UNAVAILABLE", "gliner sidecar unreachable");
  }
  if (body.model_id !== repo || body.revision !== revision) {
    throw new SanitizerError("SANITIZER_UNAVAILABLE", "gliner sidecar model/revision does not match the pinned ZSAN_GLINER_MODEL_REF");
  }
}
