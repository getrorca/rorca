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
 *   --json <path>       Spec JSON file (required)
 *   --cwd <path>        Working directory / workspace root (required)
 *   --run-id <number>   Pipeline run ID for WAL event reporting (required)
 *   --story <id>        Run a single specific story
 *   --dry-run           Preview next story without executing
 *   --port <number>     Backend port for WAL events (default: 3030)
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
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

/** Post a WAL event to the Rorca backend */
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
    // Backend may be down — log but don't abort the run
    console.error(`[run-loop] Failed to emit WAL event: ${eventType}`);
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

/** Spawn claude and return exit code. Resolves when process exits. */
function runClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
): Promise<number> {
  return new Promise((resolve) => {
    const env = buildCleanEnv();

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
      stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd);

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
      resolve(1);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      // exit code null when killed by signal — treat as timeout (124, like gtimeout)
      if (code === null) {
        resolve(124);
      } else {
        resolve(code);
      }
    });
  });
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
  console.log(`JSON: ${config.jsonPath}`);
  if (playbook) console.log(`Playbook: ${playbook}`);
  console.log('');

  // Detect workspace ID from the Rorca backend (look up by cwd path)
  const workspaceId = await resolveWorkspaceId(config.port, config.cwd);

  // Track retries per story
  const retryCounts = new Map<string, number>();
  let iteration = 0;

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('');
    console.log('Loop stopped by user.');
    process.exit(0);
  });

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
      }, story.id);
    }

    // Run Claude
    const exitCode = await runClaude(
      prompt,
      config.cwd,
      timeoutMin * 60 * 1000,
      storyLogFile,
    );

    console.log('');

    if (exitCode === 0) {
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

          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                runId: config.runId,
                storyId: story.id,
                status: 'fail',
              }),
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
        // Gate passed — proceed with marking story passed and committing
        markStoryPassed(config.jsonPath, story.id);
        retryCounts.delete(story.id);

        console.log(`Committing ${story.id}...`);
        gitCommitStory(config.cwd, story.id, story.title, mode);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_passed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            story_title: story.title,
          }, story.id);

          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                runId: config.runId,
                storyId: story.id,
                status: 'pass',
              }),
            });
          } catch { /* backend may be down */ }
        }
      }
    } else if (exitCode === 124) {
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

        try {
          await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runId: config.runId,
              storyId: story.id,
              status: 'fail',
            }),
          });
        } catch { /* backend may be down */ }
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

          try {
            await fetch(`http://localhost:${config.port}/api/pipeline/story-result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                runId: config.runId,
                storyId: story.id,
                status: 'fail',
              }),
            });
          } catch { /* backend may be down */ }
        }
      } else {
        console.log(`${story.id} failed (attempt ${currentRetries}/${MAX_RETRIES})`);
        console.log(`   Log: ${storyLogFile}`);
        console.log('   Will retry...');
      }
    }

    // If running a specific story, exit after one run
    if (config.specificStory) {
      process.exit(exitCode);
    }

    console.log('');

    // Brief pause between stories
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
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
      default:
        console.error(`Unknown arg: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!jsonPath || !cwd || !runId) {
    console.error('Usage: run-loop.ts --json <path> --cwd <path> --run-id <number> [--story <id>] [--dry-run] [--port <number>]');
    process.exit(1);
  }

  return { jsonPath, cwd, runId, specificStory, dryRun, port };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[run-loop] Fatal error:', err);
  process.exit(1);
});
