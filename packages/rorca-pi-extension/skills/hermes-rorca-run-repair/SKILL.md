---
name: hermes-rorca-run-repair
description: Watch Rorca pipeline runs and never leave a failed run failed. Diagnose every failure to root cause, apply the smallest safe fix, re-drive the run, and verify completion. Use whenever a Rorca run fails, a run stays running with a stale heartbeat, a spec is stuck pending, the worker singleton is lost, or the run queue misbehaves.
compatibility: Requires Rorca backend API (localhost:3030/3031), PostgreSQL access via psql, and the Rorca worktree checked out.
---

## Automatic layer (the failure warden)

The worker runs a failure warden (`backend/src/lib/failure-warden.ts`) that
enforces the same invariant with no Pi/UI session attached: every 60s it sweeps
recently-failed runs, classifies the root cause, writes the repair ledger
(`~/.rorca/hermes-repair/run-<id>.jsonl`), re-drives bounded (max
`RORCA_FAILURE_WARDEN_MAX_AUTO_REDRIVES`, default 2) through the governed retry
or corrected trigger API, and escalates everything else with an exact operator
action via `run_repair_escalated` WAL events. Runs stuck `running` past
`RORCA_FAILURE_WARDEN_STALL_HOURS` (default 4h) are escalated as zombie loops —
the orphan sweep cannot catch a live worker heartbeat.

This skill is the human/Pi-side companion: use it when the warden escalated,
when a run needs a deeper diagnosis than signature matching, or when the fix
requires judgment (quota decisions, worker restarts, taxonomy extensions).

# Hermes Rorca Run Repair

**The invariant: a failed run is a ticket, never a tombstone.** Hermes observes Rorca runs; when one fails or stalls, Hermes diagnoses the root cause, applies the smallest safe fix, re-drives the run, and verifies it concludes. A run may be left `failed` only with a written diagnosis and an exact operator action. Silence is failure of Hermes.

## Watch triggers (poll every 60s, or on WAL/SSE events)

| Signal | Where |
|---|---|
| Run transitions to `failed` | `GET /api/pipeline/runs?workspaceId=…` |
| Run stays `running` with no heartbeat > 5 min | `pipeline_runs.last_heartbeat_at` (psql) |
| Spec stuck `pending_enrichment` / `queued` post-save | `GET /api/specs/{id}/workflow` |
| Worker singleton lost or two workers alive | `worker_heartbeat` table |
| Run queue grows with `queued` runs and no pickup | `pgboss.job` |
| Duplicate spec files (same slug in pending/ + approved/) | `forge/specs/{pending,approved}/` |
| Recurring rate-limit / quota errors | run `summary` field |

## Diagnosis protocol (always, in order)

1. **Read the run**: `GET /api/pipeline/runs/{id}?workspaceId=…` — status, summary, pid, branch, started_at, heartbeat.
2. **Read the engine output**: decode `run_output_chunks` for the run (hex → JSONL) and the story log under `.rorca/logs/`. The exact error is almost always in the last 20 lines.
3. **Read the worker log**: the worker that owns the run logs the pre-spawn refusal and closeout error verbatim.
4. **Classify from the taxonomy below.** Never guess; the error text must match.
5. **Write the diagnosis to the repair ledger** before touching anything: `.rorca/hermes-repair/run-{id}.md` with runId, specId, observed error, root cause, fix chosen, verification. Append-only.
6. **Fix, re-drive, verify.** Record the outcome. Leave the ledger row even on success.

## Failure taxonomy (encode these exact mappings)

| Symptom | Root cause | Fix |
|---|---|---|
| `linux_bwrap_required_for_requested_mode` on macOS | Run used a non-Pi agent (e.g. `codex`) — Darwin only sanctions the ordinary-local-Pi profile | Re-dispatch with `agentOverride: pi` + `executionEnvironment: remote-rorca` + branch-only + sequential. This is a dispatch-shape error, not a Linux need. |
| `text = uuid` / SQLSTATE 42883 in spec post-save | TEXT `boss_job_id` compared to uuid cast | Apply the `::text` cast fix in `spec-post-save-workflow.ts` (2 sites) and `spec-jobs.ts` recovery CAS. |
| `expireIn cannot exceed 24 hours` on trigger | pg-boss attorney rejects >24h expiration | Clamp `expireInSeconds` to `PGBOSS_EXPIRE_IN_CEILING_SECONDS` (23h) in `pipeline-job-lifecycle.ts`. |
| `fetch failed` / `Connection error.` in pi session | Egress broker allowlist missing the model host | Add the host to `RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS`: `api.openai.com,chatgpt.com,api.deepseek.com` (codex uses chatgpt.com; deepseek uses api.deepseek.com). Restart worker. |
| `pi_progress_log_outside_workspace` | Progress log built under workspace, pi session cwd is worktree | Pass `effectiveCwd` (worktree) as progressCwd in `buildPiSessionOptions`. |
| `pi_progress_log_unverified` | Model responded but never read the progress log | Check egress host first (model may be failing); then confirm the prompt instructs the read. |
| `stale_generation` / `payload_changed` / `cancellation_fence_mismatch` at closeout | Host-attempt envelope conflicts: per-launch PID/generation drift or run cancelled mid-flight | Ensure launch_generation is deterministic per (run, story, attempt) and envelopes replay same-generation; use `rerunFromScratch: true` on re-drive; for cancelled runs, reconcile the run as terminal, don't re-drive. |
| `rate_limit_exhausted` / `usage limit has been reached` | Provider account quota | Verify with a direct probe (`pi --provider … --model … -p OK`). If quota is real: switch model/provider or wait for the window; do NOT keep re-driving the same shape. |
| Run `running` forever, no heartbeat, engine PID dead | Orphan/zombie run | Kill the engine tree, `UPDATE pipeline_runs SET status='failed' WHERE id=… AND status='running'`, then re-drive. Never leave it `running`. |
| Run `running` forever, no heartbeat, engine PID alive | Runaway loop re-spawning | Kill the supervising worker/broker tree (watch for `omp __omp_worker_daemon_broker` parents), then mark the run failed and re-drive. |
| Same spec slug in `pending/` AND `approved/` | Duplicate spec collision | Reconcile to a single canonical copy (keep the approved one; remove the stale pending copy after confirming content). |
| Post-save workflow `queued` forever, job `failed` in pgboss | Old worker ran buggy code; stage/run stuck | Use the admin reconcile endpoint (`/api/admin/recovery/spec-workflows/v1/{run}/stages/{stage}/reconcile`) after making the app job terminal, then stage retry. |

## Fix authority

- **Read-only diagnosis** is always allowed.
- **Code fixes** in the checked-out worktree are allowed when: the fix is the smallest root-cause change, it passes `npx tsc --noEmit` and the focused test, and it matches an existing pattern in the file. No rewrites of whole subsystems.
- **Config/process fixes** (env vars, restarting workers, killing verified zombie trees) are allowed when the process tree is proven (PID + parent chain inspected) and the action is reversible.
- **Never**: destroy user data, fabricate evidence, bypass approval/readiness/authority, mutate credentials, or delete lock files by hand.
- **Credentials/authority failures**: diagnose and report the exact smallest operator action. Never retry those in a loop.

## Re-drive protocol

1. Confirm the fix is live (worker restarted with the new code/env where applicable).
2. Clean stale branch/worktree state for the spec: remove the old worktree, delete the stale branch if the run never completed.
3. Fresh preflight → capture previewHash + expiresAt → trigger with a **new idempotency key** and `rerunFromScratch: true` if prior attempts left pass evidence.
4. Poll to a terminal state. On failure, go back to Diagnosis protocol — the taxonomy grows; never assume.

## Bounded termination

A run may be left `failed` only when:
- A written diagnosis exists in the ledger, AND
- The fix was applied or is impossible without operator action, AND
- The exact operator action is stated (e.g. "raise the codex quota", "approve the credential", "pause the competing dispatcher").

**A run is never left `failed` silently. Ever.**

## Verification

After any repair, prove it: the focused test passes, the run reaches `completed` or a documented blocked state, and the ledger row records the outcome. If the same failure recurs after a fix, escalate the taxonomy entry — do not paper over it.
