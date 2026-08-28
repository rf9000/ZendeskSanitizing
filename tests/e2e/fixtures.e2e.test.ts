import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createResultSanitizer } from "@/policy/resultSanitizer.ts";
import { Allowlist } from "@/sanitize/allowlist.ts";
import { loadRecognizers } from "@/sanitize/cpr.ts";
import { PresidioClient } from "@/sanitize/presidio.ts";
import { SanitizeSession } from "@/sanitize/session.ts";

const enabled = process.env.ZSAN_E2E === "1";
const d = enabled ? describe : describe.skip;
const FIXTURE_DIR = "tests/fixtures/tickets";

interface Fixture { expected: { absent: string[]; present: string[] }; expectedPass2?: { absent: string[] }; __rawText?: string; [k: string]: unknown }

d("e2e: every fixture sanitizes clean (Presidio pass only)", async () => {
  const allowlist = await Allowlist.fromFile("config/allowlist.txt");
  const presidio = new PresidioClient({ baseUrl: process.env.ZSAN_PRESIDIO_URL ?? "http://127.0.0.1:5002", recognizers: await loadRecognizers("config/recognizers") });
  const sanitizer = createResultSanitizer({
    newSession: () => new SanitizeSession({ pass1: presidio, pass2: null, allowlist, timeouts: { pass1Ms: 30_000, pass2Ms: 30_000 }, chunkMaxChars: 6000, concurrency: 4 }),
  });
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  const scorecard: Record<string, { leaked: string[]; overRedacted: string[] }> = {};

  for (const file of files) {
    test(file, async () => {
      const fx = (await Bun.file(join(FIXTURE_DIR, file)).json()) as Fixture;
      const { expected, expectedPass2: _p2, __rawText, ...payload } = fx;
      const text = __rawText ?? JSON.stringify(payload, null, 2);
      const { result } = await sanitizer.sanitize({ content: [{ type: "text", text }] });
      const out = (result.content[0] as { text: string }).text;
      const lower = out.toLowerCase();
      const leaked = expected.absent.filter((s) => lower.includes(s.toLowerCase()));
      const overRedacted = expected.present.filter((s) => !lower.includes(s.toLowerCase()));
      scorecard[file] = { leaked, overRedacted };
      expect(leaked).toEqual([]);
      expect(overRedacted).toEqual([]);
    });
  }

  test("scorecard", () => {
    console.error("\n=== sanitization scorecard (pass1 only) ===\n" + JSON.stringify(scorecard, null, 2));
  });
});
