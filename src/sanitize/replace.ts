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

/**
 * Splits each span around any overlapping `ranges` (e.g. allowlisted-term occurrences), so the
 * protected text inside those ranges is never swallowed by a longer detected span. Remainders
 * shorter than `minLen` are dropped; a span untouched by any range passes through unchanged.
 */
export function splitSpansAroundRanges(spans: Span[], ranges: Array<[number, number]>, minLen = 2): Span[] {
  if (ranges.length === 0) return spans;
  const out: Span[] = [];
  for (const sp of spans) {
    let segments: Array<[number, number]> = [[sp.start, sp.end]];
    for (const [a, b] of ranges) {
      const next: Array<[number, number]> = [];
      for (const [s0, s1] of segments) {
        if (b <= s0 || s1 <= a) { next.push([s0, s1]); continue; }
        if (s0 < a) next.push([s0, a]);
        if (b < s1) next.push([b, s1]);
      }
      segments = next;
    }
    if (segments.length === 1 && segments[0]![0] === sp.start && segments[0]![1] === sp.end) { out.push(sp); continue; }
    for (const [s0, s1] of segments) if (s1 - s0 >= minLen) out.push({ ...sp, start: s0, end: s1 });
  }
  return out;
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
