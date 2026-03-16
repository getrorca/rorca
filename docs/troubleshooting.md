# Rorca Installation Troubleshooting Guide

If everything is working, you can skip this page. This guide covers common installation issues and their solutions.

**Quick links:**
- [Permission denied on install script](#permission-denied-on-install-script)
- [Port 3030 already in use](#port-3030-already-in-use)
- [Port 5433 already in use](#port-5433-already-in-use)
- [Node.js version too old](#nodejs-version-too-old)
- [Bun not found](#bun-not-found)
- [macOS Gatekeeper blocks binary](#macos-gatekeeper-blocks-binary)
- [Windows SmartScreen warning](#windows-smartscreen-warning)
- [Postgres fails to start](#postgres-fails-to-start)
- [ECONNREFUSED localhost:3030](#econnrefused-localhost3030)
- [Migration errors](#migration-errors)

---

## Permission denied on install script

### Symptom
When running the install command, you see:
```
bash: ./rorca-macos-arm64: Permission denied
```

### Cause
The downloaded binary doesn't have execute permissions. This happens because the shell script or download didn't preserve executable flags.

### Fix
Add execute permission to the binary:
```bash
chmod +x ./rorca-macos-arm64
./rorca-macos-arm64
```

Or with the curl|sh one-liner:
```bash
curl -fsSL https://get.rorca.app | sh
```

This automatically handles permissions.

### Still not working?
If `chmod +x` doesn't help, the binary may be corrupted. Download again from [https://github.com/getrorca/rorca/releases](https://github.com/getrorca/rorca/releases) or [rorca.app/download](#).

---

## Port 3030 already in use

### Symptom
Rorca starts but the dashboard fails to load. The terminal shows:
```
Error: listen EADDRINUSE :::3030
```

Or in the logs:
```
Address already in use: Port 3030
```

### Cause
Another process is already using port 3030. This might be:
- A previous Rorca instance still running
- Another development server (Node.js, Python Flask, etc.)
- System service on that port

### Fix
**Find and kill the process using port 3030:**
```bash
# macOS / Linux
lsof -ti:3030 | xargs kill -9

# Windows (PowerShell)
Get-Process -Id (Get-NetTCPConnection -LocalPort 3030).OwningProcess | Stop-Process -Force
```

Then restart Rorca:
```bash
rorca start
```

**Alternative: Use a different port**

If you don't want to kill the other process, you can change Rorca's port:
```bash
PORT=3031 rorca start
```

Then access the dashboard at `http://localhost:3031` instead of `:3030`.

### Still not working?
Run `lsof -ti:3030` without the `xargs` to see which process owns the port. You can then kill it explicitly by name if it's not your Rorca instance.

---

## Port 5433 already in use

### Symptom
Rorca fails to start Postgres. The logs show:
```
Error: listen EADDRINUSE :::5433
Could not start embedded Postgres on port 5433
```

Or:
```
initdb failed: address already in use
```

### Cause
Port 5433 (where Rorca provisions its embedded Postgres) is in use by another Postgres instance or service.

### Fix

**Option A: Kill the existing Postgres on 5433**
```bash
# macOS / Linux
lsof -ti:5433 | xargs kill -9

# Windows (PowerShell)
Get-Process -Id (Get-NetTCPConnection -LocalPort 5433).OwningProcess | Stop-Process -Force
```

**Option B: Use an existing Postgres instance**

If you have Postgres 16 running elsewhere (e.g., Docker, local install on :5432), point Rorca to it:
```bash
DATABASE_URL="postgres://rorca:rorca@localhost:5432/rorca" rorca start
```

Replace the credentials and host with your actual Postgres connection details. The database and user must already exist.

### Still not working?
Check if you have multiple Postgres instances:
```bash
ps aux | grep postgres
```

If you see multiple `postgres` processes from different installations, identify which one is on 5433 and stop the appropriate one.

---

## Node.js version too old

### Symptom
When running `rorca start`, you see:
```
node: error while loading shared libraries: ... (error locating initializers)
```

Or:
```
Rorca requires Node.js 18.0.0 or higher. You have x.y.z
```

### Cause
The Node.js version bundled in the Rorca binary or your system Node.js is below version 18.

### Fix

**If using the Rorca binary** (Node.js is bundled):
Re-download the latest Rorca binary from [rorca.app/download](#). It includes an up-to-date Node.js runtime.

**If you have your own Node.js installation** (using `rorca start` without a binary):

Upgrade Node.js using `nvm` (Node Version Manager):
```bash
# Install nvm (if not installed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Reload shell
source ~/.bashrc  # or ~/.zshrc on macOS

# Install Node.js 18 or higher
nvm install 18
nvm use 18

# Verify
node --version  # Should be v18.0.0 or higher
```

Or use `volta` (simpler):
```bash
# Install volta
curl https://get.volta.sh | bash

# Use Node.js 18
volta install node@18

# Verify
node --version
```

### Still not working?
Check your Node.js version:
```bash
node --version
```

If it's still below 18 after upgrading, make sure your shell session loaded the new version:
```bash
# macOS / Linux
which node
```

This should point to the newly installed version, not an old system Node.js.

---

## Bun not found

### Symptom
Rorca fails with:
```
Error: bun not found in PATH
Rorca requires Bun to be installed.
```

Or the binary can't execute bundled code:
```
spawn ENOENT
```

### Cause
The Rorca binary was built with Bun, but Bun is not installed or not in your system PATH.

### Fix

**Install Bun:**
```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1|iex"
```

**Verify installation:**
```bash
bun --version  # Should output a version number like 1.x.x
```

**If Bun is installed but not in PATH:**

Add Bun to your shell profile:
```bash
# For bash (~/.bashrc)
export PATH="$HOME/.bun/bin:$PATH"

# For zsh (~/.zshrc)
export PATH="$HOME/.bun/bin:$PATH"

# For fish (~/.config/fish/config.fish)
set -gx PATH $HOME/.bun/bin $PATH
```

Then reload your shell:
```bash
source ~/.bashrc  # or your shell's config file
```

### Still not working?
If Bun is installed but still shows as "not found", try running Rorca with the full path:
```bash
~/.bun/bin/bun rorca start
```

If this works, your PATH isn't set correctly. Follow the "Add Bun to PATH" step above.

---

## macOS Gatekeeper blocks binary

### Symptom
When trying to run the Rorca binary, you see:
```
"rorca-macos-arm64" cannot be opened because the developer cannot be verified
```

Or macOS shows a security warning and prevents execution.

### Cause
macOS Gatekeeper blocks unsigned binaries by default. Rorca's standalone binary is not code-signed (code signing requires paid Apple developer certificates). This is a security feature, not a malfunction.

### Fix

**Option 1: Remove the quarantine attribute (Recommended)**

When you download Rorca directly from a browser, macOS applies a quarantine flag to the binary. Remove it using `xattr`:

```bash
# For ARM64 (Apple Silicon)
xattr -d com.apple.quarantine ./rorca-macos-arm64

# For Intel x64
xattr -d com.apple.quarantine ./rorca-macos-x64
```

Then run normally:
```bash
./rorca-macos-arm64
```

**Note on curl|sh installs:** If you used the `curl -fsSL https://get.rorca.app | sh` one-liner, the quarantine flag is not set. The `xattr` command will show an error like:
```
xattr: [Errno 93] No such xattr: com.apple.quarantine
```

This is **not an error** — it means the quarantine flag was never applied and no action is needed. You can run Rorca directly.

**Option 2: Right-click in Finder**

1. Open **Finder** and navigate to the Rorca binary
2. Right-click on it and select **"Open"** (NOT "Open with...")
3. When the Gatekeeper dialog appears, click **"Open"** to allow it
4. Rorca will run and be allowed to execute in the future without warnings

**Option 3: Allow in System Settings**

If the above don't work:
1. Open **System Settings** → **Privacy & Security**
2. Scroll down to the "Security" section
3. Look for the message "rorca-macos-arm64 was blocked from use..."
4. Click the **"Allow"** button next to it
5. Try running Rorca again

### Still not working?
If you see the "cannot be opened" dialog again:
1. Click **"Cancel"** in the dialog
2. Open System Settings → Privacy & Security
3. Click the **"Open Anyway"** button for Rorca
4. When the dialog re-appears, click **"Open"**

This one-time override allows Rorca to run permanently.

---

## Windows SmartScreen warning

### Symptom
When downloading or running `rorca-windows-x64.exe`, Windows shows:
```
Windows Defender SmartScreen
Windows protected your PC
Unrecognized app blocked to protect your PC.
```

### Cause
Windows SmartScreen blocks unsigned executables it doesn't recognize. Rorca's Windows binary is not signed (requires paid code signing certificates).

### Fix

**Click "More info" and allow execution:**
1. The SmartScreen warning appears
2. Click **"More info"**
3. Click **"Run anyway"**
4. Windows allows the app to execute

**For future runs**, Windows will recognize and allow Rorca without prompting.

**Alternative: Disable SmartScreen for this file (advanced)**
```powershell
# In PowerShell as Administrator
Unblock-File -Path "C:\Path\To\rorca-windows-x64.exe"
```

Replace the path with your actual Rorca location.

### Still not working?
If SmartScreen blocks again, you may have an older Windows 10/11 build. Update Windows:
1. Open Settings → Update & Security
2. Click **"Check for updates"**
3. Install any pending updates and restart
4. Try running Rorca again

---

## Postgres fails to start

### Symptom
Rorca starts but Postgres doesn't initialize. The logs show:
```
initdb failed
Could not initialize Postgres cluster
```

Or:
```
pg_ctl: could not start server
```

### Cause
Postgres initialization failed due to:
- Insufficient disk space
- Permission errors in the Postgres data directory
- Corrupted Postgres binaries
- Previous failed initialization left incomplete files

### Fix

**Check disk space:**
```bash
# macOS / Linux
df -h

# Windows (PowerShell)
Get-Volume
```

Rorca needs at least 500 MB free space. If disk is full, free up space and try again.

**Check Postgres data directory permissions:**
```bash
# macOS / Linux (Postgres data is stored in ~/.rorca/postgres)
ls -la ~/.rorca/postgres/

# Should show rwx permissions for your user
chmod 700 ~/.rorca/postgres
```

**Clear and reinitialize:**
```bash
# macOS / Linux
rm -rf ~/.rorca/postgres
rorca start

# Windows (PowerShell)
Remove-Item -Recurse -Force $env:USERPROFILE\.rorca\postgres
rorca start
```

This deletes any previous partial initialization and starts fresh.

### Still not working?
If `rm -rf ~/.rorca/postgres` followed by `rorca start` still fails:

1. Check if Postgres 16 binaries are intact:
   ```bash
   # macOS / Linux
   ls -la ~/.rorca/postgres/bin/
   ```
   All executable files should be present: `initdb`, `postgres`, `pg_ctl`, etc.

2. If binaries are missing or corrupted, redownload Rorca:
   ```bash
   # Delete everything and start over
   rm -rf ~/.rorca
   rorca start
   ```

3. If it still fails, check system logs:
   ```bash
   # macOS
   log show --predicate 'eventMessage contains[cd] "postgres"' --last 1h
   ```

---

## ECONNREFUSED localhost:3030

### Symptom
You see the error:
```
Error: ECONNREFUSED — Connection refused 127.0.0.1:3030
```

Or the browser shows:
```
Unable to reach localhost:3030
localhost:3030 refused to connect
```

### Cause
The Rorca backend is not running. This happens when:
- `rorca start` was not executed
- The backend crashed or exited unexpectedly
- The backend is running on a different port
- Network/firewall issues block localhost connections

### Fix

**Start Rorca if not running:**
```bash
rorca start
```

Wait 10–15 seconds for the backend and Postgres to initialize. You should see:
```
✓ Postgres running on :5433
✓ Migrations applied
✓ Backend started on :3030
✓ Dashboard: http://localhost:3030
```

**If it says "started" but still shows connection refused:**

Check the backend logs for errors. Restart the backend manually:
```bash
# Kill any running Rorca process
lsof -ti:3030 | xargs kill -9

# Try starting again
rorca start
```

**Check if backend is actually running:**
```bash
# macOS / Linux
lsof -ti:3030

# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 3030
```

If no process is listening on 3030, the backend failed to start. Check the full output of `rorca start` for error messages.

### Still not working?
If the backend starts but refuses connections:

1. Try accessing via IP instead of localhost:
   ```
   http://127.0.0.1:3030
   ```

2. Check firewall rules. Some systems block localhost by default:
   ```bash
   # macOS
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

   # Windows Firewall (PowerShell, Admin)
   Get-NetFirewallProfile
   ```

3. If Windows Firewall is blocking: Allow Node.js through Firewall
   - Settings → Privacy & Security → Firewall & network protection
   - Advanced settings → Inbound Rules
   - Look for Node.js and allow it

---

## Migration errors

### Symptom
Rorca fails to start with:
```
Error: Migration 069 already applied
```

Or:
```
Error: No migration found with version X
```

Or:
```
Error: Migration failed: column "field_name" already exists
```

### Cause
Database migrations track applied schema changes. Errors indicate:
- A migration was applied twice (version mismatch)
- Migration files were manually edited or deleted
- A duplicate migration number exists (two branches created the same migration independently)
- The database was not cleanly initialized

### Fix

**Check applied migrations:**
```bash
# Connect to Postgres and check schema_migrations table
psql postgres://rorca:rorca@localhost:5433/rorca -c "SELECT version, redo_statement FROM schema_migrations ORDER BY version;"
```

**For duplicate migration numbers (if two branches created same migration):**

Identify which migration was incorrectly applied. One solution:

1. Find the conflicting version in `backend/src/db/pg-migrations/`:
   ```bash
   ls backend/src/db/pg-migrations/ | grep "^069_"
   ```

2. Rename the second one to the next available number:
   ```bash
   # If 069 and 070 exist, find the next free number (e.g., 081)
   mv backend/src/db/pg-migrations/069_second_migration.sql backend/src/db/pg-migrations/081_second_migration.sql
   ```

3. Update schema_migrations for the renamed migration:
   ```bash
   psql postgres://rorca:rorca@localhost:5433/rorca -c "UPDATE schema_migrations SET version = 81 WHERE version = 69 AND (SELECT COUNT(*) FROM schema_migrations WHERE version = 69) > 1;"
   ```

4. Restart Rorca:
   ```bash
   rorca start
   ```

**For "column already exists" errors:**

The migration was partially applied. Clean approach:

1. Backup your data (if any)
2. Drop and reinitialize the database:
   ```bash
   # macOS / Linux
   psql postgres://rorca:rorca@localhost:5433/postgres -c "DROP DATABASE rorca;"

   # Windows (cmd)
   psql -U rorca -c "DROP DATABASE rorca;"
   ```

3. Restart Rorca to re-run all migrations:
   ```bash
   rorca start
   ```

**For manual fixes (advanced):**

If you need to manually fix the database:

```bash
# Connect to Rorca database
psql postgres://rorca:rorca@localhost:5433/rorca

# Check all applied migrations
SELECT version, redo_statement FROM schema_migrations ORDER BY version DESC;

# Remove an incorrectly applied migration (careful!)
DELETE FROM schema_migrations WHERE version = 69;

# Exit psql
\q
```

### Still not working?
If migrations continue to fail after a clean reinit:

1. Check for syntax errors in migration files:
   ```bash
   # Look at the failing migration
   cat backend/src/db/pg-migrations/069_*.sql
   ```

2. Try applying migrations manually:
   ```bash
   # Connect to the database
   psql postgres://rorca:rorca@localhost:5433/rorca < backend/src/db/pg-migrations/069_*.sql
   ```

3. If you see SQL errors, the migration file may need fixes. Report the error at [https://github.com/getrorca/rorca/issues](https://github.com/getrorca/rorca/issues).

---

## Need more help?

If your issue isn't listed above or the fix didn't work:

1. **Gather diagnostics:**
   ```bash
   # Show system info
   uname -a                                    # macOS / Linux
   winver                                      # Windows

   # Show Rorca logs
   rorca start 2>&1 | tee rorca.log
   ```

2. **Check Postgres health:**
   ```bash
   psql postgres://rorca:rorca@localhost:5433/rorca -c "SELECT version();"
   ```

3. **Open an issue** on [GitHub](https://github.com/getrorca/rorca/issues) with:
   - Your OS and version
   - Node.js version (`node --version`)
   - The full error message and logs from `rorca start`
   - Steps to reproduce

We're here to help!
