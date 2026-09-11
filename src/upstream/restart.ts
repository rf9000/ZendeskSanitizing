import type { Logger } from "../logging.ts";
import type { ToolDefinition, UpstreamClient } from "./client.ts";
import type { SpawnedUpstream } from "./child.ts";
import type { ToolResult } from "../policy/resultSanitizer.ts";

export interface RestartOptions { factory: () => Promise<SpawnedUpstream>; backoffMs: number; logger: Logger }

export async function createRestartingUpstream(opts: RestartOptions): Promise<UpstreamClient> {
  let current: SpawnedUpstream | null = null;
  let restartsLeft = 1;
  let shuttingDown = false;

  const attach = (child: SpawnedUpstream) => {
    current = child;
    child.onUnexpectedClose(() => {
      if (shuttingDown || current !== child) return;
      current = null;
      if (restartsLeft <= 0) { opts.logger.error("upstream child exited again — staying down"); return; }
      restartsLeft -= 1;
      opts.logger.warn(`upstream child exited — restarting once in ${opts.backoffMs}ms`);
      setTimeout(async () => {
        if (shuttingDown) return;
        try { attach(await opts.factory()); opts.logger.info("upstream child restarted"); }
        catch { opts.logger.error("upstream child restart failed — staying down"); }
      }, opts.backoffMs);
    });
  };
  attach(await opts.factory());

  const live = (): SpawnedUpstream => {
    if (!current) throw new Error("upstream unavailable (restarting or dead)");
    return current;
  };
  return {
    listTools: async (): Promise<ToolDefinition[]> => live().listTools(),
    callTool: async (name: string, args: Record<string, unknown>): Promise<ToolResult> => live().callTool(name, args),
    close: async () => { shuttingDown = true; await current?.close().catch(() => {}); current = null; },
  };
}
