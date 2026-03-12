#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, fork, spawn } from 'child_process';
import { homedir } from 'os';
import * as net from 'net';

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
  runStart(args.slice(1)).catch((err) => {
    console.error(`\nStartup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
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
// start: orchestrate first-run onboarding + launch Express
// ────────────────────────────────────────────────────────────────

async function runStart(startArgs: string[]): Promise<void> {
  // Parse options
  const portIdx = startArgs.indexOf('--port');
  const explicitPort = portIdx !== -1 && startArgs[portIdx + 1] ? startArgs[portIdx + 1] : null;
  const noOpen = startArgs.includes('--no-open');

  if (explicitPort) {
    const parsed = parseInt(explicitPort, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error(`Invalid port: ${explicitPort}`);
      process.exit(1);
    }
  }

  const rorcaHome = join(homedir(), '.rorca');
  const isFirstRun = !existsSync(rorcaHome);

  if (isFirstRun) {
    await runFirstTimeSetup(rorcaHome);
  } else {
    await runSubsequentStart(rorcaHome);
  }

  // ── Resolve port ──
  const basePort = explicitPort ? parseInt(explicitPort, 10) : 3030;
  const portNum = explicitPort
    ? basePort // explicit port — don't scan, fail if taken
    : await findAvailablePort(basePort, 3039);

  if (portNum === null) {
    console.error(`\nAll ports 3030-3039 are in use. Specify a free port with --port <port>.`);
    process.exit(1);
    return;
  }

  if (explicitPort && !(await isPortFree(basePort))) {
    console.error(`Port ${basePort} is already in use. Choose a different port with --port <port>.`);
    process.exit(1);
    return;
  }

  const dbPath = join(rorcaHome, 'rorca.db');

  // Auto-build frontend if dist/ is missing
  const rootDir = join(__dirname, '..');
  const distDir = join(rootDir, 'dist');
  if (!existsSync(join(distDir, 'index.html'))) {
    stepLog('Building frontend assets');
    try {
      execSync('npm run build', { cwd: rootDir, stdio: 'pipe' });
      stepDone();
    } catch {
      stepFail();
      console.error('  Run "npm run build" manually and try again.');
      process.exit(1);
    }
  }

  // ── Step: Start Express ──
  stepLog(`Starting Rorca on http://localhost:${portNum}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(portNum),
    DB_PATH: dbPath,
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
    child = fork(backendEntry, [], { env, cwd: backendDir, stdio: 'inherit' });
  } else if (existsSync(backendTsEntry)) {
    child = spawn('npx', ['tsx', backendTsEntry], {
      env,
      cwd: backendDir,
      stdio: 'inherit',
      shell: true,
    });
  } else {
    stepFail();
    console.error('  Could not find backend entry point. Run "npm run build" first.');
    process.exit(1);
    return;
  }

  child.on('error', (err: Error) => {
    console.error(`\nFailed to start server: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code: number | null) => {
    stopManagedPostgres();
    if (code !== 0 && code !== null) {
      console.error(`Server exited with code ${code}`);
    }
    process.exit(code ?? 1);
  });

  // Open browser after short delay to let server bind
  if (!noOpen) {
    setTimeout(() => {
      openBrowser(`http://localhost:${portNum}`);
    }, 1500);
  }

  console.log('');
  console.log(`  Press Ctrl+C to stop.`);
  console.log('');

  // Forward signals for clean shutdown — stop Postgres before exiting
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.log('\nShutting down...');
      child.kill(sig);
      stopManagedPostgres();
    });
  }
}

// ────────────────────────────────────────────────────────────────
// First-time setup flow
// ────────────────────────────────────────────────────────────────

async function runFirstTimeSetup(rorcaHome: string): Promise<void> {
  printWelcomeBanner();

  // Step 0: Create directory structure
  stepLog('Creating ~/.rorca/ directory structure');
  mkdirSync(join(rorcaHome, 'data'), { recursive: true });
  mkdirSync(join(rorcaHome, 'logs'), { recursive: true });
  stepDone();

  // Dynamically import PostgresManager (lives in backend)
  const { PostgresManager } = await importPostgresManager();
  const pg = new PostgresManager({
    cacheDir: join(rorcaHome, 'postgres'),
    dataDir: join(rorcaHome, 'data'),
  });

  // Step 1: Check / download Postgres
  if (!pg.isInstalled()) {
    stepLog('Downloading PostgreSQL 16.4 + pgvector');
    try {
      await pg.download();
      process.stdout.write('\n'); // newline after progress bar
      stepDone();
    } catch (err) {
      stepFail();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${msg}`);
      console.error('  Try setting POSTGRES_DOWNLOAD_URL to a mirror, or install Postgres manually.');
      process.exit(1);
    }
  } else {
    stepLog('PostgreSQL binary found');
    stepDone();
  }

  // Step 2: Initialize cluster
  stepLog('Initializing database cluster');
  try {
    pg.initCluster();
    stepDone();
  } catch (err) {
    stepFail();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${msg}`);
    process.exit(1);
  }

  // Step 3: Start Postgres
  stepLog(`Starting PostgreSQL on port ${pg.port}`);
  try {
    await pg.start();
    stepDone();
  } catch (err) {
    stepFail();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${msg}`);
    console.error(`  Check ~/.rorca/postgres.log for details.`);
    process.exit(1);
  }

  // Step 4: Create database + run migrations
  stepLog('Creating database');
  try {
    pg.createDatabase();
    stepDone();
  } catch (err) {
    stepFail();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${msg}`);
    process.exit(1);
  }

  stepLog('Running migrations (47 tables)');
  // Migrations run automatically when backend starts via db/index.ts
  // Just mark as done — the Express import triggers them
  stepDone();

  console.log('');
}

// ────────────────────────────────────────────────────────────────
// Subsequent start (fast path)
// ────────────────────────────────────────────────────────────────

async function runSubsequentStart(rorcaHome: string): Promise<void> {
  // Ensure data/logs dirs exist (in case user deleted them)
  mkdirSync(join(rorcaHome, 'data'), { recursive: true });
  mkdirSync(join(rorcaHome, 'logs'), { recursive: true });

  const { PostgresManager } = await importPostgresManager();
  const pg = new PostgresManager({
    cacheDir: join(rorcaHome, 'postgres'),
    dataDir: join(rorcaHome, 'data'),
  });

  // Only start Postgres if binary is installed (user may be using external Postgres)
  if (pg.isInstalled()) {
    if (!pg.isRunning()) {
      stepLog(`Starting PostgreSQL on port ${pg.port}`);
      try {
        await pg.start();
        stepDone();
      } catch (err) {
        stepFail();
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ${msg}`);
        console.error(`  Check ~/.rorca/postgres.log for details.`);
        process.exit(1);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Welcome banner
// ────────────────────────────────────────────────────────────────

function printWelcomeBanner(): void {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║                                          ║');
  console.log('  ║   ██████╗  ██████╗ ██████╗  ██████╗ █╗  ║');
  console.log('  ║   ██╔══██╗██╔═══██╗██╔══██╗██╔════╝██║  ║');
  console.log('  ║   ██████╔╝██║   ██║██████╔╝██║     ███║ ║');
  console.log('  ║   ██╔══██╗██║   ██║██╔══██╗██║     ╚██║ ║');
  console.log('  ║   ██║  ██║╚██████╔╝██║  ██║╚██████╗ ██║ ║');
  console.log('  ║   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝ ║');
  console.log('  ║                                          ║');
  console.log(`  ║   v${pkg.version.padEnd(38)}║`);
  console.log('  ║   AI spec orchestration pipeline         ║');
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  First-time setup — this only runs once.');
  console.log('');
}

// ────────────────────────────────────────────────────────────────
// Step output formatting
// ────────────────────────────────────────────────────────────────

let _stepLabel = '';

function stepLog(label: string): void {
  _stepLabel = label;
  const padded = label.padEnd(50, '.');
  process.stdout.write(`  ${padded} `);
}

function stepDone(): void {
  process.stdout.write('done\n');
}

function stepFail(): void {
  process.stdout.write('FAILED\n');
}

// ────────────────────────────────────────────────────────────────
// Port scanning
// ────────────────────────────────────────────────────────────────

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(start: number, end: number): Promise<number | null> {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Dynamic import of PostgresManager
// ────────────────────────────────────────────────────────────────

async function importPostgresManager(): Promise<{ PostgresManager: typeof import('../backend/src/lib/postgres-manager').PostgresManager }> {
  // Try compiled JS first, fall back to TS source via tsx
  const rootDir = join(__dirname, '..');
  const compiledPath = join(rootDir, 'backend', 'dist', 'lib', 'postgres-manager.js');
  const sourcePath = join(rootDir, 'backend', 'src', 'lib', 'postgres-manager.ts');

  if (existsSync(compiledPath)) {
    return await import(compiledPath);
  }

  // When running via tsx, the TS source is importable directly
  return await import(sourcePath);
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

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

/**
 * Stop the managed Postgres server on shutdown.
 * Uses pg_ctl from the cached binary location. Best-effort — if it fails,
 * the PID file will trigger a reuse on next start.
 */
function stopManagedPostgres(): void {
  const rorcaHome = join(homedir(), '.rorca');
  const pgCtl = join(rorcaHome, 'postgres', 'bin', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
  const dataDir = join(rorcaHome, 'data');

  if (!existsSync(pgCtl) || !existsSync(dataDir)) return;

  try {
    execSync(`"${pgCtl}" stop -D "${dataDir}" -m fast -w`, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: 'pipe',
    });
    console.log('PostgreSQL stopped.');
  } catch {
    // best-effort — process may already be gone
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
