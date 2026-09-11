import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json";
import { loadConfig } from "../config.ts";
import { createLogger } from "../logging.ts";
import { createProxyServer } from "./proxy.ts";
import { spawnUpstream } from "../upstream/child.ts";
import { createRestartingUpstream } from "../upstream/restart.ts";
import { buildSanitizer } from "./wiring.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel }); // stderr — stdout is the MCP transport
const repoRoot = resolve(import.meta.dir, "..", "..");

let sanitizer;
try {
  sanitizer = await buildSanitizer({ config, logger, repoRoot });
} catch (e) {
  // buildSanitizer errors here are config-derived (bad config/gliner.json, sidecar identity
  // mismatch, unimplemented detector) — never payload text — so logging e.message is safe.
  logger.error(`startup failed: ${e instanceof Error ? e.message : typeof e}`);
  process.exit(2);
}

const upstream = await createRestartingUpstream({
  factory: () => spawnUpstream({ command: config.upstreamCommand, zendesk: config.zendesk, onStderrLine: (l) => logger.debug(l) }),
  backoffMs: 2000,
  logger,
});
const server = createProxyServer({ upstream, sanitizer, logger });
await server.connect(new StdioServerTransport());
logger.info(`zendesk-sanitizing-proxy v${pkg.version} ready (stdio, pass2=${config.pass2 === "off" ? "off" : config.pass2Detector})`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([upstream.close(), new Promise<void>((done) => { timer = setTimeout(done, 3000); })]);
  } catch {
    // ignore — we're shutting down regardless
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The MCP client (Claude Code) closes stdin when it disconnects without sending SIGTERM first;
// without these, the proxy (and the upstream Zendesk child it spawned) would linger forever.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
server.onclose = shutdown;
