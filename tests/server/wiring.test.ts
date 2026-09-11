import { describe, expect, test } from "bun:test";
import { buildSanitizer } from "@/server/wiring.ts";
import { loadConfig } from "@/config.ts";
import { createLogger } from "@/logging.ts";
import { Allowlist } from "@/sanitize/allowlist.ts";
import { SanitizerError } from "@/sanitize/types.ts";

const minimal = { ZSAN_ZENDESK_SUBDOMAIN: "acme", ZSAN_ZENDESK_EMAIL: "bot@acme.example", ZSAN_ZENDESK_API_TOKEN: "tok" };
const glinerConfig = { threshold: 0.4, labels: ["person name"], labelMap: { "person name": "PERSON" as const } };

function deps(env: Record<string, string>, over: Record<string, unknown> = {}) {
  const lines: string[] = [];
  return {
    lines,
    d: {
      config: loadConfig({ ...minimal, ...env }),
      logger: createLogger({ level: "debug", sink: (l: string) => lines.push(l) }),
      repoRoot: process.cwd(),
      loadAllowlist: async () => Allowlist.fromText("Continia"),
      loadRecognizers: async () => [],
      loadGlinerConfig: async () => glinerConfig,
      verifyGliner: async () => {},
      ...over,
    },
  };
}

describe("buildSanitizer", () => {
  test("pass2=off builds a working sanitizer and warns loudly", async () => {
    const { d, lines } = deps({ ZSAN_PASS2: "off" });
    const s = await buildSanitizer(d as never);
    expect(typeof s.sanitize).toBe("function");
    expect(lines.join("\n")).toContain("ZSAN_PASS2=off");
  });

  test("pass2=required verifies the sidecar identity before returning", async () => {
    let verified: string[] = [];
    const { d } = deps(
      { ZSAN_PASS2: "required", ZSAN_GLINER_URL: "http://127.0.0.1:5003" },
      { verifyGliner: async (url: string, ref: string) => { verified = [url, ref]; } },
    );
    await buildSanitizer(d as never);
    expect(verified[0]).toBe("http://127.0.0.1:5003");
    expect(verified[1]).toContain("urchade/gliner_multi_pii-v1@");
  });

  test("pass2=required propagates a failed identity check", async () => {
    const { d } = deps(
      { ZSAN_PASS2: "required", ZSAN_GLINER_URL: "http://127.0.0.1:5003" },
      { verifyGliner: async () => { throw new SanitizerError("SANITIZER_UNAVAILABLE", "mismatch"); } },
    );
    await expect(buildSanitizer(d as never)).rejects.toThrow(/SANITIZER_UNAVAILABLE|mismatch/);
  });

  test("pass2=required + detector=ollama is rejected as unimplemented", async () => {
    const { d } = deps({ ZSAN_PASS2: "required", ZSAN_PASS2_DETECTOR: "ollama", ZSAN_GLINER_URL: "http://x" });
    await expect(buildSanitizer(d as never)).rejects.toThrow(/ollama/);
  });
});
