#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, fork, spawn, spawnSync } from 'child_process';
import { homedir, platform, arch } from 'os';
import * as https from 'https';
import * as net from 'net';
import * as fs from 'fs';

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
  --no-postgres            Skip automatic Postgres provisioning (requires DATABASE_URL env var)

Examples:
  rorca start
  rorca start --port 4040
  rorca start --no-open
  rorca start --no-postgres
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
// ensurePostgres: download, init, and start managed Postgres 16
// ────────────────────────────────────────────────────────────────

const POSTGRES_VERSION = '16.2.0';
const POSTGRES_PORT = 5433;
const POSTGRES_HOME = join(homedir(), '.rorca', 'postgres');
const POSTGRES_BIN = join(POSTGRES_HOME, 'bin');
const POSTGRES_DATA = join(POSTGRES_HOME, 'data');
const POSTGRES_VERSION_FILE = join(POSTGRES_HOME, '.version');
const MANAGED_DATABASE_URL = `postgres://rorca:rorca@localhost:${POSTGRES_PORT}/rorca`;

// Track whether we started postgres so shutdown handler knows to stop it
let managedPostgresStarted = false;

function detectPlatform(): string {
  const p = platform();
  const a = arch();

  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && (a === 'x64' || a === 'x32')) return 'darwin-amd64';
  if (p === 'linux' && a === 'x64') return 'linux-amd64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64v8';
  if (p === 'win32' && a === 'x64') return 'windows-amd64';

  throw new Error(
    `Unsupported platform: ${p}-${a}. Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.\n` +
    `Use --no-postgres with a DATABASE_URL pointing to your own Postgres instance.`
  );
}

function getDownloadUrl(platformId: string): string {
  // zonkyio/embedded-postgres-binaries releases — same source as Prisma
  const base = 'https://github.com/zonkyio/embedded-postgres-binaries/releases/download';
  const ext = platformId.startsWith('windows') ? '.zip' : '.txz';
  return `${base}/v${POSTGRES_VERSION}/postgres-${platformId}${ext}`;
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpPath = destPath + '.tmp';
    let bytesDownloaded = 0;
    let totalBytes = 0;
    let lastDataAt = Date.now();
    const TIMEOUT_MS = 60_000; // 60s no-data timeout

    // Cleanup temp on failure
    const cleanup = () => {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    };

    const doRequest = (requestUrl: string, redirectCount = 0): void => {
      if (redirectCount > 5) {
        cleanup();
        return reject(new Error('Too many redirects downloading Postgres'));
      }

      const request = https.get(requestUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const location = res.headers.location;
          if (!location) {
            cleanup();
            return reject(new Error('Redirect with no Location header'));
          }
          res.resume(); // drain
          doRequest(location, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          cleanup();
          return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${requestUrl}`));
        }

        totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        const fileStream = fs.createWriteStream(tmpPath);

        // No-data timeout detection
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastDataAt > TIMEOUT_MS) {
            clearInterval(timeoutCheck);
            fileStream.destroy();
            res.destroy();
            cleanup();
            reject(new Error('Postgres download timed out'));
          }
        }, 1000);

        res.on('data', (chunk: Buffer) => {
          bytesDownloaded += chunk.length;
          lastDataAt = Date.now();
          const mb = (bytesDownloaded / 1024 / 1024).toFixed(1);
          const total = totalBytes ? ` / ${(totalBytes / 1024 / 1024).toFixed(1)} MB` : '';
          process.stdout.write(`\rDownloading Postgres ${POSTGRES_VERSION}... ${mb} MB${total}   `);
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          clearInterval(timeoutCheck);
          fileStream.close();
          process.stdout.write('\n');
          // Rename temp → dest atomically
          try {
            fs.renameSync(tmpPath, destPath);
          } catch {
            cleanup();
            return reject(new Error('Failed to finalize Postgres archive download'));
          }
          resolve();
        });

        fileStream.on('error', (err) => {
          clearInterval(timeoutCheck);
          cleanup();
          reject(new Error(`Download write error: ${err.message}`));
        });

        res.on('error', (err) => {
          clearInterval(timeoutCheck);
          cleanup();
          reject(new Error(`Download network error: ${err.message}`));
        });
      });

      request.on('error', (err) => {
        cleanup();
        reject(new Error(`Download connection error: ${err.message}`));
      });

      request.setTimeout(30_000, () => {
        request.destroy();
        cleanup();
        reject(new Error('Postgres download timed out'));
      });
    };

    doRequest(url);
  });
}

function checkBinariesExist(): void {
  if (!existsSync(POSTGRES_BIN)) return; // bin dir doesn't exist at all — not corrupt, just not installed

  const requiredBins = ['postgres', 'initdb', 'pg_ctl'];
  const missing = requiredBins.filter(b => {
    const binPath = join(POSTGRES_BIN, b);
    const winPath = join(POSTGRES_BIN, b + '.exe');
    return !existsSync(binPath) && !existsSync(winPath);
  });

  if (missing.length > 0) {
    throw new Error(
      `Postgres install appears corrupt — delete ~/.rorca/postgres and retry\n` +
      `  Missing binaries: ${missing.join(', ')}\n` +
      `  Run: rm -rf ${POSTGRES_HOME}`
    );
  }
}

async function ensurePostgres(): Promise<void> {
  mkdirSync(POSTGRES_HOME, { recursive: true });

  // Step 1: Check if version already installed
  const alreadyInstalled =
    existsSync(POSTGRES_VERSION_FILE) &&
    readFileSync(POSTGRES_VERSION_FILE, 'utf8').trim() === POSTGRES_VERSION;

  if (alreadyInstalled) {
    // Validate binaries are not corrupt
    checkBinariesExist();
    console.log('Postgres 16 already installed');
  } else {
    // Step 2: Detect platform and download
    const platformId = detectPlatform();
    const downloadUrl = getDownloadUrl(platformId);
    const ext = platformId.startsWith('windows') ? '.zip' : '.txz';
    const archivePath = join(POSTGRES_HOME, `postgres-${platformId}${ext}`);

    console.log(`Downloading Postgres ${POSTGRES_VERSION} for ${platformId}...`);
    await downloadFile(downloadUrl, archivePath);

    // Step 3: Extract
    console.log('Extracting Postgres binaries...');
    mkdirSync(POSTGRES_BIN, { recursive: true });

    try {
      if (platformId.startsWith('windows')) {
        spawnSync('tar', ['-xzf', archivePath, '-C', POSTGRES_BIN], { stdio: 'inherit' });
      } else {
        // .txz = xz-compressed tar
        spawnSync('tar', ['-xJf', archivePath, '-C', POSTGRES_BIN, '--strip-components=1'], {
          stdio: 'inherit'
        });
      }
    } catch (err) {
      throw new Error(`Postgres extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Validate extraction succeeded
    checkBinariesExist();

    // Cleanup archive
    try { unlinkSync(archivePath); } catch { /* ignore */ }

    // Write version marker
    writeFileSync(POSTGRES_VERSION_FILE, POSTGRES_VERSION);
    console.log('Postgres binaries extracted');
  }

  // Step 4: initdb (only if data dir doesn't exist)
  if (!existsSync(POSTGRES_DATA)) {
    console.log('Initializing Postgres data directory...');
    const initdbBin = join(POSTGRES_BIN, platform() === 'win32' ? 'initdb.exe' : 'initdb');
    const result = spawnSync(initdbBin, [
      '-D', POSTGRES_DATA,
      '--no-locale',
      '--encoding=UTF8',
      `--username=rorca`
    ], { encoding: 'utf8' });

    if (result.status !== 0) {
      const stderr = result.stderr || '';
      if (stderr.includes('No space left on device') || stderr.includes('disk full')) {
        throw new Error('Disk full: not enough space to initialize Postgres data directory');
      }
      throw new Error(`initdb failed:\n${stderr}`);
    }
    console.log('Postgres data directory initialized');
  }

  // Step 5: Start postgres (if not already running)
  const alreadyRunning = await isPortOpen(POSTGRES_PORT);

  if (alreadyRunning) {
    console.log(`Postgres already running on ${POSTGRES_PORT}`);
  } else {
    console.log(`Starting Postgres on port ${POSTGRES_PORT}...`);
    const pgCtlBin = join(POSTGRES_BIN, platform() === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
    const logFile = join(POSTGRES_HOME, 'postgres.log');

    const startResult = spawnSync(pgCtlBin, [
      'start',
      '-D', POSTGRES_DATA,
      '-l', logFile,
      '-o', `-p ${POSTGRES_PORT} -k /tmp`
    ], { encoding: 'utf8' });

    if (startResult.status !== 0) {
      const stderr = (startResult.stderr || '') + (startResult.stdout || '');
      if (stderr.toLowerCase().includes('address already in use')) {
        throw new Error(
          `Port ${POSTGRES_PORT} is already in use by another process.\n` +
          `  Run: lsof -ti:${POSTGRES_PORT} | xargs kill -9`
        );
      }
      throw new Error(`pg_ctl start failed:\n${stderr}`);
    }

    // Poll until ready (max 30s)
    const startTime = Date.now();
    let ready = false;
    while (Date.now() - startTime < 30_000) {
      if (await isPortOpen(POSTGRES_PORT)) {
        ready = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!ready) {
      throw new Error('Postgres failed to start within 30s');
    }

    managedPostgresStarted = true;
    console.log(`Postgres started on port ${POSTGRES_PORT}`);
  }

  // Step 6: Create user and database (idempotent)
  const createuserBin = join(POSTGRES_BIN, platform() === 'win32' ? 'createuser.exe' : 'createuser');
  const createdbBin = join(POSTGRES_BIN, platform() === 'win32' ? 'createdb.exe' : 'createdb');

  const userResult = spawnSync(createuserBin, [
    '-h', 'localhost', '-p', String(POSTGRES_PORT), '-s', 'rorca'
  ], { encoding: 'utf8' });

  if (userResult.status !== 0) {
    const stderr = userResult.stderr || '';
    if (!stderr.includes('already exists')) {
      throw new Error(`createuser failed:\n${stderr}`);
    }
  }

  const dbResult = spawnSync(createdbBin, [
    '-h', 'localhost', '-p', String(POSTGRES_PORT), '-O', 'rorca', 'rorca'
  ], { encoding: 'utf8' });

  if (dbResult.status !== 0) {
    const stderr = dbResult.stderr || '';
    if (!stderr.includes('already exists')) {
      throw new Error(`createdb failed:\n${stderr}`);
    }
  }

  // Step 7: Set DATABASE_URL
  process.env.DATABASE_URL = MANAGED_DATABASE_URL;
  console.log(`Postgres ready: ${MANAGED_DATABASE_URL}`);
}

function stopManagedPostgres(): void {
  if (!managedPostgresStarted) return;
  try {
    const pgCtlBin = join(POSTGRES_BIN, platform() === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
    console.log('\nStopping managed Postgres...');
    spawnSync(pgCtlBin, ['stop', '-D', POSTGRES_DATA, '-m', 'fast'], {
      encoding: 'utf8',
      timeout: 10_000
    });
    console.log('Postgres stopped.');
  } catch {
    // Best-effort — don't throw on shutdown
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
  const noPostgres = startArgs.includes('--no-postgres');

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
  if (noPostgres) {
    // --no-postgres: user must provide DATABASE_URL
    if (!process.env.DATABASE_URL) {
      console.error('DATABASE_URL required when --no-postgres is set');
      process.exit(1);
    }
    console.log(`Using provided DATABASE_URL`);
  } else if (process.env.DATABASE_URL) {
    // DATABASE_URL is set — check if it's reachable; if yes, skip ensurePostgres
    let reachable = false;
    try {
      const { Pool: PgPool } = await import('pg');
      const testPool = new PgPool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000
      });
      await testPool.query('SELECT 1');
      await testPool.end();
      reachable = true;
    } catch {
      reachable = false;
    }

    if (reachable) {
      console.log('Using existing DATABASE_URL');
    } else {
      // DATABASE_URL set but unreachable — fall through to ensurePostgres
      console.log('DATABASE_URL set but Postgres unreachable — provisioning managed Postgres...');
      try {
        await ensurePostgres();
      } catch (err) {
        console.error('Failed to provision Postgres:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
  } else {
    // No DATABASE_URL — provision managed Postgres
    try {
      await ensurePostgres();
    } catch (err) {
      console.error('Failed to provision Postgres:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const databaseUrl = process.env.DATABASE_URL!;

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
    process.exit(1);
    return; // unreachable — satisfies TypeScript
  }

  console.log(`Rorca running at http://localhost:${portNum}`);

  child.on('error', (err: Error) => {
    console.error('Failed to start server:', err.message);
    stopManagedPostgres();
    process.exit(1);
  });

  child.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.error(`Server exited with code ${code}`);
    }
    stopManagedPostgres();
    process.exit(code ?? 1);
  });

  // Open browser after short delay to let server bind
  if (!noOpen) {
    setTimeout(() => {
      const url = `http://localhost:${portNum}`;
      openBrowser(url);
    }, 1500);
  }

  // Forward signals for clean shutdown — stop managed Postgres before exit
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      child.kill(sig);
      stopManagedPostgres();
      process.exit(0);
    });
  }
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
