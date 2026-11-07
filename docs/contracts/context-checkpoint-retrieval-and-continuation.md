<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Context checkpoint, retrieval, and continuation — canonical contract requirements

- **Status:** Draft design input; not yet an implemented wire schema
- **Contract family:** `rorca.context-continuation.v1`
- **Owning wave:** Wave 2 / ROR-23
- **Runtime implementations:** Wave 3A managed adapter; Wave 4 federated pilot
- **Structured projections:** Wave 3B

This document defines the canonical boundary used to continue governed work after
compaction, process/controller restart, and other material context changes. It is
not an implementation claim. Wave 2 must publish validated schemas and state
transitions; Wave 3A and Wave 4 must implement and prove them.

## Authority and trust model

Rorca is the canonical mission, policy, context, lease, evidence, closeout, and
lifecycle authority. Hermes orchestrates retrieval and continuation requests.
Managed or federated runtimes consume bounded context and propose work. Memory
is advisory.

```text
Rorca canonical state + active lease + active policy activation
              ↓
Hermes/managed controller requests retrieval
              ↓
Rorca verifies scope and builds required context
              +
advisory memory retrieval (policy-permitted degradation only)
              ↓
Rorca records RetrievalReceipt and verified ContextBundle[/Delta]
              ↓
Rorca authorizes one ContinuationDispatch
              ↓
runtime adapter sends one same-session continuation
```

None of these contracts grants spec approval, execution authority outside the
active lease, evidence trust, story completion, lifecycle transition, merge, or
production authority. A retrieval result, bundle, checkpoint, continuation
prompt, terminal line, process exit, or controller-validated execution-turn
completion candidate cannot prove canonical story completion.

## Context classes

Every bundle has two structurally distinct sections. Content cannot move between
classes based on source labels supplied by a runtime.

### Required execution context

Required context is canonical, exact, and fail-closed. It includes:

- workspace, mission contract revision/hash, work-package ID/revision/hash;
- canonical spec ID/version/hash/path, story ID/version/hash, exact acceptance
  criteria/requirement identities and text, invariants, prohibited outcomes,
  validation/evidence obligations, and completion definition;
- run, attempt, runtime, controller generation, Pi generation, logical session,
  originating turn, lease ID/fence/expiry, and cancellation identity;
- repository identity, remote authority, full base/current/expected head SHA,
  branch and host-created worktree identity, and allowed/required/changed/
  forbidden path manifests and hashes;
- progress cursor, latest persisted `ContextCheckpoint`, completed/pending steps,
  current plan/task cursor, and unresolved blockers;
- validation state, root-cause/failure classification, bounded validation output
  references/hashes, attempt/evidence/closeout references, and known conflicts;
- exact direction layers, compiler versions, immutable policy-definition identity,
  active policy-activation identity, and effective numeric policy values;
- required tool/runtime capability and redacted secret-reference identities.

Required content is either complete and hash-verified or retrieval fails.
Required content is never silently omitted, summarized beyond a
contract-declared canonical representation, displaced by memory, or truncated
to fit advisory content.

### Advisory semantic memory

Advisory memory consists only of workspace-scoped, provenance-bound decisions,
conventions, patterns, and gotchas with stable memory ID, content hash, source,
trust/confidence, observed/approved time, freshness, and sensitivity metadata.
It may improve implementation choices. It can never:

- grant lease, path, tool, provider, delivery, merge, or deployment authority;
- replace or override mission/spec/story/criterion/direction/policy content;
- satisfy validation, evidence, closeout, QA, lifecycle, or approval obligations;
- prove completion or promote story/run/lifecycle state;
- cross workspace, mission, or sensitivity boundaries;
- become durable truth merely because it was retrieved or used.

## Canonical identities

### Artifact header

Every artifact except an immutable policy definition carries `schemaVersion`,
`contractId`, `contractVersion`, `contentHash`, `createdAt`, and `createdBy`.
Hashes use length-prefixed canonical UTF-8 values and SHA-256. Delimiter-only
concatenation, short/relative SHAs, branch names as revision identity, raw secret
values, caller-inferred defaults, and unknown authority fields are invalid.

### `ContinuationScope`

Checkpoint, receipt, bundle, delta target, dispatch, and structured events carry
this exact tuple:

```text
workspaceId
missionId / missionRevision / missionHash
workPackageId / workPackageRevision / workPackageHash
specId / specVersion / specHash / canonicalSpecPath
storyId / storyVersion / storyHash / criteriaManifestHash
runId / attemptId
leaseId / fencingToken / leaseExpiresAt / cancellationId
runtimeId / controllerGeneration / runtimeGeneration
sessionId / sessionFileHash
turnId / turnAttempt / originatingGeneration
cursor / cursorHash / priorEntryId
repositoryId / remoteAuthorityHash / baseSha / currentSha / expectedHeadSha / worktreeId
allowedPathManifestHash / requiredPathManifestHash / changedPathManifestHash
validationStateHash / rootCauseClassification / rootCauseHash
policyDefinitionId / policyDefinitionVersion / policyDefinitionHash
policyActivationId / policyActivationRevision / policyActivationHash
```

A field may be explicitly `not_applicable` only where its schema permits it.

A policy activation cannot carry `ContinuationScope` because that would
circularly contain its own identity and would force reactivation on each cursor
advance. Instead it carries exact `ActivationScope`: workspace; mission,
work-package, spec, story, and criteria identities/hashes; run/attempt;
lease/fence/cancellation; runtime ID; repository/remote authority; immutable
`baseSha`; worktree; allowed/required path manifests; and policy-definition
identity. It excludes policy-activation ID/hash, controller/runtime generation,
turn, session/cursor, `currentSha`/`expectedHeadSha`, changed paths, and dynamic
validation/root-cause state. Those dynamic values remain mandatory on every
artifact in `ContinuationScope`.

## Deprecated `ContextEpoch` read projection

`ContextEpoch` is not a canonical contract and is never mutable/current
authority. It is a deprecated server-generated read projection named
`rorca.context-epoch-projection.v0` for old clients only. No new schema, lease,
evidence, closeout, API mutation, event write, adapter input, or conformance case
may accept it as authority.

For one requested canonical bundle, the projection is exactly:

```text
legacyEpochId = "ctxe_" + SHA256(
  checkpointId, checkpointVersion, checkpointHash,
  policyDefinitionId, policyDefinitionVersion, policyDefinitionHash,
  policyActivationId, policyActivationRevision, policyActivationHash,
  retrievalReceiptId, retrievalReceiptVersion, retrievalReceiptHash,
  contextBundleId, contextBundleVersion, contextBundleHash,
  continuationDispatchId-or-not_applicable,
  continuationDispatchVersion-or-not_applicable,
  continuationDispatchHash-or-not_applicable
)
```

The read response returns those fields verbatim, `projectionOnly=true`,
`authoritative=false`, `generatedAt`, and `compatibilityRemovalNotBefore`. It is
resolved from canonical records on every read and has no table, independent
revision, current pointer, lifecycle, writer, lease field, or fallback value.
The dispatch fields may be `not_applicable` only before a dispatch exists; a
projection without the exact checkpoint, definition, activation, receipt, and
bundle identities is invalid.

- `GET` compatibility reads are allowed only for an authenticated subject already
  authorized to read every referenced canonical record.
- `POST`, `PUT`, `PATCH`, upsert, event ingestion, lease acquire/renew/release,
  result/evidence ingestion, and adapter requests containing an epoch as input
  fail before mutation with non-retryable `deprecated_context_epoch_write`.
- A caller-supplied `legacyEpochId` is never resolved to grant access. Hash or
  component mismatch returns non-retryable `context_epoch_projection_mismatch`.
- Existing historical rows may be read and mapped only when every component can
  be verified. Unmappable rows return `legacy_context_unmappable`; they do not
  synthesize canonical authority.

The compatibility window starts with the first release that writes only the v1
canonical family and lasts through **two consecutive minor releases and at least
90 days**, whichever is later. Removal is permitted only in the next declared
major contract release after all of these checked gates pass: 30 consecutive
days of zero projection reads in bounded telemetry; no supported client or
fixture writes/consumes the projection; migration and rollback fixtures pass;
public-contract/OpenAPI/MCP break markers and release notes name the removal;
and an independent exact-SHA compatibility review accepts the packet. Until
then reads remain supported and writes remain rejected. Wave 2 owns the gate;
Wave 3A, Wave 3B, and Wave 4 consume only canonical identities.

## Versioned contracts

### `ContextCheckpoint` — `rorca.context-checkpoint.v1`

A checkpoint is the immutable continuation boundary persisted before retrieval
or a generation handoff. It contains:

- `ContinuationScope` plus `checkpointId`, monotonic `checkpointSequence`,
  `checkpointReason`, `priorCheckpointId`, and typed `triggerMaterial`;
- last durable Pi/session entry ID, stream/event high-water marks, and plan/task
  cursor;
- exact completed/pending work, root-cause and validation state;
- changed-path manifest/hash and current Git/worktree observations;
- bounded evidence, validation, failure, artifact, and raw-output references;
- exact compaction/settlement/retry/completion-candidate facts described below;
- redaction/sensitivity manifest and retention class.

State transitions:

```text
proposed → persisted → current → superseded
                  ↘ rejected
```

Only a Rorca-authorized host adapter can transition `persisted → current` after
scope/hash/lease verification. `superseded` is append-only. A checkpoint is
progress provenance, not evidence acceptance or completion.

### Immutable `ContextContinuationPolicyDefinition`

`rorca.context-continuation-policy-definition.v1` is reusable configuration. It
contains `policyDefinitionId`, semantic `policyDefinitionVersion`, immutable
canonical body/hash, issuer authority, supported contract versions, trigger
rules, source allowlists, budgets, TTL/drift/delta rules, redaction/sensitivity,
failure behavior, and retry/quarantine limits. It contains no run, lease,
generation, session, cursor, Git, or worktree identity.

Every saved definition revision, including draft, is immutable; an edit creates
a new version/hash. Lifecycle is append-only authority metadata:

```text
draft → validated → published → superseded
               ↘ rejected       ↘ revoked
```

Supersession selects a newer definition for future activations but does not
rewrite history. Revocation records reason, authority receipt, database time,
and effective boundary; it forbids new activation and revokes every unconsumed
artifact whose activation names the definition unless an explicit revocation
record narrows the affected activation set. A runtime, Hermes, event, memory
source, or projection cannot publish, supersede, revoke, amend, or revive it.

Version 1 defaults are bounded and testable:

| Limit | Default | Hard maximum |
| --- | ---: | ---: |
| total rendered context | 32,000 tokens | 64,000 tokens |
| required-context allocation | 24,000 tokens | 48,000 tokens |
| advisory-memory allocation | 4,000 tokens | 8,000 tokens |
| transition/controller instructions | 4,000 tokens | 8,000 tokens |
| advisory items | 20 | 50 |
| required source records | 200 | 500 |
| bundle serialized size | 2 MiB | 4 MiB |
| bundle TTL | 15 minutes | 60 minutes |
| delta chain | 8 | 8 |
| retrieval attempts | 3 | 5 |
| dispatch transport reconciliations | 2 | 3 |

Required context has priority. If its canonical representation exceeds the
allocation, Rorca returns non-retryable `required_context_oversize` and blocks;
it does not truncate criteria or borrow authority from an advisory summary.

### Scope-bound `ContextContinuationPolicyActivation`

`rorca.context-continuation-policy-activation.v1` is the only effective policy
reference for retrieval/dispatch. It binds one exact definition ID/version/hash
to `ActivationScope`, an activation ID/revision/hash, effective numeric values,
activating authority/receipt, `activatedAt`, optional `expiresAt`, and revocation
state. It may span checkpoint, cursor, current-SHA, validation/root-cause, and
fenced generation changes only while the exact activation scope and lease remain
valid; each resulting artifact still carries those dynamic identities.

```text
proposed → verified → active → superseded
                    ↘ rejected  ↘ revoked
```

Only one activation is active for a dispatch scope. A scope or effective-value
change creates a new activation; no in-place edit exists. Revocation/supersession
makes unused receipts, bundles, deltas, and authorizations stale immediately.
Already dispatched facts remain immutable observations but grant no new send.
Receipts, bundles, deltas, and dispatches hash **both** definition and activation
identities. A definition identity alone is insufficient.

### `RetrievalReceipt` — `rorca.retrieval-receipt.v1`

A receipt is Rorca's immutable account of one retrieval request. It contains:

- `retrievalRequestId`, `retrievalReceiptId`, typed trigger, checkpoint ref;
- `ContinuationScope`, definition and activation refs, and idempotency key;
- required/advisory source manifests, stable source IDs/hashes, freshness,
  exclusions, dedupe decisions, and redaction decisions;
- token/byte budgets requested, used, omitted, and remaining by class;
- resulting bundle/delta IDs, versions, hashes, and base identity;
- status, stable reason codes, start/finish/database times, duration,
  retryability, retry-budget identity, and explicit degraded dimensions;
- telemetry correlation ID without raw prompts, transcripts, secret values, or
  human authority payloads.

```text
requested → assembling → completed
                       ↘ degraded
                       ↘ failed
                       ↘ rejected
```

`degraded` is valid only when every required source is complete/current and an
allowed advisory source failed or was excluded. Required-source absence,
wrong-workspace data, stale canonical identity, hash mismatch, or oversize is
`failed` or `rejected`, never `degraded`.

### `ContextBundle` and `ContextBundleDelta`

`ContextBundle` (`rorca.context-bundle.v1`) is an immutable renderable input. It
contains `ContinuationScope`, checkpoint/receipt/definition/activation refs,
`requiredContext`, `advisoryMemory`, deterministic ordering, source-level
hashes, redaction manifest, token accounting, expiry, and final `bundleHash`.

`ContextBundleDelta` (`rorca.context-bundle-delta.v1`) contains deterministic
add/remove/replace operations against one exact `baseBundleId/baseBundleHash`
and declares the complete target scope/hash. Applying it must reproduce the
full target bundle bytes/hash. Dedupe keys are `(contextClass, sourceType,
stableSourceId, sourceVersion, contentHash)`; records never dedupe across
classes. Conflicting canonical records block required context and remain
explicit for advisory memory. The ninth change requires a full bundle.

#### Verified stale-base reconstruction exception

A base bundle that is stale against the current target may be read **only** as
immutable reconstruction input. It cannot be activated, rendered to a runtime,
used for lease verification, or dispatched. Rorca must load it by exact ID/hash,
verify its original signature/content/source manifest and retention integrity,
and compare it to the current target inside one verification transaction.

The base and target must match exactly on workspace, mission/work-package,
spec/story/criteria hashes, run/attempt, lease/fence/cancellation, logical
session, repository, immutable `baseSha`, worktree, allowed/required path scope,
and policy definition/activation. Only these differences are permitted:

- checkpoint/receipt/bundle identity and timestamps/expiry;
- cursor/hash, prior entry, turn, and changed-path manifest;
- `currentSha`/`expectedHeadSha` when host Git proves target `currentSha` is a
  descendant of base `currentSha`, the merge base is the declared immutable
  `baseSha`, and every intervening changed path is allowed and represented;
- validation/root-cause state and bounded evidence/source manifests;
- controller/runtime generation only for a typed restart/handoff trigger whose
  fenced ancestry and dead prior writer are host-verified.

Any policy activation change, lease/fence change, session change, repository or
worktree move, base-SHA change, spec/story/criteria change, forbidden/unobserved
path, non-descendant Git history, unavailable/corrupt base, unsupported version,
secret/redaction uncertainty, chain overflow, or failure to reproduce the exact
full target bytes requires a newly assembled **full bundle**. The fallback is
not a retry of the delta key and cannot use the stale base as context.

Delta state is `proposed → verified → applied`, with `rejected`, `stale`, and
`superseded` terminal branches. Bundle state is `assembled → verified → active →
superseded`, with `rejected` and `stale` branches. Only Rorca verifies either.

### `ContinuationDispatch` — `rorca.continuation-dispatch.v1`

A dispatch is the one-use instruction to continue an existing logical session.
It contains:

- `continuationDispatchId`, typed trigger, checkpoint/receipt/bundle refs;
- definition and activation refs plus full `ContinuationScope`;
- exact target Pi RPC session/cursor, expected prior entry ID, and expected
  post-dispatch cursor relationship;
- rendered payload hash and bounded restricted raw reference;
- Rorca lease-verification receipt/time and authorization expiry;
- controller identity, adapter version, dispatch attempt, retry-budget identity,
  idempotency key, disposition, and stable reason.

```text
proposed → lease_verified → authorized → dispatched → settled
        ↘ rejected       ↘ expired      ↘ failed
                                      ↘ quarantined
```

`authorized → dispatched` is a compare-and-set with one uniqueness constraint
over canonical continuation identity. A crash before it may retry the identical
transaction. A crash after it may reconcile/observe but cannot send again.
`settled` requires the matching generation/turn `agent_settled` and a new
non-empty assistant entry/cursor advance; it does not imply completion.

## Trigger and turn-decision contracts

### Typed `TriggerMaterial`

Every checkpoint and retrieval key contains exactly one discriminated trigger:

| Trigger | Required canonical material in addition to `ContinuationScope` |
| --- | --- |
| `initial_dispatch` | launch request/hash, normalized engine request/hash, initial source-manifest hash |
| `successful_compaction` | compaction ID, start/end event IDs/hashes, `status=success`, `aborted=false`, `willRetry=false`, summary hash, originating turn/generation, matching settled ID/hash, retry-phase identity, completion-candidate state/hash |
| `generation_restart` | prior/new controller and runtime generations, process-group identity hash, restart reason/evidence hash, prior-writer-death receipt |
| `story_wave_transition` | from/to story and wave IDs/versions/hashes, transition authority receipt/hash |
| `material_file_scope_change` | prior/current allowed, required, changed and forbidden path-manifest hashes, host Git status/diff hash |
| `validation_root_cause_change` | prior/current validation-state hashes, prior/current root-cause class/hash, changed validation-reference manifest hash |
| `meaningful_retry` | retry preview/receipt/hash, prior/new attempt/generation, failed-scope hash, changed-source-vector hash |
| `ttl_or_source_staleness` | prior bundle/expiry, database observation time, current required/advisory source-manifest hashes |
| `explicit_missing_context` | request/event ID/hash, missing-context reason, missing required-reference manifest hash |

A material change receives a new typed key. Reusing an existing key with changed
material is a permanent conflict, not a signal to invent a nonce or retry.

### Successful compaction eligibility

Continuation after compaction requires all facts below, persisted and
replayable:

1. `context_compaction_ended` is `status=success`, `aborted=false`, and names its
   originating `turnId`, `turnAttempt`, session, controller/runtime generation,
   matching `context_compaction_started`, result/summary hash, and `willRetry`.
2. A later `agent_settled` has the same turn, session, and originating generation;
   sequence/host-receipt order match and its event ID/hash are stored.
3. Pi retry state names `retryCycleId`, phase (`none | started | ended |
   settled | fenced`), retry attempt/max, start/end/settled event IDs/hashes, and
   generation. Dispatch is forbidden in `started` or `ended`; it is eligible only
   in `none` or after matching `settled`/`fenced` proves no Pi retry is pending.
4. The execution-turn completion candidate is explicit: `absent | observed |
   controller_rejected | controller_validated | submitted_to_closeout`. A
   controller-validated candidate terminalizes only the execution turn and
   submits result/evidence proposals, so no continuation is sent for that turn.
   It is not `StoryCloseoutDecision.accepted` and cannot set story/run/lifecycle
   state. If closeout later blocks, governed retry/replan authority selects the
   next attempt; the old compaction key is never reopened.
5. The active lease, definition/activation, checkpoint, and source state still
   match at authorization and dispatch CAS.

An aborted, failed, unmatched, cross-generation, retry-ambiguous, or
completion-candidate-ambiguous compaction blocks and reaches bounded quarantine;
it never dispatches speculatively.

## Idempotency

Canonical values are length-prefixed by field name and byte length, encoded as
UTF-8, then SHA-256 hashed. `ContinuationScope` includes repository/base/current
SHA/worktree, spec/story/criteria hashes, path manifests, validation/root-cause,
policy definition, and policy activation; those values may not be omitted.

```text
checkpointKey = H("checkpoint", ContinuationScope, TriggerMaterial)
retrievalKey = H("retrieval", checkpointKey, requiredSourceManifestHash,
  advisoryQueryHash, policyDefinitionHash, policyActivationHash)
bundleKey = H("bundle", retrievalReceiptId, completeOrderedSourceHashList,
  redactionManifestHash, tokenAllocationHash, targetScopeHash)
deltaKey = H("delta", baseBundleId, baseBundleHash, targetScopeHash,
  canonicalOperationListHash, reconstructedTargetBundleHash)
continuationKey = H("continuation", ContinuationScope, TriggerMaterial,
  checkpointHash, retrievalReceiptHash, bundleOrReconstructedTargetHash,
  renderedPayloadHash)
```

Identical replay returns the existing object. Changed reuse returns audited,
non-retryable `idempotency_payload_conflict`, consumes no transport retry, and
increments a persistent conflict counter. Repository, base/current SHA,
worktree, spec/story/criteria, path manifests, validation/root-cause, retry
phase, completion candidate, generation, session/cursor, policy activation, or
bundle changes necessarily produce a different valid key through typed input,
never through a random suffix.

## Retrieval, redaction, secrets, and authority payloads

- Rorca resolves canonical sources by server-owned identity; runtime-supplied
  text is never promoted into required context.
- Retrieval is workspace-first. A source lacking exact workspace provenance is
  rejected even if semantically similar.
- Secret values, bearer tokens, database URLs, provider credentials, human
  attestation/signature payloads, private keys, and raw environment snapshots
  are prohibited from contracts, trigger material, keys, telemetry, and rendered
  context. Hashes never accept secret values as input.
- Only server-resolved opaque capability/secret references may occur. Reference
  hashes prove identifier integrity, not possession or authority.
- Restricted raw content stays behind existing authorization/retention controls.
  Bundles contain bounded redacted excerpts or opaque references.
- Hashes cover canonical source identity and separately cover the permitted
  redacted representation; public clients receive only allowed hashes/content.
- Terminal/activity output may name a raw reference but is not required truth
  unless a separate host-normalized canonical record exists.

## Staleness and rejection

Except for the narrow stale-base reconstruction read above, Rorca rejects a
checkpoint, receipt, bundle, delta, activation, or dispatch when any required
canonical identity differs from current state, including:

- wrong workspace, mission, work package, spec/story/criteria, run, or attempt;
- expired/cancelled/superseded lease or stale fence;
- changed direction, policy definition/activation, required source, validation,
  root cause, or path manifest not represented by a typed checkpoint;
- moved repository/worktree, wrong base/current SHA, or unverified Git ancestry;
- session/cursor regression or cursor from another turn/generation;
- expired TTL, unsupported version, bad hash, or delta/base mismatch;
- advisory memory from another workspace or above sensitivity ceiling.

Rejection persists a bounded reason/event. It never falls back to an older
bundle, deprecated epoch projection, semantically similar workspace, or random
idempotency key.

## Failure, retry, and quarantine policy

- Required context or lease verification failure blocks continuation.
- Advisory outage may degrade only when the active policy activation permits it;
  receipt, bundle, stream, and UI name the absent source.
- One PostgreSQL-owned `ContinuationRetryBudget` per continuation identity
  aggregates every API, worker, Hermes, controller, companion, and transport
  attempt. Actors cannot each spend a separate budget.
- Default retrieval attempts are 3; dispatch transport reconciliations are 2.
  Backoff uses database time, server-provided `retryAfter`, expiry, and one
  in-flight retry lease. Duplicate deliveries do not increment attempts.
- Authority, identity, workspace, secret, hash, unsupported-version, stale,
  changed-replay, aborted-compaction, and forbidden-delta failures are permanent
  and never retried as transient.
- A meaningful source/Git/validation/policy change creates a new typed trigger
  identity only after host verification; it does not reset the old budget.
- Exhaustion, repeated permanent conflict, or ambiguous post-dispatch state is
  quarantined for operator reconciliation. It never widens scope, starts a
  second writer, sends a second prompt, or marks work complete.

## Rorca lease verification before continuation

Rorca verifies the active lease twice: immediately before authorization and in
the dispatch compare-and-set transaction. Verification covers lease ID/fence,
expiry/cancellation, mission/work-package/spec/story revision, runtime and turn/
generation, repository/base/current SHA, worktree/path scope, session/cursor,
policy definition/activation, checkpoint, receipt, and bundle hash. The adapter
rejects expired authorization or any mismatch with loaded Pi session state.

## Structured telemetry

The runtime-neutral registry includes at least:

```text
context_compaction_started
context_compaction_ended
agent_settled_observed
pi_auto_retry_started
pi_auto_retry_ended
pi_auto_retry_settled
execution_completion_candidate_observed
execution_completion_candidate_validated
execution_completion_candidate_rejected
execution_completion_candidate_submitted
context_checkpoint_persisted
context_retrieval_requested
context_retrieval_completed
context_retrieval_degraded
context_retrieval_failed
continuation_authorized
continuation_dispatched
continuation_settled
cursor_advanced
context_stale
context_rejected
continuation_quarantined
```

Every event carries canonical IDs/hashes, trigger, turn/generation/session/cursor,
checkpoint/definition/activation/receipt/bundle/dispatch refs where applicable,
event/payload hash, host receipt order, and bounded reason metadata. Compaction,
settled, retry, and completion-candidate events require their exact matching
identity and phase fields. Raw secrets, prompts, transcripts, and human authority
payloads are forbidden.

Metrics include retrieval latency, source counts, token use, dedupe savings,
delta/full ratio/fallback reason, stale/rejected counts, degraded dimensions,
retry-budget spend, dispatch reconciliation, duplicate suppression, permanent
conflicts, aborted compactions, and quarantine. Telemetry and read models remain
non-authoritative.

## Current precursor and target status

Direct/raw tmux pane behavior is not this supervised contract and pane output is
not a continuation or completion protocol. The current Hermes Pi supervisor
precursor fences one writer, persists Pi RPC session/cursor state, observes
`compaction_end`, retry start, and `agent_settled`, and issues bounded repair
prompts. It does **not** persist all successful/non-aborted turn/retry identities,
request canonical Rorca retrieval, verify a receipt/bundle/activation, obtain a
lease-verified dispatch, or prove exactly-once continuation. Those behaviors
remain Wave 2/3A/3B/4 implementation and conformance work.

## Minimum conformance cases

A conforming implementation proves locally:

- initial full bundle and same-input idempotent replay;
- changed replay for repository ID, base/current SHA, worktree, spec/story/
  criteria, allowed/required/changed paths, validation/root cause, retry phase,
  completion-candidate state, policy activation, and every trigger-specific
  material field;
- successful non-aborted max-output compaction with `willRetry=false`, exact
  originating turn/generation, matching settled identity, and one continuation;
- aborted/failed compaction and mismatched settled events produce zero dispatch;
- Pi retry start/end/settled phases suppress controller continuation until the
  matching retry cycle settles or is fenced;
- execution-turn completion candidate terminalizes only that turn, submits
  proposals, and never substitutes for canonical closeout acceptance;
- missing settled with fenced timeout/restart; crash before/after retrieval and
  before/after dispatch CAS; duplicate delivery and cursor/session restart;
- stale-base delta success for only permitted differences, plus full-bundle
  fallback for every forbidden/ambiguous difference;
- stale lease/fence/turn/generation/Git/policy activation/bundle/delta/cursor
  rejection; required outage blocks; permitted advisory outage degrades;
- deprecated epoch reads map exactly, every epoch write fails before mutation,
  and retirement telemetry/removal gates are executable;
- secret and human-authority payload rejection across schemas, keys, logs, and
  errors; wrong-workspace memory rejection;
- one distributed retry budget prevents storms; permanent conflicts do not
  retry; exhaustion quarantines;
- exactly one authorized continuation, writer, and process; same-session cursor
  advancement; no story/run/lifecycle completion without canonical closeout.
