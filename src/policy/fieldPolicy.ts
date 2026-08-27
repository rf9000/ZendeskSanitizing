export type FieldRule = "drop" | "idOnly" | "keep" | "sanitize";
export interface CollectedField { path: string; text: string }

const MARKER = "__zsan";

/** Ordered suffix rules. Segments compare against the actual path with numeric indices removed. */
const RULES: Array<[string, FieldRule]> = [
  // PII-by-definition objects → { id }
  ["requester", "idOnly"], ["submitter", "idOnly"], ["assignee", "idOnly"], ["author", "idOnly"],
  ["collaborators", "idOnly"], ["email_ccs", "idOnly"], ["followers", "idOnly"], ["user", "idOnly"], ["users", "idOnly"],
  // dropped outright
  ["via.source.from", "drop"], ["via.source.to", "drop"], ["html_body", "drop"],
  ["content_url", "drop"], ["mapped_content_url", "drop"],
  ["metadata.system.client", "drop"], ["metadata.system.ip_address", "drop"], ["metadata.system.location", "drop"],
  ["metadata.system.latitude", "drop"], ["metadata.system.longitude", "drop"],
  ["domain_names", "drop"], ["details", "drop"], ["notes", "drop"], ["external_id", "drop"],
  // safe strings
  ["url", "keep"], ["next_page", "keep"], ["previous_page", "keep"], ["status", "keep"], ["priority", "keep"],
  ["type", "keep"], ["channel", "keep"], ["content_type", "keep"], ["created_at", "keep"], ["updated_at", "keep"],
  ["due_at", "keep"], ["locale", "keep"], ["time_zone", "keep"], ["sort_by", "keep"], ["sort_order", "keep"],
];

function stripIndices(path: string[]): string[] {
  return path.filter((s) => !/^\d+$/.test(s));
}

function suffixMatches(path: string[], rule: string): boolean {
  const r = rule.split(".");
  if (r.length > path.length) return false;
  return r.every((seg, i) => path[path.length - r.length + i] === seg);
}

export function ruleFor(pathSegments: string[], value: unknown): FieldRule {
  const path = stripIndices(pathSegments);
  for (const [rule, action] of RULES) {
    if (suffixMatches(path, rule)) {
      // idOnly only makes sense for objects; a bare *_id number is already handled by "keep" below
      if (action === "idOnly" && (typeof value !== "object" || value === null)) continue;
      return action;
    }
  }
  return typeof value === "string" ? "sanitize" : "keep";
}

const DROP: unique symbol = Symbol("drop");

export function applyFieldPolicy(payload: unknown): { skeleton: unknown; fields: CollectedField[] } {
  const fields: CollectedField[] = [];

  // Every value in the tree — object property, array element, or the payload itself — goes
  // through the same rule check on its own full path. "keep" is only a true pass-through for
  // leaf values; for objects/arrays it means "no rule fired here", so we still recurse into
  // children (each re-evaluated against the RULES table at its own path).
  const process = (value: unknown, path: string[]): unknown => {
    // Value-conditional rule, evaluated before the path-suffix table: search-result "hits" carry
    // their own type tag rather than a distinctive key name, so the suffix engine can't express
    // this. A user hit is reduced to { id, result_type } — the tag is kept (not PII, and
    // downstream consumers need to know the hit was a user) but every other field is dropped.
    if (typeof value === "object" && value !== null && !Array.isArray(value) && (value as { result_type?: unknown }).result_type === "user") {
      const id = (value as { id?: unknown }).id;
      return { id: id ?? null, result_type: "user" };
    }

    const rule = ruleFor(path, value);
    if (rule === "drop") return DROP;
    if (rule === "idOnly") {
      // Zendesk sends arrays for some idOnly fields (collaborators, followers, email_ccs, users).
      if (Array.isArray(value)) {
        return value.map((v) => (v && typeof v === "object" && "id" in (v as object) ? { id: (v as { id: unknown }).id } : null));
      }
      const id = (value as { id?: unknown }).id;
      return id === undefined ? null : { id };
    }
    if (rule === "sanitize") {
      const id = path.join(".");
      fields.push({ path: id, text: value as string });
      return { [MARKER]: id };
    }
    // rule === "keep"
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      value.forEach((v, i) => {
        const r = process(v, [...path, String(i)]);
        if (r !== DROP) out.push(r);
      });
      return out;
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        // A key literally named "__zsan" arriving from upstream (not one we generated) must never
        // survive into the skeleton, where it could be mistaken for our own sanitize marker.
        if (key === MARKER) continue;
        const r = process(v, [...path, key]);
        if (r !== DROP) out[key] = r;
      }
      return out;
    }
    return value;
  };

  const skeleton = process(payload, []);
  return { skeleton: skeleton === DROP ? undefined : skeleton, fields };
}

export function fillFields(skeleton: unknown, texts: Map<string, string>): unknown {
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill);
    if (typeof value !== "object" || value === null) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === MARKER && typeof (value as Record<string, unknown>)[MARKER] === "string") {
      const id = (value as Record<string, string>)[MARKER]!;
      const t = texts.get(id);
      if (t === undefined) throw new Error(`fieldPolicy: unfilled sanitize marker at "${id}"`);
      return t;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  };
  return fill(skeleton);
}
