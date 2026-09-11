# ZendeskSanitizing

An MCP proxy that Claude Code registers *as* `zendesk`. It forwards a restricted, read-only
set of tool calls to the real Zendesk MCP server (`@sshadows/zendesk-mcp-server`), intercepts
every response, and removes personal data in two passes before anything reaches Claude Code.
Claude Code — and the developer laptop it runs on — never sees raw ticket data and never
holds Zendesk credentials directly in a client config.

**Fail-closed guarantee:** if either sanitization pass is unreachable, times out, or returns
an invalid result, the tool call returns an MCP error. The raw payload is never returned as a
fallback — an error beats a leak, always.

> Explaining this to someone? [`docs/overview.md`](docs/overview.md) is the plain-language
> summary: what is removed, what is kept, how it works, and where it is imperfect.

## Laptop mode

**Prerequisites:** Bun ≥ 1.3, Docker Desktop.

1. Copy the env template and fill in your Zendesk credentials:
   ```sh
   cp .env.example .env
   # edit .env: ZSAN_ZENDESK_SUBDOMAIN, ZSAN_ZENDESK_EMAIL, ZSAN_ZENDESK_API_TOKEN
   ```
   `.env.example` already has `ZSAN_PASS2=required` — leave it as-is; that's the two-pass,
   GLiNER-backed mode this plan implements. Use `ZSAN_PASS2=off` only for a deliberate
   Presidio-only run (e.g. the GLiNER sidecar is down and you accept reduced coverage).
2. Start both sidecars (Presidio analyzer + GLiNER, laptop profile):
   ```sh
   docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build
   ```
   Config under `config/presidio/` and `sidecars/gliner/` is baked into their images —
   re-run this command after editing either. `config/recognizers/*.json`, `config/allowlist.txt`,
   and `config/gliner.json` are read by the proxy process at runtime, so changes there need no
   rebuild. See `config/README.md` for an index of every tuning knob and what to run after
   changing it.
3. Smoke test the proxy on its own (with `ZSAN_PASS2=required` from step 1, both sidecars up):
   ```sh
   bun run start
   ```
   You should see a `pass2=gliner verified against …` line followed by "ready" on stderr. To
   run Presidio-only instead, use `ZSAN_PASS2=off bun run start`.
4. Register the proxy in Claude Code's `.mcp.json`, over stdio. Claude Code runs MCP servers
   with `cwd` set to *your project*, not this repo, so `bun run` won't find a `.env` here by
   itself — pass it explicitly with `--env-file`:
   ```json
   { "mcpServers": { "zendesk": { "type": "stdio", "command": "bun", "args": [
       "run", "--env-file=C:/GeneralDev/DevOpsPullers/ZendeskSanitizing/.env",
       "C:/GeneralDev/DevOpsPullers/ZendeskSanitizing/src/server/stdio.ts"
   ] } } }
   ```

**Single-registration rule:** before adding this, remove any existing raw `zendesk` MCP entry
from every `.mcp.json` and from `~/.claude.json`. Only one `zendesk` MCP server may be
registered at a time — if the real, unsanitized Zendesk server is still registered anywhere
Claude Code reads config from, this proxy provides no protection at all.

**What the upstream child's env actually contains:** the proxy spawns the real Zendesk MCP
server with the `ZENDESK_*` trio, `PATH`, and the MCP SDK's fixed safe-inherit list
(HOME/TEMP/USERPROFILE-class variables the SDK always adds, never the proxy's own env) —
never this proxy's `ZSAN_*` variables or secrets such as `ANTHROPIC_API_KEY`.

## VM mode

The proxy runs on a dedicated VM over Streamable HTTP with per-developer bearer tokens, so
Zendesk credentials never touch a developer laptop. See spec §3 for the full design
(`docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md`).

**Security upgrade over laptop mode:** in VM mode, Zendesk credentials (`ZSAN_ZENDESK_*`)
exist only in `/opt/zsan/.env` on the VM — never on a developer laptop, never in a client
config, and never baked into the container image. Developers hold only a per-person bearer
token that authenticates to the proxy's `/mcp` endpoint; the proxy still enforces the same
tool allowlist and two-pass sanitization as laptop mode.

**Prerequisites:** an Ubuntu 24.04 VM with a sudo-capable user and outbound internet access.
A public DNS name pointed at the VM is optional — without one, Caddy falls back to a
self-signed `localhost` certificate (fine for a lab VM, not for real developer use). The first
build compiles the Presidio and GLiNER sidecar images too (not just the proxy), so budget
≥8 GB RAM and roughly 10 minutes plus model-download time for `docker compose ... up --build`
the first time.

**Setup:**

1. Clone this repo onto the VM, e.g. into `/opt/zsan/app`. (Ubuntu images on Azure ship `git`
   preinstalled; if yours doesn't, `sudo apt-get install -y git` first.)
2. From `/opt/zsan/app`, run `bash deploy/vm-setup.sh` (review it first — it installs Docker
   Engine, opens SSH + 80 + 443 in `ufw`, and creates `/opt/zsan`). Running it via `bash
   deploy/vm-setup.sh` means the file's executable bit doesn't matter. **After it finishes, log
   out and back in (or run `newgrp docker`)** — group membership changes from `usermod -aG
   docker` only take effect in a new login session, so `docker ...` commands will fail with a
   permission error until you do.
3. Create `/opt/zsan/.env` with `ZSAN_ZENDESK_SUBDOMAIN`/`_EMAIL`/`_API_TOKEN`,
   `ZSAN_CLIENT_TOKENS` (`name:token,name:token`, each token at least 16 characters), and
   `ZSAN_PASS2=required`. This file is read only via compose `env_file` — it is never baked
   into the proxy image.
4. `export ZSAN_DOMAIN=<your-dns-name>` (or leave unset to use the self-signed `localhost`
   cert) — Caddy needs this both to request the right certificate and to know which host to
   answer for; it's passed through to the `caddy` service via compose `environment`.
5. From `/opt/zsan/app`:
   ```sh
   docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile vm up -d --build
   ```
6. Verify: `curl -k https://localhost/healthz` (or `https://<your-dns-name>/healthz` with a
   real domain) should return `{"status":"ok"}`.

**Developer-side `.mcp.json`** (registers the VM proxy over HTTP instead of spawning it
locally):

```json
{ "mcpServers": { "zendesk": { "type": "http", "url": "https://<vm-dns>/mcp",
    "headers": { "Authorization": "Bearer ${ZSAN_TOKEN}" } } } }
```

Before relying on this form, verify that `${ZSAN_TOKEN}`-style env interpolation in
`.mcp.json` `headers` actually works on your installed Claude Code version (spec §16 — this
is an install-time check, not an assumption). If it doesn't, register the server directly
instead:

```sh
claude mcp add --transport http zendesk https://<vm>/mcp --header "Authorization: Bearer <token>"
```

Each developer gets their own `name:token` entry in the VM's `ZSAN_CLIENT_TOKENS` — tokens
are per-developer bearer credentials, not shared secrets, and are never logged (the proxy logs
only the developer name a token resolves to, e.g. `http session opened for <name>`).

**Local smoke of the `vm` profile** (no TLS domain needed — for developing/debugging this
compose setup, not for normal use): `deploy/docker-compose.smoke.yml` is a committed override
that publishes the proxy's port directly to `127.0.0.1:8080`, bypassing Caddy. Point
`ZSAN_ENV_FILE` at a throwaway env file with dummy `ZSAN_ZENDESK_*` values, `ZSAN_PASS2=off`,
and one `name:token` (16+ chars) — never the repo's real `.env`, and never a file committed to
the repo:

```sh
export ZSAN_ENV_FILE=/path/to/your/throwaway.env
docker compose --env-file deploy/versions.env \
  -f deploy/docker-compose.yml -f deploy/docker-compose.smoke.yml --profile vm up -d --build
curl http://127.0.0.1:8080/healthz          # → 200 {"status":"ok"}
curl -i http://127.0.0.1:8080/mcp           # → 401 (no bearer token)
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.smoke.yml --profile vm down
```

`ZSAN_ENV_FILE` must be `export`ed once, before both commands: `up` and `down` are separate
invocations, and compose's `env_file: - ${ZSAN_ENV_FILE:-/opt/zsan/.env}` re-resolves that
default on every invocation — a one-shot prefix on just the `up` line leaves `down` falling
back to `/opt/zsan/.env`, which doesn't exist off the VM, and it errors out before doing
anything.

**Warning:** `presidio-analyzer` and `gliner` carry both the `laptop` and `vm` profiles, so
the `down --profile vm` above stops and removes them too, not just `proxy`/`caddy`. If you were
also running the laptop profile (e.g. for `bun run test:e2e`), restart it afterwards:

```sh
docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d
```

## Tools exposed

These 9 tools are forwarded; everything else is blocked before it reaches upstream and never
appears in `tools/list`:

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
| `add_ticket_comment` | forwarded — forced internal, placeholder bodies rejected |

`add_ticket_comment` is the one write tool this proxy forwards, and only with outgoing
inspection (spec §3.2): the proxy always rewrites the call to an internal-only note (any
`type` other than `internal` is overridden, `author_id` is stripped) and rejects the call
outright — before it ever reaches upstream — if `type: "public"` was requested or if the
comment body still contains a sanitization placeholder like `[PERSON_1]`. The tool's
description in `tools/list` is amended to disclose this.

Blocked categories and why:

- **Attachment/document analysis tools** (`analyze_ticket_images`, `analyze_ticket_documents`,
  `get_document_summary`) — they ship ticket content to the Anthropic API and a third-party
  converter, outside this proxy's control.
- **All other create/update/delete tools** — this proxy is read-only otherwise; no other
  ticket mutation path exists.
- **`get_user` / `list_users`** — the response is PII by definition.

## Testing

- `bun test` — unit suite, no network required.
- `bun run test:contract` — needs Presidio up (`docker compose ... --profile laptop up`).
- `bun run test:e2e` — the fixture regression gate (`tests/fixtures/tickets/`); needs Presidio
  up. Prints a scorecard of leaked/over-redacted strings per fixture on failure.

## CI

- **`.github/workflows/ci.yml`** — runs on every PR and every push to `main`, on a
  GitHub-hosted `ubuntu-latest` runner: `bun install --frozen-lockfile`, `bun run typecheck`,
  `bun test` (unit suite only — no network, no Docker).
- **`.github/workflows/stack.yml`** — the contract + e2e gate (both Presidio-only and
  GLiNER pass-2 fixture runs), on `workflow_dispatch` and a nightly cron. It needs Docker and
  the sidecars, so it targets a **self-hosted** runner labeled `zsan`, which does not exist
  yet. The job is gated with `if: ${{ vars.ZSAN_STACK_RUNNER == 'ready' }}` so it no-ops
  (rather than failing nightly) until that runner exists. To arm it once the VM is ready:
  1. Register a self-hosted runner on the VM with the label `zsan` (in addition to GitHub's
     default labels).
  2. Set the repo variable `ZSAN_STACK_RUNNER=ready` (Settings → Secrets and variables →
     Actions → Variables).

## Configuration

For everything that controls *what gets redacted* (allowlist, GLiNER labels/threshold, Presidio
recognizers and engine config), see the index in `config/README.md`. The table below is the
proxy's own runtime environment configuration.

All variables are `ZSAN_*`, validated with Zod at startup (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `ZSAN_ZENDESK_SUBDOMAIN` | *(required)* | Zendesk subdomain |
| `ZSAN_ZENDESK_EMAIL` | *(required)* | Zendesk API auth email |
| `ZSAN_ZENDESK_API_TOKEN` | *(required)* | Zendesk API token |
| `ZSAN_UPSTREAM_COMMAND` | `npx -y @sshadows/zendesk-mcp-server@1.4.1` | Command spawned as the upstream MCP child |
| `ZSAN_TRANSPORT` | `stdio` | `stdio` \| `http` — laptop mode uses `stdio`; VM mode serves Streamable HTTP |
| `ZSAN_HTTP_PORT` | `8080` | Port the HTTP transport listens on (only used when `ZSAN_TRANSPORT=http`) |
| `ZSAN_CLIENT_TOKENS` | *(empty)* | `name:token,name:token,…` — each token at least 16 characters; required (at least one pair) when `ZSAN_TRANSPORT=http` |
| `ZSAN_PRESIDIO_URL` | `http://127.0.0.1:5002` | Presidio analyzer base URL |
| `ZSAN_PASS2` | `required` | `required` \| `off` — pass 2 (GLiNER) is required by default; `off` is logged loudly at startup |
| `ZSAN_PASS2_DETECTOR` | `gliner` | `gliner` \| `ollama` — `ollama` is not implemented and `buildSanitizer` rejects it with a clear error (post-v0.1.0 bake-off item) |
| `ZSAN_GLINER_URL` | *(unset)* | GLiNER sidecar URL |
| `ZSAN_GLINER_MODEL_REF` | `urchade/gliner_multi_pii-v1@1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d` | Pinned `repo@revision` GLiNER must be running; verified against the sidecar's `/healthz` at startup |
| `ZSAN_GLINER_CONFIG_PATH` | `config/gliner.json` | Path to the GLiNER label/threshold config |
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
[info] get_ticket 4711: PERSON 3, EMAIL 1, PHONE 1 (pass1 4, pass2 2) 812ms
```

Organization/company names are not redacted (decision of 2026-09-11) — only personal data
(persons, emails, phones, CPR, IBAN, cards, addresses, usernames) is, so `ORG` never appears
in this line with a nonzero count.

A redaction guard also scans every log line for email/CPR/IBAN-shaped substrings and masks
them before they're written, as a defense-in-depth backstop against a bug that accidentally
formats raw PII into a log message.

## Known limitations

- **Organization/company names are not redacted (decision of 2026-09-11).** Only personal
  data — persons, emails, phones, CPR, IBAN, cards, addresses, usernames — is redacted; vendor,
  partner, and customer organization names are treated as business data and pass through
  unchanged. By policy, a company name that happens to contain a person's name (e.g. `Mette
  Sørensen ApS`, common for Danish sole traders) counts as a company name, not personal data,
  and is deliberately not targeted for redaction — but nothing in this codebase specifically
  detects "this is a company name" to suppress a person-name match within it, so whether the
  embedded name still gets redacted depends on what the person-name detector does with that
  span in context (see the design spec's D4 amendment for the measured behavior). This is a
  known, accepted risk of the policy, not a bug. `config/allowlist.txt` still guards against
  product/service names being misdetected as a still-redacted personal-data type (e.g.
  `PERSON`).
- **Bare-phone/CPR coverage relies on pattern recognizers.** Phone and CPR detection (including
  the bare 10-digit CPR case) comes from the ad-hoc regex recognizers in `config/recognizers/`,
  gated by `isValidCpr`'s date check for CPR — not from a semantic understanding of the text.
- **Names embedded in attachment filenames — closed.** Attachment/thumbnail filenames
  (`file_name`, `src/policy/filename.ts`) are analyzed as **two independent views** that share
  one placeholder table: the original text unchanged (so pattern recognizers that need intact
  punctuation — CPR, phone, IBAN, card — still fire exactly as they would on any other field)
  and a tokenized stem with the extension set aside, split on separator runs (`_`/`-`/`.`/space),
  camelCase boundaries, and digit/letter boundaries (e.g. `faktura_MetteSørensen.pdf` →
  detection text `faktura Mette Sørensen`, caught by Presidio in pass 1). Refill prefers the
  original-view result whenever it redacted anything, else the rejoined stem-view result, else
  the untouched original filename byte-for-byte — see `tests/fixtures/tickets/attachments.json`,
  `basic-da.json`. What still isn't caught: (1) a name fused with no separator, no case change,
  and no digit boundary at all (e.g. an all-lowercase `mettesørensen.pdf`) — tokenization has no
  boundary to split on; (2) a filename containing **both** a pattern-detectable value and a
  glued-together name (e.g. `cpr-010190-1234-MetteSørensen.pdf`) redacts only the pattern
  (`cpr-[CPR_1]-MetteSørensen.pdf`), because the original view already redacted something and
  wins over the stem view outright — never worse than not tokenizing filenames at all, but the
  name in that combination still leaks (pinned in `tests/policy/resultSanitizer.test.ts`).
