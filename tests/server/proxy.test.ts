import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyServer, ticketIdFrom } from "@/server/proxy.ts";
import { createLogger } from "@/logging.ts";
import { SanitizerError } from "@/sanitize/types.ts";
import type { UpstreamClient } from "@/upstream/client.ts";
import type { ToolResult } from "@/policy/resultSanitizer.ts";

const RAW = '{"ticket":{"id":1,"subject":"Mette Sørensen"}}';

function fakeUpstream(over: Partial<UpstreamClient> = {}): UpstreamClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    async listTools() { return [{ name: "get_ticket", inputSchema: { type: "object" } }, { name: "delete_ticket", inputSchema: { type: "object" } }, { name: "search", inputSchema: { type: "object" } }]; },
    async callTool(name, args) { calls.push([name, args]); return { content: [{ type: "text", text: RAW }] }; },
    async close() {},
    ...over,
  };
}

const okSanitizer = {
  async sanitize(r: ToolResult) {
    return { result: { content: [{ type: "text" as const, text: "SANITIZED" }] }, counts: { PERSON: 1 } as any, perPass: { pass1: 1, pass2: 0 } };
  },
};

async function connect(deps: Parameters<typeof createProxyServer>[0]) {
  const server = createProxyServer(deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

describe("proxy", () => {
  test("tools/list exposes only allowed tools", async () => {
    const lines: string[] = [];
    const client = await connect({ upstream: fakeUpstream(), sanitizer: okSanitizer, logger: createLogger({ level: "debug", sink: (l) => lines.push(l) }) });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_ticket", "search"]);
  });

  test("tools/call forwards, sanitizes, logs counts only", async () => {
    const lines: string[] = [];
    const up = fakeUpstream();
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "info", sink: (l) => lines.push(l) }), now: (() => { let t = 0; return () => (t += 25); })() });
    const res = await client.callTool({ name: "get_ticket", arguments: { id: 4711 } });
    expect(up.calls).toEqual([["get_ticket", { id: 4711 }]]);
    expect((res.content as any)[0].text).toBe("SANITIZED");
    expect(lines.join("\n")).toContain("get_ticket ticket 4711: PERSON 1 (pass1 1, pass2 0) 25ms");
    expect(lines.join("\n")).not.toContain("Mette");
  });

  test("blocked tool is rejected before reaching upstream", async () => {
    const up = fakeUpstream();
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "delete_ticket", arguments: { id: 1 } }).catch((e) => e);
    expect(String(err.message)).toContain("TOOL_NOT_ALLOWED");
    expect(up.calls).toEqual([]);
  });

  test("sanitizer failure → error without payload", async () => {
    const failing = { async sanitize(): Promise<never> { throw new SanitizerError("SANITIZER_UNAVAILABLE", `presidio down while handling ${RAW}`); } };
    const lines: string[] = [];
    const client = await connect({ upstream: fakeUpstream(), sanitizer: failing, logger: createLogger({ level: "error", sink: (l) => lines.push(l) }) });
    const err = await client.callTool({ name: "get_ticket", arguments: { id: 1 } }).catch((e) => e);
    expect(String(err.message)).toContain("SANITIZER_UNAVAILABLE");
    expect(String(err.message)).not.toContain("Mette");
    expect(JSON.stringify(err)).not.toContain("Mette");
  });

  test("unexpected sanitizer exception → SANITIZER_INTERNAL, no payload", async () => {
    const failing = { async sanitize(): Promise<never> { throw new TypeError(`bug ${RAW}`); } };
    const client = await connect({ upstream: fakeUpstream(), sanitizer: failing, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "get_ticket", arguments: { id: 1 } }).catch((e) => e);
    expect(String(err.message)).toContain("SANITIZER_INTERNAL");
    expect(String(err.message)).not.toContain("Mette");
  });

  test("upstream failure → UPSTREAM_UNAVAILABLE", async () => {
    const up = fakeUpstream({ async callTool() { throw new Error("EPIPE"); } });
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "get_ticket", arguments: { id: 1 } }).catch((e) => e);
    expect(String(err.message)).toContain("UPSTREAM_UNAVAILABLE");
  });

  test("ticketIdFrom", () => {
    expect(ticketIdFrom({ id: 4711 })).toBe("ticket 4711");
    expect(ticketIdFrom({ query: "type:ticket status:open" })).toBe("query");
    expect(ticketIdFrom({})).toBe("-");
  });
});
