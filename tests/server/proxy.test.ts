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
    async listTools() { return [{ name: "get_ticket", inputSchema: { type: "object" } }, { name: "delete_ticket", inputSchema: { type: "object" } }, { name: "search", inputSchema: { type: "object" } }, { name: "add_ticket_comment", description: "Append a comment.", inputSchema: { type: "object" } }]; },
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
    expect(tools.map((t) => t.name)).toEqual(["get_ticket", "search", "add_ticket_comment"]);
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
    const lines: string[] = [];
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "warn", sink: (l) => lines.push(l) }) });
    const err = await client.callTool({ name: "delete_ticket", arguments: { id: 1 } }).catch((e) => e);
    expect(String(err.message)).toContain("TOOL_NOT_ALLOWED");
    expect(up.calls).toEqual([]);
    expect(lines.join("\n")).toContain("[warn] delete_ticket blocked");
  });

  test("tools/list upstream failure maps to UPSTREAM_UNAVAILABLE without payload", async () => {
    const up = fakeUpstream({ async listTools() { throw new Error("EPIPE secret-host"); } });
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.listTools().catch((e) => e);
    expect(String(err.message)).toContain("UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(err)).not.toContain("EPIPE");
    expect(JSON.stringify(err)).not.toContain("secret-host");
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
    expect(JSON.stringify(err)).not.toContain("EPIPE");
  });

  test("sanitizer resolving to undefined → SANITIZER_INTERNAL, no raw error leak", async () => {
    const broken = { async sanitize(): Promise<any> { return undefined as any; } };
    const client = await connect({ upstream: fakeUpstream(), sanitizer: broken, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "get_ticket", arguments: { id: 1 } }).catch((e) => e);
    expect(String(err.message)).toContain("SANITIZER_INTERNAL");
    expect(String(err.message)).not.toContain("undefined");
    expect(String(err.message)).not.toContain("Cannot read");
  });

  test("sanitizer returning the raw result unchanged → SANITIZER_INTERNAL", async () => {
    const identity = { async sanitize(r: ToolResult) { return { result: r, counts: { PERSON: 0 } as any, perPass: { pass1: 0, pass2: 0 } }; } };
    const client = await connect({ upstream: fakeUpstream(), sanitizer: identity, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "get_ticket", arguments: { id: 1 } }).catch((e) => e);
    expect(String(err.message)).toContain("SANITIZER_INTERNAL");
  });

  test("ticketIdFrom", () => {
    expect(ticketIdFrom({ id: 4711 })).toBe("ticket 4711");
    expect(ticketIdFrom({ query: "type:ticket status:open" })).toBe("query");
    expect(ticketIdFrom({})).toBe("-");
  });

  test("public comment is rejected with a static error and never reaches upstream", async () => {
    const up = fakeUpstream();
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "add_ticket_comment", arguments: { id: 1, body: "hi", type: "public" } }).catch((e) => e);
    expect(String(err.message)).toContain("OUTGOING_REJECTED");
    expect(up.calls).toEqual([]);
  });

  test("placeholder in body is rejected; clean internal comment is forwarded with author_id stripped", async () => {
    const up = fakeUpstream();
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "add_ticket_comment", arguments: { id: 1, body: "tell [PERSON_1]" } }).catch((e) => e);
    expect(String(err.message)).toContain("OUTGOING_REJECTED");
    await client.callTool({ name: "add_ticket_comment", arguments: { id: 1, body: "resolved via KB-42", author_id: 7 } });
    expect(up.calls).toEqual([["add_ticket_comment", { id: 1, body: "resolved via KB-42", type: "internal" }]]);
  });

  test("non-string body is rejected with the invalid-body sentence and never reaches upstream", async () => {
    const up = fakeUpstream();
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "add_ticket_comment", arguments: { id: 1, body: { text: "hi" } } }).catch((e) => e);
    expect(String(err.message)).toContain("OUTGOING_REJECTED: the comment body must be a plain string");
    expect(up.calls).toEqual([]);
  });
});
