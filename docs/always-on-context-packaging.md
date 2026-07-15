# Always-On Context packaging and platform support

This is the release contract for the `rorca-capture` CLI shipped in the `rorca`
npm tarball. It distinguishes artifact/render validation from live service-host
validation. A green render test is **not** evidence that a service survived
login, logout, reboot, or an OS update.

## Package inventory

`npm pack` must include:

- executable `bin/rorca-capture.js` and the `rorca-capture` npm bin mapping;
- capture bootstrap, shell, service, API, and type JavaScript plus their
  TypeScript sources under `packages/rorca-pi-extension/`;
- canonical runtime safety code at `backend/src/lib/context-safety.js`;
- backend compiled output and all PostgreSQL migrations, including context
  capture controls/event/candidate migrations;
- Pi extension skills/assets, this guide, the universal capture guide, README,
  license, and user-level binary installers;
- the platform contract smoke harness.

Run `npm run test:packaging`. It audits npm's actual file list and modes, creates
an `npm pack` tarball, installs only that tarball into a disposable consumer,
and runs install/reinstall, pause/resume, synthetic prior/current upgrade and
rollback, teardown, and npm uninstall checks. It does not import capture runtime
code from the checkout after packing.

## Safety contract

- `npm install` does not enable Always-On Context.
- `rorca-capture setup` requires both `--always-on` and an explicit `--policy`.
- Setup writes reversible workspace integrations, but does not invoke a provider
  session, install an editor, use `sudo`, register/start an OS service, reboot,
  or change Task Scheduler.
- `service install|start|stop|restart|uninstall` is a separate, explicit operator
  action. Do not run those commands in package tests.
- Provider adapter files contain a token **path** only. Bearer/token values must
  never be embedded. Setup may test whether an executable exists; it must not
  launch that provider or editor.
- Teardown removes only sentinel-managed integration files listed in
  `.rorca/capture/uninstall.json`. Queue, cursor/state, status, logs, unknown
  files, and workspace content are preserved. The legacy `--all` flag does not
  purge operator data.
- The backend's legacy `/uninstall` endpoint drains pending backend queue rows.
  The packaged CLI therefore pauses backend ingestion during uninstall instead
  of calling that endpoint. Any future destructive purge needs a new, separately
  confirmed operation and retention review.

## Support matrix

| Platform | Shipped behavior | Automated release evidence | Required real-host gate before claiming production support |
| --- | --- | --- | --- |
| macOS 13+ (arm64/x64), Node 20+ | LaunchAgent plist rendering; explicit `launchctl` lifecycle | Packed-artifact E2E on `macos-latest`; `plutil -lint`; dry-run command contract; paths with spaces | On a disposable macOS user: explicit install/start/status, login recovery, upgrade with changed Node path, rollback, stop/uninstall, and data-preservation inspection. No release automation may mutate the developer's live LaunchAgents. |
| Linux with systemd user manager, Node 20+ | systemd user unit rendering and explicit lifecycle | Packed-artifact E2E on Ubuntu; `systemd-analyze verify`; dry-run `systemctl --user` contract | On a disposable VM/user with user D-Bus and lingering policy documented: explicit install/start/status, login/reboot recovery, upgrade/rollback, stop/disable/uninstall, queue preservation. Container render checks alone do not satisfy this gate. |
| Windows 11 / Server 2022, x64, Node 20+ | PowerShell daemon fallback plus separately rendered Task Scheduler registration instructions | Packed-artifact E2E on `windows-latest`; PowerShell AST parse of daemon and registration scripts; dry-run lifecycle | On a disposable Windows user: review and explicitly run registration, logon recovery, path-with-spaces/apostrophe test, Node path upgrade, rollback, unregister, and data-preservation inspection. Parser success is not Task Scheduler execution evidence. |
| macOS/Linux without the named service manager; Windows without Task Scheduler permission | Foreground `rorca-capture daemon`/manual startup only | Render and one-shot daemon tests | Document as fallback/degraded. Do not claim managed always-on behavior. |

The CI jobs are non-mutating by design. The final column remains a manual release
blocker until evidence from the target host is attached to a release checklist.

## Install

From npm:

```bash
npm install --global rorca@<exact-version>
rorca-capture --help
# Review first; this still does not register a service.
rorca-capture setup --always-on --policy metadata-only --workspace-id <id>
```

For GitHub release binaries, `scripts/install.sh` defaults to
`$HOME/.local/bin`; `scripts/install.ps1` defaults to
`$env:LOCALAPPDATA\rorca`. Both accept `RORCA_INSTALL_DIR`, stage and verify the
new artifact, retain `rorca.previous`, and never elevate or mutate services.
Neither installer adds PATH automatically.

## Upgrade and Node-path change

1. Pause capture and inspect `.rorca/capture/queue/`.
2. Record `rorca-capture service status` and the current service file.
3. Install an exact new npm version (`npm install --global rorca@x.y.z`) or run
   the user-level binary installer.
4. Re-run setup with the same explicit policy; it is idempotent and updates only
   managed files.
5. If the Node executable or package path changed, explicitly run
   `rorca-capture service install ...` again. Service files intentionally use
   absolute Node and CLI paths because launchd/systemd do not inherit NVM or an
   interactive PATH.
6. Resume and validate queue drain/`lastFlush`. Do not delete the old artifact
   until validation succeeds.

## Rollback

1. Pause capture. Do not remove `.rorca/capture/queue` or `state.json`.
2. Install the prior exact npm version. Binary-installer users may restore
   `rorca.previous`/`rorca.previous.exe` after moving the current binary aside.
3. Explicitly reinstall the service definition so absolute Node/CLI paths match
   the restored runtime.
4. Run status, then resume. Preserve incompatible queue entries for review
   rather than truncating them.

## Uninstall

```bash
# Optional read-only review first
rorca-capture service status --workspace-id <id> --cwd "/path/with spaces"

# Explicit live service mutation (operator only)
rorca-capture service stop --workspace-id <id> --cwd "/path/with spaces"
# Windows only, and only if you explicitly ran the generated registration file:
# Unregister-ScheduledTask -TaskName 'Rorca Capture <id>' -Confirm:$false
rorca-capture service uninstall --workspace-id <id> --cwd "/path/with spaces"

# Non-destructive integration teardown
rorca-capture teardown --cwd "/path/with spaces"

# Remove package code; workspace data remains
npm uninstall --global rorca
```

After teardown, inspect `.rorca/capture/`. Queue, state, status, logs, and unknown
operator files remain intentionally. Archive or remove them manually only under
the workspace owner's retention policy.

## Release commands

```bash
npm run test:packaging
npm run test:capture-platform
npm run test:pi-extension
npm run typecheck
npm run build
node --check bin/rorca-capture.js
node --check scripts/test-packed-capture-lifecycle.mjs
node --check scripts/capture-platform-smoke.mjs
sh -n scripts/install.sh
```

On Windows also parse `scripts/install.ps1` with the PowerShell AST parser. These
checks do not replace the real-host gates in the support matrix.
