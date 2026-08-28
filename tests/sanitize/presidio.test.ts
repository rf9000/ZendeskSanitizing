import { describe, expect, test } from "bun:test";
import { PresidioClient, PRESIDIO_ENTITY_MAP } from "@/sanitize/presidio.ts";
import { SanitizerError } from "@/sanitize/types.ts";
import type { AdHocRecognizer } from "@/sanitize/cpr.ts";
import recorded from "../fixtures/presidio/analyze-da.json";

//           0         1         2         3         4         5         6         7         8         9
//           0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789
const TEXT = "Hej Mette Sørensen, mail mette@example.dk, cpr 010190-1234 og 320190-1234 i Aarhus hos Contoso";
const recognizers: AdHocRecognizer[] = [{ name: "DK_CPR", supported_entity: "DK_CPR", patterns: [{ name: "p", regex: "\\b\\d{6}-\\d{4}\\b", score: 0.85 }] }];

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
}

describe("PresidioClient", () => {
  test("maps INTL_PHONE to PHONE", () => {
    expect(PRESIDIO_ENTITY_MAP.INTL_PHONE).toBe("PHONE");
  });

  test("posts text, language and ad-hoc recognizers", async () => {
    let seen: { url: string; body: any } | undefined;
    const client = new PresidioClient({
      baseUrl: "http://presidio:3000", recognizers,
      fetchImpl: fakeFetch((url, init) => { seen = { url, body: JSON.parse(String(init.body)) }; return Response.json([]); }),
    });
    await client.analyze({ id: "c1", text: TEXT, lang: "da" }, { signal: new AbortController().signal });
    expect(seen!.url).toBe("http://presidio:3000/analyze");
    expect(seen!.body.text).toBe(TEXT);
    expect(seen!.body.language).toBe("da");
    expect(seen!.body.ad_hoc_recognizers[0].supported_language).toBe("da");
    expect(seen!.body.ad_hoc_recognizers[0].name).toBe("DK_CPR");
  });

  test("maps entities, validates CPR, drops unmapped and below-threshold", async () => {
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => Response.json(recorded)) });
    const spans = await client.analyze({ id: "c1", text: TEXT, lang: "da" }, { signal: new AbortController().signal });
    expect(spans.map((s) => [s.type, TEXT.slice(s.start, s.end)])).toEqual([
      ["PERSON", "Mette Sørensen"],
      ["EMAIL", "mette@example.dk"],
      ["CPR", "010190-1234"],
      // 320190-1234 dropped: invalid date; Aarhus dropped: LOCATION unmapped; Contoso dropped: ORG below 0.4
    ]);
    expect(spans.every((s) => s.source === "presidio")).toBe(true);
  });

  test("drops results with missing or non-integer start/end", async () => {
    const malformed = [
      { entity_type: "PERSON", score: 0.9 },
      { entity_type: "PERSON", start: "4", end: 18, score: 0.9 },
      { entity_type: "PERSON", start: 4, end: 18, score: 0.9 },
    ];
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => Response.json(malformed)) });
    const spans = await client.analyze({ id: "c1", text: TEXT, lang: "da" }, { signal: new AbortController().signal });
    expect(spans.map((s) => [s.type, TEXT.slice(s.start, s.end)])).toEqual([
      ["PERSON", "Mette Sørensen"],
    ]);
  });

  test("non-2xx → SANITIZER_UNAVAILABLE", async () => {
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => new Response("boom", { status: 500 })) });
    const err = await client.analyze({ id: "c1", text: TEXT }, { signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect(err.code).toBe("SANITIZER_UNAVAILABLE");
  });

  test("network error → SANITIZER_UNAVAILABLE", async () => {
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => { throw new TypeError("fetch failed"); }) });
    const err = await client.analyze({ id: "c1", text: TEXT }, { signal: new AbortController().signal }).catch((e) => e);
    expect(err.code).toBe("SANITIZER_UNAVAILABLE");
  });

  test("malformed response → SANITIZER_UNAVAILABLE", async () => {
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => Response.json({ not: "an array" })) });
    const err = await client.analyze({ id: "c1", text: TEXT }, { signal: new AbortController().signal }).catch((e) => e);
    expect(err.code).toBe("SANITIZER_UNAVAILABLE");
  });

  test("defaults language to en when chunk has none", async () => {
    let lang: string | undefined;
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch((_u, init) => { lang = JSON.parse(String(init.body)).language; return Response.json([]); }) });
    await client.analyze({ id: "c1", text: TEXT }, { signal: new AbortController().signal });
    expect(lang).toBe("en");
  });

  // Presidio reports offsets as Unicode code points; JS strings index by UTF-16 code unit.
  // TEXT2 contains two emoji (each 1 code point / 2 UTF-16 units) before the PII, so a client
  // that used the raw offsets as UTF-16 indices would slice into the wrong place (PII leak).
  const TEXT2 = "😀😀 Hilsen Mette Sørensen, mette.sorensen@fabrikam.dk";

  test("translates Presidio's code-point offsets to UTF-16 before slicing (emoji prefix)", async () => {
    // Verified with `[...TEXT2].slice(10,24).join("") === "Mette Sørensen"` etc. — code-point offsets, not UTF-16.
    const codePointResults = [
      { entity_type: "PERSON", start: 10, end: 24, score: 0.85 },
      { entity_type: "EMAIL_ADDRESS", start: 26, end: 52, score: 1 },
    ];
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => Response.json(codePointResults)) });
    const spans = await client.analyze({ id: "c1", text: TEXT2, lang: "da" }, { signal: new AbortController().signal });
    expect(spans.map((s) => TEXT2.slice(s.start, s.end))).toEqual(["Mette Sørensen", "mette.sorensen@fabrikam.dk"]);
  });
});
