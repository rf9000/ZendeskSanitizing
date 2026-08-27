import type { Allowlist } from "./allowlist.ts";
import { splitText } from "./chunking.ts";
import { detectLang as defaultDetectLang } from "./language.ts";
import { PlaceholderTable } from "./placeholders.ts";
import { applySpans } from "./replace.ts";
import { SanitizerError, emptyCounts, type Chunk, type Counts, type Lang, type Pass1Client, type Span, type SpanDetector } from "./types.ts";

export interface SessionDeps {
  pass1: Pass1Client;
  pass2: SpanDetector | null;
  allowlist: Allowlist;
  detectLang?: (text: string) => Lang;
  timeouts: { pass1Ms: number; pass2Ms: number };
  chunkMaxChars: number;
  concurrency: number;
}

export interface SanitizeOutput {
  texts: Map<string, string>;
  counts: Counts;
  perPass: { pass1: number; pass2: number };
}

export class SanitizeSession {
  private readonly table = new PlaceholderTable();
  private readonly counts = emptyCounts();
  private readonly perPass = { pass1: 0, pass2: 0 };
  private readonly detectLang: (text: string) => Lang;

  constructor(private readonly deps: SessionDeps) {
    this.detectLang = deps.detectLang ?? defaultDetectLang;
  }

  async sanitize(chunks: Chunk[]): Promise<SanitizeOutput> {
    const texts = new Map<string, string>();
    const queue = [...chunks];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) texts.set(c.id, await this.sanitizeChunk(c));
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, this.deps.concurrency) }, worker));
    } catch (e) {
      if (e instanceof SanitizerError) throw e;
      throw new SanitizerError("SANITIZER_INTERNAL", `unexpected ${(e as Error).name}`);
    }
    return { texts, counts: this.counts, perPass: this.perPass };
  }

  private async sanitizeChunk(chunk: Chunk): Promise<string> {
    const lang = chunk.lang ?? this.detectLang(chunk.text);
    const pieces = splitText(chunk.text, this.deps.chunkMaxChars);
    const out: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece: Chunk = { id: `${chunk.id}#${i}`, text: pieces[i]!, lang };
      out.push(await this.sanitizePiece(piece));
    }
    return out.join("");
  }

  private async sanitizePiece(piece: Chunk): Promise<string> {
    const spans1 = await this.withTimeout(this.deps.timeouts.pass1Ms, (signal) => this.deps.pass1.analyze(piece, { signal }));
    const step1 = this.apply(piece.text, spans1);
    this.perPass.pass1 += step1.applied.length;
    if (!this.deps.pass2) return step1.text;

    const piece2: Chunk = { ...piece, text: step1.text };
    const spans2 = await this.withTimeout(this.deps.timeouts.pass2Ms, (signal) => this.deps.pass2!.detect(piece2, { signal }));
    const step2 = this.apply(step1.text, spans2);
    this.perPass.pass2 += step2.applied.length;
    return step2.text;
  }

  private apply(text: string, spans: Span[]) {
    const result = applySpans(text, this.deps.allowlist.filter(text, spans), this.table);
    for (const sp of result.applied) this.counts[sp.type]++;
    return result;
  }

  private async withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await Promise.race([
        fn(controller.signal),
        new Promise<never>((_r, rej) => controller.signal.addEventListener("abort", () => rej(new SanitizerError("SANITIZER_UNAVAILABLE", `sanitizer call exceeded ${ms}ms`)))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
