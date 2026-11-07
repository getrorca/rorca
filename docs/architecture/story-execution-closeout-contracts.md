# Story execution and closeout contracts

LFC-008 defines the narrow boundary between lifecycle policy resolution and the existing execution engine.

## Contracts

- `StoryExecutionManifest` (`rorca.story-execution-manifest.v2`) is immutable and resolved before dispatch. It binds workspace/spec/story/run/attempt identity, spec and story revisions, execution mode, agent/model/effort/terminal/worktree/merge options, validation requirements, evidence expectations, repository profile, command-safety profile, the exact persisted `LifecycleDispatchClaim`, and the complete validated `LifecyclePlan` under one canonical hash. The plan is independently content-addressed by `lifecycle.binding.planHash`.
- `StoryAttemptResult` (`rorca.story-attempt-result.v1`) is append-only. Agent prose, process exit zero, output, and its completion packet remain proposals until host reconciliation.
- `StoryCloseoutDecision` (`rorca.story-closeout-decision.v1`) has only `accepted | blocked`. It carries stable reason codes, criterion mappings, normalized evidence references, the active subject revision, and the next safe action.

The closeout gate does **not** evaluate or write lifecycle phase state, approve QA, waive gates, choose retries, release dependencies, merge, deploy, or send externally. Policy activations, context checkpoints, retrieval receipts, bundles/deltas, dispatches, and controller-validated execution-turn completion candidates are execution-input/proposal provenance under the separate [context continuation contract](../contracts/context-checkpoint-retrieval-and-continuation.md); none is story evidence or closeout acceptance. Only an exact `StoryCloseoutDecision.accepted` establishes canonical story closeout.

Before any provider process starts, the host verifies the manifest hash, requires the claim to still select the current validated compiled-plan row, and matches the persisted plan bytes to `planHash`. Prompt construction then projects all seven stages, dispositions, gates, evidence requirements, current-story requirement mappings, completeness rules, and authority boundaries from that immutable plan. The projection is explanatory input; neither the prompt nor agent output can mutate lifecycle authority.

## Host authority

Required commands run through the autonomous command guard in the manifest-bound story worktree. The guard is command-policy/defense-in-depth, not the security boundary. The same concrete `bubblewrap` launch seam contains API drafting CLIs, semantic/RPC/PTY agents, conflict resolvers, GitReins, Hilo, workspace hooks, and worktree-controlled validation in fresh PID/proc/user/mount/network namespaces. It mounts only root-owned tool roots plus the exact worktree/Git metadata, masks credential files, supplies private HOME/tmp and a reconstructed environment, and exposes no direct network. Separate trusted API/worker Unix-socket CONNECT brokers permit exact configured public model hosts on 443 only; DB, GitHub, localhost/control-plane, arbitrary ports/hosts, ancestor environments, and host credential stores remain unreachable. Boundary preflight creates a trusted intermediate supervisor with a random marker in its initial `execve` environment: a controlled probe without PID isolation must observe it and exit 41, while the canonical `--unshare-all` probe must not. The marker is never passed to the bwrap launcher or child environment, arguments, files, commands, or logs. Raw local-dev autonomous launch is unavailable, and boundary preflight occurs before launch or before a run becomes running. A host observation records:

- canonical executable/argument hash;
- guarded working directory;
- redacted environment profile and fingerprint;
- start/finish and exit, signal, timeout, cancellation, or unavailable reason;
- bounded redacted output/reference;
- commit, branch, and worktree identity before and after validation.

Blocked commands and unavailable environments are typed blockers. Unrelated baseline failures require both host evidence and the manifest's named policy treatment. Revision mutation makes revision-sensitive evidence stale until rerun.

Direct commits are loaded from workspace/spec/run/story-scoped `story_commits`; a clean worktree therefore does not hide valid output. `.rorca`, generated memory/progress, forge runtime logs/spec state, and agent runtime files are metadata and cannot satisfy `code_required`. Legitimate no-code work requires an explicit `no_code_allowed` manifest profile and reason in implementation, QA, or Journey mode.

## Persistence and evidence

`story_execution_manifests`, `story_attempt_results`, and `story_closeout_decisions` journal immutable contracts and retries. Exact replay is idempotent; changed same-attempt content is rejected. Validated facts are adapted into the existing `ssdlc_lifecycle_evidence` store and remain bound to their commit revision. These tables are not a second evidence or lifecycle engine.

Missing manifests, version-1 manifests without a lifecycle binding, stale claims, changed compiled plans, and unsealed canonical export kits are blocked for new execution. Historical closeout reads may use only `pre-manifest-v0-before-cutoff` with a recorded cutoff, audit reference, and host evidence; that read compatibility cannot authorize a new or resumed provider invocation.

## Provider-neutral local review projection

An accepted or blocked closeout may be projected through the default `LocalReviewBundleAdapter` only from the exact durable host-attempt envelope and current Git object identity. The bundle references attempt results, closeout decisions, validation attestations, and run closeout by immutable IDs/digests; it never copies PTY, agent prose, memory, raw logs, or credentials. A bundle reports validation passed only when the exact host closeout and active host validation receipt already did so. Bundle creation itself cannot change `story_results`, closeout, lifecycle, release, merge, or deployment state.

The local projection is content-addressed and atomically finalized outside the repository checkout. PostgreSQL owns metadata/idempotency/conflict truth. Public clients receive hashes/counts/integrity and explicit no-merge/no-deploy state, never changed paths, patch bytes, or absolute host paths. See [Provider-neutral local-first delivery adapters](./provider-neutral-delivery.md).

## Explicit profile input

A spec or story may provide an `executionManifest` profile:

```json
{
  "executionManifest": {
    "profileId": "docs-evidence-only-v1",
    "changePolicy": "no_code_allowed",
    "noCodeReason": "This governed docs story changes no source code.",
    "baselineFailurePolicy": "block"
  }
}
```

Story values narrow/override the spec default. The engine consumes only the execution projection and cannot broaden the host-resolved contract from prose.
