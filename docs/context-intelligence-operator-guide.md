# Context Intelligence Platform — Operator & Security Guide

> **Spec:** `rorca-context-intelligence-platform` · **Story:** US-041 (operator / security / rollout docs)
> **Audience:** operators rolling out Hilo hydration and the `rorca-capture` sidecar, and security
> reviewers vetting what leaves a repository.
> **Companion docs:** `docs/context-intelligence-platform.md` (the canonical architecture contract — read
> §3 *Source-of-Truth Boundaries* and §4 *Excluded Adapters* first), `docs/context-injection.md`,
> `docs/graph-rag-deep-dive.md`, `docs/SECURITY-MODEL.md`.

This guide is task-oriented: **how to set Hilo up, hydrate a workspace, preview the grounded context,
create a spec from it, capture knowledge from outside a run, review captured candidates, and stay safe**.
For *why* the architecture is shaped this way, the platform contract doc is authoritative; where the two
disagree, the contract doc wins and this guide should be corrected.

---

## 0. Mental model (read this once)

The platform has two planes separated by a human review membrane:

```
 CAPTURE PLANE (untrusted, review-gated)        RETRIEVAL PLANE (trusted)
 commits / notes ─▶ rorca-capture sidecar        brief ─▶ seed retrieval
        │  (APIs only, never direct DB writes)          ─▶ Hilo graph expansion
        ▼                                                ─▶ explainable ranker
   context_events + memory_candidates (PENDING)          ─▶ bounded excerpts + budget
        │                                                ─▶ SpecContextBundle
        ▼   ── candidate review (approve/edit/reject) ──▶ promote → durable memory ─┘
```

Four invariants follow from this and govern everything below:

1. **The Hilo graph is rebuildable, never a source of truth.** Delete it and re-hydrate at any time.
2. **The Rorca DB (PostgreSQL) is the only system of record.** External tools write *through APIs*.
3. **The local JSONL queue is an offline buffer only.** It is drained into the DB and then disposable.
4. **Nothing captured influences retrieval until a human approves it** and it is promoted to durable
   memory. Pending / rejected / duplicate / superseded candidates are invisible to retrieval.

---

## 1. Hilo setup & fork strategy

Hilo is an external **codegraph** provider. Hydration runs the Hilo binary over a workspace checkout and
normalizes its edge/classification output into Rorca's `GraphEdge` / `GraphFileNode` shapes. It is
**graph-only** — there is **no FUSE mount, no extended attributes (xattr), no inotify/file-watch trigger,
and no remote backend**. Hydration is a bounded binary run that writes to an output directory; that is the
entire integration surface (`backend/src/lib/hilo-config.ts`, US-006).

### 1.1 Configuration precedence

Resolution is **total and non-throwing** — a malformed value falls back to the default rather than
crashing hydration config loading. Most specific wins:

1. **Environment overrides** (operator / CI control):
   - `RORCA_HILO_ENABLED` — master switch (`false` ⇒ detection/hydration report `disabled` and skip)
   - `HILO_BIN` — Hilo binary path or bare command name (mirrors the `CLAUDE_BIN` / `CODEX_BIN` convention)
   - `RORCA_HILO_CHECKOUT` — checkout path to hydrate
   - `RORCA_HILO_OUTPUT_DIR` — output directory for the rebuildable graph
   - `RORCA_HILO_TIMEOUT_MS` — per-run timeout (clamped to `[1s, 30m]`, default `120000` = 2 min)
2. **Per-workspace `.rorca/config.json`** — the `hilo` section (`binaryPath`, `checkoutPath`,
   `outputDir`, `timeoutMs`, `enabled`).
3. **Built-in defaults** — output dir `.rorca/hilo`, timeout 2 min, enabled when a binary is detectable.

> The default Hilo output lives at `.rorca/hilo` **inside the workspace** and is rebuildable graph data —
> add it to `.gitignore`, never check it in, and never treat it as durable.

### 1.2 Fork strategy — *pinned now, fork later*

Today Hilo is a **pinned binary + checkout**. The config shape is deliberately forward-compatible: a future
**fork** (a different build or source of the *same* codegraph contract) is adopted by pointing `HILO_BIN` /
`binaryPath` and `RORCA_HILO_CHECKOUT` / `checkoutPath` at the new build — **no schema change, no code
change**. The normalizer (`backend/src/lib/hilo-normalizer.ts`) is the contract boundary: as long as a fork
emits the edge/classification output the normalizer maps into `GraphEdge` / `GraphFileNode`, it is a
drop-in replacement. Do not couple any caller to Hilo binary internals — depend only on the normalized
graph shapes from `shared/contracts/graph.ts`.

If `RORCA_HILO_ENABLED=false`, or no binary is detected, the platform runs in a **degraded but correct**
mode: retrieval and composition still work from seed retrieval, memory, and git evidence — they simply lose
graph-neighborhood expansion. Composition is explicitly required to degrade cleanly when Hilo is absent.

---

## 2. Hydration

Hydration projects the source tree at a given git SHA into rebuildable graph metadata: file nodes,
imports, reverse importers, tests / tested_by edges, file roles, and relation counts
(`backend/src/lib/hilo-hydration-runner.ts`, `hilo-normalizer.ts`, US-007/US-008).

### 2.1 Triggering & status (APIs)

| Action | Endpoint |
|---|---|
| Get hydration status / freshness for a workspace | `GET /api/workspaces/:workspaceId/hydration` |
| Trigger hydration (idempotent) | `POST /api/workspaces/:workspaceId/hydration` |

Status records freshness (keyed to the **current git SHA**), node/edge counts, duration, and the last
error (`backend/src/db/workspace-hydration.ts`, US-003). Because freshness is SHA-keyed, a stale graph is
always *detectable* (`hydration-staleness.ts`, US-009) and *rebuildable* — when the checkout SHA moves,
hydration is re-run; nothing downstream silently trusts stale graph data.

### 2.2 Background execution

Hydration runs in the background, bounded and coalesced (`hydration-worker.ts`, US-011/US-012): concurrent
requests for the same workspace coalesce instead of stacking, and execution is observable via the status
table and platform observability (US-038). See §8 for the concurrency limits.

---

## 3. Preview & grounded spec creation

The point of hydration + retrieval is a **grounded, cited context bundle** that you can inspect *before* a
brief becomes a spec.

### 3.1 Brief-aware retrieval preview

`POST /api/context/retrieve` (`backend/src/routes/context.ts`, US-019) takes a brief and returns a
**bounded context preview**: candidate files / docs / memories produced by seed retrieval (US-013/US-014),
Hilo graph-neighborhood expansion (US-015), an **explainable deterministic ranker** (US-016) where every
candidate carries a normalized score *and a per-signal breakdown*, and **bounded, redacted,
provenance-tagged excerpts** under section-level token budgets (US-017). Every retrieval is persisted as a
replayable **trace** (US-018) so a preview can be explained after the fact.

Workspace context readiness/health is available at `GET /api/context/health/:workspaceId` — use it to
confirm hydration freshness and degradation flags before relying on a preview.

### 3.2 Grounded spec creation flow

1. **Hydrate** the workspace (§2) so graph expansion has fresh evidence.
2. **Preview** the grounded context for your brief via `POST /api/context/retrieve`, or the pre-creation
   preview UI (US-023), and confirm the cited files/docs/memories are the right ones.
3. **Compose** — retrieval output is composed into a versioned, prompt-facing `SpecContextBundle`
   (`shared/contracts/context-bundle.ts`, US-020): ordered sections for directions, memories, docs, source
   files, tests, graph summary, **current branch diff** (US-024), risks/gotchas, token accounting, and
   trace IDs — with provenance / reason / confidence / trust on **every** item. The composer is
   deterministic, budget-aware, and degrades cleanly without Hilo (US-021).
4. **Create the spec.** The composer is wired into spec generation and explicit-draft persistence
   **without breaking the existing create / persist / readiness contracts** (US-022). Per `AGENTS.md`, when
   a structured tool surface is available prefer the explicit-draft persistence path
   (`rorca_create_spec` / `rorca_persist_spec` / `POST /api/specs/persist`) over backend generation.

The grounded bundle is what makes the resulting spec *cited*: each section traces back to a real file, doc,
memory, or diff hunk, not to model recall.

---

## 4. `rorca-capture` — the capture sidecar

`rorca-capture` is a **local/VM sidecar** that submits context events and memory candidates to Rorca over
its public ingestion APIs. **It never writes to the Rorca DB directly** — every submission goes through
`POST /api/context-events` and `POST /api/candidates` (US-032). This is the single, narrow,
offline-tolerant ingestion path; the platform is deliberately **adapter-free** (no GitHub/Linear/Slack/
Sentry ingestion — see contract doc §4).

> **Hard rule for any tool author:** tools must use the **APIs**, never direct DB writes. The DB is the
> only system of record; bypassing the ingestion routes bypasses validation, redaction, de-duplication,
> and the governance gate. A PR that writes captured data straight to a table is a correctness bug.

### 4.1 "Remember" — how knowledge gets captured

Capturing ("remembering") knowledge from outside a run happens through the ingest commands below, which
extract structured evidence from git and submit it as a context event plus reviewable memory candidates.
Everything captured lands as a **PENDING `memory_candidate`** — never as durable memory, and never visible
to retrieval — until a human approves it (§6).

### 4.2 Commands

All commands accept `--backend-url` (default `http://localhost:3030`), `--api-key` (for auth-gated
deployments), and `--json`.

**Ingest a single commit**
```bash
rorca capture ingest-commit [sha] \
  --workspace-id <id> \
  --workspace-path <repo-root>   # default: cwd
  [--dry-run]                    # extract & print metadata without submitting
```

**Ingest a commit range (`since..HEAD`)**
```bash
rorca capture ingest-git \
  --since <ref> \                # branch, tag, or SHA (required)
  --workspace-id <id> \
  --workspace-path <repo-root> \
  [--dry-run]                    # list commits without submitting
```

`--dry-run` is the safe way to see exactly what *would* leave the repo before anything is submitted —
recommended for a first run on any sensitive repository.

### 4.3 Offline queue (`flush`)

When the sidecar cannot reach Rorca, it writes **redacted, versioned, idempotency-keyed** payloads to a
local `.rorca-capture-queue.jsonl` file in the workspace root (`backend/src/lib/capture-client.ts`,
US-026). The queue is an **offline buffer only** — it is never read by retrieval or composition.

```bash
rorca capture flush \
  --workspace-path <repo-root> \   # dir containing .rorca-capture-queue.jsonl
  --backend-url <url> [--api-key <key>]
```

Flushing is **idempotent**: each entry carries an idempotency key, so re-flushing after a partial failure
never creates duplicates. Once an entry is flushed, the DB is the truth and the queue entry is disposable.

### 4.4 Git hook (`git-hook`) — safe & reversible

Installs a Rorca-managed **post-commit** hook for best-effort local capture
(`backend/src/lib/git-hook-installer.ts`, US-030). It is reversible and never clobbers an existing hook —
any pre-existing post-commit hook is **preserved and chained**.

```bash
rorca capture git-hook install \
  --repo-path <repo-root> \
  --workspace-id <id> \
  [--backend-url <url>] [--api-key <key>] \
  [--strict]            # hook failures BLOCK commits (non-zero exit)

rorca capture git-hook uninstall --repo-path <repo-root>   # restores prior hook content
rorca capture git-hook status    --repo-path <repo-root>   # is a Rorca hook installed?
```

- **Default (best-effort):** capture failures **never block your commit**. This is the recommended mode.
- **`--strict`:** capture failures block the commit. Use only where missing capture is unacceptable.
- `uninstall` restores the previous hook content; `status` reports installation state. The installer is the
  *only* supported way to manage the hook — do not hand-edit `.git/hooks/post-commit`.

### 4.5 Daemon — VM/server reconciliation mode

For repos that live where Rorca runs (VM / server), the **bounded reconciliation daemon** polls a local git
repo and ingests new commits on an interval (`backend/src/reconcile-daemon-cli.ts`,
`backend/src/lib/reconcile-daemon.ts`, US-031). Run it under a supervisor (systemd / launchd / pm2); it
emits structured JSON log lines and turns SIGINT/SIGTERM into a **graceful shutdown that drains the
in-flight scan and flushes the offline queue**.

```bash
npm run reconcile -- --workspace <id> [options]
```

| Flag | Default | Meaning |
|---|---|---|
| `--workspace <id>` | *(required)* | Rorca workspace ID |
| `--repo <path>` | cwd | local git repo to scan |
| `--api-url <url>` | `$RORCA_API_URL` or `http://localhost:3030` | backend base URL |
| `--api-key <key>` | `$RORCA_API_KEY` | optional bearer token |
| `--interval <ms>` | `60000` | poll interval (floored at 1000 ms) |
| `--since <policy>` | `head` | `head` \| `all` \| `ref:<ref>` \| `count:<n>` |
| `--max-commits <n>` | `100` | max commits ingested per scan (bounded) |
| `--max-scans <n>` | *(none)* | stop after N scans (bounded operation) |
| `--once` | off | run a single scan and exit |
| `--status` | off | print a status snapshot after the run |

The daemon is the *same* ingestion path as the CLI — APIs only, offline-queued, redacted, idempotent. It is
bounded by `--max-commits`, `--max-scans`, and the platform limits in §8 so it cannot run away on a large or
hostile repo.

---

## 5. Queues (recap)

There are two distinct queues; do not conflate them:

- **Capture offline queue** (`.rorca-capture-queue.jsonl`, §4.3) — a per-workspace JSONL **offline buffer**
  for sidecar submissions. Survives API downtime, drained by `flush` / the daemon, then disposable. Never a
  source of truth, never read by retrieval.
- **Hydration / background work** — bounded, coalesced execution governed by the concurrency limits in §8.
  Hydration output is rebuildable graph data, not a durable queue.

---

## 6. Candidate review (governance)

Captured knowledge enters as **reviewable memory candidates**, never as durable memory. The governance gate
is **absolute**: pending / rejected / duplicate / superseded candidates **never** enter default retrieval or
prompt composition (US-035). Only an **approved** candidate, promoted through the existing durable-memory
path, becomes retrievable.

### 6.1 Ingestion (idempotent)

`POST /api/candidates` and `POST /api/context-events` validate, sanitize, redact, and de-duplicate via an
idempotency key (US-032). De-dup is enforced on `(workspace_id, idempotency_key)`: a **new** insert returns
`201`, a **duplicate** returns `200` with the existing record. This is what lets an offline queue flush
safely without creating duplicates.

### 6.2 Review actions

| Action | Endpoint | Notes |
|---|---|---|
| List / filter candidates | `GET /api/candidates?status=…` | statuses: `pending`, `approved`, `rejected`, `duplicate`, `superseded`, `revisit` |
| Candidate detail | `GET /api/candidates/:id` | includes provenance + promoted-memory link if approved |
| Approve / edit-and-approve | `POST /api/candidates/:id/approve` | optional field overrides = edit-and-approve; creates a durable memory; idempotent re-approval returns `200` |
| Reject | `POST /api/candidates/:id/reject` | |
| Mark duplicate / supersede | `POST /api/candidates/:id/...` | links to the canonical candidate |

**Lifecycle transitions** (`backend/src/routes/candidates.ts`, US-034):
- `pending` / `revisit` → `approved` | `rejected` | `duplicate` | `superseded`
- `rejected` / `duplicate` / `superseded` → `revisit` (reopen for another look)
- `approved` is **terminal** (idempotent re-approval is a no-op `200`).

A review UI (US-036) plus provenance / related-file previews (US-037) make review safe and auditable. **Only
approval promotes** a candidate to durable memory and thereby into retrieval — every other state stays on the
capture side of the membrane.

---

## 7. Security: redaction, ignores, regulated review defaults, limits, boundaries

All capture / hydration / composition content passes through the shared safety primitives in
`backend/src/lib/context-safety.ts` (US-005) **before** anything is persisted to the DB or composed into a
prompt. The module is dependency-free and pure (deterministic), so its behavior is testable in isolation.

### 7.1 Secret redaction

`redactSecrets()` strips secrets from any captured/excerpted text, replacing them with `[REDACTED]`.
Patterns covered include:

- PEM **private key** blocks (RSA/EC/DSA/OpenSSH/PGP/encrypted)
- **Database connection strings** (postgres/mysql/mongodb/redis/amqp/mssql/…) — redacted *whole*
- any **URL carrying `user:password@host`** credentials
- **AWS** access key IDs, **GitHub** tokens (PAT v1/v2, OAuth), **Slack** tokens, **Google** API keys,
  **Stripe** live/test keys, **OpenAI/Anthropic-style** `sk-…` / `pk-…` keys, **JWTs**, **Bearer** headers
- **assignment-style secrets** (`password = "…"`, `api_key: …`) — keeps the key name, redacts only the value

Redaction happens at the sidecar (payloads are redacted *before* being queued) and again at ingestion, so a
secret is scrubbed even if a queue file is inspected on disk.

### 7.2 Ignore rules

Walks honor gitignore-style patterns from two sources (`createIgnoreMatcher` / `loadCaptureIgnore`):

- **Built-in `DEFAULT_IGNORE_PATTERNS`** — VCS dirs (`.git/`, `.hg/`, `.svn/`), dependency/vendor dirs
  (`node_modules/`, `vendor/`, `.yarn/`), build/generated output (`dist/`, `build/`, `.next/`, `coverage/`,
  `*.min.js`, `*.map`, lockfiles), and **secrets/credentials** (`secrets/`, `.env`, `.env.*`, `*.pem`,
  `*.key`, `*.p12`, `id_rsa`, …).
- **Per-workspace `.rorca-captureignore`** at the workspace root — gitignore syntax, including `!pattern`
  re-includes. Defaults are applied first so a user `!`-re-include can deliberately override a built-in
  exclude.

Use `.rorca-captureignore` to exclude anything project-specific (generated fixtures, large data dirs,
proprietary subtrees) from ever being captured or hydrated.

### 7.3 Path traversal protection

`normalizeWorkspaceRelativePath()` resolves any path to a **workspace-relative POSIX** path and **rejects**
anything that escapes the root via `..`, an absolute path outside the root, or a NUL byte. Resolution is
logical (string-based) and does not follow symlinks — callers resolving untrusted symlinks must additionally
`fs.realpath` and re-check containment. This keeps capture/hydration scoped to the workspace and prevents a
crafted path from reading outside it.

### 7.4 Regulated review defaults (the governance defaults)

The platform is **review-gated by default** — these are the "regulated" defaults that make capture safe to
turn on:

- Captured knowledge defaults to **PENDING `memory_candidate`** — never auto-promoted, never trusted.
- The **governance gate is absolute**: pending/rejected/duplicate/superseded candidates are invisible to
  retrieval and composition. Only human **approval** + promotion makes a datum retrievable (US-035).
- Captured items carry the **lowest trust tiers** (`captured` / `unverified` in
  `shared/contracts/trust.ts`); ranking weights trust, so even an approved-but-derived item is ranked below
  authoritative/reviewed knowledge rather than blindly trusted.
- The git hook defaults to **best-effort** (failures don't block commits); `--strict` is opt-in.

The safe default is "capture freely, trust nothing until reviewed." Do not add a code path that promotes a
candidate without an explicit review action.

### 7.5 Limits (large / hostile repos)

`backend/src/lib/context-limits.ts` (US-039) is the single source of truth for the bounds that keep the
platform safe on large or hostile repositories. Every limit is **env-overridable** for big monorepos and
clamped to a floor of `1`, so a mistyped env var can never disable a bound entirely.

| Bound | Default | Env override |
|---|---|---|
| Hydration global concurrency | `4` | (see `context-limits.ts`) |
| Hydration per-workspace concurrency | `1` | |
| Hydration wait-queue depth (shed beyond) | `64` | |
| git-map LLM chunk concurrency | `5` | |
| Max candidates into ranking (protects O(n²) MMR) | `500` | |
| Max distinct files surfaced | `200` | |
| Max graph/seed traversal depth | `4` | |
| Max excerpts per retrieval | `50` | |
| Max retrieval token budget a caller may request | `200000` | |
| Max retrieval-trace payload bytes | *(capped)* | |
| Max single-candidate payload bytes | *(capped)* | |

File-size caps (`getMaxFileBytes` / `exceedsSizeCap` in `context-safety.ts`) bound individual reads/payloads
so one giant file cannot blow the budget. Payload-byte caps raise **actionable** errors
(`PayloadTooLargeError`, `TooManyRequestsError`) rather than silently truncating.

Caches (Redis) are keyed by **workspace + git SHA + file hash + brief hash + retrieval policy** so stale or
policy-divergent entries never alias each other, and are invalidated on staleness. Losing Redis degrades
performance only — never correctness, never durable state.

### 7.6 Source-of-truth boundaries (the security invariant)

| Store | Role | Durable? | Rebuildable? |
|---|---|---|---|
| **Hilo graph** | rebuildable codegraph data | No | Yes — always |
| **Rorca DB (PostgreSQL)** | durable **reviewed** state — *only* system of record | Yes (back it up) | No |
| **Local queue (JSONL)** | offline buffer for the sidecar | No | N/A |
| **Redis** | cache only | No | Yes — always |

Practical rule: a human-reviewed/approved datum → **Rorca DB**; something derived from code structure →
**Hilo graph** (or a Redis cache of it); a buffered offline submission → **local queue**; a read speed-up →
**Redis only**. External tools (the sidecar included) write through Rorca APIs — **never** by direct DB
writes. Violating a boundary is a correctness bug, not a style choice.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Preview has files but **no graph expansion** / `graphMode` looks degraded | Hilo disabled or binary not found | Set `HILO_BIN` to a valid path or ensure `hilo` is on `PATH`; confirm `RORCA_HILO_ENABLED` is not `false`. Composition still works degraded — this is expected without Hilo. |
| Hydration **status stays stale** after new commits | Freshness is keyed to git SHA; graph reflects an older SHA | `POST /api/workspaces/:id/hydration` to re-hydrate; check `GET …/hydration` for the last error. |
| Hydration **times out** on a large repo | Default 2-min per-run timeout | Raise `RORCA_HILO_TIMEOUT_MS` (clamped to ≤ 30 min) and/or tune `context-limits.ts` concurrency. |
| `capture …` exits with **"--workspace-id is required"** | Missing required flag | Pass `--workspace-id <id>` (and `--workspace-path` if not running from the repo root). |
| Captured commits **don't appear in retrieval** | Working as designed — they're PENDING candidates | Review and **approve** them (`POST /api/candidates/:id/approve`). Only approval promotes to durable memory. |
| Submissions seem lost while backend is down | Sidecar fell back to the offline queue | `rorca capture flush --workspace-path <repo>` once the backend is back; flush is idempotent. |
| `git-hook install` reports an **existing hook** | A prior post-commit hook is present | The installer preserves & chains it — no action needed. To revert entirely, `git-hook uninstall` restores the prior content. |
| Commits are **blocked** by capture failures | Hook was installed with `--strict` | Reinstall without `--strict` (best-effort) or fix the backend connection. |
| Daemon **floods** a huge/hostile repo | Unbounded scan | Use `--max-commits`, `--max-scans`, `--since count:<n>`, or `--once`; tune `context-limits.ts`. |
| `PayloadTooLargeError` / `429 TooManyRequests` on ingest | A limit in `context-limits.ts` was exceeded | Reduce payload size / request rate, or raise the relevant env-overridable bound for your monorepo. |
| A secret appears in a candidate | A pattern not yet covered by `redactSecrets` | Add the pattern to `SECRET_PATTERNS` in `context-safety.ts` (and a test); never disable redaction. |
| Duplicate candidates after a retry | (should not happen) | De-dup is on `(workspace_id, idempotency_key)`; confirm the sidecar is sending a stable idempotency key. |

For install/runtime issues unrelated to the platform (ports, Postgres, Gatekeeper), see
`docs/troubleshooting.md`.

---

## 9. Rollout checklist

1. Decide Hilo posture: pin a `HILO_BIN`, or run degraded (no graph expansion) intentionally.
2. Add `.rorca/hilo` (and any custom output dir) to `.gitignore`.
3. Add a `.rorca-captureignore` for project-specific exclusions; verify built-in secret/dep ignores cover
   your tree.
4. Dry-run capture on a sensitive repo: `rorca capture ingest-git --since <ref> --dry-run` and inspect.
5. Install the git hook in **best-effort** mode (omit `--strict`) for developer machines; use the daemon
   for VM/server repos with `--max-commits` / `--max-scans` bounds.
6. Confirm reviewers know the governance gate: **nothing captured is trusted until approved**.
7. Tune `context-limits.ts` env overrides for large monorepos before enabling broad capture.
8. Back up the Rorca DB — it is the only system of record. The Hilo graph, the offline queue (post-flush),
   and Redis are all rebuildable/disposable.
