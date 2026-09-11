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

const TOKEN_A = "sekret-token-1-abcd";
const TOKEN_B = "sekret-token-2-abcd";

const handle = startHttpProxy({
  createServer: () => createProxyServer({ upstream: fakeUpstream(), sanitizer: okSanitizer, logger }),
  tokens: new Map([[TOKEN_A, "rene"], [TOKEN_B, "mia"]]),
  port: 0,
  logger,
});
afterAll(() => handle.stop());
const base = `http://127.0.0.1:${handle.port}`;

function jsonRpcHeaders(token: string, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

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

  test("empty bearer token (Bearer with nothing after it) → 401", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer " }, body: "{}" });
    expect(r.status).toBe(401);
  });

  test("full MCP round-trip over HTTP with a valid token", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN_A}` } },
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
      const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN_A}` } } });
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
      headers: jsonRpcHeaders(TOKEN_A, "nope"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(404);
  });

  test("regression pin: session id 404s once the session has been terminated", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN_A}` } },
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    await client.listTools();
    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();

    // client.close() only aborts the client's local connection (verified against the SDK
    // source: Protocol.close() -> transport.close(), which never issues a DELETE). The real
    // "end of session" signal per the Streamable HTTP spec is the DELETE that
    // transport.terminateSession() sends — that's what actually tells the server to close
    // and forget this session, which is the behaviour this test pins.
    await transport.terminateSession();
    await client.close();

    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: jsonRpcHeaders(TOKEN_A, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(404);
  });

  test("a session id is only usable by the token whose owner opened it", async () => {
    const transportA = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN_A}` } },
    });
    const clientA = new Client({ name: "t", version: "0" });
    await clientA.connect(transportA);
    const sessionId = transportA.sessionId;
    expect(sessionId).toBeTruthy();

    const wrongOwner = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: jsonRpcHeaders(TOKEN_B, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(wrongOwner.status).toBe(404);
    expect(await wrongOwner.text()).not.toContain("rene");

    // the true owner's token still works
    const { tools } = await clientA.listTools();
    expect(tools).toHaveLength(1);
    await clientA.close();
  });
});

describe("session cap", () => {
  const capHandle = startHttpProxy({
    createServer: () => createProxyServer({ upstream: fakeUpstream(), sanitizer: okSanitizer, logger }),
    tokens: new Map([[TOKEN_A, "rene"]]),
    port: 0,
    logger,
    maxSessions: 1,
  });
  afterAll(() => capHandle.stop());
  const capBase = `http://127.0.0.1:${capHandle.port}`;

  test("oldest session is evicted once the cap would be exceeded", async () => {
    const mk = async () => {
      const t = new StreamableHTTPClientTransport(new URL(`${capBase}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN_A}` } } });
      const c = new Client({ name: "t", version: "0" });
      await c.connect(t);
      return { c, t };
    };
    const a = await mk();
    const sessionIdA = a.t.sessionId;
    expect(sessionIdA).toBeTruthy();

    const b = await mk();
    expect((await b.c.listTools()).tools).toHaveLength(1);

    const r = await fetch(`${capBase}/mcp`, {
      method: "POST",
      headers: jsonRpcHeaders(TOKEN_A, sessionIdA),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(404);

    await a.c.close();
    await b.c.close();
  });
});

describe("internal errors never leak a stack trace", () => {
  const brokenHandle = startHttpProxy({
    createServer: () => { throw new Error("boom-secret-detail"); },
    tokens: new Map([[TOKEN_A, "rene"]]),
    port: 0,
    logger,
  });
  afterAll(() => brokenHandle.stop());

  test("a thrown error while creating a session → static 500 body", async () => {
    const r = await fetch(`http://127.0.0.1:${brokenHandle.port}/mcp`, {
      method: "POST",
      headers: jsonRpcHeaders(TOKEN_A),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).not.toContain("boom-secret-detail");
    expect(JSON.parse(body)).toEqual({ error: "internal" });
  });
});
