/**
 * execution-engine.ts — Universal TypeScript execution engine for the Ralph Loop.
 *
 * Replaces both run-loop.sh and run-loop.ts. Supports three agent types:
 *   - claude:   `claude --dangerously-skip-permissions --print --verbose --output-format stream-json`
 *   - opencode: `opencode run --format json --attach <socket> --model <model>`
 *   - codex:    `codex --approval-mode auto-edit`
 *
 * Agent type is read from config (RORCA_AGENT env var via config.ts, default: claude).
 * ATTACH_ADDR for opencode is passed via function argument from opencode-server.ts,
 * NOT from env vars.
 *
 * Usage (spawned by pipeline.ts):
 *   npx tsx backend/src/lib/execution-engine.ts --json <path> --cwd <path> --run-id <N>
 *
 * Flags:
 *   --json <path>           Spec JSON file (required)
 *   --cwd <path>            Working directory / workspace root (required)
 *   --run-id <number>       Pipeline run ID for WAL event reporting (required)
 *   --story <id>            Run a single specific story
 *   --dry-run               Preview next story without executing
 *   --port <number>         Backend port for WAL events (default: 3030)
 *   --parallelism <N>       Max concurrent story subprocesses per wave (1–10, default: 1)
 *   --agent <type>          Override RORCA_AGENT (claude|opencode|codex)
 *   --model <model>         Override RORCA_MODEL (e.g. openai/gpt-4o)
 *   --attach <addr>         OpenCode server socket address (passed by pipeline.ts)
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileWaves, isCycleError } from './wave-compiler';
import type { Wave, UserStory as WaveUserStory } from './wave-compiler';
import { parseAgentConfig, type AgentType } from './config';
import { detectOpenCode } from './opencode-detector';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  acceptance?: string;
  dependsOn?: string[];
  passes?: boolean;
  status?: string;
  skipped?: boolean;
  excluded?: boolean;
  notes?: string;
  priority?: number;
  timeoutMinutes?: number;
}

interface SpecJson {
  title?: string;
  mode?: string;
  playbook?: string;
  model?: string;
  userStories?: UserStory[];
  phases?: Array<{ stories: UserStory[] }>;
}

interface EngineConfig {
  jsonPath: string;
  cwd: string;
  runId: number;
  specificStory?: string;
  dryRun: boolean;
  port: number;
  parallelism: number;
  agentType: AgentType;
  agentModel: string | null;
  attachAddr: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000];
const RATE_LIMIT_FAST_EXIT_THRESHOLD_MS = 5_000;
const DEFAULT_TIMEOUT_MINUTES = 45;

const CLAUDE_BIN = process.env.CLAUDE_BIN ||
  (() => {
    try {
      return execSync('which claude', { encoding: 'utf8' }).trim();
    } catch {
      return 'claude';
    }
  })();

const CODEX_BIN = process.env.CODEX_BIN ||
  (() => {
    try {
      return execSync('which codex', { encoding: 'utf8' }).trim();
    } catch {
      return 'codex';
    }
  })();

// Claude env vars that must be stripped to avoid nested-session detection
const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getStories(spec: SpecJson): UserStory[] {
  if (spec.userStories) return spec.userStories;
  const stories: UserStory[] = [];
  for (const phase of spec.phases ?? []) {
    for (const s of phase.stories ?? []) {
      stories.push(s);
    }
  }
  return stories;
}

function isPassed(story: UserStory): boolean {
  if (story.passes !== undefined) return Boolean(story.passes);
  return story.status === 'passed';
}

function getAcceptance(story: UserStory): string {
  if (story.acceptance) return story.acceptance;
  if (story.acceptanceCriteria?.length) {
    return story.acceptanceCriteria.map(a => `- ${a}`).join('\n');
  }
  return '';
}

function detectMode(spec: SpecJson): 'impl' | 'qa' | 'journey' {
  if (spec.mode) return spec.mode as 'impl' | 'qa' | 'journey';
  if (spec.phases) return 'qa';
  return 'impl';
}

function getProgress(stories: UserStory[]): { passed: number; total: number } {
  return {
    passed: stories.filter(isPassed).length,
    total: stories.length,
  };
}

function getNextStory(stories: UserStory[]): UserStory | null {
  const passedIds = new Set(stories.filter(isPassed).map(s => s.id));
  const sorted = [...stories].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));

  for (const story of sorted) {
    if (isPassed(story)) continue;
    if (story.skipped) continue;
    if (story.excluded) continue;
    const deps = story.dependsOn ?? [];
    if (deps.every(dep => passedIds.has(dep))) return story;
  }
  return null;
}

async function emitWalEvent(
  port: number,
  eventType: string,
  workspaceId: string,
  payload: Record<string, unknown>,
  storyId?: string,
  specId?: string,
): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/api/wal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: eventType,
        workspace_id: workspaceId,
        story_id: storyId ?? null,
        spec_id: specId ?? null,
        payload,
      }),
    });
  } catch {
    console.error(`[engine] Failed to emit WAL event: ${eventType}`);
  }
}

function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
      env[k] = v;
    }
  }
  return env;
}

function readWorkspaceFile(cwd: string, ...segments: string[]): string {
  try {
    return fs.readFileSync(path.join(cwd, ...segments), 'utf8');
  } catch {
    return '';
  }
}

function buildPrompt(
  story: UserStory,
  mode: 'impl' | 'qa' | 'journey',
  cwd: string,
  playbook?: string,
  agentType?: AgentType,
): string {
  const ac = getAcceptance(story);
  const acSection = ac ? `\nAcceptance Criteria:\n${ac}` : '';

  // OpenCode reads skill files from .opencode/skills/<name>/SKILL.md — instruct it to load direction stack
  const openCodeSkillInstruction = agentType === 'opencode'
    && fs.existsSync(path.join(cwd, '.opencode', 'skills', 'rorca', 'SKILL.md'))
    ? 'Read .opencode/skills/rorca/SKILL.md before starting work for project context and direction stack.\n'
    : '';

  if (mode === 'journey') {
    const journeySkill = playbook ? readWorkspaceFile(cwd, playbook) : '';
    return [
      'You are simulating real users navigating the application. Read CLAUDE.md for architecture.',
      openCodeSkillInstruction,
      '', journeySkill, '', '---', '',
      `Your task (${story.id}): ${story.title}`,
      '', story.description, acSection,
    ].join('\n');
  }

  if (mode === 'qa') {
    const playbookInstruction = playbook && fs.existsSync(path.join(cwd, playbook))
      ? `IMPORTANT: Read ${playbook} first for test patterns, conventions, and section references mentioned in the description.`
      : '';
    return [
      'You are writing tests for this project. Read CLAUDE.md for architecture and gotchas.',
      openCodeSkillInstruction,
      '', playbookInstruction, '',
      '## Workflow',
      '1. Read the relevant AGENTS.md in each directory you\'ll modify',
      '2. Read any referenced docs (Playbook sections, PRDs, SDDs)',
      '3. Write the tests described below',
      '4. Run the tests and fix failures until all pass',
      '5. Run type checks: npx tsc --noEmit (frontend) and cd backend && npx tsc --noEmit (backend)',
      '6. Run npm run build to verify build succeeds',
      '', '## Do NOT:',
      '- Implement features or modify production code (only test files)',
      '- Skip running the tests — every test must actually execute and pass',
      '- Write placeholder/todo tests — all tests must have real assertions',
      '', '---', '',
      `Your task (${story.id}): ${story.title}`,
      '', story.description, acSection,
    ].join('\n');
  }

  // Implementation mode
  const skillContent = readWorkspaceFile(cwd, '.claude', 'skills', 'rorca.md')
    || readWorkspaceFile(cwd, '.claude', 'skills', 'dimitri.md');
  return [
    'Follow this workflow for implementation:',
    openCodeSkillInstruction,
    '', skillContent, '', '---', '',
    `Your task (${story.id}):`,
    story.description, acSection,
  ].join('\n');
}

// ─── Agent Subprocess Spawning ──────────────────────────────────────────────

interface AgentResult {
  exitCode: number;
  stderrTail: string;
  elapsedMs: number;
}

/**
 * Spawn a story subprocess using the configured agent type.
 * All three paths use AbortController-style timeout (setTimeout + SIGTERM/SIGKILL).
 * Exit code captured from child process 'close'/'exit' event.
 */
function runAgent(
  agentType: AgentType,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null,
  attachAddr: string | null,
): Promise<AgentResult> {
  switch (agentType) {
    case 'claude':
      return spawnClaude(prompt, cwd, timeoutMs, logFile);
    case 'opencode':
      return spawnOpenCode(prompt, cwd, timeoutMs, logFile, agentModel, attachAddr);
    case 'codex':
      return spawnCodex(prompt, cwd, timeoutMs, logFile);
  }
}

/** Spawn `claude --print` (existing behavior from run-loop.ts) */
function spawnClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = buildCleanEnv();
    const startTime = Date.now();

    const args = [
      '--dangerously-skip-permissions',
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      prompt,
    ];

    const logFd = fs.openSync(logFile, 'a');
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env,
      stdio: ['ignore', logFd, 'pipe'],
    });
    fs.closeSync(logFd);

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      fs.appendFileSync(logFile, chunk);
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[engine] Failed to spawn claude: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      if (code === null) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });
  });
}

/**
 * Spawn `opencode run --format json --attach <addr> --model <model>`.
 * Prompt is passed via stdin. ATTACH_ADDR comes from function argument,
 * not from env vars.
 */
function spawnOpenCode(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null,
  attachAddr: string | null,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = buildCleanEnv();
    const startTime = Date.now();

    // Resolve opencode binary
    const status = detectOpenCode();
    const bin = status.opencodeBinPath ?? 'opencode';

    const args: string[] = ['run', '--format', 'json'];

    if (attachAddr) {
      args.push('--attach', attachAddr);
    }

    if (agentModel) {
      args.push('--model', agentModel);
    }

    const logFd = fs.openSync(logFile, 'a');
    // stdin: pipe (to send prompt), stdout: log file, stderr: pipe (capture)
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', logFd, 'pipe'],
    });
    fs.closeSync(logFd);

    // Write prompt to stdin then close
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      fs.appendFileSync(logFile, chunk);
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[engine] Failed to spawn opencode: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      if (code === null) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });
  });
}

/**
 * Spawn `codex --approval-mode auto-edit`.
 * Prompt is passed via stdin.
 */
function spawnCodex(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = buildCleanEnv();
    const startTime = Date.now();

    const args: string[] = ['--approval-mode', 'auto-edit'];

    const logFd = fs.openSync(logFile, 'a');
    // stdin: pipe (to send prompt), stdout: log file, stderr: pipe (capture)
    const child = spawn(CODEX_BIN, args, {
      cwd,
      env,
      stdio: ['pipe', logFd, 'pipe'],
    });
    fs.closeSync(logFd);

    // Write prompt to stdin then close
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      fs.appendFileSync(logFile, chunk);
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[engine] Failed to spawn codex: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      if (code === null) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });
  });
}

// ─── OpenCode Error Classification ──────────────────────────────────────────

type OpenCodeErrorCategory =
  | 'not_installed'
  | 'api_key_invalid'
  | 'model_not_available'
  | 'rate_limited'
  | 'server_crashed'
  | 'malformed_output'
  | 'timeout'
  | 'unknown';

interface ClassifiedError {
  category: OpenCodeErrorCategory;
  message: string;
  retryable: boolean;
}

/**
 * Classify an OpenCode failure into a user-facing error category.
 * Parses stderr and exit code to distinguish provider-level errors
 * from infrastructure errors.
 */
function classifyOpenCodeError(result: AgentResult): ClassifiedError {
  const lower = result.stderrTail.toLowerCase();
  const raw = result.stderrTail;

  // Binary not found (ENOENT from spawn)
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('no such file')) {
    return {
      category: 'not_installed',
      message: 'OpenCode binary not found. Install with: npm i -g opencode',
      retryable: false,
    };
  }

  // API key invalid (401/403 from provider)
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')
      || lower.includes('invalid_api_key') || lower.includes('authentication failed')
      || lower.includes('incorrect api key') || lower.includes('api key not valid')) {
    return {
      category: 'api_key_invalid',
      message: `Provider API key invalid or expired. Check your API key in Settings. ${extractProviderHint(raw)}`,
      retryable: false,
    };
  }

  // Model not available (404 or specific error messages)
  if (lower.includes('model not found') || lower.includes('model_not_found')
      || lower.includes('does not exist') || lower.includes('not available')
      || lower.includes('invalid model') || lower.includes('unknown model')
      || (lower.includes('404') && (lower.includes('model') || lower.includes('deployment')))) {
    return {
      category: 'model_not_available',
      message: `Model not available. Check that the model name is correct and you have access. ${extractModelHint(raw)}`,
      retryable: false,
    };
  }

  // Rate limiting (429 or explicit rate limit messages)
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('rate_limit')
      || lower.includes('too many requests') || lower.includes('overloaded')
      || lower.includes('quota exceeded') || lower.includes('tokens per min')) {
    const waitSeconds = extractRateLimitWait(raw);
    return {
      category: 'rate_limited',
      message: waitSeconds
        ? `Rate limited — waiting ${waitSeconds}s before retry`
        : 'Rate limited by provider — will retry with backoff',
      retryable: true,
    };
  }

  // Server/connection crash
  if (lower.includes('econnrefused') || lower.includes('econnreset')
      || lower.includes('socket hang up') || lower.includes('broken pipe')
      || lower.includes('server') && (lower.includes('crash') || lower.includes('died') || lower.includes('exited'))) {
    return {
      category: 'server_crashed',
      message: 'OpenCode server connection lost. The warm server may have crashed.',
      retryable: true,
    };
  }

  // Timeout (exit code 124 handled separately, but stderr may mention it)
  if (result.exitCode === 124) {
    return {
      category: 'timeout',
      message: 'Story execution timed out',
      retryable: false,
    };
  }

  // Default unknown error
  const snippet = raw.trim().slice(0, 200);
  return {
    category: 'unknown',
    message: snippet ? `OpenCode error: ${snippet}` : `OpenCode exited with code ${result.exitCode}`,
    retryable: result.exitCode !== 0,
  };
}

/** Extract provider name hint from error output */
function extractProviderHint(stderr: string): string {
  if (stderr.includes('openai') || stderr.includes('OpenAI')) return '(OpenAI)';
  if (stderr.includes('anthropic') || stderr.includes('Anthropic')) return '(Anthropic)';
  if (stderr.includes('google') || stderr.includes('Google') || stderr.includes('gemini')) return '(Google)';
  if (stderr.includes('openrouter') || stderr.includes('OpenRouter')) return '(OpenRouter)';
  return '';
}

/** Extract model name hint from error output */
function extractModelHint(stderr: string): string {
  const modelMatch = stderr.match(/model[:\s]+["']?([a-zA-Z0-9\-_./]+)["']?/i);
  return modelMatch ? `(requested: ${modelMatch[1]})` : '';
}

/** Extract retry-after seconds from rate limit response */
function extractRateLimitWait(stderr: string): number | null {
  // Match "retry-after: N" header or "retry after N seconds" message
  const retryAfterMatch = stderr.match(/retry[- ]after[:\s]+(\d+)/i);
  if (retryAfterMatch) return parseInt(retryAfterMatch[1], 10);
  // Match "wait N seconds" or "try again in N seconds"
  const waitMatch = stderr.match(/(?:wait|try again in|reset in)\s+(\d+)\s*(?:s|sec|second)/i);
  if (waitMatch) return parseInt(waitMatch[1], 10);
  return null;
}

// ─── Rate Limit Detection ───────────────────────────────────────────────────

function isRateLimited(result: AgentResult): boolean {
  if (result.exitCode === 0) return false;
  const lower = result.stderrTail.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('overloaded') || lower.includes('429')
      || lower.includes('too many requests') || lower.includes('quota exceeded')) return true;
  if (result.exitCode === 1 && result.elapsedMs < RATE_LIMIT_FAST_EXIT_THRESHOLD_MS) return true;
  return false;
}

// ─── Spec File Mutations ────────────────────────────────────────────────────

function markStoryPassed(jsonPath: string, storyId: string): void {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const spec: SpecJson = JSON.parse(raw);
  const stories = getStories(spec);

  for (const s of stories) {
    if (s.id === storyId) {
      if (spec.userStories || s.passes !== undefined) {
        s.passes = true;
        s.notes = 'Completed by Rorca engine';
      } else {
        s.status = 'passed';
      }
      break;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`Marked ${storyId} as passed`);
}

function markStorySkipped(jsonPath: string, storyId: string): void {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const spec: SpecJson = JSON.parse(raw);
  const stories = getStories(spec);

  for (const s of stories) {
    if (s.id === storyId) {
      s.skipped = true;
      s.notes = `Skipped after max retries — fix manually and re-run with --story ${storyId}`;
      break;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`Marked ${storyId} as skipped`);
}

// ─── Git Commit ─────────────────────────────────────────────────────────────

function gitCommitStory(
  cwd: string,
  storyId: string,
  storyTitle: string,
  mode: 'impl' | 'qa' | 'journey',
): void {
  const env = buildCleanEnv();
  const prefix = mode === 'qa' ? 'test' : mode === 'journey' ? 'journey' : 'feat';

  try {
    execSync('git add -A', { cwd, env, stdio: 'pipe' });
    execSync(
      `git commit -m "${prefix}(${storyId}): ${storyTitle.replace(/"/g, '\\"')}\n\nAutomated by Rorca engine.\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"`,
      { cwd, env, stdio: 'pipe' },
    );
    try {
      execSync('git push origin HEAD', { cwd, env, stdio: 'pipe', timeout: 60_000 });
    } catch {
      console.log('  Push failed (will retry next iteration)');
    }
  } catch {
    // git commit may fail if nothing to commit — that's OK
  }
}

// ─── Validation Gate ────────────────────────────────────────────────────────

const GATE_TIMEOUT_MS = 5 * 60 * 1000;

interface GateResult {
  passed: boolean;
  reason?: 'typecheck' | 'e2e';
  output?: string;
}

function runGate(cwd: string): GateResult {
  const env = buildCleanEnv();

  console.log('  [gate] Running tsc --noEmit...');
  try {
    execSync('npx tsc --noEmit', { cwd, env, stdio: 'pipe', timeout: GATE_TIMEOUT_MS });
    console.log('  [gate] tsc passed');
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString('utf8') ?? '';
    console.log(`  [gate] tsc FAILED`);
    return { passed: false, reason: 'typecheck', output: stderr.slice(0, 2000) };
  }

  const hasPlaywrightConfig =
    fs.existsSync(path.join(cwd, 'playwright.config.ts')) ||
    fs.existsSync(path.join(cwd, 'playwright.config.js'));

  if (hasPlaywrightConfig) {
    console.log('  [gate] Running playwright test...');
    try {
      execSync('npx playwright test --reporter=line', { cwd, env, stdio: 'pipe', timeout: GATE_TIMEOUT_MS });
      console.log('  [gate] playwright passed');
    } catch (err: unknown) {
      const stdout = (err as { stdout?: Buffer })?.stdout?.toString('utf8') ?? '';
      console.log(`  [gate] playwright FAILED`);
      return { passed: false, reason: 'e2e', output: stdout.slice(0, 2000) };
    }
  }

  return { passed: true };
}

// ─── Worktree Helpers ───────────────────────────────────────────────────────

interface StoryWorktree {
  storyId: string;
  worktreePath: string;
  branchName: string;
}

function createStoryWorktree(
  workspaceCwd: string,
  specSlug: string,
  storyId: string,
): StoryWorktree | null {
  const ts = Date.now();
  const branchName = `feat/${specSlug}-${storyId}-${ts}`;
  const repoName = path.basename(workspaceCwd);
  const worktreePath = path.resolve(workspaceCwd, '..', `${repoName}-${storyId}-${ts}`);

  try {
    execSync(
      `git worktree add -b "${branchName}" "${worktreePath}" HEAD`,
      { cwd: workspaceCwd, stdio: 'pipe', timeout: 30_000 },
    );
    console.log(`  [worktree] Created ${worktreePath} (${branchName})`);
    return { storyId, worktreePath, branchName };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    console.error(`  [worktree] FAILED to create worktree for ${storyId}: ${msg}`);
    return null;
  }
}

function mergeStoryWorktree(workspaceCwd: string, wt: StoryWorktree): boolean {
  try {
    execSync(
      `git merge --no-ff "${wt.branchName}" -m "merge: ${wt.storyId} from worktree"`,
      { cwd: workspaceCwd, stdio: 'pipe', timeout: 120_000 },
    );
    console.log(`  [worktree] Merged ${wt.branchName} into workspace`);
    return true;
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    console.error(`  [worktree] MERGE FAILED for ${wt.branchName}: ${msg}`);
    try { execSync('git merge --abort', { cwd: workspaceCwd, stdio: 'pipe' }); } catch { /* already clean */ }
    return false;
  }
}

// ─── Wave Merge Orchestrator ────────────────────────────────────────────────

interface WaveMergeResult {
  success: boolean;
  conflictsResolved: number;
  blocked?: { storyId: string; conflictingFiles: string[] };
}

async function autoResolveConflicts(
  cwd: string,
  storyId: string,
  logDir: string,
): Promise<{ resolved: boolean; resolvedFiles: string[] }> {
  const env = buildCleanEnv();
  const resolvedFiles: string[] = [];

  let conflictingFiles: string[];
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    conflictingFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    return { resolved: false, resolvedFiles: [] };
  }

  if (conflictingFiles.length === 0) {
    return { resolved: true, resolvedFiles: [] };
  }

  console.log(`  [merge] ${conflictingFiles.length} conflicting file(s): ${conflictingFiles.join(', ')}`);

  for (const file of conflictingFiles) {
    const absFile = path.join(cwd, file);
    let conflictContent: string;
    try {
      conflictContent = fs.readFileSync(absFile, 'utf8');
    } catch {
      console.error(`  [merge] Cannot read conflicting file: ${file}`);
      return { resolved: false, resolvedFiles };
    }

    const prompt = [
      'Resolve this git merge conflict. Output ONLY the resolved file content with no explanation,',
      'no markdown fences, no commentary. Choose the correct combination of both sides.',
      '', `File: ${file}`, '', conflictContent,
    ].join('\n');

    const resolveLogFile = path.join(logDir, `${storyId}_merge_resolve_${path.basename(file)}.log`);
    const resolvedContent = await new Promise<string | null>((resolve) => {
      const args = ['--dangerously-skip-permissions', '--print', prompt];
      let stdout = '';
      const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

      const logFd = fs.openSync(resolveLogFile, 'a');
      child.stderr.on('data', (chunk: Buffer) => { fs.writeSync(logFd, chunk); });

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }, 120_000);

      child.on('exit', (code) => {
        clearTimeout(timer);
        try { fs.closeSync(logFd); } catch { /* already closed */ }
        if (code === 0 && stdout.trim().length > 0) resolve(stdout);
        else resolve(null);
      });
      child.on('error', () => {
        clearTimeout(timer);
        try { fs.closeSync(logFd); } catch { /* already closed */ }
        resolve(null);
      });
    });

    if (resolvedContent === null) {
      console.error(`  [merge] Auto-resolution FAILED for ${file}`);
      return { resolved: false, resolvedFiles };
    }

    try {
      fs.writeFileSync(absFile, resolvedContent);
      execSync(`git add "${file}"`, { cwd, env, stdio: 'pipe' });
      resolvedFiles.push(file);
      console.log(`  [merge] Resolved ${file}`);
    } catch (err: unknown) {
      console.error(`  [merge] Failed to write/stage resolved ${file}: ${(err as Error).message}`);
      return { resolved: false, resolvedFiles };
    }
  }

  return { resolved: true, resolvedFiles };
}

async function mergeWave(
  waveBranches: StoryWorktree[],
  waveIndex: number,
  cwd: string,
  logDir: string,
): Promise<WaveMergeResult> {
  const env = buildCleanEnv();
  const sorted = [...waveBranches].sort((a, b) => a.storyId.localeCompare(b.storyId));
  let totalConflictsResolved = 0;

  for (const wt of sorted) {
    console.log(`  [merge] Merging ${wt.branchName} (${wt.storyId})...`);

    let mergeClean: boolean;
    try {
      execSync(
        `git merge --no-ff --no-commit "${wt.branchName}"`,
        { cwd, env, stdio: 'pipe', timeout: 120_000 },
      );
      mergeClean = true;
    } catch {
      mergeClean = false;
    }

    if (mergeClean) {
      try {
        execSync(`git commit -m "merge: ${wt.storyId}"`, { cwd, env, stdio: 'pipe', timeout: 30_000 });
        console.log(`  [merge] ${wt.storyId} merged cleanly`);
      } catch {
        console.log(`  [merge] ${wt.storyId} merged (no changes to commit)`);
      }
      continue;
    }

    console.log(`  [merge] Conflict detected for ${wt.storyId}, attempting auto-resolution...`);
    const resolution = await autoResolveConflicts(cwd, wt.storyId, logDir);

    if (resolution.resolved) {
      const filesList = resolution.resolvedFiles.join(', ');
      try {
        execSync(
          `git commit -m "merge(wave-${waveIndex}): resolved conflicts in ${filesList}"`,
          { cwd, env, stdio: 'pipe', timeout: 30_000 },
        );
        totalConflictsResolved += resolution.resolvedFiles.length;
        console.log(`  [merge] ${wt.storyId} merged with ${resolution.resolvedFiles.length} conflict(s) resolved`);
      } catch (err: unknown) {
        console.error(`  [merge] Commit after resolution failed: ${(err as Error).message}`);
        try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }

        let conflictingFiles: string[] = [];
        try {
          const output = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
          conflictingFiles = output.trim().split('\n').filter(Boolean);
        } catch { /* empty */ }

        return { success: false, conflictsResolved: totalConflictsResolved, blocked: { storyId: wt.storyId, conflictingFiles } };
      }
    } else {
      console.error(`  [merge] Auto-resolution failed for ${wt.storyId} — blocking run`);
      try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }

      let conflictingFiles: string[] = [];
      try {
        try { execSync(`git merge --no-ff --no-commit "${wt.branchName}"`, { cwd, env, stdio: 'pipe', timeout: 30_000 }); } catch { /* expected */ }
        const output = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        conflictingFiles = output.trim().split('\n').filter(Boolean);
        try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* clean up */ }
      } catch { /* empty */ }

      return { success: false, conflictsResolved: totalConflictsResolved, blocked: { storyId: wt.storyId, conflictingFiles } };
    }
  }

  return { success: true, conflictsResolved: totalConflictsResolved };
}

function removeStoryWorktree(workspaceCwd: string, wt: StoryWorktree): void {
  try {
    execSync(`git worktree remove --force "${wt.worktreePath}"`, { cwd: workspaceCwd, stdio: 'pipe', timeout: 30_000 });
  } catch { /* already removed */ }
  try {
    execSync(`git branch -D "${wt.branchName}"`, { cwd: workspaceCwd, stdio: 'pipe', timeout: 10_000 });
  } catch { /* branch may already be gone */ }
  console.log(`  [worktree] Removed ${wt.worktreePath}`);
}

// ─── Story Execution ────────────────────────────────────────────────────────

async function executeStory(
  story: UserStory,
  config: EngineConfig,
  mode: 'impl' | 'qa' | 'journey',
  playbook: string | undefined,
  logDir: string,
  workspaceId: string | null,
  retryCounts: Map<string, number>,
  storyCwd?: string,
  worktreeInfo?: StoryWorktree,
): Promise<'passed' | 'failed' | 'skipped'> {
  const effectiveCwd = storyCwd ?? config.cwd;
  const timeoutMin = story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

  console.log(`[${mode}] ${story.id}: ${story.title} (agent: ${config.agentType})`);
  if (worktreeInfo) console.log(`  Worktree: ${worktreeInfo.worktreePath}`);
  console.log(`  Timeout: ${timeoutMin}m`);

  const prompt = buildPrompt(story, mode, effectiveCwd, playbook, config.agentType);

  const promptLogFile = path.join(logDir, `${story.id}_prompt.txt`);
  fs.writeFileSync(promptLogFile, prompt);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const storyLogFile = path.join(logDir, `${story.id}_${timestamp}.log`);

  // Emit story_started WAL event
  if (workspaceId) {
    await emitWalEvent(config.port, 'story_started', workspaceId, {
      run_id: config.runId,
      story_id: story.id,
      story_title: story.title,
      agent_type: config.agentType,
      ...(worktreeInfo ? { worktree_path: worktreeInfo.worktreePath, worktree_branch: worktreeInfo.branchName } : {}),
    }, story.id);
  }

  const storyResultExtra = worktreeInfo
    ? { worktreePath: worktreeInfo.worktreePath, worktreeBranch: worktreeInfo.branchName }
    : {};

  const rateLimitKey = `rl:${story.id}`;
  let rateLimitAttempts = retryCounts.get(rateLimitKey) ?? 0;

  // Rate limit retry loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await runAgent(
      config.agentType,
      prompt,
      effectiveCwd,
      timeoutMin * 60 * 1000,
      storyLogFile,
      config.agentModel,
      config.attachAddr,
    );

    // ── Rate limit detection ──────────────────────────────────────────
    if (result.exitCode !== 0 && result.exitCode !== 124 && isRateLimited(result)) {
      rateLimitAttempts++;
      retryCounts.set(rateLimitKey, rateLimitAttempts);

      if (rateLimitAttempts > MAX_RATE_LIMIT_RETRIES) {
        console.log(`${story.id} rate limited ${rateLimitAttempts} times — exhausted. Marking failed.`);
        markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id,
            reason: 'rate_limit_exhausted', attempts: rateLimitAttempts,
          }, story.id);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra }),
            });
          } catch { /* backend may be down */ }
        }
        return 'failed';
      }

      const backoffMs = RATE_LIMIT_BACKOFF_MS[rateLimitAttempts - 1] ?? RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
      console.log(`${story.id} rate limited (attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}). Retrying in ${backoffMs / 1000}s...`);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_rate_limited', workspaceId, {
          run_id: config.runId, story_id: story.id,
          attempt: rateLimitAttempts, retryAfterMs: backoffMs,
        }, story.id);
      }

      await new Promise(resolve => setTimeout(resolve, backoffMs));

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_started', workspaceId, {
          run_id: config.runId, story_id: story.id, story_title: story.title,
          agent_type: config.agentType,
          ...(worktreeInfo ? { worktree_path: worktreeInfo.worktreePath, worktree_branch: worktreeInfo.branchName } : {}),
        }, story.id);
      }
      continue;
    }

    // ── Exit code 0: success ──────────────────────────────────────────
    if (result.exitCode === 0) {
      console.log(`${story.id} completed (exit 0)`);

      const skipGate = config.dryRun || process.env.RORCA_SKIP_GATE === '1';
      const gate = skipGate ? { passed: true } as GateResult : runGate(effectiveCwd);

      if (!gate.passed) {
        console.log(`${story.id} agent succeeded but gate failed: ${gate.reason}`);
        const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
        retryCounts.set(story.id, currentRetries);

        if (currentRetries >= MAX_RETRIES) markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id, reason: gate.reason,
            ...(gate.reason === 'typecheck' ? { stderr: gate.output } : { summary: gate.output }),
          }, story.id);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra }),
            });
          } catch { /* backend may be down */ }
        }

        if (currentRetries >= MAX_RETRIES) {
          console.log(`${story.id} failed gate after ${MAX_RETRIES} attempts. Skipping.`);
        }
        return 'failed';
      }

      // Gate passed
      markStoryPassed(config.jsonPath, story.id);
      retryCounts.delete(story.id);
      retryCounts.delete(rateLimitKey);

      console.log(`Committing ${story.id}...`);
      gitCommitStory(effectiveCwd, story.id, story.title, mode);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_passed', workspaceId, {
          run_id: config.runId, story_id: story.id, story_title: story.title,
          agent_type: config.agentType,
        }, story.id);
        try {
          await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'pass', ...storyResultExtra }),
          });
        } catch { /* backend may be down */ }
      }
      return 'passed';
    }

    // ── Exit code 124: timeout ────────────────────────────────────────
    if (result.exitCode === 124) {
      console.log(`${story.id} timed out after ${timeoutMin}m (exit 124)`);
      console.log(`   Log: ${storyLogFile}`);
      markStorySkipped(config.jsonPath, story.id);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: 'timeout', timeout_minutes: timeoutMin,
        }, story.id);
        try {
          await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra }),
          });
        } catch { /* backend may be down */ }
      }
      return 'failed';
    }

    // ── Non-zero exit: classify error and retry ────────────────────────
    const classified = config.agentType === 'opencode'
      ? classifyOpenCodeError(result)
      : { category: 'unknown' as OpenCodeErrorCategory, message: result.stderrTail.slice(0, 200), retryable: true };

    // Non-retryable errors (wrong API key, model not found, not installed) — fail immediately
    if (!classified.retryable) {
      console.log(`${story.id} failed (non-retryable): ${classified.category} — ${classified.message}`);
      console.log(`   Log: ${storyLogFile}`);
      markStorySkipped(config.jsonPath, story.id);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: classified.category, error_message: classified.message,
          agent_type: config.agentType, exit_code: result.exitCode,
        }, story.id);
        try {
          await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra }),
          });
        } catch { /* backend may be down */ }
      }
      return 'failed';
    }

    const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
    retryCounts.set(story.id, currentRetries);

    if (currentRetries >= MAX_RETRIES) {
      console.log(`${story.id} failed after ${MAX_RETRIES} attempts. Skipping.`);
      console.log(`   Log: ${storyLogFile}`);
      console.log(`   Error: ${classified.message}`);
      markStorySkipped(config.jsonPath, story.id);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: 'max_retries', attempts: currentRetries,
          error_category: classified.category, error_message: classified.message,
          agent_type: config.agentType,
        }, story.id);
        try {
          await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra }),
          });
        } catch { /* backend may be down */ }
      }
      return 'failed';
    }

    console.log(`${story.id} failed (attempt ${currentRetries}/${MAX_RETRIES}): ${classified.category}`);
    console.log(`   Log: ${storyLogFile}`);
    console.log(`   Error: ${classified.message}`);
    return 'failed';
  }
}

// ─── Bounded Concurrency ────────────────────────────────────────────────────

async function runWithBoundedConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        const value = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Transitive Blocking ────────────────────────────────────────────────────

function computeBlockedStories(
  allStories: UserStory[],
  failedIds: Set<string>,
  alreadyProcessed: Set<string>,
): Map<string, string[]> {
  const blocked = new Map<string, string[]>();
  const unprocessed = allStories.filter(s =>
    !alreadyProcessed.has(s.id) && !failedIds.has(s.id) && !s.excluded && !s.skipped && !isPassed(s)
  );

  const allBlockedIds = new Set<string>(failedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const story of unprocessed) {
      if (allBlockedIds.has(story.id)) continue;
      const deps = story.dependsOn ?? [];
      const blockers = deps.filter(dep => allBlockedIds.has(dep));
      if (blockers.length > 0) {
        allBlockedIds.add(story.id);
        blocked.set(story.id, blockers);
        changed = true;
      }
    }
  }

  return blocked;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();

  console.log(`[engine] Agent: ${config.agentType}${config.agentModel ? ` (model: ${config.agentModel})` : ''}`);
  if (config.attachAddr) console.log(`[engine] OpenCode attach: ${config.attachAddr}`);

  if (!fs.existsSync(config.jsonPath)) {
    console.error(`Error: JSON file not found: ${config.jsonPath}`);
    process.exit(1);
  }

  const logDir = path.join(path.dirname(config.jsonPath), '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const spec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
  const mode = detectMode(spec);
  const playbook = spec.playbook;
  const stories = getStories(spec);

  const modeLabel = mode === 'qa' ? 'QA Testing' : mode === 'journey' ? 'User Journey' : 'Implementation';
  const progress = getProgress(stories);

  console.log('========================================');
  console.log(`  Rorca Engine — ${modeLabel}`);
  console.log('========================================');
  console.log('');
  console.log(`Progress: ${progress.passed}/${progress.total}`);
  console.log(`Agent: ${config.agentType}`);
  console.log(`Parallelism: ${config.parallelism}`);
  console.log(`JSON: ${config.jsonPath}`);
  if (playbook) console.log(`Playbook: ${playbook}`);
  console.log('');

  const workspaceId = await resolveWorkspaceId(config.port, config.cwd);
  const retryCounts = new Map<string, number>();

  process.on('SIGINT', () => {
    console.log('');
    console.log('Engine stopped by user.');
    process.exit(0);
  });

  // ─── Parallel execution path (N > 1) ──────────────────────────────
  if (config.parallelism > 1 && !config.specificStory) {
    await runParallel(config, mode, playbook, logDir, workspaceId, retryCounts, stories);
    return;
  }

  // ─── Sequential execution path (N = 1) ────────────────────────────
  let iteration = 0;

  while (true) {
    iteration++;

    const currentSpec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
    const currentStories = getStories(currentSpec);

    let story: UserStory | null;

    if (config.specificStory) {
      story = currentStories.find(s => s.id === config.specificStory) ?? null;
      if (!story) {
        console.error(`Story ${config.specificStory} not found!`);
        process.exit(1);
      }
    } else {
      story = getNextStory(currentStories);
    }

    if (!story) {
      const finalProgress = getProgress(currentStories);
      console.log('');
      console.log(`All stories complete! ${finalProgress.passed}/${finalProgress.total}`);
      process.exit(0);
    }

    const currentProgress = getProgress(currentStories);
    const timeoutMin = story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

    console.log('------------------------------------------');
    console.log(`[${mode}] Iteration ${iteration} | ${story.id}: ${story.title} (agent: ${config.agentType})`);
    console.log(`  Progress: ${currentProgress.passed}/${currentProgress.total}`);
    console.log('------------------------------------------');

    if (config.dryRun) {
      console.log(`  [DRY RUN] Would execute: ${story.id}`);
      console.log(`  Description: ${story.description}`);
      const ac = getAcceptance(story);
      if (ac) console.log(`  Acceptance: ${ac}`);
      console.log('');
      process.exit(0);
    }

    const prompt = buildPrompt(story, mode, config.cwd, playbook, config.agentType);

    const promptLogFile = path.join(logDir, `${story.id}_prompt.txt`);
    fs.writeFileSync(promptLogFile, prompt);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const storyLogFile = path.join(logDir, `${story.id}_${timestamp}.log`);

    console.log(`  Timeout: ${timeoutMin}m (${timeoutMin * 60}s)`);
    console.log('');

    // Emit story_started WAL event
    if (workspaceId) {
      await emitWalEvent(config.port, 'story_started', workspaceId, {
        run_id: config.runId,
        story_id: story.id,
        story_title: story.title,
        agent_type: config.agentType,
      }, story.id);
    }

    // Run agent subprocess
    const result = await runAgent(
      config.agentType,
      prompt,
      config.cwd,
      timeoutMin * 60 * 1000,
      storyLogFile,
      config.agentModel,
      config.attachAddr,
    );

    console.log('');

    // ── Rate limit detection (sequential path) ───────────────────────
    if (result.exitCode !== 0 && result.exitCode !== 124 && isRateLimited(result)) {
      const rlKey = `rl:${story.id}`;
      const rlAttempts = (retryCounts.get(rlKey) ?? 0) + 1;
      retryCounts.set(rlKey, rlAttempts);

      if (rlAttempts > MAX_RATE_LIMIT_RETRIES) {
        console.log(`${story.id} rate limited ${rlAttempts} times — exhausted. Skipping.`);
        markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id,
            reason: 'rate_limit_exhausted', attempts: rlAttempts,
          }, story.id);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail' }),
            });
          } catch { /* backend may be down */ }
        }
      } else {
        const backoffMs = RATE_LIMIT_BACKOFF_MS[rlAttempts - 1] ?? RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
        console.log(`${story.id} rate limited (attempt ${rlAttempts}/${MAX_RATE_LIMIT_RETRIES}). Retrying in ${backoffMs / 1000}s...`);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_rate_limited', workspaceId, {
            run_id: config.runId, story_id: story.id,
            attempt: rlAttempts, retryAfterMs: backoffMs, waveIndex: 0,
          }, story.id);
        }

        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    } else if (result.exitCode === 0) {
      console.log(`${story.id} completed (exit 0)`);

      const skipGate = config.dryRun || process.env.RORCA_SKIP_GATE === '1';
      const gate = skipGate ? { passed: true } as GateResult : runGate(config.cwd);

      if (!gate.passed) {
        console.log(`${story.id} agent succeeded but gate failed: ${gate.reason}`);
        const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
        retryCounts.set(story.id, currentRetries);

        if (currentRetries >= MAX_RETRIES) markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id, reason: gate.reason,
            ...(gate.reason === 'typecheck' ? { stderr: gate.output } : { summary: gate.output }),
          }, story.id);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail' }),
            });
          } catch { /* backend may be down */ }
        }

        if (currentRetries >= MAX_RETRIES) {
          console.log(`${story.id} failed gate after ${MAX_RETRIES} attempts. Skipping.`);
          console.log(`   Fix manually, then re-run with: --story ${story.id}`);
        } else {
          console.log(`${story.id} gate failed (attempt ${currentRetries}/${MAX_RETRIES}). Will retry...`);
        }
      } else {
        markStoryPassed(config.jsonPath, story.id);
        retryCounts.delete(story.id);
        retryCounts.delete(`rl:${story.id}`);

        console.log(`Committing ${story.id}...`);
        gitCommitStory(config.cwd, story.id, story.title, mode);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_passed', workspaceId, {
            run_id: config.runId, story_id: story.id, story_title: story.title,
            agent_type: config.agentType,
          }, story.id);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'pass' }),
            });
          } catch { /* backend may be down */ }
        }
      }
    } else if (result.exitCode === 124) {
      console.log(`${story.id} timed out after ${timeoutMin}m (exit 124)`);
      console.log(`   Log: ${storyLogFile}`);
      console.log('   Consider increasing timeoutMinutes for this story in the spec JSON');
      markStorySkipped(config.jsonPath, story.id);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: 'timeout', timeout_minutes: timeoutMin,
        }, story.id);
        try {
          await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail' }),
          });
        } catch { /* backend may be down */ }
      }
    } else {
      // Classify OpenCode errors for user-facing messages
      const classified = config.agentType === 'opencode'
        ? classifyOpenCodeError(result)
        : { category: 'unknown' as OpenCodeErrorCategory, message: result.stderrTail.slice(0, 200), retryable: true };

      // Non-retryable errors — fail immediately, no retry
      if (!classified.retryable) {
        console.log(`${story.id} failed (non-retryable): ${classified.category} — ${classified.message}`);
        console.log(`   Log: ${storyLogFile}`);
        markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id,
            reason: classified.category, error_message: classified.message,
            agent_type: config.agentType, exit_code: result.exitCode,
          }, story.id);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail' }),
            });
          } catch { /* backend may be down */ }
        }
      } else {
        const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
        retryCounts.set(story.id, currentRetries);

        if (currentRetries >= MAX_RETRIES) {
          console.log(`${story.id} failed after ${MAX_RETRIES} attempts. Skipping.`);
          console.log(`   Log: ${storyLogFile}`);
          console.log(`   Error: ${classified.message}`);
          console.log(`   Fix manually, then re-run with: --story ${story.id}`);
          markStorySkipped(config.jsonPath, story.id);

          if (workspaceId) {
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId, story_id: story.id,
              reason: 'max_retries', attempts: currentRetries,
              error_category: classified.category, error_message: classified.message,
              agent_type: config.agentType,
            }, story.id);
            try {
              await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail' }),
              });
            } catch { /* backend may be down */ }
          }
        } else {
          console.log(`${story.id} failed (attempt ${currentRetries}/${MAX_RETRIES}): ${classified.category}`);
          console.log(`   Log: ${storyLogFile}`);
          console.log(`   Error: ${classified.message}`);
          console.log('   Will retry...');
        }
      }
    }

    if (config.specificStory) {
      process.exit(result.exitCode);
    }

    console.log('');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

// ─── Parallel Execution (N > 1) ─────────────────────────────────────────────

async function runParallel(
  config: EngineConfig,
  mode: 'impl' | 'qa' | 'journey',
  playbook: string | undefined,
  logDir: string,
  workspaceId: string | null,
  retryCounts: Map<string, number>,
  stories: UserStory[],
): Promise<void> {
  const waveStories: WaveUserStory[] = stories.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria ?? [],
    dependsOn: s.dependsOn ?? [],
    passes: s.passes,
    excluded: s.excluded,
    priority: s.priority,
    timeoutMinutes: s.timeoutMinutes,
  }));

  const waveResult = compileWaves(waveStories);

  if (isCycleError(waveResult)) {
    console.error(`[engine] Dependency cycle detected among stories: ${waveResult.involvedIds.join(', ')}`);
    console.error(`[engine] Cannot run in parallel mode. Fix dependsOn fields or use --parallelism 1`);
    process.exit(1);
  }

  const waves: Wave[] = waveResult;

  console.log(`Compiled ${stories.length} stories into ${waves.length} waves`);
  for (const wave of waves) {
    console.log(`  Wave ${wave.index}: ${wave.stories.map(s => s.id).join(', ')}`);
  }
  console.log('');

  if (workspaceId) {
    await emitWalEvent(config.port, 'run_started', workspaceId, {
      run_id: config.runId,
      parallelism: config.parallelism,
      waveCount: waves.length,
      agent_type: config.agentType,
    });
  }

  const specSlug = path.basename(config.jsonPath, '.json').replace(/[^a-z0-9-]/gi, '-');
  const failedIds = new Set<string>();
  const processedIds = new Set<string>();

  for (const wave of waves) {
    console.log('==========================================');
    console.log(`  Wave ${wave.index} — ${wave.stories.length} stories (parallelism=${config.parallelism})`);
    console.log('==========================================');

    const executableStories: UserStory[] = [];
    for (const waveStory of wave.stories) {
      const original = stories.find(s => s.id === waveStory.id);
      if (!original) continue;

      if (original.excluded || original.skipped) {
        processedIds.add(original.id);
        continue;
      }

      const deps = original.dependsOn ?? [];
      const blockers = deps.filter(dep => failedIds.has(dep));
      if (blockers.length > 0) {
        console.log(`  ${original.id} BLOCKED by: ${blockers.join(', ')}`);
        failedIds.add(original.id);
        processedIds.add(original.id);
        markStorySkipped(config.jsonPath, original.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: original.id,
            reason: 'blocked_by', blockedBy: blockers,
          }, original.id);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: original.id, status: 'skip' }),
            });
          } catch { /* backend may be down */ }
        }
        continue;
      }

      executableStories.push(original);
    }

    if (executableStories.length === 0) {
      console.log('  No executable stories in this wave — skipping');
      continue;
    }

    const worktreeMap = new Map<string, StoryWorktree>();

    for (const story of executableStories) {
      const wt = createStoryWorktree(config.cwd, specSlug, story.id);
      if (wt) {
        worktreeMap.set(story.id, wt);
      } else {
        failedIds.add(story.id);
        processedIds.add(story.id);
        markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id, reason: 'worktree_create_failed',
          }, story.id);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: story.id, status: 'fail' }),
            });
          } catch { /* backend may be down */ }
        }
      }
    }

    const storiesWithWorktrees = executableStories.filter(s => worktreeMap.has(s.id));

    const tasks = storiesWithWorktrees.map(story => {
      const wt = worktreeMap.get(story.id)!;
      return () =>
        executeStory(story, config, mode, playbook, logDir, workspaceId, retryCounts, wt.worktreePath, wt)
          .then(result => ({ storyId: story.id, result }));
    });

    const results = await runWithBoundedConcurrency(tasks, config.parallelism);

    const passedInWave: StoryWorktree[] = [];
    const failedInWave: StoryWorktree[] = [];

    for (const settled of results) {
      if (settled.status === 'fulfilled') {
        const { storyId, result } = settled.value;
        processedIds.add(storyId);
        const wt = worktreeMap.get(storyId);
        if (result === 'failed') {
          failedIds.add(storyId);
          if (wt) failedInWave.push(wt);
        } else if (result === 'passed' && wt) {
          passedInWave.push(wt);
        }
      } else {
        console.error(`[engine] Unexpected rejection in wave ${wave.index}:`, settled.reason);
      }
    }

    // Post-wave: merge passed worktrees
    if (passedInWave.length > 0) {
      if (passedInWave.length === 1) {
        console.log(`  [worktree] Single-story wave — direct merge`);
        const wt = passedInWave[0];
        const merged = mergeStoryWorktree(config.cwd, wt);
        if (!merged) {
          console.error(`  [worktree] ${wt.storyId} passed but merge failed — marking as failed`);
          failedIds.add(wt.storyId);
          if (workspaceId) {
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId, story_id: wt.storyId,
              reason: 'merge_conflict', worktree_branch: wt.branchName,
            }, wt.storyId);
          }
        }
        removeStoryWorktree(config.cwd, wt);
      } else {
        console.log(`  [worktree] Merging ${passedInWave.length} passed worktree(s) via wave merge orchestrator...`);
        const mergeResult = await mergeWave(passedInWave, wave.index, config.cwd, logDir);

        if (mergeResult.success) {
          if (workspaceId) {
            await emitWalEvent(config.port, 'wave_merged', workspaceId, {
              run_id: config.runId, wave: wave.index,
              storiesCount: passedInWave.length, conflictsResolved: mergeResult.conflictsResolved,
            });
          }
          console.log(`  [merge] Wave ${wave.index} merged successfully (${mergeResult.conflictsResolved} conflict(s) resolved)`);
          for (const wt of passedInWave) removeStoryWorktree(config.cwd, wt);
        } else if (mergeResult.blocked) {
          console.error(`  [merge] Wave ${wave.index} BLOCKED on ${mergeResult.blocked.storyId}`);
          console.error(`  [merge] Conflicting files: ${mergeResult.blocked.conflictingFiles.join(', ')}`);

          if (workspaceId) {
            await emitWalEvent(config.port, 'run_blocked', workspaceId, {
              run_id: config.runId, reason: 'merge_conflict',
              conflictingFiles: mergeResult.blocked.conflictingFiles,
              wave: wave.index, storyId: mergeResult.blocked.storyId,
            });
          }

          failedIds.add(mergeResult.blocked.storyId);
          console.log(`  [merge] Worktree branches preserved for manual resolution. Pausing run.`);
          for (const wt of failedInWave) removeStoryWorktree(config.cwd, wt);
          console.log(`\n[engine] Run paused due to merge conflict. Resolve manually and resume.`);
          process.exit(2);
        }
      }
    }

    for (const wt of failedInWave) removeStoryWorktree(config.cwd, wt);

    const allStories = getStories(JSON.parse(fs.readFileSync(config.jsonPath, 'utf8')));
    const newlyBlocked = computeBlockedStories(allStories, failedIds, processedIds);

    for (const [blockedId, blockers] of newlyBlocked) {
      if (!processedIds.has(blockedId)) {
        console.log(`  ${blockedId} transitively BLOCKED by: ${blockers.join(', ')}`);
        failedIds.add(blockedId);
        processedIds.add(blockedId);
        markStorySkipped(config.jsonPath, blockedId);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: blockedId,
            reason: 'blocked_by', blockedBy: blockers,
          }, blockedId);
          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: config.runId, storyId: blockedId, status: 'skip' }),
            });
          } catch { /* backend may be down */ }
        }
      }
    }

    console.log('');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const finalSpec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
  const finalStories = getStories(finalSpec);
  const finalProgress = getProgress(finalStories);
  console.log('');
  console.log(`All waves complete! ${finalProgress.passed}/${finalProgress.total} stories passed`);
  if (failedIds.size > 0) {
    console.log(`Failed/blocked: ${[...failedIds].join(', ')}`);
  }
  process.exit(failedIds.size > 0 ? 1 : 0);
}

// ─── Workspace Resolver ─────────────────────────────────────────────────────

async function resolveWorkspaceId(port: number, cwd: string): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/workspaces`);
    if (!res.ok) return null;
    const data = await res.json() as { workspaces?: Array<{ id: string; path: string }> };
    const ws = data.workspaces?.find(w => w.path === cwd || cwd.startsWith(w.path));
    return ws?.id ?? null;
  } catch {
    return null;
  }
}

// ─── Argument Parser ────────────────────────────────────────────────────────

function parseArgs(): EngineConfig {
  const args = process.argv.slice(2);
  let jsonPath = '';
  let cwd = '';
  let runId = 0;
  let specificStory: string | undefined;
  let dryRun = false;
  let port = parseInt(process.env.PORT ?? '3030', 10);
  let parallelism = 1;
  let cliAgent: string | undefined;
  let cliModel: string | undefined;
  let attachAddr: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--json':
        jsonPath = args[++i];
        break;
      case '--cwd':
        cwd = args[++i];
        break;
      case '--run-id':
        runId = parseInt(args[++i], 10);
        break;
      case '--story':
        specificStory = args[++i];
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--port':
        port = parseInt(args[++i], 10);
        break;
      case '--parallelism':
        parallelism = Math.max(1, Math.min(10, parseInt(args[++i], 10) || 1));
        break;
      case '--agent':
        cliAgent = args[++i];
        break;
      case '--model':
        cliModel = args[++i];
        break;
      case '--attach':
        attachAddr = args[++i];
        break;
      default:
        console.error(`Unknown arg: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!jsonPath || !cwd || !runId) {
    console.error('Usage: execution-engine.ts --json <path> --cwd <path> --run-id <number> [--story <id>] [--dry-run] [--port <number>] [--parallelism <N>] [--agent <type>] [--model <model>] [--attach <addr>]');
    process.exit(1);
  }

  // Resolve agent config: CLI flags override env vars
  const envConfig = parseAgentConfig();
  const agentType: AgentType = (cliAgent as AgentType) ?? envConfig.agentType;
  const agentModel: string | null = cliModel ?? envConfig.agentModel;

  return { jsonPath, cwd, runId, specificStory, dryRun, port, parallelism, agentType, agentModel, attachAddr };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[engine] Fatal error:', err);
  process.exit(1);
});
