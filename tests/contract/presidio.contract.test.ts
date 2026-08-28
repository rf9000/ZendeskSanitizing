import { describe, expect, test } from "bun:test";
import { PresidioClient } from "@/sanitize/presidio.ts";
import { loadRecognizers } from "@/sanitize/cpr.ts";

const enabled = process.env.ZSAN_CONTRACT === "1";
const baseUrl = process.env.ZSAN_PRESIDIO_URL ?? "http://127.0.0.1:5002";
const d = enabled ? describe : describe.skip;

d("presidio analyzer contract", () => {
  const signal = () => AbortSignal.timeout(30_000);
  let client: PresidioClient;
  test("health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.ok).toBe(true);
    client = new PresidioClient({ baseUrl, recognizers: await loadRecognizers("config/recognizers") });
  });

  test.each([
    ["da", "Hej, jeg hedder Mette Sørensen og arbejder hos Contoso ApS i Aarhus. Skriv til mette@contoso.dk eller ring på telefon +45 12 34 56 78. CPR 010190-1234. IBAN DK5000400440116243."],
    ["en", "Hello, my name is Jonathan Whitfield from Fabrikam Ltd. Email jonathan@fabrikam.co.uk or reach my mobile phone at +44 20 7946 0958. Card 4111 1111 1111 1111."],
    ["de", "Guten Tag, mein Name ist Katharina Vogelsang von der Muster GmbH. E-Mail katharina@muster.de, Telefon +49 30 901820. IBAN DE89370400440532013000."],
  ] as const)("recognizes entities in %s", async (lang, text) => {
    const spans = await client.analyze({ id: "t", text, lang }, { signal: signal() });
    const types = new Set(spans.map((s) => s.type));
    expect(types.has("PERSON")).toBe(true);
    expect(types.has("EMAIL")).toBe(true);
    expect(types.has("PHONE")).toBe(true);
    if (lang === "da") { expect(types.has("CPR")).toBe(true); expect(types.has("IBAN")).toBe(true); }
    if (lang === "en") expect(types.has("CARD")).toBe(true);
    if (lang === "de") expect(types.has("IBAN")).toBe(true);
  });

  test("rejects an unsupported language", async () => {
    const res = await fetch(`${baseUrl}/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hola", language: "es" }) });
    expect(res.ok).toBe(false);
  });
});
