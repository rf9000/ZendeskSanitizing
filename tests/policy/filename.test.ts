import { describe, expect, test } from "bun:test";
import { rejoinFilename, splitFilename, toDetectionText } from "@/policy/filename.ts";

describe("splitFilename", () => {
  test("simple extension", () => {
    expect(splitFilename("faktura_MetteSørensen.pdf")).toEqual({ stem: "faktura_MetteSørensen", ext: ".pdf" });
  });
  test("no extension at all", () => {
    expect(splitFilename("README")).toEqual({ stem: "README", ext: "" });
  });
  test("dotfile: leading dot is not treated as an extension separator", () => {
    expect(splitFilename(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
  });
  test("double extension: only the last dot separates the extension", () => {
    expect(splitFilename("a.tar.gz")).toEqual({ stem: "a.tar", ext: ".gz" });
  });
  test("trailing dot is not treated as an extension separator", () => {
    expect(splitFilename("foo.")).toEqual({ stem: "foo.", ext: "" });
  });
  test("extension boundary is constrained to a short alnum token: a space-containing tail is not an extension", () => {
    expect(splitFilename("notat.Mette Sørensen")).toEqual({ stem: "notat.Mette Sørensen", ext: "" });
  });
});

describe("toDetectionText", () => {
  test("underscore separator + camelCase boundary", () => {
    expect(toDetectionText("faktura_MetteSørensen")).toBe("faktura Mette Sørensen");
  });
  test("hyphen and underscore separators, no camelCase", () => {
    expect(toDetectionText("DC-Settings_error")).toBe("DC Settings error");
  });
  test("Danish/German uppercase letters at camelCase boundaries", () => {
    expect(toDetectionText("rapportÅrsregnskabÜbersicht")).toBe("rapport Årsregnskab Übersicht");
  });
  test("a stem that is only separators yields an empty string", () => {
    expect(toDetectionText("___")).toBe("");
    expect(toDetectionText("---")).toBe("");
    expect(toDetectionText("")).toBe("");
  });
  test("digit/letter boundaries split too, alongside camelCase", () => {
    expect(toDetectionText("Faktura2024MetteSørensen")).toBe("Faktura 2024 Mette Sørensen");
  });
});

describe("rejoinFilename", () => {
  test("collapses whitespace runs to a single underscore and appends the extension", () => {
    expect(rejoinFilename("faktura  [PERSON_1]", ".pdf")).toBe("faktura_[PERSON_1].pdf");
  });
  test("trims leading/trailing whitespace before collapsing", () => {
    expect(rejoinFilename("  rapport 2024 ", ".pdf")).toBe("rapport_2024.pdf");
  });
  test("empty extension is simply omitted", () => {
    expect(rejoinFilename("README", "")).toBe("README");
  });
});
