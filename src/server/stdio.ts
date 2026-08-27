import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.ts";
import { createLogger } from "../logging.ts";
import { createResultSanitizer } from "../policy/resultSanitizer.ts";
import { Allowlist } from "../sanitize/allowlist.ts";
import { loadRecognizers } from "../sanitize/cpr.ts";
import { PresidioClient } from "../sanitize/presidio.ts";
import { SanitizeSession } from "../sanitize/session.ts";
import { createProxyServer } from "./proxy.ts";
import { spawnUpstream } from "../upstream/child.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel }); // stderr — stdout is the MCP transport

if (config.pass2 === "off") {
  logger.warn("ZSAN_PASS2=off — running with Presidio only. Contextual PII (addresses, usernames, missed names) will NOT be redacted.");
} else {
  // Plan 2 wires the GLiNER detector here. Until then a required pass 2 cannot be satisfied.
  logger.error("ZSAN_PASS2=required but no pass-2 detector is implemented yet (Plan 2). Set ZSAN_PASS2=off to run Presidio-only.");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, "..", "..");
const allowlist = await Allowlist.fromFile(resolve(repoRoot, config.allowlistPath));
const recognizers = await loadRecognizers(resolve(repoRoot, config.recognizersPath));
const presidio = new PresidioClient({ baseUrl: config.presidioUrl, recognizers });

const sanitizer = createResultSanitizer({
  newSession: () => new SanitizeSession({
    pass1: presidio,
    pass2: null,
    allowlist,
    timeouts: { pass1Ms: config.timeouts.presidioMs, pass2Ms: config.timeouts.pass2Ms },
    chunkMaxChars: config.chunkMaxChars,
    concurrency: config.concurrency,
  }),
});

const upstream = await spawnUpstream({ command: config.upstreamCommand, zendesk: config.zendesk, onStderrLine: (l) => logger.debug(l) });
const server = createProxyServer({ upstream, sanitizer, logger });
await server.connect(new StdioServerTransport());
logger.info("zendesk-sanitizing-proxy ready (stdio, pass2=off)");

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await Promise.race([upstream.close(), new Promise<void>((done) => setTimeout(done, 3000))]);
  } catch {
    // ignore — we're shutting down regardless
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
