import { PLACEHOLDER_RE } from "../sanitize/placeholders.ts";

/**
 * Tools the proxy forwards. Everything else is blocked and never listed.
 * Widening this set requires a PR and a green e2e run (spec §5).
 * Blocked on purpose: analyze_ticket_images / analyze_ticket_documents / get_document_summary
 * (send attachments to the Anthropic API and a third-party converter), all other create/update/
 * delete, get_user / list_users (PII by definition).
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

/**
 * The one write tool the proxy forwards, with outgoing inspection (spec §3.2):
 * always rewritten to an internal-only note, and rejected if the body still
 * carries a sanitization placeholder like [PERSON_1].
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["add_ticket_comment"]);

export function isAllowedTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name) || WRITE_TOOLS.has(name);
}

export function filterToolList<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => isAllowedTool(t.name));
}

export class OutgoingRejectedError extends Error {
  readonly reason: "public_comment" | "placeholder_in_body" | "invalid_body";

  constructor(reason: "public_comment" | "placeholder_in_body" | "invalid_body") {
    super(reason);
    this.name = "OutgoingRejectedError";
    this.reason = reason;
  }
}

function containsPlaceholder(text: string): boolean {
  return [...text.matchAll(PLACEHOLDER_RE)].length > 0;
}

/**
 * Inspects/rewrites outgoing tool-call arguments before they reach upstream.
 * add_ticket_comment is forced to an internal note and stripped of author_id;
 * any string `type` other than (case-insensitively) "internal" is rejected as
 * a public comment; a present-but-non-string `body` is rejected outright
 * (fail closed rather than coercing it); and every string-valued argument —
 * not just `body` — is scanned for a leftover sanitization placeholder like
 * [PERSON_1]. Every other tool's arguments pass through unchanged (same
 * reference).
 */
export function rewriteOutgoingArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== "add_ticket_comment") return args;

  if (typeof args.type === "string" && args.type.toLowerCase() !== "internal") {
    throw new OutgoingRejectedError("public_comment");
  }

  if ("body" in args && typeof args.body !== "string") {
    throw new OutgoingRejectedError("invalid_body");
  }

  for (const v of Object.values(args)) {
    if (typeof v === "string" && containsPlaceholder(v)) {
      throw new OutgoingRejectedError("placeholder_in_body");
    }
  }

  const { author_id: _authorId, ...rest } = args;
  return { ...rest, type: "internal" };
}

const INTERNAL_ONLY_NOTE =
  " (This proxy forces this tool to post internal notes only; public comments and bodies containing sanitization placeholders are rejected.)";

/**
 * Filters the upstream tool list by isAllowedTool and rewrites
 * add_ticket_comment's description to disclose the internal-only behavior.
 */
export function amendToolList<T extends { name: string; description?: string }>(tools: T[]): T[] {
  return filterToolList(tools).map((t) =>
    t.name === "add_ticket_comment" ? { ...t, description: (t.description ?? "") + INTERNAL_ONLY_NOTE } : t,
  );
}
