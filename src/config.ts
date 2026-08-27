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
  ZSAN_PRESIDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  ZSAN_PASS2_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  ZSAN_CHUNK_MAX_CHARS: z.coerce.number().int().min(200).default(6000),
  ZSAN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  ZSAN_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ZSAN_ALLOWLIST_PATH: z.string().default("config/allowlist.txt"),
});

export interface AppConfig {
  zendesk: { subdomain: string; email: string; apiToken: string };
  upstreamCommand: string;
  presidioUrl: string;
  pass2: "required" | "off";
  pass2Detector: "gliner" | "ollama";
  glinerUrl: string | undefined;
  timeouts: { presidioMs: number; pass2Ms: number };
  chunkMaxChars: number;
  concurrency: number;
  logLevel: "debug" | "info" | "warn" | "error";
  allowlistPath: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${messages}`);
  }
  const p = result.data;
  return {
    zendesk: { subdomain: p.ZSAN_ZENDESK_SUBDOMAIN, email: p.ZSAN_ZENDESK_EMAIL, apiToken: p.ZSAN_ZENDESK_API_TOKEN },
    upstreamCommand: p.ZSAN_UPSTREAM_COMMAND,
    presidioUrl: p.ZSAN_PRESIDIO_URL,
    pass2: p.ZSAN_PASS2,
    pass2Detector: p.ZSAN_PASS2_DETECTOR,
    glinerUrl: p.ZSAN_GLINER_URL,
    timeouts: { presidioMs: p.ZSAN_PRESIDIO_TIMEOUT_MS, pass2Ms: p.ZSAN_PASS2_TIMEOUT_MS },
    chunkMaxChars: p.ZSAN_CHUNK_MAX_CHARS,
    concurrency: p.ZSAN_CONCURRENCY,
    logLevel: p.ZSAN_LOG_LEVEL,
    allowlistPath: p.ZSAN_ALLOWLIST_PATH,
  };
}
