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

Run from `/Users/dimitriteravanessian/rorca`:

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

`scripts/always-on-reboot-smoke.mjs` closes the session-loss gap without
pretending that a lifecycle restart is a reboot. It provides:

- durable preflight JSON and an exact command ledger under
  `.rorca/services/reboot-smoke/`;
- a reversible snapshot of the dirty working state (recorded HEAD/index,
  current tracked files, deleted-file manifest, and untracked files);
- `com.rorca.login-smoke.rorca`, a marker-gated one-shot LaunchAgent that is
  installed on disk but deliberately **not** bootstrapped in the current login;
- a post-login loop (up to 180 seconds by default) that requires a new kernel
  boot session, the fail-closed readiness verifier, three running launchd PIDs,
  and fresh backend/worker/capture activity logs;
- durable `post-login-latest.json`, per-attempt NDJSON, and launchd stdout/stderr.

The one-shot removes only its own marker and plist after writing a pass/fail
result. It never changes a managed service or deletes a capture queue. The
dirty-state snapshot is an emergency reversible record tied to its recorded Git
HEAD, not permission to reset or overwrite concurrent work.

### A. Preflight and arm

From `/Users/dimitriteravanessian/rorca`:

```bash
node scripts/always-on-reboot-smoke.mjs preflight
node scripts/always-on-reboot-smoke.mjs arm
node scripts/always-on-reboot-smoke.mjs status
```

`arm` fails closed unless the regular verifier passes twice, no
`execution-engine`/`run-loop` process exists, the dirty snapshot is internally
consistent, the one-shot label is not already loaded, and its generated plist
passes `plutil`. It then calls `sync`. Review:

```text
.rorca/services/reboot-smoke/preflight-latest.json
.rorca/services/reboot-smoke/armed.json
.rorca/services/reboot-smoke/REBOOT-COMMAND.txt
.rorca/services/reboot-smoke/backups/<arm-id>/manifest.json
~/Library/LaunchAgents/com.rorca.login-smoke.rorca.plist
```

To cancel without losing evidence:

```bash
node scripts/always-on-reboot-smoke.mjs disarm
```

### B. The only human-gated destructive step

Do not invoke this from tmux, Pi, SSH, CI, or an unattended shell. After
reviewing the armed evidence, open a normal interactive macOS Terminal in this
checkout and run exactly one command:

```bash
node scripts/always-on-reboot-smoke.mjs reboot-now --confirm-reboot
```

The command refuses a non-interactive terminal, requires an armed marker and
plist, repeats the complete readiness/no-engine gate, writes
`immediate-pre-reboot.json`, appends the exact command ledger, and calls `sync`.
Only then does it execute:

```text
/usr/bin/sudo /sbin/shutdown -r now
```

Do not bypass the helper with a direct shutdown command: a run can begin after
an earlier preflight. If the final gate fails or `sudo` fails, no successful
reboot is claimed and the evidence remains armed for review.

### C. Automatic post-login proof

At the next graphical login, launchd runs the one-shot automatically. The smoke
passes only if `kern.boottime` differs from the armed value; logging out and in
without rebooting is recorded as a failure, not mislabeled as reboot proof.
Inspect the result after login:

```bash
cd /Users/dimitriteravanessian/rorca
node scripts/always-on-reboot-smoke.mjs status
jq '{ok,completedAt,attempts,rebootObserved,services,logs,readiness:{ok:.readiness.ok,failureCount:.readiness.failureCount}}' \
  .rorca/services/reboot-smoke/post-login-latest.json
node scripts/verify-always-on-login-readiness.mjs
```

Expected result: `ok:true`, `rebootObserved:true`, all three service jobs have
new running PIDs, the regular verifier has zero failures, and backend stdout,
worker stdout, and capture logs have timestamps after the new boot. The full
artifacts are:

```text
.rorca/services/reboot-smoke/post-login-latest.json
.rorca/services/reboot-smoke/post-login-<arm-id>.json
.rorca/services/reboot-smoke/post-login-attempts.ndjson
.rorca/services/reboot-smoke/post-login.launchd.stdout.log
.rorca/services/reboot-smoke/post-login.launchd.stderr.log
```

If the result is failed, preserve all evidence and use the controlled
backend→worker→capture recovery sequence above. Never fix a failed smoke by
deleting queue/state files, force-killing a run, or starting duplicate services
from another checkout. Record the pre/post evidence paths and final PIDs in
`.always-on-capture-activation-progress.md`; the real reboot test is complete
only when `post-login-latest.json` and the regular verifier are both green.
