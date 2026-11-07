# Linear Issue Drafts: SSDLC Autonomy Contracts for Rorca/Hermes

Use this file to create a Linear epic and initial implementation issues. Source context lives in `docs/prds/rorca-genesis/linear-document.md` under `## SSDLC autonomy contracts for complete end-to-end execution`.

## Epic

### Title
SSDLC Autonomy Contracts for Complete Rorca/Hermes End-to-End Execution

### Description
Rorca and Hermes should complete autonomous software delivery through small deterministic skills and hard SSDLC contracts rather than relying on agent success messages. Recent runs exposed ambiguity around retry scope, stale `passes` flags, clean worktrees after agent-created commits, stale worktrees, unclear liveness, baseline validation failures, runtime artifact drift, sequential execution guarantees, and canary/merge-readiness evidence.

Operating principle:

> Agents may spend tokens, but only validated contracts advance state.

The epic adds machine-readable story completion packets, pass-state reconciliation, worktree freshness checks, retry-scope verification, merge-readiness/canary evidence, canonical liveness classification, and run closeout memory/decision capture.

### Success criteria
- Story pass requires a machine-readable completion packet plus pass-gate evidence.
- Retries verify and execute the smallest safe scope.
- Approved spec `passes` flags, DB `story_results`, progress artifacts, and commits can be reconciled deterministically.
- Agent-created commits count as story output even when the worktree is clean.
- Stale reusable worktrees are detected and safely refreshed before retry.
- Long-running stories have canonical liveness classification from process/WAL/log/git/DB/terminal signals.
- Merge/canary readiness is explicit and evidence-backed.
- Human approval gates remain mandatory for high-risk merges/deploys.

---

## Issue 1 — Add canonical story completion packets

### Summary
Require each story to emit a durable machine-readable completion packet before it can pass.

### Background
Progress markdown and `story_results` exist, but they are not a strict completion contract. Operators currently inspect logs, DB rows, git status, and progress files manually.

### Requirements
- Define a JSON schema for story completion packets.
- Include story ID, acceptance-criteria evidence, files changed, commits, validation results, known issues, safe-to-pass flag, and next recommended action.
- Store packets in a stable per-run location and/or DB table.
- Make the execution engine write or validate packets at story closeout.
- Ensure progress markdown and packet state do not contradict each other.

### Acceptance criteria
- A story cannot pass without a valid packet unless explicitly marked as legacy/override with audit evidence.
- Packet validation fails if acceptance evidence or validation evidence is missing.
- Packet includes committed story changes when the agent committed directly.

---

## Issue 2 — Implement pass-state reconciler before retry/run scheduling

### Summary
Reconcile approved spec `passes` flags against `story_results`, commits, and progress/completion artifacts before scheduling retries or new runs.

### Background
A retry intended for `UCC-008` re-ran earlier stories because copied `story_results` and approved-spec `passes` flags diverged.

### Requirements
- Add a reconciliation routine for spec story state.
- Compare approved spec `passes`, latest `story_results`, story completion packets, commits, and progress files.
- Report mismatches before run/retry.
- Safely update approved spec `passes` flags when evidence is sufficient.
- Refuse or warn when evidence is ambiguous.

### Acceptance criteria
- Retrying one failed story does not re-run prior passed stories due stale spec flags.
- Reconciler emits a clear report of updated, unchanged, and ambiguous stories.
- Changes are auditable through WAL/logs.

---

## Issue 3 — Formalize worktree freshness and safe repair skill

### Summary
Add a deterministic worktree freshness contract and repair workflow for reusable feature worktrees.

### Background
A UCC retry was blocked because the reusable worktree was stale: merge-base no longer matched current workspace `HEAD`.

### Requirements
- Detect stale/invalid reusable worktrees before retry/run start.
- Classify stale base, missing branch, dirty unrelated state, and conflict risk.
- Provide safe repair actions that preserve story commits.
- Write repair evidence to WAL/progress/operator report.
- Refuse destructive resets unless explicitly approved.

### Acceptance criteria
- Stale worktree is detected before spawning the execution engine.
- Safe refresh preserves feature commits and records the resulting merge/rebase commit.
- Ambiguous/conflicting worktrees request operator decision rather than guessing.

---

## Issue 4 — Upgrade retry planner to verify actual execution scope

### Summary
Ensure retries execute exactly the intended smallest safe scope.

### Background
Retry intent and actual execution plan can diverge when spec flags, copied results, or DAG state are inconsistent.

### Requirements
- Compute intended retry scope from failed stories and dependencies.
- Verify actual execution plan after temp retry spec generation.
- Confirm copied passed stories are not scheduled for execution.
- Support sequential enforcement for high-risk specs.
- Emit retry-plan evidence before worker spawn.

### Acceptance criteria
- Retrying `UCC-008` shows an execution plan containing only `UCC-008` plus any explicitly required dependencies.
- The worker refuses to start if actual planned stories differ from requested scope without an override.
- Retry reports include copied, skipped, executed, and remaining stories.

---

## Issue 5 — Add merge-readiness and canary-evidence contracts

### Summary
Make merge readiness and live canary proof explicit, structured gates for high-risk integrations.

### Background
Hermes Modular ChatOps had local validation but required live Slack/Rorca canary evidence and explicit approval before merge-to-main.

### Requirements
- Define merge-readiness result schema: PR-ready, merge-ready, blocked, needs-canary, needs-human-approval.
- Capture repo validation, branch freshness, migration safety, artifact sync, and known baseline classifications.
- Define canary evidence schema with target environment/channel, credentials status, commands/actions, outputs, rollback plan, and result.
- Keep auto-merge disabled unless explicitly permitted by spec policy.

### Acceptance criteria
- High-risk ChatOps/integration specs cannot be marked merge-ready without canary result or explicit canary-blocked classification.
- Merge-readiness reports are attached to run artifacts and visible to operator.
- Human approval is required before final merge/deploy for high-risk integrations.

---

## Issue 6 — Add canonical liveness and heartbeat classification

### Summary
Classify run/story liveness from multiple signals and persist it canonically.

### Background
A run was alive and emitting token WAL events while `pipeline_runs.last_heartbeat` was empty. Operators had to inspect processes, logs, DB rows, and git state manually.

### Requirements
- Aggregate signals from process tree, WAL token events, log file mtime, PTY/terminal events, DB story status, and git diff/commits.
- Classify stories as active, quiet-active, stalled, blocked, completed, or unknown.
- Persist last meaningful activity timestamp.
- Surface liveness in operator reports/API/UI.

### Acceptance criteria
- A long-running story with recent token events is classified as active even if process CPU is low.
- A process with no recent WAL/log/PTY/git activity is classified as stalled after threshold.
- Liveness classification is visible without manual DB/log inspection.

---

## Issue 7 — Productize faithful interactive PTY evidence

### Summary
Complete real interactive PTY runtime visibility for live CLI runs.

### Background
PTY mode is not yet a faithful terminal view, forcing manual log inspection during long-running Pi/Codex/Claude stories.

### Requirements
- Implement the plan in `docs/interactive-pty-cli-runtime-plan.md`.
- Capture real terminal output and completion markers.
- Persist terminal heartbeat/completion metadata.
- Ensure PTY evidence contributes to liveness classification.

### Acceptance criteria
- Run view shows live CLI terminal output faithfully for Pi/OpenCode/Claude/Codex paths.
- PTY heartbeat updates during active execution.
- Terminal completion markers are detected and stored.

---

## Issue 8 — Auto-write run closeout memory, decisions, gotchas, and follow-ups

### Summary
At run closeout, synthesize durable memory/decision/follow-up candidates from story packets, validation evidence, incidents, and fixes.

### Background
Lessons from pass-gate bugs, stale worktrees, retry drift, and validation baselines are currently captured manually or inconsistently.

### Requirements
- Generate memory candidates for architecture decisions, conventions, bug fixes, gotchas, and follow-ups.
- Link candidates to run ID, spec slug, story ID, commits, and files.
- Preserve human review before promotion when appropriate.
- Include discovered baseline failures and SSDLC contract gaps.

### Acceptance criteria
- Run closeout proposes memory candidates for meaningful incidents/fixes.
- Candidates include provenance and related files.
- Operator can approve/reject/defer candidates.

---

## Issue 9 — Add deterministic artifact-sync validation checks

### Summary
Detect drift between source files and checked-in runtime/generated artifacts.

### Background
UCC stories required `.ts` and checked-in `.js` runtime files to remain synchronized.

### Requirements
- Define artifact-sync rules per package/workspace.
- Add validation checks for TS/JS runtime pairs and generated contracts.
- Include artifact-sync results in story completion packets and merge-readiness reports.

### Acceptance criteria
- Story validation fails or warns when checked-in runtime artifacts drift from source changes.
- Artifact-sync failures are classified as story blockers unless explicitly baseline-known.

---

## Issue 10 — Add SSDLC operator report skill

### Summary
Produce a concise, evidence-backed report for humans before wait/retry/cancel/merge decisions.

### Background
Operators currently need to manually inspect WAL, DB, git, logs, progress files, and process state.

### Requirements
- Collect run status, story status, liveness, latest WAL events, latest logs, git diff/commits, completion packets, validation, and blockers.
- Recommend one action: wait, retry smallest scope, preserve/commit, refresh worktree, request approval, merge, or cancel.
- Include confidence and evidence links.

### Acceptance criteria
- Operator can answer “is this stuck?” from one report.
- Report distinguishes active token progress from stalled process state.
- Report shows exact next safe action and why.
