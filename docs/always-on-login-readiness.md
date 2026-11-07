# Always-On Context macOS login and reboot readiness

This runbook covers the per-user launchd stack for the `rorca` checkout:

1. `com.rorca.backend.rorca` — local API on `127.0.0.1:3030`
2. `com.rorca.worker.rorca` — migrations, pg-boss queues, and capture ingestion
3. `com.rorca.capture.rorca` — repository capture with a durable offline queue

All three jobs use absolute executables and working directories, explicit
`HOME`/`PATH`, `RunAtLoad`, entrypoint-backed `KeepAlive` demand, ten-second
restart throttling, and repository-local logs. The services can start concurrently at
login. Recovery checks them in dependency order: **backend, worker, capture**.
Capture may start before the API; it keeps redacted events in
the canonical `.rorca-capture-queue.jsonl` and retries after backend recovery.

## Read-only readiness gate

Run from `<repo>`:

```bash
node scripts/verify-always-on-login-readiness.mjs
```

The command is fail-closed and does not signal or load a service. `READY`
requires:

- every installed plist passes `plutil -lint` and its `KeepAlive.PathState`
  entrypoint exists;
- installed and loaded job definitions agree on label, absolute program,
  arguments, cwd, logs, environment, `RunAtLoad`, `KeepAlive`, throttle, and
  process type;
- backend, worker, and capture jobs are loaded and running;
- the backend can reach PostgreSQL and reports zero active runs;
- the worker heartbeat is healthy and no more than 90 seconds old;
- capture is enabled, unpaused, recently seen, queue depth zero, and backoff
  zero.

For structured evidence:

```bash
node scripts/verify-always-on-login-readiness.mjs --json \
  > .rorca/services/login-readiness.json
```

Do not reboot on a failed gate. Do not treat an API `active_runs: 0` result
alone as sufficient if a worker execution-engine child is still present.

## Controlled lifecycle and recovery order

Never restart the worker while a pipeline run is active. First establish:

```bash
curl -fsS http://127.0.0.1:3030/api/health | jq '{active_runs,worker:.components.worker}'
ps -axo pid=,ppid=,command= | grep -E '[e]xecution-engine|[r]un-loop'
rorca-capture service status --workspace-id rorca --repo-path "$PWD"
```

With zero active runs and no engine child, recover one layer at a time:

```bash
# 1. Backend: kickstart the loaded job, or install it if absent.
node scripts/rorca-managed-services.mjs start --service backend
until curl -fsS http://127.0.0.1:3030/api/health >/dev/null; do sleep 2; done

# 2. Worker: start only after backend health is reachable.
node scripts/rorca-managed-services.mjs start --service worker
until curl -fsS http://127.0.0.1:3030/api/health \
  | jq -e '.components.worker.status == "ok" and (.components.worker.activePid | type == "number")' >/dev/null; do sleep 2; done

# 3. Capture: restart through its supported launchctl kickstart path.
rorca-capture service restart --workspace-id rorca --repo-path "$PWD"
node scripts/verify-always-on-login-readiness.mjs
```

If a plist is missing, use its supported installation path:

```bash
node scripts/rorca-managed-services.mjs install --service backend
node scripts/rorca-managed-services.mjs install --service worker
rorca-capture service install --workspace-id rorca --repo-path "$PWD"
```

Managed-service install/start refuses unknown port owners and matching manual
processes unless an explicit `--take-over` passes the zero-active-run gate. It
also verifies the process cwd, so a sibling worktree using this checkout's
`tsx` binary is not eligible for takeover. Capture install atomically replaces
its in-memory launchd definition with the rendered plist and immediately
kickstarts it.

Logs:

```text
.rorca/services/backend.stdout.log
.rorca/services/backend.stderr.log
.rorca/services/worker.stdout.log
.rorca/services/worker.stderr.log
.rorca/capture/service.log
```

Do not delete the capture queue to resolve an outage. Restore backend and
worker, then let the daemon flush it. A nonzero queue with increasing backoff is
expected while the API is unavailable; it must return to zero/backoff zero
before declaring recovery complete.

## Durable human-approved reboot smoke

> **DESTRUCTIVE OPERATION — READ THIS BEFORE ARMING**
>
> `reboot-now` invokes `/usr/bin/sudo /sbin/shutdown -r now`. It terminates the
> current macOS session and can interrupt unrelated work. **Consent to run
> `arm` is not consent to reboot.** Reboot consent is a separate operator act:
> after reviewing the exact arm, the operator must copy its generated command
> into a normal interactive Terminal. Never delegate that command to Pi, tmux,
> SSH, CI, an agent, a scheduler, or an unattended shell.

`scripts/always-on-reboot-smoke.mjs` closes the session-loss gap without
pretending that a lifecycle restart is a reboot. It provides:

- atomic durable state and a transition ledger under
  `.rorca/services/reboot-smoke/`;
- an exclusive cross-process operation lock;
- durable preflight JSON and an exact command ledger;
- a reversible snapshot of the dirty working state (recorded HEAD/index,
  current tracked files, deleted-file manifest, and untracked files);
- `com.rorca.login-smoke.rorca`, an arm-ID-bound one-shot LaunchAgent installed
  on disk but deliberately **not** bootstrapped in the current login;
- a post-login loop (up to 180 seconds by default) that requires a new kernel
  boot session, the fail-closed readiness verifier, three running launchd PIDs,
  and fresh backend/worker/capture activity logs;
- durable `post-login-latest.json`, per-attempt NDJSON, and launchd stdout/stderr.

The immutable arm ID is embedded in `state.json`, `armed.json`, the plist's
`post-login --arm-id` arguments, generated operator commands, result files, and
every compare/delete operation. A stale process cannot delete a newer arm.
The one-shot removes only an exactly matching marker and plist after first
writing a terminal result. It never changes a managed service or deletes a
capture queue. The dirty-state snapshot is an emergency reversible record tied
to its recorded Git HEAD, not permission to reset or overwrite concurrent work.

### Safety state machine and lock

The only normal progression is:

```text
idle -> arming -> armed -> rebooting -> post-login -> completed
                                                   `-> failed
```

Other failures transition the current arm to `failed`. Every transition checks
the expected prior phase and arm ID, increments a revision, writes by atomic
rename, fsyncs the file and directory, and appends
`state-transitions.ndjson`. `reboot-now` enters durable `rebooting` **before**
the shutdown command is invoked.

Mutating actions use an atomically created `operation.lock` directory. Lock
age alone never permits takeover, and an ownerless, invalid, or same-boot lock
fails closed. The sole automatic stale-lock recovery is narrowly scoped:
`post-login` may atomically archive a lock under `stale-locks/` only when all of
the following hold:

1. durable state is `rebooting`;
2. state, lock owner, marker, plist, and `post-login --arm-id` identify the same
   arm; and
3. `kern.boottime` proves the lock came from a prior boot.

This is not a general force mechanism. There is deliberately no `--force` or
ordinary emergency-disarm flag. Preserve an ambiguous lock and investigate it;
do not delete it merely because its timestamp or PID looks old.

### A. Preflight and arm (non-rebooting preparation)

From the intended checkout:

```bash
node scripts/always-on-reboot-smoke.mjs preflight
node scripts/always-on-reboot-smoke.mjs arm
node scripts/always-on-reboot-smoke.mjs status
```

`arm` fails closed unless the regular verifier passes twice, no
`execution-engine`/`run-loop` process exists, the dirty snapshot is internally
consistent, no prior marker/plist or nonterminal state exists, the one-shot
label is not already loaded, and its generated plist passes `plutil`. It then
syncs the bundle and transitions `arming -> armed`. Review all of:

```text
.rorca/services/reboot-smoke/state.json
.rorca/services/reboot-smoke/state-transitions.ndjson
.rorca/services/reboot-smoke/preflight-latest.json
.rorca/services/reboot-smoke/armed.json
.rorca/services/reboot-smoke/REBOOT-COMMAND.txt
.rorca/services/reboot-smoke/backups/<arm-id>/manifest.json
~/Library/LaunchAgents/com.rorca.login-smoke.<checkout-slug>.plist
```

Before shutdown begins, cancellation requires the **exact arm ID**. Prefer the
`humanDisarmCommand` printed by `arm`; for default options it is equivalent to:

```bash
ARM_ID="$(jq -er '.id' .rorca/services/reboot-smoke/armed.json)"
node scripts/always-on-reboot-smoke.mjs disarm --arm-id "$ARM_ID"
```

`disarm` is serialized, compares state/marker/plist to that ID, and refuses an
ID mismatch. It is unconditionally forbidden in `rebooting` and `post-login`.
There is no casual force flag. If `reboot-now` has started, do not start a new
arm and do not remove the marker or plist; they are the pending formal login
evidence.

### B. Separate, explicit consent to the destructive reboot

Stop and reconfirm that unrelated work is safe. Do not infer consent from the
presence of an armed marker. Do not type a hand-reconstructed command.

1. Read `state.json`; require `phase: "armed"` and the expected arm ID.
2. Read `armed.json`, the dirty snapshot manifest, and final preflight.
3. Read `.rorca/services/reboot-smoke/REBOOT-COMMAND.txt`.
4. Open a normal interactive macOS Terminal in the same checkout.
5. Copy the generated command exactly. Its `--arm-id` binds this consent to the
   reviewed arm, and `--confirm-reboot` is the separate destructive consent.

The generated command includes exact root/workspace/port/timeout values and has
this shape:

```text
node scripts/always-on-reboot-smoke.mjs reboot-now ... --arm-id '<arm-id>' --confirm-reboot
```

The helper refuses a noninteractive terminal, missing consent, wrong arm ID,
wrong marker arguments, changed plist bytes, or any state other than `armed`.
While holding the exclusive lock it repeats the complete readiness/no-engine
gate, revalidates the exact bundle after that gate, transitions durably to
`rebooting`, writes arm-specific and latest immediate-pre-reboot evidence,
appends the command ledger, and calls `sync`. Only then can the production
runtime execute:

```text
/usr/bin/sudo /sbin/shutdown -r now
```

Do not bypass the helper with direct shutdown: a run can begin after an earlier
preflight. If the shutdown command reports failure, state becomes `failed` and
the exact marker/plist remain for review and arm-ID-guarded disarm. If shutdown
reports success but the machine has not yet restarted, state intentionally
remains `rebooting`; ordinary disarm and a competing arm remain forbidden.

### C. Automatic post-login proof

At the next graphical login, launchd passes the immutable arm ID to the
one-shot. The smoke accepts only the exact `rebooting` bundle. A lock stranded
by shutdown can be archived only under the prior-boot rules above. State then
moves to `post-login` while the operation lock remains held through evidence
collection and exact-arm cleanup.

The smoke passes only if `kern.boottime` differs from the armed value; logging
out and in without rebooting is recorded as a failure, not mislabeled as reboot
proof. Inspect the result after login:

```bash
node scripts/always-on-reboot-smoke.mjs status
jq '{ok,armId,completedAt,attempts,rebootObserved,services,logs,readiness:{ok:.readiness.ok,failureCount:.readiness.failureCount}}' \
  .rorca/services/reboot-smoke/post-login-latest.json
node scripts/verify-always-on-login-readiness.mjs
```

Expected result: durable phase `completed`, `ok:true`, the reviewed arm ID,
`rebootObserved:true`, all three service jobs with new running PIDs, the regular
verifier with zero failures, and backend stdout, worker stdout, and capture logs
with timestamps after the new boot. The full artifacts include:

```text
.rorca/services/reboot-smoke/state.json
.rorca/services/reboot-smoke/state-transitions.ndjson
.rorca/services/reboot-smoke/completed-<arm-id>.json
.rorca/services/reboot-smoke/post-login-latest.json
.rorca/services/reboot-smoke/post-login-<arm-id>.json
.rorca/services/reboot-smoke/post-login-attempts.ndjson
.rorca/services/reboot-smoke/post-login.launchd.stdout.log
.rorca/services/reboot-smoke/post-login.launchd.stderr.log
.rorca/services/reboot-smoke/stale-locks/   # only when a prior-boot lock was archived
```

If state is `failed`, preserve all evidence and use the controlled
backend→worker→capture recovery sequence above. Never fix a failed smoke by
deleting lock/marker/plist/queue/state files, force-killing a run, or starting
duplicate services from another checkout. A same-boot or ambiguous lock is a
forensic stop condition, not permission to improvise recovery. Record the
pre/post evidence paths and final PIDs in the activation log; the real reboot
test is complete only when `post-login-latest.json`, durable `completed` state,
and the regular verifier are all green.
