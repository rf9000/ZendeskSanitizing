# Plan 2 backlog — items carried over from Plan 1 execution

Collected from the Plan 1 review ledger (subagent-driven development, 2026-08-27/28). Each item
was triaged in the final whole-branch review as **PLAN-2** (safe to ship Plan 1 without it).
Plan 2 = GLiNER pass 2, `add_ticket_comment` (internal only + outgoing inspection), Streamable
HTTP transport + VM deploy, CI, branch protection, CODEOWNERS, `v0.1.0`.

## Must be part of Plan 2's design

1. **Offset translation for every Python sidecar client.** Presidio returns Unicode code-point
   offsets; JS uses UTF-16. `src/sanitize/offsets.ts` (`codePointToUtf16Map`) exists and must be
   used by the GLiNER and Ollama detectors too. Add an emoji case to their unit tests.
2. **Re-add the hard deadline in `SanitizeSession.withTimeout`.** It currently relies on the
   client honouring `AbortSignal`; a non-cooperative detector could hang a call. Race a
   deadline promise again before the GLiNER client lands.
3. **Allowlist vs. longest-span-wins.** `resolveOverlaps` prefers the longest span, so a
   non-allowlisted span that *contains* an allowlisted term (e.g. `group via Continia A/S`)
   redacts the allowlisted term. Structural fix: prefer a shorter allowlisted span over a longer
   containing span (or trim allowlisted words off span edges) in the merge step.
4. **Allowlist word-subset rule is too permissive (spec §6.2).** A bare `365` or `Central` is
   allowed because it is a subset of `Dynamics 365` / `Business Central`. Amend: subset matches
   require ≥2 words, or a single word ≥4 alphabetic characters.
5. **CODEOWNERS scope.** Must cover `config/**`, `sidecars/**`, `deploy/versions.env`, the
   field/tool policy files — all of them determine recall.
6. **Upstream child restart** (spec §8): restart once with back-off when the child exits;
   in-flight calls return `UPSTREAM_UNAVAILABLE`. Not implemented in Plan 1.
7. **`PLACEHOLDER_RE` is a shared `/g` RegExp** — the outgoing placeholder scan for
   `add_ticket_comment` must use `matchAll`/`match`, never `.test`/`.exec`.
8. **Scorecard by entity type / language / detector** (spec §11) — the e2e harness currently
   prints leaked/overRedacted lists per fixture; the GLiNER bake-off needs per-type recall.
9. **Spec §16 additions**: Presidio `EmailRecognizer` (tldextract) drops RFC 2606 `.example`
   TLDs — fixtures must use real TLDs on fake domains; `PhoneRecognizer`'s base score is 0.4 and
   only context boosts it — bare numbers are covered by `INTL_PHONE`/`DK_PHONE` pattern
   recognizers, not by Presidio's built-in.

## Recall / precision follow-ups (pass 1 as configured)

- `ORG_SUFFIX` recognizer: stopword filter misses first tokens containing `&`/`-`
  (`AT&T Inc`, `In-Tech Ltd`) and is defeatable by unlisted prepositions (`hos`, `via`, `near`).
  Expected to become less load-bearing once GLiNER catches bare org names.
- With ORG unsuppressed, spaCy NER noise clears the 0.4 gate (e.g. `ORG` for `Card 4111`,
  `PERSON` for `Email`) → over-redaction only. Track via the scorecard.
- `cpr_plain` at 0.75: any 10-digit token whose first six digits form a valid DDMMYY is redacted
  (≈4 % of random 10-digit strings). Spec-sanctioned (§6.6); revisit if ticket text carries many
  10-digit serials.
- `chunking.ts` hard cut slices by UTF-16 unit and can split a surrogate pair on a >6000-char
  field with no boundary — round the hard cut down to a code-point boundary.
- Logging guard covers the hyphenated CPR shape only (`\d{6}-\d{4}`); plain 10-digit is too
  noisy to guard.
- 2026-09-11: GLiNER threshold raised 0.4 → 0.65 (bare short tags like 'partner' were mislabeled
  PERSON at 0.4, and an allowlisted phrase over-redacted); German address + Danish lower-case tag
  both caught at 0.65.

## Small code/test polish (non-blocking)

- `tests/setup.ts` preloaded twice (bunfig + `--preload` in scripts) — drop one.
- `resolveOverlaps` is O(n²); tests lack a `gliner`-vs-`ollama` source tiebreak and a
  same-length start tiebreak case.
- `splitText`: no lone-`\n` boundary test; redundant `cut <= maxChars` check; no JSDoc.
- `detectLang`: no tests for the exactly-20-char boundary, whitespace-only text, or the genuine
  franc `und` fallback.
- `Allowlist`: no tests for empty span text or inline `#` comments; a term like `C#` cannot be
  allowlisted because `#` starts a comment.
- `loadRecognizers` lives in `cpr.ts` — move to `recognizers.ts`; loader tests are happy-path only.
- `PresidioClient`: no tests for an unparseable JSON body, abort, or POST/content-type headers.
- `SanitizeSession`: dead `Piece.chunkIndex`; the `texts.size` invariant is unreachable
  (belt-and-braces); `used = true` is set before config validation.
- `logging.ts`: `guardHits()` counts lines, not entities (undocumented); no test with two same-type
  matches on one line.
- `fieldPolicy.ts`: no cycle guard (input is `JSON.parse` output, so acceptable); `keep` cannot
  express whole-subtree pass-through; `details`/`notes` are dropped globally; `time_zone` kept;
  the root `DROP` branch is unreachable; the `result_type === "user"` check precedes path rules.
- `resultSanitizer.ts`: `__prefix` chunk id could collide with a top-level JSON key of that
  name (fails closed); whitespace-only prefix becomes a chunk; no bracket-in-free-text test.
- `upstream/child.ts`: stderr listener not removed in `close()`; spawn test leaves an empty
  `zsan-upstream-*` temp dir per run (pass `mkTempDir`).
- `server/proxy.ts`: `now()` runs outside the try (test seam only); `errName` non-Error branch
  untested. `server/stdio.ts`: 3 s shutdown race timer.
- `CLAUDE.md` single-file test hint omits `--preload` (bunfig covers it).
- `allowlist-edge.json` and other fixtures: several `present` strings are JSON keys or kept
  primitives and cannot fail — decorative, not harmful.
- `encodeText` always re-serialises with 2-space indent (spec §3.1 says "same formatting").
- Proxy version `0.0.1` is hard-coded in `proxy.ts`; startup log now reads it from
  `package.json` — unify.
