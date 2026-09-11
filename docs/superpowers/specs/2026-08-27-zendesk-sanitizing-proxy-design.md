# Zendesk Sanitizing MCP Proxy — Design Spec

**Date:** 2026-08-27
**Status:** Approved for planning
**Supersedes:** the initial project spec (kept below in "Changes from the initial spec")

## 1. Goal

An MCP server that Claude Code registers *as* "zendesk". It forwards a restricted set of
tool calls to the real Zendesk MCP server (`@sshadows/zendesk-mcp-server`), intercepts every
response, and removes personal data in two passes before anything reaches Claude Code.
Claude Code — and the developer laptops it runs on — never see raw ticket data and never hold
Zendesk credentials.

The sanitization core is a standalone module so the later Azure AI Search ingestion job
reuses the exact same code.

### Guarantees

1. **Fail closed.** If either sanitization pass is unreachable, times out, or returns an
   invalid result, the tool call returns an MCP error. The raw payload is never returned.
2. **Single point of access.** Zendesk credentials exist only in the proxy's environment on
   the VM. No other component can reach Zendesk. Direct upstream access is allowed only in
   the repo's test harness.
3. **Detector, not rewriter.** Pass 2 returns spans; TypeScript applies replacements. No
   model ever rewrites ticket text.
4. **No side channels.** Upstream tools that ship ticket content to third parties are blocked
   at the proxy and never appear in `tools/list`.
5. **Logs carry counts, never values.**

## 2. Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Upstream is `@sshadows/zendesk-mcp-server` 1.4.1 over **stdio**, spawned by the proxy | Verified from package source. Node ≥18, API-token mode via `ZENDESK_SUBDOMAIN/EMAIL/API_TOKEN`. |
| D2 | **Read-only allowlist + `add_ticket_comment` (internal only)** | Upstream exposes 55 tools including delete/update and three tools that send attachments to the Anthropic API and a third-party converter. |
| D3 | Languages: **da, en, de** | Actual ticket mix. Three spaCy models; per-chunk language detection. |
| D4 | Redact **all persons and all non-allowlisted organizations**; `config/allowlist.txt` protects product/vendor names | GDPR-strict; RAG keeps technical content. |
| D5 | Single `[PERSON_n]` type, no role split | Role is only knowable for metadata fields; a mixed scheme breaks same-value→same-placeholder. |
| D6 | Per-ticket placeholder table **shared by both passes**, word-subset matching within a type | "Mette" after "Mette Sørensen" → same placeholder. In-memory only, per tool call. |
| D7 | **Dedicated Ubuntu VM** hosts proxy + sidecars; proxy exposed over **Streamable HTTP** with bearer tokens | Confines raw PII and credentials to one host; laptops run only Claude Code. Existing `vm-devops-automation` (B2s, 3.8 GB, shared) is unsuitable. |
| D8 | **Pass 2 = GLiNER-PII** (encoder span extractor, CPU); Ollama LLM demoted to an alternative `SpanDetector` implementation | Native spans, deterministic, not prompt-injectable, runs on a CPU VM. Fixture suite is the bake-off harness. |
| D9 | Target VM: `Standard_D4as_v5` (4 vCPU, 16 GB) | Fits Presidio (3× `lg`) + GLiNER + proxy with headroom; ~$50/month with auto-shutdown. |
| D10 | Runtime: **Bun + TypeScript** | Sibling-project convention (Zod env, DI via interfaces, `bun test`, `tests/` mirrors `src/`). |
| D11 | CPR: pattern + **DDMMYY date validation** (incl. 7th-digit century rule); **no modulus-11** | Mod-11 is not valid for CPRs issued after 2007. |
| D12 | `ZSAN_PASS2=required` by default; `off` permitted but logged loudly at startup | Lets the GDPR owner measure Presidio-only vs. both on fixtures without a code fork. |

## 3. Architecture

```
 Developer laptop                          VM  (Standard_D4as_v5, Ubuntu 24.04)
┌──────────────────┐   HTTPS + bearer    ┌──────────────────────────────────────────────┐
│ Claude Code      │────────────────────▶│ sanitizer-proxy  (Bun, Streamable HTTP MCP)  │
│  .mcp.json →     │◀────────────────────│   │ tool policy · field policy · sanitize core│
│  https://vm/mcp  │  sanitized results  │   │ stdio (child process, clean env)          │
└──────────────────┘                     │   ▼                                          │
                                         │ @sshadows/zendesk-mcp-server ──▶ Zendesk API  │
                                         │                                              │
                                         │ docker compose (internal network only):     │
                                         │   presidio-analyzer   (digest-pinned)        │
                                         │   presidio-anonymizer (digest-pinned, opt.)  │
                                         │   gliner-pii sidecar  (own image, pinned)    │
                                         │   [ollama — optional alternative detector]   │
                                         └──────────────────────────────────────────────┘
```

- Sidecars listen on the VM's loopback / docker network only; nothing but the proxy reaches
  them. The proxy is the only port exposed (443 via a reverse proxy — Caddy or nginx — that
  terminates TLS).
- **Two supported deployment modes**, same code, same sidecars, same config:
  - **VM mode** (above): proxy over Streamable HTTP on a dedicated VM; Zendesk credentials
    exist only on the VM. This is the mode that delivers guarantee 2 in full.
  - **Laptop mode**: `docker compose --profile laptop up` (Presidio + GLiNER, no Caddy) and the
    proxy run locally over **stdio**, registered in `.mcp.json` with `command`. Zendesk
    credentials then live in the developer's environment; guarantee 2 weakens to "the proxy is
    the only configured path" (equivalent to today's exposure). The sanitization guarantee is
    unchanged. Fits a 16 GB laptop (~5–6 GB with Docker Desktop overhead).
  Both modes are documented in the README and exercised in CI; the startup check against the
  pinned GLiNER model id catches sidecar version drift between laptops.
- The presidio-anonymizer container is included for parity with the spec, but placeholder
  application is done in TypeScript (see §6.4) so both passes share one replacement engine.
  The anonymizer is therefore optional and may be dropped in build step 2 if it adds nothing.

### 3.1 Data flow for one `get_ticket` call

1. Claude Code → `tools/call get_ticket {id}` over HTTPS with bearer token.
2. **Tool policy**: `get_ticket` is on the allowlist → forward. (A blocked tool returns an MCP
   error `tool not available` and is never forwarded.)
3. **Upstream**: proxy forwards the call to the child process over stdio, receives
   `content:[{type:"text", text:"<pretty JSON>"}]`.
4. **Decode**: strip any known prefix (`"Ticket updated successfully!\n\n"` etc.), parse JSON.
   If parsing fails, treat the whole text as one free-text field.
5. **Field policy** (`src/zendesk/fieldPolicy.ts`): walk the object, applying per-path rules —
   `drop`, `sanitize`, `keep` (§7). Every `sanitize` field is collected as a text chunk with
   its JSON path and a role hint.
6. **Sanitize core** (`src/sanitize/`), one `SanitizeSession` per tool call:
   1. language detection per chunk;
   2. pass 1 — Presidio analyze → entity spans;
   3. pass 2 — `SpanDetector.detect()` on the **pass-1 output** → more spans;
   4. spans → placeholders via the shared per-session table; replacement applied in TypeScript.
7. **Encode**: write sanitized values back to their paths, re-serialize with the same
   formatting, restore the prefix.
8. **Log**: `ticket 12345: PERSON 3, EMAIL 2, CPR 1, ORG 1 (pass1 5, pass2 2) 412ms`.
9. Return to Claude Code.

Any exception in steps 4–7 → MCP error with a generic message and an `errorCode`; nothing
from the payload is included.

### 3.2 Outgoing direction (`add_ticket_comment`)

1. Argument `type` is forced to `"internal"`. A request with `type: "public"` is rejected with
   an error explaining that the proxy only writes internal notes.
2. `body` is scanned for the placeholder grammar `\[(PERSON|ORG|EMAIL|PHONE|CPR|IBAN|CARD|ADDRESS|USERNAME|OTHER)_\d+\]`.
   Any match → reject; the comment is not forwarded. (Claude cannot know the real value
   behind a placeholder, so a leaked token is always a mistake.)
3. `author_id` is stripped (upstream defaults to the API user).
4. The upstream response is sanitized like any other.

## 4. Components

```
src/
├── server/
│   ├── http.ts            # Streamable HTTP MCP server, bearer auth, TLS behind reverse proxy
│   ├── stdio.ts           # stdio entry point (dev/test)
│   └── proxy.ts           # MCP passthrough: tools/list rewrite, tools/call interception
├── upstream/
│   ├── child.ts           # spawn @sshadows/zendesk-mcp-server with clean env + cwd, stderr capture
│   └── client.ts          # MCP client over stdio to the child
├── policy/
│   ├── toolPolicy.ts      # allowlist, argument rewriting (force internal), outgoing inspection
│   └── fieldPolicy.ts     # Zendesk JSON path rules: drop / sanitize / keep
├── sanitize/              # standalone, transport-agnostic, reused by RAG ingestion
│   ├── index.ts           # SanitizeSession, sanitizeTexts(chunks) → results + counts
│   ├── types.ts           # Span, EntityType, Chunk, SanitizeResult, SpanDetector interface
│   ├── language.ts        # per-chunk language detection (da|en|de, fallback en)
│   ├── presidio.ts        # pass 1 client (analyzer REST), ad-hoc recognizers, allowlist filter
│   ├── detectors/
│   │   ├── gliner.ts      # pass 2: GLiNER sidecar client (primary)
│   │   └── ollama.ts      # pass 2: LLM detector with JSON span validation (alternative)
│   ├── placeholders.ts    # per-session value table, numbering, word-subset unification
│   ├── replace.ts         # apply spans → text (overlap resolution, longest-first)
│   └── chunking.ts        # split over-cap texts on paragraph boundaries
├── logging.ts             # counts-only logger; redaction guard on every log line
└── config.ts              # Zod schema for ZSAN_* env
```

### 4.1 Key interfaces

```ts
type EntityType =
  | 'PERSON' | 'ORG' | 'EMAIL' | 'PHONE' | 'CPR' | 'IBAN' | 'CARD'
  | 'ADDRESS' | 'USERNAME' | 'OTHER';

interface Span { start: number; end: number; type: EntityType; score: number; source: 'presidio' | 'gliner' | 'ollama' }

interface Chunk { id: string; text: string; lang?: 'da' | 'en' | 'de' }

interface SpanDetector {
  readonly name: string;
  detect(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]>;
}

interface Pass1Client {            // Presidio
  analyze(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]>;
}

class SanitizeSession {
  constructor(deps: { pass1: Pass1Client; pass2: SpanDetector | null; allowlist: Allowlist; clock: Clock; timeouts: Timeouts });
  sanitize(chunks: Chunk[]): Promise<{ texts: Map<string, string>; counts: Record<EntityType, number>; perPass: { pass1: number; pass2: number } }>;
}
```

`SanitizeSession` owns the placeholder table; one session per tool call (or per ticket in the
ingestion job). All external clients are injected so unit tests use fakes.

### 4.2 GLiNER sidecar

Small Python service (`sidecars/gliner/`): FastAPI + `gliner`, model pinned by Hugging Face
repo **and revision hash**, loaded once at startup, CPU-only, one endpoint:

```
POST /detect  { "text": "...", "labels": ["person","organization","street address","username","phone number","email"], "threshold": 0.4 }
→ { "spans": [ { "start": 12, "end": 26, "label": "person", "score": 0.91 } ] }
```

Label set and threshold live in `config/gliner.json` (CODEOWNERS). The label→`EntityType` map
is in `detectors/gliner.ts`. Health endpoint `/healthz` returns the model id + revision so the
proxy can refuse to start against an unexpected model.

## 5. Tool policy

| Tool | Policy |
|---|---|
| `get_ticket`, `get_ticket_comments`, `search`, `list_tickets`, `support_info` | forward, sanitize response |
| `get_ticket_attachments` | forward; `content_url` dropped, `file_name` sanitized |
| `get_organization`, `list_organizations` | forward, sanitize (org names → `[ORG_n]` unless allowlisted; contact fields dropped) |
| `add_ticket_comment` | forward with `type` forced to `internal`, body placeholder scan, `author_id` stripped |
| `analyze_ticket_images`, `analyze_ticket_documents`, `get_document_summary` | **blocked** — send raw attachments to Anthropic API / `converter.sshadows.dk` |
| `get_user`, `list_users` | **blocked** — response is PII by definition |
| all `create_*`, `update_*`, `delete_*`, `create_ticket`, `update_ticket`, `delete_ticket` | **blocked** |
| everything else (macros, triggers, automations, views, articles, groups, talk, chat) | **blocked** |

`tools/list` is rewritten to contain only forwarded tools, with the upstream descriptions
passed through unchanged except for `add_ticket_comment`, whose description is amended to say
it writes internal notes only. The allowlist is code (`toolPolicy.ts`), not config, so
widening it requires a PR and the e2e suite.

`search` note: the query string is authored by Claude and goes *to* Zendesk, not from it; no
inbound-PII concern. Search results are ticket/organization objects and go through the field
policy; a `type:user` search returns user objects, which the field policy reduces to `id` only.

## 6. Sanitization core

### 6.1 Entity types and placeholders

| Entity | Placeholder | Found by |
|---|---|---|
| Person name | `[PERSON_n]` | Presidio NER (da/en/de), GLiNER |
| Organization | `[ORG_n]` | Presidio NER, GLiNER; allowlist exempt |
| Email | `[EMAIL_n]` | Presidio pattern |
| Phone | `[PHONE_n]` | Presidio pattern, regions DK/DE/GB/US |
| Danish CPR | `[CPR_n]` | custom recognizer |
| IBAN | `[IBAN_n]` | Presidio |
| Card number | `[CARD_n]` | Presidio |
| Street address | `[ADDRESS_n]` | GLiNER |
| Username / handle | `[USERNAME_n]` | GLiNER |
| Other identifier | `[OTHER_n]` | GLiNER / Ollama |

Numbering is per session, in order of first appearance in the sanitized output; the same
normalized value (trim, case-fold, collapse whitespace) always maps to the same placeholder.

### 6.2 Allowlist

`config/allowlist.txt`: one term per line, `#` comments. Matching is case-insensitive on the
full span text. A span whose text is allowlisted, or whose text is a word-subset of an
allowlisted multi-word term ("Document Capture" ⊂ "Continia Document Capture"), is dropped
regardless of type or source. Initial contents: Continia, Continia Software, Document Capture,
Expense Management, Payment Management, Business Central, Dynamics 365, Dynamics NAV,
Microsoft, Azure, Zendesk, OneDrive, SharePoint, Outlook. Owned by the GDPR owner via
CODEOWNERS. A word-subset match additionally requires the span to have at least two words, or
to be a single word of at least four alphabetic characters; and a detected span that overlaps
an allowlisted occurrence is split around it, so the allowlisted text always survives.

### 6.3 Unification (D6)

Pass 2 runs on pass-1 output (placeholders already present). For each pass-2 span:

1. Skip if it overlaps an existing placeholder token.
2. Normalize the text. If an entry of the **same type** exists whose normalized value equals it
   → reuse.
3. Else, if the span's words are a subset of an existing same-type entry's words (each word
   ≥ 2 characters; "Mette" ⊂ "Mette Sørensen") → reuse that placeholder.
4. Else allocate the next number.

Known false-merge risk (two different people sharing a first name) is accepted; the reverse
(under-merging) is what (b) would have produced and was rejected.

### 6.4 Replacement

Spans from both sources are merged per chunk; overlapping spans resolve longest-first, ties by
higher score, then Presidio before GLiNER. Replacement is applied right-to-left on the original
string so offsets stay valid. The engine is the same for both passes.

### 6.5 Language detection

Per chunk, a small n-gram detector restricted to `{da, en, de}`; texts under 20 characters or
with low confidence default to `en` for NER but still run all pattern recognizers (which are
registered for all three languages). Presidio is called with `language: <lang>`.

### 6.6 Presidio configuration (`config/presidio-analyzer.yml`)

- `nlp_engine_name: spacy`, models: `da_core_news_lg`, `en_core_web_lg`, `de_core_news_lg`,
  versions pinned in the analyzer Dockerfile layer (models are downloaded at image build, not
  at runtime).
- Recognizer registry: Email, Phone (DK/DE/GB/US), IBAN, CreditCard, SpacyRecognizer, each with
  `supported_languages: [da, en, de]`.
- CPR recognizer: `\b(\d{2})(\d{2})(\d{2})-?(\d{4})\b`; validation in the proxy (not in the
  Presidio regex): DD 01–31, MM 01–12, YY with century from the 7th digit per the CPR rules,
  and the date must exist. Delivered as an `ad_hoc_recognizers` entry on each request so the
  pattern is versioned in `config/recognizers/cpr.json` alongside the tests.
- Score threshold 0.4 for NER, 0.7 for patterns, in config.

### 6.7 Chunking

One chunk per free-text field (subject, description, each comment body, each custom field
value, each attachment filename). Chunks above `ZSAN_CHUNK_MAX_CHARS` (default 6,000) are
split at paragraph boundaries, falling back to sentence boundaries. Chunks of one tool call
are processed with bounded concurrency (`ZSAN_CONCURRENCY`, default 4) against both sidecars.

### 6.8 Alternative detector: Ollama

`detectors/ollama.ts` keeps the LLM path from the initial spec: `/api/chat`, `temperature 0`,
`format: "json"`, prompt from `config/prompt.md`, response `[{text, type}]`, every `text`
validated as an exact substring and mapped to offsets (all occurrences), anything else
discarded. Selected via `ZSAN_PASS2_DETECTOR=ollama`. Not deployed on the D4as_v5; exists so
the fixture suite can compare detectors and so a GPU host can switch without code changes.

## 7. Zendesk field policy

Rules are JSON-path patterns evaluated on the parsed upstream payload. Unknown string fields
default to **sanitize** (fail safe); unknown non-string fields are kept.

| Path (glob) | Rule |
|---|---|
| `**.requester`, `**.submitter`, `**.assignee`, `**.collaborators`, `**.email_ccs`, `**.followers` (objects) | reduce to `{ id }` |
| `**.requester_id`, `**.submitter_id`, `**.assignee_id`, `**.author_id`, `**.organization_id`, `**.group_id`, `**.id`, `**.ticket_id`, `**.comment_id` | keep (opaque numeric ids) |
| `**.via.source.from`, `**.via.source.to` | drop |
| `**.subject`, `**.raw_subject`, `**.description` | sanitize |
| `**.comments[*].body`, `**.comments[*].plain_body` | sanitize |
| `**.comments[*].html_body` | drop (Claude does not need it; avoids sanitizing HTML) |
| `**.custom_fields[*].value`, `**.named_custom_fields.*` (strings) | sanitize |
| `**.attachments[*].file_name`, `**.thumbnails[*].file_name` | sanitize |
| `**.attachments[*].content_url`, `**.thumbnails[*].content_url`, `**.mapped_content_url` | drop |
| `**.tags[*]` | sanitize (tags sometimes contain customer names) |
| `**.satisfaction_rating.comment` | sanitize |
| `**.metadata.system.client`, `**.metadata.system.ip_address`, `**.metadata.system.location`, `**.metadata.system.latitude/longitude` | drop |
| organization objects: `**.name` | sanitize (→ `[ORG_n]` unless allowlisted) |
| organization objects: `**.domain_names`, `**.details`, `**.notes`, `**.external_id` | drop |
| user objects (inside search results) | reduce to `{ id }` |
| `**.url`, `**.next_page`, `**.previous_page` | keep (API URLs contain only ids) |

Error payloads from upstream (`isError: true`, `validationDetails`, embedded Zendesk response
bodies) are sanitized as free text; if that fails, they are replaced by a generic error.

## 8. Fail-closed error handling

| Condition | Result |
|---|---|
| Presidio unreachable / non-2xx / timeout (`ZSAN_PRESIDIO_TIMEOUT_MS`, 15 s) | MCP error `SANITIZER_UNAVAILABLE` |
| GLiNER unreachable / timeout (`ZSAN_PASS2_TIMEOUT_MS`, 20 s) while `ZSAN_PASS2=required` | MCP error `SANITIZER_UNAVAILABLE` |
| GLiNER `/healthz` model id ≠ pinned id at startup | proxy refuses to start |
| Span with out-of-range offsets, or Ollama span not found in text | span discarded; if > 20 % of spans discarded in one chunk → MCP error `SANITIZER_INVALID_OUTPUT` |
| Field policy walk throws (unexpected shape) | MCP error `SANITIZER_INTERNAL` |
| Upstream child exits | proxy restarts it once with back-off; in-flight calls return `UPSTREAM_UNAVAILABLE` |
| Any error path | message is static text + code; no payload fragments |

No partial results: a tool call is either fully sanitized or an error.

## 9. Configuration (`ZSAN_*`)

```
# upstream (only on the VM)
ZSAN_ZENDESK_SUBDOMAIN=        ZSAN_ZENDESK_EMAIL=        ZSAN_ZENDESK_API_TOKEN=
ZSAN_UPSTREAM_COMMAND=npx -y @sshadows/zendesk-mcp-server@1.4.1

# transport
ZSAN_TRANSPORT=http|stdio      ZSAN_HTTP_PORT=8080
ZSAN_CLIENT_TOKENS=<name>:<token>,<name>:<token>     # per-developer bearer tokens

# sidecars
ZSAN_PRESIDIO_URL=http://presidio-analyzer:3000
ZSAN_PASS2=required|off        ZSAN_PASS2_DETECTOR=gliner|ollama
ZSAN_GLINER_URL=http://gliner:8000    ZSAN_GLINER_MODEL_ID=<hf repo>@<revision>
ZSAN_OLLAMA_URL=               ZSAN_OLLAMA_MODEL=

# tuning
ZSAN_PRESIDIO_TIMEOUT_MS=15000 ZSAN_PASS2_TIMEOUT_MS=20000
ZSAN_CHUNK_MAX_CHARS=6000      ZSAN_CONCURRENCY=4
ZSAN_LOG_LEVEL=info
```

Validated with Zod at startup; the child process receives the `ZENDESK_*` trio, `PATH`, and the
MCP SDK's fixed safe-inherit list (HOME/TEMP/USERPROFILE-class variables, never the proxy's own
env), with `cwd` set to an empty directory so upstream's `dotenv.config()` cannot pick up a
stray `.env`. Upstream stderr is captured and logged at debug level after passing through the
same redaction guard as the proxy's own logs (it prints the connected user's name and email at
startup).

`.mcp.json`, VM mode:

```json
{ "mcpServers": { "zendesk": { "type": "http", "url": "https://<vm>/mcp",
    "headers": { "Authorization": "Bearer ${ZSAN_TOKEN}" } } } }
```

`.mcp.json`, laptop mode (credentials come from the developer's `.env`, loaded by the proxy —
never from `.mcp.json`). Claude Code runs MCP servers with `cwd` set to the user's project, not
this repo, so `bun run` won't find a `.env` here by itself — pass it explicitly with
`--env-file`:

```json
{ "mcpServers": { "zendesk": { "type": "stdio", "command": "bun", "args": [
    "run", "--env-file=C:/GeneralDev/DevOpsPullers/ZendeskSanitizing/.env",
    "C:/GeneralDev/DevOpsPullers/ZendeskSanitizing/src/server/stdio.ts"
] } } }
```

## 10. Logging

One line per tool call: tool name, ticket id(s) if present in the arguments, per-type
redaction counts, per-pass counts, duration, and status. A redaction guard runs on every log
line and replaces anything matching the email/CPR/IBAN patterns with `<redacted>` as a
last-resort safety net; if it fires, a warning counter increments (it indicates a bug).

## 11. Testing

Test-driven throughout (per `CLAUDE.md`). `tests/` mirrors `src/`.

**Unit (every PR, `bun test`)** — no network:
- `placeholders`: numbering, normalization, word-subset unification, type isolation.
- `replace`: overlap resolution, right-to-left application, placeholder-token skipping.
- `presidio`: request construction (language, ad-hoc CPR), response mapping, allowlist filter,
  timeout → typed error. Recorded responses as fixtures.
- `detectors/gliner`, `detectors/ollama`: response mapping, offset/substring validation, the
  20 % discard threshold.
- `cpr`: date validation table (valid dates, 31 Feb, century digit, with/without hyphen).
- `language`: sample sentences per language, short-text fallback.
- `fieldPolicy`: a recorded `get_ticket` payload (synthetic) → expected drops/sanitizes/keeps;
  unknown string field defaults to sanitize.
- `toolPolicy`: allowlist, `tools/list` rewrite, `add_ticket_comment` forcing/rejection.
- `proxy`: fake upstream + fake sanitizer; every error path returns an error without payload
  fragments (assert the raw fixture text does not appear anywhere in the response).

**Contract (nightly / on sidecar change)** — real containers, no Zendesk:
- Analyzer boots with the three models; each recognizer fires for each language.
- GLiNER `/healthz` reports the pinned revision; `/detect` returns valid offsets.

**E2E regression (pre-release gate, self-hosted runner on the VM)**:
- `tests/fixtures/tickets/*.json`: synthetic tickets — invented Danish/German/English names,
  date-valid fake CPRs, fabricated IBANs, addresses, usernames, signatures, allowlisted product
  names that must survive, and contextual cases Presidio cannot catch. Each fixture carries an
  `expected` block: the set of strings that must be absent from the output and the set that
  must be present.
- Run through the full stack with a fake upstream that serves the fixture; assert zero leaks
  and zero over-redaction of allowlisted terms.
- The same run emits a **scorecard** (recall per entity type, per language, per detector) so
  swapping `ZSAN_PASS2_DETECTOR` or the GLiNER model is a measured decision.

## 12. Pinning, versioning, governance

- `docker-compose.yml` pins `presidio-analyzer` and `presidio-anonymizer` by `@sha256` digest;
  the GLiNER sidecar image is built from a Dockerfile with pinned `gliner`, `torch`, and model
  revision, and tagged with the repo version.
- spaCy model versions pinned in the analyzer Dockerfile.
- Releases tagged `v0.x.y`; the proxy reports its version and the sidecar identities in
  `support_info`-style startup logs.
- Private repo, branch protection on `main`, PR review required, CODEOWNERS for `config/**`
  (allowlist, recognizers, GLiNER labels/threshold, prompt) → GDPR owner.
- Changes to anything in `config/`, the field policy, the tool policy, or a sidecar version
  require a green e2e run before tagging.

## 13. Repository layout

```
ZendeskSanitizing/
├── src/                     (see §4)
├── sidecars/gliner/         Dockerfile, app.py, requirements.txt (pinned)
├── sidecars/presidio/       Dockerfile (analyzer + 3 spaCy models), analyzer.yml
├── config/
│   ├── allowlist.txt
│   ├── recognizers/cpr.json
│   ├── gliner.json          labels, threshold, label→EntityType map
│   └── prompt.md            Ollama alternative detector prompt
├── deploy/
│   ├── docker-compose.yml   proxy + sidecars, digest-pinned
│   ├── Caddyfile            TLS termination → proxy
│   └── vm-setup.sh          Ubuntu 24.04: docker, compose, bun, firewall, auto-shutdown note
├── tests/                   mirrors src/, plus fixtures/ and e2e/
├── docs/superpowers/specs/  this document
├── .env.example
├── .github/workflows/ci.yml unit on every PR; contract + e2e on self-hosted runner
├── CLAUDE.md
└── package.json / tsconfig.json / bun.lock
```

## 14. Build order

1. **Passthrough proxy** (stdio and HTTP), upstream child with clean env, tool allowlist,
   `tools/list` rewrite, fake-upstream tests. No sanitization yet; verify round-trip against
   the real upstream from the test harness.
2. **Sanitize core skeleton**: types, `SanitizeSession`, placeholders, replace, chunking — all
   unit-tested with fakes. Presidio client against recorded responses.
3. **Presidio sidecar** with da/en/de models and CPR recognizer; contract tests; first
   fixtures; field policy wired into the proxy; fail-closed paths; logging with redaction guard.
4. **GLiNER sidecar** and detector; unification across passes; fixture scorecard; e2e suite
   green with both passes.
5. **Outgoing**: `add_ticket_comment` forcing and placeholder rejection.
6. **Deploy**: laptop mode (compose `laptop` profile, README walkthrough, stdio `.mcp.json`)
   and VM mode (setup script, compose `vm` profile with Caddy, bearer tokens, HTTP
   `.mcp.json`); CI with self-hosted runner; branch protection, CODEOWNERS; `v0.1.0`.
7. **Bake-off** (optional, after v0.1.0): Ollama detector against the same fixtures to
   quantify the indirect-identifier gap and decide whether a GPU host is warranted.

## 15. Out of scope for v1

- Cross-ticket pseudonyms (HMAC) — explicitly deferred; the key would be a re-identification key.
- The Azure AI Search ingestion job itself (it consumes `src/sanitize/`, lives elsewhere).
- Public replies, ticket creation/updates, user/org management.
- OAuth for the HTTP transport (static per-developer tokens in v1).
- Attachment *content* sanitization (only filenames; `content_url` is dropped).

## 16. Open items to verify during build

- GLiNER multilingual PII recall on **Danish** (base model saw Danish in pretraining; unproven
  for PII spans). Build step 4's scorecard answers this; fallback is a Danish-heavier label set
  or the Ollama detector on a GPU host.
- Whether `presidio-anonymizer` earns its place once TypeScript replacement exists (decide in
  step 2/3).
- Exact memory footprint of three `lg` spaCy models in one analyzer process on the D4as_v5
  (expect ~3 GB; if higher, drop `de` to `md`).
- Claude Code HTTP MCP: **install-time verification step** — before relying on the `.mcp.json`
  form in the README's VM mode section, confirm `headers` with `${ENV}` interpolation actually
  works in `.mcp.json` on the developer's installed Claude Code version; if it doesn't, fall
  back to `claude mcp add --transport http --header` (also documented in the README).

## Changes from the initial spec

- Pass 2 is GLiNER (encoder) by default; the Ollama LLM is an alternative detector.
- Transport to Claude Code is Streamable HTTP from a dedicated VM instead of a local stdio
  binary; stdio kept for dev/test.
- Tool surface is a read-only allowlist plus internal-only `add_ticket_comment`; upstream's
  attachment-analysis tools are blocked as third-party side channels (not in the original spec).
- Languages are da/en/de, not Danish only.
- `[PERSON_n]` replaces `[CUSTOMER_n]`; all persons and non-allowlisted orgs are redacted.
- Runtime is Bun; `tests/` not `test/`; repo root is the project root.
- CPR validation is date-based only (no modulus-11).
