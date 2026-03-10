#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, fork, spawn } from 'child_process';
import { homedir } from 'os';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
}
else {
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
    const databaseUrl = process.env.DATABASE_URL || 'postgres://rorca:rorca@localhost:5432/rorca';
    // Check Postgres reachability before starting
    try {
        const { Pool: PgPool } = await import('pg');
        const testPool = new PgPool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
        await testPool.query('SELECT 1');
        await testPool.end();
    }
    catch {
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
    const backendTsEntry = join(backendDir, 'src', 'server.ts');
    let child;
    if (existsSync(backendEntry)) {
        // Production: compiled JS
        child = fork(backendEntry, [], { env, cwd: backendDir, stdio: 'inherit' });
    }
    else if (existsSync(backendTsEntry)) {
        // Development: run TypeScript source via tsx
        child = spawn('npx', ['tsx', backendTsEntry], {
            env,
            cwd: backendDir,
            stdio: 'inherit',
            shell: true,
        });
    }
    else {
        console.error('Could not find backend entry point. Run "npm run build" first.');
        process.exit(1);
        return; // unreachable — satisfies TypeScript
    }
    console.log(`Rorca running at http://localhost:${portNum}`);
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
    // Open browser after short delay to let server bind
    if (!noOpen) {
        setTimeout(() => {
            const url = `http://localhost:${portNum}`;
            openBrowser(url);
        }, 1500);
    }
    // Forward signals for clean shutdown
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            child.kill(sig);
        });
    }
}
// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
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
