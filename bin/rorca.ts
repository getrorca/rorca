#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync, writeFileSync, createWriteStream, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, fork, spawn } from 'child_process';
import { homedir, platform, arch } from 'os';
import { get as httpsGet } from 'https';
import { get as httpGet, type IncomingMessage } from 'http';

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

  // Ensure Postgres binaries are available
  await ensurePostgres();

  const databaseUrl = process.env.DATABASE_URL || 'postgres://rorca:rorca@localhost:5432/rorca';

  // Check Postgres reachability before starting
  try {
    const { Pool: PgPool } = await import('pg');
    const testPool = new PgPool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await testPool.query('SELECT 1');
    await testPool.end();
  } catch {
    console.error('Cannot connect to PostgreSQL. Run: docker compose up -d db');
    console.error(`  DATABASE_URL: ${databaseUrl.replace(/\/\/[^@]*@/, '//***@')}`);
    process.exit(1);
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
    process.exit(1);
    return; // unreachable — satisfies TypeScript
  }

  console.log(`Rorca running at http://localhost:${portNum}`);

  child.on('error', (err: Error) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

  child.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.error(`Server exited with code ${code}`);
    }
    process.exit(code ?? 1);
  });

  // Open browser after short delay to let server bind
  if (!noOpen) {
    setTimeout(() => {
      const url = `http://localhost:${portNum}`;
      openBrowser(url);
    }, 1500);
  }

  // Forward signals for clean shutdown
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      child.kill(sig);
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

/**
 * Ensure Postgres binaries are installed at ~/.rorca/postgres/.
 * Downloads from Maven Central if not already present at the correct version.
 */
async function ensurePostgres(): Promise<string> {
  const pgDir = join(homedir(), '.rorca', 'postgres');
  const versionFile = join(pgDir, '.version');

  // Skip if already installed at correct version
  if (existsSync(versionFile)) {
    const installed = readFileSync(versionFile, 'utf8').trim();
    if (installed === PG_VERSION) {
      console.log(`Postgres ${PG_VERSION} already installed`);
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
    console.log('  Extracting archive...');
    if (platform() === 'win32') {
      execSync(`tar -xf "${jarPath}" -C "${extractDir}"`, { stdio: 'pipe' });
    } else {
      execSync(`unzip -o -q "${jarPath}" -d "${extractDir}"`, { stdio: 'pipe' });
    }

    // Find the .txz inside
    const extractedFiles = execSync(`ls "${extractDir}"`, { encoding: 'utf8' }).trim().split('\n');
    const txzFile = extractedFiles.find(f => f.endsWith('.txz'));
    if (!txzFile) {
      throw new Error('No .txz archive found inside downloaded jar');
    }

    // Extract the .txz into the postgres directory
    const txzPath = join(extractDir, txzFile);
    execSync(`tar xJf "${txzPath}" -C "${pgDir}"`, { stdio: 'pipe' });

    // Write version marker
    writeFileSync(versionFile, PG_VERSION);
    console.log(`  Postgres ${PG_VERSION} installed to ${pgDir}`);

    return pgDir;
  } finally {
    // Cleanup temp files
    try { unlinkSync(jarPath); } catch { /* ignore */ }
    try { rmSync(extractDir, { recursive: true }); } catch { /* ignore */ }
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
