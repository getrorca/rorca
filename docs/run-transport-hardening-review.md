# Run Transport and Genesis Closure Review

## Incident reviewed

Run `20260316000487` requested Pi, `openai-codex/gpt-5.6-terra`, high effort, sequential execution, and PTY mode. The database retained those requested values, but the UI showed Claude and the output endpoint demoted the run to an ANSI transcript.

## Root causes

1. PostgreSQL returns `BIGINT` run IDs as strings. The trigger route passed that string into a strict pg-boss schema requiring a number, so the worker rejected otherwise valid jobs.
2. The worker did not pass the already-validated workspace ID to the execution engine. The engine tried to rediscover it over the backend HTTP API. If the API was unavailable during startup, workspace resolution returned null.
3. PTY activation was conditional on that nullable workspace ID. A failed HTTP lookup therefore silently changed a requested PTY Pi run into the non-PTY Pi RPC path.
4. The output SSE endpoint waited five seconds for `run_pty_sessions`, then permanently demoted an active run. Context routing and prompt assembly can legitimately take longer than five seconds before node-pty starts.
5. SSE reconnects ignored `Last-Event-ID`, replaying duplicate/unbounded output.
6. Async interval polls could overlap under database latency and duplicate delivery work.
7. Poll failures emitted the same `done` marker as real run completion.
8. PTY setup failures after `node-pty.spawn()` could leave an untracked agent process alive.
9. The run-detail endpoint exposed canonical snake_case agent fields and top-level camelCase aliases, while `RunViewPanel` read camelCase only from the nested run. `AgentBadge` then defaulted to Claude.
10. The web trigger UI had no PTY control and did not model Pi as a first-class engine for effort controls.
11. Worktree runs passed the source workspace's approved spec path to the engine. Story pass/skip mutation therefore occurred outside the worktree, and uncommitted/ignored specs could be absent from the worktree entirely.
12. Run detail read `.rorca/run-state.json` from the main workspace instead of `worktree_path`, making active isolated runs appear stuck at 0/N.
13. The Genesis closure spec combines Rorca-core stories (`GLC-001`, `GLC-002`) with Genesis-repository stories. One workspace run cannot safely own both repositories; dependent bridge stories become blocked when the upstream story fails.
14. Brownfield databases could already have `memory_candidates` from an older migration. The newer `CREATE TABLE IF NOT EXISTS` did not add the unified `payload` column, so context distillation failed after every story despite clean-install tests passing.
15. Rate-limit rerouting treated an authentication file as sufficient fallback readiness. It could select Codex or Claude even when the corresponding CLI binary was unavailable, obscuring the real rate-limit failure with a second infrastructure error.

## Hardened design

- Normalize generated BIGINT run IDs to safe numbers at producer boundaries.
- Require both authentication and an installed CLI before selecting a rate-limit fallback engine.
- Apply an idempotent brownfield migration for the unified `memory_candidates.payload` contract.
- Pass workspace identity explicitly from route → pg-boss payload lookup → worker → engine argument/environment.
- Copy each worktree run's executable spec to an ignored, run-owned worktree snapshot; never mutate the source checkout's approved spec.
- Fail closed if a requested PTY run lacks workspace identity; never silently substitute RPC/ANSI execution.
- Treat active PTY runs with no session as `session pending`, not unavailable.
- Keep terminal runs with no PTY session as explicit ANSI fallback with an accurate diagnostic.
- Persist raw terminal bytes as the replay source of truth.
- Use PostgreSQL `LISTEN/NOTIFY` only as a low-latency cross-process wake-up; SSE handlers fetch committed rows by sequence. Retain bounded polling as reconnect/notification-loss recovery.
- Honor `Last-Event-ID` for exact SSE resume and suppress overlapping polls.
- Distinguish retryable stream transport errors from true `done` events.
- Terminate process groups when PTY setup fails after spawn.
- Normalize agent/model fields once at the API and UI boundaries.
- Read live run-state from `worktree_path` for isolated runs.
- Disable archived PTY input and retry browser dimensions when a pending session becomes active.
- Expose an explicit Interactive PTY option in normal web trigger flows; enabling it forces sequential execution.

## Spec correction required

Split the closure plan into two independently executable specs:

1. **Rorca core compatibility**: `GLC-001`, `GLC-002`, executed in the Rorca workspace and producing a reviewed Rorca commit/branch.
2. **Genesis launch closure**: `GLC-003`–`GLC-012`, executed in the Genesis workspace after the Rorca compatibility artifact is available. Replace cross-repository dependencies with a versioned compatibility/canary precondition.

Do not retry `GLC-001` inside the Genesis worktree. Preserve its existing isolated Rorca commit for review, then rerun the corrected upstream spec with an explicit `RORCA_CORE_PATH`/workspace contract.
