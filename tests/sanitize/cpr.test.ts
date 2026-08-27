import { describe, expect, test } from "bun:test";
import { isValidCpr, loadRecognizers } from "@/sanitize/cpr.ts";

describe("isValidCpr", () => {
  test("accepts date-valid numbers with and without hyphen", () => {
    expect(isValidCpr("010190-1234")).toBe(true);
    expect(isValidCpr("0101901234")).toBe(true);
    expect(isValidCpr("311299-0001")).toBe(true);
  });
  test("century digit: 4 with yy<=36 → 2000s (leap year 2004 ok)", () => {
    expect(isValidCpr("290204-4567")).toBe(true);   // 29 Feb 2004
    expect(isValidCpr("290203-4567")).toBe(false);  // 29 Feb 2003 does not exist
  });
  test("century digit: 0-3 → 1900s (1900 is not a leap year)", () => {
    expect(isValidCpr("290200-1234")).toBe(false);
    expect(isValidCpr("290296-1234")).toBe(true);
  });
  test("rejects impossible dates and wrong shapes", () => {
    expect(isValidCpr("320190-1234")).toBe(false);
    expect(isValidCpr("011390-1234")).toBe(false);
    expect(isValidCpr("000190-1234")).toBe(false);
    expect(isValidCpr("12345678")).toBe(false);
    expect(isValidCpr("01019O-1234")).toBe(false);
  });
});

describe("loadRecognizers", () => {
  test("loads cpr and dk-phone definitions", async () => {
    const recs = await loadRecognizers("config/recognizers");
    const names = recs.map((r) => r.name).sort();
    expect(names).toEqual(["DK_CPR", "DK_PHONE"]);
    const cpr = recs.find((r) => r.name === "DK_CPR")!;
    expect(cpr.supported_entity).toBe("DK_CPR");
    expect(new RegExp(cpr.patterns[0]!.regex).test("010190-1234")).toBe(true);
  });
});
