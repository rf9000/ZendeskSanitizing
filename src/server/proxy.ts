import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { formatCounts, type Logger } from "../logging.ts";
import type { SanitizedResult, ToolResult } from "../policy/resultSanitizer.ts";
import { filterToolList, isAllowedTool } from "../policy/toolPolicy.ts";
import { SanitizerError } from "../sanitize/types.ts";
import type { UpstreamClient } from "../upstream/client.ts";

export interface ProxyDeps {
  upstream: UpstreamClient;
  sanitizer: { sanitize(result: ToolResult): Promise<SanitizedResult> };
  logger: Logger;
  now?: () => number;
}

export function ticketIdFrom(args: Record<string, unknown>): string {
  if (typeof args.id === "number" || typeof args.id === "string") return `ticket ${args.id}`;
  if (typeof args.query === "string") return "query";
  return "-";
}

const WITHHELD = "response withheld by the sanitizing proxy";

export function createProxyServer(deps: ProxyDeps): Server {
  const now = deps.now ?? Date.now;
  const server = new Server({ name: "zendesk-sanitizing-proxy", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await deps.upstream.listTools();
    return { tools: filterToolList(tools) as never };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!isAllowedTool(name)) {
      deps.logger.warn(`${name} blocked`);
      throw new McpError(ErrorCode.InvalidParams, `TOOL_NOT_ALLOWED: ${name} is not available through the sanitizing proxy`);
    }

    const started = now();
    let raw: ToolResult;
    try {
      raw = await deps.upstream.callTool(name, args);
    } catch (e) {
      deps.logger.error(`${name} ${ticketIdFrom(args)}: upstream failed (${(e as Error).name})`);
      throw new McpError(ErrorCode.InternalError, "UPSTREAM_UNAVAILABLE: the Zendesk MCP server did not respond");
    }

    let sanitized: SanitizedResult;
    try {
      sanitized = await deps.sanitizer.sanitize(raw);
    } catch (e) {
      const code = e instanceof SanitizerError ? e.code : "SANITIZER_INTERNAL";
      deps.logger.error(`${name} ${ticketIdFrom(args)}: ${code} (${(e as Error).name})`);
      throw new McpError(ErrorCode.InternalError, `${code}: ${WITHHELD}`);
    }

    deps.logger.info(
      `${name} ${ticketIdFrom(args)}: ${formatCounts(sanitized.counts)} (pass1 ${sanitized.perPass.pass1}, pass2 ${sanitized.perPass.pass2}) ${now() - started}ms`,
    );
    return sanitized.result as never;
  });

  return server;
}
