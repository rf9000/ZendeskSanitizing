import { PLACEHOLDER_RE, type PlaceholderTable } from "./placeholders.ts";
import type { Span, SpanSource } from "./types.ts";

const SOURCE_RANK: Record<SpanSource, number> = { presidio: 0, gliner: 1, ollama: 2 };

export function resolveOverlaps(spans: Span[]): Span[] {
  const ranked = [...spans].sort((a, b) =>
    (b.end - b.start) - (a.end - a.start) ||
    b.score - a.score ||
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    a.start - b.start,
  );
  const kept: Span[] = [];
  for (const sp of ranked) {
    if (!kept.some((k) => sp.start < k.end && k.start < sp.end)) kept.push(sp);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function placeholderRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

export function applySpans(text: string, spans: Span[], table: PlaceholderTable): { text: string; applied: Span[] } {
  const protectedRanges = placeholderRanges(text);
  const valid = spans.filter(
    (sp) =>
      Number.isInteger(sp.start) && Number.isInteger(sp.end) &&
      sp.start >= 0 && sp.end <= text.length && sp.end > sp.start &&
      !protectedRanges.some(([a, b]) => sp.start < b && a < sp.end),
  );
  const applied = resolveOverlaps(valid);
  let out = text;
  // Assign placeholders left-to-right (stable numbering), replace right-to-left (stable offsets).
  const replacements = applied.map((sp) => table.placeholderFor(sp.type, text.slice(sp.start, sp.end)));
  for (let i = applied.length - 1; i >= 0; i--) {
    const sp = applied[i]!;
    out = out.slice(0, sp.start) + replacements[i]! + out.slice(sp.end);
  }
  return { text: out, applied };
}
