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

  test("a span straddling a placeholder trims to its raw remainder instead of being dropped whole", () => {
    const text = "Hilsen [PERSON_1] Nielsen ok";
    const table = new PlaceholderTable();
    // span covers "[PERSON_1] Nielsen" (indices 7..25)
    const out = applySpans(text, [s(7, 25)], table);
    expect(out.text).toBe("Hilsen [PERSON_1] [PERSON_1] ok");
    expect(out.applied).toHaveLength(1);
    expect(text.slice(out.applied[0]!.start, out.applied[0]!.end)).toBe("Nielsen");
  });

  test("a span fully inside a placeholder has no remainder and is dropped", () => {
    const text = "Hilsen [PERSON_1] Nielsen ok";
    const table = new PlaceholderTable();
    // span covers exactly "[PERSON_1]" (indices 7..17)
    const out = applySpans(text, [s(7, 17)], table);
    expect(out.text).toBe(text);
    expect(out.applied).toHaveLength(0);
  });

  test("a span straddling a placeholder on the left trims to its raw remainder", () => {
    const text = "Hilsen [PERSON_1]";
    const table = new PlaceholderTable();
    // span covers "Hilsen [PERSON_1]" in full (indices 0..17)
    const out = applySpans(text, [s(0, 17)], table);
    expect(out.text).toBe("[PERSON_1] [PERSON_1]");
    expect(out.applied).toHaveLength(1);
    expect(text.slice(out.applied[0]!.start, out.applied[0]!.end)).toBe("Hilsen");
  });
});

describe("splitSpansAroundRanges", () => {
  test("splits a span around a protected range, dropping short remainders", () => {
    const text = "group via Continia A/S";
    // span [0,22), protected [10,22) → remainder [0,10) is "group via " which then has its
    // trailing space trimmed, leaving "group via" [0,9).
    const spans = [s(0, 22, "ORG")];
    const out = splitSpansAroundRanges(spans, [[10, 22]], text);
    expect(out).toEqual([s(0, 9, "ORG")]);
  });
  test("a span inside a protected range disappears; an untouched span passes through", () => {
    const text = "x".repeat(30);
    expect(splitSpansAroundRanges([s(2, 6)], [[0, 10]], text)).toEqual([]);
    expect(splitSpansAroundRanges([s(20, 30)], [[0, 10]], text)).toEqual([s(20, 30)]);
  });
  test("a range in the middle splits a span in two", () => {
    const text = "x".repeat(30);
    expect(splitSpansAroundRanges([s(0, 30)], [[10, 20]], text)).toEqual([s(0, 10), s(20, 30)]);
  });
  test("both remainders shorter than minLen are dropped", () => {
    const text = "x".repeat(12);
    expect(splitSpansAroundRanges([s(0, 12)], [[1, 11]], text)).toEqual([]);
  });
  test("both remainders exactly at minLen are kept", () => {
    const text = "x".repeat(13);
    expect(splitSpansAroundRanges([s(0, 13)], [[2, 11]], text)).toEqual([s(0, 2), s(11, 13)]);
  });
  test("a remainder that is whitespace-only is dropped", () => {
    const text = "   abcdefg"; // remainder [0,3) is all spaces
    expect(splitSpansAroundRanges([s(0, 10)], [[3, 10]], text)).toEqual([]);
  });
  test("a remainder with leading/trailing whitespace is shrunk to the non-whitespace core", () => {
    const text = "aa   bb"; // range [2,3) removes one space, leaving remainders "aa" and "  bb"
    expect(splitSpansAroundRanges([s(0, 7)], [[2, 3]], text)).toEqual([s(0, 2), s(5, 7)]);
  });
});
