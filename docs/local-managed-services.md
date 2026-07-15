# Local managed backend and worker (macOS)

Rorca's capture daemon has its own workspace LaunchAgent. This companion helper
manages the **backend** and standalone **pg-boss worker** from one checkout;
it deliberately does not manage Vite/the frontend or the capture LaunchAgent.

```bash
# Inspect first. No process is changed.
node scripts/rorca-managed-services.mjs status

# Render and plutil-validate files without loading or signaling a job.
node scripts/rorca-managed-services.mjs render

# First migration from `npm run dev:server` / `npm run dev:worker`.
# This verifies /api/health has active_runs: 0, sends SIGTERM only to the
# matching server/worker processes from this checkout, then starts launchd.
node scripts/rorca-managed-services.mjs install --take-over

# Normal lifecycle after installation.
node scripts/rorca-managed-services.mjs status
node scripts/rorca-managed-services.mjs restart --service backend
node scripts/rorca-managed-services.mjs restart --service worker
node scripts/rorca-managed-services.mjs stop --service worker
node scripts/rorca-managed-services.mjs start --service worker
node scripts/rorca-managed-services.mjs uninstall
```

The helper renders and validates these user LaunchAgents. The separate,
read-only five-minute health monitor and bounded log retention schedule are in
[`always-on-context-production-readiness.md`](./always-on-context-production-readiness.md).
The cross-service login gate and operator-approved reboot smoke procedure are in
[`always-on-login-readiness.md`](./always-on-login-readiness.md). **Warning:**
the smoke's `reboot-now` step is destructive and invokes privileged shutdown;
arming is not reboot consent. Use only the generated arm-ID-bound command after
a separate interactive review. Never delegate it to an agent or unattended
shell.

- `~/Library/LaunchAgents/com.rorca.backend.rorca.plist`
- `~/Library/LaunchAgents/com.rorca.worker.rorca.plist`

(The last label component is the checkout directory name.) Both use the exact
Node binary that executed the installer, run `backend/node_modules/.bin/tsx`
with `src/server.ts` or `src/worker.ts`, and set their working directory to
`<checkout>/backend`. They bind the API to `127.0.0.1:3030` by default, set an
explicit `PATH`/`HOME`, start at login, keep running while their checked-in
entrypoint exists, and throttle restarts to one attempt every ten seconds. The
entrypoint `PathState` demand makes crash recovery deterministic; an operator
stop therefore unloads the job rather than merely signaling it. Logs are
appended to:

- `<checkout>/.rorca/services/backend.stdout.log`
- `<checkout>/.rorca/services/backend.stderr.log`
- `<checkout>/.rorca/services/worker.stdout.log`
- `<checkout>/.rorca/services/worker.stderr.log`

`restart` first requires bounded readiness to confirm `db_connected: true` and
an integer `active_runs: 0`. A 503, timeout, `null`, missing, or malformed count
fails closed and forbids the restart. It uses `launchctl bootout` to remove
persistent demand while sending graceful
termination, waits for the checkout process to exit, then bootstraps the
current plist and kickstarts it. This prevents launchd from racing the worker's
deliberate pg-boss/child-process drain. Launchd restarts unexpected exits and
throttles attempts to one every ten seconds.

Launchd does not inherit an interactive shell. The helper renders a bounded,
explicit `PATH` containing the exact Node directory, supported per-user binary
directories, cmux's agent binary directory, and standard Homebrew/system
locations. Rorca's database-mode bootstrap reads the existing per-user
`.rorca` database configuration. Put any additional long-lived backend secrets
or provider configuration in the backend's supported `.env` configuration,
not in a LaunchAgent plist; plists are not a safe secret store.

## Safe handoff behavior

`install` and `start` refuse to replace an existing process by default. A
backend port conflict that is not a Rorca server is never touched. Ownership
requires both the expected command and the kernel-reported
`<checkout>/backend` cwd; a sibling worktree borrowing this checkout's `tsx`
binary is never eligible for takeover. A matching manual Rorca backend/worker
is replaced only with `--take-over`; the helper
requires a responsive local health endpoint with `readiness.confirmed: true`
and integer `active_runs: 0`, sends only `SIGTERM`, waits up to 30 seconds, and
never force-kills a process. If a
shutdown stalls, resolve it manually after reviewing its logs and pipeline
state.

Use `render` to update and `plutil`-validate only the on-disk artifacts without
loading or signaling jobs. Use `--dry-run` to inspect paths and launchctl actions
without making changes. `status` includes the loaded launchd state, matching checkout PIDs,
port listener PIDs, plist location, and log locations. The existing frontend and
`com.rorca.capture.rorca` service remain untouched throughout.

For a non-default API port, use the same value for both services:

```bash
node scripts/rorca-managed-services.mjs install --port 33030 --take-over
```

The worker uses `PORT` for API callbacks, so backend and worker must always use
the same port.
