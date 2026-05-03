#!/usr/bin/env node

import { Command } from 'commander';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const API_BASE = (process.env.RORCA_API_URL || 'http://127.0.0.1:3030').replace(/\/$/, '');
const DB_CONTAINER = 'rorca-db';
const DB_VOLUME = 'rorca-db-data';
const DB_IMAGE = 'apache/age:latest';

const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

type Workspace = {
  id: string;
  label: string;
  path: string;
};

type PaginatedResponse<T> = {
  items: T[];
  total: number;
  hasMore?: boolean;
  cursor?: string;
};

type ArchiveSpec = {
  id: string;
  specName: string;
  status: string;
  storyCount: number;
};

type TriggerResponse =
  | { ok: true; runId: number; queued?: boolean; position?: number }
  | { queued: true; runId: number; position?: number }
  | { conflict: true; activeRunId: number }
  | { dryRun: true; estimate: unknown };

type PipelineRun = {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
};

type StoryResult = {
  story_id: string;
  status: 'pass' | 'fail' | 'skip' | 'retry';
};

type RunDetails = {
  run: PipelineRun;
  stories: StoryResult[];
  specStories?: Array<{ id: string }>;
};

type WalEvent = {
  id: number;
  event_type: string;
  workspace_id: string | null;
  spec_id: string | null;
  story_id: string | null;
  payload: string | null;
};

type DoctorResponse = {
  summary: {
    errors: number;
    warnings: number;
    ok: number;
    message: string;
  };
  checks: Array<{
    label: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    fix?: string;
  }>;
};

function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}

function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}

function yellow(text: string): string {
  return `\x1b[33m${text}\x1b[0m`;
}

function cyan(text: string): string {
  return `\x1b[36m${text}\x1b[0m`;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSpecFromPath(specPath: string): string {
  return path.basename(specPath, '.json');
}

function formatDate(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] || '').length)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, index) => (cell || '').padEnd(widths[index])).join('  ');

  console.log(render(headers.map((header) => bold(header))));
  console.log(render(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) {
    console.log(render(row));
  }
}

function spawnLogged(
  label: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const prefix = `[${label}] `;
  const pipe = (stream: NodeJS.ReadableStream | null, target: NodeJS.WriteStream) => {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
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

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'pipe';
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
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
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code: number | null) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function docker(args: string[], stdio: 'inherit' | 'pipe' = 'pipe') {
  return runCommand('docker', args, { stdio });
}

async function requireDocker(): Promise<void> {
  const result = await docker(['info']);
  if (result.code !== 0) {
    throw new Error('Docker is required. Start Docker Desktop or OrbStack first.');
  }
}

async function inspectDbContainer(): Promise<{ exists: boolean; running: boolean }> {
  const result = await docker(['inspect', DB_CONTAINER, '--format', '{{.State.Running}}']);
  if (result.code !== 0) {
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout === 'true' };
}

async function waitForDatabaseReady(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await docker(['exec', DB_CONTAINER, 'pg_isready', '-U', 'rorca', '-d', 'rorca']);
    if (result.code === 0) {
      return;
    }
    await sleep(1000);
  }
  throw new Error('Database container did not become ready within 30s.');
}

async function enableDbExtensions(): Promise<void> {
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

async function handleDbCommand(
  action: 'start' | 'stop' | 'status' | 'reset' | 'logs',
  options: { tail?: number; yes?: boolean; quiet?: boolean } = {},
): Promise<void> {
  if (action === 'start') {
    await requireDocker();
    const state = await inspectDbContainer();
    if (!state.exists) {
      if (!options.quiet) console.log('Starting Docker Postgres sidecar...');
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
    } else if (!state.running) {
      if (!options.quiet) console.log('Starting existing database container...');
      const result = await docker(['start', DB_CONTAINER]);
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || 'Failed to start existing database container.');
      }
    } else if (!options.quiet) {
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

async function fetchJson<T>(pathname: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
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
        const parsed = JSON.parse(text) as { error?: string };
        message = parsed.error || message;
      } catch {
        // Keep raw text message.
      }
      throw new Error(message);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function parseWalPayload(event: WalEvent): Record<string, unknown> {
  if (!event.payload) return {};
  try {
    return JSON.parse(event.payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readSse(
  pathname: string,
  onEvent: (eventName: string, data: string) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
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
    if (done) break;
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
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      await onEvent(eventName, dataLines.join('\n'));
    }
  }
}

async function getWorkspaces(): Promise<Workspace[]> {
  const response = await fetchJson<PaginatedResponse<Workspace>>('/api/workspaces');
  return response.items;
}

async function getDefaultWorkspace(): Promise<Workspace> {
  const workspaces = await getWorkspaces();
  if (workspaces.length === 0) {
    throw new Error('No workspaces registered. Add one in the UI first.');
  }
  return workspaces[0];
}

async function resolveApprovedSpec(specSlug: string): Promise<{ workspace: Workspace; spec: ArchiveSpec }> {
  const workspaces = await getWorkspaces();
  if (workspaces.length === 0) {
    throw new Error('No workspaces registered. Add one in the UI first.');
  }

  const matches: Array<{ workspace: Workspace; spec: ArchiveSpec }> = [];
  for (const workspace of workspaces) {
    const specs = await fetchJson<PaginatedResponse<ArchiveSpec>>(
      `/api/specs?workspaceId=${encodeURIComponent(workspace.id)}&status=approved`,
    );
    const match = specs.items.find((spec) => spec.id === specSlug);
    if (match) {
      matches.push({ workspace, spec: match });
    }
  }

  if (matches.length === 0) {
    throw new Error(`Approved spec "${specSlug}" not found.`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Spec slug "${specSlug}" exists in multiple workspaces: ${matches.map((match) => match.workspace.id).join(', ')}.`,
    );
  }

  return matches[0];
}

async function ensureFrontendBuild(): Promise<void> {
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

async function startServer(options: { port: number; host: string; noDb: boolean }): Promise<void> {
  if (!options.noDb) {
    await handleDbCommand('start', { quiet: true });
  } else {
    console.log('Skipping Docker database sidecar.');
  }

  await ensureFrontendBuild();

  const env: NodeJS.ProcessEnv = {
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

  const shutdown = (signal: NodeJS.Signals) => {
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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    worker.once('error', reject);
    server.once('exit', (code: number | null) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(`Server exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function runInit(targetPath: string): Promise<void> {
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
    writeFileSync(
      agentsPath,
      [
        '# AGENTS.md',
        '',
        'Project guidance for Rorca runs in this workspace.',
        '',
        '## Rules',
        '- Keep changes scoped to the requested task.',
        '- Prefer project conventions already present in the codebase.',
        '',
      ].join('\n'),
    );
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
}

function formatWalLine(event: WalEvent): string | null {
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

async function streamWal(runId: number, signal: AbortSignal): Promise<{ finalEvent: WalEvent | null }> {
  let finalEvent: WalEvent | null = null;

  await readSse(
    '/api/pipeline/stream',
    async (eventName, data) => {
      if (eventName !== 'wal_event') return;

      const event = JSON.parse(data) as WalEvent;
      const payload = parseWalPayload(event);
      if (Number(payload.run_id) !== runId) return;

      const line = formatWalLine(event);
      if (line) console.log(line);

      if (event.event_type === 'run_finished' || event.event_type === 'run_cancelled') {
        finalEvent = event;
        throw new Error('__RORCA_RUN_COMPLETE__');
      }
    },
    signal,
  ).catch((error: unknown) => {
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

async function streamRawOutput(runId: number, signal: AbortSignal): Promise<void> {
  await readSse(
    `/api/pipeline/runs/${runId}/output`,
    async (eventName, data) => {
      if (eventName !== 'chunk') return;
      const text = Buffer.from(data, 'base64').toString('utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log(dim(`│ ${line}`));
      }
    },
    signal,
  ).catch((error: unknown) => {
    if (signal.aborted) {
      return;
    }
    throw error;
  });
}

async function runSpec(options: {
  specSlug: string;
  story?: string;
  dryRun?: boolean;
  agent?: 'claude' | 'opencode' | 'codex' | 'pi';
  model?: string;
  tail?: boolean;
}): Promise<number> {
  const { workspace } = await resolveApprovedSpec(options.specSlug);
  const trigger = await fetchJson<TriggerResponse>('/api/pipeline/trigger', {
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

  const walController = new AbortController();
  const outputController = new AbortController();

  let cancelling = false;
  const cancelRun = async () => {
    if (cancelling) return;
    cancelling = true;
    console.log('Cancelling run...');
    try {
      await fetchJson(`/api/pipeline/runs/${runId}/cancel`, { method: 'POST' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
    } finally {
      walController.abort();
      outputController.abort();
    }
  };

  const onSigint = () => {
    void cancelRun();
  };
  process.once('SIGINT', onSigint);

  try {
    const walPromise = streamWal(runId, walController.signal);
    const outputPromise = options.tail ? streamRawOutput(runId, outputController.signal) : Promise.resolve();

    await walPromise;
    outputController.abort();
    await Promise.race([outputPromise, sleep(200)]);

    const details = await fetchJson<RunDetails>(`/api/pipeline/runs/${runId}`);
    const failed = details.run.status === 'failed'
      || details.run.status === 'cancelled'
      || details.run.status === 'partial_failure'
      || details.stories.some((story) => story.status === 'fail');

    return failed ? 1 : 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
    walController.abort();
    outputController.abort();
  }
}

async function runStatus(runId?: number): Promise<void> {
  if (runId) {
    const details = await fetchJson<RunDetails>(`/api/pipeline/runs/${runId}`);
    console.log(`Run ${details.run.id}`);
    console.log(`Status: ${details.run.status}`);
    console.log(`Spec: ${formatSpecFromPath(details.run.spec_path)}`);
    console.log(`Started: ${formatDate(details.run.started_at)}`);
    console.log(`Finished: ${formatDate(details.run.finished_at)}`);
    console.log('');

    const rows = details.stories.map((story) => [story.story_id, story.status]);
    if (rows.length > 0) {
      printTable(['Story', 'Status'], rows);
    } else {
      console.log('No story results yet.');
    }
    return;
  }

  const workspaces = await getWorkspaces();
  const runs: Array<PipelineRun & { workspaceLabel: string }> = [];

  for (const workspace of workspaces) {
    const response = await fetchJson<PaginatedResponse<PipelineRun>>(
      `/api/pipeline/runs?workspaceId=${encodeURIComponent(workspace.id)}&limit=10`,
    );
    for (const run of response.items) {
      runs.push({ ...run, workspaceLabel: workspace.id });
    }
  }

  runs.sort((a, b) => b.id - a.id);

  const topRuns = runs.slice(0, 10);
  const rows: string[][] = [];
  for (const run of topRuns) {
    const details = await fetchJson<RunDetails>(`/api/pipeline/runs/${run.id}`);
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

async function runDoctor(json = false): Promise<number> {
  const localChecks: Array<{ label: string; status: 'ok' | 'warning' | 'error'; message: string; fix?: string }> = [];

  const dockerInfo = await docker(['info']);
  localChecks.push(
    dockerInfo.code === 0
      ? { label: 'Docker running', status: 'ok', message: 'OK' }
      : { label: 'Docker running', status: 'error', message: 'Docker not running', fix: 'Start Docker Desktop or OrbStack' },
  );

  const backendHealth = await fetch(`${API_BASE}/api/health`).catch(() => null);
  localChecks.push(
    backendHealth?.ok
      ? { label: 'Backend reachable', status: 'ok', message: 'OK' }
      : { label: 'Backend reachable', status: 'error', message: 'Backend not running', fix: 'Run: rorca start' },
  );

  if (json) {
    const remote = await fetchJson<DoctorResponse>('/api/doctor');
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

  const remote = await fetchJson<DoctorResponse>('/api/doctor');
  for (const check of remote.checks) {
    const prefix = check.status === 'ok' ? green('OK') : check.status === 'warning' ? yellow('WARN') : red('ERR');
    console.log(`${prefix} ${check.label}: ${check.message}`);
    if (check.fix) {
      console.log(dim(`    fix: ${check.fix}`));
    }
  }

  return remote.summary.errors > 0 ? 1 : 0;
}

async function runAuth(action: 'login' | 'logout' | 'status', provider: string): Promise<void> {
  if (provider === 'pi') {
    const args = ['auth', action];
    const result = await runCommand('pi', args, { stdio: action === 'status' ? 'pipe' : 'inherit' });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `pi auth ${action} failed`);
    }
    if (action === 'status' && result.stdout) {
      console.log(result.stdout);
    }
    return;
  }

  if (provider === 'claude' || provider === 'codex') {
    if (action === 'status') {
      const state = await fetchJson<Record<string, unknown>>(`/api/config/${provider}-auth`);
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    const response = await fetchJson<{ ok: boolean; message?: string }>(
      `/api/config/${provider}-auth/${action}`,
      { method: 'POST' },
    );
    console.log(response.message || `${provider} ${action} complete`);
    return;
  }

  throw new Error(`Unsupported provider "${provider}". Use pi, claude, or codex.`);
}

async function waitForGeneratedSpec(jobId: string): Promise<{ slug?: string }> {
  for (;;) {
    const status = await fetchJson<{
      jobId: string;
      status: string;
      slug?: string;
      error?: string;
    }>(`/api/specs/generate/job/${encodeURIComponent(jobId)}`);

    if (status.status === 'done') {
      return status;
    }
    if (status.status === 'failed') {
      throw new Error(status.error || 'Spec generation failed.');
    }
    await sleep(2000);
  }
}

async function runForge(brief: string, options: { approve?: boolean; run?: boolean }): Promise<number> {
  const workspace = await getDefaultWorkspace();
  const generated = await fetchJson<Record<string, unknown>>('/api/specs/generate', {
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

  const spec = await fetchJson<Record<string, unknown>>(`/api/specs/${encodeURIComponent(specSlug)}?workspaceId=${encodeURIComponent(workspace.id)}`);
  const stories = (Array.isArray(spec.userStories) ? spec.userStories : Array.isArray(spec.stories) ? spec.stories : []) as Array<{
    id: string;
    title: string;
  }>;

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

async function runTui(): Promise<number> {
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
  .action(async (options: { port: string; host: string; db: boolean }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${options.port}`);
    }
    await startServer({ port, host: options.host, noDb: options.db === false });
  });

program
  .command('init')
  .option('--path <dir>', 'Target directory', process.cwd())
  .action(async (options: { path: string }) => {
    await runInit(options.path);
  });

program
  .command('run <specSlug>')
  .option('--story <id>', 'Run a single story')
  .option('--dry-run', 'Return dry-run estimate only')
  .option('--agent <agent>', 'Execution agent override')
  .option('--model <model>', 'Model override')
  .option('--tail', 'Tail raw run output alongside WAL lifecycle events')
  .action(async (specSlug: string, options: { story?: string; dryRun?: boolean; agent?: 'claude' | 'opencode' | 'codex' | 'pi'; model?: string; tail?: boolean }) => {
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
  .action(async (options: { runId?: string }) => {
    await runStatus(options.runId ? Number(options.runId) : undefined);
  });

program
  .command('doctor')
  .option('--json', 'Emit JSON output')
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await runDoctor(Boolean(options.json));
  });

program
  .command('auth [action]')
  .option('--provider <name>', 'Auth provider', 'pi')
  .action(async (action: 'login' | 'logout' | 'status' | undefined, options: { provider: string }) => {
    await runAuth(action ?? 'status', options.provider);
  });

program
  .command('forge <brief...>')
  .option('--approve', 'Approve generated spec')
  .option('--run', 'Approve and immediately trigger the run')
  .action(async (briefParts: string[], options: { approve?: boolean; run?: boolean }) => {
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
  .action(async (options: { yes?: boolean }) => {
    await handleDbCommand('reset', { yes: Boolean(options.yes) });
  });

db.command('logs')
  .option('--tail <lines>', 'Tail line count', '100')
  .action(async (options: { tail: string }) => {
    await handleDbCommand('logs', { tail: Number(options.tail) || 100 });
  });

program.showHelpAfterError();

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
