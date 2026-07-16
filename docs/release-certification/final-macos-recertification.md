# Final macOS isolated lifecycle recertification

Run this only from the dedicated `final/macos-service-recert` checkout at
`/Users/dimitriteravanessian/rorca-final-macos-recert`:

```bash
node scripts/wave3-macos-recert-lifecycle.mjs
```

The harness is intentionally dependency-free and uses small Node fixtures, not
the Rorca backend, worker, capture runtime, monitor runtime, database, or
installed service definitions. It creates a random `com.rorca.wave3cert.*`
label set, a nonce-bound `/private/tmp/rorca-final-macos-recert-*` runtime
root, and an ephemeral loopback port that is explicitly rejected if it is
`3030`.

Before every test `launchctl` mutation, it verifies the generated label/nonce,
plist program arguments, fixture config, temp-root containment, protected-label
noncollision, and (where present) the exact fixture PID command and cwd. It
snapshots the protected primary checkout's Git state, the protected launchd
labels, and port `3030` before and after. The sole direct signal is `SIGKILL`
to an already verified nonce-bound **test worker** PID, to prove crash recovery.
Ambiguous PIDs are never signalled.

The real-host test verifies bootstrap/kickstart, disposable backend readiness,
process identity, log rotation, worker crash replacement, capture stop/start,
status freshness, queue preservation, stop/uninstall, and removal of all test
labels, port listeners, plists, and the temporary root. It emits only redacted
machine and human evidence in the isolated checkout:

- `.final-macos-recert-evidence.json`
- `.final-macos-recert-evidence.md`
- `.final-macos-recert-progress.md`

It never installs dependencies, writes the primary checkout, touches the live
backend/worker/capture/login-smoke labels, uses port `3030`, connects to a
database, or tests login/reboot persistence. Login and reboot persistence
remain separate manual gates.

## 2026-07-15 recertification evidence

A reviewed run from the dedicated checkout passed using a nonce-bound disposable
fixture root, four `com.rorca.wave3cert.*` labels, a non-3030 loopback port,
and no database. It verified bootstrap/kickstart, readiness, exact fixture
identity, log rotation, worker crash replacement, capture restart, status and
queue preservation, stop/uninstall, and cleanup. Protected checkout Git state,
protected labels, and the port-3030 snapshot were identical before and after.

This is evidence for a **non-reboot, non-login** disposable lifecycle only. It
does not claim production-service, login-persistence, or reboot-persistence
validation.
