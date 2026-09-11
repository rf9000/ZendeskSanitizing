import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Logger } from "../logging.ts";

export interface HttpProxyDeps {
  createServer: () => Server; // fresh MCP Server per session — call createProxyServer(proxyDeps)
  tokens: Map<string, string>; // token → developer name (for the log line only)
  port: number; // 0 = ephemeral (tests)
  logger: Logger;
  maxSessions?: number; // default 64 — oldest session is evicted once the cap would be exceeded
}

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  owner: string; // developer name the session was opened under — never the token
}

const DEFAULT_MAX_SESSIONS = 64;
const UNAUTHORIZED = () => Response.json({ error: "unauthorized" }, { status: 401 });
const NOT_FOUND = () => Response.json({ error: "not found" }, { status: 404 });
const UNKNOWN_SESSION = () => Response.json({ error: "unknown session" }, { status: 404 });
const INTERNAL = () => Response.json({ error: "internal" }, { status: 500 });

export function startHttpProxy(deps: HttpProxyDeps): { port: number; stop(): Promise<void> } {
  const sessions = new Map<string, SessionEntry>();
  const maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;

  const server = Bun.serve({
    port: deps.port,
    idleTimeout: 120,
    error: () => INTERNAL(),
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") return Response.json({ status: "ok" });

      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !deps.tokens.has(token)) {
        deps.logger.warn("http 401");
        return UNAUTHORIZED();
      }
      const who = deps.tokens.get(token) as string;

      if (url.pathname !== "/mcp") return NOT_FOUND();

      const sessionId = req.headers.get("mcp-session-id");
      if (sessionId) {
        const existing = sessions.get(sessionId);
        // A session id that exists but belongs to a different token's owner is treated
        // identically to an unknown one — never reveal that the session exists.
        if (!existing || existing.owner !== who) return UNKNOWN_SESSION();
        return existing.transport.handleRequest(req);
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: async (id) => {
          if (sessions.size >= maxSessions) {
            const oldestId = sessions.keys().next().value;
            if (oldestId !== undefined) {
              const oldest = sessions.get(oldestId);
              sessions.delete(oldestId);
              await oldest?.transport.close().catch(() => {});
              deps.logger.warn("http session evicted (cap)");
            }
          }
          sessions.set(id, { transport, owner: who });
          deps.logger.info(`http session opened for ${who}`);
        },
      });
      transport.onclose = () => {
        for (const [id, s] of sessions) if (s.transport === transport) sessions.delete(id);
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
      for (const s of sessions.values()) await s.transport.close().catch(() => {});
      sessions.clear();
      // A client that never sent its own DELETE/close can leave an SSE GET stream open on
      // the underlying socket; Bun's forced stop() can then wait indefinitely for that
      // connection to unwind. Bound it so shutdown (and test teardown) never hangs.
      await Promise.race([server.stop(true), new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
    },
  };
}
