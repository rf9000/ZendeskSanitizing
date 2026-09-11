import { z } from "zod";

const envSchema = z.object({
  ZSAN_ZENDESK_SUBDOMAIN: z.string().min(1, "ZSAN_ZENDESK_SUBDOMAIN is required"),
  ZSAN_ZENDESK_EMAIL: z.string().min(1, "ZSAN_ZENDESK_EMAIL is required"),
  ZSAN_ZENDESK_API_TOKEN: z.string().min(1, "ZSAN_ZENDESK_API_TOKEN is required"),
  ZSAN_UPSTREAM_COMMAND: z.string().default("npx -y @sshadows/zendesk-mcp-server@1.4.1"),
  ZSAN_PRESIDIO_URL: z.url().default("http://127.0.0.1:5002"),
  ZSAN_PASS2: z.enum(["required", "off"]).default("required"),
  ZSAN_PASS2_DETECTOR: z.enum(["gliner", "ollama"]).default("gliner"),
  ZSAN_GLINER_URL: z.url().optional(),
  ZSAN_GLINER_MODEL_REF: z.string().default("urchade/gliner_multi_pii-v1@1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d"),
  ZSAN_GLINER_CONFIG_PATH: z.string().default("config/gliner.json"),
  ZSAN_PRESIDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  ZSAN_PASS2_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  ZSAN_CHUNK_MAX_CHARS: z.coerce.number().int().min(200).default(6000),
  ZSAN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  ZSAN_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ZSAN_ALLOWLIST_PATH: z.string().default("config/allowlist.txt"),
  ZSAN_RECOGNIZERS_PATH: z.string().default("config/recognizers"),
  ZSAN_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  ZSAN_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  ZSAN_CLIENT_TOKENS: z.string().default(""),
});

function parseClientTokens(raw: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new Error(`Invalid configuration:\n  - ZSAN_CLIENT_TOKENS: malformed entry "${trimmed}" — expected name:token`);
    }
    const name = trimmed.slice(0, idx);
    const token = trimmed.slice(idx + 1);
    tokens.set(token, name);
  }
  return tokens;
}

export interface AppConfig {
  zendesk: { subdomain: string; email: string; apiToken: string };
  upstreamCommand: string;
  presidioUrl: string;
  pass2: "required" | "off";
  pass2Detector: "gliner" | "ollama";
  glinerUrl: string | undefined;
  glinerModelRef: string;
  glinerConfigPath: string;
  timeouts: { presidioMs: number; pass2Ms: number };
  chunkMaxChars: number;
  concurrency: number;
  logLevel: "debug" | "info" | "warn" | "error";
  allowlistPath: string;
  recognizersPath: string;
  transport: "stdio" | "http";
  httpPort: number;
  clientTokens: Map<string, string>;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${messages}`);
  }
  const p = result.data;
  const clientTokens = parseClientTokens(p.ZSAN_CLIENT_TOKENS);
  if (p.ZSAN_TRANSPORT === "http" && clientTokens.size === 0) {
    throw new Error("Invalid configuration:\n  - ZSAN_CLIENT_TOKENS: at least one name:token pair is required when ZSAN_TRANSPORT=http");
  }
  if (p.ZSAN_PASS2 === "required" && p.ZSAN_PASS2_DETECTOR === "gliner" && !p.ZSAN_GLINER_URL) {
    throw new Error("Invalid configuration:\n  - ZSAN_GLINER_URL: required when ZSAN_PASS2=required and ZSAN_PASS2_DETECTOR=gliner");
  }
  return {
    zendesk: { subdomain: p.ZSAN_ZENDESK_SUBDOMAIN, email: p.ZSAN_ZENDESK_EMAIL, apiToken: p.ZSAN_ZENDESK_API_TOKEN },
    upstreamCommand: p.ZSAN_UPSTREAM_COMMAND,
    presidioUrl: p.ZSAN_PRESIDIO_URL,
    pass2: p.ZSAN_PASS2,
    pass2Detector: p.ZSAN_PASS2_DETECTOR,
    glinerUrl: p.ZSAN_GLINER_URL,
    glinerModelRef: p.ZSAN_GLINER_MODEL_REF,
    glinerConfigPath: p.ZSAN_GLINER_CONFIG_PATH,
    timeouts: { presidioMs: p.ZSAN_PRESIDIO_TIMEOUT_MS, pass2Ms: p.ZSAN_PASS2_TIMEOUT_MS },
    chunkMaxChars: p.ZSAN_CHUNK_MAX_CHARS,
    concurrency: p.ZSAN_CONCURRENCY,
    logLevel: p.ZSAN_LOG_LEVEL,
    allowlistPath: p.ZSAN_ALLOWLIST_PATH,
    recognizersPath: p.ZSAN_RECOGNIZERS_PATH,
    transport: p.ZSAN_TRANSPORT,
    httpPort: p.ZSAN_HTTP_PORT,
    clientTokens,
  };
}
