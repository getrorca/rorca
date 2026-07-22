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

<!-- contract-break: 2026-07-20 POST /api/specs/authoring/preflight/confirm -->
## 2026-07-20 `POST /api/specs/authoring/preflight/confirm`

Justification: authoring-plan confirmation now requires an exact signed provider-human event bound to the accepted plan and preflight hashes. This prevents a caller or Hermes from manufacturing approval authority after the draft changes.

Migration path:
- Obtain the canonical confirmation target from authoring preflight and require the human to confirm that exact target through an authorized provider tenant.
- Send the resulting `provider-human-event.v1` attestation; legacy caller-shaped actor objects are rejected.

<!-- contract-break: 2026-07-20 GET /api/pipeline/runs/{runId}/pty/checkpoints/{checkpointId} -->
## 2026-07-20 `GET /api/pipeline/runs/{runId}/pty/checkpoints/{checkpointId}`

Justification: trusted PTY checkpoint evidence contains recovery authority and is now restricted to authenticated operator/admin REST callers; it must not remain a public or MCP-callable surface.

Migration path:
- Operator clients must use authenticated REST access with the required operator tier.
- Public/MCP clients should consume redacted run status and lifecycle evidence instead of checkpoint authority.

<!-- contract-break: 2026-07-20 POST /api/pipeline/runs/{runId}/input -->
## 2026-07-20 `POST /api/pipeline/runs/{runId}/input`

Justification: PTY keyboard input is an execution-control operation and is now restricted to authenticated operator/admin REST callers to prevent public or MCP-driven command injection.

Migration path:
- Interactive operator consoles must authenticate and call the operator REST route.
- Automation must use governed TaskManifest or retry APIs and cannot inject terminal input.

<!-- contract-break: 2026-07-20 POST /api/pipeline/runs/{runId}/pty/resize -->
## 2026-07-20 `POST /api/pipeline/runs/{runId}/pty/resize`

Justification: PTY attachment mutation is now operator-only and excluded from public/MCP contracts so untrusted clients cannot influence an active terminal session.

Migration path:
- Authenticated operator consoles may continue through the operator REST route.
- Public/MCP consumers should treat terminal dimensions as read-only telemetry when exposed.

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

<!-- contract-break: 2026-07-19 POST /api/pipeline/runs/{runId}/input -->
## 2026-07-19 `POST /api/pipeline/runs/{runId}/input`

Justification: PTY v2 binds interactive input to the exact active generation token and accepts only bounded base64-encoded UTF-8, preventing a stale browser or prior retry from writing into a replacement process.

Migration path:
- Obtain `generationToken` from the active generation metadata and send it with `dataBase64`.
- Stop sending the legacy unscoped input shape; refresh generation metadata after rollover or HTTP 403/409.

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

<!-- contract-break: 2026-07-15 POST /api/specs/persist -->
## 2026-07-15 `POST /api/specs/persist`

Justification: reconciliation with current `main` adds optional Genesis provenance to persisted context and returns the canonical persisted `id`. The contract snapshot treats this response/schema shape change as a major revision even though the added fields are backward-compatible for tolerant clients.

Migration path:
- Existing request bodies remain valid; Genesis provenance is optional.
- Existing clients may ignore the additive response `id`; clients that need canonical identity may adopt it instead of deriving it from the slug.

<!-- contract-break-v2: 2026-07-21 GET /api/pipeline/runs/{runId}/pty/checkpoints/{checkpointId} sha256:7deaa77d1849fdbe288e5d37c9dbe3fea024b59844e7bfb011e6be5ee5e7b457 public-flag-removed -->
## 2026-07-21 PTY checkpoint retrieval authority

PTY checkpoint retrieval moved from the public API to authenticated admin/operator authority because generation-bound terminal evidence may expose restricted execution metadata. Public/MCP clients must use bounded run/output status surfaces; operator clients must authenticate and present the exact checkpoint identity.

<!-- contract-break-v2: 2026-07-21 POST /api/pipeline/runs/{runId}/input sha256:2cf1e9e87e4fdf6f14a9e3d6514befe40dc24f4ffd24c392059d2d2d1a2bd5db public-flag-removed -->
## 2026-07-21 PTY input authority

Interactive terminal input moved from the public API to authenticated admin/operator authority. Autonomous MCP clients cannot inject keyboard bytes. Operator clients must use the protected endpoint with the exact active generation token and bounded base64 payload.

<!-- contract-break-v2: 2026-07-21 POST /api/pipeline/runs/{runId}/pty/resize sha256:90761864a665a7e02c8a8f6a440549b94847e23996030593a68528a05e4276c0 public-flag-removed -->
## 2026-07-21 PTY resize authority

Interactive terminal resizing moved from the public API to authenticated admin/operator authority. Autonomous MCP clients must not mutate live PTY state; operator clients must authenticate and bind the request to the active generation token.

<!-- contract-break-v2: 2026-07-21 POST /api/pipeline/runs/{runId}/retry sha256:38dd330b5ff3389c07cd6bf257b9965dbcd1f1ecd5b70e6525d5e5381af17d8b sha256:2c8e9e0cc134d11e7385673bdfeb50804700fe8a3dc88538218b51219f6be59d -->
## 2026-07-21 governed retry approval receipts

Destructive retry approval no longer accepts a free-form `approvalToken`. Callers first obtain the exact preview packet and, when required, a human-issued packet-bound `approvalReceipt`; dispatch rejects stale, cross-packet, service-authored, or replayed receipts. Safe-mode preview remains read-only.

<!-- contract-break-v2: 2026-07-21 POST /api/pipeline/trigger sha256:08173cdf717250a248c5d3c595351e631d30e5181803ec2ef169f0faf263de1d sha256:ec5c72a1dc1337577228f115bfb4d08f14a22a25f7815fbe8f6e25bfc333b02c -->
## 2026-07-21 governed production wave execution envelope

Production `wave-parallel` requests are disabled by default and require the complete immutable qualification receipt, review/activation policy, cohort, and bounded parallelism envelope. Legacy shape-only policy fields cannot enable production execution. Existing sequential requests are unchanged; callers should omit wave fields unless presenting the governed envelope.

<!-- contract-break-v2: 2026-07-21 POST /api/specs/authoring/preflight/confirm sha256:ffc941f078454dea65220aa6b01f308556764f584fad23277d8946a49b64ba5c sha256:83a61ab794984742a0ef1e138a04483e412aab4b4626834ab39dffc892a7fe52 -->
## 2026-07-21 authoring provider-human confirmation

Service-principal confirmation now requires a durable provider-human attestation bound to the accepted plan and preflight hashes. Direct authenticated humans remain supported. Callers must not synthesize actor identity from model or service context.

<!-- contract-break-v2: 2026-07-21 POST /api/specs/generate sha256:20faeb7bc10b77ff74cf47c4e234ceddc0847320c459f694932480f74e7d47b9 sha256:da702fa328545d430341eb159e4d5b360aa5f9bdfaba97d4422d27d401070842 -->
## 2026-07-21 legacy generation authoring policy

Legacy spec generation now participates in canonical authoring preflight and durable post-save policy handling. Callers should handle review/confirmation-required responses and use canonical persist/forge workflows when exact drafted material is available.

<!-- contract-break-v2: 2026-07-21 POST /api/specs/persist/batch sha256:cdb431274ab573ce09178cf2192b46556f30efd69dcda224958ade2e58beb27b sha256:be51439516e3ab5a2c85fe70a7b4f5d90e40a23cefdd6fc4b45b968c6c8a6e8d -->
## 2026-07-21 resumable batch authoring identity

Batch persistence now requires a caller-provided `idempotencyKey` bound to the accepted parent plan and complete draft set. Replays resume incomplete children and reject changed material instead of creating ambiguous duplicate specs.

<!-- contract-break-v2: 2026-07-22 GET /api/version sha256:4ace065af3de1d868abffc084748b8bcbd6abab61e1b36c85a56c90d70b92527 sha256:72a0aa64ef3a271d53455d40ce47bcc1314fbed093b28ae653c493a0460b1186 -->
## 2026-07-22 TaskManifest human-authority capability discovery

The version capability response now advertises `provider-human-event.v1` and explicitly states that service-relayed TaskManifest execution requires that authority. Tolerant clients may ignore the additive fields; Hermes and other relays should require them before sending non-dry execution.

<!-- contract-break-v2: 2026-07-22 GET /api/workspaces sha256:17b8dea2ff89bb1d8c7acb63659fe62b73747dbc118c3047bf30ce80e029ef69 sha256:36b714a951707ea8427910f3d15a69beb3868a16e4f37a8726a566d240a87269 -->
## 2026-07-22 Canonical paginated workspace list

The public contract no longer documents the stale `workspaces` response alias that the implementation did not return. Clients must consume the canonical paginated `items`, `total`, `hasMore`, and `cursor` fields.

<!-- contract-break-v2: 2026-07-22 POST /api/pipeline/task-manifests/trigger sha256:8beff74c282556146184c8baf891822626022fecfb02d921d3caa877f56c1bab sha256:1b9c02173e53d7b448170cc25b5b2cb06e7c3c4f1baa94f763ac81c5f7d478ba -->
## 2026-07-22 Provider-human bounded TaskManifest dispatch

Non-dry internal-service dispatch now carries an exact signed provider-human event, requires a host-created isolated worktree, preserves `pr` or `draft-pr`, and rejects auto-merge or branch-only delivery. Direct authenticated human callers retain their human-origin authority; supervisory relays must use the exact manifest approval target and replay the same receipt.

<!-- contract-break-v2: 2026-07-22 POST /api/pipeline/trigger sha256:08173cdf717250a248c5d3c595351e631d30e5181803ec2ef169f0faf263de1d sha256:eb224389c6832a728aea0bae84ce7ef3739a86911bc00ba2914c64bb44cf48e7 -->
## 2026-07-22 Release-1 manifestless trigger retirement

The legacy public trigger remains usable for dry-run preview and typed redirect only. Release-1 implementation execution requires the bounded TaskManifest route, a host-created worktree, sequential execution, and `pr`/`draft-pr` delivery; scheduled, parallel, direct, branch-only, auto-merge, and local-user execution shapes fail closed.

<!-- contract-break-v2: 2026-07-22 POST /api/specs/{specId}/approve sha256:c1559e4cfceab749f9fe0fce76661f431c9f82c4d9ea17a4434b447d8503c4d4 sha256:52925baf6176170c234b70c940d045c94f947315e2f4298696a688745756086c -->
## 2026-07-22 Exact governed spec approval identity

Governed approval no longer permits readiness override and service-mediated approval requires an accepted authoring identity plus signed provider-human attestation. Callers must consume `approvedPath`, readiness, mutation receipt, optional provider approval, and `rorca.spec-approval-response-identity.v1` instead of relying on the legacy `specPath`-only response.
