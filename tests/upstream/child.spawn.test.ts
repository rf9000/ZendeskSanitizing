import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSpawnSpec } from "@/upstream/child.ts";

// Integration test: buildSpawnSpec's env, passed through a REAL spawn (not the MCP transport).
// StdioClientTransport itself layers `{ ...getDefaultEnvironment(), ...env }` on top of what we
// return — a fixed, hard-coded safe-inherit list (Windows: APPDATA, HOMEDRIVE, HOMEPATH,
// LOCALAPPDATA, PROCESSOR_ARCHITECTURE, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERNAME, USERPROFILE,
// PROGRAMFILES; Unix: HOME, LOGNAME, SHELL, TERM, USER) — this test only asserts on what
// buildSpawnSpec itself contributes: the Zendesk trio + PATH, and never the proxy's own env.
const zendesk = { subdomain: "acme", email: "bot@acme.example", apiToken: "tok" };
const scriptPath = join(import.meta.dir, "fixtures", "print-env.ts");

describe("buildSpawnSpec env, through a real spawn", () => {
  test("child process env has the Zendesk trio, no ZSAN_* keys, and never leaks the proxy's own secrets", () => {
    const prev = process.env.ZSAN_ZENDESK_API_TOKEN;
    process.env.ZSAN_ZENDESK_API_TOKEN = "should-not-leak";
    try {
      const spec = buildSpawnSpec({ command: "npx -y @sshadows/zendesk-mcp-server@1.4.1", zendesk, onStderrLine: () => {} });
      const result = Bun.spawnSync(["bun", "run", scriptPath], { env: spec.env, cwd: spec.cwd });
      expect(result.exitCode).toBe(0);
      const childEnv = JSON.parse(result.stdout.toString("utf8"));
      expect(childEnv.ZENDESK_API_TOKEN).toBe("tok");
      expect(childEnv.ZENDESK_SUBDOMAIN).toBe("acme");
      expect(childEnv.ZENDESK_EMAIL).toBe("bot@acme.example");
      expect(Object.keys(childEnv).some((k) => k.startsWith("ZSAN_"))).toBe(false);
      expect(JSON.stringify(childEnv)).not.toContain("should-not-leak");
    } finally {
      if (prev === undefined) delete process.env.ZSAN_ZENDESK_API_TOKEN;
      else process.env.ZSAN_ZENDESK_API_TOKEN = prev;
    }
  });
});
