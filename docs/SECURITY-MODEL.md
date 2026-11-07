# OSS Security Model

This document describes the intended security posture of the future Apache 2.0 `rorca` repo.

## Trust model

- The OSS edition is **local-first** and **self-hostable**.
- The OSS codebase should be treated as **operator-controlled and modifiable**.
- Local UI checks and defaults are product ergonomics, not strong anti-tamper enforcement.

## Identity boundary

The Apache 2.0 OSS repo should **not** ship hosted identity infrastructure such as:
- Supabase auth
- hosted GitHub web sign-in
- other SaaS-style account/session systems

Those belong in `rorca-opencore`.

## GitHub access in OSS

Rorca still needs to interact with user repositories in the OSS edition.
That capability should remain available through local/operator-managed credentials such as:
- GitHub personal access tokens (PATs)
- local git credentials already configured on the machine
- local CLI auth flows managed by developer tools

GitHub repository capability stays in OSS.
GitHub web-login identity does not.

## Local dashboard protection

If an OSS dashboard needs protection outside pure localhost use, prefer a minimal local-only control such as:
- a static API key
- a locally managed shared secret
- network-level protection provided by the operator

Do not require hosted identity infrastructure just to run the local OSS product.

## Context intelligence capture safety

Context Intelligence adds Hilo graph hydration, grounded spec creation, and the `rorca-capture` sidecar.
Its operator runbook is `docs/context-intelligence-operator-guide.md`; the security model is:

- **API-only ingestion:** external tools, sidecars, hooks, and daemons must use Rorca APIs such as
  `POST /api/context-events` and `POST /api/candidates`. They must **never** write directly to PostgreSQL
  tables or append durable memory to bypass validation, redaction, idempotency, and review.
- **Redaction:** captured notes, commit metadata, excerpts, and queued payloads pass through
  `redactSecrets()` / ingestion redaction. Secrets are replaced with `[REDACTED]`; covered classes include
  private keys, credentialed URLs, database connection strings, cloud/provider tokens, bearer headers,
  JWTs, and assignment-style secrets. Redaction happens before offline queue writes and again at ingestion.
- **Ignores and workspace boundaries:** built-in `DEFAULT_IGNORE_PATTERNS` skip VCS/dependency/generated
  directories and common secret files. Operators can add `.rorca-captureignore` per workspace. Paths are
  normalized to workspace-relative POSIX paths and traversal outside the workspace is rejected.
- **Regulated review defaults:** all captured knowledge defaults to PENDING `memory_candidate` state with
  low trust (`captured` / `unverified`). Pending, rejected, duplicate, and superseded candidates are
  invisible to retrieval and prompt composition. Only explicit human approval promotes a candidate to durable
  memory.
- **Limits:** `context-limits.ts` is the source of truth for bounded hydration/retrieval/capture behavior:
  concurrency, queue depth, candidate counts, graph depth, excerpt count, token budgets, trace/payload byte
  caps, and file-size caps. Limits are env-overridable for large repos but clamped so they cannot be
  accidentally disabled.
- **Source-of-truth boundaries:** the Hilo graph is rebuildable graph-only codegraph data; Redis is a
  cache; the local JSONL capture queue is an offline buffer; PostgreSQL is the only durable system of
  record for reviewed state. Losing graph output, Redis, or a drained queue must not lose reviewed memory or
  spec history.

## Commercial enforcement

The OSS repo should not be treated as a secure place to enforce:
- billing
- subscriptions
- seat limits
- enterprise RBAC
- hosted entitlements

Those controls belong in `rorca-opencore` and other infrastructure under operator/company control.
