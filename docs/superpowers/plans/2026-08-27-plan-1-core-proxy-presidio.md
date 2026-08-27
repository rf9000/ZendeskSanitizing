# Zendesk Sanitizing Proxy — Plan 1: Core proxy + Presidio pass (laptop mode)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stdio MCP proxy that forwards a read-only set of Zendesk tools to `@sshadows/zendesk-mcp-server`, sanitizes every response with Presidio (da/en/de + Danish CPR) into stable per-call placeholders, and fails closed — runnable on a developer laptop with Docker Desktop.

**Architecture:** `src/sanitize/` is a pure, dependency-injected library (`SanitizeSession` owns a per-call `PlaceholderTable`; `Pass1Client` is Presidio; a `SpanDetector` slot for pass 2 exists but is `null` in this plan). `src/policy/` turns a Zendesk JSON payload into text chunks via a field policy and back. `src/server/proxy.ts` wires an MCP `Server` to an upstream MCP `Client` (child process, clean env) and routes every `tools/call` result through the sanitizer. Any failure → `McpError`, never the payload.

**Tech Stack:** Bun 1.3.x, TypeScript (strict), `bun:test`, Zod 4, `@modelcontextprotocol/sdk` 1.30.0, `franc` 6 (language detection), Presidio analyzer (Docker, digest-pinned, custom image with 3 spaCy `lg` models).

**Spec:** `docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md` — read §§4–8 and §11 before starting.

## Global Constraints

- Fail closed: no code path may return upstream text to the MCP client unless it has passed through `SanitizeSession.sanitize`. Error messages are static strings + a code; they never embed payload fragments.
- Logs carry counts only. Every log line passes through `redactionGuard()`.
- Placeholder grammar: `[<TYPE>_<n>]`, `TYPE ∈ PERSON|ORG|EMAIL|PHONE|CPR|IBAN|CARD|ADDRESS|USERNAME|OTHER`, `n` starts at 1, per `SanitizeSession`.
- Env vars are prefixed `ZSAN_`, validated with Zod in `src/config.ts`; `loadConfig(env)` takes the env as a parameter for tests.
- The upstream child receives **only** `PATH`, `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN`, with `cwd` = a fresh empty temp directory.
- Tool allowlist in this plan: `get_ticket`, `get_ticket_comments`, `search`, `list_tickets`, `get_ticket_attachments`, `get_organization`, `list_organizations`, `support_info`. Nothing else is forwarded or listed. (`add_ticket_comment` is Plan 2.)
- CPR validation: date-only (DDMMYY + 7th-digit century rule). No modulus-11.
- Unknown string fields in a payload default to `sanitize`.
- TDD per `CLAUDE.md`: write the failing test, run it red, implement, run green, commit. Include real test output when reporting.
- Never put real ticket data in the repo. Fixtures are synthetic.
- Conventions from sibling projects: `tests/` mirrors `src/`; DI via `Deps`-style interfaces; `bun test --preload ./tests/setup.ts`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work on a feature branch (`feat/plan-1-core-proxy`), not `main`.

## File structure (this plan)

```
package.json, tsconfig.json, bunfig.toml, .gitignore, .env.example, README.md
src/
  config.ts                      Zod ZSAN_* schema → AppConfig
  logging.ts                     Logger + redactionGuard
  sanitize/
    types.ts                     Lang, EntityType, Span, Chunk, Pass1Client, SpanDetector, SanitizerError
    placeholders.ts              PlaceholderTable, normalizeValue, PLACEHOLDER_RE
    replace.ts                   resolveOverlaps, applySpans
    chunking.ts                  splitText (lossless)
    language.ts                  detectLang (franc, da|en|de)
    allowlist.ts                 Allowlist (load from text, isAllowed)
    cpr.ts                       isValidCpr
    presidio.ts                  PresidioClient implements Pass1Client
    session.ts                   SanitizeSession
    index.ts                     re-exports
  policy/
    toolPolicy.ts                READ_ONLY_TOOLS, isAllowedTool, filterToolList
    fieldPolicy.ts               applyFieldPolicy (drop/idOnly/keep/sanitize walk), fillFields
    resultSanitizer.ts           CallToolResult → decoded JSON → field policy → session → encoded
  upstream/
    child.ts                     spawnUpstream: StdioClientTransport with clean env, stderr capture
    client.ts                    UpstreamClient interface + McpUpstreamClient
  server/
    proxy.ts                     createProxyServer(deps): Server
    stdio.ts                     entry point (laptop mode)
config/
  allowlist.txt
  recognizers/cpr.json, recognizers/dk-phone.json
sidecars/presidio/
  Dockerfile, nlp.yml, recognizers.yml
deploy/
  docker-compose.yml, versions.env
tests/
  setup.ts, helpers/fakes.ts
  config.test.ts, logging.test.ts
  sanitize/{placeholders,replace,chunking,language,allowlist,cpr,presidio,session}.test.ts
  policy/{toolPolicy,fieldPolicy,resultSanitizer}.test.ts
  upstream/child.test.ts
  server/proxy.test.ts
  fixtures/tickets/*.json
  fixtures/presidio/*.json         recorded analyzer responses
  contract/presidio.contract.test.ts   (runs only with ZSAN_CONTRACT=1)
  e2e/fixtures.e2e.test.ts             (runs only with ZSAN_E2E=1)
```

---

### Task 1: Project scaffold and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `tests/setup.ts`, `src/config.ts`, `.env.example`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: Record<string, string | undefined>): AppConfig` and the `AppConfig` type:
  ```ts
  interface AppConfig {
    zendesk: { subdomain: string; email: string; apiToken: string };
    upstreamCommand: string;                 // e.g. "npx -y @sshadows/zendesk-mcp-server@1.4.1"
    presidioUrl: string;
    pass2: 'required' | 'off';
    pass2Detector: 'gliner' | 'ollama';
    glinerUrl: string | undefined;
    timeouts: { presidioMs: number; pass2Ms: number };
    chunkMaxChars: number;
    concurrency: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    allowlistPath: string;
  }
  ```

- [ ] **Step 1: Create branch and scaffold files**

```bash
git checkout -b feat/plan-1-core-proxy
```

`package.json`:
```json
{
  "name": "zendesk-sanitizing-proxy",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/server/stdio.ts",
    "test": "bun test --preload ./tests/setup.ts tests/**/*.test.ts",
    "test:unit": "bun test --preload ./tests/setup.ts tests/config.test.ts tests/logging.test.ts tests/sanitize tests/policy tests/upstream tests/server",
    "test:contract": "ZSAN_CONTRACT=1 bun test --preload ./tests/setup.ts tests/contract",
    "test:e2e": "ZSAN_E2E=1 bun test --preload ./tests/setup.ts tests/e2e",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "franc": "6.2.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/bun": "1.4.0",
    "typescript": "5.9.2"
  }
}
```

`tsconfig.json` — copy from `C:\GeneralDev\DevOpsPullers\DevOpsPullTemplate\tsconfig.json` verbatim (strict, `noUncheckedIndexedAccess`, `allowImportingTsExtensions`, `paths @/* → ./src/*`).

`bunfig.toml`:
```toml
[test]
preload = ["./tests/setup.ts"]
```

`tests/setup.ts`:
```ts
delete process.env.CLAUDECODE;
// Contract/e2e suites opt in via env; unit tests never touch the network.
```

`.gitignore`:
```
node_modules/
.env
.env.*
!.env.example
dist/
*.log
```

`.env.example`:
```
# Upstream Zendesk (laptop mode: on the developer machine; VM mode: only on the VM)
ZSAN_ZENDESK_SUBDOMAIN=
ZSAN_ZENDESK_EMAIL=
ZSAN_ZENDESK_API_TOKEN=
ZSAN_UPSTREAM_COMMAND=npx -y @sshadows/zendesk-mcp-server@1.4.1

# Sidecars
ZSAN_PRESIDIO_URL=http://127.0.0.1:5002
ZSAN_PASS2=required            # required | off  (off is logged loudly)
ZSAN_PASS2_DETECTOR=gliner     # gliner | ollama
ZSAN_GLINER_URL=http://127.0.0.1:5003

# Tuning
ZSAN_PRESIDIO_TIMEOUT_MS=15000
ZSAN_PASS2_TIMEOUT_MS=20000
ZSAN_CHUNK_MAX_CHARS=6000
ZSAN_CONCURRENCY=4
ZSAN_LOG_LEVEL=info
ZSAN_ALLOWLIST_PATH=config/allowlist.txt
```

Run `bun install`.

- [ ] **Step 2: Write the failing config test**

`tests/config.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "@/config.ts";

const minimal = {
  ZSAN_ZENDESK_SUBDOMAIN: "acme",
  ZSAN_ZENDESK_EMAIL: "bot@acme.example",
  ZSAN_ZENDESK_API_TOKEN: "tok",
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const c = loadConfig(minimal);
    expect(c.zendesk.subdomain).toBe("acme");
    expect(c.upstreamCommand).toBe("npx -y @sshadows/zendesk-mcp-server@1.4.1");
    expect(c.presidioUrl).toBe("http://127.0.0.1:5002");
    expect(c.pass2).toBe("required");
    expect(c.timeouts).toEqual({ presidioMs: 15000, pass2Ms: 20000 });
    expect(c.chunkMaxChars).toBe(6000);
    expect(c.concurrency).toBe(4);
    expect(c.logLevel).toBe("info");
  });

  test("lists every missing required var", () => {
    expect(() => loadConfig({})).toThrow(/ZSAN_ZENDESK_SUBDOMAIN[\s\S]*ZSAN_ZENDESK_EMAIL[\s\S]*ZSAN_ZENDESK_API_TOKEN/);
  });

  test("rejects unknown pass2 mode", () => {
    expect(() => loadConfig({ ...minimal, ZSAN_PASS2: "maybe" })).toThrow(/ZSAN_PASS2/);
  });

  test("coerces numeric tuning values", () => {
    const c = loadConfig({ ...minimal, ZSAN_CONCURRENCY: "8", ZSAN_PRESIDIO_TIMEOUT_MS: "100" });
    expect(c.concurrency).toBe(8);
    expect(c.timeouts.presidioMs).toBe(100);
  });
});
```

- [ ] **Step 3: Run it — expect failure**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `Cannot find module '@/config.ts'`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import { z } from "zod";

const envSchema = z.object({
  ZSAN_ZENDESK_SUBDOMAIN: z.string().min(1, "ZSAN_ZENDESK_SUBDOMAIN is required"),
  ZSAN_ZENDESK_EMAIL: z.string().min(1, "ZSAN_ZENDESK_EMAIL is required"),
  ZSAN_ZENDESK_API_TOKEN: z.string().min(1, "ZSAN_ZENDESK_API_TOKEN is required"),
  ZSAN_UPSTREAM_COMMAND: z.string().default("npx -y @sshadows/zendesk-mcp-server@1.4.1"),
  ZSAN_PRESIDIO_URL: z.string().url().default("http://127.0.0.1:5002"),
  ZSAN_PASS2: z.enum(["required", "off"]).default("required"),
  ZSAN_PASS2_DETECTOR: z.enum(["gliner", "ollama"]).default("gliner"),
  ZSAN_GLINER_URL: z.string().url().optional(),
  ZSAN_PRESIDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  ZSAN_PASS2_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  ZSAN_CHUNK_MAX_CHARS: z.coerce.number().int().min(200).default(6000),
  ZSAN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  ZSAN_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ZSAN_ALLOWLIST_PATH: z.string().default("config/allowlist.txt"),
});

export interface AppConfig {
  zendesk: { subdomain: string; email: string; apiToken: string };
  upstreamCommand: string;
  presidioUrl: string;
  pass2: "required" | "off";
  pass2Detector: "gliner" | "ollama";
  glinerUrl: string | undefined;
  timeouts: { presidioMs: number; pass2Ms: number };
  chunkMaxChars: number;
  concurrency: number;
  logLevel: "debug" | "info" | "warn" | "error";
  allowlistPath: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${messages}`);
  }
  const p = result.data;
  return {
    zendesk: { subdomain: p.ZSAN_ZENDESK_SUBDOMAIN, email: p.ZSAN_ZENDESK_EMAIL, apiToken: p.ZSAN_ZENDESK_API_TOKEN },
    upstreamCommand: p.ZSAN_UPSTREAM_COMMAND,
    presidioUrl: p.ZSAN_PRESIDIO_URL,
    pass2: p.ZSAN_PASS2,
    pass2Detector: p.ZSAN_PASS2_DETECTOR,
    glinerUrl: p.ZSAN_GLINER_URL,
    timeouts: { presidioMs: p.ZSAN_PRESIDIO_TIMEOUT_MS, pass2Ms: p.ZSAN_PASS2_TIMEOUT_MS },
    chunkMaxChars: p.ZSAN_CHUNK_MAX_CHARS,
    concurrency: p.ZSAN_CONCURRENCY,
    logLevel: p.ZSAN_LOG_LEVEL,
    allowlistPath: p.ZSAN_ALLOWLIST_PATH,
  };
}
```

- [ ] **Step 5: Run tests — expect pass; typecheck**

Run: `bun test tests/config.test.ts && bun run typecheck`
Expected: 4 pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json bunfig.toml .gitignore .env.example bun.lock tests/setup.ts src/config.ts tests/config.test.ts
git commit -m "feat: scaffold Bun project and ZSAN_ config loader

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Sanitize types and PlaceholderTable

**Files:**
- Create: `src/sanitize/types.ts`, `src/sanitize/placeholders.ts`
- Test: `tests/sanitize/placeholders.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type Lang = "da" | "en" | "de";
  export const ENTITY_TYPES = ["PERSON","ORG","EMAIL","PHONE","CPR","IBAN","CARD","ADDRESS","USERNAME","OTHER"] as const;
  export type EntityType = (typeof ENTITY_TYPES)[number];
  export type SpanSource = "presidio" | "gliner" | "ollama";
  export interface Span { start: number; end: number; type: EntityType; score: number; source: SpanSource }
  export interface Chunk { id: string; text: string; lang?: Lang }
  export interface Pass1Client { analyze(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]> }
  export interface SpanDetector { readonly name: string; detect(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]> }
  export type Counts = Record<EntityType, number>;
  export function emptyCounts(): Counts;
  export type SanitizerErrorCode = "SANITIZER_UNAVAILABLE" | "SANITIZER_INVALID_OUTPUT" | "SANITIZER_INTERNAL";
  export class SanitizerError extends Error { readonly code: SanitizerErrorCode; constructor(code, message) }
  ```
- Produces (`placeholders.ts`):
  ```ts
  export const PLACEHOLDER_RE: RegExp;                       // global, matches [TYPE_n]
  export function normalizeValue(value: string): string;      // trim, NFC, casefold, collapse whitespace
  export class PlaceholderTable {
    placeholderFor(type: EntityType, value: string): string; // stable; word-subset unification within type
    size(): number;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/sanitize/placeholders.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { PlaceholderTable, normalizeValue, PLACEHOLDER_RE } from "@/sanitize/placeholders.ts";

describe("normalizeValue", () => {
  test("trims, casefolds, collapses whitespace, NFC", () => {
    expect(normalizeValue("  Mette   SØRENSEN ")).toBe("mette sørensen");
    expect(normalizeValue("Me\u0301tte")).toBe("métte"); // combining accent → precomposed
  });
});

describe("PlaceholderTable", () => {
  test("numbers per type from 1 in order of first use", () => {
    const t = new PlaceholderTable();
    expect(t.placeholderFor("PERSON", "Mette Sørensen")).toBe("[PERSON_1]");
    expect(t.placeholderFor("EMAIL", "mette@example.dk")).toBe("[EMAIL_1]");
    expect(t.placeholderFor("PERSON", "Lars Nielsen")).toBe("[PERSON_2]");
  });

  test("same normalized value → same placeholder", () => {
    const t = new PlaceholderTable();
    t.placeholderFor("PERSON", "Mette Sørensen");
    expect(t.placeholderFor("PERSON", "mette  sørensen")).toBe("[PERSON_1]");
  });

  test("word-subset of an existing same-type value reuses it", () => {
    const t = new PlaceholderTable();
    t.placeholderFor("PERSON", "Mette Sørensen");
    expect(t.placeholderFor("PERSON", "Mette")).toBe("[PERSON_1]");
    expect(t.placeholderFor("PERSON", "Sørensen")).toBe("[PERSON_1]");
  });

  test("subset matching ignores single-character words and is type-isolated", () => {
    const t = new PlaceholderTable();
    t.placeholderFor("PERSON", "M Sørensen");
    expect(t.placeholderFor("PERSON", "M")).toBe("[PERSON_2]");
    expect(t.placeholderFor("ORG", "Sørensen")).toBe("[ORG_1]");
  });

  test("a later longer value does not retroactively merge", () => {
    const t = new PlaceholderTable();
    t.placeholderFor("PERSON", "Mette");
    expect(t.placeholderFor("PERSON", "Mette Sørensen")).toBe("[PERSON_2]");
  });

  test("PLACEHOLDER_RE matches all types and only well-formed tokens", () => {
    const text = "[PERSON_1] [ORG_12] [EMAIL_3] [FOO_1] [PERSON_]";
    expect(text.match(PLACEHOLDER_RE)).toEqual(["[PERSON_1]", "[ORG_12]", "[EMAIL_3]"]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/sanitize/placeholders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/sanitize/types.ts`:
```ts
export type Lang = "da" | "en" | "de";

export const ENTITY_TYPES = ["PERSON", "ORG", "EMAIL", "PHONE", "CPR", "IBAN", "CARD", "ADDRESS", "USERNAME", "OTHER"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export type SpanSource = "presidio" | "gliner" | "ollama";

export interface Span {
  start: number;
  end: number; // exclusive
  type: EntityType;
  score: number;
  source: SpanSource;
}

export interface Chunk {
  id: string;
  text: string;
  lang?: Lang;
}

export interface Pass1Client {
  analyze(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]>;
}

export interface SpanDetector {
  readonly name: string;
  detect(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]>;
}

export type Counts = Record<EntityType, number>;
export function emptyCounts(): Counts {
  return Object.fromEntries(ENTITY_TYPES.map((t) => [t, 0])) as Counts;
}

export type SanitizerErrorCode = "SANITIZER_UNAVAILABLE" | "SANITIZER_INVALID_OUTPUT" | "SANITIZER_INTERNAL";

export class SanitizerError extends Error {
  readonly code: SanitizerErrorCode;
  constructor(code: SanitizerErrorCode, message: string) {
    super(message);
    this.name = "SanitizerError";
    this.code = code;
  }
}
```

`src/sanitize/placeholders.ts`:
```ts
import { ENTITY_TYPES, type EntityType } from "./types.ts";

export const PLACEHOLDER_RE = new RegExp(`\\[(${ENTITY_TYPES.join("|")})_\\d+\\]`, "g");

export function normalizeValue(value: string): string {
  return value.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

interface Entry {
  type: EntityType;
  normalized: string;
  words: Set<string>;
  placeholder: string;
}

function significantWords(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((w) => w.length >= 2));
}

export class PlaceholderTable {
  private readonly entries: Entry[] = [];
  private readonly counters = new Map<EntityType, number>();

  placeholderFor(type: EntityType, value: string): string {
    const normalized = normalizeValue(value);
    const exact = this.entries.find((e) => e.type === type && e.normalized === normalized);
    if (exact) return exact.placeholder;

    const words = significantWords(normalized);
    if (words.size > 0) {
      const superset = this.entries.find(
        (e) => e.type === type && [...words].every((w) => e.words.has(w)),
      );
      if (superset) return superset.placeholder;
    }

    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const placeholder = `[${type}_${n}]`;
    this.entries.push({ type, normalized, words, placeholder });
    return placeholder;
  }

  size(): number {
    return this.entries.length;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/sanitize/placeholders.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/types.ts src/sanitize/placeholders.ts tests/sanitize/placeholders.test.ts
git commit -m "feat(sanitize): entity types and per-session PlaceholderTable with word-subset unification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Span replacement engine

**Files:**
- Create: `src/sanitize/replace.ts`
- Test: `tests/sanitize/replace.test.ts`

**Interfaces:**
- Consumes: `Span`, `EntityType` (Task 2), `PlaceholderTable`, `PLACEHOLDER_RE` (Task 2).
- Produces:
  ```ts
  export function resolveOverlaps(spans: Span[]): Span[];   // non-overlapping, sorted by start
  export function applySpans(text: string, spans: Span[], table: PlaceholderTable): { text: string; applied: Span[] };
  ```
  `applySpans` drops spans that intersect an existing placeholder token or have invalid offsets, resolves overlaps, replaces right-to-left.

- [ ] **Step 1: Write the failing tests**

`tests/sanitize/replace.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { applySpans, resolveOverlaps } from "@/sanitize/replace.ts";
import { PlaceholderTable } from "@/sanitize/placeholders.ts";
import type { Span } from "@/sanitize/types.ts";

const s = (start: number, end: number, type: Span["type"] = "PERSON", score = 0.9, source: Span["source"] = "presidio"): Span =>
  ({ start, end, type, score, source });

describe("resolveOverlaps", () => {
  test("keeps the longest of overlapping spans", () => {
    expect(resolveOverlaps([s(0, 5), s(0, 14)])).toEqual([s(0, 14)]);
  });
  test("equal length → higher score wins", () => {
    expect(resolveOverlaps([s(0, 5, "PERSON", 0.5), s(0, 5, "ORG", 0.8)])).toEqual([s(0, 5, "ORG", 0.8)]);
  });
  test("equal length and score → presidio beats gliner", () => {
    expect(resolveOverlaps([s(0, 5, "ORG", 0.8, "gliner"), s(0, 5, "PERSON", 0.8, "presidio")])).toEqual([s(0, 5, "PERSON", 0.8, "presidio")]);
  });
  test("non-overlapping spans are all kept, sorted", () => {
    expect(resolveOverlaps([s(10, 14), s(0, 5)])).toEqual([s(0, 5), s(10, 14)]);
  });
});

describe("applySpans", () => {
  test("replaces spans with placeholders, same value → same placeholder", () => {
    const text = "Mette Sørensen wrote. Thanks, Mette Sørensen";
    const table = new PlaceholderTable();
    const out = applySpans(text, [s(0, 14), s(30, 44)], table);
    expect(out.text).toBe("[PERSON_1] wrote. Thanks, [PERSON_1]");
    expect(out.applied).toHaveLength(2);
  });

  test("drops spans overlapping an existing placeholder token", () => {
    const text = "[PERSON_1] met Lars";
    const table = new PlaceholderTable();
    const out = applySpans(text, [s(1, 7), s(15, 19)], table);
    expect(out.text).toBe("[PERSON_1] met [PERSON_1]"); // "Lars" is first new value → PERSON_1 in this fresh table
    expect(out.applied).toHaveLength(1);
  });

  test("drops spans with invalid offsets", () => {
    const table = new PlaceholderTable();
    const out = applySpans("abc", [s(-1, 2), s(2, 10), s(2, 2)], table);
    expect(out.text).toBe("abc");
    expect(out.applied).toHaveLength(0);
  });

  test("handles multi-byte characters by JS string index", () => {
    const text = "Søren 😀 Ærø";
    const table = new PlaceholderTable();
    const out = applySpans(text, [s(0, 5), s(9, 12)], table);
    expect(out.text).toBe("[PERSON_1] 😀 [PERSON_2]");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/sanitize/replace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/sanitize/replace.ts`**

```ts
import { PLACEHOLDER_RE, type PlaceholderTable } from "./placeholders.ts";
import type { Span, SpanSource } from "./types.ts";

const SOURCE_RANK: Record<SpanSource, number> = { presidio: 0, gliner: 1, ollama: 2 };

export function resolveOverlaps(spans: Span[]): Span[] {
  const ranked = [...spans].sort((a, b) =>
    (b.end - b.start) - (a.end - a.start) ||
    b.score - a.score ||
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    a.start - b.start,
  );
  const kept: Span[] = [];
  for (const sp of ranked) {
    if (!kept.some((k) => sp.start < k.end && k.start < sp.end)) kept.push(sp);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function placeholderRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

export function applySpans(text: string, spans: Span[], table: PlaceholderTable): { text: string; applied: Span[] } {
  const protectedRanges = placeholderRanges(text);
  const valid = spans.filter(
    (sp) =>
      Number.isInteger(sp.start) && Number.isInteger(sp.end) &&
      sp.start >= 0 && sp.end <= text.length && sp.end > sp.start &&
      !protectedRanges.some(([a, b]) => sp.start < b && a < sp.end),
  );
  const applied = resolveOverlaps(valid);
  let out = text;
  // Assign placeholders left-to-right (stable numbering), replace right-to-left (stable offsets).
  const replacements = applied.map((sp) => table.placeholderFor(sp.type, text.slice(sp.start, sp.end)));
  for (let i = applied.length - 1; i >= 0; i--) {
    const sp = applied[i]!;
    out = out.slice(0, sp.start) + replacements[i]! + out.slice(sp.end);
  }
  return { text: out, applied };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/sanitize/replace.test.ts`
Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/replace.ts tests/sanitize/replace.test.ts
git commit -m "feat(sanitize): span overlap resolution and placeholder replacement engine

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Lossless chunking

**Files:**
- Create: `src/sanitize/chunking.ts`
- Test: `tests/sanitize/chunking.test.ts`

**Interfaces:**
- Produces: `export function splitText(text: string, maxChars: number): string[]` — pieces satisfy `pieces.join("") === text`; every piece ≤ `maxChars` unless a single unbreakable run is longer (then hard-cut). Split preference: blank line (`\n\n`) → newline → sentence end (`. `, `! `, `? `) → space → hard cut.

- [ ] **Step 1: Write the failing tests**

`tests/sanitize/chunking.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { splitText } from "@/sanitize/chunking.ts";

describe("splitText", () => {
  test("returns the whole text when under the cap", () => {
    expect(splitText("short", 100)).toEqual(["short"]);
  });

  test("is lossless and respects the cap", () => {
    const para = "Hej Mette. Tak for din mail! Vi kigger på det? Ja.\n\n";
    const text = para.repeat(20);
    const pieces = splitText(text, 120);
    expect(pieces.join("")).toBe(text);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(120);
  });

  test("prefers paragraph boundaries over sentence boundaries", () => {
    const text = "Sentence one. Sentence two.\n\nSentence three. Sentence four.";
    const pieces = splitText(text, 35);
    expect(pieces).toEqual(["Sentence one. Sentence two.\n\n", "Sentence three. Sentence four."]);
  });

  test("falls back to sentence, then space, then hard cut", () => {
    expect(splitText("One two. Three four.", 12)).toEqual(["One two. ", "Three four."]);
    expect(splitText("aaaa bbbb cccc", 9)).toEqual(["aaaa ", "bbbb cccc"]); // "bbbb cccc" is exactly 9 → fits
    expect(splitText("aaaa bbbb cccc", 8)).toEqual(["aaaa ", "bbbb ", "cccc"]);
    expect(splitText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("empty string → single empty piece", () => {
    expect(splitText("", 10)).toEqual([""]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/sanitize/chunking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/sanitize/chunking.ts`**

```ts
const BOUNDARIES: RegExp[] = [/\n\n/g, /\n/g, /[.!?] /g, / /g];

function lastBoundaryBefore(window: string, re: RegExp): number {
  let last = -1;
  for (const m of window.matchAll(re)) {
    const end = m.index + m[0].length;
    if (end < window.length) last = end; // boundary must leave something after it
  }
  return last;
}

export function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1); // +1 so a boundary exactly at maxChars is seen
    let cut = -1;
    for (const re of BOUNDARIES) {
      cut = lastBoundaryBefore(window, re);
      if (cut > 0 && cut <= maxChars) break;
      cut = -1;
    }
    if (cut <= 0) cut = maxChars; // hard cut
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/sanitize/chunking.test.ts`
Expected: 5 pass. If the "prefers paragraph boundaries" case fails, print `splitText(...)` and adjust the window logic — the expected output is the contract.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/chunking.ts tests/sanitize/chunking.test.ts
git commit -m "feat(sanitize): lossless boundary-aware text splitting

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Language detection

**Files:**
- Create: `src/sanitize/language.ts`
- Test: `tests/sanitize/language.test.ts`

**Interfaces:**
- Produces: `export function detectLang(text: string): Lang` — `franc` restricted to `dan|eng|deu`; texts shorter than 20 chars or `und` → `"en"`.

- [ ] **Step 1: Write the failing tests**

`tests/sanitize/language.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { detectLang } from "@/sanitize/language.ts";

describe("detectLang", () => {
  test("Danish", () => {
    expect(detectLang("Hej, jeg har et problem med Document Capture, den kan ikke læse fakturaen fra vores leverandør.")).toBe("da");
  });
  test("German", () => {
    expect(detectLang("Guten Tag, wir haben ein Problem mit der Rechnungserkennung und bitten um Unterstützung.")).toBe("de");
  });
  test("English", () => {
    expect(detectLang("Hello, the invoice import fails with an error after the latest update, please advise.")).toBe("en");
  });
  test("short or empty text falls back to en", () => {
    expect(detectLang("Hej Mette")).toBe("en");
    expect(detectLang("")).toBe("en");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/sanitize/language.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/sanitize/language.ts`**

```ts
import { franc } from "franc";
import type { Lang } from "./types.ts";

const ISO3_TO_LANG: Record<string, Lang> = { dan: "da", eng: "en", deu: "de" };
const MIN_LENGTH = 20;

export function detectLang(text: string): Lang {
  if (text.trim().length < MIN_LENGTH) return "en";
  const code = franc(text, { only: Object.keys(ISO3_TO_LANG), minLength: MIN_LENGTH });
  return ISO3_TO_LANG[code] ?? "en";
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/sanitize/language.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/language.ts tests/sanitize/language.test.ts
git commit -m "feat(sanitize): da/en/de language detection via franc

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Allowlist

**Files:**
- Create: `src/sanitize/allowlist.ts`, `config/allowlist.txt`
- Test: `tests/sanitize/allowlist.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class Allowlist {
    static fromText(content: string): Allowlist;          // one term per line, '#' comments, blank lines ignored
    static async fromFile(path: string): Promise<Allowlist>;
    isAllowed(spanText: string): boolean;                 // exact (normalized) or word-subset of a multi-word term
    filter(text: string, spans: Span[]): Span[];          // drops allowlisted spans
  }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/sanitize/allowlist.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Allowlist } from "@/sanitize/allowlist.ts";
import type { Span } from "@/sanitize/types.ts";

const list = Allowlist.fromText(`
# products
Continia
Continia Document Capture
Business Central
`);

describe("Allowlist", () => {
  test("exact match, case-insensitive", () => {
    expect(list.isAllowed("continia")).toBe(true);
    expect(list.isAllowed("BUSINESS  central")).toBe(true);
  });
  test("word-subset of a multi-word term", () => {
    expect(list.isAllowed("Document Capture")).toBe(true);
    expect(list.isAllowed("Capture")).toBe(true);
  });
  test("non-matching", () => {
    expect(list.isAllowed("Contoso")).toBe(false);
    expect(list.isAllowed("Document Capture Pro")).toBe(false);
  });
  test("filter drops allowlisted spans", () => {
    const text = "Continia and Contoso";
    const spans: Span[] = [
      { start: 0, end: 8, type: "ORG", score: 0.9, source: "presidio" },
      { start: 13, end: 20, type: "ORG", score: 0.9, source: "presidio" },
    ];
    expect(list.filter(text, spans)).toEqual([spans[1]]);
  });
  test("loads the repo allowlist file", async () => {
    const repo = await Allowlist.fromFile("config/allowlist.txt");
    expect(repo.isAllowed("Business Central")).toBe(true);
    expect(repo.isAllowed("Zendesk")).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/sanitize/allowlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`config/allowlist.txt`:
```
# Terms that must never be redacted. One per line. Case-insensitive.
# A span is also allowed when its words are a subset of a multi-word term here.
# Owned by the GDPR owner via CODEOWNERS.
Continia
Continia Software
Continia Document Capture
Document Capture
Continia Expense Management
Expense Management
Continia Payment Management
Payment Management
Business Central
Dynamics 365
Dynamics NAV
Microsoft
Azure
Zendesk
OneDrive
SharePoint
Outlook
```

`src/sanitize/allowlist.ts`:
```ts
import { normalizeValue } from "./placeholders.ts";
import type { Span } from "./types.ts";

export class Allowlist {
  private readonly exact = new Set<string>();
  private readonly wordSets: Array<Set<string>> = [];

  private constructor(terms: string[]) {
    for (const raw of terms) {
      const n = normalizeValue(raw);
      if (!n) continue;
      this.exact.add(n);
      const words = n.split(" ");
      if (words.length > 1) this.wordSets.push(new Set(words));
    }
  }

  static fromText(content: string): Allowlist {
    const terms = content
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l.length > 0);
    return new Allowlist(terms);
  }

  static async fromFile(path: string): Promise<Allowlist> {
    return Allowlist.fromText(await Bun.file(path).text());
  }

  isAllowed(spanText: string): boolean {
    const n = normalizeValue(spanText);
    if (this.exact.has(n)) return true;
    const words = n.split(" ").filter((w) => w.length > 0);
    return words.length > 0 && this.wordSets.some((set) => words.every((w) => set.has(w)));
  }

  filter(text: string, spans: Span[]): Span[] {
    return spans.filter((sp) => !this.isAllowed(text.slice(sp.start, sp.end)));
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/sanitize/allowlist.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/allowlist.ts config/allowlist.txt tests/sanitize/allowlist.test.ts
git commit -m "feat(sanitize): allowlist of product/vendor terms exempt from redaction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Danish CPR validation and ad-hoc recognizer definitions

**Files:**
- Create: `src/sanitize/cpr.ts`, `config/recognizers/cpr.json`, `config/recognizers/dk-phone.json`
- Test: `tests/sanitize/cpr.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function isValidCpr(candidate: string): boolean;   // "DDMMYY-SSSS" or "DDMMYYSSSS"
  export interface AdHocRecognizer {                        // Presidio /analyze ad_hoc_recognizers item (language filled in per request)
    name: string; supported_entity: string;
    patterns: Array<{ name: string; regex: string; score: number }>;
    context?: string[];
  }
  export async function loadRecognizers(dir: string): Promise<AdHocRecognizer[]>;  // reads every *.json in dir
  ```
- CPR century rule (7th digit `s`, year `yy`): `s∈0-3` → 1900–1999; `s=4|9` → `yy≤36` ? 2000s : 1900s; `s∈5-8` → `yy≤57` ? 2000s : 1800s.

- [ ] **Step 1: Write the failing tests**

`tests/sanitize/cpr.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { isValidCpr, loadRecognizers } from "@/sanitize/cpr.ts";

describe("isValidCpr", () => {
  test("accepts date-valid numbers with and without hyphen", () => {
    expect(isValidCpr("010190-1234")).toBe(true);
    expect(isValidCpr("0101901234")).toBe(true);
    expect(isValidCpr("311299-0001")).toBe(true);
  });
  test("century digit: 4 with yy<=36 → 2000s (leap year 2004 ok)", () => {
    expect(isValidCpr("290204-4567")).toBe(true);   // 29 Feb 2004
    expect(isValidCpr("290203-4567")).toBe(false);  // 29 Feb 2003 does not exist
  });
  test("century digit: 0-3 → 1900s (1900 is not a leap year)", () => {
    expect(isValidCpr("290200-1234")).toBe(false);
    expect(isValidCpr("290296-1234")).toBe(true);
  });
  test("rejects impossible dates and wrong shapes", () => {
    expect(isValidCpr("320190-1234")).toBe(false);
    expect(isValidCpr("011390-1234")).toBe(false);
    expect(isValidCpr("000190-1234")).toBe(false);
    expect(isValidCpr("12345678")).toBe(false);
    expect(isValidCpr("01019O-1234")).toBe(false);
  });
});

describe("loadRecognizers", () => {
  test("loads cpr and dk-phone definitions", async () => {
    const recs = await loadRecognizers("config/recognizers");
    const names = recs.map((r) => r.name).sort();
    expect(names).toEqual(["DK_CPR", "DK_PHONE"]);
    const cpr = recs.find((r) => r.name === "DK_CPR")!;
    expect(cpr.supported_entity).toBe("DK_CPR");
    expect(new RegExp(cpr.patterns[0]!.regex).test("010190-1234")).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/sanitize/cpr.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`config/recognizers/cpr.json`:
```json
{
  "name": "DK_CPR",
  "supported_entity": "DK_CPR",
  "patterns": [
    { "name": "cpr_hyphen", "regex": "\\b\\d{6}-\\d{4}\\b", "score": 0.85 },
    { "name": "cpr_plain", "regex": "\\b\\d{10}\\b", "score": 0.6 }
  ],
  "context": ["cpr", "cpr-nr", "cpr-nummer", "personnummer"]
}
```

`config/recognizers/dk-phone.json`:
```json
{
  "name": "DK_PHONE",
  "supported_entity": "DK_PHONE",
  "patterns": [
    { "name": "dk_intl", "regex": "(?<!\\d)\\+45[ ]?\\d{2}[ ]?\\d{2}[ ]?\\d{2}[ ]?\\d{2}(?!\\d)", "score": 0.9 },
    { "name": "dk_local_grouped", "regex": "(?<!\\d)\\d{2} \\d{2} \\d{2} \\d{2}(?!\\d)", "score": 0.75 }
  ],
  "context": ["tlf", "telefon", "mobil", "ring"]
}
```

`src/sanitize/cpr.ts`:
```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const CPR_RE = /^(\d{2})(\d{2})(\d{2})-?(\d)(\d{3})$/;

function centuryFor(seventh: number, yy: number): number {
  if (seventh <= 3) return 1900;
  if (seventh === 4 || seventh === 9) return yy <= 36 ? 2000 : 1900;
  return yy <= 57 ? 2000 : 1800; // 5–8
}

export function isValidCpr(candidate: string): boolean {
  const m = CPR_RE.exec(candidate);
  if (!m) return false;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]), seventh = Number(m[4]);
  if (mm < 1 || mm > 12 || dd < 1) return false;
  const year = centuryFor(seventh, yy) + yy;
  const daysInMonth = new Date(Date.UTC(year, mm, 0)).getUTCDate(); // day 0 of next month
  return dd <= daysInMonth;
}

export interface AdHocRecognizer {
  name: string;
  supported_entity: string;
  patterns: Array<{ name: string; regex: string; score: number }>;
  context?: string[];
}

export async function loadRecognizers(dir: string): Promise<AdHocRecognizer[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => (await Bun.file(join(dir, f)).json()) as AdHocRecognizer));
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/sanitize/cpr.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/cpr.ts config/recognizers tests/sanitize/cpr.test.ts
git commit -m "feat(sanitize): CPR date validation and ad-hoc recognizer definitions (CPR, DK phone)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Presidio client (pass 1)

**Files:**
- Create: `src/sanitize/presidio.ts`, `tests/fixtures/presidio/analyze-da.json`
- Test: `tests/sanitize/presidio.test.ts`

**Interfaces:**
- Consumes: `Pass1Client`, `Span`, `Chunk`, `SanitizerError` (Task 2); `isValidCpr`, `AdHocRecognizer` (Task 7).
- Produces:
  ```ts
  export interface PresidioClientOptions {
    baseUrl: string;
    recognizers: AdHocRecognizer[];
    nerThreshold?: number;      // default 0.4 — applies to PERSON/ORG
    patternThreshold?: number;  // default 0.7 — applies to everything else
    fetchImpl?: typeof fetch;   // injected for tests
  }
  export class PresidioClient implements Pass1Client { constructor(opts: PresidioClientOptions); analyze(chunk, {signal}): Promise<Span[]> }
  export const PRESIDIO_ENTITY_MAP: Record<string, EntityType>;  // PERSON→PERSON, ORGANIZATION→ORG, EMAIL_ADDRESS→EMAIL, PHONE_NUMBER→PHONE, DK_PHONE→PHONE, IBAN_CODE→IBAN, CREDIT_CARD→CARD, DK_CPR→CPR
  ```
- Request: `POST {baseUrl}/analyze` with body `{ text, language, ad_hoc_recognizers: recognizers.map(r => ({...r, supported_language: language})), return_decision_process: false }`. Response: `Array<{ entity_type: string; start: number; end: number; score: number }>`.
- Behaviour: unmapped entity types (LOCATION, DATE_TIME, URL, …) are dropped; `DK_CPR` spans failing `isValidCpr` are dropped; non-2xx, network error, invalid JSON, or abort → `SanitizerError("SANITIZER_UNAVAILABLE", …)`.

- [ ] **Step 1: Write the failing tests**

`tests/fixtures/presidio/analyze-da.json`:
```json
[
  { "entity_type": "PERSON", "start": 4, "end": 18, "score": 0.85 },
  { "entity_type": "EMAIL_ADDRESS", "start": 25, "end": 41, "score": 1.0 },
  { "entity_type": "DK_CPR", "start": 47, "end": 58, "score": 0.85 },
  { "entity_type": "DK_CPR", "start": 62, "end": 73, "score": 0.85 },
  { "entity_type": "LOCATION", "start": 76, "end": 82, "score": 0.9 },
  { "entity_type": "ORGANIZATION", "start": 87, "end": 94, "score": 0.3 }
]
```

`tests/sanitize/presidio.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { PresidioClient } from "@/sanitize/presidio.ts";
import { SanitizerError } from "@/sanitize/types.ts";
import type { AdHocRecognizer } from "@/sanitize/cpr.ts";
import recorded from "../fixtures/presidio/analyze-da.json";

//           0         1         2         3         4         5         6         7         8         9
//           0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789
const TEXT = "Hej Mette Sørensen, mail mette@example.dk, cpr 010190-1234 og 320190-1234 i Aarhus hos Contoso";
const recognizers: AdHocRecognizer[] = [{ name: "DK_CPR", supported_entity: "DK_CPR", patterns: [{ name: "p", regex: "\\b\\d{6}-\\d{4}\\b", score: 0.85 }] }];

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
}

describe("PresidioClient", () => {
  test("posts text, language and ad-hoc recognizers", async () => {
    let seen: { url: string; body: any } | undefined;
    const client = new PresidioClient({
      baseUrl: "http://presidio:3000", recognizers,
      fetchImpl: fakeFetch((url, init) => { seen = { url, body: JSON.parse(String(init.body)) }; return Response.json([]); }),
    });
    await client.analyze({ id: "c1", text: TEXT, lang: "da" }, { signal: new AbortController().signal });
    expect(seen!.url).toBe("http://presidio:3000/analyze");
    expect(seen!.body.text).toBe(TEXT);
    expect(seen!.body.language).toBe("da");
    expect(seen!.body.ad_hoc_recognizers[0].supported_language).toBe("da");
    expect(seen!.body.ad_hoc_recognizers[0].name).toBe("DK_CPR");
  });

  test("maps entities, validates CPR, drops unmapped and below-threshold", async () => {
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => Response.json(recorded)) });
    const spans = await client.analyze({ id: "c1", text: TEXT, lang: "da" }, { signal: new AbortController().signal });
    expect(spans.map((s) => [s.type, TEXT.slice(s.start, s.end)])).toEqual([
      ["PERSON", "Mette Sørensen"],
      ["EMAIL", "mette@example.dk"],
      ["CPR", "010190-1234"],
      // 320190-1234 dropped: invalid date; Aarhus dropped: LOCATION unmapped; Contoso dropped: ORG below 0.4
    ]);
    expect(spans.every((s) => s.source === "presidio")).toBe(true);
  });

  test("non-2xx → SANITIZER_UNAVAILABLE", async () => {
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => new Response("boom", { status: 500 })) });
    const err = await client.analyze({ id: "c1", text: TEXT }, { signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect(err.code).toBe("SANITIZER_UNAVAILABLE");
  });

  test("network error → SANITIZER_UNAVAILABLE", async () => {
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => { throw new TypeError("fetch failed"); }) });
    const err = await client.analyze({ id: "c1", text: TEXT }, { signal: new AbortController().signal }).catch((e) => e);
    expect(err.code).toBe("SANITIZER_UNAVAILABLE");
  });

  test("malformed response → SANITIZER_UNAVAILABLE", async () => {
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch(() => Response.json({ not: "an array" })) });
    const err = await client.analyze({ id: "c1", text: TEXT }, { signal: new AbortController().signal }).catch((e) => e);
    expect(err.code).toBe("SANITIZER_UNAVAILABLE");
  });

  test("defaults language to en when chunk has none", async () => {
    let lang: string | undefined;
    const client = new PresidioClient({ baseUrl: "http://p", recognizers, fetchImpl: fakeFetch((_u, init) => { lang = JSON.parse(String(init.body)).language; return Response.json([]); }) });
    await client.analyze({ id: "c1", text: TEXT }, { signal: new AbortController().signal });
    expect(lang).toBe("en");
  });
});
```

Note on the fixture offsets: verify with `TEXT.slice(start, end)` in a Bun REPL (`bun -e`) before trusting them; adjust the fixture, not the test expectations.

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/sanitize/presidio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/sanitize/presidio.ts`**

```ts
import { isValidCpr, type AdHocRecognizer } from "./cpr.ts";
import { SanitizerError, type Chunk, type EntityType, type Pass1Client, type Span } from "./types.ts";

export const PRESIDIO_ENTITY_MAP: Record<string, EntityType> = {
  PERSON: "PERSON",
  ORGANIZATION: "ORG",
  EMAIL_ADDRESS: "EMAIL",
  PHONE_NUMBER: "PHONE",
  DK_PHONE: "PHONE",
  IBAN_CODE: "IBAN",
  CREDIT_CARD: "CARD",
  DK_CPR: "CPR",
};

const NER_TYPES = new Set<EntityType>(["PERSON", "ORG"]);

export interface PresidioClientOptions {
  baseUrl: string;
  recognizers: AdHocRecognizer[];
  nerThreshold?: number;
  patternThreshold?: number;
  fetchImpl?: typeof fetch;
}

interface PresidioResult { entity_type: string; start: number; end: number; score: number }

export class PresidioClient implements Pass1Client {
  private readonly opts: Required<PresidioClientOptions>;

  constructor(opts: PresidioClientOptions) {
    this.opts = {
      nerThreshold: 0.4,
      patternThreshold: 0.7,
      fetchImpl: fetch,
      ...opts,
      baseUrl: opts.baseUrl.replace(/\/$/, ""),
    };
  }

  async analyze(chunk: Chunk, { signal }: { signal: AbortSignal }): Promise<Span[]> {
    const language = chunk.lang ?? "en";
    const body = {
      text: chunk.text,
      language,
      ad_hoc_recognizers: this.opts.recognizers.map((r) => ({ ...r, supported_language: language })),
      return_decision_process: false,
    };

    let results: unknown;
    try {
      const res = await this.opts.fetchImpl(`${this.opts.baseUrl}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new SanitizerError("SANITIZER_UNAVAILABLE", `presidio analyze returned HTTP ${res.status}`);
      results = await res.json();
    } catch (e) {
      if (e instanceof SanitizerError) throw e;
      throw new SanitizerError("SANITIZER_UNAVAILABLE", `presidio unreachable: ${(e as Error).name}`);
    }
    if (!Array.isArray(results)) throw new SanitizerError("SANITIZER_UNAVAILABLE", "presidio returned a non-array body");

    const spans: Span[] = [];
    for (const r of results as PresidioResult[]) {
      const type = PRESIDIO_ENTITY_MAP[r.entity_type];
      if (!type) continue;
      const threshold = NER_TYPES.has(type) ? this.opts.nerThreshold : this.opts.patternThreshold;
      if (typeof r.score !== "number" || r.score < threshold) continue;
      if (type === "CPR" && !isValidCpr(chunk.text.slice(r.start, r.end))) continue;
      spans.push({ start: r.start, end: r.end, type, score: r.score, source: "presidio" });
    }
    return spans;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/sanitize/presidio.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/presidio.ts tests/sanitize/presidio.test.ts tests/fixtures/presidio/analyze-da.json
git commit -m "feat(sanitize): Presidio analyzer client with entity mapping, thresholds and CPR validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: SanitizeSession (orchestration)

**Files:**
- Create: `src/sanitize/session.ts`, `src/sanitize/index.ts`, `tests/helpers/fakes.ts`
- Test: `tests/sanitize/session.test.ts`

**Interfaces:**
- Consumes: everything in `src/sanitize/` so far.
- Produces:
  ```ts
  export interface SessionDeps {
    pass1: Pass1Client;
    pass2: SpanDetector | null;         // null when ZSAN_PASS2=off (Plan 1 always null in production wiring)
    allowlist: Allowlist;
    detectLang?: (text: string) => Lang; // default detectLang
    timeouts: { pass1Ms: number; pass2Ms: number };
    chunkMaxChars: number;
    concurrency: number;
  }
  export interface SanitizeOutput { texts: Map<string, string>; counts: Counts; perPass: { pass1: number; pass2: number } }
  export class SanitizeSession {
    constructor(deps: SessionDeps);
    sanitize(chunks: Chunk[]): Promise<SanitizeOutput>;  // one PlaceholderTable for the whole call
  }
  ```
  `tests/helpers/fakes.ts` produces `fakePass1(spansFor: (text) => Span[])`, `fakeDetector(name, spansFor)`, `emptyAllowlist()`.
- Semantics: per chunk → `splitText` → for each piece: lang, pass1 spans (allowlist-filtered) → `applySpans` → if pass2: detect on the *replaced* piece (allowlist-filtered) → `applySpans` → join pieces. Pieces of all chunks run with bounded concurrency; placeholders are assigned in completion order within a chunk *only after* all pieces of that chunk are done, so numbering is deterministic: process pieces **sequentially within a chunk**, chunks concurrently. Timeouts via `AbortSignal.timeout(ms)` → `SanitizerError("SANITIZER_UNAVAILABLE")`. Any non-`SanitizerError` thrown → wrapped as `SANITIZER_INTERNAL`.

- [ ] **Step 1: Write the fakes and failing tests**

`tests/helpers/fakes.ts`:
```ts
import { Allowlist } from "@/sanitize/allowlist.ts";
import type { Chunk, Pass1Client, Span, SpanDetector } from "@/sanitize/types.ts";

/** Builds spans by literal search — handy for tests. */
export function spansByLiteral(text: string, literals: Array<[string, Span["type"]]>, source: Span["source"]): Span[] {
  const spans: Span[] = [];
  for (const [lit, type] of literals) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(lit, from);
      if (i < 0) break;
      spans.push({ start: i, end: i + lit.length, type, score: 0.9, source });
      from = i + lit.length;
    }
  }
  return spans;
}

export function fakePass1(spansFor: (chunk: Chunk) => Span[] | Promise<Span[]>): Pass1Client & { calls: Chunk[] } {
  const calls: Chunk[] = [];
  return { calls, async analyze(chunk) { calls.push(chunk); return spansFor(chunk); } };
}

export function fakeDetector(name: string, spansFor: (chunk: Chunk) => Span[] | Promise<Span[]>): SpanDetector & { calls: Chunk[] } {
  const calls: Chunk[] = [];
  return { name, calls, async detect(chunk) { calls.push(chunk); return spansFor(chunk); } };
}

export const emptyAllowlist = (): Allowlist => Allowlist.fromText("");
```

`tests/sanitize/session.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { SanitizeSession, type SessionDeps } from "@/sanitize/session.ts";
import { Allowlist } from "@/sanitize/allowlist.ts";
import { SanitizerError } from "@/sanitize/types.ts";
import { emptyAllowlist, fakeDetector, fakePass1, spansByLiteral } from "../helpers/fakes.ts";

const base = (over: Partial<SessionDeps> = {}): SessionDeps => ({
  pass1: fakePass1(() => []),
  pass2: null,
  allowlist: emptyAllowlist(),
  detectLang: () => "da",
  timeouts: { pass1Ms: 1000, pass2Ms: 1000 },
  chunkMaxChars: 6000,
  concurrency: 2,
  ...over,
});

describe("SanitizeSession", () => {
  test("pass 1 only: replaces and counts, placeholders stable across chunks", async () => {
    const deps = base({ pass1: fakePass1((c) => spansByLiteral(c.text, [["Mette Sørensen", "PERSON"], ["mette@example.dk", "EMAIL"]], "presidio")) });
    const out = await new SanitizeSession(deps).sanitize([
      { id: "subject", text: "Fra Mette Sørensen" },
      { id: "c1", text: "Mette Sørensen <mette@example.dk> skrev" },
    ]);
    expect(out.texts.get("subject")).toBe("Fra [PERSON_1]");
    expect(out.texts.get("c1")).toBe("[PERSON_1] <[EMAIL_1]> skrev");
    expect(out.counts.PERSON).toBe(2);
    expect(out.counts.EMAIL).toBe(1);
    expect(out.perPass).toEqual({ pass1: 3, pass2: 0 });
  });

  test("pass 2 runs on pass-1 output and shares the table", async () => {
    const deps = base({
      pass1: fakePass1((c) => spansByLiteral(c.text, [["Mette Sørensen", "PERSON"]], "presidio")),
      pass2: fakeDetector("fake", (c) => spansByLiteral(c.text, [["Mette", "PERSON"], ["Vestergade 12", "ADDRESS"]], "gliner")),
    });
    const out = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "Mette Sørensen bor på Vestergade 12. Hilsen Mette" }]);
    expect(out.texts.get("c1")).toBe("[PERSON_1] bor på [ADDRESS_1]. Hilsen [PERSON_1]");
    expect((deps.pass2 as any).calls[0].text).toBe("[PERSON_1] bor på Vestergade 12. Hilsen Mette");
    expect(out.perPass).toEqual({ pass1: 1, pass2: 2 });
  });

  test("allowlist filters spans from both passes", async () => {
    const deps = base({
      allowlist: Allowlist.fromText("Continia"),
      pass1: fakePass1((c) => spansByLiteral(c.text, [["Continia", "ORG"]], "presidio")),
      pass2: fakeDetector("fake", (c) => spansByLiteral(c.text, [["Continia", "ORG"]], "gliner")),
    });
    const out = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "Continia Document Capture" }]);
    expect(out.texts.get("c1")).toBe("Continia Document Capture");
    expect(out.counts.ORG).toBe(0);
  });

  test("passes detected language to pass 1 and splits long text losslessly", async () => {
    const pass1 = fakePass1(() => []);
    const deps = base({ pass1, chunkMaxChars: 50 });
    const text = "Første afsnit her.\n\n".repeat(10);
    const out = await new SanitizeSession(deps).sanitize([{ id: "c1", text }]);
    expect(out.texts.get("c1")).toBe(text);
    expect(pass1.calls.length).toBeGreaterThan(1);
    expect(pass1.calls.every((c) => c.lang === "da")).toBe(true);
  });

  test("pass 1 timeout → SANITIZER_UNAVAILABLE", async () => {
    const pass1 = fakePass1((_c) => new Promise<never>((_res, rej) => setTimeout(() => rej(new SanitizerError("SANITIZER_UNAVAILABLE", "aborted")), 50)));
    const deps = base({ pass1, timeouts: { pass1Ms: 10, pass2Ms: 10 } });
    const err = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "x".repeat(30) }]).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect(err.code).toBe("SANITIZER_UNAVAILABLE");
  });

  test("unexpected exception → SANITIZER_INTERNAL", async () => {
    const deps = base({ pass1: fakePass1(() => { throw new RangeError("bug"); }) });
    const err = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "hello there friend" }]).catch((e) => e);
    expect(err.code).toBe("SANITIZER_INTERNAL");
  });

  test("empty chunk list → empty output", async () => {
    const out = await new SanitizeSession(base()).sanitize([]);
    expect(out.texts.size).toBe(0);
    expect(out.perPass).toEqual({ pass1: 0, pass2: 0 });
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/sanitize/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/sanitize/session.ts`:
```ts
import type { Allowlist } from "./allowlist.ts";
import { splitText } from "./chunking.ts";
import { detectLang as defaultDetectLang } from "./language.ts";
import { PlaceholderTable } from "./placeholders.ts";
import { applySpans } from "./replace.ts";
import { SanitizerError, emptyCounts, type Chunk, type Counts, type Lang, type Pass1Client, type Span, type SpanDetector } from "./types.ts";

export interface SessionDeps {
  pass1: Pass1Client;
  pass2: SpanDetector | null;
  allowlist: Allowlist;
  detectLang?: (text: string) => Lang;
  timeouts: { pass1Ms: number; pass2Ms: number };
  chunkMaxChars: number;
  concurrency: number;
}

export interface SanitizeOutput {
  texts: Map<string, string>;
  counts: Counts;
  perPass: { pass1: number; pass2: number };
}

export class SanitizeSession {
  private readonly table = new PlaceholderTable();
  private readonly counts = emptyCounts();
  private readonly perPass = { pass1: 0, pass2: 0 };
  private readonly detectLang: (text: string) => Lang;

  constructor(private readonly deps: SessionDeps) {
    this.detectLang = deps.detectLang ?? defaultDetectLang;
  }

  async sanitize(chunks: Chunk[]): Promise<SanitizeOutput> {
    const texts = new Map<string, string>();
    const queue = [...chunks];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) texts.set(c.id, await this.sanitizeChunk(c));
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, this.deps.concurrency) }, worker));
    } catch (e) {
      if (e instanceof SanitizerError) throw e;
      throw new SanitizerError("SANITIZER_INTERNAL", `unexpected ${(e as Error).name}`);
    }
    return { texts, counts: this.counts, perPass: this.perPass };
  }

  private async sanitizeChunk(chunk: Chunk): Promise<string> {
    const lang = chunk.lang ?? this.detectLang(chunk.text);
    const pieces = splitText(chunk.text, this.deps.chunkMaxChars);
    const out: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece: Chunk = { id: `${chunk.id}#${i}`, text: pieces[i]!, lang };
      out.push(await this.sanitizePiece(piece));
    }
    return out.join("");
  }

  private async sanitizePiece(piece: Chunk): Promise<string> {
    const spans1 = await this.withTimeout(this.deps.timeouts.pass1Ms, (signal) => this.deps.pass1.analyze(piece, { signal }));
    const step1 = this.apply(piece.text, spans1);
    this.perPass.pass1 += step1.applied.length;
    if (!this.deps.pass2) return step1.text;

    const piece2: Chunk = { ...piece, text: step1.text };
    const spans2 = await this.withTimeout(this.deps.timeouts.pass2Ms, (signal) => this.deps.pass2!.detect(piece2, { signal }));
    const step2 = this.apply(step1.text, spans2);
    this.perPass.pass2 += step2.applied.length;
    return step2.text;
  }

  private apply(text: string, spans: Span[]) {
    const result = applySpans(text, this.deps.allowlist.filter(text, spans), this.table);
    for (const sp of result.applied) this.counts[sp.type]++;
    return result;
  }

  private async withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await Promise.race([
        fn(controller.signal),
        new Promise<never>((_r, rej) => controller.signal.addEventListener("abort", () => rej(new SanitizerError("SANITIZER_UNAVAILABLE", `sanitizer call exceeded ${ms}ms`)))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
```

`src/sanitize/index.ts`:
```ts
export * from "./types.ts";
export * from "./placeholders.ts";
export * from "./replace.ts";
export * from "./chunking.ts";
export * from "./language.ts";
export * from "./allowlist.ts";
export * from "./cpr.ts";
export * from "./presidio.ts";
export * from "./session.ts";
```

- [ ] **Step 4: Run — expect pass; run whole suite**

Run: `bun test tests/sanitize/session.test.ts && bun test && bun run typecheck`
Expected: 7 pass in session; all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/session.ts src/sanitize/index.ts tests/helpers/fakes.ts tests/sanitize/session.test.ts
git commit -m "feat(sanitize): SanitizeSession orchestrating pass 1/2 with shared placeholders, timeouts, fail-closed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Logger with redaction guard

**Files:**
- Create: `src/logging.ts`
- Test: `tests/logging.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LogLevel = "debug" | "info" | "warn" | "error";
  export interface Logger { debug(msg: string): void; info(msg: string): void; warn(msg: string): void; error(msg: string): void; guardHits(): number }
  export function redactionGuard(line: string): { line: string; hit: boolean };  // replaces email / CPR-shaped / IBAN-shaped substrings with <redacted>
  export function createLogger(opts: { level: LogLevel; sink?: (line: string) => void }): Logger;   // default sink: process.stderr (stdout is the MCP transport!)
  export function formatCounts(counts: Counts): string;  // "PERSON 3, EMAIL 2" — omits zeros; "none" if all zero
  ```

- [ ] **Step 1: Write the failing tests**

`tests/logging.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { createLogger, formatCounts, redactionGuard } from "@/logging.ts";
import { emptyCounts } from "@/sanitize/types.ts";

describe("redactionGuard", () => {
  test("redacts email, CPR and IBAN shapes", () => {
    const { line, hit } = redactionGuard("user mette@example.dk cpr 010190-1234 iban DK5000400440116243 done");
    expect(line).toBe("user <redacted> cpr <redacted> iban <redacted> done");
    expect(hit).toBe(true);
  });
  test("leaves clean lines alone", () => {
    expect(redactionGuard("ticket 12345: PERSON 3, EMAIL 2")).toEqual({ line: "ticket 12345: PERSON 3, EMAIL 2", hit: false });
  });
});

describe("createLogger", () => {
  test("filters by level, prefixes level, applies guard and counts hits", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", sink: (l) => lines.push(l) });
    log.debug("hidden");
    log.info("ticket 1: ok");
    log.warn("leak mette@example.dk");
    expect(lines).toEqual(["[info] ticket 1: ok", "[warn] leak <redacted>"]);
    expect(log.guardHits()).toBe(1);
  });
});

describe("formatCounts", () => {
  test("omits zeros and orders by entity type", () => {
    const c = emptyCounts(); c.EMAIL = 2; c.PERSON = 3;
    expect(formatCounts(c)).toBe("PERSON 3, EMAIL 2");
    expect(formatCounts(emptyCounts())).toBe("none");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/logging.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/logging.ts`**

```ts
import { ENTITY_TYPES, type Counts } from "./sanitize/types.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const GUARDS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,   // email
  /\b\d{6}-\d{4}\b/g,                                   // CPR with hyphen
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,                  // IBAN-shaped
];

export function redactionGuard(line: string): { line: string; hit: boolean } {
  let hit = false;
  let out = line;
  for (const re of GUARDS) {
    if (re.test(out)) { hit = true; out = out.replace(re, "<redacted>"); }
    re.lastIndex = 0;
  }
  return { line: out, hit };
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  guardHits(): number;
}

export function createLogger(opts: { level: LogLevel; sink?: (line: string) => void }): Logger {
  const sink = opts.sink ?? ((l: string) => process.stderr.write(l + "\n"));
  let hits = 0;
  const emit = (level: LogLevel, msg: string) => {
    if (ORDER[level] < ORDER[opts.level]) return;
    const { line, hit } = redactionGuard(msg);
    if (hit) hits++;
    sink(`[${level}] ${line}`);
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    guardHits: () => hits,
  };
}

export function formatCounts(counts: Counts): string {
  const parts = ENTITY_TYPES.filter((t) => counts[t] > 0).map((t) => `${t} ${counts[t]}`);
  return parts.length ? parts.join(", ") : "none";
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/logging.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/logging.ts tests/logging.test.ts
git commit -m "feat: counts-only logger with redaction guard (stderr sink)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Tool policy

**Files:**
- Create: `src/policy/toolPolicy.ts`
- Test: `tests/policy/toolPolicy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const READ_ONLY_TOOLS: ReadonlySet<string>;   // the 8 allowed tools
  export function isAllowedTool(name: string): boolean;
  export function filterToolList<T extends { name: string }>(tools: T[]): T[];   // keeps only allowed, preserves upstream order
  export class ToolNotAllowedError extends Error { readonly tool: string }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/policy/toolPolicy.test.ts`:
```ts
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
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/policy/toolPolicy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/policy/toolPolicy.ts`**

```ts
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
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/policy/toolPolicy.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/policy/toolPolicy.ts tests/policy/toolPolicy.test.ts
git commit -m "feat(policy): read-only tool allowlist

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Field policy (Zendesk payload walk)

**Files:**
- Create: `src/policy/fieldPolicy.ts`, `tests/fixtures/tickets/basic-da.json`
- Test: `tests/policy/fieldPolicy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FieldRule = "drop" | "idOnly" | "keep" | "sanitize";
  export interface CollectedField { path: string; text: string }        // path like "ticket.comments.3.body"
  export function ruleFor(pathSegments: string[], value: unknown): FieldRule;
  export function applyFieldPolicy(payload: unknown): { skeleton: unknown; fields: CollectedField[] };
  export function fillFields(skeleton: unknown, texts: Map<string, string>): unknown;   // texts keyed by CollectedField.path
  ```
- Rule matching: rules are path **suffixes** where numeric array indices in the actual path are skipped, e.g. rule `via.source.from` matches `ticket.comments.3.via.source.from`; rule `content_url` matches any key named `content_url`. First matching rule in table order wins. Defaults: string → `sanitize`; number/boolean/null → `keep`; object/array → recurse.
- `idOnly` reduces an object to `{ id }` (or `null` if it has no `id`); `drop` removes the key; `sanitize` replaces the string with a marker object `{ "__zsan": "<path>" }` in the skeleton and records the field; `fillFields` swaps markers for the sanitized text and throws if any marker is left unfilled (fail closed).

- [ ] **Step 1: Write the fixture and failing tests**

`tests/fixtures/tickets/basic-da.json` (synthetic; shape follows the Zendesk `GET /tickets/{id}.json?include=comments` response as serialized by upstream):
```json
{
  "ticket": {
    "id": 4711,
    "url": "https://acme.zendesk.com/api/v2/tickets/4711.json",
    "subject": "Faktura fra Mette Sørensen bliver ikke læst",
    "raw_subject": "Faktura fra Mette Sørensen bliver ikke læst",
    "description": "Hej, jeg hedder Mette Sørensen fra Contoso ApS. Mit cpr er 010190-1234.",
    "status": "open",
    "priority": "normal",
    "requester_id": 900001,
    "submitter_id": 900001,
    "assignee_id": 100002,
    "organization_id": 500003,
    "tags": ["document_capture", "mette_soerensen"],
    "custom_fields": [{ "id": 360001, "value": "Contoso ApS" }, { "id": 360002, "value": null }, { "id": 360003, "value": 42 }],
    "via": { "channel": "email", "source": { "from": { "address": "mette@contoso.example", "name": "Mette Sørensen" }, "to": { "address": "support@acme.example" }, "rel": null } },
    "created_at": "2026-01-05T09:12:00Z",
    "metadata": { "system": { "client": "Mozilla/5.0", "ip_address": "10.1.2.3", "location": "Aarhus, Denmark", "latitude": 56.1, "longitude": 10.2 }, "custom": {} },
    "requester": { "id": 900001, "name": "Mette Sørensen", "email": "mette@contoso.example" }
  },
  "comments": [
    {
      "id": 1, "author_id": 900001, "public": true,
      "body": "Vedhæftet faktura. Ring evt. på 12 34 56 78.",
      "html_body": "<p>Vedhæftet faktura. Ring evt. på 12 34 56 78.</p>",
      "plain_body": "Vedhæftet faktura. Ring evt. på 12 34 56 78.",
      "attachments": [{ "id": 77, "file_name": "faktura_MetteSørensen.pdf", "content_url": "https://acme.zendesk.com/attachments/token/abc/?name=faktura_MetteS%C3%B8rensen.pdf", "content_type": "application/pdf", "size": 12345, "thumbnails": [] }],
      "via": { "channel": "email", "source": { "from": { "address": "mette@contoso.example", "name": "Mette Sørensen" }, "to": {}, "rel": null } },
      "created_at": "2026-01-05T09:12:00Z"
    },
    {
      "id": 2, "author_id": 100002, "public": false,
      "body": "Intern note: kunden er CFO hos Contoso, se sag hos Lars Nielsen.",
      "html_body": "<p>Intern note</p>",
      "plain_body": "Intern note: kunden er CFO hos Contoso, se sag hos Lars Nielsen.",
      "attachments": [],
      "created_at": "2026-01-05T10:00:00Z"
    }
  ],
  "expected": {
    "absent": ["Mette Sørensen", "Mette", "Sørensen", "mette@contoso.example", "010190-1234", "12 34 56 78", "Contoso", "Lars Nielsen", "10.1.2.3", "Aarhus, Denmark", "attachments/token"],
    "present": ["Vedhæftet faktura", "4711", "open", "Intern note"]
  }
}
```
The `expected` block is consumed only by the e2e suite (Task 17): `absent` strings must not appear anywhere in the sanitized output; `present` strings must (case-insensitive substring). Tests in this task strip `expected` before feeding the payload to the field policy.

`tests/policy/fieldPolicy.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { applyFieldPolicy, fillFields, ruleFor } from "@/policy/fieldPolicy.ts";
import fixture from "../fixtures/tickets/basic-da.json";

const payload = (({ expected, ...rest }) => rest)(fixture as any);

describe("ruleFor", () => {
  test("suffix rules skip array indices", () => {
    expect(ruleFor(["ticket", "comments", "3", "via", "source", "from"], {})).toBe("drop");
    expect(ruleFor(["ticket", "comments", "0", "html_body"], "<p>")).toBe("drop");
    expect(ruleFor(["comments", "0", "attachments", "0", "content_url"], "https://x")).toBe("drop");
    expect(ruleFor(["ticket", "requester"], { id: 1 })).toBe("idOnly");
  });
  test("defaults: string → sanitize, primitives → keep", () => {
    expect(ruleFor(["ticket", "some_new_field"], "text")).toBe("sanitize");
    expect(ruleFor(["ticket", "some_new_field"], 5)).toBe("keep");
    expect(ruleFor(["ticket", "some_new_field"], null)).toBe("keep");
  });
  test("known safe strings are kept", () => {
    for (const k of ["url", "status", "priority", "created_at", "updated_at", "content_type", "channel", "type", "next_page"]) {
      expect(ruleFor(["ticket", k], "x")).toBe("keep");
    }
  });
});

describe("applyFieldPolicy + fillFields", () => {
  test("drops, reduces and collects exactly the free-text fields", () => {
    const { skeleton, fields } = applyFieldPolicy(payload) as any;
    const t = skeleton.ticket;
    expect(t.requester).toEqual({ id: 900001 });
    expect(t.via.source.from).toBeUndefined();
    expect(t.via.channel).toBe("email");
    expect(t.metadata.system.ip_address).toBeUndefined();
    expect(t.metadata.system.location).toBeUndefined();
    expect(skeleton.comments[0].html_body).toBeUndefined();
    expect(skeleton.comments[0].attachments[0].content_url).toBeUndefined();
    expect(skeleton.comments[0].attachments[0].size).toBe(12345);
    expect(t.custom_fields[2].value).toBe(42);

    const paths = fields.map((f: any) => f.path).sort();
    expect(paths).toEqual([
      "comments.0.attachments.0.file_name", "comments.0.body", "comments.0.plain_body",
      "comments.1.body", "comments.1.plain_body",
      "ticket.custom_fields.0.value", "ticket.description", "ticket.raw_subject", "ticket.subject",
      "ticket.tags.0", "ticket.tags.1",
    ]);
  });

  test("fillFields swaps markers for sanitized text", () => {
    const { skeleton, fields } = applyFieldPolicy(payload);
    const texts = new Map(fields.map((f) => [f.path, `S(${f.path})`]));
    const filled = fillFields(skeleton, texts) as any;
    expect(filled.ticket.subject).toBe("S(ticket.subject)");
    expect(filled.comments[1].body).toBe("S(comments.1.body)");
    expect(JSON.stringify(filled)).not.toContain("__zsan");
  });

  test("fillFields throws if a marker is unfilled (fail closed)", () => {
    const { skeleton } = applyFieldPolicy(payload);
    expect(() => fillFields(skeleton, new Map())).toThrow(/unfilled/);
  });

  test("non-object payloads pass through", () => {
    expect(applyFieldPolicy(5)).toEqual({ skeleton: 5, fields: [] });
    const s = applyFieldPolicy("free text");
    expect(s.fields).toEqual([{ path: "", text: "free text" }]);
    expect(fillFields(s.skeleton, new Map([["", "X"]]))).toBe("X");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/policy/fieldPolicy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/policy/fieldPolicy.ts`**

```ts
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

export function applyFieldPolicy(payload: unknown): { skeleton: unknown; fields: CollectedField[] } {
  const fields: CollectedField[] = [];
  const walk = (value: unknown, path: string[]): unknown => {
    if (typeof value === "string" && path.length === 0) {
      fields.push({ path: "", text: value });
      return { [MARKER]: "" };
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, String(i)]));
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const p = [...path, key];
      const rule = ruleFor(p, v);
      if (rule === "drop") continue;
      if (rule === "idOnly") { const id = (v as { id?: unknown }).id; out[key] = id === undefined ? null : { id }; continue; }
      if (rule === "keep") { out[key] = v; continue; }
      if (typeof v === "string") { const id = p.join("."); fields.push({ path: id, text: v }); out[key] = { [MARKER]: id }; continue; }
      out[key] = walk(v, p);
    }
    return out;
  };
  return { skeleton: walk(payload, []), fields };
}

export function fillFields(skeleton: unknown, texts: Map<string, string>): unknown {
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill);
    if (typeof value !== "object" || value === null) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === MARKER) {
      const id = (value as Record<string, string>)[MARKER]!;
      const t = texts.get(id);
      if (t === undefined) throw new Error(`fieldPolicy: unfilled sanitize marker at "${id}"`);
      return t;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  };
  return fill(skeleton);
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/policy/fieldPolicy.test.ts`
Expected: 7 pass. If a path list differs, inspect `fields` — the expected list is the contract; adjust RULES, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/policy/fieldPolicy.ts tests/policy/fieldPolicy.test.ts tests/fixtures/tickets/basic-da.json
git commit -m "feat(policy): Zendesk field policy walk (drop / idOnly / keep / sanitize) with fail-closed refill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Result sanitizer (CallToolResult ↔ sanitize core)

**Files:**
- Create: `src/policy/resultSanitizer.ts`
- Test: `tests/policy/resultSanitizer.test.ts`

**Interfaces:**
- Consumes: `applyFieldPolicy`, `fillFields` (Task 12); `SanitizeSession`, `SanitizeOutput`, `Chunk`, `SanitizerError` (Task 9).
- Produces:
  ```ts
  export interface TextContent { type: "text"; text: string }
  export interface ToolResult { content: Array<TextContent | { type: string; [k: string]: unknown }>; isError?: boolean; [k: string]: unknown }
  export interface ResultSanitizerDeps { newSession: () => SanitizeSession }
  export interface SanitizedResult { result: ToolResult; counts: Counts; perPass: { pass1: number; pass2: number } }
  export function decodeText(text: string): { prefix: string; json: unknown | undefined; raw: string };  // splits "Ticket created successfully!\n\n{...}" style prefixes
  export function encodeText(prefix: string, json: unknown): string;   // prefix + JSON.stringify(json, null, 2)
  export function createResultSanitizer(deps: ResultSanitizerDeps): { sanitize(result: ToolResult): Promise<SanitizedResult> }
  ```
- Semantics: one `SanitizeSession` per `sanitize()` call (shared across all content items → consistent placeholders). For each `text` content item: `decodeText`; if JSON parsed → field policy → chunks (`id = "<itemIndex>:<path>"`) ; else whole text as one chunk (`id = "<itemIndex>:"`). Non-text content items (images, resources) are **dropped** (fail safe; upstream doesn't emit them, but be strict). Extra top-level keys on the result other than `content` and `isError` (`retryAfter`, `validationDetails`, `errorType`, `timestamp`, `isRetryable`) are dropped — `validationDetails` can embed raw Zendesk bodies.

- [ ] **Step 1: Write the failing tests**

`tests/policy/resultSanitizer.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { createResultSanitizer, decodeText, encodeText } from "@/policy/resultSanitizer.ts";
import { SanitizeSession } from "@/sanitize/session.ts";
import { emptyAllowlist, fakePass1, spansByLiteral } from "../helpers/fakes.ts";
import fixture from "../fixtures/tickets/basic-da.json";

const payload = (({ expected, ...rest }) => rest)(fixture as any);

const newSession = () => new SanitizeSession({
  pass1: fakePass1((c) => spansByLiteral(c.text, [["Mette Sørensen", "PERSON"], ["mette@contoso.example", "EMAIL"], ["010190-1234", "CPR"], ["Contoso ApS", "ORG"]], "presidio")),
  pass2: null, allowlist: emptyAllowlist(), detectLang: () => "da",
  timeouts: { pass1Ms: 1000, pass2Ms: 1000 }, chunkMaxChars: 6000, concurrency: 2,
});

describe("decodeText / encodeText", () => {
  test("plain JSON", () => {
    const d = decodeText('{\n  "a": 1\n}');
    expect(d.prefix).toBe(""); expect(d.json).toEqual({ a: 1 });
  });
  test("prefixed JSON", () => {
    const d = decodeText('Ticket updated successfully!\n\n{"a":1}');
    expect(d.prefix).toBe("Ticket updated successfully!\n\n"); expect(d.json).toEqual({ a: 1 });
    expect(encodeText(d.prefix, d.json)).toBe('Ticket updated successfully!\n\n{\n  "a": 1\n}');
  });
  test("non-JSON", () => {
    const d = decodeText("🔍 Not Found: no such ticket 99");
    expect(d.json).toBeUndefined(); expect(d.raw).toBe("🔍 Not Found: no such ticket 99");
  });
  test("JSON array", () => {
    expect(decodeText("[1,2]").json).toEqual([1, 2]);
  });
});

describe("createResultSanitizer", () => {
  test("sanitizes JSON payloads field-by-field with consistent placeholders", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result, counts } = await rs.sanitize({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
    const text = (result.content[0] as any).text as string;
    const out = JSON.parse(text);
    expect(out.ticket.subject).toBe("Faktura fra [PERSON_1] bliver ikke læst");
    expect(out.ticket.description).toContain("[PERSON_1] fra [ORG_1]. Mit cpr er [CPR_1].");
    expect(out.ticket.requester).toEqual({ id: 900001 });
    expect(out.comments[0].attachments[0].file_name).toBe("faktura_MetteSørensen.pdf"); // literal not matched by this fake; real Presidio/GLiNER handle it — e2e asserts
    expect(text).not.toContain("mette@contoso.example");
    expect(text).not.toContain("content_url");
    expect(counts.PERSON).toBeGreaterThanOrEqual(2);
  });

  test("non-JSON text is sanitized whole", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result } = await rs.sanitize({ content: [{ type: "text", text: "Error for Mette Sørensen: not found" }], isError: true, validationDetails: { raw: "Mette Sørensen" } });
    expect((result.content[0] as any).text).toBe("Error for [PERSON_1]: not found");
    expect(result.isError).toBe(true);
    expect((result as any).validationDetails).toBeUndefined();
  });

  test("a free-text prefix before the JSON is sanitized too", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result } = await rs.sanitize({ content: [{ type: "text", text: 'Validation Error: requester Mette Sørensen not found\n\nDetails:\n{"requester":"Mette Sørensen"}' }], isError: true });
    const text = (result.content[0] as any).text as string;
    expect(text).toBe('Validation Error: requester [PERSON_1] not found\n\nDetails:\n{\n  "requester": "[PERSON_1]"\n}');
  });

  test("multiple content items share one placeholder table", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result } = await rs.sanitize({ content: [{ type: "text", text: "Mette Sørensen" }, { type: "text", text: "Again Mette Sørensen" }] });
    expect((result.content[1] as any).text).toBe("Again [PERSON_1]");
  });

  test("non-text content items are dropped", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result } = await rs.sanitize({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "ok" }] });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("sanitizer failure propagates (caller maps to MCP error)", async () => {
    const failing = () => new SanitizeSession({
      pass1: fakePass1(() => { throw new Error("down"); }), pass2: null, allowlist: emptyAllowlist(),
      timeouts: { pass1Ms: 10, pass2Ms: 10 }, chunkMaxChars: 6000, concurrency: 1,
    });
    const rs = createResultSanitizer({ newSession: failing });
    await expect(rs.sanitize({ content: [{ type: "text", text: "secret Mette" }] })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/policy/resultSanitizer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/policy/resultSanitizer.ts`**

```ts
import type { SanitizeSession } from "../sanitize/session.ts";
import type { Chunk, Counts } from "../sanitize/types.ts";
import { applyFieldPolicy, fillFields } from "./fieldPolicy.ts";

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

interface Pending { index: number; prefix: string; skeleton?: unknown; whole?: boolean }
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
        for (const f of fields) chunks.push({ id: `${index}:${f.path}`, text: f.text });
        // The prefix is upstream free text too (e.g. "Validation Error: requester <name> not found\n\nDetails:\n") — sanitize it.
        if (prefix) chunks.push({ id: `${index}:${PREFIX_KEY}`, text: prefix });
        pending.push({ index, prefix, skeleton });
      });

      const out = await session.sanitize(chunks);

      const content: TextContent[] = pending.map((p) => {
        if (p.whole) return { type: "text", text: out.texts.get(`${p.index}:`)! };
        const texts = new Map<string, string>();
        for (const [id, t] of out.texts) if (id.startsWith(`${p.index}:`)) texts.set(id.slice(`${p.index}:`.length), t);
        const prefix = p.prefix ? texts.get(PREFIX_KEY)! : "";
        texts.delete(PREFIX_KEY);
        return { type: "text", text: encodeText(prefix, fillFields(p.skeleton, texts)) };
      });

      const sanitized: ToolResult = { content };
      if (result.isError) sanitized.isError = true;
      return { result: sanitized, counts: out.counts, perPass: out.perPass };
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test tests/policy/resultSanitizer.test.ts && bun run typecheck`
Expected: 10 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/policy/resultSanitizer.ts tests/policy/resultSanitizer.test.ts
git commit -m "feat(policy): sanitize CallToolResult text items via field policy and SanitizeSession

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Upstream child process (clean env, stderr capture)

**Files:**
- Create: `src/upstream/client.ts`, `src/upstream/child.ts`
- Test: `tests/upstream/child.test.ts`

**Interfaces:**
- Produces (`client.ts`):
  ```ts
  export interface ToolDefinition { name: string; description?: string; inputSchema: unknown; [k: string]: unknown }
  export interface UpstreamClient {
    listTools(): Promise<ToolDefinition[]>;
    callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;   // ToolResult from Task 13
    close(): Promise<void>;
  }
  ```
- Produces (`child.ts`):
  ```ts
  export interface SpawnOptions {
    command: string;                       // "npx -y @sshadows/zendesk-mcp-server@1.4.1"
    zendesk: { subdomain: string; email: string; apiToken: string };
    onStderrLine: (line: string) => void;  // proxy passes logger.debug (guarded)
    platform?: NodeJS.Platform;            // injected for tests; default process.platform
    mkTempDir?: () => string;              // injected for tests; default mkdtempSync(join(tmpdir(), "zsan-upstream-"))
  }
  export function buildSpawnSpec(opts: SpawnOptions): { command: string; args: string[]; env: Record<string, string>; cwd: string };
  export async function spawnUpstream(opts: SpawnOptions): Promise<UpstreamClient>;   // McpUpstreamClient over StdioClientTransport
  ```
- `buildSpawnSpec` is pure and fully unit-tested; `spawnUpstream` is thin glue over the SDK (`Client` + `StdioClientTransport`) and is exercised by the e2e suite, not unit tests. On `win32`, the command is wrapped as `cmd /c <command>` (npx is a `.cmd` shim on Windows).

- [ ] **Step 1: Write the failing tests**

`tests/upstream/child.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildSpawnSpec } from "@/upstream/child.ts";

const zendesk = { subdomain: "acme", email: "bot@acme.example", apiToken: "tok" };
const base = { command: "npx -y @sshadows/zendesk-mcp-server@1.4.1", zendesk, onStderrLine: () => {}, mkTempDir: () => "/tmp/zsan-x" };

describe("buildSpawnSpec", () => {
  test("linux: splits command, passes only the Zendesk trio + PATH, empty cwd", () => {
    const spec = buildSpawnSpec({ ...base, platform: "linux" });
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "@sshadows/zendesk-mcp-server@1.4.1"]);
    expect(Object.keys(spec.env).sort()).toEqual(["PATH", "ZENDESK_API_TOKEN", "ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"]);
    expect(spec.env.ZENDESK_SUBDOMAIN).toBe("acme");
    expect(spec.env.PATH).toBe(process.env.PATH ?? "");
    expect(spec.cwd).toBe("/tmp/zsan-x");
  });

  test("win32: wraps with cmd /c", () => {
    const spec = buildSpawnSpec({ ...base, platform: "win32" });
    expect(spec.command).toBe("cmd");
    expect(spec.args).toEqual(["/c", "npx", "-y", "@sshadows/zendesk-mcp-server@1.4.1"]);
  });

  test("never leaks the proxy's own env (e.g. ZSAN_*, ANTHROPIC_API_KEY)", () => {
    process.env.ANTHROPIC_API_KEY = "should-not-leak";
    process.env.ZSAN_ZENDESK_API_TOKEN = "should-not-leak";
    const spec = buildSpawnSpec({ ...base, platform: "linux" });
    expect(JSON.stringify(spec.env)).not.toContain("should-not-leak");
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ZSAN_ZENDESK_API_TOKEN;
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/upstream/child.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/upstream/client.ts`:
```ts
import type { ToolResult } from "../policy/resultSanitizer.ts";

export interface ToolDefinition { name: string; description?: string; inputSchema: unknown; [k: string]: unknown }

export interface UpstreamClient {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}
```

`src/upstream/child.ts`:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../policy/resultSanitizer.ts";
import type { ToolDefinition, UpstreamClient } from "./client.ts";

export interface SpawnOptions {
  command: string;
  zendesk: { subdomain: string; email: string; apiToken: string };
  onStderrLine: (line: string) => void;
  platform?: NodeJS.Platform;
  mkTempDir?: () => string;
}

export function buildSpawnSpec(opts: SpawnOptions): { command: string; args: string[]; env: Record<string, string>; cwd: string } {
  const platform = opts.platform ?? process.platform;
  const parts = opts.command.trim().split(/\s+/);
  const [command, ...args] = platform === "win32" ? ["cmd", "/c", ...parts] : parts;
  return {
    command: command!,
    args,
    env: {
      PATH: process.env.PATH ?? "",
      ZENDESK_SUBDOMAIN: opts.zendesk.subdomain,
      ZENDESK_EMAIL: opts.zendesk.email,
      ZENDESK_API_TOKEN: opts.zendesk.apiToken,
    },
    cwd: (opts.mkTempDir ?? (() => mkdtempSync(join(tmpdir(), "zsan-upstream-"))))(),
  };
}

export async function spawnUpstream(opts: SpawnOptions): Promise<UpstreamClient> {
  const spec = buildSpawnSpec(opts);
  const transport = new StdioClientTransport({ ...spec, stderr: "pipe" });
  const client = new Client({ name: "zendesk-sanitizing-proxy", version: "0.0.1" });
  await client.connect(transport);

  let buffer = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) opts.onStderrLine(`[upstream] ${line}`);
  });

  return {
    async listTools() {
      const res = await client.listTools();
      return res.tools as ToolDefinition[];
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    },
    async close() {
      await client.close();
    },
  };
}
```

- [ ] **Step 4: Run — expect pass; typecheck**

Run: `bun test tests/upstream/child.test.ts && bun run typecheck`
Expected: 3 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/upstream/client.ts src/upstream/child.ts tests/upstream/child.test.ts
git commit -m "feat(upstream): spawn Zendesk MCP child with clean env, temp cwd and captured stderr

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: Proxy server and stdio entry point

**Files:**
- Create: `src/server/proxy.ts`, `src/server/stdio.ts`
- Test: `tests/server/proxy.test.ts`

**Interfaces:**
- Consumes: `UpstreamClient`, `ToolDefinition` (Task 14); `createResultSanitizer` return type (Task 13); `isAllowedTool`, `filterToolList` (Task 11); `Logger`, `formatCounts` (Task 10); `SanitizerError` (Task 2).
- Produces:
  ```ts
  export interface ProxyDeps {
    upstream: UpstreamClient;
    sanitizer: { sanitize(result: ToolResult): Promise<SanitizedResult> };
    logger: Logger;
    now?: () => number;   // for duration; default Date.now
  }
  export function createProxyServer(deps: ProxyDeps): Server;   // @modelcontextprotocol/sdk Server with tools capability
  export function ticketIdFrom(args: Record<string, unknown>): string;   // "ticket 4711" | "query" | "-" for logs
  ```
- Error mapping in the `tools/call` handler (all thrown as `McpError`):
  - tool not allowed → `ErrorCode.InvalidParams`, message `TOOL_NOT_ALLOWED: <name> is not available through the sanitizing proxy`
  - upstream throws → `ErrorCode.InternalError`, `UPSTREAM_UNAVAILABLE: the Zendesk MCP server did not respond`
  - `SanitizerError` → `ErrorCode.InternalError`, `<code>: response withheld by the sanitizing proxy`
  - anything else → `ErrorCode.InternalError`, `SANITIZER_INTERNAL: response withheld by the sanitizing proxy`
  Messages are static; `error.message` from upstream/sanitizer goes to the log only (guarded).

- [ ] **Step 1: Write the failing tests**

`tests/server/proxy.test.ts`:
```ts
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
    async listTools() { return [{ name: "get_ticket", inputSchema: {} }, { name: "delete_ticket", inputSchema: {} }, { name: "search", inputSchema: {} }]; },
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
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/server/proxy.test.ts`
Expected: FAIL — module not found. (If `InMemoryTransport` import fails, check `node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js` exists — it does in 1.30.0.)

- [ ] **Step 3: Implement**

`src/server/proxy.ts`:
```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { formatCounts, type Logger } from "../logging.ts";
import type { SanitizedResult, ToolResult } from "../policy/resultSanitizer.ts";
import { filterToolList, isAllowedTool } from "../policy/toolPolicy.ts";
import { SanitizerError } from "../sanitize/types.ts";
import type { UpstreamClient } from "../upstream/client.ts";

export interface ProxyDeps {
  upstream: UpstreamClient;
  sanitizer: { sanitize(result: ToolResult): Promise<SanitizedResult> };
  logger: Logger;
  now?: () => number;
}

export function ticketIdFrom(args: Record<string, unknown>): string {
  if (typeof args.id === "number" || typeof args.id === "string") return `ticket ${args.id}`;
  if (typeof args.query === "string") return "query";
  return "-";
}

const WITHHELD = "response withheld by the sanitizing proxy";

export function createProxyServer(deps: ProxyDeps): Server {
  const now = deps.now ?? Date.now;
  const server = new Server({ name: "zendesk-sanitizing-proxy", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await deps.upstream.listTools();
    return { tools: filterToolList(tools) as never };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!isAllowedTool(name)) {
      deps.logger.warn(`${name} blocked`);
      throw new McpError(ErrorCode.InvalidParams, `TOOL_NOT_ALLOWED: ${name} is not available through the sanitizing proxy`);
    }

    const started = now();
    let raw: ToolResult;
    try {
      raw = await deps.upstream.callTool(name, args);
    } catch (e) {
      deps.logger.error(`${name} ${ticketIdFrom(args)}: upstream failed (${(e as Error).name})`);
      throw new McpError(ErrorCode.InternalError, "UPSTREAM_UNAVAILABLE: the Zendesk MCP server did not respond");
    }

    let sanitized: SanitizedResult;
    try {
      sanitized = await deps.sanitizer.sanitize(raw);
    } catch (e) {
      const code = e instanceof SanitizerError ? e.code : "SANITIZER_INTERNAL";
      deps.logger.error(`${name} ${ticketIdFrom(args)}: ${code} (${(e as Error).name})`);
      throw new McpError(ErrorCode.InternalError, `${code}: ${WITHHELD}`);
    }

    deps.logger.info(
      `${name} ${ticketIdFrom(args)}: ${formatCounts(sanitized.counts)} (pass1 ${sanitized.perPass.pass1}, pass2 ${sanitized.perPass.pass2}) ${now() - started}ms`,
    );
    return sanitized.result as never;
  });

  return server;
}
```

`src/server/stdio.ts` (laptop-mode entry point; composition root — no logic of its own):
```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.ts";
import { createLogger } from "../logging.ts";
import { createResultSanitizer } from "../policy/resultSanitizer.ts";
import { Allowlist } from "../sanitize/allowlist.ts";
import { loadRecognizers } from "../sanitize/cpr.ts";
import { PresidioClient } from "../sanitize/presidio.ts";
import { SanitizeSession } from "../sanitize/session.ts";
import { createProxyServer } from "./proxy.ts";
import { spawnUpstream } from "../upstream/child.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel }); // stderr — stdout is the MCP transport

if (config.pass2 === "off") {
  logger.warn("ZSAN_PASS2=off — running with Presidio only. Contextual PII (addresses, usernames, missed names) will NOT be redacted.");
} else {
  // Plan 2 wires the GLiNER detector here. Until then a required pass 2 cannot be satisfied.
  logger.error("ZSAN_PASS2=required but no pass-2 detector is implemented yet (Plan 2). Set ZSAN_PASS2=off to run Presidio-only.");
  process.exit(2);
}

const allowlist = await Allowlist.fromFile(config.allowlistPath);
const recognizers = await loadRecognizers("config/recognizers");
const presidio = new PresidioClient({ baseUrl: config.presidioUrl, recognizers });

const sanitizer = createResultSanitizer({
  newSession: () => new SanitizeSession({
    pass1: presidio,
    pass2: null,
    allowlist,
    timeouts: { pass1Ms: config.timeouts.presidioMs, pass2Ms: config.timeouts.pass2Ms },
    chunkMaxChars: config.chunkMaxChars,
    concurrency: config.concurrency,
  }),
});

const upstream = await spawnUpstream({ command: config.upstreamCommand, zendesk: config.zendesk, onStderrLine: (l) => logger.debug(l) });
const server = createProxyServer({ upstream, sanitizer, logger });
await server.connect(new StdioServerTransport());
logger.info("zendesk-sanitizing-proxy ready (stdio, pass2=off)");

const shutdown = async () => { await upstream.close().catch(() => {}); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- [ ] **Step 4: Run — expect pass; full suite; typecheck**

Run: `bun test tests/server/proxy.test.ts && bun test && bun run typecheck`
Expected: 7 pass; whole suite green; typecheck clean.

- [ ] **Step 5: Manual round-trip against the real upstream (no sanitizer yet needs Presidio? — it does: `ZSAN_PASS2=off` still requires Presidio running; do this step after Task 16 if Presidio isn't up yet)**

With `.env` filled (never committed) and Presidio running (Task 16):
```bash
bun run start   # in one terminal — should log "ready"
```
Then in Claude Code, add to a scratch project's `.mcp.json`:
```json
{ "mcpServers": { "zendesk": { "type": "stdio", "command": "bun", "args": ["run", "C:/GeneralDev/DevOpsPullers/ZendeskSanitizing/src/server/stdio.ts"] } } }
```
Ask Claude Code to list Zendesk tools — expect exactly the 8 allowed tools. Fetch a ticket you know contains a name — expect `[PERSON_n]` placeholders. Record the observation (not the ticket content) in the PR description.

- [ ] **Step 6: Commit**

```bash
git add src/server/proxy.ts src/server/stdio.ts tests/server/proxy.test.ts
git commit -m "feat(server): MCP proxy with tool allowlist, sanitized results, fail-closed errors; stdio entry point

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Presidio sidecar image, compose (laptop profile), contract test

**Files:**
- Create: `sidecars/presidio/Dockerfile`, `sidecars/presidio/nlp.yml`, `sidecars/presidio/recognizers.yml`, `deploy/docker-compose.yml`, `deploy/versions.env`
- Test: `tests/contract/presidio.contract.test.ts` (runs only when `ZSAN_CONTRACT=1`)

**Interfaces:**
- Produces: a running analyzer at `http://127.0.0.1:5002` whose `POST /analyze` accepts `language: da|en|de` and recognizes EMAIL_ADDRESS / PHONE_NUMBER / IBAN_CODE / CREDIT_CARD / PERSON / ORGANIZATION in all three languages, plus the ad-hoc `DK_CPR` / `DK_PHONE`.

- [ ] **Step 1: Resolve the pins (record real values, do not guess)**

```bash
docker buildx imagetools inspect mcr.microsoft.com/presidio-analyzer:latest --format '{{json .Manifest.Digest}}'
docker run --rm mcr.microsoft.com/presidio-analyzer:latest python -c "import spacy, presidio_analyzer; print('spacy', spacy.__version__); print('presidio', presidio_analyzer.__version__)"
```
Write the results into `deploy/versions.env`:
```
# Resolved on <date> — every value here changes sanitization behaviour; bump via PR + e2e.
PRESIDIO_ANALYZER_DIGEST=sha256:<from imagetools inspect>
PRESIDIO_ANALYZER_VERSION=<printed presidio version>
SPACY_VERSION=<printed spacy version>
# spaCy models must match spaCy's major.minor. See https://github.com/explosion/spacy-models/releases
SPACY_MODEL_VERSION=<e.g. 3.8.0>
```

- [ ] **Step 2: Write the contract test (fails until the sidecar is up)**

`tests/contract/presidio.contract.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { PresidioClient } from "@/sanitize/presidio.ts";
import { loadRecognizers } from "@/sanitize/cpr.ts";

const enabled = process.env.ZSAN_CONTRACT === "1";
const baseUrl = process.env.ZSAN_PRESIDIO_URL ?? "http://127.0.0.1:5002";
const d = enabled ? describe : describe.skip;

d("presidio analyzer contract", () => {
  const signal = () => AbortSignal.timeout(30_000);
  let client: PresidioClient;
  test("health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.ok).toBe(true);
    client = new PresidioClient({ baseUrl, recognizers: await loadRecognizers("config/recognizers") });
  });

  test.each([
    ["da", "Hej, jeg hedder Mette Sørensen og arbejder hos Contoso ApS i Aarhus. Skriv til mette@contoso.example eller ring +45 12 34 56 78. CPR 010190-1234. IBAN DK5000400440116243."],
    ["en", "Hello, my name is Jonathan Whitfield from Fabrikam Ltd. Email jonathan@fabrikam.example or call +44 20 7946 0958. Card 4111 1111 1111 1111."],
    ["de", "Guten Tag, mein Name ist Katharina Vogelsang von der Muster GmbH. E-Mail katharina@muster.example, Telefon +49 30 901820. IBAN DE89370400440532013000."],
  ] as const)("recognizes entities in %s", async (lang, text) => {
    const spans = await client.analyze({ id: "t", text, lang }, { signal: signal() });
    const types = new Set(spans.map((s) => s.type));
    expect(types.has("PERSON")).toBe(true);
    expect(types.has("EMAIL")).toBe(true);
    expect(types.has("PHONE")).toBe(true);
    if (lang === "da") { expect(types.has("CPR")).toBe(true); expect(types.has("IBAN")).toBe(true); }
    if (lang === "en") expect(types.has("CARD")).toBe(true);
    if (lang === "de") expect(types.has("IBAN")).toBe(true);
  });

  test("rejects an unsupported language", async () => {
    const res = await fetch(`${baseUrl}/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hola", language: "es" }) });
    expect(res.ok).toBe(false);
  });
});
```

Run: `ZSAN_CONTRACT=1 bun test tests/contract` → Expected: FAIL (connection refused) — the red state.

- [ ] **Step 3: Write the sidecar**

`sidecars/presidio/nlp.yml`:
```yaml
nlp_engine_name: spacy
models:
  - lang_code: da
    model_name: da_core_news_lg
  - lang_code: en
    model_name: en_core_web_lg
  - lang_code: de
    model_name: de_core_news_lg
ner_model_configuration:
  model_to_presidio_entity_mapping:
    PER: PERSON
    PERSON: PERSON
    ORG: ORGANIZATION
    LOC: LOCATION
    GPE: LOCATION
    NORP: NRP
    MISC: MISC
  low_confidence_score_multiplier: 0.4
  low_score_entity_names: [ORGANIZATION, ORG]
  labels_to_ignore: [CARDINAL, DATE, EVENT, FAC, LANGUAGE, LAW, MONEY, ORDINAL, PERCENT, PRODUCT, QUANTITY, TIME, WORK_OF_ART, MISC]
```

`sidecars/presidio/recognizers.yml`:
```yaml
supported_languages: [da, en, de]
global_regex_flags: 26
recognizers:
  - name: EmailRecognizer
    type: predefined
    supported_languages: [da, en, de]
  - name: PhoneRecognizer
    type: predefined
    supported_languages: [da, en, de]
  - name: IbanRecognizer
    type: predefined
    supported_languages: [da, en, de]
  - name: CreditCardRecognizer
    type: predefined
    supported_languages: [da, en, de]
  - name: SpacyRecognizer
    type: predefined
    supported_languages: [da, en, de]
```

`sidecars/presidio/Dockerfile`:
```dockerfile
ARG PRESIDIO_ANALYZER_DIGEST
FROM mcr.microsoft.com/presidio-analyzer@${PRESIDIO_ANALYZER_DIGEST}
ARG SPACY_MODEL_VERSION
RUN pip install --no-cache-dir \
    "https://github.com/explosion/spacy-models/releases/download/da_core_news_lg-${SPACY_MODEL_VERSION}/da_core_news_lg-${SPACY_MODEL_VERSION}-py3-none-any.whl" \
    "https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-${SPACY_MODEL_VERSION}/en_core_web_lg-${SPACY_MODEL_VERSION}-py3-none-any.whl" \
    "https://github.com/explosion/spacy-models/releases/download/de_core_news_lg-${SPACY_MODEL_VERSION}/de_core_news_lg-${SPACY_MODEL_VERSION}-py3-none-any.whl"
COPY nlp.yml recognizers.yml /app/conf/
ENV NLP_CONF_FILE=/app/conf/nlp.yml \
    RECOGNIZER_REGISTRY_CONF_FILE=/app/conf/recognizers.yml
```

`deploy/docker-compose.yml`:
```yaml
# Usage (laptop):  docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build
services:
  presidio-analyzer:
    build:
      context: ../sidecars/presidio
      args:
        PRESIDIO_ANALYZER_DIGEST: ${PRESIDIO_ANALYZER_DIGEST}
        SPACY_MODEL_VERSION: ${SPACY_MODEL_VERSION}
    image: zsan/presidio-analyzer:${SPACY_MODEL_VERSION}-${PRESIDIO_ANALYZER_VERSION}
    profiles: [laptop, vm]
    ports:
      - "127.0.0.1:5002:3000"
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:3000/health')\""]
      interval: 15s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits:
          memory: 4g
```

- [ ] **Step 4: Build, start, run contract test — expect pass**

```bash
docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build
docker compose -f deploy/docker-compose.yml logs -f presidio-analyzer   # wait for "Running on"
ZSAN_CONTRACT=1 bun test tests/contract
```
Expected: 5 pass. Troubleshooting, in order: (1) env var names for the config files — if the analyzer ignores them, open `/app/app.py` in the container (`docker compose exec presidio-analyzer cat /app/app.py`) and use the names it reads; (2) `PhoneRecognizer` not firing for da → it defaults to a region list that lacks DK — the `DK_PHONE` ad-hoc recognizer covers Danish formats; make the `da` assertion pass via `DK_PHONE` and note it in the PR; (3) memory — `docker stats` should show < 3.5 GB after warm-up; if higher, lower the memory limit test expectation and note it in spec §16.

- [ ] **Step 5: Commit**

```bash
git add sidecars/presidio deploy tests/contract/presidio.contract.test.ts
git commit -m "feat(sidecar): digest-pinned Presidio analyzer with da/en/de spaCy models; compose laptop profile; contract test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: Fixture corpus, e2e regression suite, README

**Files:**
- Create: `tests/fixtures/tickets/{english-partner.json, german-partner.json, search-results.json, attachments.json, organization.json, error-validation.json}`, `tests/e2e/fixtures.e2e.test.ts`, `README.md`
- Modify: `CLAUDE.md` (Commands + Architecture sections)

**Interfaces:**
- Fixture format (all files in `tests/fixtures/tickets/`):
  ```ts
  interface TicketFixture {
    expected: { absent: string[]; present: string[]; toolResultPrefix?: string };
    // every other top-level key is the upstream JSON payload
  }
  ```
- The e2e harness builds a real `SanitizeSession` (real `PresidioClient`, `pass2: null` in this plan; Plan 2 flips it to GLiNER) and drives `createResultSanitizer` directly — no upstream, no Zendesk.

- [ ] **Step 1: Write the fixtures**

Author five more synthetic fixtures following `basic-da.json`. Each must include the `expected` block. Required coverage:

`english-partner.json` — `get_ticket` payload, English, requester "Jonathan Whitfield" at "Fabrikam Ltd", email, UK phone `+44 20 7946 0958`, card `4111 1111 1111 1111`, signature "Best regards, Jonathan"; allowlisted "Business Central" and "Document Capture" in the body (must be `present`).

`german-partner.json` — German, "Katharina Vogelsang", "Muster GmbH", IBAN `DE89370400440532013000`, phone `+49 30 901820`, street "Musterstraße 12, 10115 Berlin" (address is *not* expected absent in Plan 1 — Presidio has no DE address recognizer; list it under a new key `"expectedPass2": {"absent": [...]}` so Plan 2 can promote it).

`search-results.json` — `search` payload: `{ "results": [ ...3 ticket objects with subjects containing names..., 1 user object {"result_type":"user","name":"Lars Nielsen","email":"lars@x.example"} ], "count": 4 }`; `absent` includes the user's name and email; `present` includes `"result_type"` and `"count"`.

`attachments.json` — `get_ticket_attachments` payload `{ "attachments": [ {file_name:"faktura_MetteSørensen.pdf", content_url:"https://…/token/…", content_type, size, comment_id} ] }`; `absent`: the content_url host path `"token/"`; `present`: `"application/pdf"`. (Name inside a filename without spaces is a known Plan-1 gap → also listed in `expectedPass2.absent`.)

`organization.json` — `get_organization` payload with `name: "Contoso ApS"`, `domain_names`, `details`, `notes`; `absent`: name, domains, notes text.

`error-validation.json` — an upstream error result where the *text* is not JSON: `{ "expected": { "absent": ["Mette Sørensen"], "present": ["Validation Error"] }, "__rawText": "❌ Validation Error: requester Mette Sørensen not found\n\nDetails:\n{\"requester\":\"Mette Sørensen\"}" }`. The harness treats a fixture with `__rawText` as a non-JSON text item.

- [ ] **Step 2: Write the e2e test (red until Presidio is up)**

`tests/e2e/fixtures.e2e.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createResultSanitizer } from "@/policy/resultSanitizer.ts";
import { Allowlist } from "@/sanitize/allowlist.ts";
import { loadRecognizers } from "@/sanitize/cpr.ts";
import { PresidioClient } from "@/sanitize/presidio.ts";
import { SanitizeSession } from "@/sanitize/session.ts";

const enabled = process.env.ZSAN_E2E === "1";
const d = enabled ? describe : describe.skip;
const FIXTURE_DIR = "tests/fixtures/tickets";

interface Fixture { expected: { absent: string[]; present: string[] }; expectedPass2?: { absent: string[] }; __rawText?: string; [k: string]: unknown }

d("e2e: every fixture sanitizes clean (Presidio pass only)", async () => {
  const allowlist = await Allowlist.fromFile("config/allowlist.txt");
  const presidio = new PresidioClient({ baseUrl: process.env.ZSAN_PRESIDIO_URL ?? "http://127.0.0.1:5002", recognizers: await loadRecognizers("config/recognizers") });
  const sanitizer = createResultSanitizer({
    newSession: () => new SanitizeSession({ pass1: presidio, pass2: null, allowlist, timeouts: { pass1Ms: 30_000, pass2Ms: 30_000 }, chunkMaxChars: 6000, concurrency: 4 }),
  });
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  const scorecard: Record<string, { leaked: string[]; overRedacted: string[] }> = {};

  for (const file of files) {
    test(file, async () => {
      const fx = (await Bun.file(join(FIXTURE_DIR, file)).json()) as Fixture;
      const { expected, expectedPass2: _p2, __rawText, ...payload } = fx;
      const text = __rawText ?? JSON.stringify(payload, null, 2);
      const { result } = await sanitizer.sanitize({ content: [{ type: "text", text }] });
      const out = (result.content[0] as { text: string }).text;
      const lower = out.toLowerCase();
      const leaked = expected.absent.filter((s) => lower.includes(s.toLowerCase()));
      const overRedacted = expected.present.filter((s) => !lower.includes(s.toLowerCase()));
      scorecard[file] = { leaked, overRedacted };
      expect(leaked).toEqual([]);
      expect(overRedacted).toEqual([]);
    });
  }

  test("scorecard", () => {
    console.error("\n=== sanitization scorecard (pass1 only) ===\n" + JSON.stringify(scorecard, null, 2));
  });
});
```

Run: `ZSAN_E2E=1 bun test tests/e2e` with Presidio up. Expected first run: some fixtures **fail** — that is the point. For each leak decide: (a) recognizer/config gap that Presidio *should* catch → fix `nlp.yml` / `recognizers.yml` / thresholds and re-run; (b) genuinely contextual (address, name-in-filename, lower-case name) → move the string from `expected.absent` to `expectedPass2.absent` with a one-line reason in the PR. Do not weaken a fixture to make the suite green without recording the reason.

- [ ] **Step 3: Iterate until green**

Run: `ZSAN_E2E=1 bun test tests/e2e`
Expected: all fixture tests pass; the scorecard prints empty `leaked`/`overRedacted` arrays.

- [ ] **Step 4: Write `README.md` and update `CLAUDE.md`**

`README.md` must contain, in this order: one-paragraph purpose + the fail-closed guarantee; **Laptop mode** walkthrough (prereqs: Bun ≥ 1.3, Docker Desktop; `cp .env.example .env` and fill `ZSAN_ZENDESK_*`; `docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build`; `ZSAN_PASS2=off bun run start` smoke test; the stdio `.mcp.json` snippet from Task 15 step 5; the **single-registration rule**: remove any existing raw `zendesk` MCP entry from every `.mcp.json` / `~/.claude.json` before adding the proxy); **VM mode** — a short section stating it is delivered in Plan 2 with a link to spec §3; **Tools exposed** table (the 8 + why the rest are blocked, one line each category); **Testing** (`bun test`, `bun run test:contract`, `bun run test:e2e`, what each needs running); **Configuration** (table of `ZSAN_*` from `.env.example`); **Logging** (counts only; example line).

`CLAUDE.md` — replace the *Commands* placeholder with:
```
- `bun test` — unit suite (no network). `bun test tests/sanitize/session.test.ts` for one file; `bun test -t "name"` for one test.
- `bun run test:contract` — needs Presidio up (`docker compose … --profile laptop up`).
- `bun run test:e2e` — fixture regression gate; needs Presidio up.
- `bun run typecheck` — `tsc --noEmit`.
- `ZSAN_PASS2=off bun run start` — run the stdio proxy (laptop mode) with `.env` filled.
```
and the *Architecture* placeholder with a 6–8 line summary pointing at the spec: request path (`server/proxy.ts` → `policy/toolPolicy.ts` → `upstream/child.ts` → `policy/resultSanitizer.ts` → `policy/fieldPolicy.ts` → `sanitize/session.ts`), the two-pass design with `SpanDetector` slot, fail-closed rule, and "never real ticket data in fixtures".

- [ ] **Step 5: Full verification**

Run: `bun run typecheck && bun test && ZSAN_CONTRACT=1 bun test tests/contract && ZSAN_E2E=1 bun test tests/e2e`
Expected: all green. Paste the summary lines into the PR description.

- [ ] **Step 6: Commit and open the PR**

```bash
git add tests/fixtures/tickets tests/e2e README.md CLAUDE.md
git commit -m "test: synthetic fixture corpus and e2e regression gate; document laptop mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin feat/plan-1-core-proxy
gh pr create --title "Plan 1: sanitizing proxy core with Presidio pass (laptop mode)" --body "$(cat <<'EOF'
Implements docs/superpowers/plans/2026-08-27-plan-1-core-proxy-presidio.md against spec docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md.

- stdio MCP proxy, read-only tool allowlist, upstream child with clean env
- sanitize core: Presidio pass 1, placeholders, field policy, fail-closed
- Presidio sidecar (digest-pinned, da/en/de), compose laptop profile
- fixtures + e2e regression gate (pass 1 only; pass-2 gaps recorded under expectedPass2)

Test output:
<paste bun test / contract / e2e summaries>

Manual round-trip: <tools listed = 8; get_ticket returned placeholders — no ticket content here>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review (done while writing; recorded for the executor)

**Spec coverage → task:** §3.1 data flow → T13/T15; §3.2 outgoing → Plan 2; §4 components → T1–T15 (HTTP server, GLiNER, Ollama → Plan 2); §5 tool policy → T11 (without `add_ticket_comment`); §6.1–6.7 → T2–T9, T16; §6.8 → Plan 2; §7 field policy → T12; §8 fail-closed → T8, T9, T12 (`fillFields` throws), T15; §9 config → T1, T14 (clean env); §10 logging → T10, T15; §11 unit/contract/e2e → every task, T16, T17; §12 pinning → T16 (`versions.env`), governance/CI → Plan 2; §13 layout → file structure above; §14 build order steps 1–3 → this plan.

**Known Plan-1 limitations (by design, not gaps):** `ZSAN_PASS2=required` cannot be satisfied and exits with code 2 until Plan 2 adds GLiNER — laptop mode in Plan 1 runs with `ZSAN_PASS2=off`. Contextual PII (addresses, names inside filenames, lower-case names) is tracked in fixtures under `expectedPass2` and is the acceptance criterion for Plan 2.

**Type consistency check:** `ToolResult` defined in T13 and consumed by T14/T15; `SanitizedResult` T13 → T15; `Chunk.id` convention `"<itemIndex>:<path>"` used in T13 only; `SessionDeps` T9 used by T13 tests, T15 entry, T17; `AdHocRecognizer` T7 → T8, T16, T17; `Logger` T10 → T14 (`onStderrLine`), T15.

<!-- END OF PLAN 1 -->
