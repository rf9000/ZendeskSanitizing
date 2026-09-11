# Zendesk Sanitizing Proxy — overview

A plain-language summary of what this does and does not protect. For how to change the
behaviour, see [`config/README.md`](../config/README.md); for the design rationale, see
[`docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md`](superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md).

## What it is

Claude Code does not talk to Zendesk. It talks to a proxy that sits in front of the Zendesk MCP
server, forwards a restricted set of tools, intercepts every response and removes personal data
before anything reaches the model. Raw ticket text never enters the session.

The Zendesk API token lives only in the proxy's environment, so the proxy is the only component
that can reach Zendesk at all.

```
Claude Code ──▶ sanitizing proxy ──▶ Zendesk MCP ──▶ Zendesk
                      │
                      ├─ pass 1: Presidio   (rules + per-language NER)
                      └─ pass 2: GLiNER     (contextual, runs on pass 1's output)
                      │
                ◀─────┘ sanitized response
```

**Fail closed.** If either detector is unreachable, times out or returns something invalid, the
tool call returns an error. There is no code path that falls back to unredacted data.

## What gets removed

Detected and replaced with placeholders:

- personal names
- email addresses
- phone numbers (Danish and international)
- Danish CPR numbers
- IBANs and payment card numbers
- street addresses
- usernames and account handles
- names embedded in attachment filenames (`faktura_MetteSørensen.pdf` → `faktura_[PERSON_1].pdf`)

Dropped structurally — these never reach detection at all, because they are personal by
definition rather than by content:

- requester, submitter, assignee and collaborator objects (reduced to numeric IDs)
- sender/recipient email addresses on the ticket and on each comment
- client IP address, geolocation, user agent
- attachment download URLs
- organisation contact details, notes and domain names

## What is kept

Company and vendor names, product and version information, the technical content of the
conversation, ticket and organisation IDs, statuses, priorities, timestamps and tags. A
sanitized ticket is still meant to be useful to work from.

Company names were originally redacted too; that was reversed on 2026-09-11 by decision of the
GDPR owner — organisations are business data, not personal data.

## How it works

Two passes run over every piece of text.

**Pass 1 — Presidio.** Regular expressions with validation (a CPR must parse as a real calendar
date; a card number must checksum) plus spaCy named-entity recognition in Danish, English and
German. This is the deterministic half: structured identifiers are caught by rules you can read
and test, not by a model's judgement.

**Pass 2 — GLiNER.** A small zero-shot model that runs over pass 1's already-redacted output and
catches what rules cannot: addresses, unusual casing, usernames, names in positions the NER
models miss. It returns character spans only — it never rewrites text, so it cannot paraphrase
or hallucinate ticket content.

Within a single ticket the same value always becomes the same placeholder, so `[PERSON_1]` in
the first comment is the same person as `[PERSON_1]` in the last one and the conversation still
reads coherently. The mapping is held in memory for the duration of one call and never stored.

Logs record counts only — `PERSON 3, EMAIL 2, CPR 1` — never values.

## Where it is imperfect

Stated plainly, because it is the question that follows:

- **Run-together names in filenames.** `faktura_MetteSørensen.pdf` is handled, but
  `mettesørensen.pdf` — no separator, no capital, no digit — is not.
- **Company names containing a person's name.** `Sørensen Consulting A/S` is kept whole. This is
  deliberate under the current policy: it is a company name.
- **A bare initial next to a redacted name.** A single character adjacent to an existing
  placeholder can survive.
- **Free-text judgement calls.** Indirect identifiers ("the CFO of the Aarhus office") are only
  caught when a detector recognises them; nothing guarantees it.

These are tracked in [`docs/superpowers/plans/2026-08-28-plan-2-backlog.md`](superpowers/plans/2026-08-28-plan-2-backlog.md).

## How we know it works

A corpus of synthetic tickets — invented Danish, English and German names, fake-but-valid CPR
numbers, fabricated IBANs and addresses — runs through the real detectors on every change. Each
fixture declares the strings that must be absent from the output and the strings that must
survive, so both under-redaction and over-redaction fail the build. Real ticket data is never
used as a fixture.

```
bun test                    # unit suite, no network
bun run test:e2e            # fixture corpus, pass 1 only
bun run test:e2e:pass2      # fixture corpus, both passes
```

## Where it is managed

Everything that decides what gets redacted is under [`config/`](../config/), indexed by
[`config/README.md`](../config/README.md) and governed by CODEOWNERS — changes require the GDPR
owner's review.
