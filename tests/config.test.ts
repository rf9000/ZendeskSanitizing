import { describe, expect, test } from "bun:test";
import { loadConfig } from "@/config.ts";

const minimal = {
  ZSAN_ZENDESK_SUBDOMAIN: "acme",
  ZSAN_ZENDESK_EMAIL: "bot@acme.example",
  ZSAN_ZENDESK_API_TOKEN: "tok",
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const c = loadConfig(minimal);
    expect(c.zendesk.subdomain).toBe("acme");
    expect(c.upstreamCommand).toBe("npx -y @sshadows/zendesk-mcp-server@1.4.1");
    expect(c.presidioUrl).toBe("http://127.0.0.1:5002");
    expect(c.pass2).toBe("required");
    expect(c.timeouts).toEqual({ presidioMs: 15000, pass2Ms: 20000 });
    expect(c.chunkMaxChars).toBe(6000);
    expect(c.concurrency).toBe(4);
    expect(c.logLevel).toBe("info");
    expect(c.allowlistPath).toBe("config/allowlist.txt");
    expect(c.recognizersPath).toBe("config/recognizers");
  });

  test("lists every missing required var", () => {
    expect(() => loadConfig({})).toThrow(/ZSAN_ZENDESK_SUBDOMAIN[\s\S]*ZSAN_ZENDESK_EMAIL[\s\S]*ZSAN_ZENDESK_API_TOKEN/);
  });

  test("rejects unknown pass2 mode", () => {
    expect(() => loadConfig({ ...minimal, ZSAN_PASS2: "maybe" })).toThrow(/ZSAN_PASS2/);
  });

  test("coerces numeric tuning values", () => {
    const c = loadConfig({ ...minimal, ZSAN_CONCURRENCY: "8", ZSAN_PRESIDIO_TIMEOUT_MS: "100" });
    expect(c.concurrency).toBe(8);
    expect(c.timeouts.presidioMs).toBe(100);
  });
});
