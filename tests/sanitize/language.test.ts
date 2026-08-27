import { describe, expect, test } from "bun:test";
import { detectLang } from "@/sanitize/language.ts";

describe("detectLang", () => {
  test("Danish", () => {
    expect(detectLang("Hej, jeg har et problem med Document Capture, den kan ikke læse fakturaen fra vores leverandør.")).toBe("da");
  });
  test("German", () => {
    expect(detectLang("Guten Tag, wir haben ein Problem mit der Rechnungserkennung und bitten um Unterstützung.")).toBe("de");
  });
  test("English", () => {
    expect(detectLang("Hello, the invoice import fails with an error after the latest update, please advise.")).toBe("en");
  });
  test("short or empty text falls back to en", () => {
    expect(detectLang("Hej Mette")).toBe("en");
    expect(detectLang("")).toBe("en");
  });
});
