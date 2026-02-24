#!/usr/bin/env node

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, fork, spawn } from 'child_process';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

// ─── --version / --help ───
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
rorcha v${pkg.version} — AI spec orchestration pipeline

Usage:
  rorcha start [options]    Start the Rorcha server
  rorcha --version          Print version

Options:
  --port <port>             Server port (default: 3030)
  --no-open                 Don't open browser on start

Examples:
  rorcha start
  rorcha start --port 4040
  rorcha start --no-open
`);
  process.exit(0);
}

const command = args[0];

if (command !== 'start') {
  console.error(`Unknown command: ${command}\nRun "rorcha --help" for usage.`);
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

// ─── Ensure ~/.rorcha/ exists ───
const rorchHome = join(homedir(), '.rorcha');
if (!existsSync(rorchHome)) {
  mkdirSync(rorchHome, { recursive: true });
  console.log(`Created config directory: ${rorchHome}`);
}

const dbPath = join(rorchHome, 'rorcha.db');

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

// ─── Start the server ───
console.log(`Starting Rorcha on port ${portNum}...`);
console.log(`Database: ${dbPath}`);

const env = {
  ...process.env,
  PORT: String(portNum),
  DB_PATH: dbPath,
  RORCHA_SERVE_STATIC: '1',
  RORCHA_STATIC_DIR: distDir,
  RORCHA_HOME: rorchHome,
  NODE_ENV: process.env.NODE_ENV || 'production',
};

const backendDir = join(__dirname, 'backend');
const backendEntry = join(backendDir, 'dist', 'server.js');
const backendTsEntry = join(backendDir, 'src', 'server.ts');

let child;
if (existsSync(backendEntry)) {
  // Production: run compiled JS via fork (Node.js child process)
  child = fork(backendEntry, [], { env, cwd: backendDir, stdio: 'inherit' });
} else if (existsSync(backendTsEntry)) {
  // Development: use tsx to run TypeScript source directly
  child = spawn('npx', ['tsx', backendTsEntry], {
    env,
    cwd: backendDir,
    stdio: 'inherit',
    shell: true,
  });
} else {
  console.error('Could not find backend entry point. Run "npm run build" first.');
  process.exit(1);
}

child.on('error', (err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`Server exited with code ${code}`);
  }
  process.exit(code ?? 1);
});

// Open browser after a short delay to let server start
if (!noOpen) {
  setTimeout(() => {
    const url = `http://localhost:${portNum}`;
    console.log(`Opening ${url} in your browser...`);
    openBrowser(url);
  }, 1500);
}

// Forward signals for clean shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill(sig);
  });
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
