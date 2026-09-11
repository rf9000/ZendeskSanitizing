# Zendesk Sanitizing Proxy — Plan 2: GLiNER pass 2, outgoing comments, HTTP/VM mode, v0.1.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `v0.1.0`: the contextual GLiNER detector as a required pass 2, internal-only `add_ticket_comment` with outgoing placeholder inspection, a bearer-token Streamable HTTP transport with VM deploy artifacts, CI and CODEOWNERS — plus the nine "must" items from the Plan 1 backlog.

**Architecture:** Plan 1's `SanitizeSession` already has a `pass2: SpanDetector | null` slot; this plan fills it with a `GlinerDetector` talking to a new digest-pinned Python sidecar (FastAPI + GLiNER, model baked into the image at a pinned HF revision). The proxy core gains the backlog hardening (hard timeout deadline, allowlist-aware span splitting, code-point-safe chunking, upstream restart-once). A second entry point serves the same `createProxyServer` over Streamable HTTP with per-developer bearer tokens for VM mode.

**Tech Stack:** existing Bun/TypeScript stack + `@modelcontextprotocol/sdk` 1.30.0 (`WebStandardStreamableHTTPServerTransport`); sidecar: `python:3.12-slim`, `gliner==0.2.29`, `fastapi==0.141.1`, `uvicorn==0.52.4`, model `urchade/gliner_multi_pii-v1` @ revision `1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d`; Caddy for TLS on the VM; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md` (§3.2, §4.2, §5, §6.2, §8, §9, §11, §12, §14 steps 4–6). **Backlog:** `docs/superpowers/plans/2026-08-28-plan-2-backlog.md` — its "Must be part of Plan 2's design" section is binding for this plan.

## Global Constraints

- Fail closed: no code path may return upstream text to the MCP client unless it passed through `SanitizeSession.sanitize`. Error messages are static strings + a code. Logs carry counts only; every log line passes `redactionGuard`.
- Pass 2 is a **detector, not a rewriter**: it returns spans; TypeScript applies replacements. The GLiNER sidecar returns character offsets in **Unicode code points** (Python `str` indices) — every client MUST translate via `codePointToUtf16Map` (`src/sanitize/offsets.ts`) before touching JS strings (backlog must-item 1).
- `ZSAN_PASS2=required` is the default and must now actually work; `off` stays permitted with a loud startup warning.
- Placeholder grammar unchanged: `[<TYPE>_<n>]`, `TYPE ∈ PERSON|ORG|EMAIL|PHONE|CPR|IBAN|CARD|ADDRESS|USERNAME|OTHER`. Any scan for placeholder tokens uses `matchAll`/`match` on `PLACEHOLDER_RE` — never `.test`/`.exec` (it is a shared `/g` instance; backlog must-item 7).
- Pins: sidecar image base by digest, Python deps by exact version, HF model by repo **and** revision `urchade/gliner_multi_pii-v1@1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d`; the proxy refuses to start `required` pass 2 against a sidecar reporting a different model/revision.
- Tool surface after this plan: the 8 read-only tools + `add_ticket_comment` (forced `type: "internal"`, `author_id` stripped, body rejected if it contains a placeholder token). Nothing else.
- Conventions: TDD per `CLAUDE.md` (RED for the right reason → GREEN, real output in reports); `tests/` mirrors `src/`; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never `git add -A`; fixtures stay synthetic; use the Write tool (not shell heredocs) for any file containing regex backslashes or JSON escapes.
- Work on branch `feat/plan-2-gliner-vm`. Do not push and do not create a PR — the controller/user decides.
- Environment notes: Docker Desktop runs the Presidio analyzer (healthy at `127.0.0.1:5002`); `bun test` = unit suite (no network); `ZSAN_CONTRACT=1 bun test tests/contract` and `ZSAN_E2E=1 bun test tests/e2e` need the sidecars up. A real `.env` with live Zendesk credentials exists at the repo root — NEVER read, print, cat, copy or commit it; tests must not depend on it.

## File structure (this plan)

```
sidecars/gliner/                Dockerfile, app.py, requirements.txt
config/gliner.json              labels, threshold, label→EntityType map (CODEOWNERS-owned)
src/config.ts                   + ZSAN_TRANSPORT, ZSAN_HTTP_PORT, ZSAN_CLIENT_TOKENS,
                                  ZSAN_GLINER_MODEL_REF, ZSAN_GLINER_CONFIG_PATH; glinerUrl required when pass2=required
src/sanitize/detectors/gliner.ts   GlinerDetector (SpanDetector), loadGlinerConfig, verifyGlinerSidecar
src/sanitize/session.ts         withTimeout hard deadline; allowlist-occurrence span splitting
src/sanitize/chunking.ts        hard cut on code-point boundary
src/sanitize/allowlist.ts       findOccurrences(); tightened word-subset rule
src/sanitize/replace.ts         splitSpansAroundRanges()
src/policy/toolPolicy.ts        + add_ticket_comment, rewriteOutgoingArguments(), amendToolList()
src/server/proxy.ts             outgoing rewrite hook; version from package.json
src/server/stdio.ts             pass-2 wiring + sidecar identity check
src/server/http.ts              Streamable HTTP entry (bearer auth, session map)
src/upstream/restart.ts         createRestartingUpstream()
deploy/docker-compose.yml       + gliner service (laptop+vm), proxy + caddy services (vm)
deploy/Caddyfile, deploy/vm-setup.sh, deploy/github-setup.md
sidecars/proxy/Dockerfile       proxy container for VM mode
.github/workflows/ci.yml        unit+typecheck on every PR (ubuntu-latest)
.github/workflows/stack.yml     contract+e2e on self-hosted runner (nightly + dispatch)
.github/CODEOWNERS
tests/…                         mirrors of all the above; e2e harness gains pass-2 mode + typed scorecard
```

---

### Task 1: GLiNER sidecar (image, API, compose service, contract test)

**Files:**
- Create: `sidecars/gliner/Dockerfile`, `sidecars/gliner/app.py`, `sidecars/gliner/requirements.txt`
- Modify: `deploy/docker-compose.yml` (add `gliner` service), `deploy/versions.env` (add pins)
- Test: `tests/contract/gliner.contract.test.ts`

**Interfaces:**
- Produces (HTTP, consumed by Task 2):
  - `GET /healthz` → `200 {"model_id": "urchade/gliner_multi_pii-v1", "revision": "1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d", "status": "ok"}`
  - `POST /detect` body `{"text": string, "labels": string[], "threshold": number}` → `200 {"spans": [{"start": int, "end": int, "label": string, "score": float}]}` — offsets are Python `str` indices (Unicode code points), end exclusive.
  - Errors: missing/invalid body → 422 (FastAPI default); empty `text` → `200 {"spans": []}`.

- [ ] **Step 1: Resolve the remaining pins (record real values, never guess)**

```bash
docker run --rm python:3.12-slim pip index versions torch --index-url https://download.pytorch.org/whl/cpu 2>/dev/null | head -2
docker buildx imagetools inspect python:3.12-slim --format '{{json .Manifest.Digest}}'
```
Append to `deploy/versions.env` (keep existing content):
```
# GLiNER sidecar pins (resolved <date>)
PYTHON_SLIM_DIGEST=sha256:<from imagetools inspect>
TORCH_CPU_VERSION=<latest from pip index, e.g. 2.9.x>
GLINER_VERSION=0.2.29
GLINER_MODEL_ID=urchade/gliner_multi_pii-v1
GLINER_MODEL_REVISION=1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d
```

- [ ] **Step 2: Write the contract test (RED: connection refused while the sidecar doesn't exist)**

`tests/contract/gliner.contract.test.ts`:
```ts
import { describe, expect, test } from "bun:test";

const enabled = process.env.ZSAN_CONTRACT === "1";
const baseUrl = process.env.ZSAN_GLINER_URL ?? "http://127.0.0.1:5003";
const d = enabled ? describe : describe.skip;

d("gliner sidecar contract", () => {
  test("healthz reports the pinned model and revision", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model_id: string; revision: string };
    expect(body.model_id).toBe("urchade/gliner_multi_pii-v1");
    expect(body.revision).toBe("1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d");
  });

  test("detects a Danish person and street address with valid code-point offsets", async () => {
    const text = "Hej, jeg hedder Mette Sørensen og bor på Vestergade 12, 8000 Aarhus C.";
    const res = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, labels: ["person name", "street address"], threshold: 0.3 }),
    });
    expect(res.status).toBe(200);
    const { spans } = (await res.json()) as { spans: Array<{ start: number; end: number; label: string; score: number }> };
    const cp = [...text];
    for (const s of spans) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(cp.length);
    }
    const texts = spans.map((s) => cp.slice(s.start, s.end).join(""));
    expect(texts.some((t) => t.includes("Mette"))).toBe(true);
    expect(texts.some((t) => t.includes("Vestergade"))).toBe(true);
  });

  test("empty text returns empty spans, not an error", async () => {
    const res = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", labels: ["person name"], threshold: 0.4 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { spans: unknown[] }).spans).toEqual([]);
  });
});
```
Run: `ZSAN_CONTRACT=1 bun test tests/contract/gliner.contract.test.ts` → Expected: FAIL, connection refused (RED recorded).

- [ ] **Step 3: Write the sidecar**

`sidecars/gliner/requirements.txt` (fill TORCH_CPU_VERSION from Step 1):
```
--extra-index-url https://download.pytorch.org/whl/cpu
torch==<TORCH_CPU_VERSION>
gliner==0.2.29
fastapi==0.141.1
uvicorn==0.52.4
```

`sidecars/gliner/app.py`:
```python
"""GLiNER PII span detector sidecar.

Returns character offsets as Python str indices (Unicode code points).
The TypeScript client translates them to UTF-16 via codePointToUtf16Map.
"""
import os

from fastapi import FastAPI
from gliner import GLiNER
from pydantic import BaseModel

MODEL_ID = os.environ["GLINER_MODEL_ID"]
REVISION = os.environ["GLINER_MODEL_REVISION"]

model = GLiNER.from_pretrained(MODEL_ID, revision=REVISION)
app = FastAPI()


class DetectRequest(BaseModel):
    text: str
    labels: list[str]
    threshold: float = 0.4


@app.get("/healthz")
def healthz() -> dict:
    return {"model_id": MODEL_ID, "revision": REVISION, "status": "ok"}


@app.post("/detect")
def detect(req: DetectRequest) -> dict:
    if not req.text:
        return {"spans": []}
    entities = model.predict_entities(req.text, req.labels, threshold=req.threshold)
    return {
        "spans": [
            {"start": e["start"], "end": e["end"], "label": e["label"], "score": float(e["score"])}
            for e in entities
        ]
    }
```
Note: if `gliner==0.2.29`'s `predict_entities` returns keys other than `start`/`end`/`label`/`score`, inspect one result inside the container (`python -c "..."`) and adapt the mapping — the HTTP contract above is fixed; the adaptation happens in `app.py`, never in the TS client. Record what you found in your report.

`sidecars/gliner/Dockerfile` (model baked in at build so runtime needs no network):
```dockerfile
ARG PYTHON_SLIM_DIGEST
FROM python:3.12-slim@${PYTHON_SLIM_DIGEST}
ARG GLINER_MODEL_ID
ARG GLINER_MODEL_REVISION
ENV GLINER_MODEL_ID=${GLINER_MODEL_ID} \
    GLINER_MODEL_REVISION=${GLINER_MODEL_REVISION} \
    HF_HOME=/opt/hf
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
RUN python -c "from gliner import GLiNER; import os; GLiNER.from_pretrained(os.environ['GLINER_MODEL_ID'], revision=os.environ['GLINER_MODEL_REVISION'])"
COPY app.py /app/app.py
WORKDIR /app
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

Add to `deploy/docker-compose.yml` (same style as `presidio-analyzer`):
```yaml
  gliner:
    build:
      context: ../sidecars/gliner
      args:
        PYTHON_SLIM_DIGEST: ${PYTHON_SLIM_DIGEST}
        GLINER_MODEL_ID: ${GLINER_MODEL_ID}
        GLINER_MODEL_REVISION: ${GLINER_MODEL_REVISION}
    image: zsan/gliner:${GLINER_VERSION}-${GLINER_MODEL_REVISION}
    profiles: [laptop, vm]
    restart: unless-stopped
    ports:
      - "127.0.0.1:5003:8000"
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')\""]
      interval: 15s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits:
          memory: 2g
```

- [ ] **Step 4: Build, start, contract test GREEN**

```bash
docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build gliner
docker compose -f deploy/docker-compose.yml logs -f gliner   # wait for "Uvicorn running"
ZSAN_CONTRACT=1 bun test tests/contract/gliner.contract.test.ts
```
Expected: 3 pass. Troubleshooting: (1) model download at build needs network — expected, ~1 GB; (2) if memory exceeds 2g at inference (`docker stats --no-stream`), raise the limit and note it; (3) if the Danish detection assertion fails at threshold 0.3, record the actual spans returned in your report and lower the assertion to `texts.length > 0` ONLY if neither name nor street is found at any threshold ≥ 0.2 — that outcome is itself a key result (Danish recall is the open question, spec §16) and must be flagged loudly as DONE_WITH_CONCERNS.

- [ ] **Step 5: Full regression + commit**

Run: `ZSAN_CONTRACT=1 bun test tests/contract && bun test && bun run typecheck`
Expected: presidio contract still 5/5, gliner 3/3, unit suite green.

```bash
git add sidecars/gliner deploy/docker-compose.yml deploy/versions.env tests/contract/gliner.contract.test.ts
git commit -m "feat(sidecar): GLiNER PII detector sidecar, pinned model baked into image; compose service; contract test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: GlinerDetector client, config keys, sidecar identity check

**Files:**
- Create: `src/sanitize/detectors/gliner.ts`, `config/gliner.json`
- Modify: `src/config.ts` (new keys + refinement), `.env.example`
- Test: `tests/sanitize/detectors/gliner.test.ts`, extend `tests/config.test.ts`

**Interfaces:**
- Consumes: `SpanDetector`, `Span`, `Chunk`, `EntityType`, `SanitizerError` from `src/sanitize/types.ts`; `codePointToUtf16Map` from `src/sanitize/offsets.ts`.
- Produces:
  ```ts
  export interface GlinerConfig { threshold: number; labels: string[]; labelMap: Record<string, EntityType> }
  export async function loadGlinerConfig(path: string): Promise<GlinerConfig>;   // Bun.file(path).json() + shape validation (throws Error on bad shape)
  export interface GlinerDetectorOptions { baseUrl: string; config: GlinerConfig; fetchImpl?: typeof fetch }
  export class GlinerDetector implements SpanDetector {
    readonly name = "gliner";
    constructor(opts: GlinerDetectorOptions);
    detect(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]>;
  }
  export async function verifyGlinerSidecar(baseUrl: string, expectedModelRef: string, fetchImpl?: typeof fetch): Promise<void>;
  // expectedModelRef format "repo@revision"; GET /healthz; mismatch or unreachable → SanitizerError("SANITIZER_UNAVAILABLE", static message)
  ```
- New config (`src/config.ts`): `ZSAN_GLINER_MODEL_REF` (default `urchade/gliner_multi_pii-v1@1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d`) → `glinerModelRef`; `ZSAN_GLINER_CONFIG_PATH` (default `config/gliner.json`) → `glinerConfigPath`. Refinement: when `ZSAN_PASS2=required` and `ZSAN_PASS2_DETECTOR=gliner`, `ZSAN_GLINER_URL` must be set — otherwise `loadConfig` throws listing `ZSAN_GLINER_URL`.

- [ ] **Step 1: Write `config/gliner.json`**

```json
{
  "threshold": 0.4,
  "labels": [
    "person name",
    "street address",
    "postal address including city",
    "username or account handle",
    "organization or company name",
    "phone number",
    "email address"
  ],
  "labelMap": {
    "person name": "PERSON",
    "street address": "ADDRESS",
    "postal address including city": "ADDRESS",
    "username or account handle": "USERNAME",
    "organization or company name": "ORG",
    "phone number": "PHONE",
    "email address": "EMAIL"
  }
}
```
(Labels are zero-shot descriptions — changing them changes recall; the file sits under `config/` for CODEOWNERS. A label missing from `labelMap` means: drop that span.)

> **Superseded by the 2026-09-11 D4 reversal.** The `"organization or company name": "ORG"`
> `labelMap` entry above is no longer shipped — organizations are not redacted at all (see spec
> D4). If this plan is ever (re-)executed, keep `"organization or company name"` in `labels`
> (removing the label would distort the zero-shot scores of every other label — GLiNER's
> confidence is conditioned on the whole label set it's given) but do **not** add it back to
> `labelMap`; an unmapped label is dropped the same way any other unmapped label is. Do not
> silently reinstate org redaction by restoring this block verbatim.

- [ ] **Step 2: Write the failing tests**

`tests/sanitize/detectors/gliner.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { GlinerDetector, loadGlinerConfig, verifyGlinerSidecar } from "@/sanitize/detectors/gliner.ts";
import { SanitizerError } from "@/sanitize/types.ts";

const config = {
  threshold: 0.4,
  labels: ["person name", "street address"],
  labelMap: { "person name": "PERSON" as const, "street address": "ADDRESS" as const },
};

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;
}

describe("GlinerDetector", () => {
  test("posts text, labels and threshold; maps labels to entity types; source gliner", async () => {
    let seen: { url: string; body: any } | undefined;
    const TEXT = "Mette bor på Vestergade 12";
    const d = new GlinerDetector({
      baseUrl: "http://gliner:8000", config,
      fetchImpl: fakeFetch((url, init) => {
        seen = { url, body: JSON.parse(String(init?.body)) };
        return Response.json({ spans: [
          { start: 0, end: 5, label: "person name", score: 0.9 },
          { start: 13, end: 26, label: "street address", score: 0.8 },
          { start: 6, end: 9, label: "unknown label", score: 0.9 },
        ] });
      }),
    });
    const spans = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal });
    expect(seen!.url).toBe("http://gliner:8000/detect");
    expect(seen!.body).toEqual({ text: TEXT, labels: config.labels, threshold: 0.4 });
    expect(spans.map((s) => [s.type, TEXT.slice(s.start, s.end)])).toEqual([
      ["PERSON", "Mette"],
      ["ADDRESS", "Vestergade 12"],
    ]);
    expect(spans.every((s) => s.source === "gliner")).toBe(true);
  });

  test("translates code-point offsets to UTF-16 (emoji before the span)", async () => {
    const TEXT = "😀😀 Hilsen Mette Sørensen";
    // code points: 😀=1 each → "Mette Sørensen" is cp [10,24); UTF-16 [12,26)
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [{ start: 10, end: 24, label: "person name", score: 0.9 }] })),
    });
    const spans = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal });
    expect(TEXT.slice(spans[0]!.start, spans[0]!.end)).toBe("Mette Sørensen");
  });

  test("drops malformed spans (missing/non-integer/out-of-range offsets, bad score)", async () => {
    const TEXT = "abcdef";
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [
        { start: 0, end: 3, label: "person name", score: 0.9 },
        { end: 3, label: "person name", score: 0.9 },
        { start: "1", end: 3, label: "person name", score: 0.9 },
        { start: 2, end: 99, label: "person name", score: 0.9 },
        { start: 0, end: 3, label: "person name", score: "high" },
      ] })),
    });
    const spans = await d.detect({ id: "c", text: TEXT }, { signal: new AbortController().signal });
    expect(spans).toHaveLength(1);
  });

  test("below-threshold spans are dropped client-side too", async () => {
    const d = new GlinerDetector({
      baseUrl: "http://g", config,
      fetchImpl: fakeFetch(() => Response.json({ spans: [{ start: 0, end: 3, label: "person name", score: 0.2 }] })),
    });
    expect(await d.detect({ id: "c", text: "abcdef" }, { signal: new AbortController().signal })).toEqual([]);
  });

  test("empty text short-circuits without a network call", async () => {
    let called = false;
    const d = new GlinerDetector({ baseUrl: "http://g", config, fetchImpl: fakeFetch(() => { called = true; return Response.json({ spans: [] }); }) });
    expect(await d.detect({ id: "c", text: "" }, { signal: new AbortController().signal })).toEqual([]);
    expect(called).toBe(false);
  });

  test("non-2xx / network error / non-object body → SANITIZER_UNAVAILABLE", async () => {
    for (const impl of [
      fakeFetch(() => new Response("boom", { status: 500 })),
      fakeFetch(() => { throw new TypeError("fetch failed"); }),
      fakeFetch(() => Response.json([1, 2])),
    ]) {
      const d = new GlinerDetector({ baseUrl: "http://g", config, fetchImpl: impl });
      const err = await d.detect({ id: "c", text: "abc def ghi" }, { signal: new AbortController().signal }).catch((e) => e);
      expect(err).toBeInstanceOf(SanitizerError);
      expect((err as SanitizerError).code).toBe("SANITIZER_UNAVAILABLE");
    }
  });
});

describe("verifyGlinerSidecar", () => {
  test("passes on matching model ref", async () => {
    await verifyGlinerSidecar("http://g", "repo/x@abc",
      fakeFetch(() => Response.json({ model_id: "repo/x", revision: "abc", status: "ok" })));
  });
  test("throws SANITIZER_UNAVAILABLE on mismatch and on unreachable", async () => {
    for (const impl of [
      fakeFetch(() => Response.json({ model_id: "repo/x", revision: "OTHER", status: "ok" })),
      fakeFetch(() => { throw new TypeError("fetch failed"); }),
    ]) {
      const err = await verifyGlinerSidecar("http://g", "repo/x@abc", impl).catch((e) => e);
      expect((err as SanitizerError).code).toBe("SANITIZER_UNAVAILABLE");
    }
  });
});

describe("loadGlinerConfig", () => {
  test("loads the repo config and validates shape", async () => {
    const c = await loadGlinerConfig("config/gliner.json");
    expect(c.threshold).toBeGreaterThan(0);
    expect(c.labels.length).toBeGreaterThan(0);
    for (const label of Object.keys(c.labelMap)) expect(c.labels).toContain(label);
  });
});
```

Extend `tests/config.test.ts` with:
```ts
  test("gliner defaults and required-url refinement", () => {
    const c = loadConfig({ ...minimal, ZSAN_PASS2: "off" });
    expect(c.glinerModelRef).toBe("urchade/gliner_multi_pii-v1@1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d");
    expect(c.glinerConfigPath).toBe("config/gliner.json");
    expect(() => loadConfig({ ...minimal, ZSAN_PASS2: "required" })).toThrow(/ZSAN_GLINER_URL/);
    const ok = loadConfig({ ...minimal, ZSAN_PASS2: "required", ZSAN_GLINER_URL: "http://127.0.0.1:5003" });
    expect(ok.glinerUrl).toBe("http://127.0.0.1:5003");
  });
```

Run: `bun test tests/sanitize/detectors/gliner.test.ts tests/config.test.ts` → Expected: FAIL (module not found; config refinement missing).

- [ ] **Step 3: Implement**

`src/sanitize/detectors/gliner.ts`:
```ts
import { codePointToUtf16Map } from "../offsets.ts";
import { SanitizerError, type Chunk, type EntityType, type Span, type SpanDetector } from "../types.ts";

export interface GlinerConfig {
  threshold: number;
  labels: string[];
  labelMap: Record<string, EntityType>;
}

export async function loadGlinerConfig(path: string): Promise<GlinerConfig> {
  const raw = (await Bun.file(path).json()) as Partial<GlinerConfig>;
  if (
    typeof raw.threshold !== "number" || raw.threshold <= 0 ||
    !Array.isArray(raw.labels) || raw.labels.length === 0 ||
    typeof raw.labelMap !== "object" || raw.labelMap === null
  ) {
    throw new Error(`invalid gliner config at ${path}`);
  }
  return raw as GlinerConfig;
}

interface GlinerSpan { start: number; end: number; label: string; score: number }

export interface GlinerDetectorOptions { baseUrl: string; config: GlinerConfig; fetchImpl?: typeof fetch }

export class GlinerDetector implements SpanDetector {
  readonly name = "gliner";
  private readonly baseUrl: string;
  private readonly config: GlinerConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GlinerDetectorOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async detect(chunk: Chunk, { signal }: { signal: AbortSignal }): Promise<Span[]> {
    if (chunk.text.length === 0) return [];
    let body: unknown;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/detect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: chunk.text, labels: this.config.labels, threshold: this.config.threshold }),
        signal,
      });
      if (!res.ok) throw new SanitizerError("SANITIZER_UNAVAILABLE", `gliner returned HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      if (e instanceof SanitizerError) throw e;
      throw new SanitizerError("SANITIZER_UNAVAILABLE", `gliner unreachable: ${e instanceof Error ? e.name : typeof e}`);
    }
    const spansRaw = (body as { spans?: unknown })?.spans;
    if (!Array.isArray(spansRaw)) throw new SanitizerError("SANITIZER_UNAVAILABLE", "gliner returned a malformed body");

    const map = codePointToUtf16Map(chunk.text);
    const spans: Span[] = [];
    for (const r of spansRaw as GlinerSpan[]) {
      const type = this.config.labelMap[r?.label];
      if (!type) continue;
      if (typeof r.score !== "number" || r.score < this.config.threshold) continue;
      if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end > map.length - 1 || r.end <= r.start) continue;
      spans.push({ start: map[r.start]!, end: map[r.end]!, type, score: r.score, source: "gliner" });
    }
    return spans;
  }
}

export async function verifyGlinerSidecar(baseUrl: string, expectedModelRef: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const [repo, revision] = expectedModelRef.split("@");
  let body: { model_id?: string; revision?: string };
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/healthz`);
    if (!res.ok) throw new SanitizerError("SANITIZER_UNAVAILABLE", `gliner healthz returned HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (e) {
    if (e instanceof SanitizerError) throw e;
    throw new SanitizerError("SANITIZER_UNAVAILABLE", "gliner sidecar unreachable");
  }
  if (body.model_id !== repo || body.revision !== revision) {
    throw new SanitizerError("SANITIZER_UNAVAILABLE", "gliner sidecar model/revision does not match the pinned ZSAN_GLINER_MODEL_REF");
  }
}
```

`src/config.ts`: add to the schema
```ts
  ZSAN_GLINER_MODEL_REF: z.string().default("urchade/gliner_multi_pii-v1@1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d"),
  ZSAN_GLINER_CONFIG_PATH: z.string().default("config/gliner.json"),
```
add to `AppConfig`: `glinerModelRef: string; glinerConfigPath: string;` and map them in the return. After `safeParse` succeeds, add the refinement:
```ts
  if (p.ZSAN_PASS2 === "required" && p.ZSAN_PASS2_DETECTOR === "gliner" && !p.ZSAN_GLINER_URL) {
    throw new Error("Invalid configuration:\n  - ZSAN_GLINER_URL: required when ZSAN_PASS2=required and ZSAN_PASS2_DETECTOR=gliner");
  }
```
`.env.example`: under the sidecar section add (comments on their own lines):
```
# GLiNER pass-2 sidecar (required when ZSAN_PASS2=required)
ZSAN_GLINER_URL=http://127.0.0.1:5003
# Pinned model identity the proxy verifies at startup
ZSAN_GLINER_MODEL_REF=urchade/gliner_multi_pii-v1@1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d
# Labels / threshold / entity map (CODEOWNERS-owned)
ZSAN_GLINER_CONFIG_PATH=config/gliner.json
```
and change the template default `ZSAN_PASS2=off` line to `ZSAN_PASS2=required` (with its comment noting `off` = Presidio-only).

- [ ] **Step 4: Run — expect pass; typecheck**

Run: `bun test tests/sanitize/detectors/gliner.test.ts tests/config.test.ts && bun run typecheck`
Expected: all pass, typecheck clean. Then `bun test` (full) for regressions.

- [ ] **Step 5: Commit**

```bash
git add src/sanitize/detectors/gliner.ts config/gliner.json src/config.ts .env.example tests/sanitize/detectors/gliner.test.ts tests/config.test.ts
git commit -m "feat(sanitize): GLiNER pass-2 detector with code-point offset translation and pinned-model verification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Session hardening — hard timeout deadline and code-point-safe chunking

**Files:**
- Modify: `src/sanitize/session.ts` (withTimeout), `src/sanitize/chunking.ts` (hard cut)
- Test: extend `tests/sanitize/session.test.ts`, `tests/sanitize/chunking.test.ts`

**Interfaces:** unchanged public signatures. Backlog must-item 2 and the chunking surrogate-pair item.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sanitize/session.test.ts`:
```ts
  test("a detector that ignores its AbortSignal is still cut off at the deadline", async () => {
    const neverSettles = fakePass1(() => new Promise<never>(() => {})); // ignores signal, never resolves
    const deps = base({ pass1: neverSettles, timeouts: { pass1Ms: 30, pass2Ms: 30 } });
    const started = Date.now();
    const err = await new SanitizeSession(deps).sanitize([{ id: "c1", text: "hello there friend" }]).catch((e) => e);
    expect(err).toBeInstanceOf(SanitizerError);
    expect((err as SanitizerError).code).toBe("SANITIZER_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(2000);
  });
```
Append to `tests/sanitize/chunking.test.ts`:
```ts
  test("a hard cut never splits a surrogate pair", () => {
    const text = "a".repeat(3) + "😀".repeat(4); // no boundaries; 😀 = 2 UTF-16 units
    const pieces = splitText(text, 4); // naive cut at 4 would split the first emoji
    expect(pieces.join("")).toBe(text);
    for (const p of pieces) {
      expect(p).not.toMatch(/^[\uDC00-\uDFFF]/); // no piece starts with a lone low surrogate
      expect(p).not.toMatch(/[\uD800-\uDBFF]$/); // no piece ends with a lone high surrogate
    }
  });
```

Run: `bun test tests/sanitize/session.test.ts tests/sanitize/chunking.test.ts` → Expected: the new session test HANGS or fails (run with `--timeout 5000` and expect a timeout failure — that is the RED); the chunking test FAILS on the surrogate assertions.

- [ ] **Step 2: Implement**

`src/sanitize/session.ts` — in `withTimeout`, reinstate a deadline race alongside the abort (keep the existing per-call/abort wiring intact):
```ts
  private async withTimeout<T>(ms: number, callSignal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const onCallAbort = () => controller.abort();
    if (callSignal.aborted) controller.abort();
    else callSignal.addEventListener("abort", onCallAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => {
        controller.abort();
        rej(new SanitizerError("SANITIZER_UNAVAILABLE", `sanitizer call exceeded ${ms}ms`));
      }, ms);
    });
    try {
      return await Promise.race([
        fn(controller.signal).catch((e) => {
          if (controller.signal.aborted) throw new SanitizerError("SANITIZER_UNAVAILABLE", "sanitizer call aborted or timed out");
          throw e;
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      callSignal.removeEventListener("abort", onCallAbort);
    }
  }
```
(Adapt the exact existing signature — the current implementation already takes the call signal; keep whatever parameter order exists. The essential change: `Promise.race` with a rejecting deadline promise, so a client that ignores its signal cannot hang the session. A late rejection from the abandoned `fn` promise is handled by the `.catch` attached before the race.)

`src/sanitize/chunking.ts` — where the hard cut assigns `cut = maxChars`, round down to a code-point boundary:
```ts
    if (cut <= 0) {
      cut = maxChars;
      // never split a surrogate pair: if the cut lands between a high and low surrogate, back up one unit
      const before = rest.charCodeAt(cut - 1);
      if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
      if (cut === 0) cut = maxChars + 1; // single unbreakable pair wider than the cap: take it whole
    }
```

- [ ] **Step 3: Run — expect pass; full suite; typecheck**

Run: `bun test tests/sanitize/session.test.ts tests/sanitize/chunking.test.ts && bun test && bun run typecheck`
Expected: all green (the previous timeout test from Plan 1 must still pass).

- [ ] **Step 4: Commit**

```bash
git add src/sanitize/session.ts src/sanitize/chunking.ts tests/sanitize/session.test.ts tests/sanitize/chunking.test.ts
git commit -m "fix(sanitize): enforce hard timeout deadline against non-cooperative detectors; code-point-safe hard cuts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Allowlist — occurrence-aware span splitting and tightened subset rule

**Files:**
- Modify: `src/sanitize/allowlist.ts` (findOccurrences + subset rule), `src/sanitize/replace.ts` (splitSpansAroundRanges), `src/sanitize/session.ts` (use both in `apply`), `docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md` (§6.2 amendment)
- Test: extend `tests/sanitize/allowlist.test.ts`, `tests/sanitize/replace.test.ts`, `tests/sanitize/session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // allowlist.ts
  findOccurrences(text: string): Array<[number, number]>;   // UTF-16 ranges of allowlisted terms in text (case-insensitive, whole words, whitespace-flexible), merged and sorted
  // replace.ts
  export function splitSpansAroundRanges(spans: Span[], ranges: Array<[number, number]>, minLen?: number): Span[];
  // a span overlapping a range is split into its non-overlapping remainders; remainders shorter than minLen (default 2) are dropped; spans untouched by any range pass through
  ```
- Subset rule change (spec §6.2 amendment, backlog must-item 4): a span whose words are a subset of a multi-word allowlist term is allowed only if the span has ≥ 2 words, OR is a single word of ≥ 4 alphabetic characters. (`Capture` stays allowed; bare `365` and `A/S` are no longer allowed on their own.)
- Session behaviour (backlog must-item 3): in `apply`, after `allowlist.filter`, run `splitSpansAroundRanges(spans, allowlist.findOccurrences(text))` before `applySpans` — so a long non-allowlisted span containing an allowlisted term no longer swallows it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sanitize/allowlist.test.ts`:
```ts
  test("tightened subset rule: short/numeric single words no longer allowed", () => {
    expect(list.isAllowed("Capture")).toBe(true);      // single word, ≥4 alpha chars
    expect(list.isAllowed("365")).toBe(false);          // numeric — was allowed via "Dynamics 365"-style terms
    expect(list.isAllowed("Business Central")).toBe(true); // ≥2 words
  });

  test("findOccurrences locates allowlisted terms case-insensitively with flexible whitespace", () => {
    const text = "We use BUSINESS  central and continia daily; Contoso does not.";
    const occ = Allowlist.fromText("Business Central\nContinia").findOccurrences(text);
    expect(occ).toEqual([[7, 24], [29, 37]]);
    expect(text.slice(7, 24)).toBe("BUSINESS  central");
    expect(text.slice(29, 37)).toBe("continia");
  });

  test("findOccurrences matches whole words only", () => {
    const occ = Allowlist.fromText("Continia").findOccurrences("Continias product");
    expect(occ).toEqual([]);
  });
```
(If the numeric example term is not in the shared `list`, build a local `Allowlist.fromText("Dynamics 365\nContinia Document Capture\nBusiness Central")` for this test — assert against that.)

Append to `tests/sanitize/replace.test.ts`:
```ts
describe("splitSpansAroundRanges", () => {
  test("splits a span around a protected range, dropping short remainders", () => {
    // text: "group via Continia A/S" — span [0,22), protected [10,22)
    const spans = [s(0, 22, "ORG")];
    const out = splitSpansAroundRanges(spans, [[10, 22]]);
    expect(out).toEqual([s(0, 10, "ORG")]); // "group via " survives as its own span
  });
  test("a span inside a protected range disappears; an untouched span passes through", () => {
    expect(splitSpansAroundRanges([s(2, 6)], [[0, 10]])).toEqual([]);
    expect(splitSpansAroundRanges([s(20, 30)], [[0, 10]])).toEqual([s(20, 30)]);
  });
  test("a range in the middle splits a span in two", () => {
    expect(splitSpansAroundRanges([s(0, 30)], [[10, 20]])).toEqual([s(0, 10), s(20, 30)]);
  });
});
```
Append to `tests/sanitize/session.test.ts`:
```ts
  test("an allowlisted term inside a longer detected span survives sanitization", async () => {
    const text = "the Business Central user group reported it";
    const deps = base({
      allowlist: Allowlist.fromText("Business Central"),
      pass1: fakePass1((c) => spansByLiteral(c.text, [["Business Central user group", "ORG"]], "presidio")),
    });
    const out = await new SanitizeSession(deps).sanitize([{ id: "c1", text }]);
    expect(out.texts.get("c1")).toContain("Business Central");
    expect(out.texts.get("c1")).not.toContain("user group reported it".slice(0, 0)); // no-op guard; the real assertions:
    expect(out.texts.get("c1")).toBe("the Business Central[ORG_1] reported it");
  });
```
(The expected string shows the mechanism: the span is split around the protected range and the remainder " user group" — ≥2 chars — is still redacted. If the exact rendering differs by one leading space, print the actual output and set the expectation to the actual — the two hard requirements are: `Business Central` present, and the remainder redacted, with `pieces.join` losslessness intact.)

Run: `bun test tests/sanitize/allowlist.test.ts tests/sanitize/replace.test.ts tests/sanitize/session.test.ts` → Expected: FAIL (methods missing; subset rule unchanged).

- [ ] **Step 2: Implement**

`src/sanitize/allowlist.ts` — subset rule in `isAllowed`:
```ts
  isAllowed(spanText: string): boolean {
    const n = normalizeValue(spanText);
    if (this.exact.has(n)) return true;
    const words = n.split(" ").filter((w) => w.length > 0);
    if (words.length === 0) return false;
    const qualifies = words.length >= 2 || /^[a-zæøåàâäéèêëíìîïóòôöúùûüß]{4,}$/i.test(words[0]!.normalize("NFC"));
    return qualifies && this.wordSets.some((set) => words.every((w) => set.has(w)));
  }
```
`findOccurrences` (store the raw terms at construction for this):
```ts
  private readonly termPatterns: RegExp[] = []; // built in constructor: one per term

  // in the constructor, for each non-empty normalized term:
  //   const escaped = n.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&")).join("\\s+");
  //   this.termPatterns.push(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"));

  findOccurrences(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const re of this.termPatterns) {
      for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }
```
`src/sanitize/replace.ts`:
```ts
export function splitSpansAroundRanges(spans: Span[], ranges: Array<[number, number]>, minLen = 2): Span[] {
  if (ranges.length === 0) return spans;
  const out: Span[] = [];
  for (const sp of spans) {
    let segments: Array<[number, number]> = [[sp.start, sp.end]];
    for (const [a, b] of ranges) {
      const next: Array<[number, number]> = [];
      for (const [s0, s1] of segments) {
        if (b <= s0 || s1 <= a) { next.push([s0, s1]); continue; }
        if (s0 < a) next.push([s0, a]);
        if (b < s1) next.push([b, s1]);
      }
      segments = next;
    }
    if (segments.length === 1 && segments[0]![0] === sp.start && segments[0]![1] === sp.end) { out.push(sp); continue; }
    for (const [s0, s1] of segments) if (s1 - s0 >= minLen) out.push({ ...sp, start: s0, end: s1 });
  }
  return out;
}
```
`src/sanitize/session.ts` — in the private `apply` (both passes go through it):
```ts
  private apply(text: string, spans: Span[]) {
    const filtered = this.deps.allowlist.filter(text, spans);
    const protectedRanges = this.deps.allowlist.findOccurrences(text);
    const result = applySpans(text, splitSpansAroundRanges(filtered, protectedRanges), this.table);
    for (const sp of result.applied) this.counts[sp.type]++;
    return result;
  }
```
Spec §6.2: append one sentence: "A word-subset match additionally requires the span to have at least two words, or to be a single word of at least four alphabetic characters; and a detected span that overlaps an allowlisted occurrence is split around it, so the allowlisted text always survives."

- [ ] **Step 3: Run — expect pass; check the e2e gate still holds**

Run: `bun test && bun run typecheck` then `ZSAN_E2E=1 bun test tests/e2e`
Expected: unit green; e2e 10/10 (the `allowlist-edge.json` fixture should now ALSO pass if you strengthen it — do so: add `"working group"`-adjacent sweep coverage by appending `"group via Continia A/S was informed."` to its body and `"Continia A/S"` stays in `expected.present`; run e2e again to confirm).

- [ ] **Step 4: Commit**

```bash
git add src/sanitize/allowlist.ts src/sanitize/replace.ts src/sanitize/session.ts tests/sanitize/allowlist.test.ts tests/sanitize/replace.test.ts tests/sanitize/session.test.ts tests/fixtures/tickets/allowlist-edge.json docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md
git commit -m "feat(sanitize): allowlisted occurrences survive longer detected spans; tighten word-subset rule (spec §6.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire pass 2 into the entry points

**Files:**
- Create: `src/server/wiring.ts` (shared composition helper so stdio and the future http entry don't drift)
- Modify: `src/server/stdio.ts`
- Test: `tests/server/wiring.test.ts`

**Interfaces:**
- Consumes: `GlinerDetector`, `loadGlinerConfig`, `verifyGlinerSidecar` (Task 2); everything `stdio.ts` already composes.
- Produces:
  ```ts
  // src/server/wiring.ts
  export interface WiringDeps {           // every external effect injected for tests
    config: AppConfig;
    logger: Logger;
    repoRoot: string;
    loadAllowlist?: typeof Allowlist.fromFile;
    loadRecognizers?: typeof loadRecognizers;
    loadGlinerConfig?: typeof loadGlinerConfig;
    verifyGliner?: typeof verifyGlinerSidecar;
    fetchImpl?: typeof fetch;
  }
  export async function buildSanitizer(deps: WiringDeps): Promise<{ sanitize(result: ToolResult): Promise<SanitizedResult> }>;
  // - pass2 "off": logs the loud warning, pass2 = null
  // - pass2 "required" + detector "gliner": loads config/gliner.json, calls verifyGlinerSidecar(glinerUrl, glinerModelRef)
  //   (throws → caller exits), builds GlinerDetector, wires it as pass2 in every new SanitizeSession
  // - pass2 "required" + detector "ollama": throws Error("ollama detector is not implemented; see spec §6.8") — still Plan 3 territory
  ```
- `stdio.ts` shrinks to: loadConfig → logger → `buildSanitizer` (exit 2 with a static error line if it throws) → spawnUpstream → createProxyServer → connect. The Plan-1 "required exits 2 because no detector exists" branch is REMOVED — required now works.

- [ ] **Step 1: Write the failing tests**

`tests/server/wiring.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildSanitizer } from "@/server/wiring.ts";
import { loadConfig } from "@/config.ts";
import { createLogger } from "@/logging.ts";
import { Allowlist } from "@/sanitize/allowlist.ts";
import { SanitizerError } from "@/sanitize/types.ts";

const minimal = { ZSAN_ZENDESK_SUBDOMAIN: "acme", ZSAN_ZENDESK_EMAIL: "bot@acme.example", ZSAN_ZENDESK_API_TOKEN: "tok" };
const glinerConfig = { threshold: 0.4, labels: ["person name"], labelMap: { "person name": "PERSON" as const } };

function deps(env: Record<string, string>, over: Record<string, unknown> = {}) {
  const lines: string[] = [];
  return {
    lines,
    d: {
      config: loadConfig({ ...minimal, ...env }),
      logger: createLogger({ level: "debug", sink: (l: string) => lines.push(l) }),
      repoRoot: process.cwd(),
      loadAllowlist: async () => Allowlist.fromText("Continia"),
      loadRecognizers: async () => [],
      loadGlinerConfig: async () => glinerConfig,
      verifyGliner: async () => {},
      ...over,
    },
  };
}

describe("buildSanitizer", () => {
  test("pass2=off builds a working sanitizer and warns loudly", async () => {
    const { d, lines } = deps({ ZSAN_PASS2: "off" });
    const s = await buildSanitizer(d as never);
    expect(typeof s.sanitize).toBe("function");
    expect(lines.join("\n")).toContain("ZSAN_PASS2=off");
  });

  test("pass2=required verifies the sidecar identity before returning", async () => {
    let verified: string[] = [];
    const { d } = deps(
      { ZSAN_PASS2: "required", ZSAN_GLINER_URL: "http://127.0.0.1:5003" },
      { verifyGliner: async (url: string, ref: string) => { verified = [url, ref]; } },
    );
    await buildSanitizer(d as never);
    expect(verified[0]).toBe("http://127.0.0.1:5003");
    expect(verified[1]).toContain("urchade/gliner_multi_pii-v1@");
  });

  test("pass2=required propagates a failed identity check", async () => {
    const { d } = deps(
      { ZSAN_PASS2: "required", ZSAN_GLINER_URL: "http://127.0.0.1:5003" },
      { verifyGliner: async () => { throw new SanitizerError("SANITIZER_UNAVAILABLE", "mismatch"); } },
    );
    await expect(buildSanitizer(d as never)).rejects.toThrow(/SANITIZER_UNAVAILABLE|mismatch/);
  });

  test("pass2=required + detector=ollama is rejected as unimplemented", async () => {
    const { d } = deps({ ZSAN_PASS2: "required", ZSAN_PASS2_DETECTOR: "ollama", ZSAN_GLINER_URL: "http://x" });
    await expect(buildSanitizer(d as never)).rejects.toThrow(/ollama/);
  });
});
```

Run: `bun test tests/server/wiring.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/server/wiring.ts` and shrink `stdio.ts`**

`src/server/wiring.ts` — move the sanitizer-composition block out of `stdio.ts` verbatim and extend it:
```ts
import { resolve } from "node:path";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logging.ts";
import { createResultSanitizer, type SanitizedResult, type ToolResult } from "../policy/resultSanitizer.ts";
import { Allowlist } from "../sanitize/allowlist.ts";
import { loadRecognizers as defaultLoadRecognizers } from "../sanitize/cpr.ts";
import { GlinerDetector, loadGlinerConfig as defaultLoadGlinerConfig, verifyGlinerSidecar as defaultVerifyGliner } from "../sanitize/detectors/gliner.ts";
import { PresidioClient } from "../sanitize/presidio.ts";
import { SanitizeSession } from "../sanitize/session.ts";
import type { SpanDetector } from "../sanitize/types.ts";

export interface WiringDeps {
  config: AppConfig;
  logger: Logger;
  repoRoot: string;
  loadAllowlist?: (path: string) => Promise<Allowlist>;
  loadRecognizers?: typeof defaultLoadRecognizers;
  loadGlinerConfig?: typeof defaultLoadGlinerConfig;
  verifyGliner?: typeof defaultVerifyGliner;
  fetchImpl?: typeof fetch;
}

export async function buildSanitizer(deps: WiringDeps): Promise<{ sanitize(result: ToolResult): Promise<SanitizedResult> }> {
  const { config, logger, repoRoot } = deps;
  const allowlist = await (deps.loadAllowlist ?? Allowlist.fromFile)(resolve(repoRoot, config.allowlistPath));
  const recognizers = await (deps.loadRecognizers ?? defaultLoadRecognizers)(resolve(repoRoot, config.recognizersPath));
  const presidio = new PresidioClient({ baseUrl: config.presidioUrl, recognizers, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });

  let pass2: SpanDetector | null = null;
  if (config.pass2 === "off") {
    logger.warn("ZSAN_PASS2=off — running with Presidio only. Contextual PII (addresses, usernames, missed names) will NOT be redacted.");
  } else if (config.pass2Detector === "gliner") {
    const glinerConfig = await (deps.loadGlinerConfig ?? defaultLoadGlinerConfig)(resolve(repoRoot, config.glinerConfigPath));
    await (deps.verifyGliner ?? defaultVerifyGliner)(config.glinerUrl!, config.glinerModelRef, deps.fetchImpl ?? fetch);
    pass2 = new GlinerDetector({ baseUrl: config.glinerUrl!, config: glinerConfig, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    logger.info(`pass2=gliner verified against ${config.glinerModelRef}`);
  } else {
    throw new Error("ollama detector is not implemented; see spec §6.8");
  }

  return createResultSanitizer({
    newSession: () =>
      new SanitizeSession({
        pass1: presidio,
        pass2,
        allowlist,
        timeouts: { pass1Ms: config.timeouts.presidioMs, pass2Ms: config.timeouts.pass2Ms },
        chunkMaxChars: config.chunkMaxChars,
        concurrency: config.concurrency,
      }),
  });
}
```
`src/server/stdio.ts`: replace the config-path resolution + Presidio/sanitizer composition and the old `pass2 === "required"` exit-2 branch with:
```ts
let sanitizer;
try {
  sanitizer = await buildSanitizer({ config, logger, repoRoot });
} catch (e) {
  logger.error(`startup failed: ${e instanceof Error ? e.message : typeof e}`);
  process.exit(2);
}
```
(The startup log line changes from `pass2=off` to reflect the actual mode; keep the version line.) Note: `buildSanitizer` error messages here are static/config-derived, never payload text — logging `e.message` at startup is safe because no ticket data can exist before the first tool call.

- [ ] **Step 3: Run — pass; full suite; typecheck**

Run: `bun test tests/server/wiring.test.ts && bun test && bun run typecheck`
Expected: green. The Plan-1 stdio behaviour tests (if any referenced exit-2-when-required) do not exist as automated tests — but `README.md` and `CLAUDE.md` still describe `ZSAN_PASS2=off bun run start`; update both:
- CLAUDE.md Commands: `bun run start` — runs the stdio proxy with pass 2 (needs Presidio + GLiNER containers up and `.env` filled); `ZSAN_PASS2=off bun run start` for Presidio-only.
- README: laptop-mode walkthrough now says `docker compose … --profile laptop up -d --build` brings up BOTH sidecars, `.env` keeps `ZSAN_PASS2=required`, and the "Known limitations (Plan 1)" section is retitled "Known limitations" with the "no pass 2 yet" bullet removed.

- [ ] **Step 4: Manual smoke (real sidecars, no Zendesk needed)**

With both containers up: `bun run start` from the repo root — expect stderr `pass2=gliner verified against urchade/gliner_multi_pii-v1@1fcf13e…` and the ready line, then Ctrl-C. If `.env` credentials are present this spawns the real upstream — that is fine; do not print any ticket data in your report.

- [ ] **Step 5: Commit**

```bash
git add src/server/wiring.ts src/server/stdio.ts tests/server/wiring.test.ts README.md CLAUDE.md
git commit -m "feat(server): shared wiring builds required GLiNER pass 2 with startup identity check

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: E2E pass-2 gate — promote expectedPass2, typed scorecard

**Files:**
- Modify: `tests/e2e/fixtures.e2e.test.ts`, fixtures `tests/fixtures/tickets/{basic-da,german-partner,attachments}.json`
- Test: this IS the test.

**Interfaces:**
- Harness contract change: with `ZSAN_E2E=1` alone the suite runs pass 1 only (unchanged). With `ZSAN_E2E=1 ZSAN_E2E_PASS2=1` it builds the session with a real `GlinerDetector` (`loadGlinerConfig("config/gliner.json")`, `ZSAN_GLINER_URL` default `http://127.0.0.1:5003`) and ADDITIONALLY asserts `expectedPass2.absent` (backlog acceptance criterion: German street address, name inside `faktura_MetteSørensen.pdf`, lower-case names).
- Scorecard (backlog must-item 8): after all fixtures, print a table `entity-type × {fixtureLang} → caught/leaked` derived per fixture from which `absent`/`expectedPass2.absent` strings were found/leaked, plus the per-fixture `leaked`/`overRedacted` lists. Fixture files gain an optional top-level `"lang": "da"|"en"|"de"` key (add it to all 9 fixtures; harness defaults to `"en"` when missing).

- [ ] **Step 1: Extend the harness (write it first — RED comes from running with pass 2 before any config tuning)**

Modify `tests/e2e/fixtures.e2e.test.ts`:
```ts
const pass2Enabled = process.env.ZSAN_E2E_PASS2 === "1";
// inside the setup, after building presidio:
let pass2 = null as import("@/sanitize/types.ts").SpanDetector | null;
if (pass2Enabled) {
  const glinerConfig = await loadGlinerConfig("config/gliner.json");
  pass2 = new GlinerDetector({ baseUrl: process.env.ZSAN_GLINER_URL ?? "http://127.0.0.1:5003", config: glinerConfig });
}
// session deps: pass2 instead of null; timeouts.pass2Ms 60_000
```
Assertions per fixture: as today for `expected.absent`/`present`; when `pass2Enabled`, also `const leaked2 = (fx.expectedPass2?.absent ?? []).filter((s) => lower.includes(s.toLowerCase())); expect(leaked2).toEqual([]);`
Scorecard: build `scorecard[file] = { lang, leaked, leaked2, overRedacted }` and after the loop print a per-language summary:
```ts
test("scorecard", () => {
  const byLang: Record<string, { checked: number; leaked: number }> = {};
  for (const [f, r] of Object.entries(scorecard)) {
    const l = (byLang[r.lang] ??= { checked: 0, leaked: 0 });
    l.checked += r.absentChecked; l.leaked += r.leaked.length + (r.leaked2?.length ?? 0);
  }
  console.error("\n=== scorecard (pass2=" + (pass2Enabled ? "gliner" : "off") + ") ===\n" + JSON.stringify({ byLang, perFixture: scorecard }, null, 2));
});
```
(Adapt names to the existing harness structure — keep its style; `absentChecked` = number of absent strings checked for that fixture.)

- [ ] **Step 2: Add `"lang"` to all 9 fixtures** (`basic-da` → `da`, `german-partner` → `de`, rest per content).

- [ ] **Step 3: Run the pass-2 gate — observe RED honestly, then tune CONFIG only**

```bash
ZSAN_E2E=1 bun test tests/e2e                       # must stay green (pass-1 regression)
ZSAN_E2E=1 ZSAN_E2E_PASS2=1 bun test tests/e2e      # first run: some expectedPass2 strings may leak
```
For each pass-2 leak decide: (a) label/threshold tuning in `config/gliner.json` (e.g. add a label like `"file name containing a person name"` for the filename case, or lower `threshold` to 0.35) → re-run; (b) if a string cannot be caught at any reasonable threshold, MOVE it back with a `reasons` note updated to say GLiNER misses it and flag DONE_WITH_CONCERNS — this is a measurement, not a failure to hide. NEVER weaken `expected.absent` (pass-1 strings). Record the before/after scorecard in your report — this is the Danish-recall answer the spec (§16) has been waiting for.

- [ ] **Step 4: Full verification + commit**

```bash
bun run typecheck && bun test && ZSAN_CONTRACT=1 bun test tests/contract && ZSAN_E2E=1 bun test tests/e2e && ZSAN_E2E=1 ZSAN_E2E_PASS2=1 bun test tests/e2e
```
```bash
git add tests/e2e/fixtures.e2e.test.ts tests/fixtures/tickets config/gliner.json
git commit -m "test(e2e): pass-2 gate promotes expectedPass2 assertions; per-language scorecard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `add_ticket_comment` — internal-only with outgoing inspection

**Files:**
- Modify: `src/policy/toolPolicy.ts`, `src/server/proxy.ts`
- Test: extend `tests/policy/toolPolicy.test.ts`, `tests/server/proxy.test.ts`

**Interfaces:**
- Produces (`toolPolicy.ts`):
  ```ts
  export const READ_ONLY_TOOLS: ReadonlySet<string>;         // unchanged 8
  export const WRITE_TOOLS: ReadonlySet<string>;             // new Set(["add_ticket_comment"])
  export function isAllowedTool(name: string): boolean;      // READ_ONLY ∪ WRITE
  export class OutgoingRejectedError extends Error { readonly reason: "public_comment" | "placeholder_in_body" }
  export function rewriteOutgoingArguments(name: string, args: Record<string, unknown>): Record<string, unknown>;
  // for add_ticket_comment: throws OutgoingRejectedError("public_comment") if args.type === "public";
  //   throws OutgoingRejectedError("placeholder_in_body") if String(args.body ?? "") contains a [TYPE_n] token
  //   (checked with PLACEHOLDER_RE via matchAll — NEVER .test/.exec, shared /g instance);
  //   returns { ...args, type: "internal" } with author_id removed. For every other tool: returns args unchanged.
  export function amendToolList<T extends { name: string; description?: string }>(tools: T[]): T[];
  // filters by isAllowedTool AND rewrites add_ticket_comment's description to state it posts INTERNAL notes only
  ```
- `proxy.ts` CallTool handler: `args = rewriteOutgoingArguments(name, args)` inside a try that maps `OutgoingRejectedError` → `McpError(ErrorCode.InvalidParams, "OUTGOING_REJECTED: <static sentence per reason>")` (public: "the sanitizing proxy only posts internal notes — omit type or pass 'internal'"; placeholder: "the comment body contains sanitization placeholders like [PERSON_1]; replace them with real text before posting"). ListTools handler switches `filterToolList` → `amendToolList`. Spec §3.2 is the authority.

- [ ] **Step 1: Write the failing tests**

Append to `tests/policy/toolPolicy.test.ts`:
```ts
describe("outgoing policy", () => {
  test("add_ticket_comment is allowed; other writes stay blocked", () => {
    expect(isAllowedTool("add_ticket_comment")).toBe(true);
    expect(isAllowedTool("update_ticket")).toBe(false);
  });
  test("forces internal and strips author_id", () => {
    const out = rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: "ok", type: "internal", author_id: 99 });
    expect(out).toEqual({ id: 1, body: "ok", type: "internal" });
    const defaulted = rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: "ok" });
    expect(defaulted.type).toBe("internal");
  });
  test("rejects public comments", () => {
    expect(() => rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: "ok", type: "public" }))
      .toThrow(OutgoingRejectedError);
  });
  test("rejects placeholder tokens in the body — including repeated calls (shared /g regex)", () => {
    for (let i = 0; i < 3; i++) {
      expect(() => rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: `ping [PERSON_${i + 1}] about it` }))
        .toThrow(OutgoingRejectedError);
    }
    expect(() => rewriteOutgoingArguments("add_ticket_comment", { id: 1, body: "no tokens [PERSON_x] here" })).not.toThrow();
  });
  test("other tools pass through untouched", () => {
    const args = { id: 1, body: "[PERSON_1]" };
    expect(rewriteOutgoingArguments("get_ticket", args)).toBe(args);
  });
  test("amendToolList rewrites the comment tool's description and still filters", () => {
    const tools = [
      { name: "add_ticket_comment", description: "Append a comment." },
      { name: "delete_ticket", description: "x" },
      { name: "get_ticket", description: "y" },
    ];
    const out = amendToolList(tools);
    expect(out.map((t) => t.name)).toEqual(["add_ticket_comment", "get_ticket"]);
    expect(out[0]!.description).toContain("internal");
  });
});
```
Append to `tests/server/proxy.test.ts` (reuse its `connect`/fake-upstream helpers; add `add_ticket_comment` to the fake upstream's tool list):
```ts
  test("public comment is rejected with a static error and never reaches upstream", async () => {
    const up = fakeUpstream();
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "add_ticket_comment", arguments: { id: 1, body: "hi", type: "public" } }).catch((e) => e);
    expect(String(err.message)).toContain("OUTGOING_REJECTED");
    expect(up.calls).toEqual([]);
  });

  test("placeholder in body is rejected; clean internal comment is forwarded with author_id stripped", async () => {
    const up = fakeUpstream();
    const client = await connect({ upstream: up, sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    const err = await client.callTool({ name: "add_ticket_comment", arguments: { id: 1, body: "tell [PERSON_1]" } }).catch((e) => e);
    expect(String(err.message)).toContain("OUTGOING_REJECTED");
    await client.callTool({ name: "add_ticket_comment", arguments: { id: 1, body: "resolved via KB-42", author_id: 7 } });
    expect(up.calls).toEqual([["add_ticket_comment", { id: 1, body: "resolved via KB-42", type: "internal" }]]);
  });
```
Run: `bun test tests/policy/toolPolicy.test.ts tests/server/proxy.test.ts` → Expected: FAIL (exports missing).

- [ ] **Step 2: Implement** per the Interfaces block. In `proxy.ts`, the rewrite runs AFTER the allowlist check and BEFORE the upstream call; the upstream response is sanitized like any other (it echoes the created comment). `OutgoingRejectedError` catch logs `logger.warn(\`${name} outgoing rejected (${e.reason})\`)` — the body is never logged.

- [ ] **Step 3: Run — pass; full suite; typecheck.** Also update the README tools table: `add_ticket_comment` row "forwarded — forced internal, placeholder bodies rejected"; move it out of the blocked list.

- [ ] **Step 4: Commit**

```bash
git add src/policy/toolPolicy.ts src/server/proxy.ts tests/policy/toolPolicy.test.ts tests/server/proxy.test.ts README.md
git commit -m "feat(policy): internal-only add_ticket_comment with outgoing placeholder inspection (spec §3.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Upstream restart-once (spec §8)

**Files:**
- Create: `src/upstream/restart.ts`
- Modify: `src/upstream/child.ts` (expose close notification), `src/server/stdio.ts` (wrap)
- Test: `tests/upstream/restart.test.ts`

**Interfaces:**
- Consumes: `UpstreamClient`, `ToolDefinition` (`src/upstream/client.ts`); `Logger`.
- Produces:
  ```ts
  // child.ts addition: SpawnedUpstream extends UpstreamClient with close notification
  export interface SpawnedUpstream extends UpstreamClient { onUnexpectedClose(cb: () => void): void }
  // spawnUpstream return type becomes SpawnedUpstream: wire the SDK Client's `onclose` to the callback,
  // but NOT when close() was requested (guard with an internal `closing` flag).

  // restart.ts
  export interface RestartOptions { factory: () => Promise<SpawnedUpstream>; backoffMs: number; logger: Logger }
  export function createRestartingUpstream(opts: RestartOptions): Promise<UpstreamClient>;
  // resolves once the first child is up. On unexpected close: logs, waits backoffMs, calls factory ONCE more.
  // While down or after the second death: listTools/callTool throw Error("upstream unavailable (restarting or dead)")
  // — the proxy already maps any upstream throw to UPSTREAM_UNAVAILABLE. After the second unexpected close, stays dead.
  // close() closes the current child (if any) and disables restarts.
  ```

- [ ] **Step 1: Write the failing tests**

`tests/upstream/restart.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { createRestartingUpstream } from "@/upstream/restart.ts";
import { createLogger } from "@/logging.ts";
import type { SpawnedUpstream } from "@/upstream/child.ts";

function fakeChild() {
  let closeCb: (() => void) | undefined;
  const child: SpawnedUpstream & { die: () => void; closed: boolean } = {
    closed: false,
    async listTools() { return [{ name: "get_ticket", inputSchema: {} }]; },
    async callTool(name) { return { content: [{ type: "text", text: `ok:${name}` }] }; },
    async close() { child.closed = true; },
    onUnexpectedClose(cb) { closeCb = cb; },
    die() { closeCb?.(); },
  };
  return child;
}

const logger = () => createLogger({ level: "error", sink: () => {} });

describe("createRestartingUpstream", () => {
  test("delegates to the child and restarts once after an unexpected close", async () => {
    const children = [fakeChild(), fakeChild()];
    let spawns = 0;
    const up = await createRestartingUpstream({ factory: async () => children[spawns++]!, backoffMs: 10, logger: logger() });
    expect(spawns).toBe(1);
    await up.callTool("get_ticket", {});
    children[0]!.die();
    const err = await up.callTool("get_ticket", {}).catch((e) => e); // during backoff
    expect(String(err.message)).toContain("upstream unavailable");
    await new Promise((r) => setTimeout(r, 50));
    expect(spawns).toBe(2);
    expect((await up.callTool("get_ticket", {})).content[0]).toEqual({ type: "text", text: "ok:get_ticket" });
  });

  test("stays dead after the second unexpected close", async () => {
    const children = [fakeChild(), fakeChild(), fakeChild()];
    let spawns = 0;
    const up = await createRestartingUpstream({ factory: async () => children[spawns++]!, backoffMs: 5, logger: logger() });
    children[0]!.die();
    await new Promise((r) => setTimeout(r, 30));
    children[1]!.die();
    await new Promise((r) => setTimeout(r, 30));
    expect(spawns).toBe(2);
    const err = await up.listTools().catch((e) => e);
    expect(String(err.message)).toContain("upstream unavailable");
  });

  test("close() disables restarts", async () => {
    const children = [fakeChild(), fakeChild()];
    let spawns = 0;
    const up = await createRestartingUpstream({ factory: async () => children[spawns++]!, backoffMs: 5, logger: logger() });
    await up.close();
    expect(children[0]!.closed).toBe(true);
    children[0]!.die(); // simulate the close event arriving after close()
    await new Promise((r) => setTimeout(r, 30));
    expect(spawns).toBe(1);
  });
});
```
Run: `bun test tests/upstream/restart.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

`src/upstream/child.ts`: add the `SpawnedUpstream` interface; in `spawnUpstream`, add `let requestedClose = false;` and `const closeCbs: Array<() => void> = [];` set `client.onclose = () => { if (!requestedClose) for (const cb of closeCbs) cb(); };` return `{ ..., onUnexpectedClose: (cb) => closeCbs.push(cb), close: async () => { requestedClose = true; await client.close(); } }`.

`src/upstream/restart.ts`:
```ts
import type { Logger } from "../logging.ts";
import type { ToolDefinition, UpstreamClient } from "./client.ts";
import type { SpawnedUpstream } from "./child.ts";
import type { ToolResult } from "../policy/resultSanitizer.ts";

export interface RestartOptions { factory: () => Promise<SpawnedUpstream>; backoffMs: number; logger: Logger }

export async function createRestartingUpstream(opts: RestartOptions): Promise<UpstreamClient> {
  let current: SpawnedUpstream | null = null;
  let restartsLeft = 1;
  let shuttingDown = false;

  const attach = (child: SpawnedUpstream) => {
    current = child;
    child.onUnexpectedClose(() => {
      if (shuttingDown || current !== child) return;
      current = null;
      if (restartsLeft <= 0) { opts.logger.error("upstream child exited again — staying down"); return; }
      restartsLeft -= 1;
      opts.logger.warn(`upstream child exited — restarting once in ${opts.backoffMs}ms`);
      setTimeout(async () => {
        if (shuttingDown) return;
        try { attach(await opts.factory()); opts.logger.info("upstream child restarted"); }
        catch { opts.logger.error("upstream child restart failed — staying down"); }
      }, opts.backoffMs);
    });
  };
  attach(await opts.factory());

  const live = (): SpawnedUpstream => {
    if (!current) throw new Error("upstream unavailable (restarting or dead)");
    return current;
  };
  return {
    listTools: (): Promise<ToolDefinition[]> => live().listTools(),
    callTool: (name: string, args: Record<string, unknown>): Promise<ToolResult> => live().callTool(name, args),
    close: async () => { shuttingDown = true; await current?.close().catch(() => {}); current = null; },
  };
}
```
`src/server/stdio.ts`: `const upstream = await createRestartingUpstream({ factory: () => spawnUpstream({ command: config.upstreamCommand, zendesk: config.zendesk, onStderrLine: (l) => logger.debug(l) }), backoffMs: 2000, logger });`
Also delete the corresponding "Known limitations" README bullet.

- [ ] **Step 3: Run — pass; full suite; typecheck. Commit**

```bash
git add src/upstream/restart.ts src/upstream/child.ts src/server/stdio.ts tests/upstream/restart.test.ts README.md
git commit -m "feat(upstream): restart child once with back-off on unexpected exit (spec §8)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Streamable HTTP transport with bearer tokens

**Files:**
- Create: `src/server/http.ts`
- Modify: `src/config.ts` (transport keys), `.env.example`, `package.json` (script `start:http`)
- Test: `tests/server/http.test.ts`, extend `tests/config.test.ts`

**Interfaces:**
- New config: `ZSAN_TRANSPORT` (`stdio|http`, default `stdio`) → `transport`; `ZSAN_HTTP_PORT` (coerced int, default `8080`) → `httpPort`; `ZSAN_CLIENT_TOKENS` (default `""`, format `name:token,name:token`) → `clientTokens: Map<string, string>` (token → name). Refinement: `transport === "http"` requires at least one token — otherwise `loadConfig` throws listing `ZSAN_CLIENT_TOKENS`.
- Produces (`src/server/http.ts`):
  ```ts
  export interface HttpProxyDeps {
    createServer: () => Server;          // fresh MCP Server per session — call createProxyServer(proxyDeps)
    tokens: Map<string, string>;         // token → developer name (for the log line only)
    port: number;                        // 0 = ephemeral (tests)
    logger: Logger;
  }
  export function startHttpProxy(deps: HttpProxyDeps): { port: number; stop(): Promise<void> };
  ```
- Semantics: `Bun.serve({ port, fetch })`. Every request except `GET /healthz` requires `Authorization: Bearer <token>` present in `tokens` — otherwise `401` with static body `{"error":"unauthorized"}` (never echo the token). `/mcp` routes to a session map: a POST without an `mcp-session-id` header creates `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (id) => sessions.set(id, transport) })`, connects a fresh `deps.createServer()` to it, and returns `transport.handleRequest(req)`; requests carrying a known `mcp-session-id` are handed to that session's transport; unknown session id → `404` static body. `transport.onclose` deletes the session. `GET /healthz` → `200 {"status":"ok"}` unauthenticated. Log lines: `http session opened for <name>` / `http 401` — never tokens.
- SDK import: `import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";` (verified present in 1.30.0; `handleRequest(req: Request): Promise<Response>`).

- [ ] **Step 1: Write the failing tests**

`tests/server/http.test.ts` (real HTTP against an ephemeral port; fake upstream + ok-sanitizer reused from the proxy tests — import the same helpers or re-declare them locally exactly as in `tests/server/proxy.test.ts`):
```ts
import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpProxy } from "@/server/http.ts";
import { createProxyServer } from "@/server/proxy.ts";
import { createLogger } from "@/logging.ts";
import type { UpstreamClient } from "@/upstream/client.ts";
import type { ToolResult } from "@/policy/resultSanitizer.ts";

function fakeUpstream(): UpstreamClient {
  return {
    async listTools() { return [{ name: "get_ticket", inputSchema: { type: "object" } }]; },
    async callTool() { return { content: [{ type: "text", text: "RAW" }] } as ToolResult; },
    async close() {},
  };
}
const okSanitizer = { async sanitize(_r: ToolResult) { return { result: { content: [{ type: "text" as const, text: "SANITIZED" }] }, counts: {} as never, perPass: { pass1: 0, pass2: 0 } }; } };
const logger = createLogger({ level: "error", sink: () => {} });

const handle = startHttpProxy({
  createServer: () => createProxyServer({ upstream: fakeUpstream(), sanitizer: okSanitizer, logger }),
  tokens: new Map([["sekret-token-1", "rene"]]),
  port: 0,
  logger,
});
afterAll(() => handle.stop());
const base = `http://127.0.0.1:${handle.port}`;

describe("http transport", () => {
  test("healthz is open", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  test("missing or wrong bearer token → 401, token never echoed", async () => {
    const r1 = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
    expect(r2.status).toBe(401);
    expect(await r2.text()).not.toContain("wrong");
  });

  test("full MCP round-trip over HTTP with a valid token", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer sekret-token-1" } },
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_ticket"]);
    const res = await client.callTool({ name: "get_ticket", arguments: { id: 1 } });
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe("SANITIZED");
    await client.close();
  });

  test("two clients get isolated sessions", async () => {
    const mk = async () => {
      const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer sekret-token-1" } } });
      const c = new Client({ name: "t", version: "0" });
      await c.connect(t);
      return c;
    };
    const [a, b] = [await mk(), await mk()];
    expect((await a.listTools()).tools).toHaveLength(1);
    expect((await b.listTools()).tools).toHaveLength(1);
    await a.close(); await b.close();
  });

  test("unknown session id → 404", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer sekret-token-1", "mcp-session-id": "nope", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(404);
  });
});
```
Extend `tests/config.test.ts`:
```ts
  test("http transport requires client tokens; token map parses", () => {
    expect(() => loadConfig({ ...minimal, ZSAN_TRANSPORT: "http" })).toThrow(/ZSAN_CLIENT_TOKENS/);
    const c = loadConfig({ ...minimal, ZSAN_TRANSPORT: "http", ZSAN_CLIENT_TOKENS: "rene:tok1,mia:tok2" });
    expect(c.transport).toBe("http");
    expect(c.httpPort).toBe(8080);
    expect(c.clientTokens.get("tok1")).toBe("rene");
    expect(c.clientTokens.get("tok2")).toBe("mia");
    expect(loadConfig(minimal).transport).toBe("stdio");
  });
```
Run: `bun test tests/server/http.test.ts tests/config.test.ts` → Expected: FAIL (module/keys missing).

- [ ] **Step 2: Implement**

`src/config.ts`: schema keys `ZSAN_TRANSPORT: z.enum(["stdio","http"]).default("stdio")`, `ZSAN_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080)`, `ZSAN_CLIENT_TOKENS: z.string().default("")`; parse tokens `name:token` pairs → `clientTokens: Map<token, name>` (skip empty entries; malformed entry without `:` → throw). Refinement: http + empty map → throw listing `ZSAN_CLIENT_TOKENS`.

`src/server/http.ts`:
```ts
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Logger } from "../logging.ts";

export interface HttpProxyDeps {
  createServer: () => Server;
  tokens: Map<string, string>;
  port: number;
  logger: Logger;
}

const UNAUTHORIZED = () => Response.json({ error: "unauthorized" }, { status: 401 });

export function startHttpProxy(deps: HttpProxyDeps): { port: number; stop(): Promise<void> } {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const server = Bun.serve({
    port: deps.port,
    idleTimeout: 120,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") return Response.json({ status: "ok" });

      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const who = deps.tokens.get(token);
      if (!who) { deps.logger.warn("http 401"); return UNAUTHORIZED(); }

      if (url.pathname !== "/mcp") return Response.json({ error: "not found" }, { status: 404 });

      const sessionId = req.headers.get("mcp-session-id");
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) return Response.json({ error: "unknown session" }, { status: 404 });
        return existing.handleRequest(req);
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          deps.logger.info(`http session opened for ${who}`);
        },
      });
      transport.onclose = () => {
        for (const [id, t] of sessions) if (t === transport) sessions.delete(id);
      };
      await deps.createServer().connect(transport);
      return transport.handleRequest(req);
    },
  });

  return {
    port: server.port,
    stop: async () => {
      for (const t of sessions.values()) await t.close().catch(() => {});
      sessions.clear();
      await server.stop(true);
    },
  };
}
```
`src/server/stdio.ts` gains a branch at the end (or a sibling entry — keep it in `stdio.ts` renamed logic-free: if `config.transport === "http"`, call `startHttpProxy({ createServer: () => createProxyServer({ upstream, sanitizer, logger }), tokens: config.clientTokens, port: config.httpPort, logger })` and log the port instead of connecting the stdio transport). Note: each HTTP session gets its own MCP `Server` but they intentionally SHARE the single upstream child and sanitizer factory. `package.json`: add `"start:http": "ZSAN_TRANSPORT=http bun run src/server/stdio.ts"` — on Windows this env-prefix syntax fails in cmd but the script runs under Bun's shell which supports it; verify with `bun run start:http` (expect the ZSAN_CLIENT_TOKENS config error, which proves the wiring). `.env.example`: add the three keys with comments on their own lines.

- [ ] **Step 3: Run — pass; full suite; typecheck. Commit**

```bash
git add src/server/http.ts src/server/stdio.ts src/config.ts package.json .env.example tests/server/http.test.ts tests/config.test.ts
git commit -m "feat(server): Streamable HTTP transport with per-developer bearer tokens and session isolation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: VM deploy artifacts (proxy container, Caddy TLS, setup script, docs)

**Files:**
- Create: `sidecars/proxy/Dockerfile`, `deploy/Caddyfile`, `deploy/vm-setup.sh`
- Modify: `deploy/docker-compose.yml` (proxy + caddy services, `vm` profile), `README.md` (VM mode section), `docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md` (§16: mark the `.mcp.json` header-interpolation item as an install-time verification step)
- Test: manual compose smoke on this machine (documented below); no unit tests — these are deployment artifacts.

**Interfaces:** the proxy container runs `bun run src/server/stdio.ts` with `ZSAN_TRANSPORT=http`, `ZSAN_PRESIDIO_URL=http://presidio-analyzer:3000`, `ZSAN_GLINER_URL=http://gliner:8000`; Caddy terminates TLS on 443 → `proxy:8080`. Zendesk credentials and `ZSAN_CLIENT_TOKENS` come from `/opt/zsan/.env` on the VM (compose `env_file`), never from the image.

- [ ] **Step 1: Write the artifacts**

`sidecars/proxy/Dockerfile`:
```dockerfile
FROM oven/bun:1.3.9-slim
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY config ./config
ENV ZSAN_TRANSPORT=http
EXPOSE 8080
CMD ["bun", "run", "src/server/stdio.ts"]
```
Compose additions (profile `vm` only):
```yaml
  proxy:
    build:
      context: ..
      dockerfile: sidecars/proxy/Dockerfile
    image: zsan/proxy:dev
    profiles: [vm]
    restart: unless-stopped
    env_file:
      - ${ZSAN_ENV_FILE:-/opt/zsan/.env}
    environment:
      ZSAN_TRANSPORT: http
      ZSAN_HTTP_PORT: "8080"
      ZSAN_PRESIDIO_URL: http://presidio-analyzer:3000
      ZSAN_GLINER_URL: http://gliner:8000
    depends_on:
      presidio-analyzer:
        condition: service_healthy
      gliner:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "bun -e \"const r=await fetch('http://localhost:8080/healthz'); if(!r.ok) process.exit(1)\""]
      interval: 15s
      timeout: 5s
      retries: 10

  caddy:
    image: caddy:2-alpine
    profiles: [vm]
    restart: unless-stopped
    ports:
      - "443:443"
    volumes:
      - ../deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    depends_on:
      - proxy
```
(add `volumes: caddy-data: {}` at file bottom). Note the presidio/gliner services must NOT publish ports in the vm profile — they already bind to `127.0.0.1` on the host, which is acceptable on the VM too; leave as-is and note it.

`deploy/Caddyfile`:
```
{$ZSAN_DOMAIN:localhost} {
	reverse_proxy proxy:8080
	# With a real ZSAN_DOMAIN and public DNS, Caddy provisions Let's Encrypt automatically.
	# For a lab VM without public DNS, `localhost` uses Caddy's internal CA (self-signed).
}
```

`deploy/vm-setup.sh` (Ubuntu 24.04, run as a sudo-capable user):
```bash
#!/usr/bin/env bash
# One-time setup for the ZendeskSanitizing VM (Ubuntu 24.04). Review before running.
set -euo pipefail

sudo apt-get update && sudo apt-get install -y ca-certificates curl git ufw
# Docker Engine + compose plugin (official repo)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"

# Firewall: SSH + HTTPS only
sudo ufw allow OpenSSH && sudo ufw allow 443/tcp && sudo ufw --force enable

sudo mkdir -p /opt/zsan && sudo chown "$USER" /opt/zsan
cat <<'EOF'
Next steps (manual):
  1. git clone the repo, e.g. into /opt/zsan/app
  2. Create /opt/zsan/.env with ZSAN_ZENDESK_*, ZSAN_CLIENT_TOKENS (name:token per developer), ZSAN_PASS2=required
  3. export ZSAN_DOMAIN=<your-dns-name>   (or leave unset for self-signed localhost testing)
  4. cd /opt/zsan/app && docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile vm up -d --build
  5. Verify: curl -k https://localhost/healthz
Note: Node/npx come via the proxy image (bun runs npx? NO — the upstream child needs node/npx INSIDE the proxy container: the oven/bun image does not ship node. See Dockerfile note.)
EOF
```
**Dockerfile note (must handle):** the proxy spawns `npx -y @sshadows/zendesk-mcp-server@1.4.1`, which requires Node inside the proxy container. Extend `sidecars/proxy/Dockerfile` after the FROM line:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*
```
(and remove the confusing trailing note from `vm-setup.sh` — pre-installing the upstream package into the image is a fine optional optimisation: `RUN npm install -g @sshadows/zendesk-mcp-server@1.4.1` and set `ZSAN_UPSTREAM_COMMAND=zendesk-mcp` via compose `environment` — do this; it removes runtime npm downloads and pins the version in the image).

README VM mode section: prerequisites (Ubuntu VM, DNS name optional), the five setup steps, the developer-side `.mcp.json`:
```json
{ "mcpServers": { "zendesk": { "type": "http", "url": "https://<vm-dns>/mcp",
    "headers": { "Authorization": "Bearer ${ZSAN_TOKEN}" } } } }
```
with the note: verify `${ZSAN_TOKEN}` env interpolation works in your Claude Code version at install time (spec §16); fallback `claude mcp add --transport http zendesk https://<vm>/mcp --header "Authorization: Bearer <token>"`. State the security upgrade: in VM mode, Zendesk credentials exist only on the VM.

- [ ] **Step 2: Local smoke of the vm profile (no TLS domain needed)**

```bash
docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile vm build proxy
ZSAN_ENV_FILE=$(pwd)/.env docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile vm up -d proxy
docker compose -f deploy/docker-compose.yml logs proxy | tail -20   # expect: pass2=gliner verified …, http listening
bun -e "const r = await fetch('http://127.0.0.1:8080/healthz'); console.log(r.status)"   # → 200? NO: the proxy port is NOT published
```
Correction baked into the artifacts: for the local smoke, temporarily publish the proxy port via an override file `deploy/docker-compose.smoke.yml` (create it, commit it — it is also useful on the VM for debugging):
```yaml
services:
  proxy:
    ports:
      - "127.0.0.1:8080:8080"
```
Smoke with `-f deploy/docker-compose.yml -f deploy/docker-compose.smoke.yml`; expect `/healthz` 200 and a 401 from `/mcp` without a token. The smoke uses the real repo `.env` via `ZSAN_ENV_FILE` — acceptable on this machine (the file is never read into the session; compose reads it), and the log lines are counts-only by design. Tear down the smoke containers afterwards (`docker compose … --profile vm down` — leave the laptop-profile presidio/gliner running).

- [ ] **Step 3: Commit**

```bash
git add sidecars/proxy deploy/Caddyfile deploy/vm-setup.sh deploy/docker-compose.yml deploy/docker-compose.smoke.yml README.md docs/superpowers/specs/2026-08-27-zendesk-sanitizing-proxy-design.md
git commit -m "feat(deploy): VM mode — containerized proxy with pinned upstream, Caddy TLS, setup script, docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: CI workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/stack.yml`
- Test: YAML validity (`bun x yaml-lint` is NOT available — validate with `bun -e "const {parse}=await import('yaml'); …"`? No: do not add deps. Validate by `docker run --rm -v "$PWD":/w rhysd/actionlint:latest` if Docker allows pulling; otherwise careful review + the controller's review gate).

**Interfaces:** `ci.yml` runs on every PR and push to main: ubuntu-latest, `oven-sh/setup-bun@v2` with `bun-version: 1.3.9`, `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`. `stack.yml` runs on `workflow_dispatch` and nightly cron on a self-hosted runner labeled `zsan`: compose up (laptop profile), contract tests, e2e (pass 1 and pass 2), compose down. The self-hosted runner does not exist yet — the workflow must degrade gracefully (documented, not scheduled-failing): gate the nightly job with `if: ${{ vars.ZSAN_STACK_RUNNER == 'ready' }}` so it no-ops until the repo variable is set.

- [ ] **Step 1: Write the workflows**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.9
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
```
`.github/workflows/stack.yml`:
```yaml
name: stack
on:
  workflow_dispatch:
  schedule:
    - cron: "30 2 * * *"
jobs:
  contract-e2e:
    if: ${{ vars.ZSAN_STACK_RUNNER == 'ready' }}
    runs-on: [self-hosted, zsan]
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.9
      - run: bun install --frozen-lockfile
      - run: docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile laptop up -d --build
      - run: ZSAN_CONTRACT=1 bun test tests/contract
      - run: ZSAN_E2E=1 bun test tests/e2e
      - run: ZSAN_E2E=1 ZSAN_E2E_PASS2=1 bun test tests/e2e
      - if: always()
        run: docker compose -f deploy/docker-compose.yml --profile laptop down
```

- [ ] **Step 2: Validate** — run actionlint if pullable (`docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:latest -color`); if the pull is blocked, re-read both files against the GitHub Actions schema by eye and note that in the report. README: add a CI section (what runs where; how to arm the stack job: register a self-hosted runner on the VM with label `zsan`, then set repo variable `ZSAN_STACK_RUNNER=ready`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows README.md
git commit -m "ci: unit workflow on every PR; nightly contract+e2e stack workflow gated on a self-hosted runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Governance and v0.1.0 release prep

**Files:**
- Create: `.github/CODEOWNERS`, `deploy/github-setup.md`
- Modify: `package.json` (version 0.1.0, drop the duplicated `--preload`), `src/server/proxy.ts` (version from package.json), `tests/upstream/child.spawn.test.ts` (mkTempDir override), `src/sanitize/session.ts` (remove dead `Piece.chunkIndex` if still present), `README.md`
- Test: extend `tests/server/proxy.test.ts` (version reflected), full four-gate verification.

**Interfaces:** `createProxyServer` reports `{ name: "zendesk-sanitizing-proxy", version: pkg.version }` via `import pkg from "../../package.json"`. CODEOWNERS assigns every sanitization-behaviour path to the GDPR owner.

- [ ] **Step 1: Write the failing test** — in `tests/server/proxy.test.ts` add:
```ts
  test("server reports the package version", async () => {
    const client = await connect({ upstream: fakeUpstream(), sanitizer: okSanitizer, logger: createLogger({ level: "error", sink: () => {} }) });
    expect(client.getServerVersion()?.version).toBe("0.1.0");
  });
```
Run: FAIL (`0.0.1`). Then bump `package.json` to `0.1.0`, import it in `proxy.ts`, GREEN.

- [ ] **Step 2: Governance files**

`.github/CODEOWNERS` (GDPR owner placeholder is the repo owner until the real owner has a GitHub account — say so in a comment):
```
# Sanitization behaviour must not change without the GDPR owner's review (spec §12).
# TODO(owner): replace @rf9000 with the GDPR owner's GitHub handle.
/config/                @rf9000
/sidecars/              @rf9000
/deploy/versions.env    @rf9000
/src/policy/            @rf9000
/src/sanitize/          @rf9000
```
`deploy/github-setup.md` — the exact commands the user runs once, after pushing:
````markdown
# One-time GitHub setup (requires admin on rf9000/ZendeskSanitizing)

```bash
git push -u origin main
# Branch protection: PRs required, CI must pass, CODEOWNERS review required
gh api -X PUT repos/rf9000/ZendeskSanitizing/branches/main/protection \
  -f "required_status_checks[strict]=true" -f "required_status_checks[checks][][context]=unit" \
  -F "enforce_admins=true" \
  -F "required_pull_request_reviews[require_code_owner_reviews]=true" \
  -F "required_pull_request_reviews[required_approving_review_count]=1" \
  -F "restrictions=null"
# Arm the nightly stack job once the VM runner exists (label: zsan):
gh variable set ZSAN_STACK_RUNNER --body ready
```
````

- [ ] **Step 3: Polish batch** (backlog): remove `--preload ./tests/setup.ts` from the `test*` scripts in `package.json` (bunfig.toml already preloads — verify by running `bun test` once after the change); pass `mkTempDir: () => tmpdir-under-scratch` in `tests/upstream/child.spawn.test.ts` so runs stop littering; delete `Piece.chunkIndex` in `session.ts` if the field still exists (check first).

- [ ] **Step 4: Full verification** — all four gates plus the pass-2 gate:
```bash
bun run typecheck && bun test && ZSAN_CONTRACT=1 bun test tests/contract && ZSAN_E2E=1 bun test tests/e2e && ZSAN_E2E=1 ZSAN_E2E_PASS2=1 bun test tests/e2e
```
Paste all summaries in the report.

- [ ] **Step 5: Commit and tag (local tag only — no push)**

```bash
git add .github/CODEOWNERS deploy/github-setup.md package.json src/server/proxy.ts src/sanitize/session.ts tests/server/proxy.test.ts tests/upstream/child.spawn.test.ts README.md
git commit -m "chore(release): v0.1.0 — CODEOWNERS, branch-protection runbook, version from package.json

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag -a v0.1.0 -m "First release: sanitizing proxy with Presidio + GLiNER passes, laptop and VM modes"
```

---

## Self-review (recorded for the executor)

**Spec coverage → task:** §3.2 outgoing → T7; §4.2 GLiNER sidecar → T1; §5 tool table (+comment) → T7; §6.2 amendment → T4; §8 restart → T8, hard deadline → T3; §9 HTTP/tokens/VM → T9/T10; §11 scorecard per type/language → T6; §12 CODEOWNERS/versioning/release → T11/T12; §14 steps 4–6 → whole plan; §16 open items (GLiNER Danish recall → T6 measures it; `.mcp.json` header interpolation → T10 install-time note). Backlog must-items: 1→T1/T2 (offsets), 2→T3, 3→T4, 4→T4, 5→T12, 6→T8, 7→T7 (matchAll), 8→T6, 9→T1 (real-TLD note inherited; fixtures already fixed in Plan 1). Ollama detector (spec §6.8): deliberately NOT in this plan — `buildSanitizer` rejects it with a clear error; it remains the post-v0.1.0 bake-off item.

**Known deferred (not gaps):** presidio-anonymizer container (spec §3, optional — never added, note for a spec cleanup); per-detector scorecard comparison requires the Ollama detector, so T6 ships per-language/type only.

**Type consistency:** `SpanDetector.detect(chunk, {signal})` (Plan 1 types.ts) matches `GlinerDetector` (T2) and the harness usage (T6); `SpawnedUpstream` defined T8 and consumed only there + stdio; `WiringDeps`/`buildSanitizer` defined T5, reused by T9's entry branch; `startHttpProxy` deps take `createServer: () => Server` matching `createProxyServer`'s return (Plan 1). `clientTokens: Map<string,string>` (token→name) consistent between T9 config and http deps.

<!-- END OF PLAN 2 -->
