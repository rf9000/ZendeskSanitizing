import { Allowlist } from "@/sanitize/allowlist.ts";
import type { Chunk, Pass1Client, Span, SpanDetector } from "@/sanitize/types.ts";

/** Builds spans by literal search — handy for tests. */
export function spansByLiteral(text: string, literals: Array<[string, Span["type"]]>, source: Span["source"]): Span[] {
  const spans: Span[] = [];
  for (const [lit, type] of literals) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(lit, from);
      if (i < 0) break;
      spans.push({ start: i, end: i + lit.length, type, score: 0.9, source });
      from = i + lit.length;
    }
  }
  return spans;
}

export function fakePass1(spansFor: (chunk: Chunk) => Span[] | Promise<Span[]>): Pass1Client & { calls: Chunk[] } {
  const calls: Chunk[] = [];
  return { calls, async analyze(chunk) { calls.push(chunk); return spansFor(chunk); } };
}

export function fakeDetector(name: string, spansFor: (chunk: Chunk) => Span[] | Promise<Span[]>): SpanDetector & { calls: Chunk[] } {
  const calls: Chunk[] = [];
  return { name, calls, async detect(chunk) { calls.push(chunk); return spansFor(chunk); } };
}

export const emptyAllowlist = (): Allowlist => Allowlist.fromText("");
