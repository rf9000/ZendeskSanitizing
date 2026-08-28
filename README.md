# ZendeskSanitizing

An MCP proxy that Claude Code registers *as* `zendesk`. It forwards a restricted, read-only
set of tool calls to the real Zendesk MCP server (`@sshadows/zendesk-mcp-server`), intercepts
every response, and removes personal data in two passes before anything reaches Claude Code.
Claude Code — and the developer laptop it runs on — never sees raw ticket data and never
holds Zendesk credentials directly in a client config.

**Fail-closed guarantee:** if either sanitization pass is unreachable, times out, or returns
an invalid result, the tool call returns an MCP error. The raw payload is never returned as a
fallback — an error beats a leak, always.

## Laptop mode

This is the only mode this plan implements. VM mode (below) ships in Plan 2.

**Prerequisites:** Bun ≥ 1.3, Docker Desktop.

1. Copy the env template and fill in your Zendesk credentials:
   ```sh
   cp .env.example .env
   # edit .env: ZSAN_ZENDESK_SUBDOMAIN, ZSAN_ZENDESK_EMAIL, ZSAN_ZENDESK_API_TOKEN
   ```
2. Start the Presidio sidecar (analyzer only, laptop profile):
   ```sh
   docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build
   ```
   Config under `sidecars/presidio/` is baked into the image — re-run this command after
   editing it. `config/recognizers/*.json` and `config/allowlist.txt` are read by the proxy
   process at runtime, so changes there need no rebuild.
3. Smoke test the proxy on its own (pass 2 doesn't exist yet in this plan, so it must be
   turned off explicitly — `ZSAN_PASS2=required`, the default, exits with an error):
   ```sh
   ZSAN_PASS2=off bun run start
   ```
   You should see a loud "pass 2 disabled" warning followed by "ready" on stderr.
4. Register the proxy in Claude Code's `.mcp.json`, over stdio:
   ```json
   { "mcpServers": { "zendesk": { "type": "stdio", "command": "bun", "args": ["run", "C:/GeneralDev/DevOpsPullers/ZendeskSanitizing/src/server/stdio.ts"] } } }
   ```

**Single-registration rule:** before adding this, remove any existing raw `zendesk` MCP entry
from every `.mcp.json` and from `~/.claude.json`. Only one `zendesk` MCP server may be
registered at a time — if the real, unsanitized Zendesk server is still registered anywhere
Claude Code reads config from, this proxy provides no protection at all.

## VM mode

Delivered in Plan 2: the proxy runs on a dedicated VM over Streamable HTTP with bearer
tokens, so Zendesk credentials never touch a developer laptop. See spec §3 for the full
design (`docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md`).

## Tools exposed

Only these 8 read-only tools are forwarded; everything else is blocked before it reaches
upstream and never appears in `tools/list`:

| Tool | Purpose |
|---|---|
| `get_ticket` | Fetch one ticket |
| `get_ticket_comments` | Fetch a ticket's comment thread |
| `search` | Search tickets/users/organizations |
| `list_tickets` | List tickets |
| `get_ticket_attachments` | List a ticket's attachment metadata |
| `get_organization` | Fetch one organization |
| `list_organizations` | List organizations |
| `support_info` | Zendesk instance metadata |

Blocked categories and why:

- **Attachment/document analysis tools** (`analyze_ticket_images`, `analyze_ticket_documents`,
  `get_document_summary`) — they ship ticket content to the Anthropic API and a third-party
  converter, outside this proxy's control.
- **All create/update/delete tools** — this proxy is read-only by design; no ticket mutation
  path exists yet (`add_ticket_comment` is scoped for Plan 2, with outgoing inspection).
- **`get_user` / `list_users`** — the response is PII by definition.

## Testing

- `bun test` — unit suite, no network required.
- `bun run test:contract` — needs Presidio up (`docker compose ... --profile laptop up`).
- `bun run test:e2e` — the fixture regression gate (`tests/fixtures/tickets/`); needs Presidio
  up. Prints a scorecard of leaked/over-redacted strings per fixture on failure.

## Configuration

All variables are `ZSAN_*`, validated with Zod at startup (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `ZSAN_ZENDESK_SUBDOMAIN` | *(required)* | Zendesk subdomain |
| `ZSAN_ZENDESK_EMAIL` | *(required)* | Zendesk API auth email |
| `ZSAN_ZENDESK_API_TOKEN` | *(required)* | Zendesk API token |
| `ZSAN_UPSTREAM_COMMAND` | `npx -y @sshadows/zendesk-mcp-server@1.4.1` | Command spawned as the upstream MCP child |
| `ZSAN_PRESIDIO_URL` | `http://127.0.0.1:5002` | Presidio analyzer base URL |
| `ZSAN_PASS2` | `required` | `required` \| `off` — `off` is logged loudly at startup |
| `ZSAN_PASS2_DETECTOR` | `gliner` | `gliner` \| `ollama` (Plan 2) |
| `ZSAN_GLINER_URL` | *(unset)* | GLiNER sidecar URL (Plan 2) |
| `ZSAN_PRESIDIO_TIMEOUT_MS` | `15000` | Pass-1 call timeout |
| `ZSAN_PASS2_TIMEOUT_MS` | `20000` | Pass-2 call timeout |
| `ZSAN_CHUNK_MAX_CHARS` | `6000` | Max characters per text chunk sent to a detector |
| `ZSAN_CONCURRENCY` | `4` | Max concurrent detector calls per tool result |
| `ZSAN_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ZSAN_ALLOWLIST_PATH` | `config/allowlist.txt` | Terms that must never be redacted |
| `ZSAN_RECOGNIZERS_PATH` | `config/recognizers` | Ad-hoc Presidio recognizer definitions |

## Logging

Every tool call logs one line to stderr with entity **counts only** — never values:

```
[info] get_ticket 4711: PERSON 3, ORG 1, EMAIL 1, PHONE 1 (pass1 4, pass2 2) 812ms
```

A redaction guard also scans every log line for email/CPR/IBAN-shaped substrings and masks
them before they're written, as a defense-in-depth backstop against a bug that accidentally
formats raw PII into a log message.
