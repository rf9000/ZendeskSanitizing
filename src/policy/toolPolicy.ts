/**
 * Tools the proxy forwards. Everything else is blocked and never listed.
 * Widening this set requires a PR and a green e2e run (spec §5).
 * Blocked on purpose: analyze_ticket_images / analyze_ticket_documents / get_document_summary
 * (send attachments to the Anthropic API and a third-party converter), all create/update/delete,
 * add_ticket_comment (Plan 2, with outgoing inspection), get_user / list_users (PII by definition).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_ticket",
  "get_ticket_comments",
  "search",
  "list_tickets",
  "get_ticket_attachments",
  "get_organization",
  "list_organizations",
  "support_info",
]);

export function isAllowedTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

export function filterToolList<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => isAllowedTool(t.name));
}

export class ToolNotAllowedError extends Error {
  constructor(readonly tool: string) {
    super(`tool not available through the sanitizing proxy: ${tool}`);
    this.name = "ToolNotAllowedError";
  }
}
