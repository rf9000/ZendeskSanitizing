// Runs texts through the sanitize pipeline (pass 1, pass 2, sweep) the way a tool result goes through it, without
// Zendesk and without the MCP server. Made for the chain test of the banking chatbot, which sends the output on to
// its own privacy filter. Use it with synthetic text only.
//
//   bun run scripts/sanitize-texts.ts <in.json> <out.json> [--pass2 on|off]
//
// "-" as in.json reads standard input; "-" as out.json writes standard output (the count line then goes to standard
// error). This is how the script runs inside the proxy's container:
//   docker exec -i <proxy container> bun run scripts/sanitize-texts.ts - - < in.json > out.json
//
// in.json:  { "<id>": "<text>", ... }
// out.json: { "<id>": "<sanitized text>" | null, ... }   null: the pipeline refused the text (it failed closed).
//
// Presidio and GLiNER addresses come from ZSAN_PRESIDIO_URL and ZSAN_GLINER_URL (defaults: the laptop profile).
// It prints counts and error class names only, never text.
import { createResultSanitizer } from "@/policy/resultSanitizer.ts";
import { Allowlist } from "@/sanitize/allowlist.ts";
import { loadRecognizers } from "@/sanitize/cpr.ts";
import { GlinerDetector, loadGlinerConfig } from "@/sanitize/detectors/gliner.ts";
import { PresidioClient } from "@/sanitize/presidio.ts";
import { SanitizeSession } from "@/sanitize/session.ts";
import type { SpanDetector } from "@/sanitize/types.ts";

const [inFile, outFile, ...rest] = process.argv.slice(2);
const pass2Arg = rest[0] === "--pass2" ? rest[1] : "on";
if (!inFile || !outFile || (pass2Arg !== "on" && pass2Arg !== "off")) {
  console.error("usage: bun run scripts/sanitize-texts.ts <in.json> <out.json> [--pass2 on|off]");
  process.exit(2);
}

const texts = (inFile === "-" ? await Bun.stdin.json() : await Bun.file(inFile).json()) as Record<string, string>;
const allowlist = await Allowlist.fromFile("config/allowlist.txt");
const presidio = new PresidioClient({
  baseUrl: process.env.ZSAN_PRESIDIO_URL ?? "http://127.0.0.1:5002",
  recognizers: await loadRecognizers("config/recognizers"),
});
const pass2: SpanDetector | null = pass2Arg === "on"
  ? new GlinerDetector({ baseUrl: process.env.ZSAN_GLINER_URL ?? "http://127.0.0.1:5003", config: await loadGlinerConfig("config/gliner.json") })
  : null;
const sanitizer = createResultSanitizer({
  newSession: () => new SanitizeSession({ pass1: presidio, pass2, allowlist, timeouts: { pass1Ms: 60_000, pass2Ms: 120_000 }, chunkMaxChars: 6000, concurrency: 4 }),
});

const out: Record<string, string | null> = {};
const errors: Record<string, number> = {};
for (const [id, text] of Object.entries(texts)) {
  try {
    const { result } = await sanitizer.sanitize({ content: [{ type: "text", text }] });
    out[id] = (result.content[0] as { text: string }).text;
  } catch (e) {
    const name = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "UnknownError";
    errors[name] = (errors[name] ?? 0) + 1;
    out[id] = null;
  }
}
const refused = Object.values(out).filter((v) => v === null).length;
const counts = JSON.stringify({ texts: Object.keys(texts).length, refused, errors, pass2: pass2Arg });
if (outFile === "-") {
  console.error(counts);
  await Bun.write(Bun.stdout, JSON.stringify(out));
} else {
  await Bun.write(outFile, JSON.stringify(out));
  console.log(counts);
}
