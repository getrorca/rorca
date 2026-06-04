#!/usr/bin/env node
import { Command } from 'commander';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import readline from 'node:readline/promises';
import { execa } from 'execa';
import { ensureMcpToken, getMcpAdminToken, getMcpAdminTokenPath, getMcpPublicToken, getMcpPublicTokenPath, rotateMcpToken, } from '../backend/src/lib/mcp-auth';
import { detectDbMode, getDbConnectionString, isAgeAvailable, setDbMode } from '../backend/src/lib/db-strategy';
import { dbStart, dbStatus } from '../backend/src/lib/db-sidecar';
import { MIN_PI_VERSION, detectPi as detectPiShared } from '../backend/src/lib/pi-detector';
import { checkDuplicatePrefixes } from '../backend/src/db/pg-index';
import { checkVersion as checkVersionShared, MIN_BACKEND_VERSION as SHARED_MIN_BACKEND_VERSION } from '../packages/rorca-cli/src/version-check';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const API_BASE = (process.env.RORCA_API_URL || 'http://127.0.0.1:3030').replace(/\/$/, '');
const DB_CONTAINER = 'rorca-db';
const DB_VOLUME = 'rorca-db-data';
const DB_IMAGE = 'apache/age:latest';
const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const PI_INSTALL_METHODS = {
    npm: 'npm install -g @mariozechner/pi-coding-agent',
    pnpm: 'pnpm add -g @mariozechner/pi-coding-agent',
    bun: 'bun add -g @mariozechner/pi-coding-agent',
    curl: 'curl -fsSL https://pi.mariozechner.com/install.sh | sh',
};
const PI_INSTALL_SCRIPT_URL = 'https://pi.mariozechner.com/install.sh';
const PI_PROVIDER_LABELS = {
    openai: 'ChatGPT Plus/Pro',
    chatgpt: 'ChatGPT Plus/Pro',
    codex: 'ChatGPT Plus/Pro',
    anthropic: 'Claude',
    claude: 'Claude',
    github: 'GitHub',
    google: 'Gemini',
    gemini: 'Gemini',
    openrouter: 'OpenRouter',
};
const PI_PROVIDER_ORDER = [
    'ChatGPT Plus/Pro',
    'Claude',
    'GitHub',
    'Gemini',
    'OpenRouter',
];
const MIN_BACKEND_VERSION = SHARED_MIN_BACKEND_VERSION;
const MIN_BACKEND_API_VERSION = '1.0';
const MIN_NODE_VERSION = '20.0.0';
const NATIVE_PG_PORT = 5433;
const BACKEND_DEPENDENT_CHECKS = [
    'backend-version',
    'schema-migrations',
    'worker-heartbeat',
    'mcp-bridge',
];
function red(text) {
    return `\x1b[31m${text}\x1b[0m`;
}
function green(text) {
    return `\x1b[32m${text}\x1b[0m`;
}
function yellow(text) {
    return `\x1b[33m${text}\x1b[0m`;
}
function cyan(text) {
    return `\x1b[36m${text}\x1b[0m`;
}
function dim(text) {
    return `\x1b[2m${text}\x1b[0m`;
}
function bold(text) {
    return `\x1b[1m${text}\x1b[0m`;
}
class PrintedCliError extends Error {
    constructor() {
        super('printed-cli-error');
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatSpecFromPath(specPath) {
    return path.basename(specPath, '.json');
}
function formatDate(iso) {
    if (!iso)
        return '-';
    return new Date(iso).toLocaleString('en-US', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}
function printTable(headers, rows) {
    const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] || '').length)));
    const render = (cells) => cells.map((cell, index) => (cell || '').padEnd(widths[index])).join('  ');
    console.log(render(headers.map((header) => bold(header))));
    console.log(render(widths.map((width) => '-'.repeat(width))));
    for (const row of rows) {
        console.log(render(row));
    }
}
function spawnLogged(label, command, args, options) {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
    });
    const prefix = `[${label}] `;
    const pipe = (stream, target) => {
        if (!stream)
            return;
        let buffer = '';
        stream.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                target.write(`${prefix}${line}\n`);
            }
        });
        stream.on('end', () => {
            if (buffer.length > 0) {
                target.write(`${prefix}${buffer}\n`);
            }
        });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    return child;
}
function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });
        let stdout = '';
        let stderr = '';
        if (options.stdio !== 'inherit') {
            child.stdout?.on('data', (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
            });
        }
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
        });
    });
}
async function docker(args, stdio = 'pipe') {
    return runCommand('docker', args, { stdio });
}
async function requireDocker() {
    const result = await docker(['info']);
    if (result.code !== 0) {
        throw new Error('Docker is required. Start Docker Desktop or OrbStack first.');
    }
}
async function inspectDbContainer() {
    const result = await docker(['inspect', DB_CONTAINER, '--format', '{{.State.Running}}']);
    if (result.code !== 0) {
        return { exists: false, running: false };
    }
    return { exists: true, running: result.stdout === 'true' };
}
async function waitForDatabaseReady() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await docker(['exec', DB_CONTAINER, 'pg_isready', '-U', 'rorca', '-d', 'rorca']);
        if (result.code === 0) {
            return;
        }
        await sleep(1000);
    }
    throw new Error('Database container did not become ready within 30s.');
}
async function enableDbExtensions() {
    const result = await docker([
        'exec',
        DB_CONTAINER,
        'psql',
        '-U',
        'rorca',
        '-d',
        'rorca',
        '-c',
        'CREATE EXTENSION IF NOT EXISTS age; CREATE EXTENSION IF NOT EXISTS vector;',
    ]);
    if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || 'Failed to enable AGE/vector extensions.');
    }
}
async function handleDbCommand(action, options = {}) {
    if (action === 'start') {
        await requireDocker();
        const state = await inspectDbContainer();
        if (!state.exists) {
            if (!options.quiet)
                console.log('Starting Docker Postgres sidecar...');
            const result = await docker([
                'run',
                '-d',
                '--name',
                DB_CONTAINER,
                '-p',
                '5432:5432',
                '-v',
                `${DB_VOLUME}:/var/lib/postgresql/data`,
                '-e',
                'POSTGRES_DB=rorca',
                '-e',
                'POSTGRES_USER=rorca',
                '-e',
                'POSTGRES_PASSWORD=rorca',
                DB_IMAGE,
            ]);
            if (result.code !== 0) {
                throw new Error(result.stderr || result.stdout || 'Failed to start database container.');
            }
        }
        else if (!state.running) {
            if (!options.quiet)
                console.log('Starting existing database container...');
            const result = await docker(['start', DB_CONTAINER]);
            if (result.code !== 0) {
                throw new Error(result.stderr || result.stdout || 'Failed to start existing database container.');
            }
        }
        else if (!options.quiet) {
            console.log('Database container already running.');
        }
        await waitForDatabaseReady();
        await enableDbExtensions();
        setDbMode('docker');
        process.env.DATABASE_URL = getDbConnectionString('docker');
        if (!options.quiet) {
            console.log(green('Database ready at postgres://rorca:rorca@127.0.0.1:5432/rorca'));
        }
        return;
    }
    if (action === 'stop') {
        const result = await docker(['stop', DB_CONTAINER], 'inherit');
        if (result.code !== 0) {
            throw new Error('Failed to stop database container.');
        }
        return;
    }
    if (action === 'status') {
        const state = await inspectDbContainer();
        if (!state.exists) {
            console.log('Database container: not created');
            return;
        }
        console.log(`Database container: ${state.running ? green('running') : yellow('stopped')}`);
        if (state.running) {
            const ageResult = await docker([
                'exec',
                DB_CONTAINER,
                'psql',
                '-U',
                'rorca',
                '-d',
                'rorca',
                '-tAc',
                "SELECT 1 FROM pg_extension WHERE extname = 'age'",
            ]);
            console.log(`AGE extension: ${ageResult.code === 0 && ageResult.stdout === '1' ? green('enabled') : yellow('disabled')}`);
        }
        return;
    }
    if (action === 'reset') {
        if (!options.yes) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question('Reset Docker Postgres and delete all data? [y/N] ');
            rl.close();
            if (answer.trim().toLowerCase() !== 'y') {
                console.log('Reset cancelled.');
                return;
            }
        }
        await docker(['rm', '-f', DB_CONTAINER], 'pipe');
        await docker(['volume', 'rm', DB_VOLUME], 'pipe');
        await handleDbCommand('start');
        return;
    }
    const tail = options.tail ?? 100;
    const result = await docker(['logs', '--tail', String(tail), '--follow', DB_CONTAINER], 'inherit');
    if (result.code !== 0) {
        throw new Error('Failed to stream database logs.');
    }
}
function parseSemver(input) {
    const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match)
        return null;
    return [
        Number.parseInt(match[1], 10),
        Number.parseInt(match[2], 10),
        Number.parseInt(match[3], 10),
    ];
}
function semverGte(left, right) {
    const a = parseSemver(left);
    const b = parseSemver(right);
    if (!a || !b)
        return left === right;
    for (let index = 0; index < 3; index += 1) {
        if (a[index] > b[index])
            return true;
        if (a[index] < b[index])
            return false;
    }
    return true;
}
async function checkVersion(backendUrl) {
    const baseUrl = backendUrl.replace(/\/$/, '');
    try {
        const response = await fetch(`${baseUrl}/api/version`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
            return { ok: false, reason: `Backend health check failed (${response.status})` };
        }
        const backend = await response.json();
        if (!semverGte(backend.version, MIN_BACKEND_VERSION)) {
            return {
                ok: false,
                reason: `Backend ${backend.version} < required ${MIN_BACKEND_VERSION}`,
                backend,
            };
        }
        if (backend.apiVersion !== MIN_BACKEND_API_VERSION) {
            return {
                ok: false,
                reason: `API version ${backend.apiVersion} != ${MIN_BACKEND_API_VERSION}`,
                backend,
            };
        }
        if (!semverGte(pkg.version, backend.minCliVersion)) {
            return {
                ok: false,
                reason: `CLI ${pkg.version} < backend minimum ${backend.minCliVersion}`,
                backend,
            };
        }
        return { ok: true, backend };
    }
    catch {
        return { ok: false, reason: `Cannot reach backend at ${baseUrl}` };
    }
}
function printVersionMismatch(result) {
    const backendVersion = result.backend?.version ?? 'unknown';
    let requirement = `need >= ${MIN_BACKEND_VERSION}`;
    if (result.backend && result.backend.apiVersion !== MIN_BACKEND_API_VERSION) {
        requirement = `API ${result.backend.apiVersion}, need ${MIN_BACKEND_API_VERSION}`;
    }
    else if (result.backend && !semverGte(pkg.version, result.backend.minCliVersion)) {
        requirement = `requires CLI >= ${result.backend.minCliVersion}`;
    }
    console.error(`${red('✗')} Version mismatch:`);
    console.error(`   CLI:     ${pkg.version}`);
    console.error(`   Backend: ${backendVersion} (${requirement})`);
    console.error('');
    console.error('Upgrade:  npm install -g rorca@latest');
    console.error(`Downgrade: npm install -g rorca@${backendVersion}`);
}
function printBackendUnavailable(reason) {
    console.error(`${red('✗')} ${reason}`);
    console.error('Hint: run `rorca start`');
}
let versionCheckPromise = null;
async function ensureBackendVersionCompatible() {
    if (!versionCheckPromise) {
        versionCheckPromise = checkVersion(API_BASE);
    }
    const result = await versionCheckPromise;
    if (result.ok)
        return;
    if (result.reason?.startsWith('Cannot reach backend at ')) {
        printBackendUnavailable(result.reason);
        throw new PrintedCliError();
    }
    printVersionMismatch(result);
    throw new PrintedCliError();
}
async function fetchJson(pathname, init, timeoutMs = 30_000, options) {
    if (!options?.skipVersionCheck && pathname !== '/api/version') {
        await ensureBackendVersionCompatible();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${API_BASE}${pathname}`, {
            ...init,
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
                ...(init?.headers ?? {}),
            },
        });
        if (!response.ok) {
            const text = await response.text();
            let message = text || `HTTP ${response.status}`;
            try {
                const parsed = JSON.parse(text);
                message = parsed.error || message;
            }
            catch {
                // Keep raw text message.
            }
            throw new Error(message);
        }
        return (await response.json());
    }
    finally {
        clearTimeout(timeout);
    }
}
function parseWalPayload(event) {
    if (!event.payload)
        return {};
    try {
        return JSON.parse(event.payload);
    }
    catch {
        return {};
    }
}
async function readSse(pathname, onEvent, signal) {
    const response = await fetch(`${API_BASE}${pathname}`, {
        headers: { Accept: 'text/event-stream' },
        signal,
    });
    if (!response.ok || !response.body) {
        throw new Error(`Failed to open SSE stream: ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            if (!block || block.startsWith(':')) {
                continue;
            }
            const lines = block.split('\n');
            let eventName = 'message';
            const dataLines = [];
            for (const line of lines) {
                if (line.startsWith('event:')) {
                    eventName = line.slice(6).trim();
                }
                else if (line.startsWith('data:')) {
                    dataLines.push(line.slice(5).trimStart());
                }
            }
            await onEvent(eventName, dataLines.join('\n'));
        }
    }
}
async function getWorkspaces() {
    const response = await fetchJson('/api/workspaces');
    return response.items;
}
async function getDefaultWorkspace() {
    const workspaces = await getWorkspaces();
    if (workspaces.length === 0) {
        throw new Error('No workspaces registered. Add one in the UI first.');
    }
    return workspaces[0];
}
async function getWorkspaceById(workspaceId) {
    const workspaces = await getWorkspaces();
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
        throw new Error(`Workspace "${workspaceId}" not found.`);
    }
    return workspace;
}
function isBackendUnavailableError(error) {
    if (!(error instanceof Error))
        return false;
    const message = error.message.toLowerCase();
    return (message.includes('fetch failed')
        || message.includes('networkerror')
        || message.includes('econnrefused')
        || message.includes('enotfound')
        || message.includes('failed to fetch')
        || message.includes('this operation was aborted'));
}
function cleanupTempFile(filePath) {
    if (!filePath)
        return;
    try {
        unlinkSync(filePath);
    }
    catch {
        // Best-effort cleanup for temp context files.
    }
}
function resolvePiBinPathLocal() {
    const envBin = process.env.PI_BIN?.trim();
    if (envBin)
        return envBin;
    const whichCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(whichCommand, ['pi'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0)
        return null;
    const output = result.stdout.trim().split(/\r?\n/).find(Boolean);
    return output || null;
}
function resolvePiBinPath(preferred) {
    return preferred || resolvePiBinPathLocal() || 'pi';
}
function parsePiVersion(output) {
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
}
function detectPi() {
    const binPath = resolvePiBinPathLocal();
    if (!binPath) {
        return { piInstalled: false, piVersion: null, piBinPath: null };
    }
    const result = spawnSync(binPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
        return { piInstalled: false, piVersion: null, piBinPath: null };
    }
    return {
        piInstalled: true,
        piVersion: parsePiVersion(result.stdout),
        piBinPath: binPath,
    };
}
function resolveClaudeBinPathLocal() {
    const envBin = process.env.CLAUDE_BIN?.trim();
    if (envBin)
        return envBin;
    const whichCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(whichCommand, ['claude'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0)
        return null;
    const output = result.stdout.trim().split(/\r?\n/).find(Boolean);
    return output || null;
}
function checkMcpTokenFile(tokenPath) {
    if (!existsSync(tokenPath)) {
        return { exists: false, modeOk: false, mode: null };
    }
    if (process.platform === 'win32') {
        return { exists: true, modeOk: true, mode: null };
    }
    const mode = (statSync(tokenPath).mode & 0o777).toString(8).padStart(3, '0');
    return { exists: true, modeOk: mode === '600', mode };
}
function hasInteractiveTty() {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}
function detectPreferredPiInstallMethod() {
    const userAgent = process.env.npm_config_user_agent?.toLowerCase() ?? '';
    if (userAgent.startsWith('bun/'))
        return 'bun';
    if (userAgent.startsWith('pnpm/'))
        return 'pnpm';
    return 'npm';
}
function getShellRcPath() {
    const shell = process.env.SHELL ?? '';
    if (shell.includes('fish'))
        return '~/.config/fish/config.fish';
    if (shell.includes('bash'))
        return '~/.bashrc';
    return '~/.zshrc';
}
function printPiPathTroubleshooting() {
    const shellRcPath = getShellRcPath();
    console.error(red('✗ Pi installation completed but binary not on PATH.'));
    console.error('');
    console.error("This usually means npm's global bin directory is not in your PATH.");
    console.error('Try:');
    console.error('  npm config get prefix');
    if (shellRcPath.endsWith('config.fish')) {
        console.error(`  echo 'fish_add_path \"<prefix>/bin\"' >> ${shellRcPath}`);
    }
    else {
        console.error(`  echo 'export PATH=\"<prefix>/bin:$PATH\"' >> ${shellRcPath}`);
    }
    console.error(`  source ${shellRcPath}`);
}
function printPiMissingInstructions(extra) {
    console.error('Pi binary not found.');
    console.error('');
    console.error('Rorca uses pi (https://github.com/mariozechner/pi) as its execution engine.');
    console.error('');
    printPiInstallMethods();
    if (extra?.includeAutoInstallHint) {
        console.error('');
        console.error('Non-interactive shell detected. Re-run with --auto-install-pi to install automatically.');
    }
}
function splitInstallCommand(command) {
    if (command === PI_INSTALL_METHODS.npm) {
        return { cmd: 'npm', args: ['install', '-g', '@mariozechner/pi-coding-agent'] };
    }
    if (command === PI_INSTALL_METHODS.pnpm) {
        return { cmd: 'pnpm', args: ['add', '-g', '@mariozechner/pi-coding-agent'] };
    }
    if (command === PI_INSTALL_METHODS.bun) {
        return { cmd: 'bun', args: ['add', '-g', '@mariozechner/pi-coding-agent'] };
    }
    if (command === PI_INSTALL_METHODS.curl) {
        return { cmd: 'sh', args: ['-c', command] };
    }
    throw new Error(`Unsupported pi install command: ${command}`);
}
async function promptForPiInstallMethod() {
    const defaultMethod = detectPreferredPiInstallMethod();
    const defaultChoice = defaultMethod === 'npm' ? '1' : defaultMethod === 'pnpm' ? '2' : '3';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log('Pi binary not found.');
        console.log('');
        console.log('Rorca uses pi (https://github.com/mariozechner/pi) as its execution engine.');
        console.log('');
        console.log('Install pi now?');
        console.log(`  [1] ${PI_INSTALL_METHODS.npm}${defaultChoice === '1' ? ' (default)' : ''}`);
        console.log(`  [2] ${PI_INSTALL_METHODS.pnpm}${defaultChoice === '2' ? ' (default)' : ''}`);
        console.log(`  [3] ${PI_INSTALL_METHODS.bun}${defaultChoice === '3' ? ' (default)' : ''}`);
        console.log(`  [4] ${PI_INSTALL_METHODS.curl}`);
        console.log("  [5] Skip — I'll install it manually");
        console.log('');
        const rawChoice = await rl.question(`Choice [1-5] (default ${defaultChoice}): `);
        const choice = rawChoice.trim() || defaultChoice;
        if (choice === '1')
            return 'npm';
        if (choice === '2')
            return 'pnpm';
        if (choice === '3')
            return 'bun';
        if (choice === '4')
            return 'curl';
        if (choice === '5')
            return 'skip';
        console.log(yellow(`Unrecognized choice "${choice}". Using default option ${defaultChoice}.`));
        return defaultMethod;
    }
    finally {
        rl.close();
    }
}
async function confirmCurlInstall() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log(PI_INSTALL_SCRIPT_URL);
        const answer = await rl.question(`Run curl install script from pi.mariozechner.com? [y/N]: `);
        return answer.trim().toLowerCase() === 'y';
    }
    finally {
        rl.close();
    }
}
async function executePiInstall(method) {
    const command = PI_INSTALL_METHODS[method];
    const { cmd, args } = splitInstallCommand(command);
    if (method === 'curl') {
        const confirmed = await confirmCurlInstall();
        if (!confirmed) {
            console.log(yellow(`Skipped pi install. Runs will fail until pi is installed: ${PI_INSTALL_SCRIPT_URL}`));
            return { ok: true, skipped: true };
        }
    }
    try {
        await execa(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    }
    catch (error) {
        const timestamp = new Date().toISOString();
        const exitCode = typeof error === 'object' && error !== null && 'exitCode' in error
            ? String(error.exitCode ?? 'unknown')
            : 'unknown';
        const shortMessage = error instanceof Error
            ? error.message.split('\n')[0]
            : 'Unknown error';
        console.error(red(`Pi installation failed: ${shortMessage}. See output above.`));
        console.error(dim(`[debug ${timestamp}] command="${cmd} ${args.join(' ')}" exitCode=${exitCode}`));
        return { ok: false };
    }
    const status = detectPi();
    if (!status.piInstalled) {
        printPiPathTroubleshooting();
        return { ok: false };
    }
    return { ok: true };
}
async function ensurePiInstalled(options) {
    const status = detectPi();
    if (status.piInstalled) {
        return { ok: true };
    }
    if (options?.autoInstall) {
        return executePiInstall('npm');
    }
    if (!hasInteractiveTty()) {
        printPiMissingInstructions({ includeAutoInstallHint: true });
        return { ok: false };
    }
    const method = await promptForPiInstallMethod();
    if (method === 'skip') {
        console.log(yellow(`Runs will fail until pi is installed: ${PI_INSTALL_SCRIPT_URL}`));
        return { ok: true, skipped: true };
    }
    return executePiInstall(method);
}
function buildRorcaPiMcpExtension(mcpUrl) {
    const escapedUrl = JSON.stringify(mcpUrl);
    return `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

const MCP_URL = process.env.RORCA_PI_MCP_URL || ${escapedUrl};
const MCP_TOKEN = process.env.RORCA_PI_MCP_TOKEN || "";
const PROTOCOL_VERSION = "2024-11-05";
let requestId = 0;

function nextId(): number {
  requestId += 1;
  return requestId;
}

async function mcpPost(method: string, params: Record<string, unknown>, sessionId?: string, signal?: AbortSignal) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(MCP_TOKEN ? { "Authorization": \`Bearer \${MCP_TOKEN}\` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId(),
      method,
      params,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(\`\${method} failed (\${response.status}): \${body}\`);
  }

  const payload = await response.json() as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };

  if (payload.error?.message) {
    throw new Error(payload.error.message);
  }

  return {
    sessionId: response.headers.get("mcp-session-id") || sessionId || "",
    result: payload.result || {},
  };
}

async function initializeBridge(signal?: AbortSignal): Promise<{ sessionId: string; tools: McpTool[] }> {
  const init = await mcpPost("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: "rorca-pi-bridge",
      version: "0.1.0",
    },
  }, undefined, signal);

  if (!init.sessionId) {
    throw new Error("MCP server did not return a session id");
  }

  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await mcpPost("tools/list", cursor ? { cursor } : {}, init.sessionId, signal);
    const pageTools = Array.isArray(listed.result.tools) ? listed.result.tools as McpTool[] : [];
    tools.push(...pageTools);
    const nextCursor = typeof listed.result.nextCursor === "string" ? listed.result.nextCursor : undefined;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return {
    sessionId: init.sessionId,
    tools,
  };
}

function schemaToType(schema: JsonSchema | undefined, required: boolean) {
  const value = (() => {
    if (!schema) {
      return Type.Any();
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
      return Type.Any({ description: schema.description });
    }

    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
      return Type.Any({ description: schema.description });
    }

    if (Array.isArray(schema.enum) && schema.enum.length === 1) {
      return Type.Literal(typeof schema.enum[0] === "string" ? schema.enum[0] : String(schema.enum[0]), schema.description ? { description: schema.description } : {});
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 1) {
      return Type.Union(
        schema.enum.map((entry) => Type.Literal(typeof entry === "string" ? entry : String(entry))),
        schema.description ? { description: schema.description } : {},
      );
    }

    if (schema.type === "number" || schema.type === "integer") {
      return Type.Number(schema.description ? { description: schema.description } : {});
    }

    if (schema.type === "boolean") {
      return Type.Boolean(schema.description ? { description: schema.description } : {});
    }

    if (schema.type === "array") {
      return Type.Array(schemaToType(schema.items, true), schema.description ? { description: schema.description } : {});
    }

    if (schema.type === "object" || schema.properties) {
      const requiredKeys = new Set(schema.required || []);
      const properties = Object.fromEntries(
        Object.entries(schema.properties || {}).map(([key, child]) => [key, schemaToType(child, requiredKeys.has(key))]),
      );
      return Type.Object(properties, schema.description ? { description: schema.description } : {});
    }

    return Type.String(schema.description ? { description: schema.description } : {});
  })();

  return required ? value : Type.Optional(value);
}

function buildParametersSchema(tool: McpTool) {
  const schema = tool.inputSchema;
  const requiredKeys = new Set(schema?.required || []);
  const properties = Object.fromEntries(
    Object.entries(schema?.properties || {}).map(([key, child]) => [key, schemaToType(child, requiredKeys.has(key))]),
  );
  return Type.Object(properties);
}

function formatToolResult(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = content
    .filter((item): item is { type: string; text?: string } => Boolean(item) && typeof item === "object")
    .map((item) => item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item, null, 2))
    .filter(Boolean);

  if (textParts.length > 0) {
    return textParts.join("\\n\\n");
  }

  return JSON.stringify(result, null, 2);
}

export default function rorcaPiBridge(pi: ExtensionAPI) {
  let bridgePromise: Promise<{ sessionId: string; tools: McpTool[] }> | null = null;
  let sessionId: string | null = null;
  const registeredTools = new Set<string>();

  async function getBridge(signal?: AbortSignal) {
    if (!bridgePromise) {
      bridgePromise = initializeBridge(signal);
    }
    const bridge = await bridgePromise;
    sessionId = bridge.sessionId;
    return bridge;
  }

  function registerBridgeTool(tool: McpTool) {
    if (registeredTools.has(tool.name)) return;
    registeredTools.add(tool.name);

    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || \`Rorca MCP tool: \${tool.name}\`,
      parameters: buildParametersSchema(tool),
      async execute(_toolCallId, params, signal) {
        const bridge = await getBridge(signal);
        const response = await mcpPost("tools/call", {
          name: tool.name,
          arguments: params,
        }, bridge.sessionId, signal);

        const result = response.result as Record<string, unknown>;
        return {
          content: [{ type: "text", text: formatToolResult(result) }],
          details: {
            bridge: "rorca-mcp",
            tool: tool.name,
          },
        };
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const bridge = await getBridge();
      for (const tool of bridge.tools) {
        registerBridgeTool(tool);
      }
      ctx.ui.setStatus("rorca-mcp", \`Rorca MCP: \${bridge.tools.length} tools\`);
      ctx.ui.notify(\`Loaded \${bridge.tools.length} Rorca MCP tools from \${MCP_URL}\`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus("rorca-mcp", "Rorca MCP: unavailable");
      ctx.ui.notify(\`Failed to load Rorca MCP bridge: \${message}\`, "error");
    }
  });

  pi.registerCommand("rorca-mcp-status", {
    description: "Show Rorca MCP bridge status",
    handler: async (_args, ctx) => {
      try {
        const bridge = await getBridge();
        for (const tool of bridge.tools) {
          registerBridgeTool(tool);
        }
        ctx.ui.notify(\`Rorca MCP bridge healthy: \${bridge.tools.length} tools from \${MCP_URL}\`, "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(\`Rorca MCP bridge unavailable: \${message}\`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    if (!sessionId) return;
    try {
      await fetch(MCP_URL, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
      });
    } catch {
      // Best effort cleanup for server-side MCP sessions.
    }
  });
}
`;
}
async function fetchBackendHealth(options) {
    return fetchJson('/api/health', undefined, 30_000, options);
}
async function runMcpToken(options = {}) {
    const tokens = ensureMcpToken();
    console.log(options.admin ? tokens.adminToken : tokens.publicToken);
    return 0;
}
async function runMcpStatus() {
    const publicTokenStatus = checkMcpTokenFile(getMcpPublicTokenPath());
    const adminTokenStatus = checkMcpTokenFile(getMcpAdminTokenPath());
    const backendHealth = await fetchBackendHealth({ skipVersionCheck: true }).catch(() => null);
    const toolCount = await fetchJson('/api/mcp/tools')
        .then((data) => data.tools.length)
        .catch(() => null);
    if (!publicTokenStatus.exists) {
        console.log(`${red('ERR')} MCP public token file: missing`);
    }
    else if (!publicTokenStatus.modeOk) {
        console.log(`${yellow('WARN')} MCP public token file: mode ${publicTokenStatus.mode}, expected 600`);
    }
    else {
        console.log(`${green('OK')} MCP public token file: ~/.rorca/mcp-token (mode 600)`);
    }
    if (!adminTokenStatus.exists) {
        console.log(`${red('ERR')} MCP admin token file: missing`);
    }
    else if (!adminTokenStatus.modeOk) {
        console.log(`${yellow('WARN')} MCP admin token file: mode ${adminTokenStatus.mode}, expected 600`);
    }
    else {
        console.log(`${green('OK')} MCP admin token file: ~/.rorca/mcp-admin-token (mode 600)`);
    }
    if (!backendHealth) {
        console.log(`${red('ERR')} MCP server: unreachable at ${API_BASE}/mcp`);
    }
    else if (backendHealth.mcp?.enabled) {
        console.log(`${green('OK')} MCP server: ${backendHealth.mcp.url}`);
    }
    else {
        console.log(`${yellow('WARN')} MCP server: disabled`);
    }
    if (toolCount == null) {
        console.log(`${yellow('WARN')} MCP tools: unavailable`);
    }
    else {
        console.log(`${green('OK')} MCP tools: ${toolCount} registered`);
    }
    return !publicTokenStatus.exists || !adminTokenStatus.exists || !backendHealth ? 1 : 0;
}
async function runMcpSetupClaude(options = {}) {
    const claudeBin = resolveClaudeBinPathLocal();
    if (!claudeBin) {
        throw new Error('Claude CLI not found. Set CLAUDE_BIN or install `claude` first.');
    }
    const tokens = ensureMcpToken();
    const token = options.admin ? tokens.adminToken : tokens.publicToken;
    await runCommand(claudeBin, ['mcp', 'remove', 'rorca'], { stdio: 'pipe' });
    const add = await runCommand(claudeBin, [
        'mcp',
        'add',
        'rorca',
        'http://localhost:3030/mcp',
        '--header',
        `Authorization: Bearer ${token}`,
    ], { stdio: 'inherit' });
    if (add.code !== 0) {
        return add.code;
    }
    console.log(`Claude MCP configured for Rorca (${options.admin ? 'admin' : 'public'} token).`);
    return 0;
}
async function runMcpRotateToken(options = {}) {
    if (!hasInteractiveTty()) {
        console.error('Rotate token requires an interactive TTY confirmation.');
        return 1;
    }
    const selectedModes = [options.public, options.admin, options.all].filter(Boolean).length;
    if (selectedModes > 1) {
        console.error('Choose only one of --public, --admin, or --all.');
        return 1;
    }
    const rotateTarget = options.all ? 'all' : options.admin ? 'admin' : 'public';
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        const answer = (await rl.question(`Rotate ${rotateTarget} token${rotateTarget === 'all' ? 's' : ''}? Existing MCP clients will need re-setup. [y/N] `)).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
            console.log('Token rotation cancelled.');
            return 1;
        }
    }
    finally {
        rl.close();
    }
    const rotated = rotateTarget === 'all'
        ? rotateMcpToken('all')
        : rotateTarget === 'admin'
            ? rotateMcpToken('admin')
            : rotateMcpToken('public');
    if (typeof rotated === 'string') {
        console.log(rotated);
    }
    else {
        console.log(JSON.stringify(rotated, null, 2));
    }
    if (rotateTarget === 'public') {
        console.log('Public token rotated. Existing ~/.rorca/mcp-token consumers keep public-tier access only.');
        console.log('Run `rorca mcp setup-claude` to re-link Claude to the new public token.');
    }
    else if (rotateTarget === 'admin') {
        console.log('Admin token rotated.');
        console.log('Run `rorca mcp setup-claude --admin` to re-link Claude to the new admin token.');
    }
    else {
        console.log('Public and admin tokens rotated. Existing ~/.rorca/mcp-token consumers remain public-tier only.');
        console.log('Run `rorca mcp setup-claude` and/or `rorca mcp setup-claude --admin` to re-link clients.');
    }
    return 0;
}
function appendUniquePath(paths, candidate) {
    if (!candidate)
        return;
    if (!paths.includes(candidate)) {
        paths.push(candidate);
    }
}
function getClaudeDesktopConfigPaths() {
    const paths = [];
    appendUniquePath(paths, path.join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    appendUniquePath(paths, path.join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'));
    if (process.env.APPDATA) {
        appendUniquePath(paths, path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'));
    }
    return paths;
}
function getVsCodeSettingsPaths() {
    const paths = [];
    appendUniquePath(paths, path.join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'));
    appendUniquePath(paths, path.join(homedir(), '.config', 'Code', 'User', 'settings.json'));
    if (process.env.APPDATA) {
        appendUniquePath(paths, path.join(process.env.APPDATA, 'Code', 'User', 'settings.json'));
    }
    return paths;
}
function configTargetsRorcaMcp(serverConfig) {
    if (!serverConfig || typeof serverConfig !== 'object') {
        return false;
    }
    const serialized = JSON.stringify(serverConfig).toLowerCase();
    return serialized.includes('/mcp')
        && (serialized.includes('localhost:3030')
            || serialized.includes('127.0.0.1:3030')
            || serialized.includes('rorca_api_url'));
}
function configHasBearerHeader(serverConfig) {
    if (!serverConfig || typeof serverConfig !== 'object') {
        return false;
    }
    const serialized = JSON.stringify(serverConfig);
    return serialized.includes('Authorization: Bearer')
        || serialized.includes('"Authorization":"Bearer ')
        || serialized.includes('"authorization":"Bearer ');
}
function collectSectionFindings(section, client, configPath, issue, fix) {
    if (!section || typeof section !== 'object') {
        return [];
    }
    const findings = [];
    for (const [serverName, serverConfig] of Object.entries(section)) {
        if (!configTargetsRorcaMcp(serverConfig)) {
            continue;
        }
        if (configHasBearerHeader(serverConfig)) {
            continue;
        }
        findings.push({
            client,
            configPath,
            serverName,
            issue,
            fix,
        });
    }
    return findings;
}
function inspectJsonConfig(filePath, inspector) {
    try {
        const raw = readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return { findings: inspector(parsed, filePath) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { findings: [], parseError: message };
    }
}
async function runMcpDiagnoseClients() {
    const findings = [];
    const parseWarnings = [];
    for (const configPath of getClaudeDesktopConfigPaths()) {
        if (!existsSync(configPath))
            continue;
        const result = inspectJsonConfig(configPath, (parsed, filePath) => collectSectionFindings(parsed.mcpServers, 'Claude Desktop', filePath, 'Claude Desktop MCP HTTP configs that relied on the removed OAuth probe will fail. Rorca is Bearer-only now.', 'Use Claude Code CLI instead: `rorca mcp setup-claude` or `claude mcp add rorca http://localhost:3030/mcp --header \'Authorization: Bearer <token>\'`.'));
        findings.push(...result.findings);
        if (result.parseError) {
            parseWarnings.push(`Claude Desktop config unreadable: ${configPath} (${result.parseError})`);
        }
    }
    for (const configPath of getVsCodeSettingsPaths()) {
        if (!existsSync(configPath))
            continue;
        const result = inspectJsonConfig(configPath, (parsed, filePath) => collectSectionFindings(parsed['mcp.servers'], 'VS Code', filePath, 'This VS Code MCP server points at Rorca /mcp without an Authorization Bearer header.', 'Add an `Authorization: Bearer <token>` header to that server entry. Use `rorca mcp token` for public access or `rorca mcp token --admin` for admin access.'));
        findings.push(...result.findings);
        if (result.parseError) {
            parseWarnings.push(`VS Code settings unreadable: ${configPath} (${result.parseError})`);
        }
    }
    if (findings.length === 0 && parseWarnings.length === 0) {
        console.log('No broken MCP client configs detected.');
        console.log('Rorca MCP is Bearer-only. Use `rorca mcp setup-claude` for Claude Code CLI.');
        return 0;
    }
    if (findings.length > 0) {
        console.log('Potentially broken MCP client configs:');
        for (const finding of findings) {
            console.log('');
            console.log(`[${finding.client}] ${finding.serverName}`);
            console.log(`Config: ${finding.configPath}`);
            console.log(`Issue: ${finding.issue}`);
            console.log(`Fix: ${finding.fix}`);
        }
    }
    if (parseWarnings.length > 0) {
        console.log('');
        console.log('Unreadable config files:');
        for (const warning of parseWarnings) {
            console.log(`- ${warning}`);
        }
    }
    return findings.length > 0 ? 1 : 0;
}
async function spawnInteractivePi(piBinPath, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(piBinPath, args, {
            env: env ? { ...process.env, ...env } : process.env,
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });
        const forwardSignal = (signal) => {
            if (!child.killed) {
                child.kill(signal);
            }
        };
        process.on('SIGINT', forwardSignal);
        process.on('SIGTERM', forwardSignal);
        child.on('error', (error) => {
            process.removeListener('SIGINT', forwardSignal);
            process.removeListener('SIGTERM', forwardSignal);
            reject(error);
        });
        child.on('close', (code) => {
            process.removeListener('SIGINT', forwardSignal);
            process.removeListener('SIGTERM', forwardSignal);
            resolve(code ?? 1);
        });
    });
}
function resolveRorcaPiExtensionEntry() {
    const entry = path.join(ROOT_DIR, 'packages', 'rorca-pi-extension', 'extensions', 'rorca', 'index.ts');
    if (!existsSync(entry)) {
        throw new Error(`Rorca Pi extension not found at ${entry}`);
    }
    return entry;
}
async function runChat(options) {
    let workspaceName = options.workspaceId ?? 'default';
    let tempSkillFile = null;
    const extensionEntry = resolveRorcaPiExtensionEntry();
    const tokens = ensureMcpToken();
    const health = await fetchBackendHealth().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Rorca backend is required for pi MCP bridge. Start \`npm run dev\` or \`rorca start\` first. (${message})`);
    });
    if (!health.piInstalled) {
        printPiInstallMethods();
        throw new Error('Pi CLI is not installed.');
    }
    if (!health.piBinPath && !resolvePiBinPathLocal()) {
        printPiInstallMethods();
        throw new Error('Pi CLI binary path could not be resolved.');
    }
    if (!health.mcp?.enabled || health.mcp.status !== 'healthy' || !health.mcp.url) {
        const detail = health.mcp?.status === 'disabled'
            ? 'MCP is disabled in the backend (`RORCA_SERVE_MCP=false`).'
            : 'MCP bridge is not reachable from the backend.';
        throw new Error(`Rorca MCP bridge is required for \`rorca chat\`. ${detail} Start \`npm run dev\` or \`rorca start\` with MCP enabled first.`);
    }
    try {
        const workspace = options.workspaceId
            ? await getWorkspaceById(options.workspaceId)
            : await getDefaultWorkspace();
        workspaceName = workspace.label || workspace.id;
        const direction = await fetchJson('/api/direction/synthesize', {
            method: 'POST',
            body: JSON.stringify({
                workspaceId: workspace.id,
            }),
        });
        tempSkillFile = path.join(tmpdir(), `rorca-chat-context-${Date.now()}-${process.pid}.md`);
        writeFileSync(tempSkillFile, [
            '---',
            'name: rorca-chat-context',
            'description: Rorca direction stack and workspace context injected for rorca chat sessions.',
            '---',
            '',
            '# Rorca Chat Context',
            '',
            direction.synthesized.trim(),
            '',
        ].join('\n'), 'utf8');
    }
    catch (error) {
        if (isBackendUnavailableError(error)) {
            throw new Error('Rorca backend is required for `rorca chat`. Start `npm run dev` or `rorca start` first.');
        }
        throw error;
    }
    const args = [
        '--no-extensions',
        ...(tempSkillFile ? ['--skill', tempSkillFile] : []),
        '--extension', extensionEntry,
        ...(options.model ? ['--model', options.model] : []),
    ];
    console.log('─── Rorca Chat ───────────────────────────────────────────────');
    console.log(`Workspace: ${workspaceName}  Agent: pi  Model: ${options.model ?? 'default'}  Context: ${tempSkillFile ? 'L1-L5 injected' : 'not injected'}  MCP: ${health.mcp.url}`);
    console.log('─────────────────────────────────────────────────────────────');
    try {
        return await spawnInteractivePi(resolvePiBinPath(health.piBinPath), args, {
            RORCA_PI_API_URL: API_BASE,
            RORCA_PI_MCP_URL: health.mcp.url,
            RORCA_PI_MCP_TOKEN: tokens.adminToken,
            ...(options.workspaceId ? { RORCA_PI_WORKSPACE_ID: options.workspaceId } : {}),
        });
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            printPiInstallMethods();
        }
        throw error;
    }
    finally {
        cleanupTempFile(tempSkillFile);
        console.log('Chat session ended');
    }
}
async function resolveApprovedSpec(specSlug) {
    const workspaces = await getWorkspaces();
    if (workspaces.length === 0) {
        throw new Error('No workspaces registered. Add one in the UI first.');
    }
    const matches = [];
    for (const workspace of workspaces) {
        const specs = await fetchJson(`/api/specs?workspaceId=${encodeURIComponent(workspace.id)}&status=approved`);
        const match = specs.items.find((spec) => spec.id === specSlug);
        if (match) {
            matches.push({ workspace, spec: match });
        }
    }
    if (matches.length === 0) {
        throw new Error(`Approved spec "${specSlug}" not found.`);
    }
    if (matches.length > 1) {
        throw new Error(`Spec slug "${specSlug}" exists in multiple workspaces: ${matches.map((match) => match.workspace.id).join(', ')}.`);
    }
    return matches[0];
}
async function ensureFrontendBuild() {
    if (existsSync(path.join(DIST_DIR, 'index.html'))) {
        return;
    }
    console.log('Building frontend bundle...');
    const result = await runCommand('npm', ['run', 'build'], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
    });
    if (result.code !== 0) {
        throw new Error('Build failed.');
    }
}
async function startServer(options) {
    if (!options.noDb) {
        await handleDbCommand('start', { quiet: true });
    }
    else {
        console.log('Skipping Docker database sidecar.');
    }
    await ensureFrontendBuild();
    const env = {
        ...process.env,
        PORT: String(options.port),
        RORCA_BIND_HOST: options.host,
        RORCA_SERVE_STATIC: '1',
        RORCA_STATIC_DIR: DIST_DIR,
        NODE_ENV: process.env.NODE_ENV || 'production',
    };
    const serverJs = path.join(BACKEND_DIR, 'dist', 'server.js');
    const workerJs = path.join(BACKEND_DIR, 'dist', 'worker.js');
    const serverTs = path.join(BACKEND_DIR, 'src', 'server.ts');
    const workerTs = path.join(BACKEND_DIR, 'src', 'worker.ts');
    const server = existsSync(serverJs)
        ? spawnLogged('server', process.execPath, [serverJs], { cwd: BACKEND_DIR, env })
        : spawnLogged('server', 'npx', ['tsx', serverTs], { cwd: BACKEND_DIR, env });
    const worker = existsSync(workerJs)
        ? spawnLogged('worker', process.execPath, [workerJs], { cwd: BACKEND_DIR, env })
        : spawnLogged('worker', 'npx', ['tsx', workerTs], { cwd: BACKEND_DIR, env });
    console.log(`Rorca running at http://${options.host}:${options.port}`);
    const shutdown = (signal) => {
        server.kill(signal);
        worker.kill(signal);
    };
    process.once('SIGINT', () => {
        shutdown('SIGTERM');
        process.exit(0);
    });
    process.once('SIGTERM', () => {
        shutdown('SIGTERM');
        process.exit(0);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        worker.once('error', reject);
        server.once('exit', (code) => {
            if ((code ?? 1) !== 0) {
                reject(new Error(`Server exited with code ${code}`));
                return;
            }
            resolve();
        });
    });
}
function printInitDockerInstallInstructions() {
    console.error('Docker is required for `rorca init`.');
    console.error('Install one of:');
    console.error('  OrbStack: https://orbstack.dev/');
    console.error('  Docker Desktop: https://www.docker.com/products/docker-desktop/');
}
async function pullInitDatabaseImage() {
    console.log('Pulling Rorca database image (~200MB, first run only)...');
    const result = await docker(['pull', DB_IMAGE], 'inherit');
    if (result.code !== 0) {
        throw new Error('Failed to pull the Rorca database image.');
    }
}
async function enableInitExtensions() {
    const result = await docker([
        'exec',
        DB_CONTAINER,
        'psql',
        '-U',
        'rorca',
        '-d',
        'rorca',
        '-c',
        'CREATE EXTENSION IF NOT EXISTS age; CREATE EXTENSION IF NOT EXISTS vector;',
    ]);
    if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || 'Failed to enable AGE/vector extensions.');
    }
}
function writeInitFileIfMissing(root, relativePath, content) {
    const filePath = path.join(root, relativePath);
    if (existsSync(filePath)) {
        console.log(`Already exists: ${relativePath}`);
        return;
    }
    writeFileSync(filePath, content);
    console.log(`Created: ${relativePath}`);
}
function ensureInitDirectory(root, relativePath) {
    const dirPath = path.join(root, relativePath);
    if (existsSync(dirPath)) {
        console.log(`Already exists: ${relativePath}/`);
        return;
    }
    mkdirSync(dirPath, { recursive: true });
    console.log(`Created: ${relativePath}/`);
}
async function runInit(targetPath, options) {
    const root = path.resolve(process.cwd(), targetPath);
    mkdirSync(root, { recursive: true });
    if (options?.skipDocker) {
        console.log('Skipping Docker setup — ensure AGE + pgvector are enabled: CREATE EXTENSION IF NOT EXISTS age; CREATE EXTENSION IF NOT EXISTS vector;');
    }
    else {
        console.log('Checking Docker...');
        const status = await dbStatus();
        let dockerReady = false;
        try {
            const dockerInfo = await docker(['info']);
            dockerReady = dockerInfo.code === 0;
        }
        catch {
            dockerReady = false;
        }
        if (!dockerReady) {
            printInitDockerInstallInstructions();
            return 1;
        }
        console.log('✓ Docker is available');
        if (!status.containerExists) {
            await pullInitDatabaseImage();
        }
        else {
            console.log('Database container already exists; skipping image pull.');
        }
        console.log('Starting database...');
        await dbStart();
        console.log('✓ Database ready at localhost:5432');
        console.log('Enabling AGE + pgvector extensions...');
        await enableInitExtensions();
        console.log('✓ Graph + vector extensions enabled');
    }
    console.log(`Scaffolding workspace at ${root}...`);
    ensureInitDirectory(root, '.rorca');
    ensureInitDirectory(root, '.rorca/skills');
    writeInitFileIfMissing(root, '.rorca/config.json', '{}\n');
    writeInitFileIfMissing(root, 'AGENTS.md', '# AGENTS.md\n\nAdd your file governance rules here.\n');
    writeInitFileIfMissing(root, 'MEMORY.md', '# Memory\n\n_No entries yet._\n');
    console.log(`Rorca is ready! Next steps:
  1. rorca start          # Start backend + worker
  2. rorca doctor         # Verify all systems  
  3. rorca auth login     # Connect pi to a provider
  4. rorca forge <brief>  # Generate your first spec`);
    return 0;
}
function formatWalLine(event) {
    const payload = parseWalPayload(event);
    const storyId = typeof payload.story_id === 'string' ? payload.story_id : event.story_id;
    const storyTitle = typeof payload.story_title === 'string' ? payload.story_title : '';
    switch (event.event_type) {
        case 'story_started':
            return yellow(`▶ FORGE ${storyId ?? ''}${storyTitle ? `  ${storyTitle}` : ''}`.trim());
        case 'story_passed':
            return green(`✓ PASS  ${storyId ?? ''}`.trim());
        case 'story_failed':
            return red(`✗ FAIL  ${storyId ?? ''}${typeof payload.reason === 'string' ? `  ${payload.reason}` : ''}`.trim());
        case 'story_retry':
            return yellow(`↻ RETRY ${storyId ?? ''}`.trim());
        case 'run_started':
            return cyan(`Run ${payload.run_id ?? ''} started`);
        case 'run_finished':
            return cyan(`Run ${payload.run_id ?? ''} finished with status ${String(payload.status ?? 'unknown')}`);
        case 'run_cancelled':
            return yellow(`Run ${payload.run_id ?? ''} cancelled`);
        default:
            return null;
    }
}
function isActiveRunStatus(status) {
    return status === 'queued' || status === 'running' || status === 'paused';
}
async function promptCancelDecision() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await Promise.race([
            rl.question('Cancel run? [y/N] '),
            new Promise((resolve) => setTimeout(() => resolve(''), 3000)),
        ]);
        return answer.trim().toLowerCase() === 'y' ? 'cancel' : 'detach';
    }
    finally {
        rl.close();
    }
}
async function streamWal(runId, signal) {
    let finalEvent = null;
    await readSse('/api/pipeline/stream', async (eventName, data) => {
        if (eventName !== 'wal_event')
            return;
        const event = JSON.parse(data);
        const payload = parseWalPayload(event);
        if (Number(payload.run_id) !== runId)
            return;
        const line = formatWalLine(event);
        if (line)
            console.log(line);
        if (event.event_type === 'run_finished' || event.event_type === 'run_cancelled') {
            finalEvent = event;
            throw new Error('__RORCA_RUN_COMPLETE__');
        }
    }, signal).catch((error) => {
        if (error instanceof Error && error.message === '__RORCA_RUN_COMPLETE__') {
            return;
        }
        if (signal.aborted) {
            return;
        }
        throw error;
    });
    return { finalEvent };
}
async function streamRawOutput(runId, signal) {
    await readSse(`/api/pipeline/runs/${runId}/output`, async (eventName, data) => {
        if (eventName !== 'chunk')
            return;
        const text = Buffer.from(data, 'base64').toString('utf8');
        const lines = text.split('\n');
        for (const line of lines) {
            if (!line.trim())
                continue;
            console.log(dim(`│ ${line}`));
        }
    }, signal).catch((error) => {
        if (signal.aborted) {
            return;
        }
        throw error;
    });
}
async function attachLiveRun(runId) {
    let details;
    try {
        details = await fetchJson(`/api/pipeline/runs/${runId}`);
    }
    catch {
        console.log(`No active run with ID ${runId}`);
        return 1;
    }
    if (!isActiveRunStatus(details.run.status)) {
        console.log(`No active run with ID ${runId}`);
        return 1;
    }
    console.log(`Attached to run ${runId}`);
    const walController = new AbortController();
    const outputController = new AbortController();
    let mode = 'attached';
    let prompting = false;
    const onSigint = () => {
        if (prompting || mode === 'cancelling' || mode === 'detaching') {
            return;
        }
        prompting = true;
        void (async () => {
            const decision = await promptCancelDecision();
            prompting = false;
            if (decision === 'cancel') {
                mode = 'cancelling';
                console.log('Cancelling run...');
                try {
                    await fetchJson(`/api/pipeline/runs/${runId}/cancel`, { method: 'POST' });
                }
                catch (error) {
                    mode = 'attached';
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(message);
                }
                return;
            }
            mode = 'detaching';
            walController.abort();
            outputController.abort();
        })();
    };
    process.on('SIGINT', onSigint);
    try {
        const walPromise = streamWal(runId, walController.signal);
        const outputPromise = streamRawOutput(runId, outputController.signal);
        const { finalEvent } = await walPromise;
        if (mode === 'detaching') {
            return 0;
        }
        outputController.abort();
        await Promise.race([outputPromise, sleep(200)]);
        details = await fetchJson(`/api/pipeline/runs/${runId}`);
        if (mode === 'cancelling'
            && (details.run.status === 'cancelled' || finalEvent?.event_type === 'run_cancelled')) {
            console.log('Run cancelled');
        }
        const failed = details.run.status === 'failed'
            || details.run.status === 'cancelled'
            || details.run.status === 'partial_failure'
            || details.stories.some((story) => story.status === 'fail');
        return failed ? 1 : 0;
    }
    finally {
        process.removeListener('SIGINT', onSigint);
        walController.abort();
        outputController.abort();
    }
}
async function runSpec(options) {
    const { workspace } = await resolveApprovedSpec(options.specSlug);
    const trigger = await fetchJson('/api/pipeline/trigger', {
        method: 'POST',
        body: JSON.stringify({
            specPath: `forge/specs/approved/${options.specSlug}.json`,
            workspaceId: workspace.id,
            storyId: options.story,
            dryRun: Boolean(options.dryRun),
            agentOverride: options.agent,
            modelOverride: options.model,
            forceSequential: Boolean(options.forceSequential),
        }),
    });
    if ('dryRun' in trigger) {
        console.log(JSON.stringify(trigger.estimate, null, 2));
        return 0;
    }
    if ('conflict' in trigger) {
        console.error(`Workspace busy. Active run: ${trigger.activeRunId}`);
        return 1;
    }
    const runId = trigger.runId;
    console.log(`Triggered run ${runId} for ${options.specSlug} in workspace ${workspace.id}`);
    if ('queued' in trigger && trigger.queued) {
        console.log(`Queued at position ${trigger.position ?? '?'}`);
    }
    return attachLiveRun(runId);
}
async function runStatus(runId) {
    if (runId) {
        const details = await fetchJson(`/api/pipeline/runs/${runId}`);
        console.log(`Run ${details.run.id}`);
        console.log(`Status: ${details.run.status}`);
        console.log(`Spec: ${formatSpecFromPath(details.run.spec_path)}`);
        console.log(`Started: ${formatDate(details.run.started_at)}`);
        console.log(`Finished: ${formatDate(details.run.finished_at)}`);
        console.log('');
        const rows = details.stories.map((story) => [story.story_id, story.status]);
        if (rows.length > 0) {
            printTable(['Story', 'Status'], rows);
        }
        else {
            console.log('No story results yet.');
        }
        return;
    }
    const workspaces = await getWorkspaces();
    const runs = [];
    for (const workspace of workspaces) {
        const response = await fetchJson(`/api/pipeline/runs?workspaceId=${encodeURIComponent(workspace.id)}&limit=10`);
        for (const run of response.items) {
            runs.push({ ...run, workspaceLabel: workspace.id });
        }
    }
    runs.sort((a, b) => b.id - a.id);
    const topRuns = runs.slice(0, 10);
    const rows = [];
    for (const run of topRuns) {
        const details = await fetchJson(`/api/pipeline/runs/${run.id}`);
        const passCount = details.stories.filter((story) => story.status === 'pass').length;
        const failCount = details.stories.filter((story) => story.status === 'fail').length;
        rows.push([
            String(run.id),
            run.workspaceLabel,
            run.status,
            formatSpecFromPath(run.spec_path),
            `${details.stories.length}`,
            `${passCount}`,
            `${failCount}`,
            formatDate(run.started_at),
        ]);
    }
    if (rows.length === 0) {
        console.log('No pipeline runs found.');
        return;
    }
    printTable(['Run', 'Workspace', 'Status', 'Spec', 'Stories', 'Pass', 'Fail', 'Started'], rows);
}
function parseApiAddress() {
    const url = new URL(API_BASE);
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    return { host: url.hostname, port, label: `:${port}` };
}
function normalizeDoctorStatus(status) {
    if (status === 'pass')
        return green('✓');
    if (status === 'warn')
        return yellow('⚠');
    return red('✗');
}
function resolveDoctorSelection(input) {
    if (!input)
        return null;
    const normalized = input.trim().toLowerCase();
    const map = {
        node: ['node-version'],
        'node-version': ['node-version'],
        pi: ['pi-binary', 'pi-version'],
        'pi-binary': ['pi-binary'],
        'pi-version': ['pi-version'],
        db: ['db-mode'],
        'db-mode': ['db-mode'],
        native: ['native-pg'],
        'native-pg': ['native-pg'],
        docker: ['docker-daemon', 'db-container', 'age-extension'],
        'docker-daemon': ['docker-daemon'],
        'db-container': ['db-container'],
        age: ['age-extension'],
        'age-extension': ['age-extension'],
        backend: ['backend-port', 'backend-version'],
        'backend-port': ['backend-port'],
        'backend-version': ['backend-version'],
        migrations: ['schema-migrations'],
        'schema-migrations': ['schema-migrations'],
        worker: ['worker-heartbeat'],
        'worker-heartbeat': ['worker-heartbeat'],
        mcp: ['mcp-public-token', 'mcp-admin-token', 'mcp-bridge'],
        'mcp-public-token': ['mcp-public-token'],
        'mcp-admin-token': ['mcp-admin-token'],
        'mcp-bridge': ['mcp-bridge'],
        workspace: ['workspace-files'],
        'workspace-files': ['workspace-files'],
    };
    return map[normalized] ? new Set(map[normalized]) : null;
}
function shouldRunDoctorCheck(selected, id) {
    return selected === null || selected.has(id);
}
function doctorPass(id, name, detail) {
    return { id, name, status: 'pass', detail };
}
function doctorWarn(id, name, detail, hint) {
    return { id, name, status: 'warn', detail, hint };
}
function doctorFail(id, name, detail, hint) {
    return { id, name, status: 'fail', detail, hint };
}
function doctorExitCode(checks) {
    if (checks.some((check) => check.status === 'fail'))
        return 1;
    if (checks.some((check) => check.status === 'warn'))
        return 2;
    return 0;
}
function formatAgeSeconds(ageSeconds) {
    return `${Math.round(ageSeconds)}s ago`;
}
function getMigrationFiles() {
    const migrationsDir = path.join(BACKEND_DIR, 'src', 'db', 'pg-migrations');
    return readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'));
}
function readMcpToken(tier = 'public') {
    return tier === 'admin' ? getMcpAdminToken() : getMcpPublicToken();
}
function checkMcpToken(tier) {
    const tokenPath = tier === 'admin' ? getMcpAdminTokenPath() : getMcpPublicTokenPath();
    const label = tier === 'admin' ? 'MCP admin token' : 'MCP public token';
    const id = tier === 'admin' ? 'mcp-admin-token' : 'mcp-public-token';
    const status = checkMcpTokenFile(tokenPath);
    if (!status.exists) {
        return doctorWarn(id, label, 'missing', `Run: rorca mcp token${tier === 'admin' ? ' --admin' : ''}`);
    }
    if (!status.modeOk) {
        return doctorWarn(id, label, `mode ${status.mode}, expected 600`, `Run: chmod 600 ${tokenPath}`);
    }
    return doctorPass(id, label, `${tokenPath.replace(homedir(), '~')} (mode 0600)`);
}
async function isTcpReachable(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const finish = (result) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}
async function fetchRawJson(pathname, timeoutMs = 3_000, init) {
    try {
        const response = await fetch(`${API_BASE}${pathname}`, {
            ...init,
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                Accept: 'application/json',
                ...(init?.headers ?? {}),
            },
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        return { ok: response.ok, status: response.status, data };
    }
    catch {
        return { ok: false, status: 0, data: null };
    }
}
async function fetchStatus(pathname, timeoutMs = 3_000, init) {
    try {
        const response = await fetch(`${API_BASE}${pathname}`, {
            ...init,
            signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
function checkNodeVersion() {
    if (semverGte(process.version, MIN_NODE_VERSION)) {
        return doctorPass('node-version', 'Node version', process.version);
    }
    return doctorFail('node-version', 'Node version', `${process.version} < required v${MIN_NODE_VERSION}`, 'Install Node 20 or newer');
}
function checkPiBinary() {
    const piStatus = detectPiShared();
    if (piStatus.piInstalled) {
        const version = piStatus.piVersion ? ` (v${piStatus.piVersion})` : '';
        return {
            piStatus,
            check: doctorPass('pi-binary', 'Pi binary', `${piStatus.piBinPath ?? 'pi'}${version}`),
        };
    }
    return {
        piStatus,
        check: doctorWarn('pi-binary', 'Pi binary', 'not installed', 'Run: rorca auth login'),
    };
}
function checkPiVersion(piStatus) {
    if (!piStatus.piInstalled) {
        return doctorWarn('pi-version', 'Pi version', 'skipped (pi missing)');
    }
    if (!piStatus.piVersion) {
        return doctorWarn('pi-version', 'Pi version', 'unknown version', `Need >= ${MIN_PI_VERSION}`);
    }
    if (semverGte(piStatus.piVersion, MIN_PI_VERSION)) {
        return doctorPass('pi-version', 'Pi version', `v${piStatus.piVersion}`);
    }
    return doctorWarn('pi-version', 'Pi version', `v${piStatus.piVersion} < required ${MIN_PI_VERSION}`, 'Upgrade pi to a newer version');
}
function checkDbModeLocal() {
    const mode = detectDbMode();
    const detail = mode === 'native' ? 'native (default)' : mode === 'docker' ? 'docker (sidecar)' : 'byop (DATABASE_URL)';
    return { mode, check: doctorPass('db-mode', 'DB mode', detail) };
}
async function checkNativePg() {
    const dataDir = path.join(homedir(), '.rorca', 'postgres');
    if (!existsSync(dataDir)) {
        return doctorFail('native-pg', 'Native PG', '~/.rorca/postgres missing', 'Run: rorca start');
    }
    const ready = await isTcpReachable('127.0.0.1', NATIVE_PG_PORT, 1_500);
    if (ready) {
        return doctorPass('native-pg', 'Native PG', `:${NATIVE_PG_PORT} ready`);
    }
    return doctorFail('native-pg', 'Native PG', `:${NATIVE_PG_PORT} unreachable`, 'Run: rorca start');
}
async function checkDockerDaemon() {
    try {
        execSync('docker info', { stdio: 'ignore', timeout: 3_000 });
        return doctorPass('docker-daemon', 'Docker daemon', 'running');
    }
    catch {
        return doctorFail('docker-daemon', 'Docker daemon', 'unavailable', 'Start Docker Desktop or OrbStack');
    }
}
async function checkDbContainer() {
    const status = await dbStatus();
    if (status.running) {
        return doctorPass('db-container', 'DB container', 'running');
    }
    if (status.containerExists) {
        return doctorFail('db-container', 'DB container', 'stopped', 'Run: rorca db start');
    }
    return doctorFail('db-container', 'DB container', 'not created', 'Run: rorca db start');
}
async function checkAgeExtensionLocal() {
    try {
        const available = await isAgeAvailable();
        if (available) {
            return doctorPass('age-extension', 'AGE extension', 'enabled');
        }
        return doctorWarn('age-extension', 'AGE extension', 'not installed (graph features disabled)');
    }
    catch {
        return doctorWarn('age-extension', 'AGE extension', 'unable to verify');
    }
}
async function checkBackendPort() {
    const address = parseApiAddress();
    const reachable = await isTcpReachable(address.host, address.port, 1_500);
    if (reachable) {
        return { reachable, check: doctorPass('backend-port', 'Backend port', `${address.label} reachable`) };
    }
    return {
        reachable,
        check: doctorFail('backend-port', 'Backend port', `${address.label} unreachable`, 'Run: rorca start'),
    };
}
async function checkBackendVersionLocal() {
    const result = await checkVersionShared(API_BASE);
    if (result.ok) {
        return {
            result,
            check: doctorPass('backend-version', 'Backend version', result.backend?.version ?? 'unknown'),
        };
    }
    return {
        result,
        check: doctorFail('backend-version', 'Backend version', result.reason ?? `need >= ${MIN_BACKEND_VERSION}`, 'Upgrade: npm install -g rorca@latest'),
    };
}
async function checkSchemaMigrations(backend) {
    try {
        const files = getMigrationFiles();
        checkDuplicatePrefixes(files);
        const expected = files.length;
        const response = await fetchRawJson('/api/health');
        const applied = response.data?.components?.migrations?.applied;
        if (!response.ok || typeof applied !== 'number') {
            return doctorFail('schema-migrations', 'Schema migrations', 'unable to verify');
        }
        if (applied >= expected) {
            const suffix = backend?.schemaVersion ? ` (latest ${backend.schemaVersion})` : '';
            return doctorPass('schema-migrations', 'Schema migrations', `${applied}/${expected} applied${suffix}`);
        }
        const latest = backend?.schemaVersion ? `, latest ${backend.schemaVersion}` : '';
        return doctorFail('schema-migrations', 'Schema migrations', `${applied}/${expected} applied${latest}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'unable to verify';
        return doctorFail('schema-migrations', 'Schema migrations', message);
    }
}
async function checkWorkerHeartbeat() {
    const [workerResponse, healthResponse] = await Promise.all([
        fetchRawJson('/api/pipeline/worker/health'),
        fetchRawJson('/api/health'),
    ]);
    const worker = workerResponse.data;
    if (!workerResponse.ok || !worker) {
        return doctorFail('worker-heartbeat', 'Worker heartbeat', 'unable to verify');
    }
    const lastHeartbeat = healthResponse.data?.components?.worker?.lastHeartbeat;
    if (worker.workerActive) {
        if (lastHeartbeat) {
            const ageSeconds = (Date.now() - new Date(lastHeartbeat).getTime()) / 1000;
            return doctorPass('worker-heartbeat', 'Worker heartbeat', `healthy ${formatAgeSeconds(ageSeconds)}`);
        }
        return doctorPass('worker-heartbeat', 'Worker heartbeat', 'healthy');
    }
    if (worker.workerPid === null) {
        return doctorFail('worker-heartbeat', 'Worker heartbeat', 'no heartbeat');
    }
    if (lastHeartbeat) {
        const ageSeconds = (Date.now() - new Date(lastHeartbeat).getTime()) / 1000;
        return doctorWarn('worker-heartbeat', 'Worker heartbeat', `stale ${formatAgeSeconds(ageSeconds)}`);
    }
    return doctorWarn('worker-heartbeat', 'Worker heartbeat', 'stale');
}
async function checkMcpBridge() {
    const token = readMcpToken('public');
    const toolsResponse = await fetchRawJson('/api/mcp/tools');
    if (!token) {
        return doctorWarn('mcp-bridge', 'MCP bridge', 'token missing');
    }
    const reachable = await fetchStatus('/mcp', 3_000, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!reachable) {
        return doctorWarn('mcp-bridge', 'MCP bridge', 'unreachable');
    }
    const toolCount = Array.isArray(toolsResponse.data?.tools) ? toolsResponse.data.tools.length : 0;
    return doctorPass('mcp-bridge', 'MCP bridge', `${toolCount} tools`);
}
function checkWorkspaceFiles() {
    const required = [
        path.join(process.cwd(), '.rorca', 'config.json'),
        path.join(process.cwd(), 'MEMORY.md'),
        path.join(process.cwd(), 'AGENTS.md'),
    ];
    const missing = required
        .filter((target) => !existsSync(target))
        .map((target) => path.relative(process.cwd(), target) || path.basename(target));
    if (missing.length === 0) {
        return doctorPass('workspace-files', 'Workspace files', 'all present');
    }
    return doctorWarn('workspace-files', 'Workspace files', `missing ${missing.join(', ')}`);
}
function skippedBackendCheck(id) {
    const names = {
        'node-version': 'Node version',
        'pi-binary': 'Pi binary',
        'pi-version': 'Pi version',
        'db-mode': 'DB mode',
        'native-pg': 'Native PG',
        'docker-daemon': 'Docker daemon',
        'db-container': 'DB container',
        'age-extension': 'AGE extension',
        'backend-port': 'Backend port',
        'backend-version': 'Backend version',
        'schema-migrations': 'Schema migrations',
        'worker-heartbeat': 'Worker heartbeat',
        'mcp-public-token': 'MCP public token',
        'mcp-admin-token': 'MCP admin token',
        'mcp-bridge': 'MCP bridge',
        'workspace-files': 'Workspace files',
    };
    return doctorFail(id, names[id], 'skipped (backend down)');
}
function printDoctorChecks(checks, verbose = false) {
    const width = Math.max(...checks.map((check) => check.name.length), 16);
    for (const check of checks) {
        console.log(`  ${normalizeDoctorStatus(check.status)} ${check.name.padEnd(width)} ${check.detail}`);
        if (verbose) {
            console.log(`      → check=${check.id} status=${check.status}`);
        }
        if (check.hint) {
            console.log(`      → ${check.hint}`);
        }
    }
}
async function runDoctor(options = {}) {
    const selected = resolveDoctorSelection(options.check);
    if (options.check && !selected) {
        console.error(`Unknown doctor check: ${options.check}`);
        return 1;
    }
    const checks = [];
    const wants = (id) => shouldRunDoctorCheck(selected, id);
    let piStatus = null;
    let dbMode = null;
    let backendUp = false;
    let backendVersion;
    if (wants('node-version')) {
        checks.push(checkNodeVersion());
    }
    if (wants('pi-binary') || wants('pi-version')) {
        const piBinary = checkPiBinary();
        piStatus = piBinary.piStatus;
        if (wants('pi-binary'))
            checks.push(piBinary.check);
        if (wants('pi-version'))
            checks.push(checkPiVersion(piStatus));
    }
    if (wants('db-mode')) {
        const dbModeCheck = checkDbModeLocal();
        dbMode = dbModeCheck.mode;
        checks.push(dbModeCheck.check);
    }
    else {
        dbMode = detectDbMode();
    }
    if (wants('native-pg') && dbMode === 'native') {
        checks.push(await checkNativePg());
    }
    if (dbMode === 'docker') {
        let dockerFailed = false;
        if (wants('docker-daemon')) {
            const dockerCheck = await checkDockerDaemon();
            checks.push(dockerCheck);
            dockerFailed = dockerCheck.status === 'fail';
        }
        if (wants('db-container')) {
            checks.push(selected === null && dockerFailed
                ? doctorFail('db-container', 'DB container', 'skipped (docker unavailable)')
                : await checkDbContainer());
        }
        if (wants('age-extension')) {
            checks.push(selected === null && dockerFailed
                ? doctorWarn('age-extension', 'AGE extension', 'skipped (docker unavailable)')
                : await checkAgeExtensionLocal());
        }
    }
    if (wants('backend-port')) {
        const backendPort = await checkBackendPort();
        backendUp = backendPort.reachable;
        checks.push(backendPort.check);
    }
    else if (selected === null || BACKEND_DEPENDENT_CHECKS.some((id) => selected.has(id))) {
        backendUp = (await checkBackendPort()).reachable;
    }
    if (wants('backend-version')) {
        if (selected === null && !backendUp) {
            checks.push(skippedBackendCheck('backend-version'));
        }
        else {
            const versionCheck = await checkBackendVersionLocal();
            backendVersion = versionCheck.result.backend;
            checks.push(versionCheck.check);
        }
    }
    if (wants('schema-migrations')) {
        checks.push(selected === null && !backendUp
            ? skippedBackendCheck('schema-migrations')
            : await checkSchemaMigrations(backendVersion));
    }
    if (wants('worker-heartbeat')) {
        checks.push(selected === null && !backendUp
            ? skippedBackendCheck('worker-heartbeat')
            : await checkWorkerHeartbeat());
    }
    if (wants('mcp-public-token')) {
        checks.push(checkMcpToken('public'));
    }
    if (wants('mcp-admin-token')) {
        checks.push(checkMcpToken('admin'));
    }
    if (wants('mcp-bridge')) {
        checks.push(selected === null && !backendUp
            ? skippedBackendCheck('mcp-bridge')
            : await checkMcpBridge());
    }
    if (wants('workspace-files')) {
        checks.push(checkWorkspaceFiles());
    }
    const exitCode = doctorExitCode(checks);
    if (options.json) {
        const payload = {
            checks: checks.map(({ name, status, detail, hint }) => ({ name, status, detail, ...(hint ? { hint } : {}) })),
            exitCode,
        };
        console.log(JSON.stringify(payload, null, 2));
        return exitCode;
    }
    printDoctorChecks(checks, Boolean(options.verbose));
    return exitCode;
}
function titleCase(input) {
    return input
        .split(/[\s/_-]+/)
        .filter(Boolean)
        .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
        .join(' ');
}
function getPiProviderLabel(provider) {
    const normalized = provider.trim().toLowerCase();
    return PI_PROVIDER_LABELS[normalized] ?? titleCase(provider);
}
function printPiInstallMethods() {
    console.log('Install Pi CLI with one of:');
    console.log(`NPM   ${PI_INSTALL_METHODS.npm}`);
    console.log(`PNPM  ${PI_INSTALL_METHODS.pnpm}`);
    console.log(`BUN   ${PI_INSTALL_METHODS.bun}`);
    console.log(`CURL  ${PI_INSTALL_METHODS.curl}`);
}
async function fetchPiHealth() {
    return fetchBackendHealth();
}
async function fetchPiModels() {
    return fetchJson('/api/config/pi-models');
}
function buildPiProviderCounts(models) {
    const counts = new Map();
    for (const model of models) {
        const label = getPiProviderLabel(model.provider);
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    for (const label of PI_PROVIDER_ORDER) {
        if (!counts.has(label)) {
            counts.set(label, 0);
        }
    }
    return [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => {
        const aIndex = PI_PROVIDER_ORDER.indexOf(a.label);
        const bIndex = PI_PROVIDER_ORDER.indexOf(b.label);
        if (aIndex >= 0 && bIndex >= 0)
            return aIndex - bIndex;
        if (aIndex >= 0)
            return -1;
        if (bIndex >= 0)
            return 1;
        return a.label.localeCompare(b.label);
    });
}
async function runPiAuthStatus() {
    const health = await fetchPiHealth();
    console.log(`Pi CLI: ${health.piInstalled ? health.piVersion ?? 'installed' : 'Not installed'}`);
    if (!health.piInstalled) {
        printPiInstallMethods();
        return 1;
    }
    const { models } = await fetchPiModels();
    const providers = buildPiProviderCounts(models);
    console.log('');
    console.log('Providers:');
    for (const provider of providers) {
        if (provider.count > 0) {
            const noun = provider.count === 1 ? 'model' : 'models';
            console.log(`  ${provider.label}: ${provider.count} ${noun} ${green('✓')}`);
        }
        else {
            console.log(`  ${provider.label}: Not authenticated`);
        }
    }
    console.log('');
    console.log('To authenticate a provider: rorca auth login <provider>');
    return 0;
}
async function runPiAuthCommand(action, provider) {
    if (action === 'login') {
        const pi = await ensurePiInstalled();
        if (!pi.ok) {
            return 1;
        }
        if (pi.skipped) {
            return 0;
        }
    }
    const health = await fetchPiHealth().catch(() => null);
    if (!health?.piInstalled) {
        if (action === 'logout') {
            printPiInstallMethods();
            return 1;
        }
        const detected = detectPi();
        if (!detected.piInstalled) {
            printPiInstallMethods();
            return 1;
        }
    }
    const args = ['auth', action];
    if (provider) {
        args.push(provider);
    }
    const result = await runCommand(resolvePiBinPath(health?.piBinPath), args, { stdio: 'inherit' });
    if (result.code !== 0) {
        return result.code;
    }
    if (action === 'login') {
        console.log('Auth complete — run rorca auth status to verify');
    }
    return 0;
}
function getBundledPiExtensionPath() {
    const extensionDir = path.join(ROOT_DIR, 'packages', 'rorca-pi-extension');
    const manifestPath = path.join(extensionDir, 'package.json');
    if (existsSync(manifestPath)) {
        return extensionDir;
    }
    throw new Error('Bundled Rorca Pi extension package not found. Reinstall or rebuild Rorca and try again.');
}
async function runPiExtensionInstall(options) {
    const pi = await ensurePiInstalled();
    if (!pi.ok) {
        return 1;
    }
    if (pi.skipped) {
        return 0;
    }
    const extensionDir = getBundledPiExtensionPath();
    const installScope = options?.global ? 'globally' : 'for this project';
    const args = ['install', extensionDir, ...(options?.global ? [] : ['-l'])];
    console.log(`Installing Rorca Pi extension ${installScope}...`);
    const result = await runCommand(resolvePiBinPath(), args, { stdio: 'inherit' });
    if (result.code !== 0) {
        return result.code;
    }
    console.log(green(`Installed Rorca Pi extension ${installScope}.`));
    console.log('');
    console.log('Next steps:');
    console.log(options?.global ? '  1. Open Pi in the session where you want Rorca commands.' : '  1. Open Pi in this project.');
    console.log('  2. Run /rorca-help to verify the commands are loaded.');
    console.log('  3. If Pi was already open, run /reload.');
    console.log('  4. If the commands still do not appear, restart Pi.');
    console.log('');
    console.log(dim(`Advanced/dev fallback: pi install ${extensionDir} ${options?.global ? '' : '-l'}`.trim()));
    return 0;
}
async function waitForGeneratedSpec(jobId) {
    const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    const startMs = Date.now();
    const ticker = setInterval(() => {
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
        const frame = spinFrames[spinIdx++ % spinFrames.length];
        process.stdout.write(`\r${frame}  Generating spec… ${dim(`${elapsed}s`)}`);
    }, 100);
    try {
        for (;;) {
            const status = await fetchJson(`/api/specs/generate/job/${encodeURIComponent(jobId)}`);
            if (status.status === 'done') {
                clearInterval(ticker);
                const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
                process.stdout.write(`\r${green('✓')}  Spec generated  ${dim(`(${elapsed}s)`)}\n`);
                return status;
            }
            if (status.status === 'failed') {
                clearInterval(ticker);
                process.stdout.write(`\r${red('✗')}  Spec generation failed\n`);
                throw new Error(status.error || 'Spec generation failed.');
            }
            await sleep(2000);
        }
    }
    catch (err) {
        clearInterval(ticker);
        throw err;
    }
}
async function runForge(brief, options) {
    const workspace = await getDefaultWorkspace();
    process.stdout.write(`${dim('⠋')}  Forging spec… `);
    const genStart = Date.now();
    const generated = await fetchJson('/api/specs/forge', {
        method: 'POST',
        body: JSON.stringify({
            brief,
            workspaceId: workspace.id,
            ...(options.agent ? { agentOverride: options.agent } : {}),
            ...(options.model ? { model: options.model } : {}),
        }),
    }, 120_000);
    const specSlug = typeof generated.slug === 'string' ? generated.slug : undefined;
    if (specSlug) {
        const elapsed = ((Date.now() - genStart) / 1000).toFixed(1);
        process.stdout.write(`\r${green('✓')}  Spec forged  ${dim(`(${elapsed}s)`)}\n`);
    }
    if (!specSlug) {
        throw new Error('Spec forge completed without a slug.');
    }
    const spec = await fetchJson(`/api/specs/${encodeURIComponent(specSlug)}?workspaceId=${encodeURIComponent(workspace.id)}`);
    const stories = (Array.isArray(spec.userStories) ? spec.userStories : Array.isArray(spec.stories) ? spec.stories : []);
    console.log(`${bold(specSlug)} in workspace ${workspace.label || workspace.id}`);
    if (stories.length > 0) {
        printTable(['Story', 'Title'], stories.map((story) => [story.id, story.title]));
    }
    if (options.approve || options.run) {
        await fetchJson(`/api/specs/${encodeURIComponent(specSlug)}/approve`, {
            method: 'POST',
            body: JSON.stringify({ workspaceId: workspace.id }),
        });
        console.log(green(`Approved ${specSlug}`));
    }
    if (options.run) {
        return runSpec({ specSlug, tail: true });
    }
    return 0;
}
async function runTui() {
    const entry = path.join(BACKEND_DIR, 'bin', 'forge.ts');
    const result = await runCommand('npx', ['tsx', entry], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
    });
    return result.code;
}
const program = new Command();
program
    .name('rorca')
    .description('Rorca CLI')
    .version(pkg.version);
program
    .command('start')
    .option('--port <port>', 'Port to bind', '3030')
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--no-db', 'Skip Docker sidecar management')
    .action(async (options) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${options.port}`);
    }
    await startServer({ port, host: options.host, noDb: options.db === false });
});
program
    .command('init')
    .option('--path <dir>', 'Target directory', process.cwd())
    .option('--auto-install-pi', 'Install pi automatically with npm in non-interactive environments')
    .option('--skip-docker', 'Skip Docker database setup')
    .action(async (options) => {
    process.exitCode = await runInit(options.path, {
        autoInstallPi: Boolean(options.autoInstallPi),
        skipDocker: Boolean(options.skipDocker),
    });
});
program
    .command('chat')
    .option('--model <model>', 'Pi model override')
    .option('--workspace-id <id>', 'Workspace to inject context from')
    .action(async (options) => {
    process.exitCode = await runChat(options);
});
program
    .command('run <specSlug>')
    .option('--story <id>', 'Run a single story')
    .option('--dry-run', 'Return dry-run estimate only')
    .option('--agent <agent>', 'Execution agent override')
    .option('--model <model>', 'Model override')
    .option('--sequential', 'Force sequential execution (parallelism = 1)')
    .option('--tail', 'Tail raw run output alongside WAL lifecycle events')
    .action(async (specSlug, options) => {
    const code = await runSpec({
        specSlug,
        story: options.story,
        dryRun: options.dryRun,
        agent: options.agent,
        model: options.model,
        forceSequential: options.sequential,
        tail: options.tail,
    });
    process.exitCode = code;
});
program
    .command('status')
    .option('--run-id <id>', 'Show one run in detail')
    .action(async (options) => {
    await runStatus(options.runId ? Number(options.runId) : undefined);
});
program
    .command('attach <runId>')
    .description('Attach to an active run')
    .action(async (runId) => {
    const parsedRunId = Number(runId);
    if (!Number.isInteger(parsedRunId) || parsedRunId < 1) {
        console.log(`No active run with ID ${runId}`);
        process.exitCode = 1;
        return;
    }
    process.exitCode = await attachLiveRun(parsedRunId);
});
program
    .command('doctor')
    .option('--json', 'Emit JSON output')
    .option('--check <name>', 'Run a single named check')
    .option('--verbose', 'Show verbose detail output')
    .action(async (options) => {
    process.exitCode = await runDoctor(options);
});
const auth = program.command('auth').description('Manage provider authentication (via pi — Rorca\'s execution engine)');
auth
    .action(async () => {
    process.exitCode = await runPiAuthStatus();
});
auth
    .command('status')
    .action(async () => {
    process.exitCode = await runPiAuthStatus();
});
auth
    .command('login [provider]')
    .action(async (provider) => {
    process.exitCode = await runPiAuthCommand('login', provider);
});
auth
    .command('logout [provider]')
    .action(async (provider) => {
    process.exitCode = await runPiAuthCommand('logout', provider);
});
auth
    .command('install')
    .action(() => {
    printPiInstallMethods();
});
const pi = program.command('pi').description('Manage Pi integration and the Rorca Pi extension');
pi
    .command('install')
    .option('--global', 'Install the extension for all Pi sessions instead of the current project')
    .action(async (options) => {
    process.exitCode = await runPiExtensionInstall({ global: Boolean(options.global) });
});
program
    .command('forge <brief...>')
    .option('--approve', 'Approve generated spec')
    .option('--run', 'Approve and immediately trigger the run')
    .option('--agent <agent>', 'Forge runtime override (claude|opencode|codex|pi)')
    .option('--model <model>', 'Forge model override')
    .action(async (briefParts, options) => {
    process.exitCode = await runForge(briefParts.join(' '), options);
});
program
    .command('tui')
    .action(async () => {
    process.exitCode = await runTui();
});
const mcp = program.command('mcp').description('Manage MCP HTTP authentication');
mcp
    .command('token')
    .option('--admin', 'Print the admin token instead of the public token')
    .action(async (options) => {
    process.exitCode = await runMcpToken(options);
});
mcp
    .command('setup-claude')
    .option('--admin', 'Configure Claude to use the admin token instead of the public token')
    .action(async (options) => {
    process.exitCode = await runMcpSetupClaude(options);
});
mcp
    .command('rotate-token')
    .option('--public', 'Rotate only the public token (default)')
    .option('--admin', 'Rotate only the admin token')
    .option('--all', 'Rotate both public and admin tokens')
    .action(async (options) => {
    process.exitCode = await runMcpRotateToken(options);
});
mcp
    .command('status')
    .action(async () => {
    process.exitCode = await runMcpStatus();
});
mcp
    .command('diagnose-clients')
    .description('Scan known MCP client configs for broken Rorca OAuth-era entries')
    .action(async () => {
    process.exitCode = await runMcpDiagnoseClients();
});
const db = program.command('db').description('Manage the Docker Postgres sidecar');
db.command('start').action(async () => {
    await handleDbCommand('start');
});
db.command('stop').action(async () => {
    await handleDbCommand('stop');
});
db.command('status').action(async () => {
    await handleDbCommand('status');
});
db.command('reset')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (options) => {
    await handleDbCommand('reset', { yes: Boolean(options.yes) });
});
db.command('logs')
    .option('--tail <lines>', 'Tail line count', '100')
    .action(async (options) => {
    await handleDbCommand('logs', { tail: Number(options.tail) || 100 });
});
program.showHelpAfterError();
program.parseAsync(process.argv).catch((error) => {
    if (error instanceof PrintedCliError) {
        process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
