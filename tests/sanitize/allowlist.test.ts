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
});
