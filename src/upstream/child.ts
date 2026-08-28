import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../policy/resultSanitizer.ts";
import type { ToolDefinition, UpstreamClient } from "./client.ts";

export interface SpawnOptions {
  command: string;
  zendesk: { subdomain: string; email: string; apiToken: string };
  onStderrLine: (line: string) => void;
  platform?: NodeJS.Platform;
  mkTempDir?: () => string;
}

/**
 * Builds the command/args/env/cwd this proxy hands to `StdioClientTransport` for the upstream
 * Zendesk MCP child. The `env` returned here is only PART of what the child actually receives:
 * `StdioClientTransport` spawns with `{ ...getDefaultEnvironment(), ...env }`, where
 * `getDefaultEnvironment()` is the MCP SDK's own fixed, hard-coded safe-inherit list —
 * Windows: APPDATA, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, PROCESSOR_ARCHITECTURE, SYSTEMDRIVE,
 * SYSTEMROOT, TEMP, USERNAME, USERPROFILE, PROGRAMFILES; Unix: HOME, LOGNAME, SHELL, TERM, USER.
 * So the child's real environment is the Zendesk trio + PATH (below) UNIONED with that fixed
 * list — never the proxy's own `ZSAN_*` variables or secrets such as `ANTHROPIC_API_KEY`, which
 * are never read from `process.env` here and are not part of the SDK's safe-inherit list either.
 */
export function buildSpawnSpec(opts: SpawnOptions): { command: string; args: string[]; env: Record<string, string>; cwd: string } {
  const platform = opts.platform ?? process.platform;
  const parts = opts.command.trim().split(/\s+/);
  const [command, ...args] = platform === "win32" ? ["cmd", "/c", ...parts] : parts;
  return {
    command: command!,
    args,
    env: {
      PATH: process.env.PATH ?? "",
      ZENDESK_SUBDOMAIN: opts.zendesk.subdomain,
      ZENDESK_EMAIL: opts.zendesk.email,
      ZENDESK_API_TOKEN: opts.zendesk.apiToken,
    },
    cwd: (opts.mkTempDir ?? (() => mkdtempSync(join(tmpdir(), "zsan-upstream-"))))(),
  };
}

export async function spawnUpstream(opts: SpawnOptions): Promise<UpstreamClient> {
  const spec = buildSpawnSpec(opts);
  const transport = new StdioClientTransport({ ...spec, stderr: "pipe" });
  const client = new Client({ name: "zendesk-sanitizing-proxy", version: "0.0.1" });
  await client.connect(transport);

  let buffer = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) opts.onStderrLine(`[upstream] ${line}`);
  });
  transport.stderr?.on("end", () => {
    if (buffer.trim()) opts.onStderrLine(`[upstream] ${buffer}`);
    buffer = "";
  });

  return {
    async listTools() {
      const res = await client.listTools();
      return res.tools as ToolDefinition[];
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    },
    async close() {
      await client.close();
    },
  };
}
