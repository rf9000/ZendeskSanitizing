import { describe, expect, test } from "bun:test";
import { Allowlist } from "@/sanitize/allowlist.ts";
import type { Span } from "@/sanitize/types.ts";

const list = Allowlist.fromText(`
# products
Continia
Continia Document Capture
Business Central
`);

describe("Allowlist", () => {
  test("exact match, case-insensitive", () => {
    expect(list.isAllowed("continia")).toBe(true);
    expect(list.isAllowed("BUSINESS  central")).toBe(true);
  });
  test("word-subset of a multi-word term", () => {
    expect(list.isAllowed("Document Capture")).toBe(true);
    expect(list.isAllowed("Capture")).toBe(true);
  });
  test("non-matching", () => {
    expect(list.isAllowed("Contoso")).toBe(false);
    expect(list.isAllowed("Document Capture Pro")).toBe(false);
  });
  test("filter drops allowlisted spans", () => {
    const text = "Continia and Contoso";
    const spans: Span[] = [
      { start: 0, end: 8, type: "ORG", score: 0.9, source: "presidio" },
      { start: 13, end: 20, type: "ORG", score: 0.9, source: "presidio" },
    ];
    expect(list.filter(text, spans)).toEqual([spans[1]!]);
  });
  test("loads the repo allowlist file", async () => {
    const repo = await Allowlist.fromFile("config/allowlist.txt");
    expect(repo.isAllowed("Business Central")).toBe(true);
    expect(repo.isAllowed("Zendesk")).toBe(true);
  });

  test("tightened subset rule: short/numeric single words no longer allowed", () => {
    const numeric = Allowlist.fromText("Dynamics 365\nContinia Document Capture\nBusiness Central");
    expect(numeric.isAllowed("Capture")).toBe(true); // single word, ≥4 alpha chars
    expect(numeric.isAllowed("365")).toBe(false); // numeric — was allowed via "Dynamics 365"-style terms
    expect(numeric.isAllowed("Business Central")).toBe(true); // ≥2 words
  });

  test("findOccurrences locates allowlisted terms case-insensitively with flexible whitespace", () => {
    const text = "We use BUSINESS  central and continia daily; Contoso does not.";
    const occ = Allowlist.fromText("Business Central\nContinia").findOccurrences(text);
    expect(occ).toEqual([[7, 24], [29, 37]]);
    expect(text.slice(7, 24)).toBe("BUSINESS  central");
    expect(text.slice(29, 37)).toBe("continia");
  });

  test("findOccurrences matches whole words only", () => {
    const occ = Allowlist.fromText("Continia").findOccurrences("Continias product");
    expect(occ).toEqual([]);
  });

  test("findOccurrences escapes punctuation in the term itself", () => {
    const occ = Allowlist.fromText("Continia A/S").findOccurrences("ordre fra Continia A/S i dag");
    expect(occ).toEqual([[10, 22]]);
    expect("ordre fra Continia A/S i dag".slice(10, 22)).toBe("Continia A/S");
  });
});
