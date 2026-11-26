import { describe, expect, test } from "bun:test";
import { FIND_TICKET_IDS, FindArgsError, FindResultError, parseFindArgs, ticketIdsFrom } from "@/policy/findTicketIds.ts";

const text = (json: unknown, prefix = "") => ({ content: [{ type: "text", text: prefix + JSON.stringify(json) }] });

describe("find_ticket_ids arguments", () => {
  test("a query and a limit become one upstream search for tickets, newest first", () => {
    expect(parseFindArgs({ query: "status:new tags:banking", limit: 10 })).toEqual({
      query: "type:ticket status:new tags:banking", sort_by: "created_at", sort_order: "desc", per_page: 10,
    });
  });

  test("the limit defaults to 25", () => {
    expect(parseFindArgs({ query: "status:new" }).per_page).toBe(25);
  });

  test("a query that already asks for tickets is not prefixed twice", () => {
    expect(parseFindArgs({ query: "type:ticket status:open" }).query).toBe("type:ticket status:open");
  });

  test("a query for another type is refused", () => {
    expect(() => parseFindArgs({ query: "type:user name" })).toThrow(FindArgsError);
  });

  test("refuses a missing, empty, long or multi-line query and a limit outside 1 to 50", () => {
    for (const args of [{}, { query: "" }, { query: "  " }, { query: 7 }, { query: "a".repeat(501) }, { query: "status:new\nx" },
      { query: "status:new", limit: 0 }, { query: "status:new", limit: 51 }, { query: "status:new", limit: 2.5 }, { query: "status:new", limit: "5" }]) {
      expect(() => parseFindArgs(args as Record<string, unknown>)).toThrow(FindArgsError);
    }
  });

  test("the tool definition names the tool and its two arguments", () => {
    expect(FIND_TICKET_IDS.name).toBe("find_ticket_ids");
    expect(Object.keys((FIND_TICKET_IDS.inputSchema as any).properties)).toEqual(["query", "limit"]);
  });
});

describe("find_ticket_ids result", () => {
  const hit = { id: 4711, result_type: "ticket", status: "new", created_at: "2026-11-26T08:15:00Z", subject: "Mette Sørensen cannot pay", description: "Call 12 34 56 78", requester_id: 9 };

  test("keeps id, status and created_at of ticket hits and nothing else", () => {
    const out = ticketIdsFrom(text({ results: [hit], count: 1, next_page: null }));
    expect(out).toEqual({ count: 1, tickets: [{ id: 4711, status: "new", created_at: "2026-11-26T08:15:00Z" }] });
    expect(JSON.stringify(out)).not.toContain("Mette");
  });

  test("reads the JSON behind a text prefix, and a bare list", () => {
    expect(ticketIdsFrom(text({ results: [hit] }, "Found 1 result:\n\n")).tickets).toHaveLength(1);
    expect(ticketIdsFrom(text([hit])).tickets).toHaveLength(1);
  });

  test("drops hits that are not tickets or have no whole-number id", () => {
    const out = ticketIdsFrom(text({ results: [{ ...hit, result_type: "user" }, { ...hit, id: "4711" }, { ...hit, id: 1.5 }, { ...hit, id: 12 }] }));
    expect(out.tickets.map((t) => t.id)).toEqual([12]);
  });

  test("a status or a time that is not in the plain form becomes null", () => {
    const out = ticketIdsFrom(text({ results: [{ ...hit, status: "Mette Sørensen", created_at: "call Mette" }] }));
    expect(out.tickets).toEqual([{ id: 4711, status: null, created_at: null }]);
  });

  test("count falls back to the number of tickets kept", () => {
    expect(ticketIdsFrom(text({ results: [hit, { ...hit, id: 2 }] })).count).toBe(2);
  });

  test("an upstream error, no JSON, or JSON without a result list is refused", () => {
    expect(() => ticketIdsFrom({ ...text({ results: [] }), isError: true })).toThrow(FindResultError);
    expect(() => ticketIdsFrom({ content: [{ type: "text", text: "Mette Sørensen" }] })).toThrow(FindResultError);
    expect(() => ticketIdsFrom(text({ ticket: hit }))).toThrow(FindResultError);
    expect(() => ticketIdsFrom({ content: [] })).toThrow(FindResultError);
  });
});
