import { describe, expect, test } from "bun:test";
import { codePointToUtf16Map } from "@/sanitize/offsets.ts";

describe("codePointToUtf16Map", () => {
  test("BMP-only text: identity mapping", () => {
    const text = "Hilsen Mette";
    const map = codePointToUtf16Map(text);
    expect(map).toEqual([...Array(text.length + 1).keys()]);
    expect(map.length - 1).toBe(text.length);
  });

  test("text with two emoji: offsets after them are shifted by 2", () => {
    const text = "\u{1F600}\u{1F600} Hilsen Mette Sørensen, mette.sorensen@fabrikam.dk";
    const map = codePointToUtf16Map(text);
    // 2 emoji = 2 code points, each 2 UTF-16 units -> code point index 2 (right after the emoji) is UTF-16 index 4
    expect(map[0]).toBe(0);
    expect(map[2]).toBe(4);
    // code point offsets 10..24 (from the fixture) map to the UTF-16 slice "Mette Sørensen"
    const start = map[10]!;
    const end = map[24]!;
    expect(text.slice(start, end)).toBe("Mette Sørensen");
    const emailStart = map[26]!;
    const emailEnd = map[52]!;
    expect(text.slice(emailStart, emailEnd)).toBe("mette.sorensen@fabrikam.dk");
  });

  test("empty text: [0]", () => {
    expect(codePointToUtf16Map("")).toEqual([0]);
  });
});
