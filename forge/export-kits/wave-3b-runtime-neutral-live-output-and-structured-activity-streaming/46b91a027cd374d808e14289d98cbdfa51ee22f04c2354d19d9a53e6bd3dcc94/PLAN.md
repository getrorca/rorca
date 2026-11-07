# Wave 3B — Runtime-Neutral Live Output and Structured Activity Streaming — Delivery Plan

## Story order
1. **W3B-001 — Gate stream work and isolate the sole parallel ownership zone**
2. **W3B-002 — Publish versioned sequenced activity and context-continuation events**
3. **W3B-003 — Persist generation-isolated streams with bounded retention**
4. **W3B-004 — Adapt managed local PTY output into the neutral stream**
5. **W3B-005 — Accept future federated telemetry through a bounded ingest seam**
6. **W3B-006 — Support replay and reconnect from generation-bound checkpoints**
7. **W3B-007 — Enforce redaction, backpressure, and stream security boundaries**
8. **W3B-008 — Evolve Run View without regressing xterm compatibility**
9. **W3B-009 — Pass stream conformance, recovery, browser, and independent review gates**

## Dependencies
- W3B-001 → W3B-002
- W3B-002 → W3B-003
- W3B-003 → W3B-004
- W3B-002 → W3B-005
- W3B-003 → W3B-005
- W3B-003 → W3B-006
- W3B-004 → W3B-006
- W3B-005 → W3B-006
- W3B-004 → W3B-007
- W3B-005 → W3B-007
- W3B-006 → W3B-007
- W3B-006 → W3B-008
- W3B-007 → W3B-008
- W3B-008 → W3B-009

## Verification
- W3B-001: The gate binds exact Wave 2 spec revision, stream-related contract version/hash, migration head, implementation SHA, conformance receipt, and independent review.
- W3B-001: Missing, changed, stale, unsupported, or self-asserted Wave 2 evidence blocks implementation before mutation.
- W3B-001: The ownership manifest rejects overlap with ROR-28 except declared serialized contract/generated integration points and rejects every third concurrent wave.
- W3B-001: Existing Run View and PTY storage behavior remain the compatibility baseline and are captured by golden fixtures before changes.
- W3B-001: The gate grants no lifecycle, evidence, approval, merge, deployment, or production-stream authority.
- W3B-002: Stream/event v1 binds workspace/mission/work-package/spec/story/run/attempt/lease/fence; policy definition/activation, checkpoint/receipt/bundle/dispatch; repository/base/current SHA/worktree/path, validation/root-cause, runtime/controller/originating turn/generation, session/cursor, stream/sequence/times/kind/payload/redaction and restricted reference.
- W3B-002: Registered kinds include compaction started/ended, agent_settled observed, Pi retry started/ended/settled, execution completion-candidate observed/validated/rejected/submitted, checkpoint/retrieval/continuation/cursor/stale/rejected/quarantined, plus PTY/activity/lease/cancellation/gap/retention/transport projections.
- W3B-002: Per-kind compaction schemas require success/aborted/willRetry/result and exact originating turn/generation; settled/retry schemas require matching turn/generation/session/retry-cycle and phase, with state rules that make aborted/failed/mismatched events ineligible.
- W3B-002: Completion-candidate events distinguish controller execution-turn terminalization/proposal submission from canonical StoryCloseoutDecision.accepted and can never infer story/run/lifecycle completion.
- W3B-002: Per-kind payloads allow bounded canonical IDs/hashes/counts/reasons/budgets/timing/restricted refs only; raw prompts/transcripts, credentials, secrets, human attestations/signatures, unrestricted context, and deprecated epoch writes reject.
- W3B-002: Version/state order/duplicate/changed replay/gap/regression/generation/session/cursor/policy/receipt/bundle/dispatch rules reject unknown critical semantics, cross-generation splicing, and random-key bypass; permanent conflicts consume no retry.
- W3B-002: Read models expose active/degraded/failed/stale/rejected/authorized/dispatched/settled/gap/quarantined and retry-budget state only from canonical events and never infer authority from terminal/pane/process/candidate state.
- W3B-002: Projection compatibility exposes only exact read-only deprecated epoch mapping/use telemetry/removal posture; it never accepts stream ingestion or resolves caller-supplied projection IDs as authority.
- W3B-002: Generated schema/OpenAPI/TypeScript fixtures cover secret/attestation rejection, every changed replay dimension, successful/aborted/mismatched compaction, retry phases, candidate/closeout distinction, replay/gap/quarantine, and serialized ROR-28 integration.
- W3B-003: Migrations/repositories enforce unique stream-generation-sequence identity, immutable payload hashes, mission/work-package lineage, checkpoint cursors, and tenant/workspace isolation.
- W3B-003: Duplicate identical records are idempotent; changed payload, sequence regression, wrong turn/generation/fence/policy activation/checkpoint/repository/spec/story/path/validation identity, secret-bearing content, deprecated epoch write, and cross-workspace data are rejected and audited.
- W3B-003: Retention is bounded by age/bytes/records with explicit tombstones and archive integrity metadata; pruning cannot delete canonical evidence or lifecycle rows.
- W3B-003: Queries require bounded limit and opaque generation-bound cursor and report gaps/expired ranges rather than silently splicing streams.
- W3B-003: Fresh local PostgreSQL migration and repository tests cover concurrency, retention, archive corruption, pruning, generation rollover, and restart.
- W3B-003: Repositories and read APIs scope stream rows, opaque cursors, restricted raw references, archive manifests, retention, quota accounting, and alert transitions by workspace plus runtime generation; labels or project names alone never authorize access.
- W3B-003: Cross-workspace cursor, replay, archive, dashboard, alert, log, and error fixtures return no data and append a bounded audit reason without exposing whether another workspace identity exists.
- W3B-004: Managed PTY bytes retain exact ordering and generation identity and reference the existing integrity-checked raw archive rather than duplicating unbounded payloads.
- W3B-004: Structured managed activity, lease/runtime state, context transition, checkpoint, cancellation, and terminal transport records are emitted independently of terminal escape sequences.
- W3B-004: PTY process exit closes only its generation transport; it cannot settle story/run/lifecycle outcome.
- W3B-004: Malformed resize, redraw storm, binary/noisy output, partial UTF-8, output limit, disconnect, cancellation, and crash produce bounded observable stream behavior.
- W3B-004: Golden PTY lifecycle, noisy recovery, raw archive, checkpoint, cancellation, and multi-engine compatibility tests remain green.
- W3B-005: Ingestion accepts only an authenticated runtime holding the exact active lease/fence and binds every batch to mission/work-package/spec/story/attempt, policy activation, checkpoint, turn/generation/session/cursor, repository/Git/worktree/path, and validation/root-cause identity; deprecated epoch input rejects.
- W3B-005: Batch idempotency, sequence windows, body/rate limits, payload hashing, compression bounds, and database transactions prevent duplicate or unbounded ingestion.
- W3B-005: Stale fences, expired/cancelled leases, wrong runtime, revision drift, sequence gaps/conflicts, and unsupported versions fail closed with bounded diagnostics.
- W3B-005: MCP may project permitted read operations from OpenAPI but is neither telemetry transport nor trust/authority source.
- W3B-005: Contract fixtures use a fake remote runtime only; no external provider, second runtime, merge, deployment, or production activation is introduced.
- W3B-006: A checkpoint binds stream/generation, last durable sequence, payload/hash window, expiry/retention posture, and opaque self-verifying cursor data.
- W3B-006: Reconnect replays durable records after the checkpoint exactly once at the client contract level, then tails live records without omitting the handoff boundary.
- W3B-006: Expired, tampered, cross-run, cross-generation, future-sequence, and pruned checkpoints return explicit reset/gap responses rather than data from another stream.
- W3B-006: Slow/disconnected clients do not block ingestion; bounded buffers, heartbeat, backoff, and server-side disconnect protect memory and database resources.
- W3B-006: API annotations, authorization, pagination/cursor, reconnect race, restart, retention, and multi-client tests pass locally.
- W3B-007: Configured credential patterns, provider tokens, database URLs, authorization headers, environment secrets, and restricted context are redacted before ordinary API/UI projection.
- W3B-007: Raw archives preserve documented encrypted/restricted access and integrity metadata; redacted output cannot be reverse-resolved by public/MCP clients.
- W3B-007: Per-runtime, per-stream, per-client, and global byte/record/rate limits trigger explicit throttled/gap/terminated records and bounded cancellation visibility.
- W3B-007: Control characters, terminal injection, oversized events, compression bombs, invalid UTF-8, log forging, and malicious sequence churn cannot corrupt UI, evidence, or lifecycle state.
- W3B-007: Security tests and an independent redaction review verify no secrets, authority receipts, or cross-tenant records leak through live, replay, archive-manifest, logs, or errors.
- W3B-007: Ordinary observability stores and projects no raw prompt, transcript, unrestricted context, environment snapshot, database URL, provider token, credential value, or human attestation/signature; only bounded redacted fields and separately authorized opaque references are allowed.
- W3B-007: Per-workspace/runtime event, byte, replay, storage, retention, and alert budgets isolate throttling and circuit state so one noisy stream cannot consume another workspace buffer, cursor window, archive allocation, or notification budget.
- W3B-008: Existing raw terminal rendering, copy/scroll/resize, reconnect, completed transcript, and accessibility behavior remain available for legacy and managed streams.
- W3B-008: A structured lane renders normalized activity independently from PTY parsing and clearly labels terminal output and runtime assertions as observability, not evidence/lifecycle authority.
- W3B-008: The UI shows active/stale/expired lease, runtime generation, context transition, reconnect/replay, retention gap, cancellation requested/acknowledged, and degraded/error states without inventing success.
- W3B-008: All frontend calls use apiFetch, styles use tokens, keyboard/focus/screen-reader behavior is tested, and high-volume updates are batched/virtualized to avoid browser lockup.
- W3B-008: Frontend unit tests plus a local Playwright/browser journey validate live, disconnect/reconnect, refresh replay, gap/reset, cancellation, noisy PTY, empty, error, and completed states without CI.
- W3B-008: The UI and API expose source/config drift and typed dependency capability/health as two independent status planes, each with source identity, observedAt, validUntil, reason, impact, and next safe action.
- W3B-008: Runtime/process/sandbox/resource health and queue/outbox freshness/backlog are separate status planes and a green runtime cannot mask stale queue/outbox state or quota exhaustion.
- W3B-008: Lease/fence/retry/recovery state and observability ingest/replay/archive freshness are separate status planes and neither terminal activity nor heartbeat may set either plane healthy.
- W3B-008: Provider/operations readiness separately reports credential-reference rotation posture, provider quota/rate/circuit state, Doctor escalation, idle suspension, and resource-saga blockers without exposing credentials.
- W3B-008: No aggregate green badge, unit-test result, raw test count, process exit, PTY text, or runtime self-report may overwrite any plane or imply evidence, closeout, lifecycle, approval, merge, deployment, or production readiness.
- W3B-009: The shared normative contract assertions pass for managed PTY and fake federated telemetry across canonical identity, compaction/settled/retry/candidate events, sequencing/replay, retry budget/quarantine, checkpoints, retention, redaction/secrets, backpressure, cancellation, and versions.
- W3B-009: Restart and fault tests cover process crash, API restart, worker restart, transaction interruption, partial batch, slow client, corrupt archive, retention during replay, and generation rollover without cross-generation splicing.
- W3B-009: A CI-independent recipe runs fresh dedicated-owner PostgreSQL migrations, backend/frontend tests, local browser journeys, typecheck, public-contract/Swagger/license checks, security scan, and git diff --check.
- W3B-009: An independent frontend/security/runtime reviewer resolves all P0/P1 findings and verifies terminal non-authority, redaction, replay correctness, bounded resources, accessibility, and no merge/deploy authority.
- W3B-009: The exact-SHA completion packet records serialized shared-file integration with ROR-28 and confirms ROR-28/ROR-25 were the only overlapping waves.
- W3B-009: Isolation tests prove workspace A event floods, retention pruning, raw-reference probes, cursor replay, and alert storms cannot change workspace B status planes, quotas, data, or notifications.
- W3B-009: Status-plane fixtures independently vary all seven planes and prove source/freshness/reason/action parity across API, SSE replay, Run View, restart, and redacted error paths.

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
