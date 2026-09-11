import { describe, expect, test } from "bun:test";
import {
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  OutgoingRejectedError,
  amendToolList,
  filterToolList,
  isAllowedTool,
  rewriteOutgoingArguments,
} from "@/policy/toolPolicy.ts";

describe("toolPolicy", () => {
  test("allowlist is exactly the read-only set", () => {
    expect([...READ_ONLY_TOOLS].sort()).toEqual([
      "get_organization", "get_ticket", "get_ticket_attachments", "get_ticket_comments",
      "list_organizations", "list_tickets", "search", "support_info",
    ]);
  });

  test("blocks side-channel, write, delete and user tools", () => {
    for (const t of ["analyze_ticket_images", "analyze_ticket_documents", "get_document_summary",
      "create_ticket", "update_ticket", "delete_ticket", "get_user", "list_users", "create_macro"]) {
      expect(isAllowedTool(t)).toBe(false);
    }
  });

  test("filterToolList keeps order and drops blocked", () => {
    const tools = [{ name: "search" }, { name: "delete_ticket" }, { name: "get_ticket" }];
    expect(filterToolList(tools)).toEqual([{ name: "search" }, { name: "get_ticket" }]);
  });

  test("WRITE_TOOLS is exactly add_ticket_comment", () => {
    expect([...WRITE_TOOLS]).toEqual(["add_ticket_comment"]);
  });
});

describe("outgoing policy", () => {
  test("add_ticket_comment is allowed; other writes stay blocked", () => {
    expect(isAllowedTool("add_ticket_comment")).toBe(true);
    expect(isAllowedTool("update_ticket")).toBe(false);
  });
  test("forces internal and strips author_id", () => {
    const out = rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: "ok", type: "internal", author_id: 99 });
    expect(out).toEqual({ id: 1, body: "ok", type: "internal" });
    const defaulted = rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: "ok" });
    expect(defaulted.type).toBe("internal");
  });
  test("rejects public comments", () => {
    expect(() => rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: "ok", type: "public" }))
      .toThrow(OutgoingRejectedError);
  });
  test("rejects placeholder tokens in the body — including repeated calls (shared /g regex)", () => {
    for (let i = 0; i < 3; i++) {
      expect(() => rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: `ping [PERSON_${i + 1}] about it` }))
        .toThrow(OutgoingRejectedError);
    }
    expect(() => rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: "no tokens [PERSON_x] here" })).not.toThrow();
  });
  test("other tools pass through untouched", () => {
    const args = { id: 1, body: "[PERSON_1]" };
    expect(rewriteOutgoingArguments("get_ticket", args)).toBe(args);
  });
  test("amendToolList rewrites the comment tool's description and still filters", () => {
    const tools = [
      { name: "add_ticket_comment", description: "Append a comment." },
      { name: "delete_ticket", description: "x" },
      { name: "get_ticket", description: "y" },
    ];
    const out = amendToolList(tools);
    expect(out.map((t) => t.name)).toEqual(["add_ticket_comment", "get_ticket"]);
    expect(out[0]!.description).toContain("internal");
  });
});
