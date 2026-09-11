import { resolve } from "node:path";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logging.ts";
import { createResultSanitizer, type SanitizedResult, type ToolResult } from "../policy/resultSanitizer.ts";
import { Allowlist } from "../sanitize/allowlist.ts";
import { loadRecognizers as defaultLoadRecognizers } from "../sanitize/cpr.ts";
import { GlinerDetector, loadGlinerConfig as defaultLoadGlinerConfig, verifyGlinerSidecar as defaultVerifyGliner } from "../sanitize/detectors/gliner.ts";
import { PresidioClient } from "../sanitize/presidio.ts";
import { SanitizeSession } from "../sanitize/session.ts";
import type { SpanDetector } from "../sanitize/types.ts";

export interface WiringDeps {
  config: AppConfig;
  logger: Logger;
  repoRoot: string;
  loadAllowlist?: (path: string) => Promise<Allowlist>;
  loadRecognizers?: typeof defaultLoadRecognizers;
  loadGlinerConfig?: typeof defaultLoadGlinerConfig;
  verifyGliner?: typeof defaultVerifyGliner;
  fetchImpl?: typeof fetch;
}

export async function buildSanitizer(deps: WiringDeps): Promise<{ sanitize(result: ToolResult): Promise<SanitizedResult> }> {
  const { config, logger, repoRoot } = deps;
  const allowlist = await (deps.loadAllowlist ?? Allowlist.fromFile)(resolve(repoRoot, config.allowlistPath));
  const recognizers = await (deps.loadRecognizers ?? defaultLoadRecognizers)(resolve(repoRoot, config.recognizersPath));
  const presidio = new PresidioClient({ baseUrl: config.presidioUrl, recognizers, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });

  let pass2: SpanDetector | null = null;
  if (config.pass2 === "off") {
    logger.warn("ZSAN_PASS2=off — running with Presidio only. Contextual PII (addresses, usernames, missed names) will NOT be redacted.");
  } else if (config.pass2Detector === "gliner") {
    const glinerConfig = await (deps.loadGlinerConfig ?? defaultLoadGlinerConfig)(resolve(repoRoot, config.glinerConfigPath));
    await (deps.verifyGliner ?? defaultVerifyGliner)(config.glinerUrl!, config.glinerModelRef, deps.fetchImpl ?? fetch);
    pass2 = new GlinerDetector({ baseUrl: config.glinerUrl!, config: glinerConfig, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    logger.info(`pass2=gliner verified against ${config.glinerModelRef}`);
  } else {
    throw new Error("ollama detector is not implemented; see spec §6.8");
  }

  return createResultSanitizer({
    newSession: () =>
      new SanitizeSession({
        pass1: presidio,
        pass2,
        allowlist,
        timeouts: { pass1Ms: config.timeouts.presidioMs, pass2Ms: config.timeouts.pass2Ms },
        chunkMaxChars: config.chunkMaxChars,
        concurrency: config.concurrency,
      }),
  });
}
