# Public API Breaking Changes

Breaking changes to routes marked `x-rorca-public-api: true` must be documented here before CI will allow them.

Required for every entry:
- Marker line in the exact format `<!-- contract-break: YYYY-MM-DD METHOD /path -->`
- Why the break is necessary
- Migration path for downstream consumers

Rules:
- The marker date is evaluated relative to PR creation time, not workflow runtime.
- Markers older than 30 days do not count as overrides.
- Adding a new entry here requires a major `package.json` version bump.
- Breaking public API changes also require a major `contractVersion` bump in `docs/openapi-public-snapshot.json`.

Template:

```md
<!-- contract-break: YYYY-MM-DD METHOD /path -->
## YYYY-MM-DD `METHOD /path`

Justification: explain the security, correctness, or maintenance reason.

Migration path:
- Describe the replacement route or schema.
- Describe any temporary compatibility strategy.
```

<!-- contract-break: 2026-07-14 GET /api/health -->
## 2026-07-14 `GET /api/health`

Justification: the health response now publishes the active database and graph capability model required for safe local runtime diagnostics.

Migration path:
- Existing health fields and status semantics remain unchanged.
- Treat `databaseCapability`, `dbMode`, `graphMode`, `graphWarnings`, and `pgvectorReady` as optional additive diagnostics.

<!-- contract-break: 2026-07-14 GET /api/pipeline/runs/{runId} -->
## 2026-07-14 `GET /api/pipeline/runs/{runId}`

Justification: run detail now exposes the normalized `terminal_mode` required for ANSI/PTY renderer selection and backward-compatible reattachment.

Migration path:
- Existing run-detail fields remain unchanged.
- Treat absent or null historical terminal mode as `ansi-html`; use `pty` only when explicitly returned.

<!-- contract-break: 2026-07-14 GET /api/specs/kanban -->
## 2026-07-14 `GET /api/specs/kanban`

Justification: in-progress cards now expose bounded post-save stage and queue state so clients can distinguish queued, waiting, and running enrichment work.

Migration path:
- Existing Kanban fields remain unchanged.
- Treat all `postSave*` fields as optional and fall back to the existing card state when absent.

<!-- contract-break: 2026-07-14 GET /api/version -->
## 2026-07-14 `GET /api/version`

Justification: version metadata now publishes the redacted database capability model used for cross-client compatibility decisions.

Migration path:
- Existing version fields remain unchanged.
- Ignore `databaseCapability` on older clients or when connecting to an older server.

<!-- contract-break: 2026-07-14 POST /api/pipeline/runs/{runId}/retry -->
## 2026-07-14 `POST /api/pipeline/runs/{runId}/retry`

Justification: retry accepts an optional bounded sequential-execution control for deterministic recovery.

Migration path:
- Existing callers may omit `forceSequential`.
- Pass `forceSequential: true` only when serial retry is required.

<!-- contract-break: 2026-07-14 POST /api/pipeline/trigger -->
## 2026-07-14 `POST /api/pipeline/trigger`

Justification: trigger now documents optional runner, reasoning, rerun, readiness, merge-strategy, story-scope, and PTY transport controls already supported by the merged execution surface.

Migration path:
- Existing required fields and defaults remain unchanged.
- Send new options only when needed; absent or null `terminal_mode` continues to resolve to `ansi-html`.

<!-- contract-break: 2026-07-14 POST /api/specs/{specId}/approve -->
## 2026-07-14 `POST /api/specs/{specId}/approve`

Justification: approval now accepts explicit readiness-override intent so exceptional approvals are auditable rather than implicit.

Migration path:
- Existing callers may omit `readinessOverride`.
- Set it only after presenting readiness blockers to the operator.

<!-- contract-break: 2026-07-14 POST /api/specs/generate -->
## 2026-07-14 `POST /api/specs/generate`

Justification: legacy generation now documents optional agent routing and policy-aware post-save behavior shared with canonical spec persistence.

Migration path:
- Existing generation callers can continue sending `brief` and prior optional settings.
- Prefer `POST /api/specs/persist` for caller-drafted specs and omit `postSave` to retain the default policy.

<!-- contract-break: 2026-07-14 PUT /api/specs/{specId} -->
## 2026-07-14 `PUT /api/specs/{specId}`

Justification: spec metadata updates now accept the Pi agent and expanded supported reasoning effort levels.

Migration path:
- Existing agent and effort values remain valid.
- Clients should send `pi`, `max`, or `xhigh` only after confirming server capability.
