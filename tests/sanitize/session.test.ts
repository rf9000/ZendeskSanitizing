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

  test("placeholder numbering follows input order, not completion order, under concurrency", async () => {
    const pass1 = fakePass1(async (chunk) => {
      const name = chunk.text.includes("Anna") ? "Anna" : "Bo";
      if (name === "Anna") await new Promise((resolve) => setTimeout(resolve, 30));
      return spansByLiteral(chunk.text, [[name, "PERSON"]], "presidio");
    });
    const deps = base({ pass1, concurrency: 2 });
    const out = await new SanitizeSession(deps).sanitize([
      { id: "a", text: "Hilsen Anna" },
      { id: "b", text: "Hilsen Bo" },
    ]);
    expect(out.texts.get("a")).toBe("Hilsen [PERSON_1]");
    expect(out.texts.get("b")).toBe("Hilsen [PERSON_2]");
  });

  test("invalid concurrency rejects with SANITIZER_INTERNAL", async () => {
    const deps = base({ concurrency: Number.NaN });
    const err = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "hello" }]).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect(err.code).toBe("SANITIZER_INTERNAL");
  });

  test("duplicate chunk ids reject with SANITIZER_INTERNAL", async () => {
    const err = await new SanitizeSession(base())
      .sanitize([
        { id: "dup", text: "a" },
        { id: "dup", text: "b" },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect(err.code).toBe("SANITIZER_INTERNAL");
  });

  test("a session can only be used once", async () => {
    const session = new SanitizeSession(base());
    await session.sanitize([{ id: "c1", text: "hello" }]);
    const err = await session.sanitize([{ id: "c2", text: "world" }]).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect(err.code).toBe("SANITIZER_INTERNAL");
  });

  test("empty-text pieces skip the pass1 call entirely", async () => {
    const pass1 = fakePass1((c) => {
      if (c.text.length === 0) throw new Error("must not be called for empty text");
      return spansByLiteral(c.text, [["friend", "PERSON"]], "presidio");
    });
    const deps = base({ pass1 });
    const out = await new SanitizeSession(deps).sanitize([
      { id: "a", text: "" },
      { id: "b", text: "hello there friend" },
    ]);
    expect(out.texts.get("a")).toBe("");
    expect(out.texts.get("b")).toBe("hello there [PERSON_1]");
  });

  test("failure aborts in-flight sibling calls", async () => {
    let bSignal: AbortSignal | undefined;
    const pass1 = fakePass1((chunk, opts) => {
      if (chunk.id.startsWith("a")) throw new Error("boom");
      bSignal = opts.signal;
      return new Promise<ReturnType<typeof spansByLiteral>>((resolve) => {
        const timer = setTimeout(() => resolve([]), 50);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve([]);
        });
      });
    });
    const deps = base({ pass1, concurrency: 2 });
    const err = await new SanitizeSession(deps)
      .sanitize([
        { id: "a", text: "x".repeat(30) },
        { id: "b", text: "y".repeat(30) },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect(bSignal?.aborted).toBe(true);
  });

  test("a detector that ignores its AbortSignal is still cut off at the deadline", async () => {
    const neverSettles = fakePass1(() => new Promise<never>(() => {})); // ignores signal, never resolves
    const deps = base({ pass1: neverSettles, timeouts: { pass1Ms: 30, pass2Ms: 30 } });
    const started = Date.now();
    const err = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "hello there friend" }]).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect((err as SanitizerError).code).toBe("SANITIZER_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
