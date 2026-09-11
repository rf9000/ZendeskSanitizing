import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Logger } from "../logging.ts";

export interface HttpProxyDeps {
  createServer: () => Server; // fresh MCP Server per session — call createProxyServer(proxyDeps)
  tokens: Map<string, string>; // token → developer name (for the log line only)
  port: number; // 0 = ephemeral (tests)
  logger: Logger;
}

const UNAUTHORIZED = () => Response.json({ error: "unauthorized" }, { status: 401 });

export function startHttpProxy(deps: HttpProxyDeps): { port: number; stop(): Promise<void> } {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const server = Bun.serve({
    port: deps.port,
    idleTimeout: 120,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") return Response.json({ status: "ok" });

      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const who = deps.tokens.get(token);
      if (!who) {
        deps.logger.warn("http 401");
        return UNAUTHORIZED();
      }

      if (url.pathname !== "/mcp") return Response.json({ error: "not found" }, { status: 404 });

      const sessionId = req.headers.get("mcp-session-id");
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) return Response.json({ error: "unknown session" }, { status: 404 });
        return existing.handleRequest(req);
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          deps.logger.info(`http session opened for ${who}`);
        },
      });
      transport.onclose = () => {
        for (const [id, t] of sessions) if (t === transport) sessions.delete(id);
      };
      await deps.createServer().connect(transport);
      return transport.handleRequest(req);
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("http proxy: server has no TCP port (unix socket mode is not supported)");

  return {
    port,
    stop: async () => {
      for (const t of sessions.values()) await t.close().catch(() => {});
      sessions.clear();
      await server.stop(true);
    },
  };
}
