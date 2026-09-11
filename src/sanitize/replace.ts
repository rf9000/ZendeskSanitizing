import { PLACEHOLDER_RE, type PlaceholderTable } from "./placeholders.ts";
import type { Span, SpanSource } from "./types.ts";

const SOURCE_RANK: Record<SpanSource, number> = { presidio: 0, gliner: 1, ollama: 2 };

/** Subtracts `ranges` from `interval`, returning the surviving (possibly empty) sub-intervals. */
function subtractRanges(interval: [number, number], ranges: Array<[number, number]>): Array<[number, number]> {
  let segments: Array<[number, number]> = [interval];
  for (const [a, b] of ranges) {
    const next: Array<[number, number]> = [];
    for (const [s0, s1] of segments) {
      if (b <= s0 || s1 <= a) { next.push([s0, s1]); continue; }
      if (s0 < a) next.push([s0, a]);
      if (b < s1) next.push([b, s1]);
    }
    segments = next;
  }
  return segments;
}

/**
 * Rank-ordered greedy resolution: a higher-ranked span always wins its full range. A lower-ranked
 * span that only *partially* overlaps already-kept spans is trimmed to its non-overlapping
 * remainder(s) — rather than dropped whole — so no character covered by any input span goes
 * unredacted merely because a longer/stronger span happened to cover part of it. A span fully
 * contained within already-kept spans has no remainder and is dropped, as before. Remainders
 * shorter than 2 chars are dropped (consistent with `splitSpansAroundRanges`'s default `minLen`).
 */
export function resolveOverlaps(spans: Span[]): Span[] {
  const ranked = [...spans].sort((a, b) =>
    (b.end - b.start) - (a.end - a.start) ||
    b.score - a.score ||
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    a.start - b.start,
  );
  const kept: Span[] = [];
  for (const sp of ranked) {
    const keptRanges: Array<[number, number]> = kept.map((k) => [k.start, k.end]);
    const segments = subtractRanges([sp.start, sp.end], keptRanges);
    // A span untouched by any already-kept range passes through unchanged, however short — the
    // same full-segment passthrough `splitSpansAroundRanges` gives an untouched span. Only a
    // *trimmed* remainder (from a partial overlap) is subject to the 2-char minimum below.
    if (segments.length === 1 && segments[0]![0] === sp.start && segments[0]![1] === sp.end) {
      kept.push(sp);
      continue;
    }
    for (const [s0, s1] of segments) {
      if (s1 - s0 >= 2) kept.push({ ...sp, start: s0, end: s1 });
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

function placeholderRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** Shrinks `[start, end)` so it neither starts nor ends with whitespace, per `text`. */
function trimWhitespace(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return [start, end];
}

/**
 * Splits each span around any overlapping `ranges` (e.g. allowlisted-term occurrences or existing
 * `[TYPE_n]` placeholder tokens), so the protected text inside those ranges is never swallowed by
 * a longer detected span. Each remainder is then shrunk so it does not start or end with
 * whitespace (e.g. splitting "[PERSON_1] Nielsen" around the placeholder leaves " Nielsen", which
 * is trimmed to "Nielsen"). Remainders shorter than `minLen` (after trimming) are dropped; a span
 * untouched by any range passes through unchanged.
 */
export function splitSpansAroundRanges(spans: Span[], ranges: Array<[number, number]>, text: string, minLen = 2): Span[] {
  if (ranges.length === 0) return spans;
  const out: Span[] = [];
  for (const sp of spans) {
    const segments = subtractRanges([sp.start, sp.end], ranges);
    if (segments.length === 1 && segments[0]![0] === sp.start && segments[0]![1] === sp.end) { out.push(sp); continue; }
    for (const [rawS0, rawS1] of segments) {
      const [s0, s1] = trimWhitespace(text, rawS0, rawS1);
      if (s1 - s0 >= minLen) out.push({ ...sp, start: s0, end: s1 });
    }
  }
  return out;
}

export function applySpans(text: string, spans: Span[], table: PlaceholderTable): { text: string; applied: Span[] } {
  const protectedRanges = placeholderRanges(text);
  const valid = spans.filter(
    (sp) =>
      Number.isInteger(sp.start) && Number.isInteger(sp.end) &&
      sp.start >= 0 && sp.end <= text.length && sp.end > sp.start,
  );
  // A span overlapping an existing placeholder token is trimmed to its non-placeholder
  // remainder(s), not dropped whole — a pass-2 span like "[PERSON_1] Nielsen" must still redact
  // the raw "Nielsen" part. A span fully inside a placeholder yields no remainder and disappears.
  const trimmed = splitSpansAroundRanges(valid, protectedRanges, text);
  const applied = resolveOverlaps(trimmed);
  let out = text;
  // Assign placeholders left-to-right (stable numbering), replace right-to-left (stable offsets).
  const replacements = applied.map((sp) => table.placeholderFor(sp.type, text.slice(sp.start, sp.end)));
  for (let i = applied.length - 1; i >= 0; i--) {
    const sp = applied[i]!;
    out = out.slice(0, sp.start) + replacements[i]! + out.slice(sp.end);
  }
  return { text: out, applied };
}
