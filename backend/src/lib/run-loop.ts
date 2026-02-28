/**
 * run-loop.ts — TypeScript replacement for forge/run-loop.sh
 *
 * Cross-platform execution engine for the Ralph Loop. Reads a spec JSON,
 * iterates user stories, spawns `claude --dangerously-skip-permissions --print`
 * per story, and reports progress via WAL events to the Rorca backend.
 *
 * Usage (standalone — spawned by pipeline.ts):
 *   npx tsx backend/src/lib/run-loop.ts --json /path/to/spec.json --cwd /path/to/workspace --run-id 42
 *
 * Flags:
 *   --json <path>           Spec JSON file (required)
 *   --cwd <path>            Working directory / workspace root (required)
 *   --run-id <number>       Pipeline run ID for WAL event reporting (required)
 *   --story <id>            Run a single specific story
 *   --dry-run               Preview next story without executing
 *   --port <number>         Backend port for WAL events (default: 3030)
 *   --parallelism <N>       Max concurrent story subprocesses per wave (1–10, default: 1)
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileWaves, isCycleError } from './wave-compiler';
import { retryPost, writeFallbackResult, type FallbackResultEntry } from './resilient-post';
import type { Wave, UserStory as WaveUserStory } from './wave-compiler';

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

interface RunLoopConfig {
  jsonPath: string;
  cwd: string;
  runId: number;
  specificStory?: string;
  dryRun: boolean;
  port: number;
  parallelism: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000]; // 30s, 60s, 120s, 240s
const RATE_LIMIT_FAST_EXIT_THRESHOLD_MS = 5_000; // exit within 5s = heuristic for immediate rejection
const DEFAULT_TIMEOUT_MINUTES = 45;

const CLAUDE_BIN = process.env.CLAUDE_BIN ||
  (() => {
    // Try to find claude in PATH
    const { execSync } = require('child_process') as typeof import('child_process');
    try {
      return execSync('which claude', { encoding: 'utf8' }).trim();
    } catch {
      return 'claude';
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

/** Extract a flat list of stories from either spec format */
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

/** Check if a story is considered passed */
function isPassed(story: UserStory): boolean {
  if (story.passes !== undefined) return Boolean(story.passes);
  return story.status === 'passed';
}

/** Get acceptance criteria as a string */
function getAcceptance(story: UserStory): string {
  if (story.acceptance) return story.acceptance;
  if (story.acceptanceCriteria?.length) {
    return story.acceptanceCriteria.map(a => `- ${a}`).join('\n');
  }
  return '';
}

/** Detect mode from JSON structure */
function detectMode(spec: SpecJson): 'impl' | 'qa' | 'journey' {
  if (spec.mode) return spec.mode as 'impl' | 'qa' | 'journey';
  if (spec.phases) return 'qa';
  return 'impl';
}

/** Get progress counts */
function getProgress(stories: UserStory[]): { passed: number; total: number } {
  return {
    passed: stories.filter(isPassed).length,
    total: stories.length,
  };
}

/** Find the next pending story respecting dependencies */
function getNextStory(stories: UserStory[]): UserStory | null {
  const passedIds = new Set(stories.filter(isPassed).map(s => s.id));

  const sorted = [...stories].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));

  for (const story of sorted) {
    if (isPassed(story)) continue;
    if (story.skipped) continue;
    if (story.excluded) continue;

    const deps = story.dependsOn ?? [];
    if (deps.every(dep => passedIds.has(dep))) {
      return story;
    }
  }
  return null;
}

/** Effective CWD for fallback file writes — set by executeStory / main. */
let _fallbackCwd: string | null = null;
/** Current run ID for fallback entries. */
let _fallbackRunId: number = 0;

function setFallbackContext(cwd: string, runId: number): void {
  _fallbackCwd = cwd;
  _fallbackRunId = runId;
}

/** Post a WAL event to the Rorca backend (with retry + fallback). */
async function emitWalEvent(
  port: number,
  eventType: string,
  workspaceId: string,
  payload: Record<string, unknown>,
  storyId?: string,
  specId?: string,
): Promise<void> {
  const body = {
    event_type: eventType,
    workspace_id: workspaceId,
    story_id: storyId ?? null,
    spec_id: specId ?? null,
    payload,
  };

  const ok = await retryPost(
    `http://localhost:${port}/api/wal`,
    body,
    `WAL:${eventType}`,
  );

  if (!ok && _fallbackCwd) {
    const entry: FallbackResultEntry = {
      type: 'wal',
      storyId: storyId ?? null,
      status: eventType,
      runId: _fallbackRunId,
      retries: 3,
      ts: new Date().toISOString(),
      payload: body,
    };
    writeFallbackResult(_fallbackCwd, entry);
  }
}

/** POST a story result to the backend with retry + fallback. */
async function postStoryResult(
  port: number,
  body: Record<string, unknown>,
): Promise<void> {
  const ok = await retryPost(
    `http://localhost:${port}/api/pipeline/story-result`,
    body,
    `story-result:${body.storyId ?? 'unknown'}`,
  );

  if (!ok && _fallbackCwd) {
    const entry: FallbackResultEntry = {
      type: 'story_result',
      storyId: (body.storyId as string) ?? null,
      status: (body.status as string) ?? null,
      runId: _fallbackRunId,
      retries: 3,
      ts: new Date().toISOString(),
      payload: body,
    };
    writeFallbackResult(_fallbackCwd, entry);
  }
}

/** Build a clean environment stripping Claude Code vars */
function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
      env[k] = v;
    }
  }
  return env;
}

/** Read a file from the workspace, return empty string if missing */
function readWorkspaceFile(cwd: string, ...segments: string[]): string {
  try {
    return fs.readFileSync(path.join(cwd, ...segments), 'utf8');
  } catch {
    return '';
  }
}

/** Build the prompt for a story (replicates bash run-loop.sh prompt construction) */
function buildPrompt(
  story: UserStory,
  mode: 'impl' | 'qa' | 'journey',
  cwd: string,
  playbook?: string,
): string {
  const ac = getAcceptance(story);
  const acSection = ac ? `\nAcceptance Criteria:\n${ac}` : '';

  if (mode === 'journey') {
    const journeySkill = playbook ? readWorkspaceFile(cwd, playbook) : '';
    return [
      'You are simulating real users navigating the application. Read CLAUDE.md for architecture.',
      '',
      journeySkill,
      '',
      '---',
      '',
      `Your task (${story.id}): ${story.title}`,
      '',
      story.description,
      acSection,
    ].join('\n');
  }

  if (mode === 'qa') {
    const playbookInstruction = playbook && fs.existsSync(path.join(cwd, playbook))
      ? `IMPORTANT: Read ${playbook} first for test patterns, conventions, and section references mentioned in the description.`
      : '';

    return [
      'You are writing tests for this project. Read CLAUDE.md for architecture and gotchas.',
      '',
      playbookInstruction,
      '',
      '## Workflow',
      '1. Read the relevant AGENTS.md in each directory you\'ll modify',
      '2. Read any referenced docs (Playbook sections, PRDs, SDDs)',
      '3. Write the tests described below',
      '4. Run the tests and fix failures until all pass',
      '5. Run type checks: npx tsc --noEmit (frontend) and cd backend && npx tsc --noEmit (backend)',
      '6. Run npm run build to verify build succeeds',
      '',
      '## Do NOT:',
      '- Implement features or modify production code (only test files)',
      '- Skip running the tests — every test must actually execute and pass',
      '- Write placeholder/todo tests — all tests must have real assertions',
      '',
      '---',
      '',
      `Your task (${story.id}): ${story.title}`,
      '',
      story.description,
      acSection,
    ].join('\n');
  }

  // Implementation mode — inject skill file
  const skillContent = readWorkspaceFile(cwd, '.claude', 'skills', 'rorca.md')
    || readWorkspaceFile(cwd, '.claude', 'skills', 'dimitri.md');

  return [
    'Follow this workflow for implementation:',
    '',
    skillContent,
    '',
    '---',
    '',
    `Your task (${story.id}):`,
    story.description,
    acSection,
  ].join('\n');
}

interface ClaudeResult {
  exitCode: number;
  stderrTail: string; // last ~4KB of stderr for rate limit detection
  elapsedMs: number;
}

/** Spawn claude and return exit code + stderr tail + elapsed time. */
function runClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
): Promise<ClaudeResult> {
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
    // stdout → log file, stderr → pipe (so we can capture rate limit messages)
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env,
      stdio: ['ignore', logFd, 'pipe'],
    });
    fs.closeSync(logFd);

    // Capture last ~4KB of stderr for rate limit detection
    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      // Also append stderr to log file for debugging
      fs.appendFileSync(logFile, chunk);
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      // Keep only the tail
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout (replaces gtimeout --foreground)
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        // Escalate to SIGKILL after 10s if still alive
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[run-loop] Failed to spawn claude: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      // exit code null when killed by signal — treat as timeout (124, like gtimeout)
      if (code === null) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });
  });
}

/** Check if a failed story run was due to rate limiting */
function isRateLimited(result: ClaudeResult): boolean {
  if (result.exitCode === 0) return false;
  // Check stderr for rate limit indicators (case-insensitive)
  const lower = result.stderrTail.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('overloaded')) return true;
  // Heuristic: exit code 1 within < 5 seconds = immediate rejection (likely rate limit)
  if (result.exitCode === 1 && result.elapsedMs < RATE_LIMIT_FAST_EXIT_THRESHOLD_MS) return true;
  return false;
}

/** Mark a story as passed in the spec JSON file */
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

/** Mark a story as skipped in the spec JSON file */
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

/** Run git add, commit, push for a completed story */
function gitCommitStory(
  cwd: string,
  storyId: string,
  storyTitle: string,
  mode: 'impl' | 'qa' | 'journey',
): void {
  const { execSync } = require('child_process') as typeof import('child_process');
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

// ─── Validation Gate ─────────────────────────────────────────────────────────

const GATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface GateResult {
  passed: boolean;
  reason?: 'typecheck' | 'e2e';
  output?: string; // first 2000 chars of stderr/stdout
}

/**
 * Objective validation gate — runs tsc and optionally playwright after a story
 * completes. Uses exit codes, not agent self-assessment.
 */
function runGate(cwd: string): GateResult {
  const env = buildCleanEnv();

  // 1. TypeScript type check
  console.log('  [gate] Running tsc --noEmit...');
  try {
    execSync('npx tsc --noEmit', { cwd, env, stdio: 'pipe', timeout: GATE_TIMEOUT_MS });
    console.log('  [gate] tsc passed');
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString('utf8') ?? '';
    console.log(`  [gate] tsc FAILED`);
    return { passed: false, reason: 'typecheck', output: stderr.slice(0, 2000) };
  }

  // 2. Playwright (only if config exists)
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

// ─── Worktree Helpers (parallel isolation) ───────────────────────────────────

interface StoryWorktree {
  storyId: string;
  worktreePath: string;
  branchName: string;
}

/**
 * Create a git worktree for a story (parallel mode only).
 * Returns worktree info or null on failure (emits WAL event on failure).
 */
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

/**
 * Merge a story worktree branch back into the current branch of the main workspace.
 * (Legacy — used only for single-story waves where no orchestration is needed.)
 */
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
    // Abort the merge to leave workspace clean
    try { execSync('git merge --abort', { cwd: workspaceCwd, stdio: 'pipe' }); } catch { /* already clean */ }
    return false;
  }
}

// ─── Wave Merge Orchestrator (EQ-011) ────────────────────────────────────────

interface WaveMergeResult {
  success: boolean;
  conflictsResolved: number;
  /** Set if merge was blocked — contains conflicting files and the storyId that caused the block */
  blocked?: { storyId: string; conflictingFiles: string[] };
}

/**
 * Attempt to auto-resolve merge conflicts using Claude.
 * For each conflicting file, reads the conflict markers and asks Claude
 * to produce resolved content. Returns true if all conflicts resolved.
 */
async function autoResolveConflicts(
  cwd: string,
  storyId: string,
  logDir: string,
): Promise<{ resolved: boolean; resolvedFiles: string[] }> {
  const env = buildCleanEnv();
  const resolvedFiles: string[] = [];

  // Get list of conflicting files
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
      '',
      `File: ${file}`,
      '',
      conflictContent,
    ].join('\n');

    // Spawn a short Claude invocation for conflict resolution
    const resolveLogFile = path.join(logDir, `${storyId}_merge_resolve_${path.basename(file)}.log`);
    const resolvedContent = await new Promise<string | null>((resolve) => {
      const args = [
        '--dangerously-skip-permissions',
        '--print',
        prompt,
      ];

      let stdout = '';
      const child = spawn(CLAUDE_BIN, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

      // Log stderr for debugging
      const logFd = fs.openSync(resolveLogFile, 'a');
      child.stderr.on('data', (chunk: Buffer) => { fs.writeSync(logFd, chunk); });

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }, 120_000); // 2min timeout for conflict resolution

      child.on('exit', (code) => {
        clearTimeout(timer);
        try { fs.closeSync(logFd); } catch { /* already closed */ }
        if (code === 0 && stdout.trim().length > 0) {
          resolve(stdout);
        } else {
          resolve(null);
        }
      });

      child.on('error', () => {
        clearTimeout(timer);
        try { fs.closeSync(logFd); } catch { /* already closed */ }
        resolve(null);
      });
    });

    if (resolvedContent === null) {
      console.error(`  [merge] Auto-resolution FAILED for ${file} (Claude exit non-zero or empty)`);
      return { resolved: false, resolvedFiles };
    }

    // Write resolved content and stage the file
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

/**
 * Merge wave branches sequentially in ascending story-ID order.
 *
 * Uses `git merge --no-ff --no-commit` to detect conflicts before committing.
 * On conflict: attempts auto-resolution via Claude. If that fails, aborts and
 * returns a blocked result for HITL intervention.
 *
 * @param waveBranches — worktree info sorted by story ID
 * @param waveIndex — wave number for commit messages and WAL events
 * @param cwd — main workspace path (target branch)
 * @param logDir — directory for merge resolution logs
 */
async function mergeWave(
  waveBranches: StoryWorktree[],
  waveIndex: number,
  cwd: string,
  logDir: string,
): Promise<WaveMergeResult> {
  const env = buildCleanEnv();

  // Sort by story ID for deterministic merge order
  const sorted = [...waveBranches].sort((a, b) => a.storyId.localeCompare(b.storyId));

  let totalConflictsResolved = 0;

  for (const wt of sorted) {
    console.log(`  [merge] Merging ${wt.branchName} (${wt.storyId})...`);

    // Step 1: merge --no-ff --no-commit to detect conflicts
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
      // Clean merge — commit
      try {
        execSync(
          `git commit -m "merge: ${wt.storyId}"`,
          { cwd, env, stdio: 'pipe', timeout: 30_000 },
        );
        console.log(`  [merge] ${wt.storyId} merged cleanly`);
      } catch {
        // Nothing to commit (identical trees) — that's fine
        console.log(`  [merge] ${wt.storyId} merged (no changes to commit)`);
      }
      continue;
    }

    // Step 2: merge conflict detected — attempt auto-resolution
    console.log(`  [merge] Conflict detected for ${wt.storyId}, attempting auto-resolution...`);

    const resolution = await autoResolveConflicts(cwd, wt.storyId, logDir);

    if (resolution.resolved) {
      // All conflicts resolved — commit
      const filesList = resolution.resolvedFiles.join(', ');
      try {
        execSync(
          `git commit -m "merge(wave-${waveIndex}): resolved conflicts in ${filesList}"`,
          { cwd, env, stdio: 'pipe', timeout: 30_000 },
        );
        totalConflictsResolved += resolution.resolvedFiles.length;
        console.log(`  [merge] ${wt.storyId} merged with ${resolution.resolvedFiles.length} conflict(s) resolved`);
      } catch (err: unknown) {
        // Commit failed — abort and block
        console.error(`  [merge] Commit after resolution failed: ${(err as Error).message}`);
        try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }

        // Get conflicting files for the blocked event
        let conflictingFiles: string[] = [];
        try {
          const output = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
          conflictingFiles = output.trim().split('\n').filter(Boolean);
        } catch { /* empty */ }

        return {
          success: false,
          conflictsResolved: totalConflictsResolved,
          blocked: { storyId: wt.storyId, conflictingFiles },
        };
      }
    } else {
      // Auto-resolution failed — abort merge and block
      console.error(`  [merge] Auto-resolution failed for ${wt.storyId} — blocking run`);
      try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }

      // Get conflicting files for the blocked event
      let conflictingFiles: string[] = [];
      try {
        // Re-attempt merge to get conflict file list (we just aborted)
        try {
          execSync(`git merge --no-ff --no-commit "${wt.branchName}"`, { cwd, env, stdio: 'pipe', timeout: 30_000 });
        } catch { /* expected to fail */ }
        const output = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        conflictingFiles = output.trim().split('\n').filter(Boolean);
        try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* clean up */ }
      } catch { /* empty */ }

      return {
        success: false,
        conflictsResolved: totalConflictsResolved,
        blocked: { storyId: wt.storyId, conflictingFiles },
      };
    }
  }

  return { success: true, conflictsResolved: totalConflictsResolved };
}

/**
 * Remove a worktree and delete its branch.
 */
function removeStoryWorktree(workspaceCwd: string, wt: StoryWorktree): void {
  try {
    execSync(`git worktree remove --force "${wt.worktreePath}"`, { cwd: workspaceCwd, stdio: 'pipe', timeout: 30_000 });
  } catch { /* already removed */ }
  try {
    execSync(`git branch -D "${wt.branchName}"`, { cwd: workspaceCwd, stdio: 'pipe', timeout: 10_000 });
  } catch { /* branch may already be gone */ }
  console.log(`  [worktree] Removed ${wt.worktreePath}`);
}

// ─── Parallel Execution Helpers ──────────────────────────────────────────────

/**
 * Run a single story end-to-end: emit WAL events, spawn claude, handle result.
 * Returns 'passed' | 'failed' | 'skipped'.
 *
 * @param storyCwd — override cwd for worktree isolation (defaults to config.cwd)
 * @param worktreeInfo — if running in a worktree, provides path/branch for story_results
 */
async function executeStory(
  story: UserStory,
  config: RunLoopConfig,
  mode: 'impl' | 'qa' | 'journey',
  playbook: string | undefined,
  logDir: string,
  workspaceId: string | null,
  retryCounts: Map<string, number>,
  storyCwd?: string,
  worktreeInfo?: StoryWorktree,
  waveIndex?: number,
): Promise<'passed' | 'failed' | 'skipped'> {
  const effectiveCwd = storyCwd ?? config.cwd;
  const timeoutMin = story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

  // Set fallback context so emitWalEvent / postStoryResult can write .rorca-results.jsonl
  setFallbackContext(effectiveCwd, config.runId);

  console.log(`[${mode}] ${story.id}: ${story.title}`);
  if (worktreeInfo) console.log(`  Worktree: ${worktreeInfo.worktreePath}`);
  console.log(`  Timeout: ${timeoutMin}m`);

  // Build prompt — use worktree cwd so skill files are read from worktree
  const prompt = buildPrompt(story, mode, effectiveCwd, playbook);

  // Write prompt to log file for debugging
  const promptLogFile = path.join(logDir, `${story.id}_prompt.txt`);
  fs.writeFileSync(promptLogFile, prompt);

  // Story log file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const storyLogFile = path.join(logDir, `${story.id}_${timestamp}.log`);

  // Emit story_started WAL event
  if (workspaceId) {
    await emitWalEvent(config.port, 'story_started', workspaceId, {
      run_id: config.runId,
      story_id: story.id,
      story_title: story.title,
      log_file: storyLogFile,
      ...(waveIndex != null ? { wave_index: waveIndex } : {}),
      ...(worktreeInfo ? { worktree_path: worktreeInfo.worktreePath, worktree_branch: worktreeInfo.branchName } : {}),
    }, story.id);
  }

  // Build story-result body with optional worktree fields
  const storyResultExtra = worktreeInfo
    ? { worktreePath: worktreeInfo.worktreePath, worktreeBranch: worktreeInfo.branchName }
    : {};

  // Track rate limit retries separately from logic retries
  const rateLimitKey = `rl:${story.id}`;
  let rateLimitAttempts = retryCounts.get(rateLimitKey) ?? 0;

  // Rate limit retry loop — re-spawns story after exponential backoff
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Run Claude — in worktree cwd if provided
    const result = await runClaude(
      prompt,
      effectiveCwd,
      timeoutMin * 60 * 1000,
      storyLogFile,
    );

    // ── Rate limit detection (before normal exit code handling) ─────────
    if (result.exitCode !== 0 && result.exitCode !== 124 && isRateLimited(result)) {
      rateLimitAttempts++;
      retryCounts.set(rateLimitKey, rateLimitAttempts);

      if (rateLimitAttempts > MAX_RATE_LIMIT_RETRIES) {
        console.log(`${story.id} rate limited ${rateLimitAttempts} times — exhausted. Marking failed.`);
        markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: 'rate_limit_exhausted',
            attempts: rateLimitAttempts,
          }, story.id);

          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra });
        }
        return 'failed';
      }

      const backoffMs = RATE_LIMIT_BACKOFF_MS[rateLimitAttempts - 1] ?? RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
      console.log(`${story.id} rate limited (attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}). Retrying in ${backoffMs / 1000}s...`);

      // Emit story_rate_limited WAL event — drives UI amber state
      if (workspaceId) {
        await emitWalEvent(config.port, 'story_rate_limited', workspaceId, {
          run_id: config.runId,
          story_id: story.id,
          attempt: rateLimitAttempts,
          retryAfterMs: backoffMs,
          waveIndex: worktreeInfo ? undefined : 0, // wave index not available here; set by caller context
        }, story.id);
      }

      // Backoff — sleep then re-spawn
      await new Promise(resolve => setTimeout(resolve, backoffMs));

      // Re-emit story_started before retry
      if (workspaceId) {
        await emitWalEvent(config.port, 'story_started', workspaceId, {
          run_id: config.runId,
          story_id: story.id,
          story_title: story.title,
          log_file: storyLogFile,
          ...(waveIndex != null ? { wave_index: waveIndex } : {}),
          ...(worktreeInfo ? { worktree_path: worktreeInfo.worktreePath, worktree_branch: worktreeInfo.branchName } : {}),
        }, story.id);
      }
      continue; // retry the story
    }

    // ── Normal exit code handling ──────────────────────────────────────
    if (result.exitCode === 0) {
      console.log(`${story.id} completed (exit 0)`);

      // Validation gate — run in the story's own cwd
      const skipGate = config.dryRun || process.env.RORCA_SKIP_GATE === '1';
      const gate = skipGate ? { passed: true } as GateResult : runGate(effectiveCwd);

      if (!gate.passed) {
        console.log(`${story.id} agent succeeded but gate failed: ${gate.reason}`);
        const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
        retryCounts.set(story.id, currentRetries);

        if (currentRetries >= MAX_RETRIES) {
          markStorySkipped(config.jsonPath, story.id);
        }

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: gate.reason,
            ...(gate.reason === 'typecheck' ? { stderr: gate.output } : { summary: gate.output }),
          }, story.id);

          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra });
        }

        if (currentRetries >= MAX_RETRIES) {
          console.log(`${story.id} failed gate after ${MAX_RETRIES} attempts. Skipping.`);
          return 'failed';
        }
        return 'failed';
      }

      // Gate passed — commit in the story's cwd (worktree or main)
      markStoryPassed(config.jsonPath, story.id);
      retryCounts.delete(story.id);
      retryCounts.delete(rateLimitKey);

      console.log(`Committing ${story.id}...`);
      gitCommitStory(effectiveCwd, story.id, story.title, mode);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_passed', workspaceId, {
          run_id: config.runId,
          story_id: story.id,
          story_title: story.title,
        }, story.id);

        await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'pass', ...storyResultExtra });
      }
      return 'passed';
    }

    if (result.exitCode === 124) {
      console.log(`${story.id} timed out after ${timeoutMin}m (exit 124)`);
      console.log(`   Log: ${storyLogFile}`);
      markStorySkipped(config.jsonPath, story.id);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId,
          story_id: story.id,
          reason: 'timeout',
          timeout_minutes: timeoutMin,
        }, story.id);

        await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra });
      }
      return 'failed';
    }

    // Non-zero exit — retry logic (not rate limit)
    const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
    retryCounts.set(story.id, currentRetries);

    if (currentRetries >= MAX_RETRIES) {
      console.log(`${story.id} failed after ${MAX_RETRIES} attempts. Skipping.`);
      console.log(`   Log: ${storyLogFile}`);
      markStorySkipped(config.jsonPath, story.id);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId,
          story_id: story.id,
          reason: 'max_retries',
          attempts: currentRetries,
        }, story.id);

        await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', ...storyResultExtra });
      }
      return 'failed';
    }

    console.log(`${story.id} failed (attempt ${currentRetries}/${MAX_RETRIES})`);
    console.log(`   Log: ${storyLogFile}`);
    return 'failed';
  } // end while (rate limit retry loop)
}

/**
 * Compute the transitive set of story IDs that are blocked because they depend
 * (directly or transitively) on at least one story in `failedIds`.
 */
function computeBlockedStories(
  allStories: UserStory[],
  failedIds: Set<string>,
  alreadyProcessed: Set<string>,
): Map<string, string[]> {
  // Build reverse-dep lookup: for each story, which other stories depend on it
  const blocked = new Map<string, string[]>(); // storyId -> [blockedBy ids]
  const unprocessed = allStories.filter(s =>
    !alreadyProcessed.has(s.id) && !failedIds.has(s.id) && !s.excluded && !s.skipped && !isPassed(s)
  );

  // BFS: start from failedIds, propagate to all transitive dependents
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

/**
 * Run tasks with bounded concurrency using Promise.allSettled semantics.
 * At most `limit` tasks run concurrently; the rest queue up as workers free.
 */
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

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();

  if (!fs.existsSync(config.jsonPath)) {
    console.error(`Error: JSON file not found: ${config.jsonPath}`);
    process.exit(1);
  }

  // Create log directory
  const logDir = path.join(path.dirname(config.jsonPath), '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const spec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
  const mode = detectMode(spec);
  const playbook = spec.playbook;
  const stories = getStories(spec);

  const modeLabel = mode === 'qa' ? 'QA Testing' : mode === 'journey' ? 'User Journey' : 'Implementation';
  const progress = getProgress(stories);

  console.log('========================================');
  console.log(`  Ralph Loop — ${modeLabel} (TypeScript)`);
  console.log('========================================');
  console.log('');
  console.log(`Progress: ${progress.passed}/${progress.total}`);
  console.log(`Parallelism: ${config.parallelism}`);
  console.log(`JSON: ${config.jsonPath}`);
  if (playbook) console.log(`Playbook: ${playbook}`);
  console.log('');

  // Detect workspace ID from the Rorca backend (look up by cwd path)
  const workspaceId = await resolveWorkspaceId(config.port, config.cwd);

  // Track retries per story
  const retryCounts = new Map<string, number>();

  // Set fallback context for emitWalEvent / postStoryResult fallback file writes
  setFallbackContext(config.cwd, config.runId);

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('');
    console.log('Loop stopped by user.');
    process.exit(0);
  });

  // ─── Parallel execution path (N > 1) ────────────────────────────────────
  if (config.parallelism > 1 && !config.specificStory) {
    await runParallel(config, mode, playbook, logDir, workspaceId, retryCounts, stories);
    return;
  }

  // ─── Sequential execution path (N = 1, identical to original) ───────────
  let iteration = 0;

  while (true) {
    iteration++;

    // Re-read spec each iteration (it gets modified after each story)
    const currentSpec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
    const currentStories = getStories(currentSpec);

    // Find next story
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

    // Check if done
    if (!story) {
      const finalProgress = getProgress(currentStories);
      console.log('');
      console.log(`All stories complete! ${finalProgress.passed}/${finalProgress.total}`);
      process.exit(0);
    }

    const currentProgress = getProgress(currentStories);
    const timeoutMin = story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

    console.log('------------------------------------------');
    console.log(`[${mode}] Iteration ${iteration} | ${story.id}: ${story.title}`);
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

    // Build prompt
    const prompt = buildPrompt(story, mode, config.cwd, playbook);

    // Write prompt to log file for debugging
    const promptLogFile = path.join(logDir, `${story.id}_prompt.txt`);
    fs.writeFileSync(promptLogFile, prompt);

    // Story log file
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
        log_file: storyLogFile,
      }, story.id);
    }

    // Run Claude
    const result = await runClaude(
      prompt,
      config.cwd,
      timeoutMin * 60 * 1000,
      storyLogFile,
    );

    console.log('');

    // ── Rate limit detection (sequential path) ─────────────────────────
    if (result.exitCode !== 0 && result.exitCode !== 124 && isRateLimited(result)) {
      const rateLimitKey = `rl:${story.id}`;
      const rlAttempts = (retryCounts.get(rateLimitKey) ?? 0) + 1;
      retryCounts.set(rateLimitKey, rlAttempts);

      if (rlAttempts > MAX_RATE_LIMIT_RETRIES) {
        console.log(`${story.id} rate limited ${rlAttempts} times — exhausted. Skipping.`);
        markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: 'rate_limit_exhausted',
            attempts: rlAttempts,
          }, story.id);

          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail' });
        }
      } else {
        const backoffMs = RATE_LIMIT_BACKOFF_MS[rlAttempts - 1] ?? RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
        console.log(`${story.id} rate limited (attempt ${rlAttempts}/${MAX_RATE_LIMIT_RETRIES}). Retrying in ${backoffMs / 1000}s...`);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_rate_limited', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            attempt: rlAttempts,
            retryAfterMs: backoffMs,
            waveIndex: 0,
          }, story.id);
        }

        await new Promise(resolve => setTimeout(resolve, backoffMs));
        // Don't increment normal retries — loop will re-pick this story
      }
    } else if (result.exitCode === 0) {
      console.log(`${story.id} completed (exit 0)`);

      // Validation gate — skip on dry-run or RORCA_SKIP_GATE=1
      const skipGate = config.dryRun || process.env.RORCA_SKIP_GATE === '1';
      const gate = skipGate ? { passed: true } as GateResult : runGate(config.cwd);

      if (!gate.passed) {
        console.log(`${story.id} agent succeeded but gate failed: ${gate.reason}`);

        // Gate failure counts as a retry attempt
        const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
        retryCounts.set(story.id, currentRetries);

        if (currentRetries >= MAX_RETRIES) {
          markStorySkipped(config.jsonPath, story.id);
        }

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: gate.reason,
            ...(gate.reason === 'typecheck' ? { stderr: gate.output } : { summary: gate.output }),
          }, story.id);

          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail' });
        }

        if (currentRetries >= MAX_RETRIES) {
          console.log(`${story.id} failed gate after ${MAX_RETRIES} attempts. Skipping.`);
          console.log(`   Fix manually, then re-run with: --story ${story.id}`);
        } else {
          console.log(`${story.id} gate failed (attempt ${currentRetries}/${MAX_RETRIES}). Will retry...`);
        }
      } else {
        // Gate passed — proceed with marking story passed and committing
        markStoryPassed(config.jsonPath, story.id);
        retryCounts.delete(story.id);
        retryCounts.delete(`rl:${story.id}`);

        console.log(`Committing ${story.id}...`);
        gitCommitStory(config.cwd, story.id, story.title, mode);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_passed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            story_title: story.title,
          }, story.id);

          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'pass' });
        }
      }
    } else if (result.exitCode === 124) {
      // Timeout (mirrors gtimeout exit code 124)
      console.log(`${story.id} timed out after ${timeoutMin}m (exit 124)`);
      console.log(`   Log: ${storyLogFile}`);
      console.log('   Consider increasing timeoutMinutes for this story in the spec JSON');
      markStorySkipped(config.jsonPath, story.id);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId,
          story_id: story.id,
          reason: 'timeout',
          timeout_minutes: timeoutMin,
        }, story.id);

        await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail' });
      }
    } else {
      // Failure with retry logic
      const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
      retryCounts.set(story.id, currentRetries);

      if (currentRetries >= MAX_RETRIES) {
        console.log(`${story.id} failed after ${MAX_RETRIES} attempts. Skipping.`);
        console.log(`   Log: ${storyLogFile}`);
        console.log(`   Fix manually, then re-run with: --story ${story.id}`);
        markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: 'max_retries',
            attempts: currentRetries,
          }, story.id);

          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail' });
        }
      } else {
        console.log(`${story.id} failed (attempt ${currentRetries}/${MAX_RETRIES})`);
        console.log(`   Log: ${storyLogFile}`);
        console.log('   Will retry...');
      }
    }

    // If running a specific story, exit after one run
    if (config.specificStory) {
      process.exit(result.exitCode);
    }

    console.log('');

    // Brief pause between stories
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

// ─── Parallel Execution (N > 1) ──────────────────────────────────────────────

async function runParallel(
  config: RunLoopConfig,
  mode: 'impl' | 'qa' | 'journey',
  playbook: string | undefined,
  logDir: string,
  workspaceId: string | null,
  retryCounts: Map<string, number>,
  stories: UserStory[],
): Promise<void> {
  // Convert to wave-compiler format (fields have compatible shape)
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
    console.error(`[run-loop] Dependency cycle detected among stories: ${waveResult.involvedIds.join(', ')}`);
    console.error(`[run-loop] Cannot run in parallel mode. Fix dependsOn fields or use --parallelism 1`);
    process.exit(1);
  }

  const waves: Wave[] = waveResult;

  console.log(`Compiled ${stories.length} stories into ${waves.length} waves`);
  for (const wave of waves) {
    console.log(`  Wave ${wave.index}: ${wave.stories.map(s => s.id).join(', ')}`);
  }
  console.log('');

  // Emit run_started with parallelism + waveCount
  if (workspaceId) {
    await emitWalEvent(config.port, 'run_started', workspaceId, {
      run_id: config.runId,
      parallelism: config.parallelism,
      waveCount: waves.length,
    });
  }

  // Derive spec slug for worktree branch naming
  const specSlug = path.basename(config.jsonPath, '.json').replace(/[^a-z0-9-]/gi, '-');

  // Track all failed story IDs across waves for transitive blocking
  const failedIds = new Set<string>();
  const processedIds = new Set<string>();

  for (const wave of waves) {
    console.log('==========================================');
    console.log(`  Wave ${wave.index} — ${wave.stories.length} stories (parallelism=${config.parallelism})`);
    console.log('==========================================');

    // Filter out stories that are blocked by earlier failures
    const executableStories: UserStory[] = [];
    for (const waveStory of wave.stories) {
      // Look up the original UserStory (with full fields like acceptance, notes, etc.)
      const original = stories.find(s => s.id === waveStory.id);
      if (!original) continue;

      if (original.excluded || original.skipped) {
        processedIds.add(original.id);
        continue;
      }

      // Check if any direct dependency failed
      const deps = original.dependsOn ?? [];
      const blockers = deps.filter(dep => failedIds.has(dep));
      if (blockers.length > 0) {
        // This story is blocked — skip it
        console.log(`  ${original.id} BLOCKED by: ${blockers.join(', ')}`);
        failedIds.add(original.id);
        processedIds.add(original.id);
        markStorySkipped(config.jsonPath, original.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: original.id,
            reason: 'blocked_by',
            blockedBy: blockers,
          }, original.id);

          await postStoryResult(config.port, { runId: config.runId, storyId: original.id, status: 'skip' });
        }
        continue;
      }

      executableStories.push(original);
    }

    if (executableStories.length === 0) {
      console.log('  No executable stories in this wave — skipping');
      continue;
    }

    // ── Worktree isolation: create one worktree per story ─────────────────
    const worktreeMap = new Map<string, StoryWorktree>();

    for (const story of executableStories) {
      const wt = createStoryWorktree(config.cwd, specSlug, story.id);
      if (wt) {
        worktreeMap.set(story.id, wt);
      } else {
        // Worktree creation failed → treat as story failure
        failedIds.add(story.id);
        processedIds.add(story.id);
        markStorySkipped(config.jsonPath, story.id);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: 'worktree_create_failed',
          }, story.id);

          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail' });
        }
      }
    }

    // Only execute stories that got a worktree
    const storiesWithWorktrees = executableStories.filter(s => worktreeMap.has(s.id));

    // Build task functions for bounded concurrency — each story runs in its worktree
    const tasks = storiesWithWorktrees.map(story => {
      const wt = worktreeMap.get(story.id)!;
      return () =>
        executeStory(story, config, mode, playbook, logDir, workspaceId, retryCounts, wt.worktreePath, wt, wave.index)
          .then(result => ({ storyId: story.id, result }));
    });

    // Run with bounded concurrency — Promise.allSettled semantics
    const results = await runWithBoundedConcurrency(tasks, config.parallelism);

    // Collect results — track passed/failed for merge decisions
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
        // Should not happen since executeStory handles its own errors,
        // but handle defensively
        console.error(`[run-loop] Unexpected rejection in wave ${wave.index}:`, settled.reason);
      }
    }

    // ── Post-wave: merge passed worktrees via wave merge orchestrator ────
    if (passedInWave.length > 0) {
      if (passedInWave.length === 1) {
        // Single story in wave — skip orchestrator, merge directly
        console.log(`  [worktree] Single-story wave — direct merge`);
        const wt = passedInWave[0];
        const merged = mergeStoryWorktree(config.cwd, wt);
        if (!merged) {
          console.error(`  [worktree] ${wt.storyId} passed but merge failed — marking as failed`);
          failedIds.add(wt.storyId);

          if (workspaceId) {
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId,
              story_id: wt.storyId,
              reason: 'merge_conflict',
              worktree_branch: wt.branchName,
            }, wt.storyId);
          }
        }
        removeStoryWorktree(config.cwd, wt);
      } else {
        // Multi-story wave — use wave merge orchestrator
        console.log(`  [worktree] Merging ${passedInWave.length} passed worktree(s) via wave merge orchestrator...`);
        const mergeResult = await mergeWave(passedInWave, wave.index, config.cwd, logDir);

        if (mergeResult.success) {
          // All merged — emit wave_merged WAL event
          if (workspaceId) {
            await emitWalEvent(config.port, 'wave_merged', workspaceId, {
              run_id: config.runId,
              wave: wave.index,
              storiesCount: passedInWave.length,
              conflictsResolved: mergeResult.conflictsResolved,
            });
          }
          console.log(`  [merge] Wave ${wave.index} merged successfully (${mergeResult.conflictsResolved} conflict(s) resolved)`);

          // Clean up all passed worktrees + branches
          for (const wt of passedInWave) {
            removeStoryWorktree(config.cwd, wt);
          }
        } else if (mergeResult.blocked) {
          // Merge blocked — emit run_blocked WAL event, pause the run
          console.error(`  [merge] Wave ${wave.index} BLOCKED on ${mergeResult.blocked.storyId}`);
          console.error(`  [merge] Conflicting files: ${mergeResult.blocked.conflictingFiles.join(', ')}`);

          if (workspaceId) {
            await emitWalEvent(config.port, 'run_blocked', workspaceId, {
              run_id: config.runId,
              reason: 'merge_conflict',
              conflictingFiles: mergeResult.blocked.conflictingFiles,
              wave: wave.index,
              storyId: mergeResult.blocked.storyId,
            });
          }

          // Mark the blocking story as failed
          failedIds.add(mergeResult.blocked.storyId);

          // Don't clean up worktrees — user needs the branches for manual resolution
          console.log(`  [merge] Worktree branches preserved for manual resolution. Pausing run.`);

          // Clean up only the failed worktrees (not passed — user may need to inspect)
          for (const wt of failedInWave) {
            removeStoryWorktree(config.cwd, wt);
          }

          // Pause — exit with code 2 to indicate HITL needed
          console.log(`\n[run-loop] Run paused due to merge conflict. Resolve manually and resume.`);
          process.exit(2);
        }
      }
    }

    // Clean up failed worktrees — no merge, just remove
    for (const wt of failedInWave) {
      removeStoryWorktree(config.cwd, wt);
    }

    // After wave settles: compute transitively blocked stories in remaining waves
    const allStories = getStories(JSON.parse(fs.readFileSync(config.jsonPath, 'utf8')));
    const newlyBlocked = computeBlockedStories(allStories, failedIds, processedIds);

    for (const [blockedId, blockers] of newlyBlocked) {
      // Only emit for stories not yet processed
      if (!processedIds.has(blockedId)) {
        console.log(`  ${blockedId} transitively BLOCKED by: ${blockers.join(', ')}`);
        failedIds.add(blockedId);
        processedIds.add(blockedId);
        markStorySkipped(config.jsonPath, blockedId);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: blockedId,
            reason: 'blocked_by',
            blockedBy: blockers,
          }, blockedId);

          await postStoryResult(config.port, { runId: config.runId, storyId: blockedId, status: 'skip' });
        }
      }
    }

    console.log('');

    // Brief pause between waves
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Final summary
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

/** Look up workspace ID from the Rorca backend by path */
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

/** Parse command-line arguments */
function parseArgs(): RunLoopConfig {
  const args = process.argv.slice(2);
  let jsonPath = '';
  let cwd = '';
  let runId = 0;
  let specificStory: string | undefined;
  let dryRun = false;
  let port = parseInt(process.env.PORT ?? '3030', 10);
  let parallelism = 1;

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
      default:
        console.error(`Unknown arg: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!jsonPath || !cwd || !runId) {
    console.error('Usage: run-loop.ts --json <path> --cwd <path> --run-id <number> [--story <id>] [--dry-run] [--port <number>] [--parallelism <N>]');
    process.exit(1);
  }

  return { jsonPath, cwd, runId, specificStory, dryRun, port, parallelism };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[run-loop] Fatal error:', err);
  process.exit(1);
});
