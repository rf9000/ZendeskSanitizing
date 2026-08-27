import { describe, expect, test } from "bun:test";
import { SanitizeSession, type SessionDeps } from "@/sanitize/session.ts";
import { Allowlist } from "@/sanitize/allowlist.ts";
import { SanitizerError } from "@/sanitize/types.ts";
import { emptyAllowlist, fakeDetector, fakePass1, spansByLiteral } from "../helpers/fakes.ts";

const base = (over: Partial<SessionDeps> = {}): SessionDeps => ({
  pass1: fakePass1(() => []),
  pass2: null,
  allowlist: emptyAllowlist(),
  detectLang: () => "da",
  timeouts: { pass1Ms: 1000, pass2Ms: 1000 },
  chunkMaxChars: 6000,
  concurrency: 2,
  ...over,
});

describe("SanitizeSession", () => {
  test("pass 1 only: replaces and counts, placeholders stable across chunks", async () => {
    const deps = base({ pass1: fakePass1((c) => spansByLiteral(c.text, [["Mette Sørensen", "PERSON"], ["mette@example.dk", "EMAIL"]], "presidio")) });
    const out = await new SanitizeSession(deps).sanitize([
      { id: "subject", text: "Fra Mette Sørensen" },
      { id: "c1", text: "Mette Sørensen <mette@example.dk> skrev" },
    ]);
    expect(out.texts.get("subject")).toBe("Fra [PERSON_1]");
    expect(out.texts.get("c1")).toBe("[PERSON_1] <[EMAIL_1]> skrev");
    expect(out.counts.PERSON).toBe(2);
    expect(out.counts.EMAIL).toBe(1);
    expect(out.perPass).toEqual({ pass1: 3, pass2: 0 });
  });

  test("pass 2 runs on pass-1 output and shares the table", async () => {
    const deps = base({
      pass1: fakePass1((c) => spansByLiteral(c.text, [["Mette Sørensen", "PERSON"]], "presidio")),
      pass2: fakeDetector("fake", (c) => spansByLiteral(c.text, [["Mette", "PERSON"], ["Vestergade 12", "ADDRESS"]], "gliner")),
    });
    const out = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "Mette Sørensen bor på Vestergade 12. Hilsen Mette" }]);
    expect(out.texts.get("c1")).toBe("[PERSON_1] bor på [ADDRESS_1]. Hilsen [PERSON_1]");
    expect((deps.pass2 as any).calls[0].text).toBe("[PERSON_1] bor på Vestergade 12. Hilsen Mette");
    expect(out.perPass).toEqual({ pass1: 1, pass2: 2 });
  });

  test("allowlist filters spans from both passes", async () => {
    const deps = base({
      allowlist: Allowlist.fromText("Continia"),
      pass1: fakePass1((c) => spansByLiteral(c.text, [["Continia", "ORG"]], "presidio")),
      pass2: fakeDetector("fake", (c) => spansByLiteral(c.text, [["Continia", "ORG"]], "gliner")),
    });
    const out = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "Continia Document Capture" }]);
    expect(out.texts.get("c1")).toBe("Continia Document Capture");
    expect(out.counts.ORG).toBe(0);
  });

  test("passes detected language to pass 1 and splits long text losslessly", async () => {
    const pass1 = fakePass1(() => []);
    const deps = base({ pass1, chunkMaxChars: 50 });
    const text = "Første afsnit her.\n\n".repeat(10);
    const out = await new SanitizeSession(deps).sanitize([{ id: "c1", text }]);
    expect(out.texts.get("c1")).toBe(text);
    expect(pass1.calls.length).toBeGreaterThan(1);
    expect(pass1.calls.every((c) => c.lang === "da")).toBe(true);
  });

  test("pass 1 timeout → SANITIZER_UNAVAILABLE", async () => {
    const pass1 = fakePass1((_c) => new Promise<never>((_res, rej) => setTimeout(() => rej(new SanitizerError("SANITIZER_UNAVAILABLE", "aborted")), 50)));
    const deps = base({ pass1, timeouts: { pass1Ms: 10, pass2Ms: 10 } });
    const err = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "x".repeat(30) }]).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect(err.code).toBe("SANITIZER_UNAVAILABLE");
  });

  test("unexpected exception → SANITIZER_INTERNAL", async () => {
    const deps = base({ pass1: fakePass1(() => { throw new RangeError("bug"); }) });
    const err = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "hello there friend" }]).catch((e) => e);
    expect(err.code).toBe("SANITIZER_INTERNAL");
  });

  test("empty chunk list → empty output", async () => {
    const out = await new SanitizeSession(base()).sanitize([]);
    expect(out.texts.size).toBe(0);
    expect(out.perPass).toEqual({ pass1: 0, pass2: 0 });
  });
});
