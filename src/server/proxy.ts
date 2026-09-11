import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { formatCounts, type Logger } from "../logging.ts";
import type { SanitizedResult, ToolResult } from "../policy/resultSanitizer.ts";
import { OutgoingRejectedError, amendToolList, isAllowedTool, rewriteOutgoingArguments } from "../policy/toolPolicy.ts";
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
const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

export function createProxyServer(deps: ProxyDeps): Server {
  const now = deps.now ?? Date.now;
  const server = new Server({ name: "zendesk-sanitizing-proxy", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const tools = await deps.upstream.listTools();
      return { tools: amendToolList(tools) as never };
    } catch (e) {
      deps.logger.error(`tools/list: upstream failed (${errName(e)})`);
      throw new McpError(ErrorCode.InternalError, "UPSTREAM_UNAVAILABLE: the Zendesk MCP server did not respond");
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    let args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!isAllowedTool(name)) {
      deps.logger.warn(`${name} blocked`);
      throw new McpError(ErrorCode.InvalidParams, `TOOL_NOT_ALLOWED: ${name} is not available through the sanitizing proxy`);
    }

    try {
      args = rewriteOutgoingArguments(name, args);
    } catch (e) {
      if (e instanceof OutgoingRejectedError) {
        deps.logger.warn(`${name} outgoing rejected (${e.reason})`);
        const sentence =
          e.reason === "public_comment"
            ? "the sanitizing proxy only posts internal notes — omit type or pass 'internal'"
            : "the comment body contains sanitization placeholders like [PERSON_1]; replace them with real text before posting";
        throw new McpError(ErrorCode.InvalidParams, `OUTGOING_REJECTED: ${sentence}`);
      }
      throw e;
    }

    const started = now();
    let raw: ToolResult;
    try {
      raw = await deps.upstream.callTool(name, args);
    } catch (e) {
      deps.logger.error(`${name} ${ticketIdFrom(args)}: upstream failed (${errName(e)})`);
      throw new McpError(ErrorCode.InternalError, "UPSTREAM_UNAVAILABLE: the Zendesk MCP server did not respond");
    }

    let toReturn: ToolResult;
    try {
      const sanitized: SanitizedResult = await deps.sanitizer.sanitize(raw);
      if (sanitized.result === raw) {
        throw new SanitizerError("SANITIZER_INTERNAL", "sanitizer returned the raw result");
      }
      deps.logger.info(
        `${name} ${ticketIdFrom(args)}: ${formatCounts(sanitized.counts)} (pass1 ${sanitized.perPass.pass1}, pass2 ${sanitized.perPass.pass2}) ${now() - started}ms`,
      );
      toReturn = sanitized.result;
    } catch (e) {
      const code = e instanceof SanitizerError ? e.code : "SANITIZER_INTERNAL";
      deps.logger.error(`${name} ${ticketIdFrom(args)}: ${code} (${errName(e)})`);
      throw new McpError(ErrorCode.InternalError, `${code}: ${WITHHELD}`);
    }
    return toReturn as never;
  });

  return server;
}
