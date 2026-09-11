import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createResultSanitizer } from "@/policy/resultSanitizer.ts";
import { Allowlist } from "@/sanitize/allowlist.ts";
import { loadRecognizers } from "@/sanitize/cpr.ts";
import { GlinerDetector, loadGlinerConfig } from "@/sanitize/detectors/gliner.ts";
import { PresidioClient } from "@/sanitize/presidio.ts";
import { SanitizeSession } from "@/sanitize/session.ts";
import type { SpanDetector } from "@/sanitize/types.ts";

const enabled = process.env.ZSAN_E2E === "1";
const pass2Enabled = process.env.ZSAN_E2E_PASS2 === "1";
const d = enabled ? describe : describe.skip;
const FIXTURE_DIR = "tests/fixtures/tickets";

interface Fixture {
  expected: { absent: string[]; present: string[] };
  expectedPass2?: { absent: string[]; reasons?: Record<string, string> };
  lang?: string;
  __rawText?: string;
  [k: string]: unknown;
}

d(`e2e: every fixture sanitizes clean (pass2=${pass2Enabled ? "gliner" : "off"})`, async () => {
  const allowlist = await Allowlist.fromFile("config/allowlist.txt");
  const presidio = new PresidioClient({ baseUrl: process.env.ZSAN_PRESIDIO_URL ?? "http://127.0.0.1:5002", recognizers: await loadRecognizers("config/recognizers") });

  let pass2: SpanDetector | null = null;
  if (pass2Enabled) {
    const glinerConfig = await loadGlinerConfig("config/gliner.json");
    pass2 = new GlinerDetector({ baseUrl: process.env.ZSAN_GLINER_URL ?? "http://127.0.0.1:5003", config: glinerConfig });
  }

  const sanitizer = createResultSanitizer({
    newSession: () => new SanitizeSession({ pass1: presidio, pass2, allowlist, timeouts: { pass1Ms: 30_000, pass2Ms: 60_000 }, chunkMaxChars: 6000, concurrency: 4 }),
  });
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  const scorecard: Record<string, { lang: string; absentChecked: number; leaked: string[]; leaked2: string[]; overRedacted: string[] }> = {};

  for (const file of files) {
    test(file, async () => {
      const fx = (await Bun.file(join(FIXTURE_DIR, file)).json()) as Fixture;
      const { expected, expectedPass2, lang, __rawText, ...payload } = fx;
      const text = __rawText ?? JSON.stringify(payload, null, 2);
      const { result } = await sanitizer.sanitize({ content: [{ type: "text", text }] });
      const out = (result.content[0] as { text: string }).text;
      const lower = out.toLowerCase();
      const leaked = expected.absent.filter((s) => lower.includes(s.toLowerCase()));
      const overRedacted = expected.present.filter((s) => !lower.includes(s.toLowerCase()));
      const leaked2 = pass2Enabled ? (expectedPass2?.absent ?? []).filter((s) => lower.includes(s.toLowerCase())) : [];
      scorecard[file] = {
        lang: lang ?? "en",
        absentChecked: expected.absent.length + (pass2Enabled ? (expectedPass2?.absent?.length ?? 0) : 0),
        leaked,
        leaked2,
        overRedacted,
      };
      expect(leaked).toEqual([]);
      expect(overRedacted).toEqual([]);
      if (pass2Enabled) {
        expect(leaked2).toEqual([]);
      }
    });
  }

  test("scorecard", () => {
    const byLang: Record<string, { checked: number; leaked: number }> = {};
    for (const [, r] of Object.entries(scorecard)) {
      const l = (byLang[r.lang] ??= { checked: 0, leaked: 0 });
      l.checked += r.absentChecked;
      l.leaked += r.leaked.length + r.leaked2.length;
    }
    console.error("\n=== scorecard (pass2=" + (pass2Enabled ? "gliner" : "off") + ") ===\n" + JSON.stringify({ byLang, perFixture: scorecard }, null, 2));
  });
});
