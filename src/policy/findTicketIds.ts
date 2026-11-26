import { decodeText, type TextContent, type ToolResult } from "./resultSanitizer.ts";

/**
 * `find_ticket_ids`: a tool of the proxy itself, not of the upstream server. It runs the upstream
 * `search` for tickets and returns the id, the status and the creation time of each hit, and
 * nothing else. No ticket text leaves the proxy, so the result does not go through the sanitizer.
 *
 * It exists for a client that polls for new tickets: the forwarded `search` masks every text of
 * every hit with the models, which a poll every few minutes does not need.
 */
export const FIND_TICKET_IDS = {
  name: "find_ticket_ids",
  description:
    "Find tickets with a Zendesk search query and return only id, status and created_at per ticket, newest first. " +
    "No ticket text is returned. `type:ticket` is added to the query. Use get_ticket to read a ticket.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Zendesk search terms, for example `status:new tags:banking created>=2026-11-26T08:00:00Z`. At most 500 characters, one line." },
      limit: { type: "number", description: "Most tickets to return, 1 to 50. Defaults to 25." },
    },
    required: ["query"],
  },
} as const;

export const MAX_FIND_LIMIT = 50;
const DEFAULT_FIND_LIMIT = 25;
const MAX_QUERY_CHARS = 500;

export class FindArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindArgsError";
  }
}

/** The upstream result could not be read as a list of hits. The message never carries the payload. */
export class FindResultError extends Error {
  constructor() {
    super("unreadable search result");
    this.name = "FindResultError";
  }
}

export interface UpstreamSearchArgs { query: string; sort_by: "created_at"; sort_order: "desc"; per_page: number; [k: string]: unknown }

/** Checks the caller's arguments and builds the arguments of the upstream `search`. */
export function parseFindArgs(args: Record<string, unknown>): UpstreamSearchArgs {
  const raw = args.query;
  if (typeof raw !== "string" || raw.trim() === "") throw new FindArgsError("query must be a non-empty string");
  const terms = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (terms.length > MAX_QUERY_CHARS || /[\u0000-\u001f\u007f]/.test(terms)) throw new FindArgsError("query must be one line of at most 500 characters");
  const types = [...terms.matchAll(/(?:^|\s)type:(\S+)/gi)].map((m) => m[1]!.toLowerCase());
  if (types.some((t) => t !== "ticket")) throw new FindArgsError("only type:ticket can be searched with this tool");
  const limit = args.limit ?? DEFAULT_FIND_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_FIND_LIMIT) {
    throw new FindArgsError("limit must be a whole number from 1 to 50");
  }
  return { query: types.length > 0 ? terms : `type:ticket ${terms}`, sort_by: "created_at", sort_order: "desc", per_page: limit };
}

export interface FoundTicket { id: number; status: string | null; created_at: string | null }

const STATUS_RE = /^[a-z_]{1,20}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Reduces an upstream `search` result to ids. A value is copied only when it has the plain form
 * of an id, a status word or a timestamp, so free text cannot pass in one of the three fields.
 */
export function ticketIdsFrom(result: ToolResult): { count: number; tickets: FoundTicket[] } {
  if (result.isError) throw new FindResultError();
  for (const item of result.content) {
    if (item.type !== "text" || typeof (item as TextContent).text !== "string") continue;
    const { json } = decodeText((item as TextContent).text);
    const list = Array.isArray(json) ? json : json && typeof json === "object" ? (json as { results?: unknown }).results : undefined;
    if (!Array.isArray(list)) continue;
    const tickets: FoundTicket[] = [];
    for (const hit of list) {
      if (!hit || typeof hit !== "object") continue;
      const h = hit as { id?: unknown; result_type?: unknown; status?: unknown; created_at?: unknown };
      if (h.result_type !== undefined && h.result_type !== "ticket") continue;
      if (typeof h.id !== "number" || !Number.isSafeInteger(h.id) || h.id < 1) continue;
      tickets.push({
        id: h.id,
        status: typeof h.status === "string" && STATUS_RE.test(h.status) ? h.status : null,
        created_at: typeof h.created_at === "string" && TIME_RE.test(h.created_at) ? h.created_at : null,
      });
    }
    const total = (json as { count?: unknown }).count;
    return { count: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : tickets.length, tickets };
  }
  throw new FindResultError();
}
