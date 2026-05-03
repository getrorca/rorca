#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync, createWriteStream, unlinkSync, rmSync, readdirSync, renameSync, statSync, statfsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync, spawnSync, fork, spawn } from 'child_process';
import { homedir, platform, arch } from 'os';
import { get as httpsGet } from 'https';
import { get as httpGet } from 'http';
import { createConnection } from 'net';
import { createRequire } from 'module';
import * as readline from 'readline/promises';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
// ─── --version / --help ───
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
    console.log(pkg.version);
    process.exit(0);
}
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
rorca v${pkg.version} — AI spec orchestration pipeline

Usage:
  rorca start [options]    Start the Rorca server
  rorca db start           Start Docker Postgres, or upgrade Lite Mode to Docker + AGE
  rorca init               Register Rorca as an MCP server with claude CLI
  rorca --version          Print version
  rorca --help             Show this help message

Options for start:
  --port <port>            Server port (default: 3030)
  --no-open                Don't open browser on start
  --no-postgres            Skip managed Postgres; requires DATABASE_URL to be set
  --dry-run                Validate config and exit without starting servers

Examples:
  rorca start
  rorca start --port 4040
  rorca start --no-open
  rorca start --no-postgres
  rorca start --dry-run
  rorca db start
  rorca init
`);
    process.exit(0);
}
const command = args[0];
// ─── Command: init ───
if (command === 'init') {
    runInit();
    process.exit(0);
}
// ─── Command: db ───
if (command === 'db') {
    void runDb(args.slice(1)).catch(handleFatalCliError);
}
// ─── Command: start ───
if (command === 'start') {
    void runStart(args.slice(1)).catch(handleFatalCliError);
    // runStart sets up async process management — don't exit here
}
else if (command !== 'db') {
    console.error(`Unknown command: ${command}\nRun "rorca --help" for usage.`);
    process.exit(1);
}
// ────────────────────────────────────────────────────────────────
// init: register MCP server with claude CLI
// ────────────────────────────────────────────────────────────────
function runInit() {
    console.log('Initializing Rorca MCP integration...\n');
    const claudeBin = findBinary('claude');
    if (!claudeBin) {
        console.log('Claude CLI not found in PATH.\n');
        console.log('To register Rorca as an MCP server manually, run:');
        console.log('  claude mcp add --global rorca --transport http http://localhost:3030/mcp\n');
        console.log('Install Claude CLI: https://claude.ai/download');
        return;
    }
    console.log(`Found claude at: ${claudeBin}`);
    // Check if already registered
    try {
        const listOutput = execSync(`${claudeBin} mcp list 2>&1`, { encoding: 'utf8' });
        if (listOutput.includes('rorca')) {
            console.log('Rorca is already registered as an MCP server.');
            console.log('To update the registration, remove it first: claude mcp remove rorca');
            return;
        }
    }
    catch {
        // mcp list may not exist in older versions — proceed anyway
    }
    try {
        execSync(`${claudeBin} mcp add --global rorca --transport http http://localhost:3030/mcp`, { stdio: 'inherit' });
        console.log('\nRorca MCP server registered successfully.');
        console.log('Start Rorca with "rorca start", then use Claude with full Rorca access.');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Already registered — not an error
        if (msg.includes('already') || msg.includes('exists')) {
            console.log('Rorca MCP server is already registered.');
        }
        else {
            console.error('Failed to register MCP server:', msg);
            console.log('\nTo register manually, run:');
            console.log('  claude mcp add --global rorca --transport http http://localhost:3030/mcp');
        }
    }
}
// ────────────────────────────────────────────────────────────────
// start: launch Express backend + open browser
// ────────────────────────────────────────────────────────────────
async function runStart(startArgs) {
    // Parse options
    const portIdx = startArgs.indexOf('--port');
    const port = portIdx !== -1 && startArgs[portIdx + 1] ? startArgs[portIdx + 1] : '3030';
    const noOpen = startArgs.includes('--no-open');
    const noPostgres = startArgs.includes('--no-postgres');
    const dryRun = startArgs.includes('--dry-run');
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        console.error(`Invalid port: ${port}`);
        process.exit(1);
    }
    // --no-postgres: skip managed Postgres, require DATABASE_URL
    if (noPostgres && !process.env.DATABASE_URL) {
        console.error('DATABASE_URL required when --no-postgres is set');
        process.exit(1);
    }
    // --dry-run: validate config and exit without starting servers
    if (dryRun) {
        console.log(`rorca v${pkg.version} — dry-run mode`);
        console.log(`  Port: ${portNum}`);
        const dbUrl = process.env.DATABASE_URL || '(managed Postgres will be provisioned)';
        console.log(`  DATABASE_URL: ${dbUrl.replace(/\/\/[^@]*@/, '//***@')}`);
        const rorcaHome = join(homedir(), '.rorca');
        console.log(`  Config dir: ${rorcaHome}`);
        console.log('Config OK — dry-run complete.');
        process.exit(0);
        return;
    }
    // Ensure ~/.rorca/ config directory exists
    const rorcaHome = join(homedir(), '.rorca');
    if (!existsSync(rorcaHome)) {
        mkdirSync(rorcaHome, { recursive: true });
        console.log(`Created config directory: ${rorcaHome}`);
    }
    let managedPostgresStarted = false;
    let databaseUrl = process.env.DATABASE_URL || '';
    if (noPostgres || databaseUrl) {
        await probeDatabaseConnection(databaseUrl);
        const urlObj = parsePostgresUrl(databaseUrl);
        console.log(`Using user-provided DATABASE_URL (${urlObj?.host ?? 'unknown'}:${urlObj?.port ?? 'unknown'})`);
    }
    else {
        const { detectDbMode, getDbConnectionString } = await loadDbStrategy();
        const mode = detectDbMode();
        if (mode === 'docker') {
            const { dbStart } = await loadDbSidecar();
            await dbStart();
            databaseUrl = getDbConnectionString('docker');
            process.env.DATABASE_URL = databaseUrl;
            console.log('Docker Postgres sidecar ready at localhost:5432');
        }
        else if (mode === 'native') {
            const pgDir = await ensurePostgres();
            await startPostgres(pgDir);
            managedPostgresStarted = true;
            databaseUrl = `postgres://rorca:rorca@127.0.0.1:${MANAGED_PG_PORT}/rorca`;
            process.env.DATABASE_URL = databaseUrl;
            console.log(`Managed Postgres ready at 127.0.0.1:${MANAGED_PG_PORT}`);
        }
        else {
            databaseUrl = getDbConnectionString('byop');
            await probeDatabaseConnection(databaseUrl);
            process.env.DATABASE_URL = databaseUrl;
            const urlObj = parsePostgresUrl(databaseUrl);
            console.log(`Using external Postgres (${urlObj?.host ?? 'unknown'}:${urlObj?.port ?? 'unknown'})`);
        }
    }
    // Auto-build frontend if dist/ is missing
    const rootDir = join(__dirname, '..');
    const distDir = join(rootDir, 'dist');
    if (!existsSync(join(distDir, 'index.html'))) {
        console.log('Frontend not built yet — building...');
        try {
            execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
        }
        catch {
            console.error('Build failed. Please run "npm run build" manually and try again.');
            process.exit(1);
        }
    }
    const env = {
        ...process.env,
        PORT: String(portNum),
        DATABASE_URL: databaseUrl,
        RORCA_SERVE_STATIC: '1',
        RORCA_STATIC_DIR: distDir,
        RORCA_HOME: rorcaHome,
        NODE_ENV: process.env.NODE_ENV || 'production',
    };
    const backendDir = join(rootDir, 'backend');
    const backendEntry = join(backendDir, 'dist', 'server.js');
    const workerEntry = join(backendDir, 'dist', 'worker.js');
    const backendTsEntry = join(backendDir, 'src', 'server.ts');
    const workerTsEntry = join(backendDir, 'src', 'worker.ts');
    /** Spawn a process and prefix each line of its stdout/stderr with a label. */
    function spawnLabeled(label, cmd, args, opts) {
        const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        const prefix = `[${label}] `;
        const printLine = (stream, line) => stream.write(prefix + line + '\n');
        let buf = '';
        const onData = (stream) => (chunk) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines)
                printLine(stream, line);
        };
        child.stdout?.on('data', onData(process.stdout));
        child.stderr?.on('data', onData(process.stderr));
        child.on('close', () => {
            if (buf.length > 0) {
                process.stdout.write(prefix + buf + '\n');
                buf = '';
            }
        });
        return child;
    }
    let serverChild;
    let workerChild = null;
    if (existsSync(backendEntry)) {
        // Production: compiled JS — server
        serverChild = fork(backendEntry, [], { env, cwd: backendDir, stdio: 'inherit' });
    }
    else if (existsSync(backendTsEntry)) {
        // Development: run TypeScript source via tsx — server
        serverChild = spawnLabeled('server', 'npx', ['tsx', backendTsEntry], {
            env,
            cwd: backendDir,
            shell: true,
        });
    }
    else {
        console.error('Could not find backend entry point. Run "npm run build" first.');
        if (managedPostgresStarted)
            stopManagedPostgres();
        process.exit(1);
        return; // unreachable — satisfies TypeScript
    }
    // Spawn worker sibling process
    if (existsSync(workerEntry)) {
        // Production: compiled JS — worker
        workerChild = fork(workerEntry, [], { env, cwd: backendDir, stdio: 'inherit' });
    }
    else if (existsSync(workerTsEntry)) {
        // Development: run TypeScript source via tsx — worker
        workerChild = spawnLabeled('worker', 'npx', ['tsx', workerTsEntry], {
            env,
            cwd: backendDir,
            shell: true,
        });
    }
    else {
        console.warn('[startup] worker.ts not found — worker will not start. Pipeline jobs will not be processed.');
    }
    console.log(`Rorca running at http://localhost:${portNum}`);
    const killAll = (sig) => {
        serverChild.kill(sig);
        workerChild?.kill(sig);
        if (managedPostgresStarted)
            stopManagedPostgres();
    };
    serverChild.on('error', (err) => {
        console.error('[server] Failed to start:', err.message);
        killAll('SIGTERM');
        process.exit(1);
    });
    serverChild.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`[server] exited with code ${code}`);
        }
        workerChild?.kill('SIGTERM');
        if (managedPostgresStarted)
            stopManagedPostgres();
        process.exit(code ?? 1);
    });
    workerChild?.on('error', (err) => {
        console.error('[worker] Failed to start:', err.message);
        // Worker failure is non-fatal — server keeps running but warn the operator
        console.error('[worker] Pipeline jobs will not be processed until worker is restarted.');
    });
    workerChild?.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`[worker] exited with code ${code} — pipeline jobs will not be processed`);
        }
    });
    // Open browser after short delay to let server bind
    if (!noOpen) {
        setTimeout(() => {
            const url = `http://localhost:${portNum}`;
            openBrowser(url);
        }, 1500);
    }
    // Worker health check: warn once if worker hasn't registered a heartbeat after 10 s
    setTimeout(() => {
        void (async () => {
            try {
                const res = await fetch(`http://localhost:${portNum}/api/pipeline/worker/health`);
                if (res.ok) {
                    const data = await res.json();
                    if (!data.workerActive) {
                        console.warn('[startup] Warning: worker not yet active — pipeline jobs may be delayed');
                    }
                }
            }
            catch {
                // Server may not be ready yet — not an error worth surfacing
            }
        })();
    }, 10_000);
    // Graceful shutdown: stop all child processes + managed Postgres
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            killAll(sig);
            process.exit(0);
        });
    }
}
async function importBackendModule(distPath, srcPath) {
    const rootDir = join(__dirname, '..');
    const runtimePath = existsSync(join(rootDir, distPath)) ? join(rootDir, distPath) : join(rootDir, srcPath);
    return import(pathToFileURL(runtimePath).href);
}
async function loadDbStrategy() {
    return importBackendModule('backend/dist/lib/db-strategy.js', 'backend/src/lib/db-strategy.ts');
}
async function loadDbSidecar() {
    return importBackendModule('backend/dist/lib/db-sidecar.js', 'backend/src/lib/db-sidecar.ts');
}
async function loadPgIndex() {
    return importBackendModule('backend/dist/db/pg-index.js', 'backend/src/db/pg-index.ts');
}
async function probeDatabaseConnection(databaseUrl) {
    try {
        const pg = require(join(__dirname, '..', 'backend', 'node_modules', 'pg'));
        const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
    }
    catch {
        console.error('Cannot reach Postgres at the configured DATABASE_URL');
        console.error(`  DATABASE_URL: ${databaseUrl.replace(/\/\/[^@]*@/, '//***@')}`);
        process.exit(1);
    }
}
function handleFatalCliError(err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
}
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIdx = 0;
    while (value >= 1024 && unitIdx < units.length - 1) {
        value /= 1024;
        unitIdx += 1;
    }
    return `${value >= 10 || unitIdx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIdx]}`;
}
function createTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}
function getRorcaHome() {
    return join(homedir(), '.rorca');
}
function getNativePostgresDir() {
    return join(getRorcaHome(), 'postgres');
}
function getNativeDataDir() {
    return join(getNativePostgresDir(), 'data');
}
function getNativeDatabaseUrl() {
    return `postgres://rorca:rorca@127.0.0.1:${MANAGED_PG_PORT}/rorca`;
}
function getMigrationBackupPath() {
    const migrationsDir = join(getRorcaHome(), 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    return join(migrationsDir, `lite-backup-${createTimestamp()}.dump`);
}
function getBinaryExtension() {
    return platform() === 'win32' ? '.exe' : '';
}
function resolveNativePgBinary(binary) {
    const candidate = join(getNativePostgresDir(), 'bin', `${binary}${getBinaryExtension()}`);
    if (existsSync(candidate))
        return candidate;
    const fallback = findBinary(binary);
    if (fallback)
        return fallback;
    throw new Error(`Required binary not found: ${binary}`);
}
function getDirectorySizeBytes(dir) {
    if (!existsSync(dir))
        return 0;
    const stat = statSync(dir);
    if (!stat.isDirectory())
        return stat.size;
    let total = 0;
    for (const entry of readdirSync(dir)) {
        total += getDirectorySizeBytes(join(dir, entry));
    }
    return total;
}
function getFreeDiskBytes(pathname) {
    const stats = statfsSync(pathname);
    return Number(stats.bavail) * Number(stats.bsize);
}
function getPgModule() {
    return require(join(__dirname, '..', 'backend', 'node_modules', 'pg'));
}
async function queryRows(databaseUrl, sql, params = []) {
    const pg = getPgModule();
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
        const result = await client.query(sql, params);
        return result.rows;
    }
    finally {
        await client.end();
    }
}
async function queryCount(databaseUrl, sql, params = []) {
    const rows = await queryRows(databaseUrl, sql, params);
    return Number(rows[0]?.count ?? 0);
}
async function getActivePipelineCounts(databaseUrl) {
    const pipelineRuns = await queryCount(databaseUrl, `SELECT COUNT(*)::int AS count
       FROM pipeline_runs
      WHERE status IN ('running', 'queued')`);
    let bossJobs = 0;
    try {
        bossJobs = await queryCount(databaseUrl, `SELECT COUNT(*)::int AS count
         FROM pgboss.job
        WHERE name LIKE 'pipeline:%'
          AND state IN ('created', 'active', 'retry')`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('relation "pgboss.job" does not exist') && !message.includes('schema "pgboss" does not exist')) {
            throw err;
        }
    }
    return { pipelineRuns, bossJobs };
}
async function getWorkspaceCount(databaseUrl) {
    return queryCount(databaseUrl, 'SELECT COUNT(*)::int AS count FROM workspaces');
}
async function confirmPrompt(prompt) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Interactive confirmation required. Re-run this command in a terminal.');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(prompt);
        return answer.trim().toLowerCase() === 'y';
    }
    finally {
        rl.close();
    }
}
function runBinaryWithProgress(label, binary, args, env, progressFile) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        let stdout = '';
        let progressTimer = null;
        const printProgress = () => {
            if (!progressFile || !existsSync(progressFile))
                return;
            try {
                const size = statSync(progressFile).size;
                process.stdout.write(`\r  ${label}... ${formatBytes(size)}`);
            }
            catch {
                // best-effort progress
            }
        };
        if (progressFile) {
            progressTimer = setInterval(printProgress, 1000);
        }
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (progressTimer)
                clearInterval(progressTimer);
            if (progressFile) {
                printProgress();
                process.stdout.write('\n');
            }
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error((stderr || stdout || `${binary} exited with code ${code}`).trim()));
        });
    });
}
async function createNativeBackup(backupPath) {
    const pgDump = resolveNativePgBinary('pg_dump');
    const env = {
        ...process.env,
        PGPASSWORD: 'rorca',
    };
    await runBinaryWithProgress('Backup in progress', pgDump, ['-h', '127.0.0.1', '-p', String(MANAGED_PG_PORT), '-U', 'rorca', '-d', 'rorca', '-Fc', '-f', backupPath], env, backupPath);
}
async function restoreBackupToDocker(backupPath) {
    const pgRestore = resolveNativePgBinary('pg_restore');
    const env = {
        ...process.env,
        PGPASSWORD: 'rorca',
    };
    await runBinaryWithProgress('Restore in progress', pgRestore, ['-h', '127.0.0.1', '-p', '5432', '-U', 'rorca', '-d', 'rorca', '--no-owner', '--no-acl', backupPath], env);
}
async function verifyAgeSmoke(databaseUrl) {
    await queryRows(databaseUrl, 'SELECT * FROM ag_catalog.ag_graph LIMIT 1');
}
async function replayLiteSkippedMigrations(databaseUrl) {
    const { createPoolForConnectionString, prepareLiteSkippedMigrationsForReplay, runPgMigrations } = await loadPgIndex();
    const pool = createPoolForConnectionString(databaseUrl);
    try {
        const versions = await prepareLiteSkippedMigrationsForReplay(pool);
        await runPgMigrations(pool);
        return versions;
    }
    finally {
        await pool.end();
    }
}
async function runLiteToDockerUpgrade() {
    const { setDbMode, getDbConnectionString } = await loadDbStrategy();
    const { dbStart, requireDocker } = await loadDbSidecar();
    const pgDir = await ensurePostgres();
    await startPostgres(pgDir);
    const nativeUrl = getNativeDatabaseUrl();
    const dockerUrl = getDbConnectionString('docker');
    const dataSizeBytes = getDirectorySizeBytes(getNativeDataDir());
    const compressedBackupEstimateBytes = Math.ceil(dataSizeBytes * 1.5);
    const dockerVolumeEstimateBytes = dataSizeBytes;
    const totalRequiredBytes = compressedBackupEstimateBytes + dockerVolumeEstimateBytes;
    const freeDiskBytes = getFreeDiskBytes(getRorcaHome());
    const workspaceCountBefore = await getWorkspaceCount(nativeUrl);
    const active = await getActivePipelineCounts(nativeUrl);
    if (!(await confirmPrompt('Upgrade from Lite Mode (native) to Full Mode (Docker+AGE)? [y/N] '))) {
        console.log('Upgrade cancelled.');
        return;
    }
    if (!(await confirmPrompt(`This will copy ~${formatBytes(dataSizeBytes)} of data and needs ~${formatBytes(totalRequiredBytes)} free. Native DB will be stopped after migration. Continue? [y/N] `))) {
        console.log('Upgrade cancelled.');
        return;
    }
    console.log('Step 1/6: Pre-flight checks');
    await requireDocker();
    if (freeDiskBytes < totalRequiredBytes) {
        throw new Error(`Insufficient disk space. Need ~${formatBytes(totalRequiredBytes)} free, found ${formatBytes(freeDiskBytes)}.`);
    }
    if (active.pipelineRuns > 0 || active.bossJobs > 0) {
        throw new Error(`Active pipeline activity detected (pipeline_runs=${active.pipelineRuns}, pgboss.job=${active.bossJobs}). Finish or clear active work before upgrading.`);
    }
    console.log(`  Native DB reachable on :${MANAGED_PG_PORT}`);
    console.log(`  Free disk: ${formatBytes(freeDiskBytes)}`);
    console.log(`  Workspaces to migrate: ${workspaceCountBefore}`);
    const backupPath = getMigrationBackupPath();
    try {
        console.log('Step 2/6: Backup native data');
        await createNativeBackup(backupPath);
        console.log(`  Backup written to ${backupPath}`);
        console.log('Step 3/6: Start Docker + enable AGE/vector');
        await dbStart();
        console.log('  Docker Postgres ready at localhost:5432');
        console.log('Step 4/6: Restore data into Docker');
        await restoreBackupToDocker(backupPath);
        console.log('  Restore complete');
        console.log('Step 5/6: Replay Lite-skipped migrations');
        const replayedVersions = await replayLiteSkippedMigrations(dockerUrl);
        console.log(replayedVersions.length > 0
            ? `  Replayed migrations: ${replayedVersions.join(', ')}`
            : '  No Lite-skipped migrations needed replay');
        console.log('Step 6/6: Verify and switch mode');
        const workspaceCountAfter = await getWorkspaceCount(dockerUrl);
        if (workspaceCountAfter !== workspaceCountBefore) {
            throw new Error(`Workspace count mismatch after restore (native=${workspaceCountBefore}, docker=${workspaceCountAfter}).`);
        }
        await verifyAgeSmoke(dockerUrl);
        setDbMode('docker');
        stopManagedPostgres();
        console.log('✓ Migration complete. Native PG data preserved at ~/.rorca/postgres/data/. To roll back, set RORCA_DB_MODE=native and restart.');
        console.log('If Rorca is already running, restart it so the database pool reconnects to Docker Postgres.');
    }
    catch (err) {
        setDbMode('native');
        console.error('Migration failed. Native mode remains active; both databases have been left running for manual recovery.');
        console.error(`Backup preserved at ${backupPath}`);
        throw err;
    }
}
async function runDb(dbArgs) {
    const subcommand = dbArgs[0] || 'help';
    if (subcommand === 'help' || dbArgs.includes('--help') || dbArgs.includes('-h')) {
        console.log(`
Usage:
  rorca db start    Start Docker Postgres, or upgrade Lite Mode to Docker + AGE
`);
        return;
    }
    if (subcommand !== 'start') {
        throw new Error(`Unknown db subcommand: ${subcommand}`);
    }
    const { detectDbMode } = await loadDbStrategy();
    const mode = detectDbMode();
    if (mode === 'byop') {
        throw new Error('External Postgres is configured. BYOP databases are user-managed; `rorca db start` is not available.');
    }
    if (mode === 'docker') {
        console.log('Docker mode detected — starting Docker Postgres.');
        const { dbStart } = await loadDbSidecar();
        await dbStart();
        console.log('Docker Postgres ready at localhost:5432');
        return;
    }
    await runLiteToDockerUpgrade();
}
// ────────────────────────────────────────────────────────────────
// Embedded Postgres: detect, download, extract
// ────────────────────────────────────────────────────────────────
const PG_VERSION = '16.6.0';
/** Maps Node.js os.platform()/os.arch() to the Maven artifact platform suffix */
const PLATFORM_MAP = {
    'darwin-arm64': 'darwin-arm64v8',
    'darwin-x64': 'darwin-amd64',
    'linux-x64': 'linux-amd64',
    'linux-arm64': 'linux-arm64v8',
    'win32-x64': 'windows-amd64',
};
/**
 * Detect current OS/arch and return the platform key.
 * Throws for unsupported combinations.
 */
function detectPlatform() {
    const key = `${platform()}-${arch()}`;
    if (!(key in PLATFORM_MAP)) {
        throw new Error(`Unsupported platform: ${key}. ` +
            `Supported platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`);
    }
    return key;
}
/**
 * Build the Maven Central download URL for the embedded-postgres-binaries jar.
 */
function buildDownloadUrl(platformKey, version) {
    const mavenPlatform = PLATFORM_MAP[platformKey];
    const artifact = `embedded-postgres-binaries-${mavenPlatform}`;
    return `https://repo1.maven.org/maven2/io/zonky/test/postgres/${artifact}/${version}/${artifact}-${version}.jar`;
}
const DOWNLOAD_TIMEOUT_MS = 60_000; // 60s with no data = timeout
/**
 * Download a URL to a local file, following redirects, showing progress via \r spinner.
 * Uses only Node.js built-in https/http modules.
 * Times out if no data is received for DOWNLOAD_TIMEOUT_MS.
 */
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        let rejected = false;
        const fail = (err) => {
            if (rejected)
                return;
            rejected = true;
            try {
                unlinkSync(dest);
            }
            catch { /* ignore */ }
            reject(err);
        };
        const doRequest = (requestUrl, redirectCount) => {
            if (redirectCount > 10) {
                fail(new Error('Too many redirects'));
                return;
            }
            const getter = requestUrl.startsWith('https://') ? httpsGet : httpGet;
            const req = getter(requestUrl, (res) => {
                // Handle redirects
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume(); // Drain the response
                    doRequest(res.headers.location, redirectCount + 1);
                    return;
                }
                if (!res.statusCode || res.statusCode !== 200) {
                    res.resume();
                    fail(new Error(`Download failed: HTTP ${res.statusCode}`));
                    return;
                }
                const totalBytes = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : 0;
                let downloadedBytes = 0;
                // Inactivity timeout — fires if no data chunk arrives within 60s
                let inactivityTimer = null;
                const resetTimer = () => {
                    if (inactivityTimer)
                        clearTimeout(inactivityTimer);
                    inactivityTimer = setTimeout(() => {
                        res.destroy();
                        file.close();
                        fail(new Error('Postgres download timed out'));
                    }, DOWNLOAD_TIMEOUT_MS);
                };
                const file = createWriteStream(dest);
                resetTimer();
                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    resetTimer();
                    const progress = totalBytes
                        ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
                        : formatBytes(downloadedBytes);
                    process.stdout.write(`\r  Downloading Postgres ${PG_VERSION}... ${progress}`);
                });
                res.pipe(file);
                file.on('finish', () => {
                    if (inactivityTimer)
                        clearTimeout(inactivityTimer);
                    file.close();
                    if (!rejected) {
                        process.stdout.write('\n');
                        resolve();
                    }
                });
                file.on('error', (err) => {
                    if (inactivityTimer)
                        clearTimeout(inactivityTimer);
                    file.close();
                    fail(err);
                });
                res.on('error', (err) => {
                    if (inactivityTimer)
                        clearTimeout(inactivityTimer);
                    file.close();
                    fail(err);
                });
            });
            req.on('error', (err) => fail(err));
        };
        doRequest(url, 0);
    });
}
/** Required binaries that must exist after extraction */
const REQUIRED_BINARIES = ['postgres', 'initdb', 'pg_ctl', 'createuser'];
/**
 * Ensure Postgres binaries are installed at ~/.rorca/postgres/.
 * Downloads from Maven Central if not already present at the correct version.
 * After extraction, verifies binaries and runs initdb if data dir is missing.
 */
async function ensurePostgres() {
    const pgDir = join(homedir(), '.rorca', 'postgres');
    const binDir = join(pgDir, 'bin');
    const dataDir = join(pgDir, 'data');
    const versionFile = join(pgDir, '.version');
    // Check for corrupt install: bin/ exists but required binaries are missing
    if (existsSync(binDir)) {
        const ext = platform() === 'win32' ? '.exe' : '';
        const missing = REQUIRED_BINARIES.filter(name => !existsSync(join(binDir, `${name}${ext}`)));
        if (missing.length > 0) {
            throw new Error('Postgres install appears corrupt — delete ~/.rorca/postgres and retry');
        }
    }
    // Skip download if already installed at correct version
    if (existsSync(versionFile)) {
        const installed = readFileSync(versionFile, 'utf8').trim();
        if (installed === PG_VERSION) {
            console.log(`Postgres ${PG_VERSION} already installed`);
            // Still ensure data directory is initialized (idempotent)
            await initDataDir(binDir, dataDir);
            return pgDir;
        }
    }
    const platformKey = detectPlatform();
    const url = buildDownloadUrl(platformKey, PG_VERSION);
    console.log(`Installing Postgres ${PG_VERSION} for ${platformKey}...`);
    // Ensure directories exist
    mkdirSync(pgDir, { recursive: true });
    const jarPath = join(pgDir, 'postgres.jar');
    const extractDir = join(pgDir, '_extract');
    try {
        // Download the .jar (which is a zip containing a .txz)
        await downloadFile(url, jarPath);
        // Clean previous extraction
        if (existsSync(extractDir)) {
            rmSync(extractDir, { recursive: true });
        }
        mkdirSync(extractDir, { recursive: true });
        // Extract the .txz from the jar (jar is a zip)
        console.log('  Extracting jar archive...');
        try {
            if (platform() === 'win32') {
                execSync(`tar -xf "${jarPath}" -C "${extractDir}"`, { stdio: 'pipe' });
            }
            else {
                execSync(`unzip -o -q "${jarPath}" -d "${extractDir}"`, { stdio: 'pipe' });
            }
        }
        catch (err) {
            const stderr = err.stderr || (err instanceof Error ? err.message : String(err));
            throw new Error(`Postgres extraction failed (jar → txz). Check disk space.\n${stderr}`);
        }
        // Find the .txz inside
        const extractedFiles = readdirSync(extractDir);
        const txzFile = extractedFiles.find(f => f.endsWith('.txz'));
        if (!txzFile) {
            throw new Error('No .txz archive found inside downloaded jar');
        }
        // Extract the .txz to a staging area first
        const stageDir = join(pgDir, '_stage');
        if (existsSync(stageDir)) {
            rmSync(stageDir, { recursive: true });
        }
        mkdirSync(stageDir, { recursive: true });
        const txzPath = join(extractDir, txzFile);
        console.log('  Extracting Postgres binaries...');
        try {
            if (platform() === 'win32') {
                // Windows 10+ tar supports xz via auto-detect when -a is not specified
                // Use -xf (auto-detect compression) which works for both .txz and .tar.gz
                execSync(`tar -xf "${txzPath}" -C "${stageDir}"`, { stdio: 'pipe' });
            }
            else {
                // Unix: explicit xz decompression flag
                execSync(`tar xJf "${txzPath}" -C "${stageDir}"`, { stdio: 'pipe' });
            }
        }
        catch (err) {
            const stderr = err.stderr || (err instanceof Error ? err.message : String(err));
            throw new Error(`Postgres extraction failed (txz → binaries). Check disk space.\n${stderr}`);
        }
        // Locate the bin/ directory — may be at stage root or nested (e.g., pgsql/bin/)
        relocateBinaries(stageDir, pgDir);
        // Clean staging area
        try {
            rmSync(stageDir, { recursive: true });
        }
        catch { /* ignore */ }
        // Verify required binaries exist
        verifyBinaries(binDir);
        // Write version marker
        writeFileSync(versionFile, PG_VERSION);
        console.log(`  Postgres ${PG_VERSION} installed to ${pgDir}`);
        // Initialize data directory
        await initDataDir(binDir, dataDir);
        return pgDir;
    }
    finally {
        // Cleanup temp files
        try {
            unlinkSync(jarPath);
        }
        catch { /* ignore */ }
        try {
            rmSync(extractDir, { recursive: true });
        }
        catch { /* ignore */ }
    }
}
/**
 * Relocate extracted Postgres files to pgDir.
 * The .txz may extract with bin/ at the top level, or nested under a subdirectory
 * (e.g., pgsql/). This function finds the bin/ directory and moves everything
 * to the correct location.
 */
function relocateBinaries(stageDir, pgDir) {
    const stageBin = join(stageDir, 'bin');
    if (existsSync(stageBin) && statSync(stageBin).isDirectory()) {
        // bin/ is at stage root — move all top-level dirs (bin, lib, share, etc.)
        moveContents(stageDir, pgDir);
        return;
    }
    // Search one level deep for a directory containing bin/
    const entries = readdirSync(stageDir);
    for (const entry of entries) {
        const nestedPath = join(stageDir, entry);
        if (statSync(nestedPath).isDirectory()) {
            const nestedBin = join(nestedPath, 'bin');
            if (existsSync(nestedBin) && statSync(nestedBin).isDirectory()) {
                moveContents(nestedPath, pgDir);
                return;
            }
        }
    }
    throw new Error(`Could not locate bin/ directory in extracted archive. Contents: ${entries.join(', ')}`);
}
/**
 * Move all items from srcDir into destDir, overwriting existing.
 */
function moveContents(srcDir, destDir) {
    const items = readdirSync(srcDir);
    for (const item of items) {
        const src = join(srcDir, item);
        const dest = join(destDir, item);
        // Remove existing destination to allow overwrite
        if (existsSync(dest)) {
            rmSync(dest, { recursive: true });
        }
        renameSync(src, dest);
    }
}
/**
 * Verify that all required Postgres binaries exist at binDir.
 * Throws with a clear message listing missing binaries.
 */
function verifyBinaries(binDir) {
    const ext = platform() === 'win32' ? '.exe' : '';
    const missing = [];
    for (const name of REQUIRED_BINARIES) {
        const binPath = join(binDir, `${name}${ext}`);
        if (!existsSync(binPath)) {
            missing.push(binPath);
        }
    }
    if (missing.length > 0) {
        throw new Error(`Postgres extraction incomplete — missing binaries:\n  ${missing.join('\n  ')}`);
    }
    console.log(`  Verified ${REQUIRED_BINARIES.length} binaries in ${binDir}`);
}
/**
 * Initialize a Postgres data directory using initdb.
 * Only runs if the data directory does not already exist (idempotent).
 * Uses --no-locale --encoding=UTF8 --username=rorca.
 */
async function initDataDir(binDir, dataDir) {
    if (existsSync(dataDir)) {
        console.log(`  Data directory already exists: ${dataDir}`);
        return;
    }
    const ext = platform() === 'win32' ? '.exe' : '';
    const initdbBin = join(binDir, `initdb${ext}`);
    if (!existsSync(initdbBin)) {
        throw new Error(`initdb not found at ${initdbBin}`);
    }
    console.log('  Initializing Postgres data directory...');
    try {
        execSync(`"${initdbBin}" --no-locale --encoding=UTF8 --username=rorca -D "${dataDir}"`, { stdio: 'pipe', encoding: 'utf8' });
        console.log(`  Data directory initialized: ${dataDir}`);
    }
    catch (err) {
        const stderr = err.stderr || (err instanceof Error ? err.message : String(err));
        throw new Error(`initdb failed:\n${stderr}`);
    }
}
/**
 * Check if a TCP host:port is reachable within timeoutMs.
 */
function tcpReachable(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const sock = createConnection({ host, port });
        sock.setTimeout(timeoutMs);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
    });
}
const MANAGED_PG_PORT = 5433;
/**
 * Start the managed Postgres instance via pg_ctl on port MANAGED_PG_PORT.
 * Creates the 'rorca' database if it doesn't exist.
 * Returns true if Postgres was started successfully.
 */
async function startPostgres(pgDir) {
    const ext = platform() === 'win32' ? '.exe' : '';
    const binDir = join(pgDir, 'bin');
    const dataDir = join(pgDir, 'data');
    const pgCtl = join(binDir, `pg_ctl${ext}`);
    const logFile = join(pgDir, 'postgres.log');
    // Check if already running on our port
    if (await tcpReachable('127.0.0.1', MANAGED_PG_PORT, 1000)) {
        // Verify it's actually our managed Postgres by checking pg_ctl status
        const statusResult = spawnSync(pgCtl, ['status', '-D', dataDir], {
            encoding: 'utf8',
            timeout: 5000,
        });
        if (statusResult.status === 0) {
            console.log(`Managed Postgres already running on port ${MANAGED_PG_PORT}`);
            return;
        }
        // Port is occupied but it's NOT our managed Postgres
        throw new Error(`Port ${MANAGED_PG_PORT} is already in use by another process`);
    }
    // Configure port in postgresql.conf if not already set
    const confPath = join(dataDir, 'postgresql.conf');
    if (existsSync(confPath)) {
        const conf = readFileSync(confPath, 'utf8');
        if (!conf.includes(`port = ${MANAGED_PG_PORT}`)) {
            writeFileSync(confPath, conf + `\nport = ${MANAGED_PG_PORT}\n`);
        }
    }
    console.log(`  Starting Postgres on port ${MANAGED_PG_PORT}...`);
    const startResult = spawnSync(pgCtl, ['start', '-D', dataDir, '-l', logFile, '-w', '-o', `-p ${MANAGED_PG_PORT}`], { encoding: 'utf8', timeout: 30000 });
    if (startResult.status !== 0) {
        const errMsg = (startResult.stderr || '') + (startResult.stdout || '');
        if (errMsg.includes('address already in use') || errMsg.includes('Address already in use')) {
            throw new Error(`Port ${MANAGED_PG_PORT} is already in use by another process`);
        }
        throw new Error(`pg_ctl start failed:\n${errMsg || 'unknown error'}`);
    }
    console.log(`  Postgres started (port ${MANAGED_PG_PORT}, log: ${logFile})`);
    // Create the 'rorca' database if it doesn't exist
    const createdbBin = join(binDir, `createdb${ext}`);
    if (existsSync(createdbBin)) {
        const dbResult = spawnSync(createdbBin, ['-h', '127.0.0.1', '-p', String(MANAGED_PG_PORT), '-U', 'rorca', 'rorca'], { encoding: 'utf8', timeout: 10000 });
        // Exit code 0 = created, non-zero with "already exists" = fine
        if (dbResult.status === 0) {
            console.log('  Created database: rorca');
        }
        else if (dbResult.stderr?.includes('already exists')) {
            // Database already exists — nothing to do
        }
        else if (dbResult.status !== 0) {
            console.warn(`  Warning: createdb returned code ${dbResult.status}: ${dbResult.stderr}`);
        }
    }
    else {
        // Fallback: use psql to create database
        const psqlBin = join(binDir, `psql${ext}`);
        if (existsSync(psqlBin)) {
            spawnSync(psqlBin, ['-h', '127.0.0.1', '-p', String(MANAGED_PG_PORT), '-U', 'rorca', '-c',
                "SELECT 'exists' FROM pg_database WHERE datname='rorca'" +
                    " UNION ALL SELECT 'create' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='rorca');"], { encoding: 'utf8', timeout: 10000 });
            // Simple attempt — if it fails, the backend migration runner will report the error
            spawnSync(psqlBin, ['-h', '127.0.0.1', '-p', String(MANAGED_PG_PORT), '-U', 'rorca', '-tc',
                "CREATE DATABASE rorca;"], { encoding: 'utf8', timeout: 10000 });
        }
    }
}
/**
 * Stop the managed Postgres instance via pg_ctl.
 * Uses spawnSync to ensure the stop completes before process exits.
 */
function stopManagedPostgres() {
    const pgDir = join(homedir(), '.rorca', 'postgres');
    const dataDir = join(pgDir, 'data');
    const ext = platform() === 'win32' ? '.exe' : '';
    const pgCtl = join(pgDir, 'bin', `pg_ctl${ext}`);
    if (!existsSync(pgCtl) || !existsSync(dataDir)) {
        return;
    }
    console.log('\nStopping managed Postgres...');
    const result = spawnSync(pgCtl, ['stop', '-D', dataDir, '-m', 'fast'], {
        encoding: 'utf8',
        timeout: 15000,
    });
    if (result.status === 0) {
        console.log('Managed Postgres stopped.');
    }
    else {
        // pg_ctl stop returns non-zero if server wasn't running — not an error
        const msg = result.stderr || result.stdout || '';
        if (!msg.includes('not running')) {
            console.warn(`pg_ctl stop warning: ${msg.trim()}`);
        }
    }
}
// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
/**
 * Parse a postgres:// URL into host and port.
 * Returns null if the URL is not parseable.
 */
function parsePostgresUrl(url) {
    try {
        // Replace postgres:// with http:// for URL parsing
        const normalized = url.replace(/^postgres(ql)?:\/\//, 'http://');
        const parsed = new URL(normalized);
        return {
            host: parsed.hostname || '127.0.0.1',
            port: parsed.port ? parseInt(parsed.port, 10) : 5432,
        };
    }
    catch {
        return null;
    }
}
function findBinary(name) {
    try {
        const result = execSync(process.platform === 'win32' ? `where ${name}` : `which ${name}`, { encoding: 'utf8' }).trim();
        return result.split('\n')[0].trim() || null;
    }
    catch {
        return null;
    }
}
function openBrowser(url) {
    try {
        if (process.platform === 'darwin') {
            execSync(`open "${url}"`);
        }
        else if (process.platform === 'win32') {
            execSync(`start "" "${url}"`);
        }
        else {
            execSync(`xdg-open "${url}"`);
        }
    }
    catch {
        console.log(`Open ${url} in your browser.`);
    }
}
