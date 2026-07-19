# Story execution and closeout contracts

LFC-008 defines the narrow boundary between lifecycle policy resolution and the existing execution engine.

## Contracts

- `StoryExecutionManifest` (`rorca.story-execution-manifest.v1`) is immutable and resolved before dispatch. It binds workspace/spec/story/run/attempt identity, spec and story revisions, execution mode, agent/model/effort/terminal/worktree/merge options, validation requirements, evidence expectations, repository profile, command-safety profile, and a canonical hash.
- `StoryAttemptResult` (`rorca.story-attempt-result.v1`) is append-only. Agent prose, process exit zero, output, and its completion packet remain proposals until host reconciliation.
- `StoryCloseoutDecision` (`rorca.story-closeout-decision.v1`) has only `accepted | blocked`. It carries stable reason codes, criterion mappings, normalized evidence references, the active subject revision, and the next safe action.

The closeout gate does **not** evaluate or write lifecycle phase state, approve QA, waive gates, choose retries, release dependencies, merge, deploy, or send externally.

## Host authority

Required commands run through the autonomous command guard in the manifest-bound story worktree. The guard is command-policy/defense-in-depth, not the security boundary. On shipped Linux workers, the same concrete `bubblewrap` launch seam contains semantic/RPC/PTY agents, conflict resolvers, and worktree-controlled validation in fresh PID/proc/user/mount/network namespaces. It mounts only root-owned tool roots plus the exact worktree/Git metadata, masks credential files, supplies private HOME/tmp and a reconstructed environment, and exposes no direct network. A trusted worker-owned Unix-socket CONNECT broker permits exact configured public model hosts on 443 only; DB, GitHub, localhost/control-plane, arbitrary ports/hosts, ancestor environments, and host credential stores remain unreachable. Boundary preflight occurs before a run becomes running. A host observation records:

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

Missing manifests are blocked for new dispatches. Legacy reads may use only `pre-manifest-v0-before-cutoff` with a recorded cutoff, audit reference, and host evidence; the rule cannot be applied to a run after its cutoff.

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
