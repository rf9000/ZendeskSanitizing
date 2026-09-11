import type { SanitizeSession } from "../sanitize/session.ts";
import { PLACEHOLDER_RE } from "../sanitize/placeholders.ts";
import type { Chunk, Counts } from "../sanitize/types.ts";
import { applyFieldPolicy, fillFields } from "./fieldPolicy.ts";
import { rejoinFilename, splitFilename, toDetectionText } from "./filename.ts";

export interface TextContent { type: "text"; text: string }
export interface ToolResult {
  content: Array<TextContent | { type: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}
export interface ResultSanitizerDeps { newSession: () => SanitizeSession }
export interface SanitizedResult { result: ToolResult; counts: Counts; perPass: { pass1: number; pass2: number } }

export function decodeText(text: string): { prefix: string; json: unknown | undefined; raw: string } {
  const start = text.search(/[[{]/);
  if (start >= 0) {
    const candidate = text.slice(start);
    try {
      return { prefix: text.slice(0, start), json: JSON.parse(candidate), raw: text };
    } catch { /* fall through */ }
  }
  return { prefix: "", json: undefined, raw: text };
}

export function encodeText(prefix: string, json: unknown): string {
  return prefix + JSON.stringify(json, null, 2);
}

interface FilenameMeta { ext: string; original: string }
interface Pending { index: number; prefix: string; skeleton?: unknown; whole?: boolean; filenames?: Map<string, FilenameMeta> }
const PREFIX_KEY = "__prefix";

export function createResultSanitizer(deps: ResultSanitizerDeps) {
  return {
    async sanitize(result: ToolResult): Promise<SanitizedResult> {
      const session = deps.newSession();
      const chunks: Chunk[] = [];
      const pending: Pending[] = [];

      result.content.forEach((item, index) => {
        if (item.type !== "text" || typeof (item as TextContent).text !== "string") return; // dropped
        const { prefix, json, raw } = decodeText((item as TextContent).text);
        if (json === undefined) {
          chunks.push({ id: `${index}:`, text: raw });
          pending.push({ index, prefix: "", whole: true });
          return;
        }
        const { skeleton, fields } = applyFieldPolicy(json);
        let filenames: Map<string, FilenameMeta> | undefined;
        for (const f of fields) {
          if (f.kind === "filename") {
            filenames ??= new Map();
            const { stem, ext } = splitFilename(f.text);
            filenames.set(f.path, { ext, original: f.text });
            // Two views, analyzed independently: the ORIGINAL text (so pattern recognizers
            // that need intact punctuation — CPR, phone, IBAN, card — still fire, exactly as
            // on main) and the tokenized STEM (so a glued-together name gets word-boundary
            // spacing). Refill prefers the original-view result when it redacted anything.
            chunks.push({ id: `${index}:${f.path}`, text: f.text });
            chunks.push({ id: `${index}:${f.path}#stem`, text: toDetectionText(stem) });
          } else {
            chunks.push({ id: `${index}:${f.path}`, text: f.text });
          }
        }
        // The prefix is upstream free text too (e.g. "Validation Error: requester <name> not found\n\nDetails:\n") — sanitize it.
        if (prefix) chunks.push({ id: `${index}:${PREFIX_KEY}`, text: prefix });
        pending.push({ index, prefix, skeleton, filenames });
      });

      const out = await session.sanitize(chunks);

      const content: TextContent[] = pending.map((p) => {
        if (p.whole) return { type: "text", text: out.texts.get(`${p.index}:`)! };
        const texts = new Map<string, string>();
        for (const [id, t] of out.texts) if (id.startsWith(`${p.index}:`)) texts.set(id.slice(`${p.index}:`.length), t);
        const prefix = p.prefix ? texts.get(PREFIX_KEY)! : "";
        texts.delete(PREFIX_KEY);
        if (p.filenames) {
          for (const [path, meta] of p.filenames) {
            const sanitizedOriginal = texts.get(path)!;
            const stemKey = `${path}#stem`;
            const sanitizedStem = texts.get(stemKey)!;
            texts.delete(stemKey);
            // Preference order: (a) the original-view result, verbatim, if it redacted
            // anything — this preserves structure/separators and catches pattern-based PII
            // (CPR, phone, IBAN, card) that needs the original punctuation intact; (b) else the
            // stem-view result, rejoined, if IT redacted something (catches a glued-together
            // name the original view couldn't see word boundaries in); (c) else the original
            // filename, byte-for-byte. Known limitation: a filename with both a pattern value
            // and a glued name only gets the pattern redacted (rule (a) wins outright) — see
            // resultSanitizer.test.ts for a pinned example; never worse than not tokenizing.
            if ([...sanitizedOriginal.matchAll(PLACEHOLDER_RE)].length > 0) {
              texts.set(path, sanitizedOriginal);
            } else if ([...sanitizedStem.matchAll(PLACEHOLDER_RE)].length > 0) {
              texts.set(path, rejoinFilename(sanitizedStem, meta.ext));
            } else {
              texts.set(path, meta.original);
            }
          }
        }
        return { type: "text", text: encodeText(prefix, fillFields(p.skeleton, texts)) };
      });

      const sanitized: ToolResult = { content };
      if (result.isError) sanitized.isError = true;
      return { result: sanitized, counts: out.counts, perPass: out.perPass };
    },
  };
}
