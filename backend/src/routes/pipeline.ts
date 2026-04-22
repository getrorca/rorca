import { Router, Request, Response } from 'express';
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import simpleGit from 'simple-git';
import { z } from 'zod';
import { query, queryOne, execute, transaction } from '../db/index';
import { validateBody } from '../lib/validate';
import { broadcastAll, attachSSE, type WalEvent } from '../lib/sse-hub';
import { runHooks } from '../lib/hook-runner';
import { estimateDryRunCost } from '../lib/cost-estimator';
import { chatComplete, DEFAULT_MODEL, resolveVaultProvider } from '../lib/llm-client';
import { getWorkspaceEnvVars } from './env-vars';
import { checkBudgetThresholds } from './budget';
import { getVaultKey } from './vault';
import { getCopilotToken } from './copilot';
import type { AuthUser } from './auth';
import type { AgentProfileRow } from './agent-profiles';
import { handleRouteError } from '../lib/async-handler';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';
import { getEffectiveUser } from '../lib/get-user';
import { parseLine, type SemanticStep } from '../lib/semantic-log-parser';
import { agentConfig, type AgentType } from '../lib/config';
import { resolveWorkflowConfig } from '../lib/workflow-config-resolver';
import { OpenCodeServer } from '../lib/opencode-server';
import { synthesize } from '../lib/direction-stack';
import { scanRequiredEngines, countStoriesByEngine, resolveStoryAgent, reroutedStories, type EngineUserStory } from '../lib/execution-engine';
import { readRunState, type RunState } from '../lib/run-state';
import { checkSpec, type CapabilityStory, type StoryCapabilityReport } from '../lib/tool-capability-checker';
import { loadOrchestrationConfig, type CapabilityMismatchMode } from '../lib/complexity-scorer';
import { readFallbackResults, deleteFallbackFile, getFallbackFilename, type FallbackResultEntry } from '../lib/resilient-post';
import { advanceQueue } from '../lib/run-queue';
import { compileWaves, isCycleError, type Wave, type UserStory as WaveUserStory } from '../lib/wave-compiler';
import { detectDrift, isDriftCheckEnabled, hasBlockingViolations, type DriftReport } from '../lib/drift-detector';
import { synthesizeRunMemory } from '../lib/auto-memory';
import { logger } from '../lib/logger';
import { getBoss } from '../lib/pg-boss';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { sweepOrphanProcesses, type OrphanSweepResult } from '../worker';

// ── Claude binary + env-var stripping for agentic conflict resolution ─────────
// Same pattern as execution-engine.ts — strips nested-session detection vars.
const CLAUDE_BIN_PIPELINE = process.env.CLAUDE_BIN ||
  (() => {
    try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return 'claude'; }
  })();

const CLAUDE_ENV_VARS_STRIP = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

function buildCleanEnvForMerge(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_VARS_STRIP.includes(k)) {
      env[k] = v;
    }
  }
  return env;
}

/** Auto-select sequential vs wave-parallel based on dependency graph analysis. */
function autoSelectOrchestration(userStories: WaveUserStory[]): {
  mode: 'sequential' | 'wave-parallel';
  parallelism: number;
  reason: string;
  waveCount: number;
  maxWaveSize: number;
  totalStories: number;
  waves: { index: number; storyIds: string[] }[];
} {
  const pending = userStories.filter(s => !s.passes && !s.excluded);
  const totalStories = pending.length;

  if (totalStories === 0) {
    return { mode: 'sequential', parallelism: 1, reason: 'no pending stories', waveCount: 0, maxWaveSize: 0, totalStories: 0, waves: [] };
  }

  const waveResult = compileWaves(pending);
  if (isCycleError(waveResult)) {
    return { mode: 'sequential', parallelism: 1, reason: `cycle detected among ${waveResult.involvedIds.join(', ')}`, waveCount: 0, maxWaveSize: 0, totalStories, waves: [] };
  }

  const waves: Wave[] = waveResult;
  const maxWaveSize = Math.max(...waves.map(w => w.stories.length));
  const waveCount = waves.length;
  const waveSummary = waves.map(w => ({ index: w.index, storyIds: w.stories.map(s => s.id) }));

  // Decision rules:
  // 1. If max wave size < 2 (all waves have exactly 1 story) → sequential
  // 2. If total stories < 5 → sequential (overhead not worth it)
  // 3. Otherwise → wave-parallel with parallelism = maxWaveSize
  if (maxWaveSize < 2) {
    return {
      mode: 'sequential', parallelism: 1,
      reason: `max wave size: ${maxWaveSize}, stories: ${totalStories}`,
      waveCount, maxWaveSize, totalStories, waves: waveSummary,
    };
  }

  if (totalStories < 5) {
    return {
      mode: 'sequential', parallelism: 1,
      reason: `total stories: ${totalStories} (< 5 threshold)`,
      waveCount, maxWaveSize, totalStories, waves: waveSummary,
    };
  }

  return {
    mode: 'wave-parallel', parallelism: maxWaveSize,
    reason: `max wave size: ${maxWaveSize}, stories: ${totalStories}`,
    waveCount, maxWaveSize, totalStories, waves: waveSummary,
  };
}

/** Extract semantic steps from a raw text chunk (may contain multiple lines). */
function emitSemanticSteps(text: string, agent: string, res: Response): void {
  const lines = text.split('\n');
  for (const line of lines) {
    const steps = parseLine(line, agent);
    for (const step of steps) {
      res.write(`event: semantic_step\ndata: ${JSON.stringify(step)}\n\n`);
    }
  }
}

/** Legacy tmp-based log path (used as fallback for old runs) */
const tmpLogPath = (runId: number) => path.join(os.tmpdir(), `rorca-run-${runId}.log`);

/** Persistent log file path inside workspace/forge/logs/ — survives backend restarts */
function workspaceLogPath(workspacePath: string, runId: number): string {
  const logDir = path.join(workspacePath, 'forge', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `run-${runId}.log`);
}

/** Resolve log path for a run: check DB log_path, then legacy /tmp path */
async function resolveLogPath(runId: number): Promise<string | null> {
  const row = await queryOne('SELECT log_path FROM pipeline_runs WHERE id = $1', [runId]) as { log_path: string | null } | undefined;
  if (row?.log_path && fs.existsSync(row.log_path)) return row.log_path;
  const legacy = tmpLogPath(runId);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** True if the given PID is still alive */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─── Fallback Result Syncer ──────────────────────────────────────────────────
// When execution-engine.ts / run-loop.ts can't POST results to the backend
// (backend down, restart, port mismatch), they write to .rorca-results.jsonl.
// This function reads that file and replays entries into the DB.

async function syncFallbackResults(cwd: string, workspaceId: string): Promise<number> {
  const entries = readFallbackResults(cwd);
  if (entries.length === 0) return 0;

  let synced = 0;
  for (const entry of entries) {
    try {
      if (entry.type === 'wal') {
        // Replay WAL event directly into DB
        const p = entry.payload as Record<string, unknown>;
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ($1, $2, $3, $4, $5)` + ' RETURNING *', [p.event_type ?? entry.status,
          p.workspace_id ?? workspaceId,
          p.spec_id ?? null,
          p.story_id ?? entry.storyId,
          JSON.stringify(p.payload ?? p),]);
        broadcastAll(walEvent!);
        synced++;
      } else if (entry.type === 'story_result') {
        // Replay story_result into DB
        const p = entry.payload as Record<string, unknown>;
        const runId = (p.runId as number) ?? entry.runId;
        const storyId = (p.storyId as string) ?? entry.storyId;
        const status = (p.status as string) ?? entry.status;

        if (!runId || !storyId || !status) continue;

        // Check if already synced (idempotent — don't double-insert)
        const existing = await queryOne('SELECT id FROM story_results WHERE run_id = $1 AND story_id = $2', [runId, storyId]);

        if (!existing) {
          const activeSkillsVal = Array.isArray(p.activeSkills) && (p.activeSkills as string[]).length > 0
            ? JSON.stringify(p.activeSkills)
            : null;
          await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at, worktree_path, worktree_branch, input_tokens, output_tokens, model_used, cost_usd, active_skills)
             VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10)`, [runId, storyId, status,
            (p.worktreePath as string) ?? null, (p.worktreeBranch as string) ?? null,
            (p.inputTokens as number) ?? null, (p.outputTokens as number) ?? null,
            (p.modelUsed as string) ?? null, (p.costUsd as number) ?? null,
            activeSkillsVal,]);
        }
        synced++;
      }
    } catch (err: any) {
      logger.error(`[Pipeline] Failed to sync fallback entry: ${err.message}`);
    }
  }

  if (synced > 0) {
    deleteFallbackFile(cwd);
    logger.info(`[Pipeline] Synced ${synced} fallback result(s) from ${cwd}/.rorca-results.jsonl`);
  }
  return synced;
}

// All Claude Code env vars that block nested invocation (same as llm-client.ts)
const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

/**
 * Write synthesized direction stack to `.opencode/skills/rorca.md` in the workspace.
 * OpenCode reads skill files from this directory automatically.
 * Returns the absolute path of the written file (for cleanup), or null if nothing to write.
 */
async function writeOpenCodeSkillFile(workspaceCwd: string, workspaceId: string, specBrief: string): Promise<string | null> {
  // Fetch direction layers from DB
  const l1Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`) as { content_yaml: string } | undefined;

  const wsRow = await queryOne('SELECT domain FROM workspaces WHERE id = $1', [workspaceId]) as { domain: string | null } | undefined;
  const domain = wsRow?.domain;

  const l2Row = domain
    ? await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND COALESCE(workspace_id, '') = ''`, [domain]) as { content_yaml: string } | undefined
    : undefined;

  const l3Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { content_yaml: string } | undefined;

  // Fetch auto-hydrated context
  const ctx = await queryOne(`SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1`, [workspaceId]) as { schema_snapshot: string | null } | undefined;

  // Fetch team layers
  const access = await queryOne('SELECT team_id FROM workspace_access WHERE workspace_id = $1 LIMIT 1', [workspaceId]) as { team_id: string } | undefined;

  let teamL1: string | undefined;
  let teamL2: string | undefined;
  if (access) {
    const tl1 = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`, [access.team_id]) as { content_yaml: string } | undefined;
    const tl2 = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`, [access.team_id]) as { content_yaml: string } | undefined;
    teamL1 = tl1?.content_yaml;
    teamL2 = tl2?.content_yaml;
  }

  const synthesized = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    teamL1,
    teamL2,
    schemaSnapshot: ctx?.schema_snapshot || undefined,
    specBrief,
  });

  // Write to .opencode/skills/rorca/SKILL.md (OpenCode requires skills/<name>/SKILL.md structure)
  const skillDir = path.join(workspaceCwd, '.opencode', 'skills', 'rorca');
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');

  const content = [
    '---',
    'name: rorca',
    'description: Rorca direction stack context — synthesized project standards, domain profile, and workspace context for this pipeline run.',
    '---',
    '',
    '# Rorca Direction Stack',
    '',
    'This file is auto-generated by Rorca before each pipeline run.',
    'It contains the synthesized direction stack context for this workspace.',
    'Do NOT edit manually — it will be overwritten on the next run.',
    '',
    synthesized,
  ].join('\n');

  fs.writeFileSync(skillPath, content);
  return skillPath;
}

/** Remove the OpenCode skill file and clean up empty parent dirs. */
function removeOpenCodeSkillFile(skillPath: string): void {
  try {
    fs.unlinkSync(skillPath);
    // Clean up .opencode/skills/rorca/ directory, then .opencode/skills/, then .opencode/
    const rorcaDir = path.dirname(skillPath);  // .opencode/skills/rorca/
    const rorcaRemaining = fs.readdirSync(rorcaDir);
    if (rorcaRemaining.length === 0) {
      fs.rmdirSync(rorcaDir);
      const skillsDir = path.dirname(rorcaDir);  // .opencode/skills/
      const skillsRemaining = fs.readdirSync(skillsDir);
      if (skillsRemaining.length === 0) {
        fs.rmdirSync(skillsDir);
        const ocDir = path.dirname(skillsDir);  // .opencode/
        const ocRemaining = fs.readdirSync(ocDir);
        if (ocRemaining.length === 0) {
          fs.rmdirSync(ocDir);
        }
      }
    }
  } catch { /* best-effort cleanup */ }
}

// ─── Codex AGENTS.md Direction Stack Injection ──────────────────────────────

const RORCA_MARKER_START = '# === RORCA DIRECTION START ===';
const RORCA_MARKER_END = '# === RORCA DIRECTION END ===';

/**
 * Write synthesized direction stack to workspace root `AGENTS.md` for Codex CLI.
 *
 * Codex CLI auto-discovers AGENTS.md files from the Git root down and injects them
 * as context before the user prompt. By writing direction stack to AGENTS.md in the
 * workspace root, Codex stories get the full L1-L5 direction context automatically.
 *
 * If AGENTS.md already exists, appends a clearly delimited section. If not, creates it.
 * Returns metadata needed for cleanup: path, whether file existed, and original content.
 */
interface CodexAgentsMdState {
  agentsMdPath: string;
  existed: boolean;
  originalContent: string | null;
}

async function writeCodexAgentsMd(workspaceCwd: string, workspaceId: string, specBrief: string): Promise<CodexAgentsMdState | null> {
  // Fetch direction layers from DB (same pattern as writeOpenCodeSkillFile)
  const l1Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`) as { content_yaml: string } | undefined;

  const wsRow = await queryOne('SELECT domain FROM workspaces WHERE id = $1', [workspaceId]) as { domain: string | null } | undefined;
  const domain = wsRow?.domain;

  const l2Row = domain
    ? await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND COALESCE(workspace_id, '') = ''`, [domain]) as { content_yaml: string } | undefined
    : undefined;

  const l3Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { content_yaml: string } | undefined;

  // Fetch auto-hydrated context
  const ctx = await queryOne(`SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1`, [workspaceId]) as { schema_snapshot: string | null } | undefined;

  // Fetch team layers
  const access = await queryOne('SELECT team_id FROM workspace_access WHERE workspace_id = $1 LIMIT 1', [workspaceId]) as { team_id: string } | undefined;

  let teamL1: string | undefined;
  let teamL2: string | undefined;
  if (access) {
    const tl1 = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`, [access.team_id]) as { content_yaml: string } | undefined;
    const tl2 = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`, [access.team_id]) as { content_yaml: string } | undefined;
    teamL1 = tl1?.content_yaml;
    teamL2 = tl2?.content_yaml;
  }

  const synthesized = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    teamL1,
    teamL2,
    schemaSnapshot: ctx?.schema_snapshot || undefined,
    specBrief,
  });

  const agentsMdPath = path.join(workspaceCwd, 'AGENTS.md');
  let existed = false;
  let originalContent: string | null = null;

  try {
    originalContent = fs.readFileSync(agentsMdPath, 'utf8');
    existed = true;
  } catch { /* file doesn't exist */ }

  const rorcaSection = [
    '',
    RORCA_MARKER_START,
    '',
    '# Rorca Direction Stack',
    '',
    'This section is auto-generated by Rorca before each pipeline run.',
    'It contains the synthesized direction stack context for this workspace.',
    'Do NOT edit manually — it will be overwritten on the next run.',
    '',
    synthesized,
    '',
    RORCA_MARKER_END,
    '',
  ].join('\n');

  if (existed && originalContent !== null) {
    // Remove any existing Rorca section first (stale from previous run)
    const cleaned = stripRorcaSection(originalContent);
    fs.writeFileSync(agentsMdPath, cleaned + rorcaSection);
  } else {
    fs.writeFileSync(agentsMdPath, rorcaSection.trimStart());
  }

  return { agentsMdPath, existed, originalContent };
}

/** Remove Rorca markers section from content string. */
function stripRorcaSection(content: string): string {
  const startIdx = content.indexOf(RORCA_MARKER_START);
  const endIdx = content.indexOf(RORCA_MARKER_END);
  if (startIdx === -1 || endIdx === -1) return content;

  const before = content.substring(0, startIdx);
  const after = content.substring(endIdx + RORCA_MARKER_END.length);
  // Trim trailing newlines from the join point to avoid double blank lines
  return before.replace(/\n+$/, '\n') + after.replace(/^\n+/, '');
}

/** Remove Rorca direction stack from AGENTS.md, restoring original state. */
function removeCodexAgentsMd(state: CodexAgentsMdState): void {
  try {
    if (!state.existed) {
      // Rorca created this file — delete it entirely
      fs.unlinkSync(state.agentsMdPath);
    } else if (state.originalContent !== null) {
      // Restore the original content
      fs.writeFileSync(state.agentsMdPath, state.originalContent);
    }
  } catch { /* best-effort cleanup */ }
}

/** FR-005: When a pipeline run finishes with status='done', snapshot spec version as 'completed'. */
async function markSpecCompleted(specPath: string): Promise<void> {
  try {
    const slug = path.basename(specPath, '.json');
    // Check if latest spec_versions entry is already 'completed'
    const latestVersion = await queryOne(`SELECT status FROM spec_versions WHERE spec_slug = $1 ORDER BY version DESC LIMIT 1`, [slug]) as { status: string } | undefined;
    if (latestVersion?.status === 'completed') return; // already marked

    // Read spec content from filesystem (approved dir is the canonical location)
    // spec_path stored in pipeline_runs is relative like 'forge/specs/approved/slug.json'
    // We just need the slug for the version snapshot
    const run = await queryOne(`SELECT pr.workspace_id, w.path as workspace_path FROM pipeline_runs pr
       JOIN workspaces w ON w.id = pr.workspace_id
       WHERE pr.spec_path = $1 ORDER BY pr.id DESC LIMIT 1`, [specPath]) as { workspace_id: string; workspace_path: string } | undefined;
    if (!run) return;

    const absSpecPath = path.join(run.workspace_path, specPath);
    if (!fs.existsSync(absSpecPath)) return;

    const content = fs.readFileSync(absSpecPath, 'utf8');
    const nextVer = ((await queryOne('SELECT MAX(version) as max_ver FROM spec_versions WHERE spec_slug = $1', [slug]) as { max_ver: number | null } | undefined)?.max_ver ?? 0) + 1;

    await execute(`INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES ($1, $2, $3, 'completed')`, [slug, nextVer, content]);
  } catch {
    // Non-fatal — completed status is also derived from pipeline_runs at query time
  }
}

// ─── Auto-merge worktree on run completion ─────────────────────────────────────
// Called after run_finished WAL event. Merges the run-level worktree branch back
// into the main workspace branch automatically. Zero user action required.
//
// Strategy:
//   1. Stash any uncommitted workspace changes
//   2. Dry-run merge (safety pre-check) — bail out if real code conflicts detected
//   3. Try --ff-only (no merge commit, cleanest)
//   4. Fall back to --no-ff; auto-resolve tracking files (.rorca/run-state.json, progress.txt)
//   5. If real code conflicts: abort + emit worktree_merge_failed WAL event (no merge attempted)
//   6. On success: emit worktree_merged WAL event + remove the worktree directory
//   7. Always restore stash

// ─── Agentic conflict resolution via claude --print ────────────────────────────
// Called when git merge --no-ff produces real code conflicts.
// Spawns a claude session with the conflict diff and instructions to resolve.
// Returns true if resolution succeeded (no conflict markers remain), false otherwise.

const AGENTIC_RESOLVE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const AGENTIC_RESOLVE_SIGKILL_DELAY_MS = 10_000;   // 10s after SIGTERM

async function attemptAgenticConflictResolution(
  workspacePath: string,
  branchName: string,
  runId: number,
  workspaceId: string,
  appendLog: (msg: string, color?: string) => void,
): Promise<boolean> {
  const simpleGitForResolve = simpleGit(workspacePath);

  // 1. Start the real --no-ff merge to enter the conflicted state
  appendLog(`Starting merge of ${branchName} for agentic resolution...`, '\x1b[33m');
  try {
    await simpleGitForResolve.merge([branchName, '--no-ff', '--no-commit']);
    // Merged cleanly — commit and return success (shouldn't happen after pre-check, but handle it)
    await simpleGitForResolve.commit(`merge: ${branchName} (auto)`);
    appendLog('Merged cleanly without conflicts — committed.', '\x1b[32m');
    return true;
  } catch (mergeErr: any) {
    const msg: string = mergeErr?.message ?? String(mergeErr);
    if (
      !msg.includes('CONFLICT') &&
      !msg.includes('Automatic merge failed') &&
      !msg.includes('fix conflicts')
    ) {
      // Unexpected error — abort and fail
      appendLog(`Unexpected merge error: ${msg}`, '\x1b[31m');
      try { await simpleGitForResolve.merge(['--abort']); } catch { /* best-effort */ }
      return false;
    }
    // Expected: we're now in a conflicted state
  }

  // 2. Capture the conflict diff (working tree after failed merge)
  let conflictDiff = '';
  try {
    conflictDiff = await simpleGitForResolve.raw(['diff']);
  } catch { /* non-fatal — proceed with empty diff */ }
  // Truncate to 50KB to avoid prompt bloat
  if (conflictDiff.length > 50_000) {
    conflictDiff = conflictDiff.slice(0, 50_000) + '\n... (diff truncated at 50KB)';
  }

  // 3. Build the resolution prompt
  const resolutionPrompt = [
    `You are resolving git merge conflicts. The feature branch "${branchName}" is being merged into main for run #${runId}.`,
    '',
    'Here is the current conflict diff (conflict markers in working tree):',
    '```diff',
    conflictDiff || '(no diff output available)',
    '```',
    '',
    'Your task:',
    '1. Examine the conflicted files using the bash and read tools.',
    '2. Resolve each conflict intelligently — understand the intent of both sides. Do NOT blindly take one side.',
    '3. After resolving ALL conflicts, stage all files with: git add -A',
    '4. Commit the merge with: git commit --no-edit',
    '   (The merge commit message is already staged — --no-edit preserves it.)',
    '',
    `Working directory: ${workspacePath}`,
    '',
    'Critical: Do not exit until all conflict markers (<<<<<<<, =======, >>>>>>>) have been removed from ALL files and the commit has been made.',
  ].join('\n');

  // 4. Spawn claude --print with clean env
  appendLog('Spawning claude to resolve conflicts...', '\x1b[33m');
  const env = buildCleanEnvForMerge();

  return new Promise<boolean>((resolve) => {
    const child = spawn(
      CLAUDE_BIN_PIPELINE,
      ['--print', '--dangerously-skip-permissions', '--output-format', 'stream-json'],
      { cwd: workspacePath, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Write prompt to stdin then close it
    child.stdin?.write(resolutionPrompt);
    child.stdin?.end();

    let timedOut = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    // 5-minute timeout → SIGTERM, then 10s → SIGKILL
    const sigtermTimer = setTimeout(() => {
      timedOut = true;
      appendLog('Agentic resolution timed out (5 min) — sending SIGTERM', '\x1b[31m');
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => {
        appendLog('Claude did not exit — sending SIGKILL', '\x1b[31m');
        child.kill('SIGKILL');
      }, AGENTIC_RESOLVE_SIGKILL_DELAY_MS);
    }, AGENTIC_RESOLVE_TIMEOUT_MS);

    child.stdout?.on('data', (data: Buffer) => {
      // Log claude output summary (truncated)
      const text = data.toString('utf8').slice(0, 200).replace(/\n/g, ' ');
      if (text.trim()) appendLog(`[claude] ${text}`, '\x1b[90m');
    });

    child.on('exit', async (code) => {
      clearTimeout(sigtermTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);

      if (timedOut) {
        appendLog('Agentic resolution timed out — aborting merge', '\x1b[31m');
        try { await simpleGitForResolve.merge(['--abort']); } catch { /* best-effort */ }
        resolve(false);
        return;
      }

      if (code !== 0) {
        appendLog(`Claude exited with code ${code} — aborting merge`, '\x1b[31m');
        try { await simpleGitForResolve.merge(['--abort']); } catch { /* best-effort */ }
        resolve(false);
        return;
      }

      // 5. Verify no conflict markers remain using git diff --check
      try {
        await simpleGitForResolve.raw(['diff', '--check']);
        // git diff --check exits 0 if no conflict markers — resolution succeeded
        appendLog('Agentic resolution succeeded — no conflict markers remain', '\x1b[32m');
        resolve(true);
      } catch {
        // Conflict markers remain — abort
        appendLog('Conflict markers still present after claude resolution — aborting', '\x1b[31m');
        try { await simpleGitForResolve.merge(['--abort']); } catch { /* best-effort */ }
        resolve(false);
      }
    });

    child.on('error', async (err) => {
      clearTimeout(sigtermTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      appendLog(`Claude spawn error: ${err.message} — aborting merge`, '\x1b[31m');
      try { await simpleGitForResolve.merge(['--abort']); } catch { /* best-effort */ }
      resolve(false);
    });
  });
}

// OutputBuffer is declared after the router — forward-declare the type here for use in autoMergeWorktree
type MergeOutputBuffer = { chunks: string[]; done: boolean; subscribers: Set<(chunk: string) => void> };

async function autoMergeWorktree(
  workspacePath: string,
  worktreePath: string,
  branchName: string,
  workspaceId: string,
  runId: number,
  buf: MergeOutputBuffer,
  logPath: string,
): Promise<void> {
  const appendLog = (msg: string, color = '\x1b[36m') => {
    const line = `\r\n${color}[auto-merge] ${msg}\x1b[0m\r\n`;
    buf.chunks.push(line);
    buf.subscribers.forEach(cb => cb(line));
    try { fs.appendFileSync(logPath, line); } catch { /* best-effort */ }
  };

  // Skip if the worktree directory no longer exists (already manually merged/removed)
  if (!fs.existsSync(worktreePath)) {
    appendLog('Worktree already removed — skipping auto-merge', '\x1b[90m');
    return;
  }

  const git = simpleGit(workspacePath);

  // 1. Stash any uncommitted workspace changes so the merge can proceed
  let stashed = false;
  try {
    const status = await git.status();
    if (status.files.length > 0) {
      await git.stash(['push', '--include-untracked', '-m', `rorca-autostash-before-merge-${branchName}`]);
      stashed = true;
      appendLog('Stashed uncommitted workspace changes');
    }
  } catch (err: any) {
    appendLog(`Stash failed — proceeding without stash: ${err.message}`, '\x1b[33m');
  }

  // ── Tracking-only files that are always safe to resolve with --theirs ──────
  const TRACKING_PATTERNS = [
    '.rorca/run-state.json',
    'progress.txt',
    '.rorca/memory/runs/',
  ];

  // 2. Safety pre-check: dry-run merge to detect any conflicts BEFORE touching main
  appendLog(`Pre-checking merge safety for ${branchName}...`);
  let preCheckConflictFiles: string[] = [];
  let preCheckIsClean = false;
  try {
    await git.merge([branchName, '--no-commit', '--no-ff']);
    // Merged cleanly in dry-run (no CONFLICT markers) — abort it, proceed with real merge
    preCheckIsClean = true;
    try { await git.merge(['--abort']); } catch { /* nothing to abort on clean ff */ }
  } catch (dryRunErr: any) {
    if (
      dryRunErr.message?.includes('CONFLICT') ||
      dryRunErr.message?.includes('Automatic merge failed') ||
      dryRunErr.message?.includes('fix conflicts')
    ) {
      // Collect conflict files before aborting
      try {
        const diffOut = await git.raw(['diff', '--name-only', '--diff-filter=U']);
        preCheckConflictFiles = diffOut.trim().split('\n').filter(Boolean);
      } catch { /* continue */ }
      try { await git.merge(['--abort']); } catch { /* already clean */ }

      // Only auto-resolve tracking files — real code conflicts block the merge
      const realConflicts = preCheckConflictFiles.filter(
        f => !TRACKING_PATTERNS.some(tp => f.includes(tp))
      );

      if (realConflicts.length === 0) {
        // Only tracking files conflict — safe to merge with auto-resolution
        preCheckIsClean = true;
        appendLog(
          `Pre-check: only tracking file conflicts (${preCheckConflictFiles.join(', ')}) — auto-resolvable`,
          '\x1b[33m',
        );
      } else {
        // Real code conflicts — attempt agentic resolution via claude --print
        appendLog(
          `Pre-check: code conflicts detected in: ${realConflicts.join(', ')} — attempting agentic resolution`,
          '\x1b[33m',
        );
        const agenticResolved = await attemptAgenticConflictResolution(
          workspacePath, branchName, runId, workspaceId, appendLog,
        );
        if (agenticResolved) {
          // Claude resolved the conflicts — merge succeeded
          preCheckIsClean = true; // skip the normal merge path below — already committed
          // Emit success WAL event and clean up (skip to the merge-success block)
          let sha = '';
          try { sha = (await git.raw(['rev-parse', 'HEAD'])).trim(); } catch { /* non-fatal */ }
          const walEvt = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('worktree_merged', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({ run_id: runId, branchName, mergeCommitSha: sha, resolvedBy: 'agentic' })]);
          broadcastAll(walEvt!);
          try { await git.raw(['worktree', 'remove', '--force', worktreePath]); appendLog(`Worktree removed: ${path.basename(worktreePath)}`, '\x1b[32m'); } catch { /* non-fatal */ }
          try { await execute(`UPDATE pipeline_runs SET worktree_path = NULL WHERE id = $1`, [runId]); } catch { /* non-fatal */ }
          // Restore stash and return — no further merge needed
          if (stashed) {
            try { await git.stash(['pop']); appendLog('Restored stashed workspace changes'); } catch (popErr: any) { appendLog(`Stash pop conflict — run 'git stash pop' manually: ${popErr.message}`, '\x1b[33m'); }
          }
          return;
        } else {
          // Agentic resolution failed — emit failure WAL event
          appendLog('Agentic resolution failed — worktree preserved for manual resolution', '\x1b[31m');
          let conflictDiff = '';
          try { conflictDiff = (await git.raw(['diff'])).slice(0, 2048); } catch { /* non-fatal */ }
          const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('worktree_merge_failed', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({
            run_id: runId,
            branchName,
            worktreePath,
            conflictFiles: realConflicts,
            conflictSummary: conflictDiff,
            message: 'Agentic merge resolution failed — resolve conflicts manually via the Worktrees panel.',
          })]);
          broadcastAll(walEvent!);
          if (stashed) {
            try { await git.stash(['pop']); appendLog('Restored stashed workspace changes'); } catch (popErr: any) { appendLog(`Stash pop conflict — run 'git stash pop' manually: ${popErr.message}`, '\x1b[33m'); }
          }
          return;
        }
      }
    } else if (dryRunErr.message?.includes('Already up to date')) {
      preCheckIsClean = true;
      appendLog('Already up to date — nothing to merge', '\x1b[32m');
    } else {
      appendLog(`Pre-check error: ${dryRunErr.message}`, '\x1b[31m');
      return; // unknown error — don't attempt the merge
    }
  }

  if (!preCheckIsClean) return;

  // 3. Pre-check passed — execute the real merge
  let mergeSuccess = false;
  try {
    appendLog(`Merging ${branchName} into workspace...`);

    // Try fast-forward first (no merge commit, cleanest)
    try {
      await git.merge([branchName, '--ff-only']);
      appendLog('Merged via fast-forward — no conflicts', '\x1b[32m');
      mergeSuccess = true;
    } catch {
      // ff-only failed — do no-ff merge with tracking-file auto-resolution
      try {
        await git.merge([branchName, '--no-ff', '--no-commit']);
      } catch (mergeErr: any) {
        // Expected if tracking files conflict — resolve them now
        if (
          mergeErr.message?.includes('CONFLICT') ||
          mergeErr.message?.includes('Automatic merge failed')
        ) {
          // Auto-resolve tracking files (pre-check already confirmed only these conflict)
          for (const file of preCheckConflictFiles) {
            try {
              await git.raw(['checkout', '--theirs', '--', file]);
              await git.add(file);
              appendLog(`Auto-resolved tracking file: ${file}`);
            } catch { /* best-effort */ }
          }
        } else {
          throw mergeErr;
        }
      }

      // Commit the merge
      try {
        await git.commit(`merge: ${branchName} (auto)`);
        appendLog('Merged (no-ff) — no conflicts', '\x1b[32m');
        mergeSuccess = true;
      } catch (commitErr: any) {
        if (commitErr.message?.includes('nothing to commit') || commitErr.message?.includes('nothing added')) {
          appendLog('Merged — already up to date', '\x1b[32m');
          mergeSuccess = true;
        } else {
          try { await git.merge(['--abort']); } catch { /* already clean */ }
          appendLog(`Commit failed: ${commitErr.message}`, '\x1b[31m');
        }
      }
    }
  } catch (unexpectedErr: any) {
    try { await git.merge(['--abort']); } catch { /* already clean */ }
    appendLog(`Unexpected merge error: ${unexpectedErr.message}`, '\x1b[31m');
  } finally {
    // 4. Always restore stash — even if merge failed
    if (stashed) {
      try {
        await git.stash(['pop']);
        appendLog('Restored stashed workspace changes');
      } catch (popErr: any) {
        appendLog(
          `Stash pop conflict — run 'git stash pop' manually to restore your changes: ${popErr.message}`,
          '\x1b[33m',
        );
      }
    }
  }

  // 5. On success: emit WAL event + remove worktree directory
  if (mergeSuccess) {
    let mergeCommitSha = '';
    try { mergeCommitSha = (await git.raw(['rev-parse', 'HEAD'])).trim(); } catch { /* non-fatal */ }

    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('worktree_merged', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({ run_id: runId, branchName, mergeCommitSha })]);
    broadcastAll(walEvent!);

    // Remove the worktree directory — run is done, branch merged
    try {
      await git.raw(['worktree', 'remove', '--force', worktreePath]);
      appendLog(`Worktree removed: ${path.basename(worktreePath)}`, '\x1b[32m');
    } catch (rmErr: any) {
      // Worktree removal is best-effort — not a failure
      appendLog(`Worktree removal skipped: ${(rmErr as Error).message}`, '\x1b[33m');
    }

    // Clear worktree_path from pipeline_runs so UI knows it's merged
    try {
      await execute(`UPDATE pipeline_runs SET worktree_path = NULL WHERE id = $1`, [runId]);
    } catch { /* non-fatal */ }
  }
}

const router = Router();

// ─── In-memory output buffers (runId → live stdout/stderr stream) ─────────────
// Chunks are raw text (with ANSI codes). Late-joiners get full buffer replay.
interface OutputBuffer {
  chunks: string[];
  done: boolean;
  subscribers: Set<(chunk: string) => void>;
}
const outputBuffers = new Map<number, OutputBuffer>();

// ─── Types ───────────────────────────────────────────────────────────────────

interface PipelineRunRow {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: string;
  pid: number | null;
  branch_name: string | null;
  worktree_path: string | null;
  trigger_type: string;
  started_at: string;
  finished_at: string | null;
  retried_from_run_id: number | null;
  log_path: string | null;
  agent: string;
  agent_type: string;
  agent_model: string | null;
  parallelism: number;
  opencode_server_pid: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cost_usd: number | null;
  queued_at: string | null;
  queue_position: number | null;
  auto_merge: boolean;
  merge_status: string | null;
  merge_commit_sha: string | null;
  triggered_via: 'queue' | 'run_now';
  auto_worktree: boolean;
  include_graph: boolean;
}

interface StoryResultRow {
  id: number;
  run_id: number;
  story_id: string;
  status: string;
  retries: number;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
  elapsed_seconds: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_used: string | null;
  cost_usd: number | null;
}

/**
 * @swagger
 * /api/pipeline/preflight:
 *   post:
 *     tags: [Pipeline]
 *     summary: Pre-flight capability check for spec stories vs engine
 *     operationId: preflightPipelineCheck
 *     description: Validates that the current execution engine supports all tools required by each story in the spec and returns a compatibility report.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string }
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Capability report
 */
router.post('/preflight', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;
    if (!specPath || !workspaceId) {
      throw new ValidationError('Missing required fields: specPath, workspaceId');
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      throw new NotFoundError('Spec file not found');
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    const stories = (specJson.userStories ?? []) as CapabilityStory[];
    const resolvedAgent = agentConfig.agentType;
    const report = checkSpec(stories, resolvedAgent);
    const orchConfig = loadOrchestrationConfig(workspace.path);

    let browserMcpAvailable = false;
    try {
      require.resolve('@playwright/mcp');
      browserMcpAvailable = true;
    } catch {
      browserMcpAvailable = false;
    }

    res.json({
      compatible: report.compatible,
      mismatchMode: orchConfig.capabilityMismatch,
      engine: resolvedAgent,
      stories: report.stories.map(s => ({
        storyId: s.storyId,
        storyTitle: s.storyTitle,
        engine: s.engine,
        missingTools: s.result.missingTools,
        warnings: s.result.warnings,
      })),
      browserMcpAvailable,
      browserMcpPort: 4040,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Preflight');
  }
});

/**
 * @swagger
 * /api/pipeline/trigger:
 *   post:
 *     tags: [Pipeline]
 *     summary: Trigger a pipeline run (spawn run-loop.sh)
 *     operationId: triggerPipelineRun
 *     description: Spawns the execution engine as a subprocess to run all stories in the specified spec, optionally in a git worktree.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string, example: "forge/specs/approved/my-spec.json" }
 *               workspaceId: { type: string }
 *               autoWorktree: { type: boolean, default: false, description: "Create git worktree for isolated run" }
 *               autoMerge: { type: boolean, default: false, description: "Auto-merge worktree branch to main on successful run" }
 *               dryRun: { type: boolean, default: false }
 *               triggerType: { type: string, enum: [manual, scheduled], default: manual }
 *               includeGraph: { type: boolean, default: false, description: "Include knowledge graph context in the pipeline run" }
 *     responses:
 *       200:
 *         description: Pipeline started or conflict detected
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties:
 *                     ok: { type: boolean }
 *                     runId: { type: integer }
 *                     worktreePath: { type: string }
 *                     branchName: { type: string }
 *                 - type: object
 *                   properties:
 *                     conflict: { type: boolean }
 *                     activeRunId: { type: integer }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace or spec not found" }
 */
const PipelineTriggerSchema = z.object({
  specPath: z.string().min(1),
  workspaceId: z.union([z.string().min(1), z.number()]),
  autoWorktree: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  mergeStrategy: z.enum(['direct', 'pr', 'draft-pr', 'branch-only']).optional(),
  dryRun: z.boolean().optional(),
  triggerType: z.enum(['manual', 'scheduled']).optional(),
  forceSequential: z.boolean().optional(),
  agentOverride: z.enum(['claude', 'opencode', 'codex']).optional(),
  modelOverride: z.string().optional(),
  storyId: z.string().optional(),
  queuedRunId: z.number().optional(),
  queue: z.boolean().optional(),
  includeGraph: z.boolean().optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().optional(),
  effortLevel: z.enum(['low', 'medium', 'high']).optional(),
  reasoningEffort: z.string().optional(),
  forceRerun: z.boolean().optional(),
});

router.post('/trigger', validateBody(PipelineTriggerSchema), async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId, autoWorktree, autoMerge, mergeStrategy, dryRun, triggerType, forceSequential, queuedRunId, includeGraph, agentOverride, modelOverride, thinkingEnabled, thinkingBudget, effortLevel, reasoningEffort, forceRerun } = req.body;

    // 1. Look up workspace path
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; label: string; path: string; domain?: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Plan enforcement is handled by requirePlan middleware once billing-launch spec is complete.

    // ── Dry-run: return cost estimate without spawning any processes ─────
    if (dryRun) {
      const absSpecPath = path.join(workspace.path, specPath);
      if (!fs.existsSync(absSpecPath)) {
        throw new UnprocessableError(`Spec file not found at ${absSpecPath}`);
        return;
      }

      const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      if (!specJson.userStories || !Array.isArray(specJson.userStories)) {
        throw new UnprocessableError('Spec has no userStories array');
        return;
      }

      // Model comes from spec JSON only
      const model: string = specJson.model ?? DEFAULT_MODEL;

      const dryRunReasoningOptions = thinkingEnabled !== undefined
        ? { enabled: Boolean(thinkingEnabled), effort: reasoningEffort ?? effortLevel ?? undefined }
        : undefined;
      const estimate = await estimateDryRunCost(specJson, workspaceId, model, dryRunReasoningOptions);
      res.json({ dryRun: true, estimate });
      return;
    }

    // 2. Budget cap guard — block if hard cap exceeded for this period
    const budgetStatus = await checkBudgetThresholds(workspaceId);
    if (budgetStatus.capExceeded) {
      throw new ConflictError('Budget cap exceeded for this period');
      return;
    }

    // 3. Resolve agent type and model.
    //    Model: ONLY from spec JSON or per-story override. No hidden DB/env fallbacks.
    //    Agent runtime: request agentOverride > spec agentOverride > wfConfig.runtime
    const pipelineUser = await getEffectiveUser(req);
    const wfConfig = await resolveWorkflowConfig('pipeline_execution', pipelineUser?.id);

    const specModelPath = path.join(workspace.path, specPath);
    const specModelJson = fs.existsSync(specModelPath) ? JSON.parse(fs.readFileSync(specModelPath, 'utf8')) : {};
    const specLevelModel: string | null = specModelJson.model ?? null;
    // Read spec-level agent override saved by SpecModelControlBar (PUT /api/specs/:id)
    const specLevelAgent: AgentType | null = specModelJson.agentOverride ?? null;
    // Read spec-level reasoning config — used as defaults when trigger request omits reasoning params
    const specReasoning: { enabled: boolean; effort?: string } | undefined = specModelJson.reasoning;
    const resolvedThinkingEnabled: boolean | undefined = thinkingEnabled !== undefined ? thinkingEnabled : (specReasoning?.enabled ?? undefined);
    const resolvedReasoningEffort: string | undefined = reasoningEffort ?? specReasoning?.effort;
    // Model comes from: request modelOverride > spec.model > null (no hidden DB/env fallbacks)
    const resolvedAgentModel: string | null = modelOverride ?? specLevelModel;

    // Auto-detect agent from model string: if model has a provider prefix (e.g. openrouter/z-ai/glm-5,
    // openai/gpt-4o) it cannot run on Claude CLI — switch to opencode automatically.
    const OPENCODE_PROVIDER_PREFIXES = ['openrouter/', 'openai/', 'google/', 'ollama/', 'github/', 'bedrock/', 'vertex/'];
    // Note: 'anthropic/' prefix is intentionally excluded — anthropic/claude-* models must stay on Claude CLI.
    // Only non-Claude provider prefixes trigger the OpenCode auto-switch.
    const modelNeedsOpenCode = resolvedAgentModel != null && OPENCODE_PROVIDER_PREFIXES.some(p => resolvedAgentModel.startsWith(p));
    // Also catch bare provider/model strings like "z-ai/glm-5" that contain "/" but aren't claude- models.
    // Exclude anthropic/claude-* (OpenRouter format for Claude models — should still use Claude CLI).
    const modelIsNonClaude = resolvedAgentModel != null
      && resolvedAgentModel.includes('/')
      && !resolvedAgentModel.startsWith('claude-')
      && !resolvedAgentModel.startsWith('anthropic/claude-');
    const wfRuntime = wfConfig.runtime as AgentType;
    const autoSwitchedToOpenCode = (modelNeedsOpenCode || modelIsNonClaude) && !agentOverride && !specLevelAgent && wfRuntime === 'claude';
    // Priority: request agentOverride > spec-level agentOverride > auto-detect from model > wfConfig.runtime
    const resolvedAgentType: AgentType = (agentOverride as AgentType | undefined) ?? specLevelAgent ?? (autoSwitchedToOpenCode ? 'opencode' : wfRuntime);

    // Translate model IDs for OpenCode execution.
    // OpenCode expects "provider/org/model" format (e.g. "openrouter/anthropic/claude-opus-4.6").
    // Rorca stores models as either:
    //   - Claude-style IDs: "claude-opus-4-6" (Anthropic SDK format, dashes)
    //   - OpenRouter catalog IDs: "z-ai/glm-5", "anthropic/claude-opus-4.6" (org/model)
    //   - Already-prefixed: "openrouter/z-ai/glm-5", "openai/gpt-4o"
    let finalAgentModel = resolvedAgentModel;
    if (finalAgentModel && resolvedAgentType === 'opencode') {
      // Already has a known provider prefix — pass through as-is
      if (modelNeedsOpenCode) {
        // e.g. "openrouter/z-ai/glm-5", "openai/gpt-4o" — already correct
      }
      // Claude SDK model IDs → OpenRouter format (dashes to dots, add anthropic/ prefix)
      else if (/^claude-/.test(finalAgentModel) && !finalAgentModel.includes('/')) {
        // claude-opus-4-6 → anthropic/claude-opus-4.6
        // claude-sonnet-4-6 → anthropic/claude-sonnet-4.6
        // claude-haiku-4-5-20251001 → anthropic/claude-haiku-4.5 (strip date suffix)
        const openRouterId = finalAgentModel
          .replace(/-(\d+)-(\d+)(?:-\d{8})?$/, '-$1.$2')  // "4-6" → "4.6", strip date
          .replace(/-(\d{8})$/, '');                         // catch remaining date suffixes
        finalAgentModel = `openrouter/anthropic/${openRouterId}`;
      }
      // Bare org/model from OpenRouter catalog (e.g. "z-ai/glm-5", "anthropic/claude-opus-4.6")
      else if (modelIsNonClaude) {
        finalAgentModel = `openrouter/${finalAgentModel}`;
      }
    }

    // When running with Claude CLI, only claude-* model IDs are valid.
    // If the spec has an OpenRouter model (e.g. "z-ai/glm-5") but the user
    // explicitly selected Claude CLI, clear the model so Claude uses its default.
    if (resolvedAgentType === 'claude' && finalAgentModel) {
      const isClaudeModel = /^claude-/.test(finalAgentModel) && !finalAgentModel.includes('/');
      if (!isClaudeModel) {
        finalAgentModel = null;
      }
    }

    // OC-025: Block pipeline trigger if Claude is selected but not authenticated
    if (resolvedAgentType === 'claude') {
      const { getClaudeAuthState } = await import('../lib/claude-auth');
      const authState = getClaudeAuthState();
      if (!authState.connected) {
        throw new ForbiddenError('claude_not_authenticated');
        return;
      }
    }

    // OC-026: Block pipeline trigger if Codex is selected but not authenticated
    if (resolvedAgentType === 'codex') {
      const { getCodexAuthState } = await import('../lib/codex-auth');
      const authState = getCodexAuthState();
      if (!authState.connected) {
        throw new ForbiddenError('codex_not_authenticated');
        return;
      }
    }

    // OC-029: Scan per-story agent assignments and validate ALL required engines
    const absSpecPathForScan = path.join(workspace.path, specPath);
    if (fs.existsSync(absSpecPathForScan)) {
      try {
        const specJsonForScan = JSON.parse(fs.readFileSync(absSpecPathForScan, 'utf8'));
        const specStories = (specJsonForScan.userStories ?? []) as EngineUserStory[];
        const requiredEngines = scanRequiredEngines(specStories, resolvedAgentType);
        const engineCounts = countStoriesByEngine(specStories, resolvedAgentType);

        // Validate each required engine is authenticated
        const authErrors: string[] = [];

        if (requiredEngines.has('claude')) {
          const { getClaudeAuthState } = await import('../lib/claude-auth');
          const authState = getClaudeAuthState();
          if (!authState.connected) {
            const count = engineCounts.get('claude') ?? 0;
            authErrors.push(`Claude not authenticated — ${count} ${count === 1 ? 'story' : 'stories'} assigned`);
          }
        }

        if (requiredEngines.has('codex')) {
          const { getCodexAuthState } = await import('../lib/codex-auth');
          const authState = getCodexAuthState();
          if (!authState.connected) {
            const count = engineCounts.get('codex') ?? 0;
            authErrors.push(`Codex not authenticated — ${count} ${count === 1 ? 'story' : 'stories'} assigned`);
          }
        }

        if (requiredEngines.has('opencode')) {
          const { detectOpenCode } = await import('../lib/opencode-detector');
          const ocStatus = detectOpenCode();
          if (!ocStatus.opencodeInstalled) {
            const count = engineCounts.get('opencode') ?? 0;
            authErrors.push(`OpenCode not installed — ${count} ${count === 1 ? 'story' : 'stories'} assigned`);
          }
        }

        if (authErrors.length > 0) {
          throw new ForbiddenError('engine_auth_required');
          return;
        }
      } catch {
        // Spec parse error — non-fatal for auth scanning, let the trigger proceed
      }
    }

    // OC-031: Tool capability check — detect stories requiring tools the engine doesn't support
    if (fs.existsSync(path.join(workspace.path, specPath))) {
      try {
        const specJsonForCap = JSON.parse(fs.readFileSync(path.join(workspace.path, specPath), 'utf8'));
        const capStories = (specJsonForCap.userStories ?? []) as CapabilityStory[];
        const capReport = checkSpec(capStories, resolvedAgentType);

        if (!capReport.compatible) {
          const orchConfig = loadOrchestrationConfig(workspace.path);
          const mismatchMode: CapabilityMismatchMode = orchConfig.capabilityMismatch;

          if (mismatchMode === 'block') {
            const incompatible = capReport.stories.map(s => ({
              storyId: s.storyId,
              storyTitle: s.storyTitle,
              engine: s.engine,
              missingTools: s.result.missingTools,
              warnings: s.result.warnings,
            }));
            throw new ValidationError('capability_mismatch');
            return;
          }

          // For 'warn' and 'reroute', attach warnings to the response (handled at end)
          // Store in locals for response augmentation
          (req as any)._capabilityWarnings = capReport.stories.map(s => ({
            storyId: s.storyId,
            storyTitle: s.storyTitle,
            engine: s.engine,
            missingTools: s.result.missingTools,
            warnings: s.result.warnings,
          }));
          (req as any)._capabilityMismatchMode = mismatchMode;
        }
      } catch {
        // Non-fatal — let the trigger proceed
      }
    }

    // CA-006: Pre-execution convention drift check
    // If .rorca/config.json has execution.driftCheck: true, run drift detection
    // and block the pipeline if error-severity violations exist.
    if (isDriftCheckEnabled(workspace.path)) {
      try {
        const driftReport: DriftReport = await detectDrift(workspace.path, workspaceId);

        // Store the report
        await execute(`INSERT INTO drift_reports (workspace_id, violations_json, score, conventions_checked, files_sampled, trigger_type)
           VALUES ($1, $2, $3, $4, $5, $6)`, [workspaceId,
          JSON.stringify(driftReport.violations),
          driftReport.score,
          driftReport.conventionsChecked,
          driftReport.filesSampled,
          'pre-execution',]);

        // Emit WAL event
        const walPayload: Record<string, unknown> = {
          score: driftReport.score,
          violationCount: driftReport.violations.length,
          errorCount: driftReport.violations.filter(v => v.severity === 'error').length,
          warningCount: driftReport.violations.filter(v => v.severity === 'warning').length,
          conventionsChecked: driftReport.conventionsChecked,
          filesSampled: driftReport.filesSampled,
          triggerType: 'pre-execution',
        };
        const walResult = await queryOne<WalEvent>('INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3) RETURNING *', ['convention_drift_detected', workspaceId, JSON.stringify(walPayload)]);
        broadcastAll({
          id: walResult!.id,
          ts: new Date().toISOString(),
          event_type: 'convention_drift_detected',
          workspace_id: workspaceId,
          spec_id: null,
          story_id: null,
          actor: '',
          payload: JSON.stringify(walPayload),
        });

        if (hasBlockingViolations(driftReport)) {
          throw new ConflictError('convention_drift_detected');
          return;
        }
      } catch (driftErr: any) {
        // Drift check failure is non-fatal — log and continue
        logger.warn('[drift-check] Pre-execution drift check failed:', driftErr.message);
      }
    }

    const executionEngineTs = path.join(__dirname, '..', 'lib', 'execution-engine.ts');
    const runLoopSh = path.join(workspace.path, 'forge', 'run-loop.sh');
    const hasExecutionEngine = fs.existsSync(executionEngineTs);
    const hasBashRunLoop = fs.existsSync(runLoopSh);
    const useExecutionEngine = hasExecutionEngine;

    if (!hasExecutionEngine && !hasBashRunLoop) {
      throw new UnprocessableError(`No execution engine found — execution-engine.ts is missing`);
      return;
    }

    // 4. Conflict check — workspace-scoped, respects queue vs run_now semantics
    //    If queuedRunId is set, this is an internal promotion call — skip conflict check entirely
    const { queue } = req.body;

    if (!queuedRunId) {
      // ── 4a. Queue operations: always accepted up to max queue depth ──────────
      if (queue) {
        const MAX_QUEUE_DEPTH = 10;
        const queueCount = Number((await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued'`, [workspaceId]))?.count ?? '0');

        if (queueCount >= MAX_QUEUE_DEPTH) {
          res.status(429).json({ error: 'Queue full', currentDepth: queueCount, maxQueueDepth: MAX_QUEUE_DEPTH });
          return;
        }

        // Idempotent re-queue warning: same spec already queued for this workspace
        const specSlugForQueue = path.basename(specPath, '.json');
        const existingQueued = await queryOne<{ id: number }>(`SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued' AND spec_path = $2 LIMIT 1`, [workspaceId, specPath]);

        const position = queueCount + 1;
        const queueResult = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, queued_at, queue_position, triggered_via, auto_worktree)
           VALUES ($1, $2, 'queued', $3, NOW(), $4, 'queue', $5) RETURNING id`, [specPath, workspaceId, triggerType === 'scheduled' ? 'scheduled' : 'manual', position, !!autoWorktree]);
        const queuedId = queueResult!.id;

        res.status(202).json({
          queued: true,
          runId: queuedId,
          queuePosition: position,
          ...(existingQueued ? { warning: `Spec "${specSlugForQueue}" is already queued (run #${existingQueued.id}). This creates an additional queued run.` } : {}),
        });
        return;
      }

      // ── 4b. Run Now with autoWorktree: allow up to run_now_max_concurrent ──
      if (autoWorktree) {
        const concurrencyRows = await query<{ key: string; value: string }>(
          `SELECT key, value FROM worker_settings WHERE key = 'run_now_max_concurrent'`,
        );
        const runNowMaxConcurrent = concurrencyRows.length > 0 ? parseInt(concurrencyRows[0].value, 10) : 3;

        const activeWorktreeCount = Number((await queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused') AND worktree_path IS NOT NULL`,
          [workspaceId],
        ))?.count ?? '0');

        if (activeWorktreeCount >= runNowMaxConcurrent) {
          const activeRun = await queryOne<{ id: number }>(`SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused') AND worktree_path IS NOT NULL LIMIT 1`, [workspaceId]);
          res.json({ conflict: true, activeRunId: activeRun?.id, reason: `Maximum ${runNowMaxConcurrent} concurrent worktree runs reached. Wait for an active run to complete or increase run_now_max_concurrent.` });
          return;
        }
        // Fall through — allowed, will create worktree below
      } else {
        // ── 4c. Run Now without autoWorktree: conflict if any run active ──────
        const activeRun = await queryOne<PipelineRunRow>(`SELECT * FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused') LIMIT 1`, [workspaceId]);
        if (activeRun) {
          res.json({ conflict: true, activeRunId: activeRun.id });
          return;
        }
      }
    }

    // 4. Build absolute spec path: workspace/<specPath>
    const absSpecPath = path.join(workspace.path, specPath);

    // 4b. Auto-select orchestration mode (sequential vs wave-parallel)
    // IMPORTANT: Respect waveParallelism from .rorca/config.json — if false, force sequential
    let parallelism = 1;
    let orchestration: ReturnType<typeof autoSelectOrchestration> | null = null;
    try {
      const specJsonForOrch = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      const orchStories: WaveUserStory[] = (specJsonForOrch.userStories ?? []).map((s: any) => ({
        id: s.id,
        title: s.title ?? '',
        description: s.description ?? '',
        acceptanceCriteria: s.acceptanceCriteria ?? [],
        dependsOn: s.dependsOn ?? [],
        passes: s.passes,
        excluded: s.excluded,
      }));
      orchestration = autoSelectOrchestration(orchStories);

      // Check forceSequential from trigger request (UI toggle) or .rorca/config.json
      if (forceSequential) {
        parallelism = 1;
        logger.info(`[orchestration] Forced sequential (user selected sequential in UI)`);
      } else {
        let waveParallelismEnabled = true;
        try {
          const rorcaConfigPath = path.join(workspace.path, '.rorca', 'config.json');
          if (fs.existsSync(rorcaConfigPath)) {
            const rorcaConfig = JSON.parse(fs.readFileSync(rorcaConfigPath, 'utf8'));
            if (rorcaConfig?.execution?.waveParallelism === false) {
              waveParallelismEnabled = false;
            }
          }
        } catch { /* config parse error — use default */ }

        if (!waveParallelismEnabled) {
          parallelism = 1;
          logger.info(`[orchestration] Forced sequential (waveParallelism: false in .rorca/config.json)`);
        } else {
          parallelism = orchestration.parallelism;
          logger.info(`[orchestration] Using ${orchestration.mode} (${orchestration.reason})`);
        }
      }
    } catch {
      // Spec parse error — fall back to sequential
      logger.info('[orchestration] Using sequential (spec parse error, fallback)');
    }

    // 5. Determine CWD — main workspace or new worktree
    const needsWorktree = autoWorktree || orchestration?.mode === 'wave-parallel';
    let cwd = workspace.path;
    let branchName: string | null = null;
    let worktreePath: string | null = null;

    if (needsWorktree) {
      const specSlug = path.basename(specPath, '.json').replace(/[^a-z0-9-]/gi, '-');
      const repoName = path.basename(workspace.path);
      // Deterministic branch/path per spec — reuse across retries instead of
      // creating a new timestamped worktree every run.
      branchName = `feat/${specSlug}`;
      const branchSlug = branchName.replace(/\//g, '-');
      worktreePath = path.resolve(workspace.path, '..', `${repoName}-${branchSlug}`);

      const git = simpleGit(workspace.path);

      if (fs.existsSync(worktreePath)) {
        // Reuse existing worktree — engine will skip already-passed stories
        logger.info({ specSlug, worktreePath }, '[trigger] Reusing existing worktree');
      } else {
        // Create fresh worktree on the deterministic branch
        const branchExists = (await git.branchLocal()).all.includes(branchName);
        if (branchExists) {
          await git.raw(['worktree', 'add', worktreePath, branchName]);
        } else {
          await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
        }

        // Copy .env files — gitignored so never present in worktrees, but required
        // for database connections, API keys, and other runtime config.
        const envFilesToCopy = ['.env', 'backend/.env'];
        for (const rel of envFilesToCopy) {
          const src = path.join(workspace.path, rel);
          const dst = path.join(worktreePath, rel);
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            try {
              // Ensure parent directory exists (e.g. backend/)
              const dstDir = path.dirname(dst);
              if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
              fs.copyFileSync(src, dst);
              logger.info(`  [worktree] Copied ${rel} to worktree`);
            } catch (envErr: unknown) {
              logger.warn(`  [worktree] Failed to copy ${rel}: ${(envErr as Error).message}`);
            }
          }
        }

        // Add run-tracking files to .gitignore so they don't create noise in commits
        const worktreeGitignore = path.join(worktreePath, '.gitignore');
        const trackingPatterns = '\n# Rorca run-tracking files (parallel-safe)\nprogress.txt\n.rorca/run-state.json\n.rorca/memory/health-log.json\n';
        try {
          const existing = fs.existsSync(worktreeGitignore) ? fs.readFileSync(worktreeGitignore, 'utf-8') : '';
          if (!existing.includes('progress.txt')) {
            fs.appendFileSync(worktreeGitignore, trackingPatterns);
          }
        } catch { /* non-fatal */ }
      }

      cwd = worktreePath;
    }

    // 6. Create pipeline_runs record (with agent_type and agent_model)
    //    If queuedRunId is provided, promote the existing queued row instead of inserting
    const validTriggerType = triggerType === 'scheduled' ? 'scheduled' : 'manual';
    // Enforce constraint: auto_merge is only true when autoWorktree is true
    const computedAutoMerge = needsWorktree && (autoMerge !== false);

    // Resolve merge strategy: request param > spec JSON > workspace config > 'direct'
    let resolvedMergeStrategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only' = 'direct';
    if (mergeStrategy) {
      resolvedMergeStrategy = mergeStrategy;
    } else {
      // Try spec JSON
      try {
        const specJsonMs = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
        if (specJsonMs.mergeStrategy) {
          resolvedMergeStrategy = specJsonMs.mergeStrategy;
        }
      } catch { /* non-fatal — spec read may have already been done above */ }
      // Fall back to workspace pipeline_config
      if (resolvedMergeStrategy === 'direct') {
        try {
          const wsRow = await queryOne<{ pipeline_config: string }>('SELECT pipeline_config FROM workspaces WHERE id = $1', [workspaceId]);
          const pipelineConf = JSON.parse(wsRow?.pipeline_config || '{}');
          if (pipelineConf.mergeStrategy) {
            resolvedMergeStrategy = pipelineConf.mergeStrategy;
          }
        } catch { /* non-fatal */ }
      }
    }

    // US-002: Track trigger source — 'queue' when promoted from run queue, 'run_now' for direct triggers
    const triggeredVia = queuedRunId ? 'queue' : 'run_now';
    let runId: number;

    if (queuedRunId) {
      // Promote queued run to running — worker will actually execute it
      await execute(`UPDATE pipeline_runs SET status = 'queued', queued_at = NOW(),
         parallelism = $1, agent = $2, agent_type = $3, agent_model = $4,
         branch_name = $5, worktree_path = $6, auto_merge = $7, triggered_via = $8, auto_worktree = $9, include_graph = $10, merge_strategy = $12 WHERE id = $11 AND status = 'queued'`, [parallelism, resolvedAgentType, resolvedAgentType, resolvedAgentModel, branchName, worktreePath, computedAutoMerge, triggeredVia, needsWorktree, includeGraph ?? false, queuedRunId, resolvedMergeStrategy]);
      runId = queuedRunId;
    } else {
      const runResult = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at, branch_name, worktree_path, auto_merge, triggered_via, auto_worktree, include_graph, merge_strategy) VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, $13, $14) RETURNING id`, [specPath, workspaceId, validTriggerType, parallelism, resolvedAgentType, resolvedAgentType, resolvedAgentModel, branchName, worktreePath, computedAutoMerge, triggeredVia, needsWorktree, includeGraph ?? false, resolvedMergeStrategy]);
      runId = runResult!.id;
    }

    // 7. Build env overrides — workspace-specific and vault key additions only.
    //    The worker already inherits its own process.env when spawning the execution engine,
    //    so we only need to pass the EXTRA vars here (vault keys, workspace env vars).
    //    DO NOT dump all of process.env here — it bloats the pg-boss payload unnecessarily.
    const envOverrides: Record<string, string> = {};

    // Inject workspace-specific env vars (decrypted)
    const workspaceEnvVars = getWorkspaceEnvVars(workspaceId);
    for (const [k, v] of Object.entries(workspaceEnvVars)) {
      envOverrides[k] = v;
    }

    // Inject vault API key from workflow config (WR-006).
    // wfConfig.apiKey is the resolved key for the primary provider (vault → env fallback).
    // Map it to the correct env var based on the provider from wfConfig.
    if (wfConfig.apiKey) {
      const providerEnvMap: Record<string, string> = {
        anthropic: 'ANTHROPIC_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        'openai-compat': 'OPENAI_API_KEY',
      };
      const envVarName = providerEnvMap[wfConfig.provider];
      if (envVarName) {
        envOverrides[envVarName] = wfConfig.apiKey;
      }
      if (wfConfig.baseUrl && wfConfig.provider === 'openai-compat') {
        envOverrides['OPENAI_BASE_URL'] = wfConfig.baseUrl;
      }
    }
    // Also inject vault keys for OTHER providers — stories may use per-story agent assignments
    // (OC-029) that require a different provider than the primary one.
    const otherProviders: Array<{ provider: string; envKey: string; baseUrlKey?: string }> = [
      { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
      { provider: 'openai-compat', envKey: 'OPENAI_API_KEY', baseUrlKey: 'OPENAI_BASE_URL' },
      { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
    ];
    for (const { provider, envKey, baseUrlKey } of otherProviders) {
      if (envOverrides[envKey]) continue; // Already set by wfConfig above
      const vaultKey = pipelineUser ? await getVaultKey(pipelineUser.id, provider) : null;
      if (vaultKey) {
        envOverrides[envKey] = vaultKey.key;
        if (baseUrlKey && vaultKey.baseUrl) {
          envOverrides[baseUrlKey] = vaultKey.baseUrl;
        }
      }
    }

    // Inject GitHub Copilot token when using github/copilot model
    if (resolvedAgentModel === 'github/copilot' && pipelineUser) {
      const copilotToken = await getCopilotToken(pipelineUser.id);
      if (copilotToken) {
        envOverrides['GITHUB_TOKEN'] = copilotToken;
      }
    }

    // Inject active agent profile (system prompt + allowed tools + model override)
    const activeProfile = await queryOne('SELECT * FROM agent_profiles WHERE workspace_id = $1 AND is_active = true LIMIT 1', [workspaceId]) as AgentProfileRow | undefined;
    if (activeProfile) {
      if (activeProfile.system_prompt_override) {
        envOverrides['RORCA_AGENT_SYSTEM_PROMPT'] = activeProfile.system_prompt_override;
      }
      const tools = (Array.isArray(activeProfile.allowed_tools) ? activeProfile.allowed_tools : JSON.parse(activeProfile.allowed_tools)) as string[];
      if (tools.length > 0) {
        envOverrides['RORCA_AGENT_ALLOWED_TOOLS'] = tools.join(',');
      }
      if (activeProfile.model_override) {
        envOverrides['RORCA_AGENT_MODEL_OVERRIDE'] = activeProfile.model_override;
      }
    }

    // 8. Run pre-run hooks — abort if any exit non-zero.
    //    Hooks run synchronously in the trigger request so the caller gets immediate feedback.
    const logPath = workspaceLogPath(workspace.path, runId);
    await execute('UPDATE pipeline_runs SET log_path = $1 WHERE id = $2', [logPath, runId]);
    const preRunResults = await runHooks(workspaceId, 'pre_run', cwd, envOverrides);
    if (preRunResults.length > 0) {
      const hookOutput = preRunResults.map(r =>
        `\x1b[36m[pre_run hook: ${r.command}]\x1b[0m\n${r.output}` +
        (r.exitCode !== 0 ? `\n\x1b[31m[Hook exited with code ${r.exitCode}]\x1b[0m\n` : '\n')
      ).join('');
      fs.writeFileSync(logPath, hookOutput);

      const failed = preRunResults.find(r => r.exitCode !== 0);
      if (failed) {
        await execute(`UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`, [runId]);

        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({
          run_id: runId, status: 'failed', reason: 'pre_run_hook_failed',
          hook_command: failed.command, exit_code: failed.exitCode,
        })]);
        broadcastAll(walEvent!);
        advanceQueue(workspaceId);

        const failBuf: OutputBuffer = { chunks: [hookOutput], done: true, subscribers: new Set() };
        outputBuffers.set(runId, failBuf);
        setTimeout(() => { outputBuffers.delete(runId); }, 30 * 60 * 1000);

        throw new UnprocessableError('Pre-run hook failed');
        return;
      }
    }

    // 9. Record excluded / already-passing stories so the UI shows them immediately.
    let startFromStoryId: string | undefined;
    try {
      const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      const specSlug = path.basename(specPath, '.json');

      const excludedStories = (specJson.userStories ?? []).filter(
        (s: { excluded?: boolean }) => s.excluded === true
      );
      for (const s of excludedStories) {
        await execute(
          `INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, $2, 'excluded', NOW())`,
          [runId, s.id]
        );
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ('story_excluded_from_run', $1, $2, $3, $4)` + ' RETURNING *', [workspaceId, specSlug, s.id, JSON.stringify({ run_id: runId })]);
        broadcastAll(walEvent!);
      }

      // forceRerun: reset all passes=true to false so every story runs fresh
      if (forceRerun) {
        let modified = false;
        for (const s of (specJson.userStories ?? [])) {
          if (s.passes === true) { s.passes = false; modified = true; }
        }
        if (modified) {
          fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2), 'utf8');
        }
      }

      const alreadyPassing = forceRerun ? [] : (specJson.userStories ?? []).filter(
        (s: { passes?: boolean; excluded?: boolean }) => s.passes === true && s.excluded !== true
      );
      for (const s of alreadyPassing) {
        await execute(
          `INSERT INTO story_results (run_id, story_id, status, reason, finished_at) VALUES ($1, $2, 'skip', 'previously_passed', NOW())`,
          [runId, s.id]
        );
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ('story_skipped', $1, $2, $3, $4)` + ' RETURNING *', [workspaceId, specSlug, s.id, JSON.stringify({ run_id: runId, reason: 'previously_passed' })]);
        broadcastAll(walEvent!);
      }

      // Compute startFromStoryId: first story where passes !== true and not excluded
      // When forceRerun, all passes are already reset so start from the first non-excluded story
      const startFromStory = (specJson.userStories ?? []).find(
        (s: { passes?: boolean; excluded?: boolean }) => s.passes !== true && s.excluded !== true
      );
      startFromStoryId = startFromStory?.id ?? undefined;
    } catch { /* spec read error — non-fatal, worker will handle */ }

    // 10. Enqueue the pipeline run via pg-boss.
    //     The worker process picks it up and does the actual spawn / execution.
    //     Job ID = String(runId) for direct lookup by runId.
    const jobPayload = {
      runId,
      specPath,
      workspacePath: workspace.path,
      agent: resolvedAgentType,
      model: finalAgentModel ?? null,
      worktreePath: worktreePath ?? null,
      branchName: branchName ?? null,
      autoWorktree: needsWorktree,
      autoMerge: computedAutoMerge,
      mergeStrategy: resolvedMergeStrategy,
      envOverrides,
      ...(startFromStoryId ? { startFromStoryId } : {}),
      triggeredVia,
      includeGraph: includeGraph ?? false,
      ...(agentOverride ? { agentOverride } : {}),
      ...(resolvedThinkingEnabled !== undefined ? { thinkingEnabled: resolvedThinkingEnabled } : {}),
      ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
      ...(effortLevel ? { effortLevel } : {}),
      ...(resolvedReasoningEffort ? { reasoningEffort: resolvedReasoningEffort } : {}),
    };

    await getBoss().send('pipeline:run', jobPayload, {
      retryLimit: 0,
      expireInSeconds: 300, // Task-Monitor: job spawns engine and returns immediately
    });

    logger.info(`[Pipeline] Enqueued pipeline:run job for runId=${runId}`);

    // Determine queue position for response (count jobs queued before this one)
    const queuePos = (await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued' AND id < $2`,
      [workspaceId, runId]
    ))?.count ?? '0';

    // OC-031: Include capability warnings in trigger response
    const capWarnings = (req as any)._capabilityWarnings;
    const capMode = (req as any)._capabilityMismatchMode;
    res.status(201).json({
      ok: true,
      runId,
      queued: true,
      specId: path.basename(specPath, '.json'),
      queuePosition: parseInt(queuePos, 10) + 1,
      worktreePath,
      branchName,
      agentType: resolvedAgentType,
      agentModel: resolvedAgentModel,
      ...(capWarnings ? { capabilityWarnings: capWarnings, capabilityMismatchMode: capMode } : {}),
      ...(orchestration ? { orchestration } : {}),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Trigger');
  }
});

// ─── POST /api/pipeline/context-preview — Preview context routing per story ───

/**
 * @swagger
 * /api/pipeline/context-preview:
 *   post:
 *     tags: [Pipeline]
 *     summary: Preview context routing for each story in a spec
 *     operationId: previewContextRouting
 *     description: >
 *       Returns the predicted context payload for each story, including
 *       global files, scope matches, tag matches, token estimates, and
 *       budget warnings. Use before triggering to show users exactly what
 *       context will be injected.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string, example: "forge/specs/approved/my-spec.json" }
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Context preview payload
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace or spec not found" }
 */
router.post('/context-preview', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;
    if (!specPath || !workspaceId) {
      throw new ValidationError('Missing required fields: specPath, workspaceId');
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      throw new NotFoundError('Spec file not found');
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    if (!specJson.userStories || !Array.isArray(specJson.userStories)) {
      throw new UnprocessableError('Spec has no userStories array');
      return;
    }

    // Load routing config from .rorca/config.json
    const { loadRorcaConfig } = require('../lib/rorca-config') as typeof import('../lib/rorca-config');
    const rorcaConfig = loadRorcaConfig(workspace.path);
    const routingConfig = rorcaConfig.routing;
    const tokenBudget = routingConfig.tokenBudget;

    // Import context-router functions
    const { route, estimateTokens, extractPathMentions, matchScopes, matchTags, detectCrossAppPaths } =
      require('../lib/context-router') as typeof import('../lib/context-router');

    // CIE-017: Load monorepo apps for cross-app story detection
    const { loadMonorepoApps } = require('../lib/workspace-echolocation') as typeof import('../lib/workspace-echolocation');
    let monorepoApps: import('../lib/workspace-echolocation').MonorepoPackage[] | undefined;
    try {
      const apps = loadMonorepoApps(workspace.path);
      if (apps.length > 0) monorepoApps = apps;
    } catch { /* non-fatal */ }

    // Build per-story preview
    const stories: Array<{
      storyId: string;
      title: string;
      predictedPaths: string[];
      crossAppPaths: string[];
      globalFiles: Array<{ path: string; tokens: number }>;
      scopedFiles: Array<{ path: string; tokens: number; matchedScope: string }>;
      taggedFiles: Array<{ path: string; tokens: number; matchedTag: string }>;
      globalTokens: number;
      scopedTokens: number;
      taggedTokens: number;
      totalTokens: number;
      exceeded: boolean;
      droppedFiles: string[];
    }> = [];

    let anyExceeded = false;

    for (const story of specJson.userStories) {
      if (story.passes || story.excluded) continue;

      // Run the full routing pipeline (CIE-017: pass monorepo apps for cross-app detection)
      const payload = route(story, routingConfig, workspace.path, monorepoApps);

      // Re-run routing in detail mode to get per-file breakdown
      const predictedPaths = extractPathMentions(story);
      // CIE-017: Detect cross-app references in monorepo stories
      const crossAppPaths = monorepoApps ? detectCrossAppPaths(story, monorepoApps) : [];
      const allPredictedPaths = [...predictedPaths, ...crossAppPaths];
      const matchedScopes = matchScopes(allPredictedPaths, routingConfig.scopes);
      const storyTags = story.tags ?? [];
      const matchedTagRules = matchTags(storyTags, routingConfig.tags);

      // Build per-file detail lists (reading files to get token counts)
      const globalFiles: Array<{ path: string; tokens: number }> = [];
      for (const gp of routingConfig.global) {
        try {
          const absPath = path.isAbsolute(gp) ? gp : path.join(workspace.path, gp);
          const content = fs.readFileSync(absPath, 'utf-8');
          globalFiles.push({ path: gp, tokens: estimateTokens(content) });
        } catch {
          // File doesn't exist — skip
        }
      }

      const scopedFiles: Array<{ path: string; tokens: number; matchedScope: string }> = [];
      for (const scope of matchedScopes) {
        for (const ip of scope.inject) {
          try {
            const absPath = path.isAbsolute(ip) ? ip : path.join(workspace.path, ip);
            const content = fs.readFileSync(absPath, 'utf-8');
            scopedFiles.push({ path: ip, tokens: estimateTokens(content), matchedScope: scope.path });
          } catch {
            // File doesn't exist — skip
          }
        }
      }

      const taggedFiles: Array<{ path: string; tokens: number; matchedTag: string }> = [];
      for (const tagRule of matchedTagRules) {
        for (const ip of tagRule.inject) {
          try {
            const absPath = path.isAbsolute(ip) ? ip : path.join(workspace.path, ip);
            const content = fs.readFileSync(absPath, 'utf-8');
            taggedFiles.push({ path: ip, tokens: estimateTokens(content), matchedTag: tagRule.tag });
          } catch {
            // File doesn't exist — skip
          }
        }
      }

      const globalTokens = globalFiles.reduce((s, f) => s + f.tokens, 0);
      const scopedTokens = scopedFiles.reduce((s, f) => s + f.tokens, 0);
      const taggedTokens = taggedFiles.reduce((s, f) => s + f.tokens, 0);

      // Determine dropped files (files that would be injected but were cut by budget)
      const allCandidatePaths = [
        ...globalFiles.map(f => f.path),
        ...scopedFiles.map(f => f.path),
        ...taggedFiles.map(f => f.path),
      ];
      const injectedSet = new Set(payload.injectedFiles);
      const droppedFiles = allCandidatePaths.filter(p => !injectedSet.has(p));

      const exceeded = payload.totalTokens > tokenBudget || droppedFiles.length > 0;
      if (exceeded) anyExceeded = true;

      stories.push({
        storyId: story.id,
        title: story.title,
        predictedPaths,
        crossAppPaths,
        globalFiles,
        scopedFiles,
        taggedFiles,
        globalTokens,
        scopedTokens,
        taggedTokens,
        totalTokens: payload.totalTokens,
        exceeded,
        droppedFiles,
      });
    }

    res.json({
      tokenBudget,
      anyExceeded,
      globalFileCount: routingConfig.global.length,
      scopeCount: routingConfig.scopes.length,
      tagCount: routingConfig.tags.length,
      monorepo: monorepoApps ? { detected: true, appCount: monorepoApps.length } : { detected: false },
      stories,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Context preview');
  }
});

// ─── POST /api/pipeline/orchestration-preview — Preview auto-orchestration mode ─

/**
 * @swagger
 * /api/pipeline/orchestration-preview:
 *   post:
 *     tags: [Pipeline]
 *     summary: Preview auto-orchestration mode for a spec
 *     operationId: previewOrchestrationMode
 *     description: Analyzes the spec's dependency graph and returns the recommended orchestration mode (sequential or wave-parallel) with wave groupings.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string }
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Orchestration preview
 */
router.post('/orchestration-preview', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;
    if (!specPath || !workspaceId) {
      throw new ValidationError('Missing required fields: specPath, workspaceId');
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      throw new NotFoundError('Spec file not found');
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    const orchStories: WaveUserStory[] = (specJson.userStories ?? []).map((s: any) => ({
      id: s.id,
      title: s.title ?? '',
      description: s.description ?? '',
      acceptanceCriteria: s.acceptanceCriteria ?? [],
      dependsOn: s.dependsOn ?? [],
      passes: s.passes,
      excluded: s.excluded,
    }));

    const result = autoSelectOrchestration(orchStories);
    res.json(result);
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Orchestration preview');
  }
});

// ─── POST /api/pipeline/quick-run — Brief → single-story spec → immediate run ─
// Accepts a plain-English brief, generates a 1-story spec, writes it directly
// to approved/ (no review queue), emits spec_approved WAL, triggers execution.

/**
 * @swagger
 * /api/pipeline/quick-run:
 *   post:
 *     tags: [Pipeline]
 *     summary: Quick-run — generate a 1-story spec from a brief and execute immediately
 *     operationId: quickRunPipeline
 *     description: |
 *       Generates a single-story spec from a plain-English brief, writes it directly to
 *       approved (no review queue), and immediately triggers pipeline execution.
 *
 *       The spec generation prompt incorporates a layered context cascade in this order:
 *       1. **Direction Stack (L1-L3)** — synthesized from direction_layers table:
 *          L1 (global engineering principles), L2 (domain conventions matched by workspace.domain),
 *          L3 (project-specific context scoped to this workspace). Merged via synthesize().
 *       2. **MEMORY.md** — episodic ledger from workspace root (first 2000 chars).
 *          Contains timestamped Architecture/Convention/Bug Fix/Decision/Pattern/Gotcha entries.
 *       3. **Installed Skills** — list of skills from installed_skills table (name + description).
 *          Informs the LLM which reusable skill files are available for the generated story.
 *       All three context sources are best-effort: silently omitted if missing or on error.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, brief]
 *             properties:
 *               workspaceId: { type: string }
 *               brief: { type: string, description: "Plain-English description of what to build" }
 *               model: { type: string, description: "LLM model to use for spec generation" }
 *     responses:
 *       202:
 *         description: Quick-run started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runId: { type: integer }
 *                 specId: { type: string }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace not found" }
 *       409: { description: "Active run conflict or budget cap exceeded" }
 */
router.post('/quick-run', async (req: Request, res: Response) => {
  try {
    const { workspaceId, brief, model: requestedModel } = req.body;

    if (!workspaceId || !brief) {
      throw new ValidationError('Missing required fields: workspaceId, brief');
      return;
    }

    // 1. Look up workspace
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; label: string; path: string; domain?: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Plan enforcement is handled by requirePlan middleware once billing-launch spec is complete.

    // 3. Budget cap guard
    const budgetStatus = await checkBudgetThresholds(workspaceId);
    if (budgetStatus.capExceeded) {
      throw new ConflictError('Budget cap exceeded for this period');
      return;
    }

    // 4. Conflict detection
    const activeRun = await queryOne(`SELECT * FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused') LIMIT 1`, [workspaceId]) as PipelineRunRow | undefined;
    if (activeRun) {
      res.json({ conflict: true, activeRunId: activeRun.id });
      return;
    }

    // 5. Resolve model — from request only, no hidden DB fallbacks
    const resolvedModel: string = requestedModel ?? DEFAULT_MODEL;

    // 6. Resolve vault creds for LLM call
    const user = await getEffectiveUser(req);
    let vaultCreds: { apiKey?: string; baseUrl?: string } = {};
    if (user?.id) {
      const vaultProvider = resolveVaultProvider(resolvedModel);
      if (vaultProvider) {
        const result = await getVaultKey(user.id, vaultProvider);
        if (result) vaultCreds = { apiKey: result.key, baseUrl: result.baseUrl ?? undefined };
      }
      if (!vaultCreds.apiKey) {
        const compat = await getVaultKey(user.id, 'openai-compat');
        if (compat) vaultCreds = { apiKey: compat.key, baseUrl: compat.baseUrl ?? undefined };
      }
      if (!vaultCreds.apiKey) {
        const anthropic = await getVaultKey(user.id, 'anthropic');
        if (anthropic) vaultCreds = { apiKey: anthropic.key };
      }
    }

    // Context cascade: direction stack → MEMORY.md → installed skills → instructions
    // Each layer is best-effort (silently omitted on error or absence):
    //   1. Direction Stack (L1–L3): global engineering principles → domain conventions → project context
    //   2. MEMORY.md: episodic ledger at workspace root, capped at 2000 chars
    //   3. Installed Skills: names + descriptions from installed_skills table
    // Layers are assembled in this order and prepended to the LLM instructions block.
    // An empty layer is filtered out — the prompt degrades gracefully to bare instructions.

    // 7. Synthesize direction stack (L1–L3) for this workspace
    let directionContext = '';
    try {
      const domain = workspace.domain ?? '';
      const [l1Row, l2Row, l3Row] = await Promise.all([
        queryOne<{ content_yaml: string }>(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = '' AND COALESCE(team_id, '') = '' LIMIT 1`, []),
        queryOne<{ content_yaml: string }>(`SELECT content_yaml FROM direction_layers WHERE layer = 2 AND COALESCE(workspace_id, '') = '' AND (domain = $1 OR COALESCE(domain, '') = '') AND COALESCE(team_id, '') = '' ORDER BY (domain = $1) DESC LIMIT 1`, [domain]),
        queryOne<{ content_yaml: string }>(`SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = '' LIMIT 1`, [workspaceId]),
      ]);
      directionContext = synthesize({ l1: l1Row?.content_yaml, l2: l2Row?.content_yaml, l3: l3Row?.content_yaml, specBrief: brief });
    } catch (err: unknown) {
      // Silently skip — direction context is best-effort
      if (err instanceof Error) void err.message;
    }

    // 8. Generate 1-story spec via LLM
    // Read MEMORY.md from workspace root (best-effort, silent on error)
    let memoryContent = '';
    try {
      const memoryRaw = await fs.promises.readFile(path.join(workspace.path, 'MEMORY.md'), 'utf8');
      memoryContent = memoryRaw.slice(0, 2000);
    } catch (err: unknown) {
      // ENOENT or any read error — silently skip
      if (err instanceof Error) void err.message;
    }

    // Fetch installed skills for this workspace (best-effort, silent on error)
    let skillsContext = '';
    try {
      const skillRows = await query<{ name: string; description: string | null }>(
        `SELECT name, description FROM installed_skills ORDER BY name`,
        [],
      );
      if (skillRows.length > 0) {
        const skillLines = skillRows.map(s => `- ${s.name}: ${s.description ?? ''}`).join('\n');
        skillsContext = `=== INSTALLED SKILLS ===\n${skillLines}`;
      }
    } catch (err: unknown) {
      // DB error — silently skip
      if (err instanceof Error) void err.message;
    }

    // Build ordered context blocks and filter empty entries
    const contextBlocks = [
      directionContext.trim() ? `=== DIRECTION STACK ===\n${directionContext.trim()}` : '',
      memoryContent.trim() ? `=== MEMORY.md ===\n${memoryContent.trim()}` : '',
      skillsContext,
    ].filter(Boolean);

    const instructions = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
      'If you output anything other than raw JSON, the system will fail.',
      '=== END INSTRUCTIONS ===',
      '',
      `TASK: Generate a software specification JSON with exactly 1 user story.`,
      `Brief: ${brief}`,
      '',
      'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation.',
      '',
      'JSON schema:',
      '{"stories":[{"id":"QR-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":[]}]}',
      '',
      'Rules:',
      '- Generate exactly 1 story with id "QR-001"',
      '- The story must have at most 8 acceptance criteria',
      '- acceptanceCriteria must be specific and testable',
      '- dependsOn must be an empty array (single story has no deps)',
      '- The description should be detailed enough for an engineer to implement',
      '- Your entire response must be valid JSON parseable by JSON.parse()',
    ].join('\n');

    const quickRunPrompt = contextBlocks.length > 0
      ? `${contextBlocks.join('\n\n')}\n\n${instructions}`
      : instructions;

    const llmResult = await chatComplete(
      [{ role: 'user', content: quickRunPrompt }],
      { model: resolvedModel, apiKey: vaultCreds.apiKey, baseUrl: vaultCreds.baseUrl },
    );
    const rawResponse = llmResult.text;

    // 8. Parse JSON
    let parsed: { stories: Array<{ id: string; title: string; description: string; acceptanceCriteria: string[]; dependsOn: string[] }> };
    try {
      const fenceMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : rawResponse.trim();
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      res.status(500).json({ error: 'LLM returned non-JSON', raw: rawResponse });
      return;
    }

    if (!Array.isArray(parsed.stories) || parsed.stories.length === 0) {
      res.status(500).json({ error: 'Invalid spec structure from LLM' });
      return;
    }

    // Enforce single story + max 8 AC
    const story = parsed.stories[0];
    if (story.acceptanceCriteria && story.acceptanceCriteria.length > 8) {
      story.acceptanceCriteria = story.acceptanceCriteria.slice(0, 8);
    }

    // 9. Build slug and write spec directly to approved/
    const slug = `qr-${brief.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}-${Date.now()}`;
    const approvedDir = path.join(workspace.path, 'forge', 'specs', 'approved');
    fs.mkdirSync(approvedDir, { recursive: true });

    const specJson = {
      title: brief.slice(0, 120),
      generatedAt: new Date().toISOString(),
      model: resolvedModel,
      source: 'quick-run',
      userStories: [{
        id: story.id || 'QR-001',
        title: story.title,
        description: story.description,
        acceptanceCriteria: story.acceptanceCriteria || [],
        dependsOn: [],
        passes: false,
      }],
    };

    const specPath = path.join(approvedDir, `${slug}.json`);
    fs.writeFileSync(specPath, JSON.stringify(specJson, null, 2), 'utf8');
    const relativeSpecPath = `forge/specs/approved/${slug}.json`;

    // 10. Emit spec_approved WAL event with actor: 'quick-run'
    const walApproveEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('spec_approved', $1, $2, $3)` + ' RETURNING *', [slug, workspaceId, JSON.stringify({ actor: 'quick-run', brief: brief.slice(0, 200), model: resolvedModel })]);
    broadcastAll(walApproveEvent!);

    // 11. Trigger pipeline execution (same logic as /trigger)
    const runLoopSh = path.join(workspace.path, 'forge', 'run-loop.sh');
    const runLoopTs = path.join(__dirname, '..', 'lib', 'run-loop.ts');
    const hasBashRunLoop = fs.existsSync(runLoopSh);
    const hasTsRunLoop = fs.existsSync(runLoopTs);
    if (!hasBashRunLoop && !hasTsRunLoop) {
      throw new UnprocessableError(`No run-loop engine found for workspace`);
      return;
    }
    const useTypescriptRunLoop = !hasBashRunLoop && hasTsRunLoop;

    const runResult = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type) VALUES ($1, $2, 'running', 'quick-run') RETURNING id`, [relativeSpecPath, workspaceId]);
    const runId = runResult!.id;

    // Build clean env
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
        env[k] = v;
      }
    }
    env['RORCA_PROCESS_ROLE'] = 'engine';
    const workspaceEnvVars = getWorkspaceEnvVars(workspaceId);
    for (const [k, v] of Object.entries(workspaceEnvVars)) {
      env[k] = v;
    }

    // Inject vault API keys
    if (user?.id) {
      const anthropicVaultKey = await getVaultKey(user.id, 'anthropic');
      if (anthropicVaultKey) env['ANTHROPIC_API_KEY'] = anthropicVaultKey.key;
      const openaiVaultKey = await getVaultKey(user.id, 'openai-compat');
      if (openaiVaultKey) {
        env['OPENAI_API_KEY'] = openaiVaultKey.key;
        if (openaiVaultKey.baseUrl) env['OPENAI_BASE_URL'] = openaiVaultKey.baseUrl;
      }
      const openrouterVaultKey = await getVaultKey(user.id, 'openrouter');
      if (openrouterVaultKey) env['OPENROUTER_API_KEY'] = openrouterVaultKey.key;

      // Inject Copilot token when using github/copilot model
      const resolvedModel = agentConfig.agentModel;
      if (resolvedModel === 'github/copilot') {
        const copilotToken = await getCopilotToken(user.id);
        if (copilotToken) env['GITHUB_TOKEN'] = copilotToken;
      }
    }

    // Inject agent profile
    const activeProfile = await queryOne('SELECT * FROM agent_profiles WHERE workspace_id = $1 AND is_active = true LIMIT 1', [workspaceId]) as AgentProfileRow | undefined;
    if (activeProfile) {
      if (activeProfile.system_prompt_override) env['RORCA_AGENT_SYSTEM_PROMPT'] = activeProfile.system_prompt_override;
      const tools = (Array.isArray(activeProfile.allowed_tools) ? activeProfile.allowed_tools : JSON.parse(activeProfile.allowed_tools)) as string[];
      if (tools.length > 0) env['RORCA_AGENT_ALLOWED_TOOLS'] = tools.join(',');
      if (activeProfile.model_override) env['RORCA_AGENT_MODEL_OVERRIDE'] = activeProfile.model_override;
    }

    // Spawn run-loop
    const logPath = workspaceLogPath(workspace.path, runId);
    await execute('UPDATE pipeline_runs SET log_path = $1 WHERE id = $2', [logPath, runId]);
    const logFd = fs.openSync(logPath, 'a');
    let child: ReturnType<typeof spawn>;

    if (useTypescriptRunLoop) {
      const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const backendPort = process.env.PORT || '3030';
      child = spawn(tsxBin, [
        runLoopTs,
        '--json', specPath,
        '--cwd', workspace.path,
        '--run-id', String(runId),
        '--port', backendPort,
        '--parallelism', '1',
      ], {
        cwd: workspace.path,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      });
    } else {
      const scriptInCwd = path.join(workspace.path, 'forge', 'run-loop.sh');
      child = spawn('bash', [scriptInCwd, '--json', specPath], {
        cwd: workspace.path,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      });
    }
    fs.closeSync(logFd);
    child.unref();

    if (child.pid) {
      await execute(`UPDATE pipeline_runs SET pid = $1 WHERE id = $2`, [child.pid, runId]);
    }

    // Set up output buffer
    const buf: OutputBuffer = { chunks: [], done: false, subscribers: new Set() };
    outputBuffers.set(runId, buf);

    let tailPos = 0;
    const tailInterval = setInterval(() => {
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > tailPos) {
          const fd = fs.openSync(logPath, 'r');
          const newBytes = Buffer.alloc(stat.size - tailPos);
          fs.readSync(fd, newBytes, 0, newBytes.length, tailPos);
          fs.closeSync(fd);
          tailPos = stat.size;
          const text = newBytes.toString('utf8');
          buf.chunks.push(text);
          buf.subscribers.forEach(cb => cb(text));
        }
      } catch { /* transient read error */ }
    }, 200);

    // Handle process exit
    child.on('exit', async (code) => {
      clearInterval(tailInterval);
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > tailPos) {
          const fd = fs.openSync(logPath, 'r');
          const remaining = Buffer.alloc(stat.size - tailPos);
          fs.readSync(fd, remaining, 0, remaining.length, tailPos);
          fs.closeSync(fd);
          buf.chunks.push(remaining.toString('utf8'));
          buf.subscribers.forEach(cb => cb(remaining.toString('utf8')));
        }
      } catch { /* ignore */ }

      if (false /* pg pool always available */) {
        buf.done = true;
        buf.subscribers.clear();
        return;
      }

      const status = code === 0 ? 'done' : 'failed';
      await execute(`UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`, [status, runId]);

      // FR-005: Mark spec as completed when run succeeds
      if (status === 'done') markSpecCompleted(relativeSpecPath);

      // PG-021: Synthesize run-level memory (non-blocking, best-effort)
      synthesizeRunMemory(runId, workspaceId).catch(() => {});

      const postRunEnv = { ...env, RUN_STATUS: status, RUN_ID: String(runId) };
      const postRunResults = await runHooks(workspaceId, 'post_run', workspace.path, postRunEnv);
      if (postRunResults.length > 0) {
        const hookOutput = postRunResults.map(r =>
          `\r\n\x1b[36m[post_run hook: ${r.command}]\x1b[0m\r\n${r.output}` +
          (r.exitCode !== 0 ? `\r\n\x1b[31m[Hook exited with code ${r.exitCode}]\x1b[0m\r\n` : '\r\n')
        ).join('');
        buf.chunks.push(hookOutput);
        buf.subscribers.forEach(cb => cb(hookOutput));
        fs.appendFileSync(logPath, hookOutput);
      }

      const walFinishEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({ run_id: runId, status, exit_code: code, source: 'quick-run' })]);
      broadcastAll(walFinishEvent!);

      // PR-RQ-1: Advance run queue — promote next queued run if any
      advanceQueue(workspaceId);

      buf.done = true;
      buf.subscribers.forEach(cb => cb(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`));
      buf.subscribers.clear();
      setTimeout(() => { outputBuffers.delete(runId); }, 30 * 60 * 1000);
    });

    res.status(202).json({ runId, specId: slug });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Quick-run');
  }
});

// ─── POST /api/pipeline/runs — Create a pipeline run ────────────────────────

/**
 * @swagger
 * /api/pipeline/runs:
 *   post:
 *     tags: [Pipeline]
 *     summary: Create a pipeline run record
 *     operationId: createPipelineRun
 *     description: Creates a new pipeline_runs row with status 'running' and emits a run_started WAL event. Does not spawn an execution engine — use POST /api/pipeline/trigger for that.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string, description: "Relative spec path within the workspace" }
 *               workspaceId: { type: string, description: "Workspace ID" }
 *     responses:
 *       201:
 *         description: Pipeline run created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 run: { $ref: '#/components/schemas/PipelineRun' }
 *       400: { description: "Missing required fields (specPath, workspaceId)" }
 *       500: { description: "Internal server error" }
 */
router.post('/runs', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;

    if (!specPath || !workspaceId) {
      throw new ValidationError('Missing required fields: specPath, workspaceId');
      return;
    }

    const result = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, 'running') RETURNING id`, [specPath, workspaceId]);

    const runId = result!.id;

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow;

    // Insert WAL event and broadcast to SSE subscribers
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_started', $1, $2) RETURNING *`, [workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath })]);

    broadcastAll(walEvent!);

    res.status(201).json({ run });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Create run');
  }
});

// ─── GET /api/pipeline/runs — List pipeline runs ─────────────────────────────

/**
 * @swagger
 * /api/pipeline/runs:
 *   get:
 *     tags: [Pipeline]
 *     summary: List pipeline runs
 *     operationId: listPipelineRuns
 *     description: Returns a paginated list of pipeline runs for the specified workspace, ordered by most recent first.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of runs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runs:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PipelineRun' }
 */
router.get('/runs', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const pagination = parsePaginationParams(req);
    const result = await paginateQuery<PipelineRunRow>({
      query: 'SELECT * FROM pipeline_runs WHERE workspace_id = $1',
      countQuery: 'SELECT COUNT(*)::int as total FROM pipeline_runs WHERE workspace_id = $1',
      params: [workspaceId],
      pagination,
      orderBy: 'id DESC',
      cursorColumn: 'id',
      cursorDirection: 'desc',
    });

    res.json(result);
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] List runs');
  }
});

// ─── GET /api/pipeline/runs/compare — Compare two pipeline runs side-by-side ─

/**
 * @swagger
 * /api/pipeline/runs/compare:
 *   get:
 *     tags: [Pipeline]
 *     summary: Compare two pipeline runs side-by-side
 *     operationId: comparePipelineRuns
 *     description: Fetches story results for two runs and produces a per-story diff showing improved, regressed, new, or removed stories along with summary statistics.
 *     parameters:
 *       - in: query
 *         name: run1
 *         required: true
 *         schema: { type: integer }
 *         description: First run ID
 *       - in: query
 *         name: run2
 *         required: true
 *         schema: { type: integer }
 *         description: Second run ID
 *     responses:
 *       200:
 *         description: Side-by-side comparison with per-story diffs and summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 run1: { $ref: '#/components/schemas/PipelineRun' }
 *                 run2: { $ref: '#/components/schemas/PipelineRun' }
 *                 stories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       run1Status: { type: string, nullable: true }
 *                       run2Status: { type: string, nullable: true }
 *                       change: { type: string, enum: [unchanged, improved, regressed, new_in_run2, removed_in_run2] }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     run1PassRate: { type: integer }
 *                     run2PassRate: { type: integer }
 *                     improved: { type: integer }
 *                     regressed: { type: integer }
 *       400: { description: "Missing or invalid run1/run2 params, or comparing a run with itself" }
 *       404: { description: "One or both runs not found" }
 *       500: { description: "Internal server error" }
 */
router.get('/runs/compare', async (req: Request, res: Response) => {
  try {
    const run1Id = parseInt(String(req.query.run1), 10);
    const run2Id = parseInt(String(req.query.run2), 10);

    if (isNaN(run1Id) || isNaN(run2Id)) {
      throw new ValidationError('Missing or invalid run1/run2 query params');
      return;
    }

    if (run1Id === run2Id) {
      throw new ValidationError('Cannot compare a run with itself');
      return;
    }

    // Fetch both runs
    const run1 = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [run1Id]) as PipelineRunRow | undefined;
    const run2 = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [run2Id]) as PipelineRunRow | undefined;

    if (!run1) { throw new NotFoundError(`Run ${run1Id} not found`); return; }
    if (!run2) { throw new NotFoundError(`Run ${run2Id} not found`); return; }

    // Fetch story results for both runs (latest per story_id by highest id)
    const stories1All = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [run1Id]) as StoryResultRow[];
    const stories2All = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [run2Id]) as StoryResultRow[];

    // Deduplicate to latest result per story_id (retries produce multiple rows)
    const latestStory = (rows: StoryResultRow[]) => {
      const map = new Map<string, StoryResultRow>();
      for (const r of rows) map.set(r.story_id, r); // last row wins (ordered by id ASC)
      return map;
    };

    const map1 = latestStory(stories1All);
    const map2 = latestStory(stories2All);

    // Collect all story IDs from both runs
    const allStoryIds = new Set([...map1.keys(), ...map2.keys()]);

    // Build per-story comparison
    type StoryChange = 'unchanged' | 'improved' | 'regressed' | 'new_in_run2' | 'removed_in_run2';
    interface StoryComparison {
      storyId: string;
      run1Status: string | null;
      run2Status: string | null;
      run1Elapsed: number | null;
      run2Elapsed: number | null;
      run1Retries: number | null;
      run2Retries: number | null;
      run1InputTokens: number | null;
      run1OutputTokens: number | null;
      run2InputTokens: number | null;
      run2OutputTokens: number | null;
      change: StoryChange;
    }

    const stories: StoryComparison[] = [];

    for (const storyId of allStoryIds) {
      const s1 = map1.get(storyId);
      const s2 = map2.get(storyId);

      let change: StoryChange = 'unchanged';
      if (!s1 && s2) {
        change = 'new_in_run2';
      } else if (s1 && !s2) {
        change = 'removed_in_run2';
      } else if (s1 && s2 && s1.status !== s2.status) {
        // Determine if improved or regressed
        const isPass = (st: string) => st === 'pass';
        if (!isPass(s1.status) && isPass(s2.status)) {
          change = 'improved';
        } else if (isPass(s1.status) && !isPass(s2.status)) {
          change = 'regressed';
        } else {
          change = 'unchanged'; // e.g. fail→skip — neither clear improvement nor regression
        }
      }

      stories.push({
        storyId,
        run1Status: s1?.status ?? null,
        run2Status: s2?.status ?? null,
        run1Elapsed: s1?.elapsed_seconds ?? null,
        run2Elapsed: s2?.elapsed_seconds ?? null,
        run1Retries: s1?.retries ?? null,
        run2Retries: s2?.retries ?? null,
        run1InputTokens: s1?.input_tokens ?? null,
        run1OutputTokens: s1?.output_tokens ?? null,
        run2InputTokens: s2?.input_tokens ?? null,
        run2OutputTokens: s2?.output_tokens ?? null,
        change,
      });
    }

    // Sort: changes first, then alphabetical
    const changePriority: Record<StoryChange, number> = {
      regressed: 0, improved: 1, new_in_run2: 2, removed_in_run2: 3, unchanged: 4,
    };
    stories.sort((a, b) =>
      changePriority[a.change] !== changePriority[b.change]
        ? changePriority[a.change] - changePriority[b.change]
        : a.storyId.localeCompare(b.storyId)
    );

    // Compute summary stats
    const passCount = (map: Map<string, StoryResultRow>) =>
      Array.from(map.values()).filter(s => s.status === 'pass').length;
    const totalElapsed = (map: Map<string, StoryResultRow>) =>
      Array.from(map.values()).reduce((sum, s) => sum + (s.elapsed_seconds ?? 0), 0);

    const run1PassCount = passCount(map1);
    const run2PassCount = passCount(map2);
    const run1Total = map1.size;
    const run2Total = map2.size;

    const summary = {
      run1PassRate: run1Total > 0 ? Math.round((run1PassCount / run1Total) * 100) : 0,
      run2PassRate: run2Total > 0 ? Math.round((run2PassCount / run2Total) * 100) : 0,
      passRateDelta: (run2Total > 0 ? (run2PassCount / run2Total) : 0) - (run1Total > 0 ? (run1PassCount / run1Total) : 0),
      run1TotalElapsed: totalElapsed(map1),
      run2TotalElapsed: totalElapsed(map2),
      elapsedDelta: totalElapsed(map2) - totalElapsed(map1),
      run1StoryCount: run1Total,
      run2StoryCount: run2Total,
      improved: stories.filter(s => s.change === 'improved').length,
      regressed: stories.filter(s => s.change === 'regressed').length,
      newStories: stories.filter(s => s.change === 'new_in_run2').length,
      removedStories: stories.filter(s => s.change === 'removed_in_run2').length,
    };

    res.json({ run1, run2, stories, summary });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Compare runs');
  }
});

// ─── GET /api/pipeline/runs/:runId — Get run detail + story results ──────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get a pipeline run with story results
 *     operationId: getPipelineRun
 *     description: Retrieves a single pipeline run by ID along with all its story results and spec metadata.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Run details with story results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 run: { $ref: '#/components/schemas/PipelineRun' }
 *                 stories:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/StoryResult' }
 *                 worktreePath: { type: string, nullable: true, description: "Worktree path (if run uses worktree isolation)" }
 *                 branchName: { type: string, nullable: true, description: "Git branch name (if run uses worktree isolation)" }
 *       404: { description: "Run not found" }
 */
router.get('/runs/:runId', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    const stories = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [runId]) as StoryResultRow[];

    // Read spec JSON to return full userStories list (including pending ones)
    // OC-029: Include per-story engine assignment in response
    const runAgentType = (run.agent_type || run.agent || 'claude') as AgentType;
    let specStories: { id: string; title: string; dependsOn?: string[]; passes?: boolean; agent?: string; reroute?: { fromEngine: string; toEngine: string; reason: string } }[] = [];
    let specModel: string | null = null;
    try {
      const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
      if (workspace) {
        const absSpecPath = path.join(workspace.path, run.spec_path);
        if (fs.existsSync(absSpecPath)) {
          const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
          specModel = specJson.model || null;
          if (Array.isArray(specJson.userStories)) {
            specStories = specJson.userStories.map((s: any) => {
              const storyAgent = resolveStoryAgent(s, runAgentType);
              const reroute = reroutedStories.get(s.id);
              return {
                id: s.id,
                title: s.title,
                dependsOn: s.dependsOn,
                passes: s.passes,
                agent: storyAgent,
                suggestedSkills: Array.isArray(s.suggestedSkills) ? s.suggestedSkills : [],
                ...(reroute ? { reroute: { fromEngine: reroute.fromEngine, toEngine: reroute.toEngine, reason: reroute.reason } } : {}),
              };
            });
          }
        }
      }
    } catch {
      // Spec file missing or malformed — specStories stays empty
    }

    // OC-029: Enrich specStories with reroute data from WAL events (for historical runs)
    if (specStories.length > 0) {
      try {
        const rerouteEvents = await query<{ story_id: string; payload: string }>(`SELECT story_id, payload FROM wal_events WHERE event_type = 'story_rerouted' AND (payload->>'run_id')::bigint = $1 ORDER BY id ASC`, [runId]);
        for (const evt of rerouteEvents) {
          const story = specStories.find(s => s.id === evt.story_id);
          if (story && !story.reroute) {
            try {
              const p = JSON.parse(evt.payload);
              story.reroute = { fromEngine: p.fromEngine, toEngine: p.toEngine, reason: p.reason };
            } catch { /* malformed payload */ }
          }
        }
      } catch { /* WAL query error — non-fatal */ }
    }

    // Aggregate token counts and cost from story_results
    const tokenRow = await queryOne(`SELECT COALESCE(SUM(input_tokens), 0) AS total_input,
              COALESCE(SUM(output_tokens), 0) AS total_output,
              COALESCE(SUM(cost_usd), 0) AS total_cost
       FROM story_results WHERE run_id = $1`, [runId]) as { total_input: number; total_output: number; total_cost: number };

    // Per-story token breakdown
    const storyTokenBreakdown = stories.map((s) => ({
      storyId: s.story_id,
      status: s.status,
      inputTokens: s.input_tokens ?? 0,
      outputTokens: s.output_tokens ?? 0,
      modelUsed: s.model_used ?? null,
      costUsd: s.cost_usd ?? 0,
    }));

    // CIE-007: Read run-state.json for real-time story progress fallback
    let runState: RunState | null = null;
    try {
      const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
      if (workspace) {
        runState = readRunState(workspace.path);
        // Only include if it belongs to this run
        if (runState && runState.runId !== runId) runState = null;
      }
    } catch { /* non-fatal */ }

    // CIE-016: Build actual vs predicted context comparison
    let contextComparison: {
      predicted: Record<string, { totalTokens: number; injectedFiles: string[] }>;
      actual: Record<string, { contextFiles: string[] }>;
    } | null = null;

    const predictedRaw = (run as any).context_preview;
    if (predictedRaw) {
      try {
        const predicted = JSON.parse(predictedRaw);
        const predictedMap: Record<string, { totalTokens: number; injectedFiles: string[] }> = {};
        for (const s of (predicted.stories ?? [])) {
          predictedMap[s.storyId] = { totalTokens: s.totalTokens, injectedFiles: s.injectedFiles };
        }

        // Collect actual context_files from story_started WAL events
        const actualMap: Record<string, { contextFiles: string[] }> = {};
        try {
          const walRows = await query<{ story_id: string; payload: string }>(`SELECT story_id, payload FROM wal_events WHERE event_type = 'story_started' AND (payload->>'run_id')::bigint = $1`, [runId]);
          for (const row of walRows) {
            try {
              const p = JSON.parse(row.payload);
              if (p.context_files) {
                actualMap[row.story_id] = { contextFiles: p.context_files };
              }
            } catch { /* skip */ }
          }
        } catch { /* non-fatal */ }

        contextComparison = { predicted: predictedMap, actual: actualMap };
      } catch { /* malformed context_preview */ }
    }

    res.json({
      run,
      stories,
      specStories,
      specModel,
      agentType: run.agent_type || run.agent || 'claude',
      agentModel: run.agent_model || null,
      // US-004: Expose worktree fields at top level for easy frontend access
      worktreePath: run.worktree_path || null,
      branchName: run.branch_name || null,
      includeGraph: run.include_graph ?? false,
      tokenSummary: {
        inputTokens: tokenRow.total_input,
        outputTokens: tokenRow.total_output,
        totalCostUsd: tokenRow.total_cost,
      },
      storyTokenBreakdown,
      runState,
      contextComparison,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get run');
  }
});

// ─── POST /api/pipeline/runs/:runId/retry — Retry failed stories ─────────────
// Accepts optional 'storyIds' array; when omitted, retries all failed stories.
// Preserves original failed story_result rows for audit trail.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/retry:
 *   post:
 *     tags: [Pipeline]
 *     summary: Retry failed stories in a pipeline run via pg-boss job queue
 *     operationId: retryPipelineRun
 *     description: Re-executes failed stories from a completed or partially failed pipeline run, optionally filtering to specific story IDs. Enqueues a pipeline:retry pg-boss job; worker handles the actual spawn.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               storyIds:
 *                 type: array
 *                 items: { type: string }
 *                 description: Specific story IDs to retry (all failed if omitted)
 *     responses:
 *       201: { description: "Retry job enqueued", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, queued: { type: boolean }, jobId: { type: string }, runId: { type: integer } } } } } }
 *       404: { description: "Run not found" }
 *       409: { description: "Retry job already queued for this run" }
 */
router.post('/runs/:runId/retry', async (req: Request, res: Response) => {
  try {
    const originalRunId = parseInt(String(req.params.runId), 10);
    if (isNaN(originalRunId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const { storyIds } = req.body as { storyIds?: string[] };

    // 1. Fetch the original run
    const originalRun = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [originalRunId]) as PipelineRunRow | undefined;

    if (!originalRun) {
      throw new NotFoundError('Run not found');
      return;
    }

    // Only retry runs that have terminal failure states
    if (!['failed', 'done', 'partial_failure'].includes(originalRun.status)) {
      throw new ConflictError(`Cannot retry run with status '${originalRun.status}'`);
      return;
    }

    // 2. Find all stories and their latest status from the original run
    const allStories = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [originalRunId]) as StoryResultRow[];

    // Get the latest result per story_id (last row wins — ordered by id ASC)
    const latestByStory = new Map<string, StoryResultRow>();
    for (const s of allStories) {
      latestByStory.set(s.story_id, s);
    }

    // Fallback: if story_results is empty (subprocess HTTP calls failed), derive from spec JSON
    if (latestByStory.size === 0 && originalRun.spec_path) {
      try {
        const wsRow = await queryOne('SELECT path FROM workspaces WHERE id = $1', [originalRun.workspace_id]) as { path: string } | undefined;
        if (wsRow) {
          const specPath = path.join(wsRow.path, originalRun.spec_path);
          if (fs.existsSync(specPath)) {
            const specData = JSON.parse(fs.readFileSync(specPath, 'utf8'));
            const stories = specData.userStories || specData.phases?.flatMap((p: { stories: unknown[] }) => p.stories) || [];
            for (const s of stories as Array<{ id: string; passes?: boolean }>) {
              latestByStory.set(s.id, {
                id: 0, run_id: originalRunId, story_id: s.id,
                status: s.passes ? 'pass' : 'fail',
                retries: 0, log_path: null, started_at: new Date().toISOString(), finished_at: null,
                elapsed_seconds: null, input_tokens: null, output_tokens: null,
                model_used: null, cost_usd: null,
              } as StoryResultRow);
            }
            logger.info(`[retry] Derived ${latestByStory.size} story statuses from spec JSON (story_results table was empty)`);
          }
        }
      } catch (specErr: unknown) {
        logger.warn(`[retry] Could not derive stories from spec JSON: ${(specErr as Error).message}`);
      }
    }

    // Include both 'fail' and 'skip' (blocked) stories as retryable
    const failedStories = Array.from(latestByStory.values()).filter(s => s.status === 'fail' || s.status === 'skip');
    const passedStories = Array.from(latestByStory.values()).filter(s => s.status === 'pass');

    if (failedStories.length === 0) {
      throw new UnprocessableError('No failed stories to retry');
      return;
    }

    // 3. Determine which stories to retry
    let storiesToRetry: StoryResultRow[];
    if (storyIds && storyIds.length > 0) {
      storiesToRetry = failedStories.filter(s => storyIds.includes(s.story_id));
      if (storiesToRetry.length === 0) {
        throw new UnprocessableError('None of the specified storyIds are failed stories in this run');
        return;
      }
    } else {
      storiesToRetry = failedStories;
    }

    // 4. Look up workspace
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [originalRun.workspace_id]) as
      { id: string; label: string; path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // 5. Duplicate-job guard — check for an active pipeline:retry job for this runId.
    //    Job IDs are retry-<runId>-<timestamp> so uniqueness alone won't block duplicates.
    //    We query pgboss.job directly to find any active/created job for this runId.
    const existingJob = await queryOne<{ id: string }>(
      `SELECT id FROM pgboss.job WHERE name = 'pipeline:retry' AND data->>'runId' = $1 AND state IN ('created', 'active') LIMIT 1`,
      [String(originalRunId)],
    ).catch(() => undefined); // pgboss schema might not exist yet in test envs

    if (existingJob) {
      throw new ConflictError('A retry job for this run is already queued or active');
      return;
    }

    // 6. Capture sequenceOffset BEFORE creating the new run row to avoid race conditions
    //    between two simultaneous retry requests. The worker starts chunks at sequenceOffset + 1.
    const seqRow = await queryOne<{ max_seq: number | null }>(
      `SELECT MAX(sequence) AS max_seq FROM run_output_chunks WHERE run_id = $1`,
      [originalRunId],
    );
    const sequenceOffset = seqRow?.max_seq ?? 0;

    // 7. Create a NEW pipeline_run linked to the original via retried_from_run_id
    const newRunResult = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, branch_name, worktree_path, retried_from_run_id)
       VALUES ($1, $2, 'running', 'retry', $3, $4, $5) RETURNING id`, [originalRun.spec_path,
      originalRun.workspace_id,
      originalRun.branch_name,
      originalRun.worktree_path,
      originalRunId,]);
    const newRunId = newRunResult!.id;

    // 8. Copy successful story results from the original run to the new run
    for (const passed of passedStories) {
      await execute(
        `INSERT INTO story_results (run_id, story_id, status, retries, log_path, started_at, finished_at, elapsed_seconds, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          newRunId,
          passed.story_id,
          'pass',
          passed.retries,
          passed.log_path,
          passed.started_at,
          passed.finished_at,
          passed.elapsed_seconds,
          passed.input_tokens,
          passed.output_tokens,
        ]
      );
    }

    // 9. Insert 'retry' placeholder rows for stories being retried + emit WAL events
    const retriedStoryInfo: Array<{ storyId: string; attempt: number }> = [];

    for (const story of storiesToRetry) {
      const attempt = story.retries + 1;
      await execute(
        `INSERT INTO story_results (run_id, story_id, status, retries) VALUES ($1, $2, 'retry', $3)`,
        [newRunId, story.story_id, attempt]
      );

      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, story_id, payload) VALUES ('story_retried', $1, $2, $3) RETURNING *`,
        [
          originalRun.workspace_id,
          story.story_id,
          JSON.stringify({ run_id: newRunId, original_run_id: originalRunId, story_id: story.story_id, attempt }),
        ]
      );
      if (walEvent) broadcastAll(walEvent!);

      retriedStoryInfo.push({ storyId: story.story_id, attempt });
    }

    // Emit run_started WAL event for the new retry run
    const runStartEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_started', $1, $2)` + ' RETURNING *', [originalRun.workspace_id, JSON.stringify({
      run_id: newRunId,
      spec_path: originalRun.spec_path,
      retried_from_run_id: originalRunId,
      retried_stories: storiesToRetry.map(s => s.story_id),
    })]);
    broadcastAll(runStartEvent!);

    // 10. Read the original spec and write a temporary retry spec.
    //     Include all stories so dependency resolution works correctly — passed stories
    //     (passes:true) are skipped naturally by the engine.
    const absSpecPath = path.join(workspace.path, originalRun.spec_path);
    if (!fs.existsSync(absSpecPath)) {
      throw new UnprocessableError(`Spec file not found at ${absSpecPath}`);
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    const retrySpecName = `retry-${newRunId}-${Date.now()}.json`;
    const retrySpecDir = path.join(workspace.path, 'forge', 'specs', 'approved');
    const retrySpecPath = path.join(retrySpecDir, retrySpecName);
    fs.mkdirSync(retrySpecDir, { recursive: true });
    fs.writeFileSync(retrySpecPath, JSON.stringify(specJson, null, 2));

    // 11. Build env overrides (same logic as pipeline trigger)
    const envOverrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
        envOverrides[k] = v;
      }
    }
    envOverrides['RORCA_PROCESS_ROLE'] = 'engine';
    const wsEnvVars = getWorkspaceEnvVars(originalRun.workspace_id);
    for (const [k, v] of Object.entries(wsEnvVars)) {
      envOverrides[k] = v;
    }

    // 12. Validate job payload with Zod before sending to pg-boss.
    //     Invalid payloads must throw here — pg-boss failure handling is not a substitute.
    const PipelineRetryJobPayloadSchema = z.object({
      runId: z.number().int().positive(),
      originalRunId: z.number().int().positive(),
      storyIds: z.array(z.string()),
      workspacePath: z.string().min(1),
      specPath: z.string().min(1),
      retrySpecPath: z.string().min(1),
      agent: z.enum(['claude', 'opencode', 'codex']),
      model: z.string().nullable(),
      worktreePath: z.string().nullable(),
      sequenceOffset: z.number().int().min(0),
      envOverrides: z.record(z.string(), z.string()),
      includeGraph: z.boolean().optional().default(false),
    });

    const jobPayload = PipelineRetryJobPayloadSchema.parse({
      runId: Number(newRunId),
      originalRunId,
      storyIds: storiesToRetry.map(s => s.story_id),
      workspacePath: workspace.path,
      specPath: originalRun.spec_path,
      retrySpecPath,
      agent: agentConfig.agentType,
      model: agentConfig.agentModel ?? null,
      worktreePath: originalRun.worktree_path ?? null,
      sequenceOffset,
      envOverrides,
      includeGraph: originalRun.include_graph ?? false,
    });

    // 13. Enqueue via pg-boss (let pg-boss generate a UUID job ID).
    await getBoss().send('pipeline:retry', jobPayload, {
      retryLimit: 0,
      expireInSeconds: 300, // Task-Monitor: job spawns engine and returns immediately
    });

    logger.info(`[Pipeline] Enqueued pipeline:retry job for newRunId=${newRunId} (originalRunId=${originalRunId})`);

    res.status(201).json({
      ok: true,
      queued: true,
      runId: newRunId,
      originalRunId,
      queuePosition: 1,
      retriedStories: retriedStoryInfo,
      copiedStories: passedStories.map(s => s.story_id),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Retry');
  }
});

// ─── POST /api/pipeline/runs/:runId/retry-merge — Retry a failed worktree merge ─
// Re-enqueues the merge job for a run whose merge_status is 'failed'.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/retry-merge:
 *   post:
 *     tags: [Pipeline]
 *     summary: Retry a failed worktree auto-merge
 *     operationId: retryMerge
 *     description: Re-enqueues a pipeline:merge pg-boss job for a run whose merge_status is 'failed'. Resets merge_status to 'merging'.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Merge job enqueued", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, queued: { type: boolean } } } } } }
 *       404: { description: "Run not found" }
 *       409: { description: "merge_status is not failed" }
 */
router.post('/runs/:runId/retry-merge', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne<{
      id: number;
      merge_status: string | null;
      branch_name: string | null;
      worktree_path: string | null;
      workspace_id: string;
    }>(
      'SELECT id, merge_status, branch_name, worktree_path, workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );

    if (!run) {
      throw new NotFoundError('Run', String(runId));
    }

    if (run.merge_status !== 'failed') {
      throw new ConflictError(
        `Cannot retry merge: merge_status is '${run.merge_status ?? 'null'}', expected 'failed'`,
      );
    }

    if (!run.branch_name) {
      throw new ConflictError('Cannot retry merge: run has no branch_name (not a worktree run)');
    }

    // Reset merge_status to 'merging' — use rowCount to detect race condition
    const { rowCount } = await execute(
      `UPDATE pipeline_runs SET merge_status = 'merging' WHERE id = $1 AND merge_status = 'failed'`,
      [runId],
    );

    if (rowCount === 0) {
      throw new ConflictError('Merge status was already changed by another request');
    }

    // Enqueue pipeline:merge job
    await getBoss().send('pipeline:merge', {
      runId,
      branch: run.branch_name,
      workspaceId: run.workspace_id,
    }, {
      retryLimit: 0,
      expireInSeconds: 3600, // 1 hour
    });

    logger.info({ runId, branch: run.branch_name }, '[Pipeline] Enqueued pipeline:merge retry job');

    res.status(200).json({ ok: true, runId, queued: true });
  } catch (error: any) {
    // AppError subclasses are caught and serialized by the centralized error handler
    logger.error({ error }, '[Pipeline] retry-merge error');
    throw error;
  }
});

// ─── POST /api/pipeline/runs/:runId/pause — Pause a running pipeline ─────────
// Sends SIGTSTP to the process group so the current story finishes before pausing.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/pause:
 *   post:
 *     tags: [Pipeline]
 *     summary: Pause a running pipeline
 *     operationId: pausePipelineRun
 *     description: Sends SIGTSTP to the pipeline process group, allowing the current story to finish before pausing execution.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Paused", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/pause', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    if (run.status !== 'running') {
      throw new ConflictError(`Cannot pause run with status '${run.status}'`);
      return;
    }

    if (!run.pid || !isPidAlive(run.pid)) {
      throw new ConflictError('Process is not alive');
      return;
    }

    // Send SIGTSTP to the process group (negative pid) — the current story
    // finishes because SIGTSTP is a "soft" stop that the shell handles at
    // the next job-control boundary, letting the foreground child complete.
    try {
      process.kill(-run.pid, 'SIGTSTP');
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        throw new ConflictError('Process is no longer running');
      }
      handleRouteError(res, err, '[Pipeline] Send SIGTSTP');
      return;
    }

    // Update status to 'paused'
    await execute(`UPDATE pipeline_runs SET status = 'paused' WHERE id = $1`, [runId]);

    // Compute elapsed time and completed story count for the WAL event
    const elapsedMs = Date.now() - new Date(run.started_at + 'Z').getTime();
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const completedStories = await queryOne(`SELECT COUNT(*)::int as cnt FROM story_results WHERE run_id = $1 AND status IN ('pass', 'fail')`, [runId]) as { cnt: number };

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_paused', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
      run_id: runId,
      elapsed_seconds: elapsedSeconds,
      completed_stories: completedStories.cnt,
    })]);
    broadcastAll(walEvent!);

    res.json({ ok: true, runId, status: 'paused' });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Pause');
  }
});

// ─── POST /api/pipeline/runs/:runId/resume — Resume a paused pipeline ────────
// Sends SIGCONT to the process group to resume execution.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/resume:
 *   post:
 *     tags: [Pipeline]
 *     summary: Resume a paused pipeline
 *     operationId: resumePipelineRun
 *     description: Sends SIGCONT to the paused pipeline process group to resume story execution from where it left off.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Resumed", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/resume', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    if (run.status !== 'paused') {
      throw new ConflictError(`Cannot resume run with status '${run.status}'`);
      return;
    }

    if (!run.pid || !isPidAlive(run.pid)) {
      throw new ConflictError('Process is not alive');
      return;
    }

    // Send SIGCONT to the process group
    try {
      process.kill(-run.pid, 'SIGCONT');
    } catch (err: any) {
      handleRouteError(res, err, '[Pipeline] Send SIGCONT');
      return;
    }

    // Update status back to 'running'
    await execute(`UPDATE pipeline_runs SET status = 'running' WHERE id = $1`, [runId]);

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_resumed', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({ run_id: runId })]);
    broadcastAll(walEvent!);

    res.json({ ok: true, runId, status: 'running' });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Resume');
  }
});

// ─── POST /api/pipeline/runs/:runId/context — Inject context into a blocked run ─
// When a run_blocked WAL event fires (HITL pause), the user can inject free-text
// context. This writes the context to a file the run-loop can read, emits a
// run_resumed WAL event, and sends SIGCONT to resume the process.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/context:
 *   post:
 *     tags: [Pipeline]
 *     summary: Inject context into a blocked (HITL) pipeline run and resume
 *     operationId: injectPipelineContext
 *     description: Writes free-text context to a file for the run-loop to pick up and sends SIGCONT to resume a blocked or paused pipeline run.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [context]
 *             properties:
 *               context: { type: string, description: "Free-text context to inject" }
 *     responses:
 *       200: { description: "Context injected and run resumed" }
 *       400: { description: "Missing or empty context" }
 *       404: { description: "Run not found" }
 *       409: { description: "Run is not in blocked or paused state" }
 */
router.post('/runs/:runId/context', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const { context } = req.body as { context?: string };
    if (!context || context.trim().length === 0) {
      throw new ValidationError('Context is required and cannot be empty');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    // Accept context injection when run is blocked or paused
    if (run.status !== 'paused' && run.status !== 'running') {
      throw new ConflictError(`Cannot inject context into run with status '${run.status}'`);
      return;
    }

    // Write context to a file the run-loop can pick up
    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
    if (workspace) {
      const contextDir = path.join(workspace.path, 'forge', 'logs');
      fs.mkdirSync(contextDir, { recursive: true });
      const contextFile = path.join(contextDir, `run-${runId}-context.txt`);
      fs.writeFileSync(contextFile, context.trim(), 'utf8');
    }

    // If process is stopped (paused/blocked), send SIGCONT to resume
    if (run.pid && isPidAlive(run.pid)) {
      try {
        process.kill(-run.pid, 'SIGCONT');
      } catch {
        // Process may have already exited
      }
    }

    // Update status back to running
    await execute(`UPDATE pipeline_runs SET status = 'running' WHERE id = $1`, [runId]);

    // Emit run_resumed WAL event with injected context info
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_resumed', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
      run_id: runId,
      context_injected: true,
      context_length: context.trim().length,
    })]);
    broadcastAll(walEvent!);

    // Also append context to the output buffer so it shows in the terminal
    const buf = outputBuffers.get(runId);
    if (buf) {
      const contextMsg = `\r\n\x1b[1;33m[Context injected by user]\x1b[0m\r\n\x1b[36m${context.trim()}\x1b[0m\r\n`;
      buf.chunks.push(contextMsg);
      buf.subscribers.forEach(cb => cb(contextMsg));
    }

    res.json({ ok: true, runId, status: 'running' });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Context injection');
  }
});

// ─── POST /api/pipeline/runs/:runId/cancel — Cancel a queued or running pipeline ─
// Queued path: calls getBoss().cancel(String(runId)) to remove the pg-boss job
//   before the worker picks it up, then marks the run as cancelled immediately.
// Running path: sends a 'pipeline:cancel' job to the worker, returns 200 immediately.
//   The worker owns SIGTERM → SIGKILL sequencing and DB/WAL updates for this path.
// Completed/cancelled: returns 409 Conflict.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/cancel:
 *   post:
 *     tags: [Pipeline]
 *     summary: Cancel a queued or running pipeline run
 *     operationId: cancelPipelineRun
 *     description: >
 *       For queued runs: removes the pg-boss job and marks the run as cancelled immediately.
 *       For running runs: delivers a pipeline:cancel job to the worker (which sends SIGTERM then SIGKILL after 10s) and returns 200 immediately — DB and WAL updates happen asynchronously in the worker.
 *       Returns 409 if the run is already completed or cancelled.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Cancelled (or cancel delivered to worker)", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 *       409: { description: "Run is already completed or cancelled" }
 */
router.post('/runs/:runId/cancel', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne<{ id: number; status: string; workspace_id: string; started_at: string; pid: number | null }>(
      'SELECT id, status, workspace_id, started_at, pid FROM pipeline_runs WHERE id = $1',
      [runId],
    );

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    const { status } = run;

    // Already done — conflict
    if (status !== 'queued' && status !== 'running' && status !== 'paused') {
      throw new ConflictError(`Run is already ${status} and cannot be cancelled`);
    }

    if (status === 'queued') {
      // ── Queued path ──────────────────────────────────────────────────────
      // Attempt to remove the pg-boss job before the worker picks it up.
      // pg-boss requires UUID job IDs — look up by payload runId.
      const jobRow = await queryOne<{ id: string }>(
        `SELECT id FROM pgboss.job WHERE name = 'pipeline:run' AND data->>'runId' = $1 AND state IN ('created', 'active') LIMIT 1`,
        [String(runId)]
      );
      if (jobRow) {
        await getBoss().cancel('pipeline:run', jobRow.id);
      }

      // Re-read status: if the worker picked up the job between our check and
      // cancel, the run may have already transitioned to 'running'. Fall through.
      const refreshed = await queryOne<{ status: string }>(
        'SELECT status FROM pipeline_runs WHERE id = $1',
        [runId],
      );

      if (refreshed && (refreshed.status === 'running' || refreshed.status === 'paused')) {
        // Worker picked it up — delegate to the running path
        await getBoss().send('pipeline:cancel', { runId }, { expireInSeconds: 120 });
        res.json({ ok: true, runId, status: 'cancelling' });
        return;
      }

      // Mark run as cancelled in DB (it's still queued or the job was removed)
      await execute(
        `UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), queue_position = NULL WHERE id = $1`,
        [runId],
      );

      // Recalculate queue positions for remaining queued runs
      const { recalculateQueuePositions } = require('../lib/run-queue') as typeof import('../lib/run-queue');
      recalculateQueuePositions(run.workspace_id);

      // Emit WAL event
      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_cancelled', $1, $2) RETURNING *`,
        [run.workspace_id, JSON.stringify({ run_id: runId, cancelledAt: new Date().toISOString() })],
      );
      if (walEvent) broadcastAll(walEvent);

      res.json({ ok: true, runId, status: 'cancelled' });
      return;
    }

    // ── Running / paused path ─────────────────────────────────────────────
    // Deliver cancel job to the worker for SIGTERM/SIGKILL sequencing.
    await getBoss().send('pipeline:cancel', { runId }, { expireInSeconds: 120 });

    // Best-effort: if the PID is already dead (worker crashed, process exited),
    // mark the run cancelled immediately rather than waiting for the worker.
    const pidAlive = run.pid ? isPidAlive(run.pid) : false;

    if (!pidAlive) {
      // Process is already gone — handle cancellation inline
      await execute(
        `UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW() WHERE id = $1`,
        [runId],
      );
      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_cancelled', $1, $2) RETURNING *`,
        [run.workspace_id, JSON.stringify({ run_id: runId, cancelledAt: new Date().toISOString(), reason: 'pid_not_alive' })],
      );
      if (walEvent) broadcastAll(walEvent);
      res.json({ ok: true, runId, status: 'cancelled' });
      return;
    }

    // PID is alive — send SIGTERM directly as a best-effort fallback alongside the worker job
    if (run.pid) {
      try {
        process.kill(run.pid, 'SIGTERM');
      } catch {
        // ESRCH (already dead) or EPERM (no permission) — ignore, worker will handle it
      }
    }

    res.json({ ok: true, runId, status: 'cancelling' });
  } catch (error: unknown) {
    // AppError subclasses are caught and serialized by the centralized error handler
    logger.error({ err: error }, '[Pipeline] Cancel error');
    throw error;
  }
});

// ─── DELETE /api/pipeline/runs/:runId — Cancel a queued run ──────────────────
// Only works for runs with status='queued'. Returns 409 if the run is active/done.
// Recalculates queue_position for remaining queued runs after cancellation.

/**
 * @swagger
 * /api/pipeline/runs/{runId}:
 *   delete:
 *     tags: [Pipeline]
 *     summary: Cancel a queued pipeline run
 *     operationId: cancelQueuedRun
 *     description: Cancels a queued run by marking it as failed with finished_at set. Only works for runs with status='queued'. Returns 409 if the run is already active or completed.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Queued run cancelled", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer } } } } } }
 *       404: { description: "Run not found" }
 *       409: { description: "Run is not in queued state" }
 */
router.delete('/runs/:runId', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    if (run.status !== 'queued') {
      throw new ConflictError(`Cannot cancel run with status '${run.status}' — only queued runs can be cancelled via DELETE`);
      return;
    }

    // Remove the pg-boss job before the worker picks it up.
    // pg-boss requires UUID job IDs — look up by payload runId.
    const jobRow = await queryOne<{ id: string }>(
      `SELECT id FROM pgboss.job WHERE name = 'pipeline:run' AND data->>'runId' = $1 AND state IN ('created', 'active') LIMIT 1`,
      [String(runId)]
    );
    if (jobRow) {
      await getBoss().cancel('pipeline:run', jobRow.id);
    }

    // Mark as cancelled
    await execute(`UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), queued_at = NULL, queue_position = NULL WHERE id = $1`, [runId]);

    // Recalculate positions for remaining queued runs
    const { recalculateQueuePositions } = require('../lib/run-queue') as typeof import('../lib/run-queue');
    recalculateQueuePositions(run.workspace_id);

    res.json({ ok: true, runId });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Delete queued run');
  }
});

// ─── GET /api/pipeline/runs/:runId/output — Raw terminal output SSE ──────────
// Streams raw stdout/stderr (with ANSI codes) to xterm.js on the frontend.
// Output is stored in run_output_chunks table (persisted across backend restarts).
// Late-joiners receive full replay of all existing chunks, then live updates via polling.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/output:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream raw terminal output (SSE)
 *     operationId: streamPipelineOutput
 *     description: Server-Sent Events stream of base64-encoded terminal output. Late joiners receive full buffer replay from run_output_chunks table.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: SSE stream with chunk events (base64 data) and done event
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/runs/:runId/output', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.runId), 10);
  if (isNaN(runId)) {
    throw new ValidationError('Invalid runId');
    return;
  }

  // Validate workspace ownership if workspaceId is provided
  const wsId = req.query.workspaceId as string | undefined;
  if (wsId) {
    const ownerCheck = await queryOne('SELECT workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { workspace_id: number } | undefined;
    if (ownerCheck && String(ownerCheck.workspace_id) !== wsId) {
      throw new ForbiddenError('Run does not belong to this workspace');
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);

  // Resolve agent type for semantic parsing (defaults to 'claude')
  const runRow = await queryOne('SELECT agent_type, agent, agent_model, status FROM pipeline_runs WHERE id = $1', [runId]) as { agent_type: string; agent: string; agent_model: string | null; status: string } | undefined;
  const agent = runRow?.agent_type ?? runRow?.agent ?? 'claude';

  // Emit run metadata so frontend knows which renderer to use
  res.write(`event: run_meta\ndata: ${JSON.stringify({ agentType: agent, agentModel: runRow?.agent_model ?? null })}\n\n`);

  // ── Replay all existing chunks (late-join support) ────────────────────────
  interface ChunkRow { sequence: number; chunk: Buffer }
  const existingChunks = await query<ChunkRow>(
    'SELECT sequence, chunk FROM run_output_chunks WHERE run_id = $1 ORDER BY sequence ASC',
    [runId],
  );

  let lastSequence = 0;
  for (const row of existingChunks) {
    const chunkBuf = Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk);
    res.write(`event: chunk\ndata: ${chunkBuf.toString('base64')}\n\n`);
    emitSemanticSteps(chunkBuf.toString('utf8'), agent, res);
    lastSequence = row.sequence;
  }

  // ── If the run is already terminal, close immediately ────────────────────
  const terminalStatuses = ['done', 'failed', 'cancelled'];
  if (runRow && terminalStatuses.includes(runRow.status)) {
    clearInterval(hb);
    res.write('event: done\ndata: \n\n');
    res.end();
    return;
  }

  // ── Poll for new chunks while run is active ───────────────────────────────
  // Checks every 200 ms; uses lastSequence to fetch only new rows efficiently.
  const pollInterval = setInterval(async () => {
    try {
      const newChunks = await query<ChunkRow>(
        'SELECT sequence, chunk FROM run_output_chunks WHERE run_id = $1 AND sequence > $2 ORDER BY sequence ASC',
        [runId, lastSequence],
      );

      for (const row of newChunks) {
        const chunkBuf = Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk);
        res.write(`event: chunk\ndata: ${chunkBuf.toString('base64')}\n\n`);
        emitSemanticSteps(chunkBuf.toString('utf8'), agent, res);
        lastSequence = row.sequence;
      }

      // Check if run has reached a terminal state
      const statusRow = await queryOne<{ status: string }>(
        'SELECT status FROM pipeline_runs WHERE id = $1',
        [runId],
      );
      if (!statusRow || terminalStatuses.includes(statusRow.status)) {
        clearInterval(pollInterval);
        clearInterval(hb);
        res.write('event: done\ndata: \n\n');
        res.end();
      }
    } catch {
      clearInterval(pollInterval);
      clearInterval(hb);
      res.write('event: done\ndata: \n\n');
      res.end();
    }
  }, 200);

  req.on('close', () => {
    clearInterval(pollInterval);
    clearInterval(hb);
  });
});

// ─── Token usage recording helper ─────────────────────────────────────────────
// Inserts into token_usage table with cost calculation from model_pricing.
// Called by both the POST endpoint and WAL auto-record.

interface ModelPricingRow {
  model_id: string;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
}

async function recordTokenUsage(runId: number, storyId: string, inputTokens: number, outputTokens: number, model?: string, reasoningTokens?: number) {
  const run = await queryOne('SELECT workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { workspace_id: string } | undefined;
  if (!run) return;

  const modelName = model || 'unknown';
  const pricing = await queryOne('SELECT * FROM model_pricing WHERE model_id = $1', [modelName]) as ModelPricingRow | undefined;

  const costUsd = pricing
    ? (inputTokens / 1000) * pricing.input_cost_per_1k + (outputTokens / 1000) * pricing.output_cost_per_1k
    : 0;

  await execute(`INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, reasoning_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [runId, storyId, run.workspace_id, modelName, inputTokens, outputTokens, reasoningTokens ?? 0, Math.round(costUsd * 1_000_000) / 1_000_000]);
}

// ─── POST /api/pipeline/story-result — Record story outcome from run-loop.ts ──
// Called by the TypeScript run-loop to insert story_results rows.

/**
 * @swagger
 * /api/pipeline/story-result:
 *   post:
 *     tags: [Pipeline]
 *     summary: Record a story outcome from the execution engine
 *     operationId: recordStoryResult
 *     description: Called by run-loop.ts or execution-engine.ts to insert a story_results row after a story finishes. Also records token usage into the analytics table when tokens are present.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [runId, storyId, status]
 *             properties:
 *               runId: { type: integer, description: "Pipeline run ID" }
 *               storyId: { type: string, description: "Story ID (e.g. US-001)" }
 *               status: { type: string, enum: [pass, fail, skip, excluded] }
 *               worktreePath: { type: string, nullable: true }
 *               worktreeBranch: { type: string, nullable: true }
 *               inputTokens: { type: integer, nullable: true }
 *               outputTokens: { type: integer, nullable: true }
 *               modelUsed: { type: string, nullable: true }
 *               costUsd: { type: number, nullable: true }
 *               logPath: { type: string, nullable: true }
 *               blockedBy: { type: array, items: { type: string }, nullable: true }
 *               activeSkills: { type: array, items: { type: string }, nullable: true }
 *     responses:
 *       201: { description: "Story result recorded" }
 *       400: { description: "Missing required fields or invalid status" }
 *       500: { description: "Internal server error" }
 */
router.post('/story-result', async (req: Request, res: Response) => {
  try {
    const {
      runId, storyId, status, worktreePath, worktreeBranch,
      inputTokens, outputTokens, reasoningTokens, modelUsed, costUsd,
      logPath, blockedBy, activeSkills, failureReason, recoveryClass,
    } = req.body as {
      runId?: number; storyId?: string; status?: string;
      worktreePath?: string; worktreeBranch?: string;
      inputTokens?: number; outputTokens?: number; reasoningTokens?: number; modelUsed?: string; costUsd?: number;
      logPath?: string; blockedBy?: string[]; activeSkills?: string[];
      failureReason?: string; recoveryClass?: string;
    };

    if (!runId || !storyId || !status) {
      throw new ValidationError('runId, storyId, and status are required');
      return;
    }

    if (!['pass', 'fail', 'skip', 'excluded'].includes(status)) {
      throw new ValidationError(`Invalid status: ${status}`);
      return;
    }

    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at, worktree_path, worktree_branch, input_tokens, output_tokens, model_used, cost_usd, log_path, blocked_by, active_skills, failure_reason, recovery_class)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [runId, storyId, status,
      worktreePath ?? null, worktreeBranch ?? null,
      inputTokens ?? null, outputTokens ?? null,
      modelUsed ?? null, costUsd ?? null,
      logPath ?? null,
      blockedBy && blockedBy.length > 0 ? JSON.stringify(blockedBy) : null,
      activeSkills && activeSkills.length > 0 ? JSON.stringify(activeSkills) : null,
      failureReason ?? null,
      recoveryClass ?? null,]);

    // Also record into token_usage analytics table if tokens are present
    if ((inputTokens && inputTokens > 0) || (outputTokens && outputTokens > 0)) {
      recordTokenUsage(runId, storyId, inputTokens || 0, outputTokens || 0, modelUsed, reasoningTokens ?? 0);
    }

    res.status(201).json({ ok: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Story result');
  }
});

// ─── POST /api/pipeline/runs/:runId/stories/:storyId/tokens — Record token usage ─
// Allows run-loop.ts or external callers to report token usage for a story.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/stories/{storyId}/tokens:
 *   post:
 *     tags: [Pipeline]
 *     summary: Record token usage for a story
 *     operationId: recordStoryTokenUsage
 *     description: Updates the story_results row with token counts and records an entry in the token_usage analytics table. Called by run-loop.ts or external callers.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               inputTokens: { type: integer, description: "Number of input tokens consumed" }
 *               outputTokens: { type: integer, description: "Number of output tokens consumed" }
 *               model: { type: string, description: "Model name used for this story" }
 *     responses:
 *       200: { description: "Token usage recorded" }
 *       400: { description: "Invalid runId or missing token counts" }
 *       404: { description: "Story result not found for this run and story" }
 *       500: { description: "Internal server error" }
 */
router.post('/runs/:runId/stories/:storyId/tokens', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    const storyId = String(req.params.storyId);
    const { inputTokens, outputTokens, reasoningTokens, model } = req.body as { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; model?: string };

    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    if (inputTokens == null && outputTokens == null) {
      throw new ValidationError('At least one of inputTokens or outputTokens required');
      return;
    }

    // Find the latest story_result row for this run + storyId
    const row = await queryOne(`SELECT id FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1`, [runId, storyId]) as { id: number } | undefined;

    if (!row) {
      throw new NotFoundError('Story result not found');
      return;
    }

    await execute(`UPDATE story_results SET input_tokens = COALESCE($1, input_tokens), output_tokens = COALESCE($2, output_tokens) WHERE id = $3`, [inputTokens ?? null, outputTokens ?? null, row.id]);

    // Also record into token_usage analytics table
    recordTokenUsage(runId, storyId, inputTokens || 0, outputTokens || 0, model, reasoningTokens ?? 0);

    res.json({ ok: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Record tokens');
  }
});

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/output — Last N lines of story output ─
// Extracts the story's log section from the run log file or returns WAL failure info.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/stories/{storyId}/output:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get last N lines of a story's output
 *     operationId: getStoryOutput
 *     description: Returns the tail of a story's log output extracted from the per-story log file, the run log file, or the in-memory buffer. Also includes failure reason and blocked-by info from WAL events.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: lines
 *         schema: { type: integer, default: 20, maximum: 100 }
 *         description: Number of lines to return (max 100)
 *     responses:
 *       200:
 *         description: Story output lines with metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 storyId: { type: string }
 *                 runId: { type: integer }
 *                 status: { type: string }
 *                 retries: { type: integer }
 *                 failureReason: { type: string, nullable: true }
 *                 failureAttempts: { type: integer, nullable: true }
 *                 blockedBy: { type: array, items: { type: string }, nullable: true }
 *                 output: { type: array, items: { type: string } }
 *                 lineCount: { type: integer }
 *       400: { description: "Invalid runId" }
 *       404: { description: "Story result not found" }
 *       500: { description: "Internal server error" }
 */
router.get('/runs/:runId/stories/:storyId/output', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    const storyId = String(req.params.storyId);
    const lines = Math.min(parseInt(String(req.query.lines ?? '20'), 10) || 20, 100);

    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    // 1. Check story_result exists
    const storyResult = await queryOne(`SELECT * FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1`, [runId, storyId]) as StoryResultRow | undefined;

    if (!storyResult) {
      throw new NotFoundError('Story result not found');
      return;
    }

    // 2. Try to get failure details from WAL events
    const walEvent = await queryOne<{ payload: Record<string, unknown> | string }>(`SELECT payload FROM wal_events WHERE event_type = 'story_failed' AND story_id = $1 AND (payload->>'run_id')::bigint = $2 ORDER BY id DESC LIMIT 1`, [storyId, runId]);

    let failureReason: string | null = null;
    let failureAttempts: number | null = null;
    let blockedBy: string[] | null = null;
    if (walEvent?.payload) {
      try {
        const payload = typeof walEvent.payload === 'string' ? JSON.parse(walEvent.payload) : walEvent.payload;
        failureReason = payload.reason ?? null;
        failureAttempts = payload.attempts ?? null;
        if (Array.isArray(payload.blockedBy)) blockedBy = payload.blockedBy;
      } catch { /* ignore */ }
    }

    // Also check story_results.blocked_by
    if (!blockedBy && (storyResult as any).blocked_by) {
      try {
        blockedBy = JSON.parse((storyResult as any).blocked_by);
      } catch { /* ignore */ }
    }

    // 3. Try reading from per-story log file (log_path in story_results)
    let outputLines: string[] = [];
    const storyLogPath = (storyResult as any).log_path as string | null;
    if (storyLogPath && fs.existsSync(storyLogPath)) {
      try {
        const content = fs.readFileSync(storyLogPath, 'utf-8');
        const allLines = content.split('\n');
        outputLines = allLines.slice(-lines);
      } catch { /* log read error */ }
    }

    // 4. Fallback: Try to extract story output from the run log file
    const logPath = await resolveLogPath(runId);
    if (outputLines.length === 0 && logPath) {
      try {
        const content = fs.readFileSync(logPath, 'utf-8');
        const allLines = content.split('\n');

        // Find the section for this story by searching for story start/end markers
        const storyStartPattern = new RegExp(`(^|\\s)${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|:)`);
        let startIdx = -1;
        let endIdx = allLines.length;

        for (let i = 0; i < allLines.length; i++) {
          if (storyStartPattern.test(allLines[i])) {
            startIdx = i;
          }
        }

        if (startIdx >= 0) {
          // Find next story start after this one
          for (let i = startIdx + 1; i < allLines.length; i++) {
            // Next story starts with a different US-XXX or story ID pattern
            if (/^(US-\d+|[A-Z]+-\d+)\s/.test(allLines[i]) && !storyStartPattern.test(allLines[i])) {
              endIdx = i;
              break;
            }
          }
          const storySection = allLines.slice(startIdx, endIdx);
          outputLines = storySection.slice(-lines);
        } else {
          // Fallback: return last N lines of the entire log
          outputLines = allLines.slice(-lines);
        }
      } catch { /* log read error */ }
    }

    // 4. If no log output, try in-memory buffer
    if (outputLines.length === 0) {
      const buf = outputBuffers.get(runId);
      if (buf) {
        const fullText = buf.chunks.join('');
        const allLines = fullText.split('\n');
        // Try to find story section in buffer too
        const storyStartPattern = new RegExp(`(^|\\s)${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|:)`);
        let startIdx = -1;
        for (let i = 0; i < allLines.length; i++) {
          if (storyStartPattern.test(allLines[i])) {
            startIdx = i;
          }
        }
        if (startIdx >= 0) {
          outputLines = allLines.slice(startIdx).slice(-lines);
        } else {
          outputLines = allLines.slice(-lines);
        }
      }
    }

    res.json({
      storyId,
      runId,
      status: storyResult.status,
      retries: storyResult.retries,
      failureReason,
      failureAttempts,
      blockedBy,
      output: outputLines,
      lineCount: outputLines.length,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Story output');
  }
});

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/log — SSE per-story log stream ─
// Streams a per-story log file as SSE chunks (same protocol as /runs/:runId/output).
// Used by the multi-pane terminal grid when parallelism > 1.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/stories/{storyId}/log:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream per-story log output via SSE
 *     operationId: streamStoryLog
 *     description: Opens an SSE connection that streams a per-story log file in real time. Used by the multi-pane terminal grid for parallel story execution. Emits base64-encoded output chunks and semantic_step events.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: SSE stream of log chunks
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400: { description: "Invalid runId" }
 */
router.get('/runs/:runId/stories/:storyId/log', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.runId), 10);
  const storyId = String(req.params.storyId);
  if (isNaN(runId)) {
    throw new ValidationError('Invalid runId');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);

  // Resolve agent type for semantic parsing
  const runRow = await queryOne('SELECT agent, workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { agent: string; workspace_id: string } | undefined;
  const agent = runRow?.agent ?? 'claude';

  // Find story log file: check WAL event payload first, then scan forge/logs/
  let storyLogPath: string | null = null;

  // 1. Check story_started WAL event for log_file path
  const walRow = await queryOne<{ payload: Record<string, unknown> | string }>(`SELECT payload FROM wal_events WHERE event_type = 'story_started' AND story_id = $1 AND (payload->>'run_id')::bigint = $2 ORDER BY id DESC LIMIT 1`, [storyId, runId]);
  if (walRow?.payload) {
    try {
      const payload = typeof walRow.payload === 'string' ? JSON.parse(walRow.payload) : walRow.payload;
      if (payload.log_file && fs.existsSync(String(payload.log_file))) {
        storyLogPath = payload.log_file;
      }
    } catch { /* ignore */ }
  }

  // 2. Fallback: scan forge/specs/logs/ and forge/logs/ for <storyId>_*.log pattern
  if (!storyLogPath && runRow?.workspace_id) {
    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [runRow.workspace_id]) as { path: string } | undefined;
    if (workspace) {
      // Check both log directories — execution-engine writes to forge/specs/logs/ (relative to spec JSON path)
      const logDirs = [
        path.join(workspace.path, 'forge', 'specs', 'logs'),
        path.join(workspace.path, 'forge', 'logs'),
      ];
      for (const logDir of logDirs) {
        if (storyLogPath) break;
        if (fs.existsSync(logDir)) {
          try {
            const files = fs.readdirSync(logDir)
              .filter(f => f.startsWith(`${storyId}_`) && f.endsWith('.log'))
              .sort()
              .reverse(); // most recent first
            if (files.length > 0) {
              storyLogPath = path.join(logDir, files[0]);
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  if (!storyLogPath) {
    // No log file yet — send waiting status, then poll until it appears or story finishes
    res.write(`event: status\ndata: waiting\n\n`);

    // Poll every 3s for the log file to appear (slow interval to avoid pool exhaustion under parallelism)
    const wsPath = runRow?.workspace_id
      ? (await queryOne('SELECT path FROM workspaces WHERE id = $1', [runRow.workspace_id]) as { path: string } | undefined)?.path
      : undefined;
    const pollForLog = setInterval(async () => {
      try {
        // Re-check WAL event — use JSONB accessor instead of payload::text LIKE (10x faster)
        const freshWal = await queryOne<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM wal_events WHERE event_type = 'story_started' AND story_id = $1 AND (payload->>'run_id')::bigint = $2 ORDER BY id DESC LIMIT 1`,
          [storyId, runId]
        );
        if (freshWal?.payload) {
          const payload = typeof freshWal.payload === 'string' ? JSON.parse(freshWal.payload) : freshWal.payload;
          if (payload.log_file && fs.existsSync(String(payload.log_file))) {
            storyLogPath = String(payload.log_file);
            clearInterval(pollForLog);
            startTailing(storyLogPath!, agent, res, hb, runId, storyId);
            return;
          }
        }

        // Filesystem fallback: scan forge/specs/logs/ and forge/logs/ for the log file
        if (!storyLogPath && wsPath) {
          const fallbackDirs = [
            path.join(wsPath, 'forge', 'specs', 'logs'),
            path.join(wsPath, 'forge', 'logs'),
          ];
          for (const dir of fallbackDirs) {
            if (storyLogPath) break;
            if (fs.existsSync(dir)) {
              try {
                const files = fs.readdirSync(dir)
                  .filter(f => f.startsWith(`${storyId}_`) && f.endsWith('.log'))
                  .sort()
                  .reverse();
                if (files.length > 0) {
                  storyLogPath = path.join(dir, files[0]);
                  clearInterval(pollForLog);
                  startTailing(storyLogPath!, agent, res, hb, runId, storyId);
                  return;
                }
              } catch { /* ignore */ }
            }
          }
        }

        // Check if story already finished (no log will come)
        const finishEvent = await queryOne(
          `SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND (payload->>'run_id')::bigint = $2 LIMIT 1`,
          [storyId, runId]
        );
        if (finishEvent) {
          clearInterval(pollForLog);
          clearInterval(hb);
          res.write('event: done\ndata: \n\n');
          res.end();
        }
      } catch (err) {
        // Swallow DB connection errors — they're transient under heavy load.
        // The next poll tick will retry.
      }
    }, 3000);

    req.on('close', () => {
      clearInterval(pollForLog);
      clearInterval(hb);
    });
    return;
  }

  // Log file exists — start tailing
  startTailing(storyLogPath, agent, res, hb, runId, storyId);

  req.on('close', () => {
    clearInterval(hb);
  });
});

/** Tail a story log file and stream as SSE chunks. */
async function startTailing(logPath: string, agent: string, res: Response, hb: ReturnType<typeof setInterval>, runId: number, storyId: string): Promise<void> {
  // Replay existing content
  let offset = 0;
  try {
    const existing = fs.readFileSync(logPath);
    if (existing.length > 0) {
      res.write(`event: chunk\ndata: ${existing.toString('base64')}\n\n`);
      emitSemanticSteps(existing.toString('utf8'), agent, res);
    }
    offset = existing.length;
  } catch { /* file may have disappeared */ }

  // Check if story already finished
  const finishEvent = await queryOne(`SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND (payload->>'run_id')::bigint = $2 LIMIT 1`, [storyId, runId]);
  if (finishEvent) {
    clearInterval(hb);
    res.write('event: done\ndata: \n\n');
    res.end();
    return;
  }

  // Tail the log file — poll for new bytes every 200 ms
  const tailInterval = setInterval(async () => {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > offset) {
        const newBytes = Buffer.alloc(stat.size - offset);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, newBytes, 0, newBytes.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        const text = newBytes.toString('utf8');
        res.write(`event: chunk\ndata: ${newBytes.toString('base64')}\n\n`);
        emitSemanticSteps(text, agent, res);
      }

      // Check if story finished
      const done = await queryOne(`SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND (payload->>'run_id')::bigint = $2 LIMIT 1`, [storyId, runId]);
      if (done) {
        // Read any final bytes
        const finalStat = fs.statSync(logPath);
        if (finalStat.size > offset) {
          const finalBytes = Buffer.alloc(finalStat.size - offset);
          const fd = fs.openSync(logPath, 'r');
          fs.readSync(fd, finalBytes, 0, finalBytes.length, offset);
          fs.closeSync(fd);
          res.write(`event: chunk\ndata: ${finalBytes.toString('base64')}\n\n`);
          emitSemanticSteps(finalBytes.toString('utf8'), agent, res);
        }
        clearInterval(tailInterval);
        clearInterval(hb);
        res.write('event: done\ndata: \n\n');
        res.end();
      }
    } catch {
      clearInterval(tailInterval);
      clearInterval(hb);
      res.write('event: done\ndata: \n\n');
      res.end();
    }
  }, 200);

  res.req?.on('close', () => {
    clearInterval(tailInterval);
    clearInterval(hb);
  });
}

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/stream — DB-backed story output SSE ───

/**
 * @swagger
 * /api/pipeline/runs/{runId}/stories/{storyId}/stream:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream per-story prose output via SSE (DB-backed)
 *     operationId: streamStoryOutput
 *     description: >
 *       Opens an SSE connection that replays all existing story_output_chunks rows
 *       for the given (runId, storyId), then polls for new rows every 200ms.
 *       Emits base64-encoded output chunks and semantic_step events.
 *       Terminates when the story has a completion WAL event.
 *       Falls back to file-based tailing if no DB chunks exist.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: SSE stream of output chunks
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400: { description: "Invalid runId" }
 */
router.get('/runs/:runId/stories/:storyId/stream', async (req: Request, res: Response) => {
  let hb: ReturnType<typeof setInterval> | undefined;
  try {
  const runId = Number(req.params.runId);
  const storyId = String(req.params.storyId);
  if (!Number.isFinite(runId) || runId <= 0) {
    res.status(400).json({ error: 'Invalid runId' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  hb = setInterval(() => res.write(': hb\n\n'), 15_000);
  let closed = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // Single close handler — clears all intervals on client disconnect
  req.on('close', () => {
    closed = true;
    clearInterval(hb);
    if (pollInterval) clearInterval(pollInterval);
  });

  // Resolve agent type for semantic parsing
  const runRow = await queryOne<{ agent: string; workspace_id: string }>(
    'SELECT agent, workspace_id FROM pipeline_runs WHERE id = $1', [runId]
  );
  const agent = runRow?.agent ?? 'claude';

  // ── Replay phase: send all existing chunks ──
  // (may be empty if StoryLogFollower hasn't written yet — poll loop will pick them up)
  let lastSeq = -1;
  const existingRows = await query<{ chunk: string; sequence: number }>(
    'SELECT chunk, sequence FROM story_output_chunks WHERE run_id = $1 AND story_id = $2 ORDER BY sequence',
    [runId, storyId]
  );
  for (const row of existingRows) {
    if (closed) return;
    const buf = Buffer.from(row.chunk, 'utf8');
    res.write(`event: output\ndata: ${buf.toString('base64')}\n\n`);
    emitSemanticSteps(row.chunk, agent, res);
    lastSeq = row.sequence;
  }

  // Check if story already finished before entering poll loop
  if (await isStoryDone(runId, storyId)) {
    clearInterval(hb);
    if (!closed) {
      res.write('event: done\ndata: \n\n');
      res.end();
    }
    return;
  }

  // ── Live poll phase: 200ms interval ──
  pollInterval = setInterval(async () => {
    if (closed) {
      if (pollInterval) clearInterval(pollInterval);
      return;
    }
    try {
      const newRows = await query<{ chunk: string; sequence: number }>(
        'SELECT chunk, sequence FROM story_output_chunks WHERE run_id = $1 AND story_id = $2 AND sequence > $3 ORDER BY sequence',
        [runId, storyId, lastSeq]
      );
      for (const row of newRows) {
        if (closed) { if (pollInterval) clearInterval(pollInterval); return; }
        const buf = Buffer.from(row.chunk, 'utf8');
        res.write(`event: output\ndata: ${buf.toString('base64')}\n\n`);
        emitSemanticSteps(row.chunk, agent, res);
        lastSeq = row.sequence;
      }

      // Check for story completion
      if (await isStoryDone(runId, storyId)) {
        // Drain any remaining chunks
        const finalRows = await query<{ chunk: string; sequence: number }>(
          'SELECT chunk, sequence FROM story_output_chunks WHERE run_id = $1 AND story_id = $2 AND sequence > $3 ORDER BY sequence',
          [runId, storyId, lastSeq]
        );
        for (const row of finalRows) {
          if (closed) break;
          const buf = Buffer.from(row.chunk, 'utf8');
          res.write(`event: output\ndata: ${buf.toString('base64')}\n\n`);
          emitSemanticSteps(row.chunk, agent, res);
        }
        if (pollInterval) clearInterval(pollInterval);
        clearInterval(hb);
        if (!closed) {
          res.write('event: done\ndata: \n\n');
          res.end();
        }
      }
    } catch {
      // Swallow transient DB errors — next tick retries
    }
  }, 200);
  } catch (err) {
    clearInterval(hb);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream setup failed' });
    } else {
      res.end();
    }
  }
});

/** Check whether a story completion WAL event exists. */
async function isStoryDone(runId: number, storyId: string): Promise<boolean> {
  const row = await queryOne(
    `SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND (payload->>'run_id')::bigint = $2 LIMIT 1`,
    [storyId, runId]
  );
  return !!row;
}

/** Resolve story log file path from WAL event or filesystem scan. Returns path or triggers waiting-mode SSE. */
async function resolveStoryLogPath(runId: number, storyId: string, workspaceId: string | null): Promise<string> {
  // 1. Check story_started WAL event for log_file path
  const walRow = await queryOne<{ payload: Record<string, unknown> | string }>(
    `SELECT payload FROM wal_events WHERE event_type = 'story_started' AND story_id = $1 AND (payload->>'run_id')::bigint = $2 ORDER BY id DESC LIMIT 1`,
    [storyId, runId]
  );
  if (walRow?.payload) {
    try {
      const payload = typeof walRow.payload === 'string' ? JSON.parse(walRow.payload) : walRow.payload;
      if (payload.log_file && fs.existsSync(String(payload.log_file))) {
        return String(payload.log_file);
      }
    } catch { /* ignore */ }
  }

  // 2. Filesystem fallback: scan forge/specs/logs/ and forge/logs/
  if (workspaceId) {
    const workspace = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    if (workspace) {
      const logDirs = [
        path.join(workspace.path, 'forge', 'specs', 'logs'),
        path.join(workspace.path, 'forge', 'logs'),
      ];
      for (const logDir of logDirs) {
        if (fs.existsSync(logDir)) {
          try {
            const files = fs.readdirSync(logDir)
              .filter(f => f.startsWith(`${storyId}_`) && f.endsWith('.log'))
              .sort()
              .reverse();
            if (files.length > 0) {
              return path.join(logDir, files[0]);
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  // 3. No log file found — return a placeholder that startTailing handles gracefully
  return path.join(os.tmpdir(), `rorca-story-${runId}-${storyId}.log`);
}

// ─── GET /api/pipeline/stream — SSE event stream ─────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * @swagger
 * /api/pipeline/stream:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream WAL events (SSE)
 *     operationId: streamPipelineEvents
 *     description: >
 *       Server-Sent Events stream of WAL events (story progress).
 *       Events are pushed in real-time via PostgreSQL LISTEN/NOTIFY through the sse-hub.
 *     parameters:
 *       - in: query
 *         name: runId
 *         schema: { type: string }
 *         description: Filter events for a specific run
 *     responses:
 *       200:
 *         description: SSE stream of WAL events
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/stream', async (_req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial keepalive
  res.write(': keepalive\n\n');

  // Wire up real-time broadcast via sse-hub.
  // Events arrive from the dedicated LISTEN/NOTIFY client (wal-listener.ts)
  // which calls broadcastAll() on every pg notification.
  const unsubscribe = attachSSE(res);

  // Heartbeat every 15s
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  _req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeatInterval);
  });
});

// ─── GET /api/pipeline/runs/:runId/log — Download raw log file ───────────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}/log:
 *   get:
 *     tags: [Pipeline]
 *     summary: Download raw pipeline log file
 *     operationId: downloadPipelineLog
 *     description: Returns the raw log file for a completed pipeline run as a downloadable text/plain attachment.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Raw log file
 *         content:
 *           text/plain:
 *             schema: { type: string }
 *       404: { description: "Log file not found" }
 */
router.get('/runs/:runId/log', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.runId), 10);
  if (isNaN(runId)) {
    throw new ValidationError('Invalid runId');
    return;
  }

  const logPath = await resolveLogPath(runId);
  if (!logPath) {
    throw new NotFoundError('Log file not found for this run');
    return;
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="run-${runId}.log"`);
  const stream = fs.createReadStream(logPath);
  stream.pipe(res);
  stream.on('error', () => {
    res.status(500).json({ error: 'Failed to read log file' });
  });
});

// ─── Log cleanup: delete logs older than 30 days ─────────────────────────────

const LOG_RETENTION_DAYS = 30;

export async function cleanupOldLogs(): Promise<number> {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  // Clean logs referenced in pipeline_runs.log_path
  const rows = await query(`SELECT id, log_path FROM pipeline_runs WHERE log_path IS NOT NULL AND finished_at IS NOT NULL`) as { id: number; log_path: string }[];

  for (const row of rows) {
    try {
      if (fs.existsSync(row.log_path)) {
        const stat = fs.statSync(row.log_path);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(row.log_path);
          deleted++;
        }
      }
    } catch { /* ignore individual file errors */ }
  }

  // Also clean legacy /tmp logs for old runs without log_path
  const legacyRows = await query(`SELECT id FROM pipeline_runs WHERE log_path IS NULL AND finished_at IS NOT NULL`) as { id: number }[];

  for (const row of legacyRows) {
    try {
      const legacy = tmpLogPath(row.id);
      if (fs.existsSync(legacy)) {
        const stat = fs.statSync(legacy);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(legacy);
          deleted++;
        }
      }
    } catch { /* ignore */ }
  }

  if (deleted > 0) {
    logger.info(`[Pipeline] Cleaned up ${deleted} log file(s) older than ${LOG_RETENTION_DAYS} days`);
  }
  return deleted;
}

// ─── GET /api/pipeline/runs/:runId/commits — Git log for run's branch ────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}/commits:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get git commits for a pipeline run's branch
 *     operationId: getPipelineRunCommits
 *     description: Returns the list of git commits made on the pipeline run's feature branch since it diverged from main.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of commits on the run's branch
 *       404: { description: "Run not found" }
 */
router.get('/runs/:runId/commits', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;

    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const gitCwd = run.worktree_path || workspace.path;
    const git = simpleGit(gitCwd);

    // If branch_name is set, get commits on that branch since it diverged from main/master
    // Otherwise get recent commits on whatever branch the workspace is on
    const branchName = run.branch_name;
    let commits: Array<{ sha: string; message: string; date: string; author: string }> = [];

    try {
      if (branchName) {
        // Find the merge-base to only show commits on the feature branch
        let baseRef = 'main';
        try {
          await git.raw(['rev-parse', '--verify', 'main']);
        } catch {
          try {
            await git.raw(['rev-parse', '--verify', 'master']);
            baseRef = 'master';
          } catch {
            // No main/master — just show last 50 commits on the branch
            baseRef = '';
          }
        }

        const range = baseRef ? `${baseRef}..${branchName}` : branchName;
        const log = await git.log({ from: baseRef || undefined, to: branchName, maxCount: 100 });
        commits = log.all.map((c) => ({
          sha: c.hash,
          message: c.message,
          date: c.date,
          author: c.author_name,
        }));
      } else {
        // No branch — show commits since run started
        const log = await git.log({ maxCount: 50, '--after': run.started_at });
        commits = log.all.map((c) => ({
          sha: c.hash,
          message: c.message,
          date: c.date,
          author: c.author_name,
        }));
      }
    } catch (gitErr: any) {
      // Branch may not exist yet or repo issues
      logger.warn(`[Pipeline] Git log error for run ${runId}:`, gitErr.message);
    }

    res.json({ commits, branchName: branchName || null });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get run commits');
  }
});

// ─── SL-004: Skills Usage Per-Run API Endpoint ──────────────────────────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}/skills:
 *   get:
 *     summary: Get per-story skill usage data for a specific pipeline run
 *     tags: [Pipeline]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Skill usage data with per-story breakdown and run-level summary
 *       400:
 *         description: Invalid runId
 *       404:
 *         description: Run not found
 */
router.get('/runs/:runId/skills', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT id, spec_path, workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { id: number; spec_path: string; workspace_id: string } | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    // Get all story results for this run
    const storyRows = await query('SELECT story_id, status, active_skills FROM story_results WHERE run_id = $1 ORDER BY id ASC', [runId]) as Array<{ story_id: string; status: string; active_skills: string | null }>;

    // Try to read spec JSON for suggestedSkills and story titles
    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;

    let specStories: Array<{
      id: string;
      title: string;
      suggestedSkills?: Array<{ name: string; relevance: number; reason: string }>;
    }> = [];

    if (workspace) {
      try {
        const absSpecPath = path.join(workspace.path, run.spec_path);
        const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
        specStories = specJson.userStories || [];
      } catch {
        // Spec file missing/unreadable — titles and relevance will be null
      }
    }

    // Build title and suggestedSkills lookup maps
    const titleMap = new Map<string, string>();
    const skillSuggestionsMap = new Map<string, Array<{ name: string; relevance: number; reason: string }>>();
    for (const s of specStories) {
      titleMap.set(s.id, s.title);
      if (s.suggestedSkills) {
        skillSuggestionsMap.set(s.id, s.suggestedSkills);
      }
    }

    // Get installed skill descriptions
    const installedSkills = await query('SELECT name, description FROM installed_skills') as Array<{ name: string; description: string }>;
    const descriptionMap = new Map<string, string>();
    for (const sk of installedSkills) {
      descriptionMap.set(sk.name, sk.description);
    }

    // Build per-story data
    const skillCounts = new Map<string, { count: number; passCount: number; totalCount: number }>();

    const perStory = storyRows.map((row) => {
      let activeSkillNames: string[] = [];
      if (row.active_skills) {
        try {
          activeSkillNames = JSON.parse(row.active_skills);
        } catch { /* malformed JSON */ }
      }

      const suggestions = skillSuggestionsMap.get(row.story_id) || [];
      const suggestionMap = new Map<string, { relevance: number; reason: string }>();
      for (const s of suggestions) {
        suggestionMap.set(s.name, { relevance: s.relevance, reason: s.reason });
      }

      // If active_skills was never recorded (older runs), fall back to suggestedSkills from spec
      const skillNamesToShow = activeSkillNames.length > 0
        ? activeSkillNames
        : suggestions.map(s => s.name);

      const skills = skillNamesToShow.map((name) => {
        const suggestion = suggestionMap.get(name);
        return {
          name,
          relevance: suggestion?.relevance ?? null,
          reason: suggestion?.reason ?? null,
          description: descriptionMap.get(name) ?? null,
          category: null as string | null,
        };
      });

      // Update frequency counts (use the names actually shown)
      for (const name of skillNamesToShow) {
        const existing = skillCounts.get(name) || { count: 0, passCount: 0, totalCount: 0 };
        existing.count++;
        existing.totalCount++;
        if (row.status === 'pass') existing.passCount++;
        skillCounts.set(name, existing);
      }

      return {
        storyId: row.story_id,
        storyTitle: titleMap.get(row.story_id) || row.story_id,
        storyStatus: row.status,
        skills,
      };
    });

    // Build summary
    const skillFrequency = Array.from(skillCounts.entries())
      .map(([name, data]) => ({
        name,
        count: data.count,
        passRate: data.totalCount > 0 ? data.passCount / data.totalCount : 0,
        category: null as string | null,
      }))
      .sort((a, b) => b.count - a.count);

    const uniqueSkills = skillFrequency.map((s) => s.name);
    const storiesWithSkills = perStory.filter((s) => s.skills.length > 0).length;
    const storiesWithoutSkills = perStory.filter((s) => s.skills.length === 0).length;
    const totalSkillInjections = perStory.reduce((sum, s) => sum + s.skills.length, 0);

    res.json({
      runId,
      perStory,
      summary: {
        totalSkillInjections,
        uniqueSkills,
        skillFrequency,
        storiesWithSkills,
        storiesWithoutSkills,
      },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get run skills');
  }
});

/**
 * @swagger
 * /api/pipeline/runs/{runId}/wal-events:
 *   get:
 *     summary: Get all WAL events for a specific run
 *     tags: [Pipeline]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Array of WAL events ordered by id ASC
 *       400:
 *         description: Invalid runId
 */
router.get('/runs/:runId/wal-events', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
    }

    const events = await query<{
      id: number;
      ts: string;
      event_type: string;
      workspace_id: string | null;
      spec_id: string | null;
      story_id: string | null;
      actor: string;
      payload: string | null;
    }>(
      `SELECT id, ts, event_type, workspace_id, spec_id, story_id, actor, payload
       FROM wal_events
       WHERE (payload->>'run_id')::bigint = $1
       ORDER BY id ASC`,
      [runId]
    );

    res.json({ events });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get run WAL events');
  }
});

// ─── OC-015: Orphan Process Cleanup on Backend Startup ──────────────────────
// Scans pipeline_runs WHERE status='running', kills orphan PIDs (engine + OpenCode server),
// marks runs as failed. Called once at server startup.

export async function cleanupOrphanRuns(): Promise<number> {
  // Guard: if any worker has checked in within the last 90s, it owns lifecycle management — skip entirely
  try {
    const activeWorker = await queryOne<{ worker_id: string }>(
      `SELECT worker_id FROM worker_heartbeat WHERE last_seen > NOW() - INTERVAL '90 seconds' LIMIT 1`
    );
    if (activeWorker) {
      logger.info(`[Cleanup] Active worker detected (${activeWorker.worker_id}), skipping orphan cleanup`);
      return 0;
    }
  } catch {
    // worker_heartbeat table may not exist on first startup — proceed with cleanup
  }

  const staleRuns = await query(`SELECT id, pid, opencode_server_pid, workspace_id, agent_type FROM pipeline_runs WHERE status IN ('running', 'paused')`) as Array<{
    id: number;
    pid: number | null;
    opencode_server_pid: number | null;
    workspace_id: string;
    agent_type: string | null;
  }>;

  if (staleRuns.length === 0) return 0;

  let cleaned = 0;

  for (const run of staleRuns) {
    // Skip runs with an active or queued pg-boss job — includes 'retry' state which was previously missed
    try {
      const pgBossJob = await queryOne<{ id: string }>(
        `SELECT id FROM pgboss.job WHERE name IN ('pipeline:run', 'pipeline:retry') AND data->>'runId' = $1 AND state IN ('created', 'active', 'retry') LIMIT 1`,
        [String(run.id)]
      );
      if (pgBossJob) {
        logger.info(`[Cleanup] Skipping run ${run.id} — active pg-boss job ${pgBossJob.id} found`);
        continue;
      }
    } catch {
      // pgboss schema may not exist yet — treat as no active job, proceed with cleanup
    }

    // Only clean up runs whose PID is no longer alive
    if (run.pid) {
      try {
        process.kill(run.pid, 0); // Throws if process is dead
        // Process is still alive — skip, it may be legitimately running without a worker
        logger.info(`[Cleanup] Skipping run ${run.id} — PID ${run.pid} is still alive`);
        continue;
      } catch {
        // Process is dead — safe to clean up
      }
    }

    // Kill OpenCode server process (if alive)
    if (run.opencode_server_pid) {
      try {
        process.kill(run.opencode_server_pid, 0); // Check alive
        try {
          process.kill(run.opencode_server_pid, 'SIGTERM');
          logger.info(`[Cleanup] Sent SIGTERM to OpenCode server PID ${run.opencode_server_pid} (run ${run.id})`);
        } catch { /* already dead */ }
      } catch {
        // Process already dead — expected
      }
    }

    // Mark run as failed
    await execute(`UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`, [run.id]);

    // Emit WAL event
    try {
      const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('orphan_cleanup', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
        run_id: run.id,
        status: 'failed',
        reason: 'orphan_cleanup',
        error: 'Run was still marked as running after backend restart — process likely crashed.',
        agent_type: run.agent_type ?? 'claude',
      })]);
      broadcastAll(walEvent!);
    } catch {
      // WAL emit failure is non-fatal during startup cleanup
    }

    cleaned++;
    logger.info(`[Cleanup] Run ${run.id} (agent: ${run.agent_type ?? 'claude'}) marked as failed (orphan cleanup)`);
  }

  if (cleaned > 0) {
    logger.info(`[Cleanup] Cleaned up ${cleaned} orphan run(s)`);
  }

  return cleaned;
}

/**
 * @swagger
 * /api/pipeline/queue:
 *   post:
 *     summary: Smart run trigger — start immediately or queue if a run is active
 *     description: >
 *       Checks for an active run in the workspace. If none, triggers the run immediately.
 *       If one is active, queues the run and returns its position. Accepts workspaceId + specId
 *       (filename slug) instead of specPath for convenience.
 *     tags: [Pipeline]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, specId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Rorca workspace ID
 *               specId:
 *                 type: string
 *                 description: Spec slug (filename without .json)
 *     responses:
 *       200:
 *         description: Run started immediately
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queued:
 *                   type: boolean
 *                   example: false
 *                 runId:
 *                   type: number
 *                 message:
 *                   type: string
 *                   example: "Run started immediately"
 *       202:
 *         description: Run queued (active run exists)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queued:
 *                   type: boolean
 *                   example: true
 *                 queuePosition:
 *                   type: number
 *                 activeRunId:
 *                   type: number
 *                 message:
 *                   type: string
 *                   example: "Run queued, position 2"
 *       404:
 *         description: Workspace or spec not found
 */
router.post('/queue', async (req: Request, res: Response) => {
  try {
    const { workspaceId, specId } = req.body as { workspaceId?: string; specId?: string };

    if (!workspaceId || !specId) {
      throw new ValidationError('workspaceId and specId are required');
      return;
    }

    // Validate workspace exists
    const workspace = await queryOne('SELECT id FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Validate spec file exists
    const workspaceRow = await queryOne('SELECT path FROM workspaces WHERE id = $1', [workspaceId]) as
      { path: string } | undefined;
    const specPath = `forge/specs/approved/${specId}.json`;
    const absSpecPath = path.join(workspaceRow!.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      throw new NotFoundError(`Spec not found at ${specPath}`);
      return;
    }

    // Check for active run
    const activeRun = await queryOne(
      `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused') LIMIT 1`,
      [workspaceId]
    ) as { id: number } | undefined;

    if (!activeRun) {
      // No active run — trigger immediately
      const triggerRes = await fetch(`http://localhost:${process.env.PORT || 3030}/api/pipeline/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, specPath }),
      });
      const triggerData = await triggerRes.json() as Record<string, unknown>;
      if (!triggerRes.ok) {
        res.status(triggerRes.status).json(triggerData);
        return;
      }
      res.json({
        queued: false,
        runId: triggerData.runId,
        message: 'Run started immediately',
      });
      return;
    }

    // Active run exists — queue it
    const triggerRes = await fetch(`http://localhost:${process.env.PORT || 3030}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, specPath, queue: true }),
    });
    const triggerData = await triggerRes.json() as Record<string, unknown>;
    if (!triggerRes.ok) {
      res.status(triggerRes.status).json(triggerData);
      return;
    }
    const queuePosition = (triggerData.position as number) ?? 1;
    res.status(202).json({
      queued: true,
      queuePosition,
      activeRunId: activeRun.id,
      message: `Run queued, position ${queuePosition}`,
    });
  } catch (err) {
    handleRouteError(res, err, '[Pipeline] Queue run');
  }
});

// ─── GET /api/pipeline/runs/:id/dlq — Check if run's job is in DLQ ──────────

/**
 * @swagger
 * /api/pipeline/runs/{id}/dlq:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get DLQ entry for a run
 *     operationId: getRunDlq
 *     description: >
 *       Returns the dead-letter-queue entry for a pipeline run's job if it
 *       exhausted all pg-boss retries. Returns 404 if the run's job is not in
 *       the DLQ. Wraps pgboss.archive queries in try/catch — returns 404 on
 *       fresh installs where pgboss.archive may not yet exist.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: DLQ entry
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string }
 *                 lastError: { type: string, nullable: true }
 *                 attempts: { type: integer }
 *                 failedAt: { type: string, format: date-time }
 *                 originalPayload: { type: object }
 *       404:
 *         description: Run not in DLQ
 */
router.get('/runs/:id/dlq', async (req: Request, res: Response) => {
  const runId = parseInt(req.params.id as string, 10);
  if (isNaN(runId)) {
    throw new ValidationError('Invalid run ID');
    return;
  }

  try {
    // Query pgboss.archive for any pipeline job tied to this runId.
    // Guard: pgboss.archive may not exist on fresh install — catch and return 404.
    const row = await queryOne<{
      id: string;
      output: unknown;
      retrycount: number;
      archivedon: string;
      data: unknown;
    }>(
      `SELECT id, output, retrycount, archivedon, data
       FROM pgboss.archive
       WHERE name IN ('pipeline:run', 'pipeline:retry')
         AND state = 'failed'
         AND data->>'runId' = $1
       ORDER BY archivedon DESC
       LIMIT 1`,
      [String(runId)],
    ).catch(() => undefined);

    if (!row) {
      res.status(404).json({ error: 'Run not in DLQ' });
      return;
    }

    const lastError = typeof row.output === 'string'
      ? row.output
      : (row.output != null ? JSON.stringify(row.output) : null);

    res.json({
      jobId: row.id,
      lastError,
      attempts: row.retrycount ?? 0,
      failedAt: row.archivedon,
      originalPayload: row.data,
    });
  } catch (err) {
    handleRouteError(res, err, '[Pipeline] DLQ lookup');
  }
});

// ─── POST /api/pipeline/runs/:id/dlq/retry — Retry a DLQ run ─────────────────

/**
 * @swagger
 * /api/pipeline/runs/{id}/dlq/retry:
 *   post:
 *     tags: [Pipeline]
 *     summary: Retry a run from the DLQ
 *     operationId: retryRunFromDlq
 *     description: >
 *       Creates a new pipeline_runs row (retried_from_run_id = originalId)
 *       and sends a fresh pg-boss pipeline:run job. The original run remains
 *       in 'failed' status — this creates a new linked run.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       201:
 *         description: New retry run created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 runId: { type: integer }
 *                 originalRunId: { type: integer }
 *                 jobId: { type: string }
 *       404:
 *         description: Original run not found
 *       409:
 *         description: Run not in failed state
 */
router.post('/runs/:id/dlq/retry', async (req: Request, res: Response) => {
  const originalRunId = parseInt(req.params.id as string, 10);
  if (isNaN(originalRunId)) {
    throw new ValidationError('Invalid run ID');
    return;
  }

  try {
    // Fetch original run
    const originalRun = await queryOne<{
      id: number;
      spec_path: string;
      workspace_id: string;
      status: string;
      agent: string;
      agent_type: string;
      agent_model: string | null;
      branch_name: string | null;
      worktree_path: string | null;
    }>(
      `SELECT id, spec_path, workspace_id, status, agent, agent_type, agent_model, branch_name, worktree_path
       FROM pipeline_runs WHERE id = $1`,
      [originalRunId],
    );

    if (!originalRun) {
      throw new NotFoundError('Run not found');
      return;
    }

    if (originalRun.status !== 'failed') {
      throw new ConflictError(`Run is in '${originalRun.status}' state — only 'failed' runs can be retried from DLQ`);
      return;
    }

    // Fetch workspace path
    const workspace = await queryOne<{ path: string }>(
      `SELECT path FROM workspaces WHERE id = $1`,
      [originalRun.workspace_id],
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Create new pipeline_run linked to original
    const newRunRow = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, trigger_type, retried_from_run_id, agent, agent_type, agent_model, queued_at)
       VALUES ($1, $2, 'queued', 'dlq-retry', $3, $4, $5, $6, NOW())
       RETURNING id`,
      [
        originalRun.spec_path,
        originalRun.workspace_id,
        originalRunId,
        originalRun.agent,
        originalRun.agent_type,
        originalRun.agent_model,
      ],
    );
    if (!newRunRow) throw new Error('Failed to create new run row');
    const newRunId = newRunRow.id;

    // Build the job payload (mirrors pipeline:trigger payload shape)
    const jobPayload = {
      runId: newRunId,
      specPath: originalRun.spec_path,
      workspacePath: workspace.path,
      agent: (originalRun.agent_type ?? originalRun.agent ?? 'claude') as 'claude' | 'opencode' | 'codex',
      model: originalRun.agent_model ?? null,
      worktreePath: originalRun.worktree_path ?? null,
      branchName: originalRun.branch_name ?? null,
      autoWorktree: false,
      autoMerge: false,
      envOverrides: {},
    };

    await getBoss().send('pipeline:run', jobPayload, {
      retryLimit: 0,
      expireInSeconds: 300, // Task-Monitor: job spawns engine and returns immediately
    });

    // Emit WAL event
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, run_id, payload) VALUES ($1, $2, $3, $4)`,
      [
        'run_started',
        originalRun.workspace_id,
        newRunId,
        JSON.stringify({ runId: newRunId, originalRunId, trigger: 'dlq-retry', specPath: originalRun.spec_path }),
      ],
    ).catch(() => {
      // wal_events may not have run_id column on older migrations — fall back to without it
      return execute(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3)`,
        [
          'run_started',
          originalRun.workspace_id,
          JSON.stringify({ runId: newRunId, originalRunId, trigger: 'dlq-retry', specPath: originalRun.spec_path }),
        ],
      );
    });

    res.status(201).json({ ok: true, runId: newRunId, originalRunId });
  } catch (err) {
    handleRouteError(res, err, '[Pipeline] DLQ retry');
  }
});

// NOTE: /queue/:workspaceId moved AFTER static /queue/* routes to prevent Express param matching.
// See below export default router.

// ─── GET /api/pipeline/worker/health — Worker health check ───────────────────
// Queries Postgres directly — no IPC with the worker process.
// Accessible without authentication (health checks must be unauthenticated).

/**
 * @swagger
 * /api/pipeline/worker/health:
 *   get:
 *     tags: [Pipeline]
 *     summary: Worker process health check
 *     operationId: getWorkerHealth
 *     description: >
 *       Returns the health status of the standalone pg-boss worker process by
 *       querying the worker_heartbeat table and pgboss.* tables directly.
 *       No IPC with the worker is required. The worker is considered active when
 *       its last_seen timestamp is within the past 60 seconds.
 *     responses:
 *       200:
 *         description: Worker health object with queue statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workerActive: { type: boolean }
 *                 workerPid: { type: integer, nullable: true }
 *                 workerStartedAt: { type: string, nullable: true, format: date-time }
 *                 activeChildProcesses: { type: integer, description: "Number of active execution-engine child processes (from latest heartbeat)" }
 *                 queueMaxConcurrent: { type: integer, description: "Max concurrent queued (non-worktree) pipeline:run jobs" }
 *                 runNowMaxConcurrent: { type: integer, description: "Max concurrent immediate worktree-isolated runs" }
 *                 lastReconciliationErrors: { type: integer, description: "Number of state mismatches fixed in last reconcile cycle (last 90s)" }
 *                 activeJobs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       runId: { type: integer }
 *                       specId: { type: string }
 *                       startedAt: { type: string, format: date-time }
 *                       elapsedMs: { type: integer }
 *                 queueDepth: { type: integer }
 *                 scheduledJobs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       scheduleId: { type: string }
 *                       cronExpr: { type: string }
 *                       nextFireAt: { type: string, nullable: true, format: date-time }
 *                 dlqDepth: { type: integer }
 *                 pgBossVersion: { type: string }
 *                 queueHealth: { type: string, enum: ["healthy", "degraded", "critical"], description: "Health classification based on queue stats" }
 *                 queueStats:
 *                   type: object
 *                   properties:
 *                     pending: { type: integer, description: "Number of jobs waiting to be picked up" }
 *                     active: { type: integer, description: "Number of jobs currently being processed" }
 *                     failed: { type: integer, description: "Number of jobs in failed state (not yet archived)" }
 *                     completed24h: { type: integer, description: "Number of jobs completed in the last 24 hours" }
 *                     failedInLast24h: { type: integer, description: "Number of jobs failed in the last 24 hours" }
 *                     failedInLast7d: { type: integer, description: "Number of jobs failed in the last 7 days" }
 *                     archiveSize: { type: integer, description: "Total number of archived jobs" }
 *                     oldestPendingAgeSeconds: { type: integer, nullable: true, description: "Age in seconds of the oldest pending job (null if no pending jobs)" }
 *                     pickupLatency:
 *                       type: object
 *                       nullable: true
 *                       description: "Job pickup latency metrics over a 24-hour rolling window (pipeline:run + pipeline:retry only)"
 *                       properties:
 *                         avgSeconds: { type: number, nullable: true }
 *                         p50Seconds: { type: number, nullable: true }
 *                         p95Seconds: { type: number, nullable: true }
 *                         maxSeconds: { type: number, nullable: true }
 *                         sampleCount: { type: integer }
 *                         windowHours: { type: integer }
 *                         status: { type: string, enum: ["healthy", "degraded", "critical"] }
 *                     queues:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           pending: { type: integer }
 *                           active: { type: integer }
 *                           failed: { type: integer }
 */
router.get('/worker/health', async (req: Request, res: Response) => {
  try {
    // ── 1. Worker heartbeat ─────────────────────────────────────────────────
    const heartbeat = await queryOne<{
      pid: number;
      started_at: string;
      last_seen: string;
      active_jobs: number;
    }>('SELECT pid, started_at, last_seen, active_jobs FROM worker_heartbeat ORDER BY last_seen DESC LIMIT 1');

    const workerActive = heartbeat
      ? Date.now() - new Date(heartbeat.last_seen).getTime() < 60_000
      : false;

    // ── 2. Active jobs (pgboss.job joined with pipeline_runs) ───────────────
    interface ActiveJobRow {
      run_id: string;
      spec_path: string | null;
      started_at: string;
    }
    const activeJobRows = await query<ActiveJobRow>(
      `SELECT (j.data->>'runId') AS run_id,
              pr.spec_path,
              j.created_on::text AS started_at
       FROM   pgboss.job j
       LEFT   JOIN pipeline_runs pr ON pr.id = (j.data->>'runId')::bigint
       WHERE  j.name = 'pipeline:run'
         AND  j.state = 'active'`,
    ).catch(() => [] as ActiveJobRow[]);

    const activeJobs = activeJobRows.map(row => ({
      runId: parseInt(row.run_id, 10),
      specId: row.spec_path ? row.spec_path.replace(/^.*\//, '').replace(/\.json$/, '') : null,
      startedAt: row.started_at,
      elapsedMs: Date.now() - new Date(row.started_at).getTime(),
    }));

    // ── 3. Queue depth (pending pipeline:run jobs) ──────────────────────────
    const queueDepthRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pgboss.job WHERE name = 'pipeline:run' AND state = 'created'`,
    ).catch(() => ({ cnt: '0' }));
    const queueDepth = parseInt(queueDepthRow?.cnt ?? '0', 10);

    // ── 4. Scheduled jobs ───────────────────────────────────────────────────
    interface ScheduleRow {
      name: string;
      cron: string;
      timezone: string | null;
    }
    const scheduleRows = await query<ScheduleRow>(
      `SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name`,
    ).catch(() => [] as ScheduleRow[]);

    const scheduledJobs = scheduleRows.map(r => ({
      scheduleId: r.name,
      cronExpr: r.cron,
      nextFireAt: null as string | null, // pgboss doesn't surface next-fire directly
    }));

    // ── 5. DLQ depth (failed archived jobs) ────────────────────────────────
    const dlqRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pgboss.archive WHERE state = 'failed'`,
    ).catch(() => ({ cnt: '0' }));
    const dlqDepth = parseInt(dlqRow?.cnt ?? '0', 10);

    // ── 6. pg-boss schema version ───────────────────────────────────────────
    const versionRow = await queryOne<{ version: string }>(
      `SELECT version FROM pgboss.version LIMIT 1`,
    ).catch(() => undefined);
    const pgBossVersion = versionRow?.version ?? 'unknown';

    // ── 7. Last reconciliation errors (WAL events from last reconcile cycle) ─
    // Count run_finished events with reason='state_reconciliation' or
    // reason='worker_crash_recovery' emitted in the past 90s (covers one full
    // reconcile interval + one heartbeat interval).
    const reconRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM wal_events
       WHERE event_type = 'run_finished'
         AND payload->>'reason' IN ('state_reconciliation', 'worker_crash_recovery')
         AND ts > NOW() - INTERVAL '90 seconds'`,
    ).catch(() => ({ cnt: '0' }));
    const lastReconciliationErrors = parseInt(reconRow?.cnt ?? '0', 10);

    // ── 8. Queue statistics (run in parallel) ─────────────────────────────────
    interface CountRow {
      cnt: string;
    }
    interface AgeRow {
      age_seconds: number | null;
    }
    interface QueueRow {
      name: string;
      pending: string;
      active: string;
      failed: string;
    }
    interface LatencyRow {
      avg_pickup_seconds: number | null;
      p50_pickup_seconds: number | null;
      p95_pickup_seconds: number | null;
      min_pickup_seconds: number | null;
      max_pickup_seconds: number | null;
      sample_count: string;
    }

    const [
      pendingRow,
      activeRow,
      failedRow,
      completed24hRow,
      failedLast24hRow,
      failedLast7dRow,
      archiveSizeRow,
      oldestAgeRow,
      queueRows,
      latencyRow,
    ] = await Promise.all([
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.job WHERE state = $1', ['created']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.job WHERE state = $1', ['active']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.job WHERE state = $1', ['failed']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.archive WHERE state = $1 AND archived_on > NOW() - INTERVAL \'24 hours\'', ['completed']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.archive WHERE state = $1 AND archived_on > NOW() - INTERVAL \'24 hours\'', ['failed']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.archive WHERE state = $1 AND archived_on > NOW() - INTERVAL \'7 days\'', ['failed']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.archive').catch(() => ({ cnt: '0' })),
      queryOne<AgeRow>('SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_on)))::integer AS age_seconds FROM pgboss.job WHERE state = $1', ['created']).catch(() => ({ age_seconds: null })),
      query<QueueRow>(
        `SELECT name,
                COUNT(*) FILTER (WHERE state = 'created')::text AS pending,
                COUNT(*) FILTER (WHERE state = 'active')::text AS active,
                COUNT(*) FILTER (WHERE state = 'failed')::text AS failed
         FROM pgboss.job
         GROUP BY name
         ORDER BY name`,
      ).catch(() => [] as QueueRow[]),
      queryOne<LatencyRow>(
        `SELECT
           AVG(EXTRACT(EPOCH FROM (started_on - created_on)))                                                             AS avg_pickup_seconds,
           PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_on - created_on)))                   AS p50_pickup_seconds,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_on - created_on)))                   AS p95_pickup_seconds,
           MIN(EXTRACT(EPOCH FROM (started_on - created_on)))                                                             AS min_pickup_seconds,
           MAX(EXTRACT(EPOCH FROM (started_on - created_on)))                                                             AS max_pickup_seconds,
           COUNT(*)::text                                                                                                  AS sample_count
         FROM pgboss.archive
         WHERE started_on IS NOT NULL
           AND created_on IS NOT NULL
           AND archived_on > NOW() - INTERVAL '24 hours'
           AND name IN ('pipeline:run', 'pipeline:retry')`,
      ).catch(() => null),
    ]);

    const pending = parseInt(pendingRow?.cnt ?? '0', 10);
    const active = parseInt(activeRow?.cnt ?? '0', 10);
    const failed = parseInt(failedRow?.cnt ?? '0', 10);
    const completed24h = parseInt(completed24hRow?.cnt ?? '0', 10);
    const failedInLast24h = parseInt(failedLast24hRow?.cnt ?? '0', 10);
    const failedInLast7d = parseInt(failedLast7dRow?.cnt ?? '0', 10);
    const archiveSize = parseInt(archiveSizeRow?.cnt ?? '0', 10);
    const oldestPendingAgeSeconds = oldestAgeRow?.age_seconds ?? null;

    // ── Pickup latency classification ──────────────────────────────────────────
    const latencySampleCount = parseInt(latencyRow?.sample_count ?? '0', 10);
    const latencyP95 = latencyRow?.p95_pickup_seconds ?? null;
    let latencyStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (latencyP95 === null) {
      // No completed pipeline jobs in the last 24 hours.
      // Mark critical only when jobs are stuck in pending (never started).
      latencyStatus = pending > 0 ? 'critical' : 'healthy';
    } else if (latencyP95 > 10) {
      latencyStatus = 'critical';
    } else if (latencyP95 > 2) {
      latencyStatus = 'degraded';
    }

    const pickupLatency = {
      avgSeconds: latencyRow?.avg_pickup_seconds ?? null,
      p50Seconds: latencyRow?.p50_pickup_seconds ?? null,
      p95Seconds: latencyP95,
      maxSeconds: latencyRow?.max_pickup_seconds ?? null,
      sampleCount: latencySampleCount,
      windowHours: 24,
      status: latencyStatus,
    };

    // Convert per-queue breakdown to typed object
    const queues = queueRows.map(r => ({
      name: r.name,
      pending: parseInt(r.pending ?? '0', 10),
      active: parseInt(r.active ?? '0', 10),
      failed: parseInt(r.failed ?? '0', 10),
    }));

    // Determine queue health
    let queueHealth: 'critical' | 'degraded' | 'healthy' = 'healthy';
    if (failed > 0 || failedInLast24h > 5) {
      queueHealth = 'critical';
    } else if (failedInLast24h > 0 || (oldestPendingAgeSeconds !== null && oldestPendingAgeSeconds > 300)) {
      queueHealth = 'degraded';
    }


    // ── Concurrency settings from worker_settings ──────────────────────────
    const concurrencyRows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM worker_settings WHERE key IN ('queue_max_concurrent', 'run_now_max_concurrent')`,
    ).catch(() => [] as { key: string; value: string }[]);
    const concurrencyMap = Object.fromEntries(concurrencyRows.map(r => [r.key, r.value]));
    const queueMaxConcurrent = concurrencyMap['queue_max_concurrent'] ? parseInt(concurrencyMap['queue_max_concurrent'], 10) : 1;
    const runNowMaxConcurrent = concurrencyMap['run_now_max_concurrent'] ? parseInt(concurrencyMap['run_now_max_concurrent'], 10) : 3;

    // ── Per-workspace queue depths ─────────────────────────────────────────────
    const MAX_QUEUE_DEPTH = 10;
    interface WorkspaceQueueRow {
      workspace_id: string;
      queued_count: string;
      active_count: string;
    }
    const workspaceQueueRows = await query<WorkspaceQueueRow>(
      `SELECT workspace_id,
              COUNT(*) FILTER (WHERE status = 'queued')::text AS queued_count,
              COUNT(*) FILTER (WHERE status IN ('running', 'paused'))::text AS active_count
       FROM pipeline_runs
       WHERE status IN ('queued', 'running', 'paused')
       GROUP BY workspace_id`,
    ).catch(() => [] as WorkspaceQueueRow[]);

    const workspaceQueueDepths = workspaceQueueRows.map(r => ({
      workspaceId: r.workspace_id,
      queuedCount: parseInt(r.queued_count, 10),
      activeCount: parseInt(r.active_count, 10),
      maxQueueDepth: MAX_QUEUE_DEPTH,
    }));

    res.json({
      workerActive,
      workerPid: heartbeat?.pid ?? null,
      workerStartedAt: heartbeat?.started_at ?? null,
      activeChildProcesses: heartbeat?.active_jobs ?? 0,
      queueMaxConcurrent,
      runNowMaxConcurrent,
      activeJobs,
      queueDepth,
      scheduledJobs,
      dlqDepth,
      pgBossVersion,
      lastReconciliationErrors,
      queueHealth,
      workspaceQueueDepths,
      queueStats: {
        pending,
        active,
        failed,
        completed24h,
        failedInLast24h,
        failedInLast7d,
        archiveSize,
        oldestPendingAgeSeconds,
        pickupLatency,
        queues,
      },
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Worker health check');
  }
});

/**
 * @swagger
 * /api/pipeline/orphan-sweep:
 *   post:
 *     summary: Trigger immediate orphan process sweep
 *     description: Scans for pipeline runs with status='running' that belong to other workers or have no worker_id (orphaned), kills their processes, and marks runs as failed. Callable from API process (currentWorkerId is undefined, sweeps ALL stale runs).
 *     tags:
 *       - Pipeline
 *     responses:
 *       200:
 *         description: Orphan sweep completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 swept:
 *                   type: array
 *                   description: Array of swept orphan runs
 *                   items:
 *                     type: object
 *                     properties:
 *                       runId:
 *                         type: number
 *                         description: Pipeline run ID
 *                       pid:
 *                         type: number
 *                         description: Process ID that was swept (or 0 if no PID)
 *                       killed:
 *                         type: boolean
 *                         description: Whether the process was successfully terminated
 *                     required: [runId, pid, killed]
 *                 count:
 *                   type: number
 *                   description: Total number of orphan runs swept
 *               required: [swept, count]
 *       500:
 *         description: Sweep operation failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Error message
 *               required: [error]
 */
router.post('/orphan-sweep', async (req: Request, res: Response) => {
  try {
    const results = await sweepOrphanProcesses();

    res.json({
      swept: results,
      count: results.length,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Orphan sweep');
  }
});

/**
 * @swagger
 * /api/pipeline/queue/failed-jobs:
 *   get:
 *     summary: List failed pg-boss jobs
 *     description: Returns a paginated list of failed pg-boss jobs from both pgboss.job (recent unarchived failures) and pgboss.archive (archived failures within the last 30 days). Each entry is enriched with the corresponding pipeline_runs row where the job's data.runId matches.
 *     tags:
 *       - Pipeline
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number (1-indexed)
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Paginated list of failed jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       jobId:
 *                         type: string
 *                         description: pg-boss job UUID
 *                       queueName:
 *                         type: string
 *                         description: Queue name (e.g. pipeline:run)
 *                       state:
 *                         type: string
 *                         description: Job state (always "failed")
 *                       failedAt:
 *                         type: string
 *                         format: date-time
 *                         description: Timestamp when the job failed (completed_on)
 *                       retryCount:
 *                         type: integer
 *                         description: Number of retries consumed
 *                       retryLimit:
 *                         type: integer
 *                         description: Maximum retries configured
 *                       errorOutput:
 *                         type: object
 *                         description: Error details from the last attempt (API keys redacted)
 *                         properties:
 *                           message:
 *                             type: string
 *                           stack:
 *                             type: string
 *                       data:
 *                         type: object
 *                         description: Original job payload
 *                       runId:
 *                         type: integer
 *                         nullable: true
 *                         description: Linked pipeline_runs.id (null if not a pipeline:run job)
 *                       runStatus:
 *                         type: string
 *                         nullable: true
 *                         description: pipeline_runs.status for the linked run
 *                       specPath:
 *                         type: string
 *                         nullable: true
 *                         description: pipeline_runs.spec_path for the linked run
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 pageSize:
 *                   type: integer
 *               required: [items, total, page, pageSize]
 *       500:
 *         description: Internal server error
 */
router.get('/queue/failed-jobs', async (req: Request, res: Response) => {
  try {
    const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize ?? '20'), 10) || 20, 1), 100);
    const offset = (page - 1) * pageSize;

    // UNION of unarchived failed jobs + archived failed jobs (last 30 days)
    const unionSql = `
      SELECT id, name, data, state, retry_count, retry_limit, output, completed_on, 'job' AS source
      FROM pgboss.job
      WHERE state = 'failed'
      UNION ALL
      SELECT id, name, data, state, retry_count, retry_limit, output, completed_on, 'archive' AS source
      FROM pgboss.archive
      WHERE state = 'failed'
        AND archived_on > NOW() - INTERVAL '30 days'
    `;

    interface FailedJobRow {
      id: string;
      name: string;
      data: Record<string, unknown> | null;
      state: string;
      retry_count: number | null;
      retry_limit: number | null;
      output: Record<string, unknown> | null;
      completed_on: string | null;
      source: string;
      run_id: number | null;
      run_status: string | null;
      spec_path: string | null;
    }

    interface FailedJobCountRow { total: string }

    const [countRow, rows] = await Promise.all([
      queryOne<FailedJobCountRow>(
        `SELECT COUNT(*)::text AS total FROM (${unionSql}) AS combined`,
        [],
      ).catch(() => ({ total: '0' })),
      query<FailedJobRow>(
        `SELECT j.id, j.name, j.data, j.state, j.retry_count, j.retry_limit, j.output, j.completed_on, j.source,
                pr.id AS run_id, pr.status AS run_status, pr.spec_path
         FROM (${unionSql}) AS j
         LEFT JOIN pipeline_runs pr ON pr.id = (j.data->>'runId')::INT
         ORDER BY j.completed_on DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      ).catch(() => [] as FailedJobRow[]),
    ]);

    const total = parseInt(countRow?.total ?? '0', 10);

    // Scrub API keys from error output
    const scrubSecrets = (text: string): string =>
      text
        .replace(/(sk-ant-[a-zA-Z0-9-]{10,})/g, '[REDACTED]')
        .replace(/(sk-or-[a-zA-Z0-9-]{10,})/g, '[REDACTED]')
        .replace(/(sk-[a-zA-Z0-9]{10,})/g, '[REDACTED]');

    const items = rows.map(row => {
      const rawOutput = row.output as Record<string, unknown> | null;
      const errorOutput = rawOutput
        ? {
            message: typeof rawOutput.message === 'string' ? scrubSecrets(rawOutput.message) : undefined,
            stack: typeof rawOutput.stack === 'string' ? scrubSecrets(rawOutput.stack) : undefined,
            ...Object.fromEntries(
              Object.entries(rawOutput)
                .filter(([k]) => k !== 'message' && k !== 'stack')
                .map(([k, v]) => [k, typeof v === 'string' ? scrubSecrets(v) : v]),
            ),
          }
        : null;

      return {
        jobId: row.id,
        queueName: row.name,
        state: row.state,
        failedAt: row.completed_on ?? null,
        retryCount: row.retry_count ?? 0,
        retryLimit: row.retry_limit ?? 0,
        errorOutput,
        data: row.data ?? {},
        runId: row.run_id ?? null,
        runStatus: row.run_status ?? null,
        specPath: row.spec_path ?? null,
      };
    });

    res.json({ items, total, page, pageSize });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Failed jobs list');
  }
});

/**
 * @swagger
 * /api/pipeline/queue/failed-jobs/{jobId}/retry:
 *   post:
 *     summary: Re-enqueue a failed pg-boss job
 *     description: Reads the failed job from pgboss.archive or pgboss.job by its UUID, extracts the original queue name and payload, and re-inserts it as a fresh job via boss.send(). Used by operators to manually retry a failed job after fixing the underlying issue.
 *     tags:
 *       - Pipeline
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: pg-boss job UUID
 *     responses:
 *       200:
 *         description: Job successfully re-enqueued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 newJobId:
 *                   type: string
 *                   description: UUID of the newly created job
 *                 message:
 *                   type: string
 *                   example: Job requeued
 *               required: [newJobId, message]
 *       404:
 *         description: Job not found in pgboss.job or pgboss.archive
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *               required: [error]
 *       500:
 *         description: Internal server error
 */
router.post('/queue/failed-jobs/:jobId/retry', async (req: Request, res: Response) => {
  const { jobId } = req.params;

  try {
    interface JobLookupRow {
      id: string;
      name: string;
      data: Record<string, unknown> | null;
    }

    // Look up in pgboss.job first (very recent failures), then pgboss.archive
    const job = await queryOne<JobLookupRow>(
      `SELECT id, name, data FROM pgboss.job WHERE id = $1 AND state = 'failed'
       UNION ALL
       SELECT id, name, data FROM pgboss.archive WHERE id = $1 AND state = 'failed'
       LIMIT 1`,
      [jobId],
    );

    if (!job) {
      throw new NotFoundError(`Failed job ${jobId} not found`);
    }

    const boss = getBoss();
    const newJobId = await boss.send(job.name, job.data ?? {});

    if (!newJobId) {
      return res.status(500).json({ error: 'boss.send() returned null — queue may not exist or boss is not running' });
    }

    logger.info({ jobId, newJobId, queueName: job.name }, '[Pipeline] failed job re-enqueued');
    res.json({ newJobId, message: 'Job requeued' });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Failed job retry');
  }
});

// ─── GET /api/pipeline/queue/health-history — Time-series queue health snapshots ──

/**
 * @swagger
 * /api/pipeline/queue/health-history:
 *   get:
 *     tags: [Pipeline]
 *     summary: Queue health time-series data
 *     operationId: getQueueHealthHistory
 *     description: >
 *       Returns time-series snapshots from queue_health_snapshots, captured every
 *       60 seconds by the worker's monitor-states listener. Use for trend charts,
 *       alerting analysis, and queue observability dashboards.
 *     parameters:
 *       - in: query
 *         name: hours
 *         schema:
 *           type: integer
 *           enum: [1, 6, 24, 168]
 *           default: 24
 *         description: Time window in hours (1=1h, 6=6h, 24=24h, 168=1w)
 *     responses:
 *       200:
 *         description: Time-series health snapshots
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 snapshots:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       capturedAt: { type: string, format: date-time }
 *                       pending: { type: integer }
 *                       active: { type: integer }
 *                       failed: { type: integer }
 *                       completed: { type: integer }
 *                       oldestPendingSeconds: { type: integer, nullable: true }
 *                       workerId: { type: string, nullable: true }
 *                 interval:
 *                   type: string
 *                   description: Suggested chart bucket interval
 *                 totalSnapshots: { type: integer }
 *                 windowHours: { type: integer }
 */
router.get('/queue/health-history', async (req: Request, res: Response) => {
  try {
    const rawHours = parseInt(String(req.query.hours ?? '24'), 10);
    const allowedHours = [1, 6, 24, 168];
    const hours = allowedHours.includes(rawHours) ? rawHours : 24;

    // Suggest a chart bucket interval based on window size
    let interval: string;
    if (hours <= 1) {
      interval = '5m';
    } else if (hours <= 6) {
      interval = '15m';
    } else if (hours <= 24) {
      interval = '1h';
    } else {
      interval = '6h';
    }

    interface SnapshotRow {
      captured_at: string;
      total_pending: number;
      total_active: number;
      total_failed: number;
      total_completed: number;
      oldest_pending_seconds: number | null;
      worker_id: string | null;
    }

    const rows = await query<SnapshotRow>(
      `SELECT captured_at, total_pending, total_active, total_failed, total_completed,
              oldest_pending_seconds, worker_id
       FROM queue_health_snapshots
       WHERE captured_at > NOW() - ($1 || ' hours')::interval
       ORDER BY captured_at ASC`,
      [hours],
    );

    const snapshots = rows.map(r => ({
      capturedAt: r.captured_at,
      pending: r.total_pending,
      active: r.total_active,
      failed: r.total_failed,
      completed: r.total_completed,
      oldestPendingSeconds: r.oldest_pending_seconds,
      workerId: r.worker_id,
    }));

    res.json({
      snapshots,
      interval,
      totalSnapshots: snapshots.length,
      windowHours: hours,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Queue health history');
  }
});
// ─── GET /api/pipeline/queue/:workspaceId — Workspace queue state ─────────────
// IMPORTANT: Must be AFTER all static /queue/* routes (failed-jobs, health-history)
// to prevent Express matching "failed-jobs" as :workspaceId param.

/**
 * @swagger
 * /api/pipeline/queue/{workspaceId}:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get queue state for a workspace
 *     operationId: getWorkspaceQueueState
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Queue state
 */
router.get('/queue/:workspaceId', async (req: Request, res: Response) => {
  try {
    const { workspaceId } = req.params;

    const MAX_QUEUE_DEPTH = 10;

    // Fetch concurrency settings
    const concurrencyRows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM worker_settings WHERE key IN ('queue_max_concurrent', 'run_now_max_concurrent')`,
    ).catch(() => [] as { key: string; value: string }[]);
    const settingsMap = Object.fromEntries(concurrencyRows.map(r => [r.key, r.value]));
    const queueMaxConcurrent = settingsMap['queue_max_concurrent'] ? parseInt(settingsMap['queue_max_concurrent'], 10) : 1;
    const runNowMaxConcurrent = settingsMap['run_now_max_concurrent'] ? parseInt(settingsMap['run_now_max_concurrent'], 10) : 3;

    // Active runs for this workspace
    const activeRuns = await query<{ id: number; spec_path: string; status: string; started_at: string; triggered_via: string; branch_name: string | null; worktree_path: string | null; agent_type: string }>(
      `SELECT id, spec_path, status, started_at, triggered_via, branch_name, worktree_path, agent_type
       FROM pipeline_runs
       WHERE workspace_id = $1 AND status IN ('running', 'paused')
       ORDER BY started_at ASC`,
      [workspaceId],
    );

    // Queued runs for this workspace
    const queuedRuns = await query<{ id: number; spec_path: string; status: string; queued_at: string; queue_position: number; triggered_via: string; auto_worktree: boolean }>(
      `SELECT id, spec_path, status, queued_at, queue_position, triggered_via, auto_worktree
       FROM pipeline_runs
       WHERE workspace_id = $1 AND status = 'queued'
       ORDER BY queue_position ASC, queued_at ASC`,
      [workspaceId],
    );

    res.json({
      active: activeRuns,
      queued: queuedRuns,
      queueDepth: queuedRuns.length,
      maxQueueDepth: MAX_QUEUE_DEPTH,
      queueMaxConcurrent,
      runNowMaxConcurrent,
    });
  } catch (err) {
    logger.error({ err }, '[Pipeline] queue state error');
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
