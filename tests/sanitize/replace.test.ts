import { describe, expect, test } from "bun:test";
import { applySpans, resolveOverlaps, splitSpansAroundRanges } from "@/sanitize/replace.ts";
import { PlaceholderTable } from "@/sanitize/placeholders.ts";
import type { Span } from "@/sanitize/types.ts";

const s = (start: number, end: number, type: Span["type"] = "PERSON", score = 0.9, source: Span["source"] = "presidio"): Span =>
  ({ start, end, type, score, source });

describe("resolveOverlaps", () => {
  test("keeps the longest of overlapping spans", () => {
    expect(resolveOverlaps([s(0, 5), s(0, 14)])).toEqual([s(0, 14)]);
  });
  test("equal length → higher score wins", () => {
    expect(resolveOverlaps([s(0, 5, "PERSON", 0.5), s(0, 5, "ORG", 0.8)])).toEqual([s(0, 5, "ORG", 0.8)]);
  });
  test("equal length and score → presidio beats gliner", () => {
    expect(resolveOverlaps([s(0, 5, "ORG", 0.8, "gliner"), s(0, 5, "PERSON", 0.8, "presidio")])).toEqual([s(0, 5, "PERSON", 0.8, "presidio")]);
  });
  test("non-overlapping spans are all kept, sorted", () => {
    expect(resolveOverlaps([s(10, 14), s(0, 5)])).toEqual([s(0, 5), s(10, 14)]);
  });
  test("an untouched span passes through even if shorter than 2 chars", () => {
    expect(resolveOverlaps([s(0, 1)])).toEqual([s(0, 1)]);
  });
  test("a partially-overlapping loser is trimmed to its remainder, not dropped whole", () => {
    // A=[0,20) beats B=[15,50) split into [15,30)+[40,50) around a protected [30,40) range;
    // A only outranks the [15,30) piece by length tie... use explicit post-split spans directly:
    expect(
      resolveOverlaps([s(0, 20, "PERSON", 0.9), s(15, 30, "ORG", 0.9), s(40, 50, "ORG", 0.9)]),
    ).toEqual([s(0, 20, "PERSON", 0.9), s(20, 30, "ORG", 0.9), s(40, 50, "ORG", 0.9)]);
  });
});

describe("applySpans", () => {
  test("replaces spans with placeholders, same value → same placeholder", () => {
    const text = "Mette Sørensen wrote. Thanks, Mette Sørensen";
    const table = new PlaceholderTable();
    const out = applySpans(text, [s(0, 14), s(30, 44)], table);
    expect(out.text).toBe("[PERSON_1] wrote. Thanks, [PERSON_1]");
    expect(out.applied).toHaveLength(2);
  });

  test("drops spans overlapping an existing placeholder token", () => {
    const text = "[PERSON_1] met Lars";
    const table = new PlaceholderTable();
    const out = applySpans(text, [s(1, 7), s(15, 19)], table);
    expect(out.text).toBe("[PERSON_1] met [PERSON_1]"); // "Lars" is first new value → PERSON_1 in this fresh table
    expect(out.applied).toHaveLength(1);
  });

  test("drops spans with invalid offsets", () => {
    const table = new PlaceholderTable();
    const out = applySpans("abc", [s(-1, 2), s(2, 10), s(2, 2)], table);
    expect(out.text).toBe("abc");
    expect(out.applied).toHaveLength(0);
  });

  test("handles multi-byte characters by JS string index", () => {
    const text = "Søren 😀 Ærø";
    const table = new PlaceholderTable();
    const out = applySpans(text, [s(0, 5), s(9, 12)], table);
    expect(out.text).toBe("[PERSON_1] 😀 [PERSON_2]");
  });
});

describe("splitSpansAroundRanges", () => {
  test("splits a span around a protected range, dropping short remainders", () => {
    // text: "group via Continia A/S" — span [0,22), protected [10,22)
    const spans = [s(0, 22, "ORG")];
    const out = splitSpansAroundRanges(spans, [[10, 22]]);
    expect(out).toEqual([s(0, 10, "ORG")]); // "group via " survives as its own span
  });
  test("a span inside a protected range disappears; an untouched span passes through", () => {
    expect(splitSpansAroundRanges([s(2, 6)], [[0, 10]])).toEqual([]);
    expect(splitSpansAroundRanges([s(20, 30)], [[0, 10]])).toEqual([s(20, 30)]);
  });
  test("a range in the middle splits a span in two", () => {
    expect(splitSpansAroundRanges([s(0, 30)], [[10, 20]])).toEqual([s(0, 10), s(20, 30)]);
  });
  test("both remainders shorter than minLen are dropped", () => {
    expect(splitSpansAroundRanges([s(0, 12)], [[1, 11]])).toEqual([]);
  });
  test("both remainders exactly at minLen are kept", () => {
    expect(splitSpansAroundRanges([s(0, 13)], [[2, 11]])).toEqual([s(0, 2), s(11, 13)]);
  });
});
