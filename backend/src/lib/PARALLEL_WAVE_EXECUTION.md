# Parallel-wave execution closeout design

The execution engine treats a compiled wave as the isolation boundary.

- Waves with two or more stories use one per-story worktree so agent subprocesses cannot write concurrently to the run branch.
- A compiled one-story wave runs directly on the run branch. It does **not** create or merge a per-story branch. The same `executeStory` path still performs agent execution, host validation, immutable-manifest closeout, canonical pass persistence, and completion evidence.
- Dispatch manifests mirror this policy: singleton stories are frozen against the run working directory; stories in concurrent waves are frozen against deterministic story worktrees. If an older or inconsistent singleton manifest names another guarded working directory, the engine raises `SINGLE_STORY_WAVE_DIRECT_EXECUTION_UNSAFE` and records a durable story failure instead of creating a branch silently.

Promise rejection is an infrastructure-level story failure, not an absent result. Settlement order correlates each rejection with its input story. The engine immediately adds that story to failed/processed accounting, writes bounded secret-redacted message and stack fields to canonical failure evidence, and keeps a bounded mode-0600 raw diagnostic only in the local run log directory. The rejected story worktree is preserved; cleanup is restricted to known worktrees from the current wave and preserve decisions take precedence.

A run is successful only when there are no failed stories, rejected promises, unresolved pending integration closeouts, or durable-evidence write gaps. Any of those conditions produces a non-zero engine outcome.
