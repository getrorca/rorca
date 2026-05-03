#!/usr/bin/env node
import { Command } from 'commander';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { execa } from 'execa';
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
    github: 'GitHub Copilot',
    copilot: 'GitHub Copilot',
    'github copilot': 'GitHub Copilot',
    google: 'Gemini',
    gemini: 'Gemini',
    openrouter: 'OpenRouter',
};
const PI_PROVIDER_ORDER = [
    'ChatGPT Plus/Pro',
    'Claude',
    'GitHub Copilot',
    'Gemini',
    'OpenRouter',
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
async function fetchJson(pathname, init, timeoutMs = 30_000) {
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
async function fetchBackendHealth() {
    return fetchJson('/api/health');
}
async function spawnInteractivePi(piBinPath, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(piBinPath, args, {
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
async function runChat(options) {
    let workspaceName = options.workspaceId ?? 'default';
    let tempSkillFile = null;
    let tempExtensionFile = null;
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
        writeFileSync(tempSkillFile, `${direction.synthesized.trim()}\n`, 'utf8');
        tempExtensionFile = path.join(tmpdir(), `rorca-pi-mcp-bridge-${Date.now()}-${process.pid}.ts`);
        writeFileSync(tempExtensionFile, buildRorcaPiMcpExtension(health.mcp.url), 'utf8');
    }
    catch (error) {
        if (isBackendUnavailableError(error)) {
            throw new Error('Rorca backend is required for `rorca chat`. Start `npm run dev` or `rorca start` first.');
        }
        throw error;
    }
    const args = [
        ...(tempSkillFile ? ['--skill', tempSkillFile] : []),
        ...(tempExtensionFile ? ['--extension', tempExtensionFile] : []),
        ...(options.model ? ['--model', options.model] : []),
    ];
    console.log('─── Rorca Chat ───────────────────────────────────────────────');
    console.log(`Workspace: ${workspaceName}  Agent: pi  Model: ${options.model ?? 'default'}  Context: ${tempSkillFile ? 'L1-L5 injected' : 'not injected'}  MCP: ${health.mcp.url}`);
    console.log('─────────────────────────────────────────────────────────────');
    try {
        return await spawnInteractivePi(resolvePiBinPath(health.piBinPath), args);
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            printPiInstallMethods();
        }
        throw error;
    }
    finally {
        cleanupTempFile(tempSkillFile);
        cleanupTempFile(tempExtensionFile);
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
async function runInit(targetPath, options) {
    const pi = await ensurePiInstalled({ autoInstall: options?.autoInstallPi });
    if (!pi.ok) {
        return 1;
    }
    const root = path.resolve(targetPath);
    const rorcaDir = path.join(root, '.rorca');
    const skillsDir = path.join(rorcaDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const configPath = path.join(rorcaDir, 'config.json');
    const agentsPath = path.join(root, 'AGENTS.md');
    const memoryPath = path.join(root, 'MEMORY.md');
    if (!existsSync(configPath)) {
        writeFileSync(configPath, '{}\n');
    }
    if (!existsSync(agentsPath)) {
        writeFileSync(agentsPath, [
            '# AGENTS.md',
            '',
            'Project guidance for Rorca runs in this workspace.',
            '',
            '## Rules',
            '- Keep changes scoped to the requested task.',
            '- Prefer project conventions already present in the codebase.',
            '',
        ].join('\n'));
    }
    if (!existsSync(memoryPath)) {
        writeFileSync(memoryPath, '# Memory Ledger\n\n');
    }
    console.log(`Initialized Rorca workspace files in ${root}`);
    console.log(`- ${path.relative(root, configPath)}`);
    console.log(`- ${path.relative(root, agentsPath)}`);
    console.log(`- ${path.relative(root, memoryPath)}`);
    console.log(`- ${path.relative(root, skillsDir)}/`);
    console.log('');
    console.log('Next steps:');
    console.log('1. Register this workspace in Rorca if you have not already.');
    console.log('2. Run rorca start to launch.');
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
async function runDoctor(json = false) {
    const localChecks = [];
    const dockerInfo = await docker(['info']);
    localChecks.push(dockerInfo.code === 0
        ? { label: 'Docker running', status: 'ok', message: 'OK' }
        : { label: 'Docker running', status: 'error', message: 'Docker not running', fix: 'Start Docker Desktop or OrbStack' });
    const backendHealth = await fetchBackendHealth().catch(() => null);
    localChecks.push(backendHealth
        ? { label: 'Backend reachable', status: 'ok', message: 'OK' }
        : { label: 'Backend reachable', status: 'error', message: 'Backend not running', fix: 'Run: rorca start' });
    if (backendHealth) {
        if (backendHealth.mcp?.status === 'healthy' && backendHealth.mcp.enabled) {
            localChecks.push({
                label: 'Rorca MCP bridge',
                status: 'ok',
                message: `OK (${backendHealth.mcp.url})`,
            });
        }
        else {
            localChecks.push({
                label: 'Rorca MCP bridge',
                status: backendHealth.mcp?.status === 'disabled' ? 'error' : 'warning',
                message: 'Rorca MCP bridge not connected — pi will run without Rorca tools',
                fix: backendHealth.mcp?.status === 'disabled'
                    ? 'Start backend with RORCA_SERVE_MCP=1 (or unset RORCA_SERVE_MCP)'
                    : 'Start `npm run dev` or `rorca start` so /mcp is reachable',
            });
        }
    }
    if (json) {
        const remote = await fetchJson('/api/doctor');
        console.log(JSON.stringify({ localChecks, remote }, null, 2));
        return remote.summary.errors > 0 ? 1 : 0;
    }
    for (const check of localChecks) {
        const prefix = check.status === 'ok' ? green('OK') : check.status === 'warning' ? yellow('WARN') : red('ERR');
        console.log(`${prefix} ${check.label}: ${check.message}`);
        if (check.fix) {
            console.log(dim(`    fix: ${check.fix}`));
        }
    }
    if (localChecks.some((check) => check.status === 'error')) {
        return 1;
    }
    const remote = await fetchJson('/api/doctor');
    for (const check of remote.checks) {
        const prefix = check.status === 'ok' ? green('OK') : check.status === 'warning' ? yellow('WARN') : red('ERR');
        console.log(`${prefix} ${check.label}: ${check.message}`);
        if (check.fix) {
            console.log(dim(`    fix: ${check.fix}`));
        }
    }
    return remote.summary.errors > 0 ? 1 : 0;
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
async function waitForGeneratedSpec(jobId) {
    for (;;) {
        const status = await fetchJson(`/api/specs/generate/job/${encodeURIComponent(jobId)}`);
        if (status.status === 'done') {
            return status;
        }
        if (status.status === 'failed') {
            throw new Error(status.error || 'Spec generation failed.');
        }
        await sleep(2000);
    }
}
async function runForge(brief, options) {
    const workspace = await getDefaultWorkspace();
    const generated = await fetchJson('/api/specs/generate', {
        method: 'POST',
        body: JSON.stringify({
            brief,
            workspaceId: workspace.id,
        }),
    }, 120_000);
    let specSlug = typeof generated.slug === 'string' ? generated.slug : undefined;
    if (!specSlug && typeof generated.jobId === 'string') {
        const completed = await waitForGeneratedSpec(generated.jobId);
        specSlug = completed.slug;
    }
    if (!specSlug) {
        throw new Error('Spec generation completed without a slug.');
    }
    const spec = await fetchJson(`/api/specs/${encodeURIComponent(specSlug)}?workspaceId=${encodeURIComponent(workspace.id)}`);
    const stories = (Array.isArray(spec.userStories) ? spec.userStories : Array.isArray(spec.stories) ? spec.stories : []);
    console.log(`${bold(specSlug)} in workspace ${workspace.id}`);
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
    .action(async (options) => {
    process.exitCode = await runInit(options.path, { autoInstallPi: Boolean(options.autoInstallPi) });
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
    .option('--tail', 'Tail raw run output alongside WAL lifecycle events')
    .action(async (specSlug, options) => {
    const code = await runSpec({
        specSlug,
        story: options.story,
        dryRun: options.dryRun,
        agent: options.agent,
        model: options.model,
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
    .action(async (options) => {
    process.exitCode = await runDoctor(Boolean(options.json));
});
const auth = program.command('auth').description('Manage Pi authentication');
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
program
    .command('forge <brief...>')
    .option('--approve', 'Approve generated spec')
    .option('--run', 'Approve and immediately trigger the run')
    .action(async (briefParts, options) => {
    process.exitCode = await runForge(briefParts.join(' '), options);
});
program
    .command('tui')
    .action(async () => {
    process.exitCode = await runTui();
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
