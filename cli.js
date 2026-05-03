#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

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
  rorca --version          Print version

Options:
  --port <port>             Server port (default: 3030)
  --no-open                 Don't open browser on start

Examples:
  rorca start
  rorca start --port 4040
  rorca start --no-open
`);
  process.exit(0);
}

const command = args[0];

if (command !== 'start') {
  console.error(`Unknown command: ${command}\nRun "rorca --help" for usage.`);
  process.exit(1);
}

// ─── Parse start options ───
const portIdx = args.indexOf('--port');
const port = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : '3030';
const noOpen = args.includes('--no-open');

// Validate port
const portNum = parseInt(port, 10);
if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
  console.error(`Invalid port: ${port}`);
  process.exit(1);
}

// ─── Ensure ~/.rorca/ exists ───
const rorchHome = join(homedir(), '.rorca');
if (!existsSync(rorchHome)) {
  mkdirSync(rorchHome, { recursive: true });
  console.log(`Created config directory: ${rorchHome}`);
}

// ─── Check Postgres reachability ───
const databaseUrl = process.env.DATABASE_URL || 'postgres://rorca:rorca@localhost:5432/rorca';

// ─── Auto-build frontend if dist/ is missing ───
const distDir = join(__dirname, 'dist');
if (!existsSync(join(distDir, 'index.html'))) {
  console.log('Frontend not built yet — building...');
  try {
    execSync('npm run build', { cwd: __dirname, stdio: 'inherit' });
  } catch {
    console.error('Build failed. Please run "npm run build" manually and try again.');
    process.exit(1);
  }
}

await runStart();

async function runStart() {
  console.log(`Starting Rorca on port ${portNum}...`);
  console.log(`Database: ${databaseUrl.replace(/\/\/[^@]*@/, '//***@')}`);

  const backendDir = join(__dirname, 'backend');
  const apiEntry = join(backendDir, 'dist', 'server.js');
  const workerEntry = join(backendDir, 'dist', 'worker.js');
  const supervisorEntry = join(backendDir, 'dist', 'lib', 'supervisor.js');

  if (!existsSync(apiEntry) || !existsSync(workerEntry) || !existsSync(supervisorEntry)) {
    console.error('Compiled backend entry points are missing. Run "npm run build" first.');
    process.exit(1);
  }

  const env = {
    ...process.env,
    PORT: String(portNum),
    DATABASE_URL: databaseUrl,
    RORCA_SERVE_STATIC: '1',
    RORCA_STATIC_DIR: distDir,
    RORCA_HOME: rorchHome,
    NODE_ENV: process.env.NODE_ENV || 'production',
  };

  const { Supervisor } = require(supervisorEntry);
  const supervisor = new Supervisor({
    api: {
      cmd: process.execPath,
      args: [apiEntry],
      env: { ...env, RORCA_PROCESS_ROLE: 'api' },
      cwd: backendDir,
    },
    worker: {
      cmd: process.execPath,
      args: [workerEntry],
      env: { ...env, RORCA_PROCESS_ROLE: 'worker' },
      cwd: backendDir,
    },
    apiHealthUrl: `http://localhost:${portNum}/api/health`,
    healthTimeoutMs: 10_000,
  });

  try {
    await supervisor.start();
  } catch (err) {
    console.error(`Failed to start Rorca: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!noOpen) {
    setTimeout(() => {
      const url = `http://localhost:${portNum}`;
      console.log(`Opening ${url} in your browser...`);
      openBrowser(url);
    }, 1500);
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await supervisor.stop();
      process.exit(0);
    });
  }
}

function openBrowser(url) {
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
