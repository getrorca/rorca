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

<!-- contract-break: 2026-07-15 GET /api/health/detailed -->
## 2026-07-15 `GET /api/health/detailed`

Justification: detailed health adds the optional `refresh` query so operations clients can request a bounded, newly sampled dependency probe instead of relying on stale cached health evidence.

Migration path:
- Existing callers may continue omitting `refresh`; the default cached-response behavior remains unchanged.
- Clients that need a current probe may send `refresh=true` and handle the existing degraded/unavailable health response.

<!-- contract-break: 2026-07-03 GET /api/health -->
## 2026-07-03 `GET /api/health`

Justification: the health response now exposes expanded component readiness used by local runners and contract-aware clients.

Migration path:
- Treat additional health fields as optional and read known fields defensively.
- Existing `ok`/status semantics remain available for compatibility.

<!-- contract-break: 2026-07-03 GET /api/pipeline/runs/{runId} -->
## 2026-07-03 `GET /api/pipeline/runs/{runId}`

Justification: run detail now includes context/retrieval metadata required for evidence-backed execution review.

Migration path:
- Ignore unknown run-detail fields when using older clients.
- Prefer the documented run status fields and treat context metadata as additive diagnostics.

<!-- contract-break: 2026-07-03 GET /api/specs/kanban -->
## 2026-07-03 `GET /api/specs/kanban`

Justification: Kanban cards now expose canonical queue/run state so clients can distinguish queued versus running specs.

Migration path:
- Use `activeRunStatus` and `queuePosition` when present.
- Fall back to previous visual status derivation when these fields are absent.

<!-- contract-break: 2026-07-03 GET /api/version -->
## 2026-07-03 `GET /api/version`

Justification: version metadata now advertises public contract and capability compatibility for cross-client integrations.

Migration path:
- Read version fields defensively and ignore unknown compatibility keys.
- Existing version string consumers can continue using the top-level version field.

<!-- contract-break: 2026-07-03 POST /api/pipeline/runs/{runId}/retry -->
## 2026-07-03 `POST /api/pipeline/runs/{runId}/retry`

Justification: retry accepts a bounded sequential execution option used by governance loops and local runner safety checks.

Migration path:
- Existing retry callers may omit `forceSequential`.
- New callers should pass `forceSequential: true` only when deterministic serial retry is required.

<!-- contract-break: 2026-07-03 POST /api/pipeline/trigger -->
## 2026-07-03 `POST /api/pipeline/trigger`

Justification: trigger options now include readiness overrides, rerun controls, terminal mode, and runner/model routing needed by governed execution.

Migration path:
- Existing required fields are unchanged.
- Clients should ignore unknown trigger options in older servers and only send new fields after checking `/api/version` or failed validation details.

<!-- contract-break: 2026-07-03 POST /api/specs/{specId}/approve -->
## 2026-07-03 `POST /api/specs/{specId}/approve`

Justification: approval now records explicit readiness override intent for audited governed execution.

Migration path:
- Existing callers may omit `readinessOverride`.
- Only set `readinessOverride: true` after presenting readiness blockers to the operator.

<!-- contract-break: 2026-07-03 POST /api/specs/generate -->
## 2026-07-03 `POST /api/specs/generate`

Justification: legacy generation now shares policy-aware post-save options with canonical explicit-draft spec creation.

Migration path:
- Existing generation callers can keep sending `brief` and optional generation settings.
- Prefer `POST /api/specs/persist` for caller-drafted specs and use `postSave` only when overriding the default policy.

<!-- contract-break: 2026-07-03 PUT /api/specs/{specId} -->
## 2026-07-03 `PUT /api/specs/{specId}`

Justification: spec metadata updates now include agent/reasoning controls used by execution governance.

Migration path:
- Existing metadata updates may omit the new execution-control fields.
- Clients should validate supported agent/reasoning values before sending them.

<!-- contract-break: 2026-07-15 GET /api/pipeline/runs/{runId}/output -->
## 2026-07-15 `GET /api/pipeline/runs/{runId}/output`

Justification: PTY v2 adds explicit durable replay cursors and output-source identity so reconnects cannot duplicate or suppress bytes across PTY and ANSI stores.

Migration path:
- Existing callers may omit `afterSequence` and `outputSource`; they receive the bounded initial replay.
- Reconnecting clients should persist both the last sequence and returned output source, then send them together.

<!-- contract-break: 2026-07-15 POST /api/pipeline/runs/{runId}/pty/resize -->
## 2026-07-15 `POST /api/pipeline/runs/{runId}/pty/resize`

Justification: PTY v2 bounds terminal dimensions to 500 columns by 200 rows to prevent unbounded native-terminal allocation.

Migration path:
- Existing values within the documented bounds are unchanged.
- Clients must clamp larger requested dimensions before submitting resize controls.

<!-- contract-break: 2026-07-15 POST /api/pipeline/task-manifests/trigger -->
## 2026-07-15 `POST /api/pipeline/task-manifests/trigger`

Justification: the merged mainline terminal contract retains `native-pty` as a compatibility alias for the hardened PTY v2 transport.

Migration path:
- Existing `ansi-html` and `pty` requests remain valid.
- New callers should prefer canonical `pty`; `native-pty` remains accepted for mainline compatibility.
