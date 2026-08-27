import { describe, expect, test } from "bun:test";
import { READ_ONLY_TOOLS, filterToolList, isAllowedTool } from "@/policy/toolPolicy.ts";

describe("toolPolicy", () => {
  test("allowlist is exactly the read-only set", () => {
    expect([...READ_ONLY_TOOLS].sort()).toEqual([
      "get_organization", "get_ticket", "get_ticket_attachments", "get_ticket_comments",
      "list_organizations", "list_tickets", "search", "support_info",
    ]);
  });

  test("blocks side-channel, write, delete and user tools", () => {
    for (const t of ["analyze_ticket_images", "analyze_ticket_documents", "get_document_summary",
      "add_ticket_comment", "create_ticket", "update_ticket", "delete_ticket", "get_user", "list_users", "create_macro"]) {
      expect(isAllowedTool(t)).toBe(false);
    }
  });

  test("filterToolList keeps order and drops blocked", () => {
    const tools = [{ name: "search" }, { name: "delete_ticket" }, { name: "get_ticket" }];
    expect(filterToolList(tools)).toEqual([{ name: "search" }, { name: "get_ticket" }]);
  });
});
