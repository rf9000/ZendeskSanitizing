import { describe, expect, test } from "bun:test";
import { splitText } from "@/sanitize/chunking.ts";

describe("splitText", () => {
  test("returns the whole text when under the cap", () => {
    expect(splitText("short", 100)).toEqual(["short"]);
  });

  test("is lossless and respects the cap", () => {
    const para = "Hej Mette. Tak for din mail! Vi kigger på det? Ja.\n\n";
    const text = para.repeat(20);
    const pieces = splitText(text, 120);
    expect(pieces.join("")).toBe(text);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(120);
  });

  test("prefers paragraph boundaries over sentence boundaries", () => {
    const text = "Sentence one. Sentence two.\n\nSentence three. Sentence four.";
    const pieces = splitText(text, 35);
    expect(pieces).toEqual(["Sentence one. Sentence two.\n\n", "Sentence three. Sentence four."]);
  });

  test("falls back to sentence, then space, then hard cut", () => {
    expect(splitText("One two. Three four.", 12)).toEqual(["One two. ", "Three four."]);
    expect(splitText("aaaa bbbb cccc", 9)).toEqual(["aaaa ", "bbbb cccc"]); // "bbbb cccc" is exactly 9 → fits
    expect(splitText("aaaa bbbb cccc", 8)).toEqual(["aaaa ", "bbbb ", "cccc"]);
    expect(splitText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("empty string → single empty piece", () => {
    expect(splitText("", 10)).toEqual([""]);
  });
});
