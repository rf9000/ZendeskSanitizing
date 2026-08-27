import { describe, expect, test } from "bun:test";
import { PlaceholderTable, normalizeValue, PLACEHOLDER_RE } from "@/sanitize/placeholders.ts";

describe("normalizeValue", () => {
  test("trims, casefolds, collapses whitespace, NFC", () => {
    expect(normalizeValue("  Mette   SØRENSEN ")).toBe("mette sørensen");
    expect(normalizeValue("Métte")).toBe("métte"); // combining accent → precomposed
  });
});

describe("PlaceholderTable", () => {
  test("numbers per type from 1 in order of first use", () => {
    const t = new PlaceholderTable();
    expect(t.placeholderFor("PERSON", "Mette Sørensen")).toBe("[PERSON_1]");
    expect(t.placeholderFor("EMAIL", "mette@example.dk")).toBe("[EMAIL_1]");
    expect(t.placeholderFor("PERSON", "Lars Nielsen")).toBe("[PERSON_2]");
  });

  test("same normalized value → same placeholder", () => {
    const t = new PlaceholderTable();
    t.placeholderFor("PERSON", "Mette Sørensen");
    expect(t.placeholderFor("PERSON", "mette  sørensen")).toBe("[PERSON_1]");
  });

  test("word-subset of an existing same-type value reuses it", () => {
    const t = new PlaceholderTable();
    t.placeholderFor("PERSON", "Mette Sørensen");
    expect(t.placeholderFor("PERSON", "Mette")).toBe("[PERSON_1]");
    expect(t.placeholderFor("PERSON", "Sørensen")).toBe("[PERSON_1]");
  });

  test("subset matching ignores single-character words and is type-isolated", () => {
    const t = new PlaceholderTable();
    t.placeholderFor("PERSON", "M Sørensen");
    expect(t.placeholderFor("PERSON", "M")).toBe("[PERSON_2]");
    expect(t.placeholderFor("ORG", "Sørensen")).toBe("[ORG_1]");
  });

  test("a later longer value does not retroactively merge", () => {
    const t = new PlaceholderTable();
    t.placeholderFor("PERSON", "Mette");
    expect(t.placeholderFor("PERSON", "Mette Sørensen")).toBe("[PERSON_2]");
  });

  test("PLACEHOLDER_RE matches all types and only well-formed tokens", () => {
    const text = "[PERSON_1] [ORG_12] [EMAIL_3] [FOO_1] [PERSON_]";
    expect(text.match(PLACEHOLDER_RE)).toEqual(["[PERSON_1]", "[ORG_12]", "[EMAIL_3]"]);
  });
});
