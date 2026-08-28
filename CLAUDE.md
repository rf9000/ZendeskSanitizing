# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

ZendeskSanitizing is a working Bun + TypeScript project (Plan 1 — laptop mode — is implemented): an MCP sanitizing proxy in front of the Zendesk MCP server, following the sibling `DevOpsPullers` projects' conventions (Zod for env config, dependency injection via interfaces, `tests/` mirroring `src/`). Design spec: `docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md`; implementation plan: `docs/superpowers/plans/2026-08-27-plan-1-core-proxy-presidio.md`. The **Commands** and **Architecture** sections below are current — keep them that way as the codebase changes.

## Development Approach: Test-Driven Development

We prioritise TDD. Tests are not an afterthought added once code works — they drive the design.

**For new features:**
1. Write a failing test that describes the behaviour you want.
2. Run it and confirm it fails for the right reason (not a typo or import error).
3. Write the minimum implementation to make it pass.
4. Refactor with the tests green.

**For bugs — strive for red → green:**
1. First reproduce the bug as a test. Run it and confirm it is **red** (it fails because of the bug, not for some other reason).
2. Only then fix the code.
3. Run the test again and confirm it is **green**.
4. Run the full suite to make sure nothing else regressed.

Do not fix a bug and then write a test that "would have caught it" afterwards — a test written after the fix has never been observed failing, so it proves nothing about the bug. If a bug is genuinely impossible to pin down in a test (e.g. it depends on an external service that cannot be faked), say so explicitly rather than silently skipping the test.

When reporting that something is fixed or done, include the actual test output — a claim of passing tests without having run them is not acceptable.

## Commands

- `bun test` — unit suite (no network). `bun test tests/sanitize/session.test.ts` for one file; `bun test -t "name"` for one test.
- `bun run test:contract` — needs Presidio up (`docker compose … --profile laptop up`).
- `bun run test:e2e` — fixture regression gate; needs Presidio up.
- `bun run typecheck` — `tsc --noEmit`.
- `ZSAN_PASS2=off bun run start` — run the stdio proxy (laptop mode) with `.env` filled.

## Architecture

An MCP proxy the developer registers *as* `zendesk`. One request path, one direction:
`src/server/proxy.ts` (tool allowlist check) → `src/upstream/child.ts` (spawns the real
`@sshadows/zendesk-mcp-server` over stdio; the child receives the `ZENDESK_*` trio, `PATH`,
and the MCP SDK's fixed safe-inherit list — HOME/TEMP/USERPROFILE-class variables, never this
proxy's own `ZSAN_*` env) → `src/policy/resultSanitizer.ts`
(decodes the tool result's JSON text, walks it via `src/policy/fieldPolicy.ts` to drop/keep/
idOnly/sanitize each field by path) → `src/sanitize/session.ts` (one `SanitizeSession` per
tool call: pass 1 = Presidio `analyze` for spans, pass 2 = a `SpanDetector` slot — `null` in
this plan, GLiNER in Plan 2 — re-run on pass 1's already-redacted text; spans become
`[TYPE_n]` placeholders via a shared per-session table so the same value always gets the same
placeholder). Everything is fail-closed: an unreachable/timed-out/invalid sanitizer call
throws and the tool call returns an MCP error — the raw payload is never returned as a
fallback. Fixtures under `tests/fixtures/tickets/` are synthetic by construction and must stay
that way — never put real ticket data in a fixture, since the e2e suite runs it through a live
Presidio instance and prints its output on failure.
