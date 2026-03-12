#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync, writeFileSync, createWriteStream, unlinkSync, rmSync, readdirSync, renameSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync, fork, spawn } from 'child_process';
import { homedir, platform, arch } from 'os';
import { get as httpsGet } from 'https';
import { get as httpGet, type IncomingMessage } from 'http';
import { createConnection } from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
  name: string;
};

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
  rorca init               Register Rorca as an MCP server with claude CLI
  rorca --version          Print version
  rorca --help             Show this help message

Options for start:
  --port <port>            Server port (default: 3030)
  --no-open                Don't open browser on start

Examples:
  rorca start
  rorca start --port 4040
  rorca start --no-open
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

// ─── Command: start ───
if (command === 'start') {
  runStart(args.slice(1));
  // runStart sets up async process management — don't exit here
} else {
  console.error(`Unknown command: ${command}\nRun "rorca --help" for usage.`);
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────
// init: register MCP server with claude CLI
// ────────────────────────────────────────────────────────────────

function runInit(): void {
  console.log('Initializing Rorca MCP integration...\n');

  const claudeBin = findBinary('claude');

  if (!claudeBin) {
    console.log('Claude CLI not found in PATH.\n');
    console.log('To register Rorca as an MCP server manually, run:');
    console.log(
      '  claude mcp add --global rorca --transport http http://localhost:3030/mcp\n'
    );
    console.log('Install Claude CLI: https://claude.ai/download');
    return;
  }

  console.log(`Found claude at: ${claudeBin}`);

  // Check if already registered
  try {
    const listOutput = execSync(`${claudeBin} mcp list 2>&1`, { encoding: 'utf8' });
    if (listOutput.includes('rorca')) {
      console.log('Rorca is already registered as an MCP server.');
      console.log(
        'To update the registration, remove it first: claude mcp remove rorca'
      );
      return;
    }
  } catch {
    // mcp list may not exist in older versions — proceed anyway
  }

  try {
    execSync(
      `${claudeBin} mcp add --global rorca --transport http http://localhost:3030/mcp`,
      { stdio: 'inherit' }
    );
    console.log('\nRorca MCP server registered successfully.');
    console.log('Start Rorca with "rorca start", then use Claude with full Rorca access.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Already registered — not an error
    if (msg.includes('already') || msg.includes('exists')) {
      console.log('Rorca MCP server is already registered.');
    } else {
      console.error('Failed to register MCP server:', msg);
      console.log('\nTo register manually, run:');
      console.log(
        '  claude mcp add --global rorca --transport http http://localhost:3030/mcp'
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────
// start: launch Express backend + open browser
// ────────────────────────────────────────────────────────────────

async function runStart(startArgs: string[]): Promise<void> {
  // Parse options
  const portIdx = startArgs.indexOf('--port');
  const port = portIdx !== -1 && startArgs[portIdx + 1] ? startArgs[portIdx + 1] : '3030';
  const noOpen = startArgs.includes('--no-open');

  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  // Ensure ~/.rorca/ config directory exists
  const rorcaHome = join(homedir(), '.rorca');
  if (!existsSync(rorcaHome)) {
    mkdirSync(rorcaHome, { recursive: true });
    console.log(`Created config directory: ${rorcaHome}`);
  }

  // ── Postgres provisioning ──
  // If DATABASE_URL is already set and reachable, use it as-is (user-provided).
  // Otherwise, provision and start a managed Postgres instance.
  let managedPostgresStarted = false;
  let databaseUrl = process.env.DATABASE_URL || '';

  if (databaseUrl) {
    // User provided DATABASE_URL — check if it's reachable
    const urlObj = parsePostgresUrl(databaseUrl);
    if (urlObj && await tcpReachable(urlObj.host, urlObj.port, 3000)) {
      console.log(`Using user-provided DATABASE_URL (${urlObj.host}:${urlObj.port})`);
    } else {
      console.error(`Cannot reach Postgres at user-provided DATABASE_URL`);
      console.error(`  DATABASE_URL: ${databaseUrl.replace(/\/\/[^@]*@/, '//***@')}`);
      process.exit(1);
    }
  } else {
    // No DATABASE_URL — provision managed Postgres
    const pgDir = await ensurePostgres();
    await startPostgres(pgDir);
    managedPostgresStarted = true;
    databaseUrl = `postgres://rorca:rorca@127.0.0.1:${MANAGED_PG_PORT}/rorca`;
    process.env.DATABASE_URL = databaseUrl;
    console.log(`Managed Postgres ready at 127.0.0.1:${MANAGED_PG_PORT}`);
  }

  // Auto-build frontend if dist/ is missing
  const rootDir = join(__dirname, '..');
  const distDir = join(rootDir, 'dist');
  if (!existsSync(join(distDir, 'index.html'))) {
    console.log('Frontend not built yet — building...');
    try {
      execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
    } catch {
      console.error('Build failed. Please run "npm run build" manually and try again.');
      process.exit(1);
    }
  }

  const env: NodeJS.ProcessEnv = {
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
  const backendTsEntry = join(backendDir, 'src', 'server.ts');

  let child: ReturnType<typeof fork> | ReturnType<typeof spawn>;

  if (existsSync(backendEntry)) {
    // Production: compiled JS
    child = fork(backendEntry, [], { env, cwd: backendDir, stdio: 'inherit' });
  } else if (existsSync(backendTsEntry)) {
    // Development: run TypeScript source via tsx
    child = spawn('npx', ['tsx', backendTsEntry], {
      env,
      cwd: backendDir,
      stdio: 'inherit',
      shell: true,
    });
  } else {
    console.error('Could not find backend entry point. Run "npm run build" first.');
    if (managedPostgresStarted) stopManagedPostgres();
    process.exit(1);
    return; // unreachable — satisfies TypeScript
  }

  console.log(`Rorca running at http://localhost:${portNum}`);

  child.on('error', (err: Error) => {
    console.error('Failed to start server:', err.message);
    if (managedPostgresStarted) stopManagedPostgres();
    process.exit(1);
  });

  child.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.error(`Server exited with code ${code}`);
    }
    if (managedPostgresStarted) stopManagedPostgres();
    process.exit(code ?? 1);
  });

  // Open browser after short delay to let server bind
  if (!noOpen) {
    setTimeout(() => {
      const url = `http://localhost:${portNum}`;
      openBrowser(url);
    }, 1500);
  }

  // Graceful shutdown: stop managed Postgres before exiting
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      child.kill(sig);
      if (managedPostgresStarted) stopManagedPostgres();
      process.exit(0);
    });
  }
}

// ────────────────────────────────────────────────────────────────
// Embedded Postgres: detect, download, extract
// ────────────────────────────────────────────────────────────────

const PG_VERSION = '16.6.0';

/** Maps Node.js os.platform()/os.arch() to the Maven artifact platform suffix */
const PLATFORM_MAP: Record<string, string> = {
  'darwin-arm64':  'darwin-arm64v8',
  'darwin-x64':    'darwin-amd64',
  'linux-x64':     'linux-amd64',
  'linux-arm64':   'linux-arm64v8',
  'win32-x64':     'windows-amd64',
};

type SupportedPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64';

/**
 * Detect current OS/arch and return the platform key.
 * Throws for unsupported combinations.
 */
function detectPlatform(): SupportedPlatform {
  const key = `${platform()}-${arch()}`;
  if (!(key in PLATFORM_MAP)) {
    throw new Error(
      `Unsupported platform: ${key}. ` +
      `Supported platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`
    );
  }
  return key as SupportedPlatform;
}

/**
 * Build the Maven Central download URL for the embedded-postgres-binaries jar.
 */
function buildDownloadUrl(platformKey: SupportedPlatform, version: string): string {
  const mavenPlatform = PLATFORM_MAP[platformKey];
  const artifact = `embedded-postgres-binaries-${mavenPlatform}`;
  return `https://repo1.maven.org/maven2/io/zonky/test/postgres/${artifact}/${version}/${artifact}-${version}.jar`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Download a URL to a local file, following redirects, showing progress via \r spinner.
 * Uses only Node.js built-in https/http modules.
 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl: string, redirectCount: number) => {
      if (redirectCount > 10) {
        reject(new Error('Too many redirects'));
        return;
      }

      const getter = requestUrl.startsWith('https://') ? httpsGet : httpGet;
      getter(requestUrl, (res: IncomingMessage) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // Drain the response
          doRequest(res.headers.location, redirectCount + 1);
          return;
        }

        if (!res.statusCode || res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        const totalBytes = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : 0;
        let downloadedBytes = 0;

        const file = createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          const progress = totalBytes
            ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
            : formatBytes(downloadedBytes);
          process.stdout.write(`\r  Downloading Postgres ${PG_VERSION}... ${progress}`);
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });

        file.on('error', (err) => {
          file.close();
          try { unlinkSync(dest); } catch { /* ignore */ }
          reject(err);
        });

        res.on('error', (err) => {
          file.close();
          try { unlinkSync(dest); } catch { /* ignore */ }
          reject(err);
        });
      }).on('error', reject);
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
async function ensurePostgres(): Promise<string> {
  const pgDir = join(homedir(), '.rorca', 'postgres');
  const binDir = join(pgDir, 'bin');
  const dataDir = join(pgDir, 'data');
  const versionFile = join(pgDir, '.version');

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
    if (platform() === 'win32') {
      execSync(`tar -xf "${jarPath}" -C "${extractDir}"`, { stdio: 'pipe' });
    } else {
      execSync(`unzip -o -q "${jarPath}" -d "${extractDir}"`, { stdio: 'pipe' });
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
    if (platform() === 'win32') {
      // Windows 10+ tar supports xz via auto-detect when -a is not specified
      // Use -xf (auto-detect compression) which works for both .txz and .tar.gz
      execSync(`tar -xf "${txzPath}" -C "${stageDir}"`, { stdio: 'pipe' });
    } else {
      // Unix: explicit xz decompression flag
      execSync(`tar xJf "${txzPath}" -C "${stageDir}"`, { stdio: 'pipe' });
    }

    // Locate the bin/ directory — may be at stage root or nested (e.g., pgsql/bin/)
    relocateBinaries(stageDir, pgDir);

    // Clean staging area
    try { rmSync(stageDir, { recursive: true }); } catch { /* ignore */ }

    // Verify required binaries exist
    verifyBinaries(binDir);

    // Write version marker
    writeFileSync(versionFile, PG_VERSION);
    console.log(`  Postgres ${PG_VERSION} installed to ${pgDir}`);

    // Initialize data directory
    await initDataDir(binDir, dataDir);

    return pgDir;
  } finally {
    // Cleanup temp files
    try { unlinkSync(jarPath); } catch { /* ignore */ }
    try { rmSync(extractDir, { recursive: true }); } catch { /* ignore */ }
  }
}

/**
 * Relocate extracted Postgres files to pgDir.
 * The .txz may extract with bin/ at the top level, or nested under a subdirectory
 * (e.g., pgsql/). This function finds the bin/ directory and moves everything
 * to the correct location.
 */
function relocateBinaries(stageDir: string, pgDir: string): void {
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

  throw new Error(
    `Could not locate bin/ directory in extracted archive. Contents: ${entries.join(', ')}`
  );
}

/**
 * Move all items from srcDir into destDir, overwriting existing.
 */
function moveContents(srcDir: string, destDir: string): void {
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
function verifyBinaries(binDir: string): void {
  const ext = platform() === 'win32' ? '.exe' : '';
  const missing: string[] = [];

  for (const name of REQUIRED_BINARIES) {
    const binPath = join(binDir, `${name}${ext}`);
    if (!existsSync(binPath)) {
      missing.push(binPath);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Postgres extraction incomplete — missing binaries:\n  ${missing.join('\n  ')}`
    );
  }

  console.log(`  Verified ${REQUIRED_BINARIES.length} binaries in ${binDir}`);
}

/**
 * Initialize a Postgres data directory using initdb.
 * Only runs if the data directory does not already exist (idempotent).
 * Uses --no-locale --encoding=UTF8 --username=rorca.
 */
async function initDataDir(binDir: string, dataDir: string): Promise<void> {
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
    execSync(
      `"${initdbBin}" --no-locale --encoding=UTF8 --username=rorca -D "${dataDir}"`,
      { stdio: 'pipe', encoding: 'utf8' }
    );
    console.log(`  Data directory initialized: ${dataDir}`);
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`initdb failed:\n${stderr}`);
  }
}

/**
 * Check if a TCP host:port is reachable within timeoutMs.
 */
function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
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
async function startPostgres(pgDir: string): Promise<void> {
  const ext = platform() === 'win32' ? '.exe' : '';
  const binDir = join(pgDir, 'bin');
  const dataDir = join(pgDir, 'data');
  const pgCtl = join(binDir, `pg_ctl${ext}`);
  const logFile = join(pgDir, 'postgres.log');

  // Check if already running on our port
  if (await tcpReachable('127.0.0.1', MANAGED_PG_PORT, 1000)) {
    console.log(`Managed Postgres already running on port ${MANAGED_PG_PORT}`);
    return;
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
  const startResult = spawnSync(
    pgCtl,
    ['start', '-D', dataDir, '-l', logFile, '-w', '-o', `-p ${MANAGED_PG_PORT}`],
    { encoding: 'utf8', timeout: 30000 }
  );

  if (startResult.status !== 0) {
    const errMsg = startResult.stderr || startResult.stdout || 'unknown error';
    throw new Error(`pg_ctl start failed:\n${errMsg}`);
  }

  console.log(`  Postgres started (port ${MANAGED_PG_PORT}, log: ${logFile})`);

  // Create the 'rorca' database if it doesn't exist
  const createdbBin = join(binDir, `createdb${ext}`);
  if (existsSync(createdbBin)) {
    const dbResult = spawnSync(
      createdbBin,
      ['-h', '127.0.0.1', '-p', String(MANAGED_PG_PORT), '-U', 'rorca', 'rorca'],
      { encoding: 'utf8', timeout: 10000 }
    );
    // Exit code 0 = created, non-zero with "already exists" = fine
    if (dbResult.status === 0) {
      console.log('  Created database: rorca');
    } else if (dbResult.stderr?.includes('already exists')) {
      // Database already exists — nothing to do
    } else if (dbResult.status !== 0) {
      console.warn(`  Warning: createdb returned code ${dbResult.status}: ${dbResult.stderr}`);
    }
  } else {
    // Fallback: use psql to create database
    const psqlBin = join(binDir, `psql${ext}`);
    if (existsSync(psqlBin)) {
      spawnSync(
        psqlBin,
        ['-h', '127.0.0.1', '-p', String(MANAGED_PG_PORT), '-U', 'rorca', '-c',
         "SELECT 'exists' FROM pg_database WHERE datname='rorca'" +
         " UNION ALL SELECT 'create' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='rorca');"],
        { encoding: 'utf8', timeout: 10000 }
      );
      // Simple attempt — if it fails, the backend migration runner will report the error
      spawnSync(
        psqlBin,
        ['-h', '127.0.0.1', '-p', String(MANAGED_PG_PORT), '-U', 'rorca', '-tc',
         "CREATE DATABASE rorca;"],
        { encoding: 'utf8', timeout: 10000 }
      );
    }
  }
}

/**
 * Stop the managed Postgres instance via pg_ctl.
 * Uses spawnSync to ensure the stop completes before process exits.
 */
function stopManagedPostgres(): void {
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
  } else {
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
function parsePostgresUrl(url: string): { host: string; port: number } | null {
  try {
    // Replace postgres:// with http:// for URL parsing
    const normalized = url.replace(/^postgres(ql)?:\/\//, 'http://');
    const parsed = new URL(normalized);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    };
  } catch {
    return null;
  }
}

function findBinary(name: string): string | null {
  try {
    const result = execSync(
      process.platform === 'win32' ? `where ${name}` : `which ${name}`,
      { encoding: 'utf8' }
    ).trim();
    return result.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`);
    } else if (process.platform === 'win32') {
      execSync(`start "" "${url}"`);
    } else {
      execSync(`xdg-open "${url}"`);
    }
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}
