import { describe, expect, test } from "bun:test";
import { GlinerDetector, loadGlinerConfig, verifyGlinerSidecar } from "@/sanitize/detectors/gliner.ts";
import { SanitizerError } from "@/sanitize/types.ts";

const config = {
  threshold: 0.4,
  labels: ["person name", "street address"],
  labelMap: { "person name": "PERSON" as const, "street address": "ADDRESS" as const },
};

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;
}

describe("GlinerDetector", () => {
  test("posts text, labels and threshold; maps labels to entity types; source gliner", async () => {
    let seen: { url: string; body: any } | undefined;
    const TEXT = "Mette bor på Vestergade 12";
    const d = new GlinerDetector({
      baseUrl: "http://gliner:8000", config,
      fetchImpl: fakeFetch((url, init) => {
        seen = { url, body: JSON.parse(String(init?.body)) };
        return Response.json({ spans: [
          { start: 0, end: 5, label: "person name", score: 0.9 },
          { start: 13, end: 26, label: "street address", score: 0.8 },
          { start: 6, end: 9, label: "unknown label", score: 0.9 },
        ] });
      }),
    });
    const spans = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal });
    expect(seen!.url).toBe("http://gliner:8000/detect");
    expect(seen!.body).toEqual({ text: TEXT, labels: config.labels, threshold: 0.4 });
    expect(spans.map((s) => [s.type, TEXT.slice(s.start, s.end)])).toEqual([
      ["PERSON", "Mette"],
      ["ADDRESS", "Vestergade 12"],
    ]);
    expect(spans.every((s) => s.source === "gliner")).toBe(true);
  });

  test("translates code-point offsets to UTF-16 (emoji before the span)", async () => {
    const TEXT = "😀😀 Hilsen Mette Sørensen";
    // code points: 😀=1 each → "Mette Sørensen" is cp [10,24); UTF-16 [12,26)
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [{ start: 10, end: 24, label: "person name", score: 0.9 }] })),
    });
    const spans = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal });
    expect(TEXT.slice(spans[0]!.start, spans[0]!.end)).toBe("Mette Sørensen");
  });

  test("drops malformed spans (missing/non-integer/out-of-range offsets, bad score)", async () => {
    // 16 valid 1-char spans + 4 malformed = 20 total, exactly at the 20% breaker boundary (not >20%).
    const TEXT = "abcdefghijklmnopqrstuvwxyz0123456789";
    const validSpans = Array.from({ length: 16 }, (_, i) => ({ start: i, end: i + 1, label: "person name", score: 0.9 }));
    const malformedSpans = [
      { end: 3, label: "person name", score: 0.9 },
      { start: "1", end: 3, label: "person name", score: 0.9 },
      { start: 2, end: 99, label: "person name", score: 0.9 },
      { start: 0, end: 3, label: "person name", score: "high" },
    ];
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [...validSpans, ...malformedSpans] })),
    });
    const spans = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal });
    expect(spans).toHaveLength(16);
  });

  test("throws SANITIZER_INVALID_OUTPUT when >20% of returned spans are malformed (totalReturnedSpans >= 5)", async () => {
    const TEXT = "abcdefghijklmnopqrstuvwxyz0123456789";
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [
        { start: 0, end: 3, label: "person name", score: 0.9 },
        { start: 4, end: 7, label: "person name", score: 0.9 },
        { start: 8, end: 11, label: "person name", score: 0.9 },
        { end: 3, label: "person name", score: 0.9 }, // malformed: missing start
        { start: "1", end: 3, label: "person name", score: 0.9 }, // malformed: non-integer start
        { start: 2, end: 99, label: "person name", score: 0.9 }, // malformed: out-of-range end
      ] })),
    });
    const err = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect((err as SanitizerError).code).toBe("SANITIZER_INVALID_OUTPUT");
  });

  test("resolves with the valid spans when malformed share is at or below 20% (1 of 6)", async () => {
    const TEXT = "abcdefghijklmnopqrstuvwxyz0123456789";
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [
        { start: 0, end: 3, label: "person name", score: 0.9 },
        { start: 4, end: 7, label: "person name", score: 0.9 },
        { start: 8, end: 11, label: "person name", score: 0.9 },
        { start: 12, end: 15, label: "person name", score: 0.9 },
        { start: 16, end: 19, label: "person name", score: 0.9 },
        { end: 3, label: "person name", score: 0.9 }, // malformed: missing start
      ] })),
    });
    const spans = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal });
    expect(spans).toHaveLength(5);
  });

  test("below-threshold and unmapped-label drops never count toward the malformed circuit breaker", async () => {
    const TEXT = "abcdefghijklmnopqrstuvwxyz0123456789";
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [
        { start: 0, end: 3, label: "person name", score: 0.9 },
        { start: 4, end: 7, label: "person name", score: 0.2 }, // below threshold
        { start: 8, end: 11, label: "unknown label", score: 0.9 }, // unmapped label
        { start: 12, end: 15, label: "person name", score: 0.2 }, // below threshold
        { start: 16, end: 19, label: "unknown label", score: 0.9 }, // unmapped label
      ] })),
    });
    const spans = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal });
    expect(spans).toHaveLength(1);
  });

  test("below-threshold spans are dropped client-side too", async () => {
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [{ start: 0, end: 3, label: "person name", score: 0.2 }] })),
    });
    expect(await d.detect({ id: "c", text: "abcdef" }, { signal: new AbortController().signal })).toEqual([]);
  });

  test("empty text short-circuits without a network call", async () => {
    let called = false;
    const d = new GlinerDetector({ baseUrl: "http://g", config, fetchImpl: fakeFetch(() => { called = true; return Response.json({ spans: [] }); }) });
    expect(await d.detect({ id: "c", text: "" }, { signal: new AbortController().signal })).toEqual([]);
    expect(called).toBe(false);
  });

  test("non-2xx / network error / non-object body → SANITIZER_UNAVAILABLE", async () => {
    for (const impl of [
      fakeFetch(() => new Response("boom", { status: 500 })),
      fakeFetch(() => { throw new TypeError("fetch failed"); }),
      fakeFetch(() => Response.json([1, 2])),
    ]) {
      const d = new GlinerDetector({ baseUrl: "http://g", config, fetchImpl: impl });
      const err = await d.detect({ id: "c", text: "abc def ghi" }, { signal: new AbortController().signal }).catch((e) => e);
      expect(err).toBeInstanceOf(SanitizerError);
      expect((err as SanitizerError).code).toBe("SANITIZER_UNAVAILABLE");
    }
  });
});

describe("verifyGlinerSidecar", () => {
  test("passes on matching model ref", async () => {
    await verifyGlinerSidecar("http://g", "repo/x@abc",
      fakeFetch(() => Response.json({ model_id: "repo/x", revision: "abc", status: "ok" })));
  });
  test("throws SANITIZER_UNAVAILABLE on mismatch and on unreachable", async () => {
    for (const impl of [
      fakeFetch(() => Response.json({ model_id: "repo/x", revision: "OTHER", status: "ok" })),
      fakeFetch(() => { throw new TypeError("fetch failed"); }),
    ]) {
      const err = await verifyGlinerSidecar("http://g", "repo/x@abc", impl).catch((e) => e);
      expect((err as SanitizerError).code).toBe("SANITIZER_UNAVAILABLE");
    }
  });
});

describe("loadGlinerConfig", () => {
  test("loads the repo config and validates shape", async () => {
    const c = await loadGlinerConfig("config/gliner.json");
    expect(c.threshold).toBeGreaterThan(0);
    expect(c.labels.length).toBeGreaterThan(0);
    for (const label of Object.keys(c.labelMap)) expect(c.labels).toContain(label);
  });
});
