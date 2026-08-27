import type { ToolResult } from "../policy/resultSanitizer.ts";

export interface ToolDefinition { name: string; description?: string; inputSchema: unknown; [k: string]: unknown }

export interface UpstreamClient {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}
