import { describe, expect, test } from "bun:test";
import { applySpans, resolveOverlaps } from "@/sanitize/replace.ts";
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
