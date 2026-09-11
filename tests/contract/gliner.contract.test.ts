import { describe, expect, test } from "bun:test";

const enabled = process.env.ZSAN_CONTRACT === "1";
const baseUrl = process.env.ZSAN_GLINER_URL ?? "http://127.0.0.1:5003";
const d = enabled ? describe : describe.skip;

d("gliner sidecar contract", () => {
  test("healthz reports the pinned model and revision", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model_id: string; revision: string };
    expect(body.model_id).toBe("urchade/gliner_multi_pii-v1");
    expect(body.revision).toBe("1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d");
  });

  test("detects a Danish person and street address with valid code-point offsets", async () => {
    const text = "Hej, jeg hedder Mette Sørensen og bor på Vestergade 12, 8000 Aarhus C.";
    const res = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, labels: ["person name", "street address"], threshold: 0.3 }),
    });
    expect(res.status).toBe(200);
    const { spans } = (await res.json()) as { spans: Array<{ start: number; end: number; label: string; score: number }> };
    const cp = [...text];
    for (const s of spans) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(cp.length);
    }
    const texts = spans.map((s) => cp.slice(s.start, s.end).join(""));
    expect(texts.some((t) => t.includes("Mette"))).toBe(true);
    expect(texts.some((t) => t.includes("Vestergade"))).toBe(true);
  });

  test("empty text returns empty spans, not an error", async () => {
    const res = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", labels: ["person name"], threshold: 0.4 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { spans: unknown[] }).spans).toEqual([]);
  });
});
