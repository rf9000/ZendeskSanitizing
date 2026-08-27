import { describe, expect, test } from "bun:test";
import { buildSpawnSpec } from "@/upstream/child.ts";

const zendesk = { subdomain: "acme", email: "bot@acme.example", apiToken: "tok" };
const base = { command: "npx -y @sshadows/zendesk-mcp-server@1.4.1", zendesk, onStderrLine: () => {}, mkTempDir: () => "/tmp/zsan-x" };

describe("buildSpawnSpec", () => {
  test("linux: splits command, passes only the Zendesk trio + PATH, empty cwd", () => {
    const spec = buildSpawnSpec({ ...base, platform: "linux" });
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "@sshadows/zendesk-mcp-server@1.4.1"]);
    expect(Object.keys(spec.env).sort()).toEqual(["PATH", "ZENDESK_API_TOKEN", "ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"]);
    expect(spec.env.ZENDESK_SUBDOMAIN).toBe("acme");
    expect(spec.env.PATH).toBe(process.env.PATH ?? "");
    expect(spec.cwd).toBe("/tmp/zsan-x");
  });

  test("win32: wraps with cmd /c", () => {
    const spec = buildSpawnSpec({ ...base, platform: "win32" });
    expect(spec.command).toBe("cmd");
    expect(spec.args).toEqual(["/c", "npx", "-y", "@sshadows/zendesk-mcp-server@1.4.1"]);
  });

  test("never leaks the proxy's own env (e.g. ZSAN_*, ANTHROPIC_API_KEY)", () => {
    const prev = { a: process.env.ANTHROPIC_API_KEY, z: process.env.ZSAN_ZENDESK_API_TOKEN };
    try {
      process.env.ANTHROPIC_API_KEY = "should-not-leak";
      process.env.ZSAN_ZENDESK_API_TOKEN = "should-not-leak";
      const spec = buildSpawnSpec({ ...base, platform: "linux" });
      expect(JSON.stringify(spec.env)).not.toContain("should-not-leak");
    } finally {
      if (prev.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev.a;
      if (prev.z === undefined) delete process.env.ZSAN_ZENDESK_API_TOKEN; else process.env.ZSAN_ZENDESK_API_TOKEN = prev.z;
    }
  });
});
