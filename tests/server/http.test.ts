import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpProxy } from "@/server/http.ts";
import { createProxyServer } from "@/server/proxy.ts";
import { createLogger } from "@/logging.ts";
import type { UpstreamClient } from "@/upstream/client.ts";
import type { ToolResult } from "@/policy/resultSanitizer.ts";

function fakeUpstream(): UpstreamClient {
  return {
    async listTools() { return [{ name: "get_ticket", inputSchema: { type: "object" } }]; },
    async callTool() { return { content: [{ type: "text", text: "RAW" }] } as ToolResult; },
    async close() {},
  };
}
const okSanitizer = { async sanitize(_r: ToolResult) { return { result: { content: [{ type: "text" as const, text: "SANITIZED" }] }, counts: {} as never, perPass: { pass1: 0, pass2: 0 } }; } };
const logger = createLogger({ level: "error", sink: () => {} });

const handle = startHttpProxy({
  createServer: () => createProxyServer({ upstream: fakeUpstream(), sanitizer: okSanitizer, logger }),
  tokens: new Map([["sekret-token-1", "rene"]]),
  port: 0,
  logger,
});
afterAll(() => handle.stop());
const base = `http://127.0.0.1:${handle.port}`;

describe("http transport", () => {
  test("healthz is open", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  test("missing or wrong bearer token → 401, token never echoed", async () => {
    const r1 = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
    expect(r2.status).toBe(401);
    expect(await r2.text()).not.toContain("wrong");
  });

  test("full MCP round-trip over HTTP with a valid token", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer sekret-token-1" } },
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_ticket"]);
    const res = await client.callTool({ name: "get_ticket", arguments: { id: 1 } });
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe("SANITIZED");
    await client.close();
  });

  test("two clients get isolated sessions", async () => {
    const mk = async () => {
      const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer sekret-token-1" } } });
      const c = new Client({ name: "t", version: "0" });
      await c.connect(t);
      return c;
    };
    const [a, b] = [await mk(), await mk()];
    expect((await a.listTools()).tools).toHaveLength(1);
    expect((await b.listTools()).tools).toHaveLength(1);
    await a.close(); await b.close();
  });

  test("unknown session id → 404", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer sekret-token-1", "mcp-session-id": "nope", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(404);
  });
});
