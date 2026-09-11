import { describe, expect, test } from "bun:test";
import { loadConfig } from "@/config.ts";

const minimal = {
  ZSAN_ZENDESK_SUBDOMAIN: "acme",
  ZSAN_ZENDESK_EMAIL: "bot@acme.example",
  ZSAN_ZENDESK_API_TOKEN: "tok",
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const c = loadConfig({ ...minimal, ZSAN_GLINER_URL: "http://127.0.0.1:5003" });
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
    const c = loadConfig({ ...minimal, ZSAN_GLINER_URL: "http://127.0.0.1:5003", ZSAN_CONCURRENCY: "8", ZSAN_PRESIDIO_TIMEOUT_MS: "100" });
    expect(c.concurrency).toBe(8);
    expect(c.timeouts.presidioMs).toBe(100);
  });

  test("gliner defaults and required-url refinement", () => {
    const c = loadConfig({ ...minimal, ZSAN_PASS2: "off" });
    expect(c.glinerModelRef).toBe("urchade/gliner_multi_pii-v1@1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d");
    expect(c.glinerConfigPath).toBe("config/gliner.json");
    expect(() => loadConfig({ ...minimal, ZSAN_PASS2: "required" })).toThrow(/ZSAN_GLINER_URL/);
    const ok = loadConfig({ ...minimal, ZSAN_PASS2: "required", ZSAN_GLINER_URL: "http://127.0.0.1:5003" });
    expect(ok.glinerUrl).toBe("http://127.0.0.1:5003");
  });

  test("http transport requires client tokens; token map parses", () => {
    expect(() => loadConfig({ ...minimal, ZSAN_TRANSPORT: "http" })).toThrow(/ZSAN_CLIENT_TOKENS/);
    const c = loadConfig({ ...minimal, ZSAN_PASS2: "off", ZSAN_TRANSPORT: "http", ZSAN_CLIENT_TOKENS: "rene:tok1-abcdefghijk,mia:tok2-abcdefghijk" });
    expect(c.transport).toBe("http");
    expect(c.httpPort).toBe(8080);
    expect(c.clientTokens.get("tok1-abcdefghijk")).toBe("rene");
    expect(c.clientTokens.get("tok2-abcdefghijk")).toBe("mia");
    expect(loadConfig({ ...minimal, ZSAN_PASS2: "off" }).transport).toBe("stdio");
  });

  test("malformed client token entry (no colon) throws", () => {
    expect(() => loadConfig({ ...minimal, ZSAN_PASS2: "off", ZSAN_CLIENT_TOKENS: "rene-tok1" })).toThrow(/ZSAN_CLIENT_TOKENS/);
  });

  test("client token shorter than 16 chars throws", () => {
    expect(() => loadConfig({ ...minimal, ZSAN_PASS2: "off", ZSAN_CLIENT_TOKENS: "rene:tooshort" })).toThrow(/ZSAN_CLIENT_TOKENS.*rene.*too short/);
  });
});
