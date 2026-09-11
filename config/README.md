# Config index — the tuning surface

Everything in this folder decides *what gets redacted*. It is CODEOWNERS-governed (spec §12):
changes here require the GDPR owner's review before merge.

Two passes touch every chunk of text: **pass 1 = Presidio** (pattern + spaCy NER, called first),
**pass 2 = GLiNER** (zero-shot NER, re-run on pass 1's already-redacted text). A file below is
marked with which pass it affects.

| File | Pass | Runtime effect |
|---|---|---|
| `allowlist.txt` | both | terms never redacted |
| `gliner.json` | 2 | labels, threshold, label→entity map |
| `recognizers/*.json` | 1 | ad-hoc Presidio pattern recognizers |
| `presidio/nlp.yml` | 1 | spaCy model per language + NER label→entity mapping |
| `presidio/recognizers.yml` | 1 | which built-in Presidio recognizers run, per language |
| `presidio/analyzer.yml` | 1 | server-side score threshold (0, deliberately) |

## `allowlist.txt`

Terms that must never be redacted, in either pass. One term per line, `#` starts a trailing
comment, blank lines ignored. Read at runtime by the proxy (`ZSAN_ALLOWLIST_PATH`, default
this file) — no rebuild needed after editing.

**Match rule** (`src/sanitize/allowlist.ts`):
- **Exact match**: the whole candidate span, normalized, equals a listed term.
- **Word-subset match**: every word of the candidate span appears in some multi-word term's
  word set — but this only fires if the candidate itself has **≥ 2 words**, or is a **single
  word of ≥ 4 alphabetic characters**. This stops a short, generic single word (e.g. "A/S") from
  riding in on a longer allowlisted term.
- A single-word term (e.g. `Continia`, `Azure`, `NAV`) is protected wherever it appears as a
  whole word, case-insensitively — keep single-word entries specific, since they have no
  multi-word context to disambiguate them.

Organization/company names are no longer redacted at all as of 2026-09-11 (spec D4 reversed);
this list now mainly guards product/service names from being misdetected as PERSON or another
still-redacted type.

**After changing:** `bun test && bun run test:e2e:pass2`

## `gliner.json`

Pass 2 config, loaded at startup (`ZSAN_GLINER_CONFIG_PATH`, default this file).

```json
{
  "threshold": 0.65,
  "labels": ["person name", "street address", "..."],
  "labelMap": { "person name": "PERSON", "...": "..." }
}
```

- `labels` — the full zero-shot label prompt sent to GLiNER on every call.
- `threshold` — minimum score to keep a span (0.65 shipped).
- `labelMap` — label → `EntityType`. A label present in `labels` but **absent** from
  `labelMap` still gets scored by GLiNER but its spans are dropped client-side once they come
  back with no mapping.

**Warning — carry this into any edit:** GLiNER is zero-shot and scores every label relative to
the whole label set, so adding or removing a label re-scores *all* the others, not just the one
you touched. Measured on 2026-09-11 (spec §4.2): removing the `organization or company name`
label dropped person-name confidence from 0.617 to 0.167 on `"Ring til Lars Nielsen om sagen."`
and pushed `mette_soerensen` from `person name` onto `username or account handle`. This is why
`organization or company name` is still present in `labels` (to keep the rest of the label set's
scores stable) but has no entry in `labelMap` (so its spans are discarded) — a label that should
stop being redacted is removed only from `labelMap`, never from `labels`.

**After changing:** `bun test && bun run test:e2e:pass2` (label-set changes additionally need
the probe strings from the D4 amendment re-measured — see spec §4.2).

## `recognizers/*.json` (`cpr.json`, `dk-phone.json`, `intl-phone.json`)

Pass 1: ad-hoc Presidio pattern recognizers, loaded at startup (`ZSAN_RECOGNIZERS_PATH`, default
this directory) and sent as `ad_hoc_recognizers` on every `/analyze` call — no image rebuild
needed after editing.

Shape:
```json
{
  "name": "DK_CPR",
  "supported_entity": "DK_CPR",
  "patterns": [{ "name": "cpr_hyphen", "regex": "...", "score": 0.85 }],
  "context": ["cpr", "personnummer"]
}
```

These `regex` strings are sent to and executed by **Presidio's Python process**, not by JS/Bun —
Python regex syntax, not JS regex syntax.

The Danish CPR checksum/date validation (valid day-of-month, month, and century-from-7th-digit
rules) lives in code, `src/sanitize/cpr.ts` (`isValidCpr`), **not** in these regexes — a regex
alone cannot validate a calendar date, so `cpr.json`'s patterns intentionally over-match and the
proxy filters false positives after the fact.

**After changing:** `bun test && bun run test:e2e:pass2`

## `presidio/nlp.yml`

Pass 1: which spaCy model Presidio loads per language, and how spaCy's NER labels map onto
Presidio entity types.

- `models` — one `lang_code`/`model_name` pair per supported language (`da`/`en`/`de`); the
  actual model wheels are pinned and installed in `sidecars/presidio/Dockerfile`.
- `ner_model_configuration.model_to_presidio_entity_mapping` — e.g. `PER`/`PERSON` → `PERSON`,
  `ORG` → `ORGANIZATION`, `LOC`/`GPE` → `LOCATION`. Note `ORGANIZATION` has no downstream mapping
  in `src/sanitize/presidio.ts`'s `PRESIDIO_ENTITY_MAP` (organizations are not redacted, spec D4)
  — it is kept here only so spaCy's raw label doesn't fall through unmapped.
- `labels_to_ignore` — spaCy NER labels Presidio should not turn into candidate spans at all
  (`DATE`, `MONEY`, `PRODUCT`, ...).

Baked into the analyzer image at build time (`ENV NLP_CONF_FILE=...`) — editing this file has no
effect until the image is rebuilt.

**After changing:** rebuild+restart the analyzer —
`docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build presidio-analyzer`
— then `ZSAN_CONTRACT=1 bun test tests/contract && ZSAN_E2E=1 bun test tests/e2e && bun run test:e2e:pass2`.

## `presidio/recognizers.yml`

Pass 1: which built-in Presidio recognizers (`EmailRecognizer`, `PhoneRecognizer`,
`IbanRecognizer`, `CreditCardRecognizer`, `SpacyRecognizer`) are enabled, and for which
languages. `PhoneRecognizer` carries a per-language `context` word list override, because its
built-in context list is English-only and da/de matches need a local context word (e.g.
`telefon`, `mobil`) to clear the pattern score threshold.

Baked into the analyzer image (`ENV RECOGNIZER_REGISTRY_CONF_FILE=...`).

**After changing:** same rebuild + verification as `nlp.yml` above.

## `presidio/analyzer.yml`

Pass 1: `default_score_threshold: 0`, deliberately — the server does no thresholding of its own;
`src/sanitize/presidio.ts` applies the real thresholds client-side (`nerThreshold: 0.4`,
`patternThreshold: 0.7`) so the proxy, not the sidecar, owns the cutoff.

Baked into the analyzer image (`ENV ANALYZER_CONF_FILE=...`).

**After changing:** same rebuild + verification as `nlp.yml` above.

## Knobs that are *not* in this folder

- `PRESIDIO_ENTITY_MAP` — `src/sanitize/presidio.ts:5` — maps Presidio's raw `entity_type`
  strings (`PERSON`, `EMAIL_ADDRESS`, `DK_CPR`, ...) to this proxy's `EntityType`. An entity not
  listed here never becomes a redaction, however Presidio scores it.
- The pass-1 score gates — `src/sanitize/presidio.ts:37` (`nerThreshold: 0.4`) and
  `src/sanitize/presidio.ts:38` (`patternThreshold: 0.7`).
- The Zendesk field rules (drop / idOnly / keep / sanitize per JSON field path) —
  `src/policy/fieldPolicy.ts` (`RULES`, starting at line 7).
- The forwarded-tool allowlist — `src/policy/toolPolicy.ts` (`READ_ONLY_TOOLS` /
  `WRITE_TOOLS`, lines 10–26). Widening it requires a PR and a green e2e run (spec §5).

## What to run after changing what

| Changed | Run |
|---|---|
| `allowlist.txt`, `gliner.json`, `recognizers/*.json` (all read at proxy runtime, no rebuild) | `bun test && bun run test:e2e:pass2` |
| anything under `presidio/` (`nlp.yml`, `recognizers.yml`, `analyzer.yml` — baked into the analyzer image) | rebuild the analyzer image: `docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build presidio-analyzer`, then `ZSAN_CONTRACT=1 bun test tests/contract && ZSAN_E2E=1 bun test tests/e2e && bun run test:e2e:pass2` |

This folder is governed by `.github/CODEOWNERS` — every file under `config/` requires the GDPR
owner's review (spec §12).
