import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
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
import { parsePaginationParams, paginateQuery } from '../lib/paginate';
import { getEffectiveUser } from '../lib/get-user';
import { parseLine, type SemanticStep } from '../lib/semantic-log-parser';
import { agentConfig, type AgentType } from '../lib/config';
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
    const step = parseLine(line, agent);
    if (step) {
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
  const ctx = await queryOne(`SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = $1`, [workspaceId]) as { schema_snapshot: string | null; git_memory: string | null } | undefined;

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
    gitMemory: ctx?.git_memory || undefined,
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
  const ctx = await queryOne(`SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = $1`, [workspaceId]) as { schema_snapshot: string | null; git_memory: string | null } | undefined;

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
    gitMemory: ctx?.git_memory || undefined,
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
        // Real code conflicts — do NOT auto-merge, report to UI
        appendLog(
          `Pre-check: merge UNSAFE — code conflicts in: ${realConflicts.join(', ')}`,
          '\x1b[31m',
        );
        appendLog('Worktree preserved — resolve conflicts manually via the Worktrees panel', '\x1b[33m');
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('worktree_merge_failed', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({
          run_id: runId,
          branchName,
          worktreePath,
          conflictFiles: realConflicts,
          message: 'Auto-merge skipped — code conflicts detected. Resolve manually via Worktrees panel.',
        })]);
        broadcastAll(walEvent!);
        return; // bail out — do NOT attempt the real merge
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
      res.status(400).json({ error: 'Missing required fields: specPath, workspaceId' });
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      res.status(404).json({ error: 'Spec file not found' });
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    const stories = (specJson.userStories ?? []) as CapabilityStory[];
    const resolvedAgent = agentConfig.agentType;
    const report = checkSpec(stories, resolvedAgent);
    const orchConfig = loadOrchestrationConfig(workspace.path);

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
    });
  } catch (error: any) {
    logger.error('[Pipeline] Preflight error:', error);
    res.status(500).json({ error: error.message });
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
 *               dryRun: { type: boolean, default: false }
 *               triggerType: { type: string, enum: [manual, scheduled], default: manual }
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
  dryRun: z.boolean().optional(),
  triggerType: z.enum(['manual', 'scheduled']).optional(),
  forceSequential: z.boolean().optional(),
  agentOverride: z.enum(['claude', 'opencode', 'codex']).optional(),
  modelOverride: z.string().optional(),
  storyId: z.string().optional(),
  queuedRunId: z.number().optional(),
  queue: z.boolean().optional(),
});

router.post('/trigger', validateBody(PipelineTriggerSchema), async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId, autoWorktree, dryRun, triggerType, forceSequential, queuedRunId } = req.body;

    // 1. Look up workspace path
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; label: string; path: string; domain?: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // ── Plan enforcement: Free tier cannot execute pipelines ─────
    const effectiveUser = await getEffectiveUser(req);
    if (effectiveUser?.id) {
      const userRow = await queryOne('SELECT plan FROM users WHERE id = $1', [effectiveUser.id]) as { plan: string } | undefined;
      const plan = userRow?.plan || 'free';
      if (plan === 'free' && !dryRun) {
        res.status(403).json({ error: 'plan_required', message: 'Pipeline execution requires a paid plan. Upgrade to Solo, Pro, or Team.' });
        return;
      }
    }

    // ── Dry-run: return cost estimate without spawning any processes ─────
    if (dryRun) {
      const absSpecPath = path.join(workspace.path, specPath);
      if (!fs.existsSync(absSpecPath)) {
        res.status(422).json({ error: `Spec file not found at ${absSpecPath}` });
        return;
      }

      const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      if (!specJson.userStories || !Array.isArray(specJson.userStories)) {
        res.status(422).json({ error: 'Spec has no userStories array' });
        return;
      }

      // Resolve model: spec-level > workspace L3 preferred_model > default
      let model: string = DEFAULT_MODEL;
      if (specJson.model) {
        model = specJson.model;
      } else {
        const l3Pref = await queryOne(`SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { preferred_model: string | null } | undefined;
        if (l3Pref?.preferred_model) {
          model = l3Pref.preferred_model;
        }
      }

      const estimate = estimateDryRunCost(specJson, workspaceId, model);
      res.json({ dryRun: true, estimate });
      return;
    }

    // 2. Budget cap guard — block if hard cap exceeded for this period
    const budgetStatus = checkBudgetThresholds(workspaceId);
    if (budgetStatus.capExceeded) {
      res.status(409).json({
        error: 'Budget cap exceeded for this period',
        spending_usd: Math.round(budgetStatus.spending * 1_000_000) / 1_000_000,
        hard_cap_usd: budgetStatus.config!.hard_cap_usd,
        period: budgetStatus.config!.period,
      });
      return;
    }

    // 3. Resolve agent type and verify execution engine is available.
    //    Priority: execution-engine.ts (universal) → bash run-loop.sh (legacy fallback)
    const resolvedAgentType: AgentType = agentConfig.agentType;
    // Model priority: RORCA_MODEL env var > workspace L3 preferred_model > null (agent default)
    const l3WorkspaceModel = workspaceId
      ? (await queryOne(`SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { preferred_model: string | null } | undefined)?.preferred_model ?? null
      : null;
    const resolvedAgentModel: string | null = agentConfig.agentModel ?? l3WorkspaceModel;

    // OC-025: Block pipeline trigger if Claude is selected but not authenticated
    if (resolvedAgentType === 'claude') {
      const { getClaudeAuthState } = await import('../lib/claude-auth');
      const authState = getClaudeAuthState();
      if (!authState.connected) {
        res.status(403).json({
          error: 'claude_not_authenticated',
          message: 'Claude is not authenticated. Connect your Claude account in Settings > Execution Engine.',
          settingsDeepLink: '/settings?tab=providers&focus=claude-auth',
        });
        return;
      }
    }

    // OC-026: Block pipeline trigger if Codex is selected but not authenticated
    if (resolvedAgentType === 'codex') {
      const { getCodexAuthState } = await import('../lib/codex-auth');
      const authState = getCodexAuthState();
      if (!authState.connected) {
        res.status(403).json({
          error: 'codex_not_authenticated',
          message: 'Codex is not authenticated. Connect your ChatGPT account in Settings > Execution Engine.',
          settingsDeepLink: '/settings?tab=providers&focus=codex-auth',
        });
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
          res.status(403).json({
            error: 'engine_auth_required',
            message: 'Some execution engines are not ready',
            details: authErrors,
            settingsDeepLink: '/settings?tab=providers',
          });
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
            res.status(400).json({
              error: 'capability_mismatch',
              message: 'Some stories require tools not supported by the assigned engine',
              mode: mismatchMode,
              incompatibleStories: incompatible,
            });
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
          res.status(409).json({
            error: 'convention_drift_detected',
            message: 'Convention drift check found error-severity violations. Fix violations or disable driftCheck in .rorca/config.json.',
            report: driftReport,
          });
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
      res.status(422).json({ error: `No execution engine found — execution-engine.ts is missing` });
      return;
    }

    // 4. Conflict check — is there already an active run for this workspace?
    //    If queuedRunId is set, this is an internal promotion call — skip conflict check
    const activeRun = queuedRunId ? undefined : await queryOne(`SELECT * FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused') LIMIT 1`, [workspaceId]) as PipelineRunRow | undefined;

    if (activeRun && !autoWorktree) {
      // Check if user explicitly requested queueing
      const { queue } = req.body;
      if (queue) {
        // Explicit queue request — insert with status='queued'
        const queueCount = (await queryOne(`SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued'`, [workspaceId]) as { count: number }).count;
        const position = queueCount + 1;

        const queueResult = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, queued_at, queue_position)
           VALUES ($1, $2, 'queued', $3, NOW(), $4) RETURNING id`, [specPath, workspaceId, triggerType === 'scheduled' ? 'scheduled' : 'manual', position]);
        const queuedId = queueResult!.id;

        res.status(202).json({ queued: true, runId: queuedId, position });
        return;
      }

      // No explicit queue — return conflict so user can choose
      res.json({ conflict: true, activeRunId: activeRun.id });
      return;
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
      branchName = `feat/${specSlug}-${Date.now()}`;
      const repoName = path.basename(workspace.path);
      const branchSlug = branchName.replace(/\//g, '-');
      worktreePath = path.resolve(workspace.path, '..', `${repoName}-${branchSlug}`);

      const git = simpleGit(workspace.path);
      await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
      cwd = worktreePath;

      // Add run-tracking files to worktree's .gitignore so parallel stories
      // don't conflict on these files during wave merges.
      const worktreeGitignore = path.join(worktreePath, '.gitignore');
      const trackingPatterns = '\n# Rorca run-tracking files (parallel-safe)\nprogress.txt\n.rorca/run-state.json\n.rorca/memory/health-log.json\n';
      try {
        const existing = fs.existsSync(worktreeGitignore) ? fs.readFileSync(worktreeGitignore, 'utf-8') : '';
        if (!existing.includes('progress.txt')) {
          fs.appendFileSync(worktreeGitignore, trackingPatterns);
        }
      } catch { /* non-fatal */ }
    }

    // 6. Create pipeline_runs record (with agent_type and agent_model)
    //    If queuedRunId is provided, promote the existing queued row instead of inserting
    const validTriggerType = triggerType === 'scheduled' ? 'scheduled' : 'manual';
    let runId: number;

    if (queuedRunId) {
      // Promote queued run to running
      await execute(`UPDATE pipeline_runs SET status = 'running', started_at = NOW(), queued_at = NULL, queue_position = NULL,
         parallelism = $1, agent = $2, agent_type = $3, agent_model = $4 WHERE id = $5 AND status = 'queued'`, [parallelism, resolvedAgentType, resolvedAgentType, resolvedAgentModel, queuedRunId]);
      runId = queuedRunId;
    } else {
      const runResult = await queryOne<WalEvent>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model) VALUES ($1, $2, 'running', $3, $4, $5, $6, $7) RETURNING *`, [specPath, workspaceId, validTriggerType, parallelism, resolvedAgentType, resolvedAgentType, resolvedAgentModel]);
      runId = runResult!.id;
    }

    // PG-013: Pre-populate context cache for all stories in this run
    try {
      const { warmup: cacheWarmup } = await import('../lib/context-cache');
      await cacheWarmup(workspaceId);
    } catch (warmupErr: any) {
      logger.warn('[pipeline/trigger] Cache warmup failed (non-fatal):', warmupErr.message);
    }

    // 7. Build clean env — strip Claude Code vars so subprocess isn't blocked
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
        env[k] = v;
      }
    }

    // 7b. Inject workspace-specific env vars (decrypted)
    const workspaceEnvVars = getWorkspaceEnvVars(workspaceId);
    for (const [k, v] of Object.entries(workspaceEnvVars)) {
      env[k] = v;
    }

    // 7c. Inject vault API keys for all configured providers
    const pipelineUser = await getEffectiveUser(req);
    const anthropicVaultKey = pipelineUser ? getVaultKey(pipelineUser.id, 'anthropic') : null;
    if (anthropicVaultKey) {
      env['ANTHROPIC_API_KEY'] = anthropicVaultKey.key;
    }
    const openaiVaultKey = pipelineUser ? getVaultKey(pipelineUser.id, 'openai-compat') : null;
    if (openaiVaultKey) {
      env['OPENAI_API_KEY'] = openaiVaultKey.key;
      if (openaiVaultKey.baseUrl) {
        env['OPENAI_BASE_URL'] = openaiVaultKey.baseUrl;
      }
    }
    const openrouterVaultKey = pipelineUser ? getVaultKey(pipelineUser.id, 'openrouter') : null;
    if (openrouterVaultKey) {
      env['OPENROUTER_API_KEY'] = openrouterVaultKey.key;
    }

    // 7c-copilot. Inject GitHub Copilot token when using github/copilot model
    if (resolvedAgentModel === 'github/copilot' && pipelineUser) {
      const copilotToken = getCopilotToken(pipelineUser.id);
      if (copilotToken) {
        env['GITHUB_TOKEN'] = copilotToken;
      }
    }

    // 7d. Inject active agent profile (system prompt + allowed tools + model override)
    const activeProfile = await queryOne('SELECT * FROM agent_profiles WHERE workspace_id = $1 AND is_active = true LIMIT 1', [workspaceId]) as AgentProfileRow | undefined;

    if (activeProfile) {
      if (activeProfile.system_prompt_override) {
        env['RORCA_AGENT_SYSTEM_PROMPT'] = activeProfile.system_prompt_override;
      }
      const tools = (Array.isArray(activeProfile.allowed_tools) ? activeProfile.allowed_tools : JSON.parse(activeProfile.allowed_tools)) as string[];
      if (tools.length > 0) {
        env['RORCA_AGENT_ALLOWED_TOOLS'] = tools.join(',');
      }
      if (activeProfile.model_override) {
        env['RORCA_AGENT_MODEL_OVERRIDE'] = activeProfile.model_override;
      }
    }

    // 8. Run pre-run hooks — abort if any exit non-zero
    const logPath = workspaceLogPath(workspace.path, runId);
    await execute('UPDATE pipeline_runs SET log_path = $1 WHERE id = $2', [logPath, runId]);
    const preRunResults = await runHooks(workspaceId, 'pre_run', cwd, env);
    if (preRunResults.length > 0) {
      // Write hook output to the log file so it appears in the terminal
      const hookOutput = preRunResults.map(r =>
        `\x1b[36m[pre_run hook: ${r.command}]\x1b[0m\n${r.output}` +
        (r.exitCode !== 0 ? `\n\x1b[31m[Hook exited with code ${r.exitCode}]\x1b[0m\n` : '\n')
      ).join('');
      fs.writeFileSync(logPath, hookOutput);

      const failed = preRunResults.find(r => r.exitCode !== 0);
      if (failed) {
        // Mark run as failed and emit WAL event
        await execute(`UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`, [runId]);

        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({
          run_id: runId, status: 'failed', reason: 'pre_run_hook_failed',
          hook_command: failed.command, exit_code: failed.exitCode,
        })]);
        broadcastAll(walEvent!);

        // PR-RQ-1: Advance run queue even on pre-run hook failure
        advanceQueue(workspaceId);

        // Set up output buffer so terminal can display hook output
        const failBuf: OutputBuffer = { chunks: [hookOutput], done: true, subscribers: new Set() };
        outputBuffers.set(runId, failBuf);
        setTimeout(() => {
          outputBuffers.delete(runId);
        }, 30 * 60 * 1000);

        res.status(422).json({
          error: 'Pre-run hook failed',
          runId,
          hookCommand: failed.command,
          exitCode: failed.exitCode,
          output: failed.output,
        });
        return;
      }
    }

    // 9. Start OpenCode server if ANY story is assigned to opencode (OC-029: conditional start)
    //    Server reused across all opencode-assigned stories; stopped after last one completes.
    let ocServer: OpenCodeServer | null = null;
    let attachAddr: string | null = null;

    // Determine if any story needs opencode — check per-story assignments
    let hasOpencodeStories = resolvedAgentType === 'opencode';
    if (!hasOpencodeStories) {
      try {
        const specJson2 = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
        const stories2 = (specJson2.userStories ?? []) as EngineUserStory[];
        const engines = scanRequiredEngines(stories2, resolvedAgentType);
        hasOpencodeStories = engines.has('opencode');
      } catch { /* non-fatal */ }
    }

    if (hasOpencodeStories && useExecutionEngine) {
      try {
        ocServer = new OpenCodeServer({
          runId,
          onPidReady: async (pid) => {
            await execute('UPDATE pipeline_runs SET opencode_server_pid = $1 WHERE id = $2', [pid, runId]);
          },
        });
        await ocServer.start();
        attachAddr = ocServer.attach();
      } catch (serverErr: any) {
        // Failed to start OpenCode server — mark run failed
        await execute(`UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`, [runId]);
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({
          run_id: runId, status: 'failed', reason: 'opencode_server_start_failed',
          error: serverErr.message,
        })]);
        broadcastAll(walEvent!);
        // PR-RQ-1: Advance run queue even on OpenCode server failure
        advanceQueue(workspaceId);
        res.status(422).json({ error: `Failed to start OpenCode server: ${serverErr.message}`, runId });
        return;
      }
    }

    // 9c. Write OpenCode skill file (direction stack → .opencode/skills/rorca.md)
    //     OpenCode reads skill files from .opencode/skills/ automatically.
    //     Written fresh before each run; cleaned up after run completes.
    let openCodeSkillPath: string | null = null;
    if (resolvedAgentType === 'opencode') {
      try {
        // Read spec title from the spec JSON for L4 brief
        const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
        const specBrief = specJson.title || path.basename(specPath, '.json');
        openCodeSkillPath = await writeOpenCodeSkillFile(cwd, workspaceId, `Running spec: ${specBrief}`);
        if (openCodeSkillPath) {
          logger.info(`[Pipeline] Wrote OpenCode skill file: ${openCodeSkillPath}`);
        }
      } catch (err: any) {
        // Non-fatal — run can proceed without the skill file
        logger.warn(`[Pipeline] Failed to write OpenCode skill file: ${err.message}`);
      }
    }

    // 9d. Write Codex AGENTS.md (direction stack → workspace root AGENTS.md)
    //     Codex CLI auto-discovers AGENTS.md from workspace root and injects as context.
    //     If AGENTS.md exists, appends delimited section; otherwise creates it.
    //     Written fresh before each run; cleaned up after run completes.
    let codexAgentsMdState: CodexAgentsMdState | null = null;
    if (resolvedAgentType === 'codex') {
      try {
        const specJson3 = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
        const specBrief3 = specJson3.title || path.basename(specPath, '.json');
        codexAgentsMdState = await writeCodexAgentsMd(cwd, workspaceId, `Running spec: ${specBrief3}`);
        if (codexAgentsMdState) {
          logger.info(`[Pipeline] Wrote Codex AGENTS.md: ${codexAgentsMdState.agentsMdPath}`);
        }
      } catch (err: any) {
        // Non-fatal — run can proceed without direction context
        logger.warn(`[Pipeline] Failed to write Codex AGENTS.md: ${err.message}`);
      }
    }

    // 10. Spawn execution engine — detached so it survives backend restarts.
    //     stdout+stderr go directly to the log file via file descriptor (no pipes).
    const logFd = fs.openSync(logPath, 'a');
    let child: ReturnType<typeof spawn>;

    if (useExecutionEngine) {
      // Universal execution engine (supports claude, opencode, codex)
      const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const backendPort = process.env.PORT || '3030';
      const engineArgs = [
        executionEngineTs,
        '--json', absSpecPath,
        '--cwd', cwd,
        '--run-id', String(runId),
        '--port', backendPort,
        '--parallelism', String(parallelism),
        '--agent', resolvedAgentType,
      ];
      if (resolvedAgentModel) {
        engineArgs.push('--model', resolvedAgentModel);
      }
      if (attachAddr) {
        engineArgs.push('--attach', attachAddr);
      }
      child = spawn(tsxBin, engineArgs, {
        cwd,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      });
    } else {
      // Legacy bash run-loop (fallback for workspaces that still have run-loop.sh)
      const scriptInCwd = path.join(cwd, 'forge', 'run-loop.sh');
      child = spawn('bash', [scriptInCwd, '--json', absSpecPath], {
        cwd,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      });
    }
    fs.closeSync(logFd);  // parent closes its copy; child keeps its own fd
    child.unref();        // don't keep Node alive waiting for this child

    // 10b. Store PID + branch info
    if (child.pid) {
      await execute(`UPDATE pipeline_runs SET pid = $1, branch_name = $2, worktree_path = $3 WHERE id = $4`, [child.pid, branchName, worktreePath, runId]);
    }

    // CIE-016: Compute and store predicted context preview for post-run comparison
    // CIE-017: Include monorepo apps for cross-app story detection
    try {
      const { loadRorcaConfig: loadCfg } = require('../lib/rorca-config') as typeof import('../lib/rorca-config');
      const { route: routeCtx } = require('../lib/context-router') as typeof import('../lib/context-router');
      const { loadMonorepoApps: loadApps } = require('../lib/workspace-echolocation') as typeof import('../lib/workspace-echolocation');
      const rorcaCfg = loadCfg(workspace.path);
      let triggerMonorepoApps: import('../lib/workspace-echolocation').MonorepoPackage[] | undefined;
      try {
        const apps = loadApps(workspace.path);
        if (apps.length > 0) triggerMonorepoApps = apps;
      } catch { /* non-fatal */ }

      const specForCtx = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      const ctxStories = (specForCtx.userStories ?? [])
        .filter((s: any) => !s.passes && !s.excluded)
        .map((s: any) => {
          const routed = routeCtx(s, rorcaCfg.routing, workspace.path, triggerMonorepoApps);
          return {
            storyId: s.id,
            totalTokens: routed.totalTokens,
            injectedFiles: routed.injectedFiles,
          };
        });
      await execute('UPDATE pipeline_runs SET context_preview = $1 WHERE id = $2', [JSON.stringify({ tokenBudget: rorcaCfg.routing.tokenBudget, stories: ctxStories }), runId]);
    } catch { /* non-fatal — context preview is best-effort */ }

    // 9b. Record excluded stories immediately — run-loop.sh will skip them,
    //     but we insert story_results rows so the UI shows them as excluded.
    // 9c. Backfill already-passing stories (passes:true) as 'skipped' so the
    //     progress bar reflects true completion state from the start.
    try {
      const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      const specSlug = path.basename(specPath, '.json');

      // 9b — excluded stories
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

      // 9c — backfill already-passing stories as 'skipped'
      const alreadyPassing = (specJson.userStories ?? []).filter(
        (s: { passes?: boolean; excluded?: boolean }) => s.passes === true && s.excluded !== true
      );
      for (const s of alreadyPassing) {
        await execute(
          `INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, $2, 'skip', NOW())`,
          [runId, s.id]
        );
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ('story_skipped', $1, $2, $3, $4)` + ' RETURNING *', [workspaceId, specSlug, s.id, JSON.stringify({ run_id: runId, reason: 'already_passing' })]);
        broadcastAll(walEvent!);
      }
    } catch { /* spec read error — non-fatal, run-loop will handle */ }

    // 10. Set up in-memory output buffer — tail the log file at 200ms for live streaming
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
      } catch { /* file not yet created or transient read error */ }
    }, 200);

    // 10b. Poll for fallback result files (.rorca-results.jsonl) every 5 seconds.
    // When the execution engine can't POST results (backend restart, port mismatch),
    // it writes them to this file. We sync them back to DB here.
    const fallbackPollCwd = cwd; // worktree path or main workspace path
    const fallbackPollInterval = setInterval(() => {
      try {
        if (true /* pg pool always available */) {
          syncFallbackResults(fallbackPollCwd, workspaceId);
        }
      } catch { /* non-fatal */ }
    }, 5_000);

    // 10c. Monitor OpenCode server health during run — detect crashes and attempt one restart
    let ocHealthInterval: ReturnType<typeof setInterval> | null = null;
    if (ocServer && resolvedAgentType === 'opencode') {
      ocHealthInterval = setInterval(async () => {
        if (!ocServer || ocServer.getState() === 'stopped') {
          if (ocHealthInterval) clearInterval(ocHealthInterval);
          return;
        }

        if (!ocServer.isAlive()) {
          logger.info(`[Pipeline] OpenCode server crashed for run ${runId}, attempting restart...`);

          const restartMsg = `\r\n\x1b[33m[OpenCode server crashed — attempting restart...]\x1b[0m\r\n`;
          buf.chunks.push(restartMsg);
          buf.subscribers.forEach(cb => cb(restartMsg));
          fs.appendFileSync(logPath, restartMsg);

          const restarted = await ocServer.restart();
          if (restarted) {
            logger.info(`[Pipeline] OpenCode server restarted for run ${runId}`);
            const successMsg = `\r\n\x1b[32m[OpenCode server restarted successfully]\x1b[0m\r\n`;
            buf.chunks.push(successMsg);
            buf.subscribers.forEach(cb => cb(successMsg));
            fs.appendFileSync(logPath, successMsg);

            // Emit WAL event for restart
            if (true /* pg pool always available */) {
              const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('opencode_server_restarted', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({ run_id: runId })]);
              broadcastAll(walEvent!);
            }
          } else {
            logger.error(`[Pipeline] OpenCode server restart failed for run ${runId} — killing execution engine`);
            const failMsg = `\r\n\x1b[31m[OpenCode server restart failed — aborting run]\x1b[0m\r\n`;
            buf.chunks.push(failMsg);
            buf.subscribers.forEach(cb => cb(failMsg));
            fs.appendFileSync(logPath, failMsg);

            if (ocHealthInterval) clearInterval(ocHealthInterval);

            // Kill the execution engine — the exit handler will mark the run failed
            try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already dead */ }
            setTimeout(() => {
              try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already dead */ }
            }, 5_000);

            // Emit WAL event
            if (true /* pg pool always available */) {
              const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('opencode_server_crash', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({
                run_id: runId, reason: 'restart_failed',
                error: 'OpenCode server crashed and could not be restarted. Run aborted.',
              })]);
              broadcastAll(walEvent!);
            }
          }
        }
      }, 5_000); // Check every 5 seconds
    }

    // 11. Update status when process exits; stop OpenCode server if running
    child.on('exit', async (code) => {
      clearInterval(tailInterval);
      clearInterval(fallbackPollInterval);
      if (ocHealthInterval) clearInterval(ocHealthInterval);

      // Final sync of any remaining fallback results before marking run complete
      if (true /* pg pool always available */) {
        try { syncFallbackResults(fallbackPollCwd, workspaceId); } catch { /* best-effort */ }
      }

      // Stop OpenCode server — lifecycle tied to this pipeline run
      if (ocServer) {
        ocServer.stop().catch(() => { /* best-effort cleanup */ });
      }

      // Clean up OpenCode skill file — written fresh before each run
      if (openCodeSkillPath) {
        removeOpenCodeSkillFile(openCodeSkillPath);
      }

      // Clean up Codex AGENTS.md — restore original or delete if Rorca created it
      if (codexAgentsMdState) {
        removeCodexAgentsMd(codexAgentsMdState);
      }

      // Flush any remaining bytes not yet picked up by the interval
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

      // Guard: DB may be closed if the process exits after test teardown
      if (false /* pg pool always available */) {
        buf.done = true;
        buf.subscribers.clear();
        return;
      }

      const status = code === 0 ? 'done' : 'failed';
      await execute(`UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`, [status, runId]);

      // FR-005: Mark spec as completed when run succeeds
      if (status === 'done') markSpecCompleted(specPath);

      // PG-021: Synthesize run-level memory (non-blocking, best-effort)
      synthesizeRunMemory(runId, workspaceId).catch(() => {});

      // Run post-run hooks with RUN_STATUS and RUN_ID env vars
      const postRunEnv = { ...env, RUN_STATUS: status, RUN_ID: String(runId) };
      const postRunResults = await runHooks(workspaceId, 'post_run', cwd, postRunEnv);
      if (postRunResults.length > 0) {
        const hookOutput = postRunResults.map(r =>
          `\r\n\x1b[36m[post_run hook: ${r.command}]\x1b[0m\r\n${r.output}` +
          (r.exitCode !== 0 ? `\r\n\x1b[31m[Hook exited with code ${r.exitCode}]\x1b[0m\r\n` : '\r\n')
        ).join('');
        buf.chunks.push(hookOutput);
        buf.subscribers.forEach(cb => cb(hookOutput));
        fs.appendFileSync(logPath, hookOutput);
      }

      const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({ run_id: runId, status, exit_code: code })]);
      broadcastAll(walEvent!);

      // PR-RQ-1: Advance run queue — promote next queued run if any
      advanceQueue(workspaceId);

      // Notify terminal that the process exited
      const exitMsg = `\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`;
      buf.chunks.push(exitMsg);
      buf.subscribers.forEach(cb => cb(exitMsg));
      fs.appendFileSync(logPath, exitMsg);

      // Close the buffer — handles both worktree and non-worktree paths
      const closeBuffer = () => {
        buf.done = true;
        buf.subscribers.clear();
        setTimeout(() => { outputBuffers.delete(runId); }, 30 * 60 * 1000);
      };

      // Auto-merge worktree if run used one — safety pre-check included
      if (worktreePath && branchName) {
        autoMergeWorktree(workspace.path, worktreePath, branchName, workspaceId, runId, buf, logPath)
          .then(closeBuffer)
          .catch((err: Error) => {
            const errMsg = `\r\n\x1b[31m[auto-merge] Unexpected error: ${err.message}\x1b[0m\r\n`;
            buf.chunks.push(errMsg);
            fs.appendFileSync(logPath, errMsg);
            closeBuffer();
          });
      } else {
        closeBuffer();
      }
    });

    // OC-031: Include capability warnings in trigger response
    const capWarnings = (req as any)._capabilityWarnings;
    const capMode = (req as any)._capabilityMismatchMode;
    res.status(201).json({
      ok: true, runId, worktreePath, branchName,
      agentType: resolvedAgentType, agentModel: resolvedAgentModel,
      ...(capWarnings ? { capabilityWarnings: capWarnings, capabilityMismatchMode: capMode } : {}),
      ...(orchestration ? { orchestration } : {}),
    });
  } catch (error: any) {
    logger.error('[Pipeline] Trigger error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Missing required fields: specPath, workspaceId' });
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      res.status(404).json({ error: 'Spec file not found' });
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    if (!specJson.userStories || !Array.isArray(specJson.userStories)) {
      res.status(422).json({ error: 'Spec has no userStories array' });
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
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Missing required fields: specPath, workspaceId' });
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      res.status(404).json({ error: 'Spec file not found' });
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
    res.status(500).json({ error: error.message });
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
 *     description: Generates a single-story spec from a plain-English brief, writes it directly to approved, and immediately triggers pipeline execution.
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
      res.status(400).json({ error: 'Missing required fields: workspaceId, brief' });
      return;
    }

    // 1. Look up workspace
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; label: string; path: string; domain?: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // 2. Plan enforcement
    const effectiveUser = await getEffectiveUser(req);
    if (effectiveUser?.id) {
      const userRow = await queryOne('SELECT plan FROM users WHERE id = $1', [effectiveUser.id]) as { plan: string } | undefined;
      const plan = userRow?.plan || 'free';
      if (plan === 'free') {
        res.status(403).json({ error: 'plan_required', message: 'Pipeline execution requires a paid plan.' });
        return;
      }
    }

    // 3. Budget cap guard
    const budgetStatus = checkBudgetThresholds(workspaceId);
    if (budgetStatus.capExceeded) {
      res.status(409).json({
        error: 'Budget cap exceeded for this period',
        spending_usd: Math.round(budgetStatus.spending * 1_000_000) / 1_000_000,
        hard_cap_usd: budgetStatus.config!.hard_cap_usd,
        period: budgetStatus.config!.period,
      });
      return;
    }

    // 4. Conflict detection
    const activeRun = await queryOne(`SELECT * FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused') LIMIT 1`, [workspaceId]) as PipelineRunRow | undefined;
    if (activeRun) {
      res.json({ conflict: true, activeRunId: activeRun.id });
      return;
    }

    // 5. Resolve model
    let resolvedModel: string = DEFAULT_MODEL;
    if (requestedModel) {
      resolvedModel = requestedModel;
    } else {
      const l3Pref = await queryOne(`SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { preferred_model: string | null } | undefined;
      if (l3Pref?.preferred_model) {
        resolvedModel = l3Pref.preferred_model;
      }
    }

    // 6. Resolve vault creds for LLM call
    const user = await getEffectiveUser(req);
    let vaultCreds: { apiKey?: string; baseUrl?: string } = {};
    if (user?.id) {
      const vaultProvider = resolveVaultProvider(resolvedModel);
      if (vaultProvider) {
        const result = getVaultKey(user.id, vaultProvider);
        if (result) vaultCreds = { apiKey: result.key, baseUrl: result.baseUrl ?? undefined };
      }
      if (!vaultCreds.apiKey) {
        const compat = getVaultKey(user.id, 'openai-compat');
        if (compat) vaultCreds = { apiKey: compat.key, baseUrl: compat.baseUrl ?? undefined };
      }
      if (!vaultCreds.apiKey) {
        const anthropic = getVaultKey(user.id, 'anthropic');
        if (anthropic) vaultCreds = { apiKey: anthropic.key };
      }
    }

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
      res.status(422).json({ error: `No run-loop engine found for workspace` });
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
    const workspaceEnvVars = getWorkspaceEnvVars(workspaceId);
    for (const [k, v] of Object.entries(workspaceEnvVars)) {
      env[k] = v;
    }

    // Inject vault API keys
    if (user?.id) {
      const anthropicVaultKey = getVaultKey(user.id, 'anthropic');
      if (anthropicVaultKey) env['ANTHROPIC_API_KEY'] = anthropicVaultKey.key;
      const openaiVaultKey = getVaultKey(user.id, 'openai-compat');
      if (openaiVaultKey) {
        env['OPENAI_API_KEY'] = openaiVaultKey.key;
        if (openaiVaultKey.baseUrl) env['OPENAI_BASE_URL'] = openaiVaultKey.baseUrl;
      }
      const openrouterVaultKey = getVaultKey(user.id, 'openrouter');
      if (openrouterVaultKey) env['OPENROUTER_API_KEY'] = openrouterVaultKey.key;

      // Inject Copilot token when using github/copilot model
      const resolvedModel = agentConfig.agentModel;
      if (resolvedModel === 'github/copilot') {
        const copilotToken = getCopilotToken(user.id);
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
    logger.error('[Pipeline] Quick-run error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Missing required fields: specPath, workspaceId' });
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
    logger.error('[Pipeline] Create run error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const pagination = parsePaginationParams(req);
    const result = await paginateQuery<PipelineRunRow>({
      query: 'SELECT * FROM pipeline_runs WHERE workspace_id = $1',
      countQuery: 'SELECT COUNT(*) as total FROM pipeline_runs WHERE workspace_id = $1',
      params: [workspaceId],
      pagination,
      orderBy: 'id DESC',
      cursorColumn: 'id',
      cursorDirection: 'desc',
    });

    res.json(result);
  } catch (error: any) {
    logger.error('[Pipeline] List runs error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Missing or invalid run1/run2 query params' });
      return;
    }

    if (run1Id === run2Id) {
      res.status(400).json({ error: 'Cannot compare a run with itself' });
      return;
    }

    // Fetch both runs
    const run1 = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [run1Id]) as PipelineRunRow | undefined;
    const run2 = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [run2Id]) as PipelineRunRow | undefined;

    if (!run1) { res.status(404).json({ error: `Run ${run1Id} not found` }); return; }
    if (!run2) { res.status(404).json({ error: `Run ${run2Id} not found` }); return; }

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
    logger.error('[Pipeline] Compare runs error:', error);
    res.status(500).json({ error: error.message });
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
 *       404: { description: "Run not found" }
 */
router.get('/runs/:runId', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
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
        const rerouteEvents = await query(`SELECT story_id, payload FROM wal_events WHERE event_type = 'story_rerouted' AND payload::text LIKE '%"run_id":' || $1 || '%' ORDER BY id ASC`, [runId]) as Array<{ story_id: string; payload: string }>;
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
          const walRows = await query(`SELECT story_id, payload FROM wal_events WHERE event_type = 'story_started' AND payload::text LIKE '%"run_id":' || $1 || '%'`, [runId]) as Array<{ story_id: string; payload: string }>;
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
    logger.error('[Pipeline] Get run error:', error);
    res.status(500).json({ error: error.message });
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
 *     summary: Retry failed stories in a pipeline run
 *     operationId: retryPipelineRun
 *     description: Re-executes failed stories from a completed or partially failed pipeline run, optionally filtering to specific story IDs.
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
 *       200: { description: "Retry started", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/retry', async (req: Request, res: Response) => {
  try {
    const originalRunId = parseInt(String(req.params.runId), 10);
    if (isNaN(originalRunId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const { storyIds } = req.body as { storyIds?: string[] };

    // 1. Fetch the original run
    const originalRun = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [originalRunId]) as PipelineRunRow | undefined;

    if (!originalRun) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    // Only retry runs that have terminal failure states
    if (!['failed', 'done', 'partial_failure'].includes(originalRun.status)) {
      res.status(409).json({ error: `Cannot retry run with status '${originalRun.status}'` });
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
      res.status(422).json({ error: 'No failed stories to retry' });
      return;
    }

    // 3. Determine which stories to retry
    let storiesToRetry: StoryResultRow[];
    if (storyIds && storyIds.length > 0) {
      storiesToRetry = failedStories.filter(s => storyIds.includes(s.story_id));
      if (storiesToRetry.length === 0) {
        res.status(422).json({ error: 'None of the specified storyIds are failed stories in this run' });
        return;
      }
    } else {
      storiesToRetry = failedStories;
    }

    // 4. Look up workspace
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [originalRun.workspace_id]) as
      { id: string; label: string; path: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // 5. Verify run-loop engine is available
    const cwd = originalRun.worktree_path || workspace.path;
    const retryRunLoopSh = path.join(cwd, 'forge', 'run-loop.sh');
    const retryRunLoopTs = path.join(__dirname, '..', 'lib', 'run-loop.ts');
    const retryExecutionEngineTs = path.join(__dirname, '..', 'lib', 'execution-engine.ts');
    const retryHasExecutionEngine = fs.existsSync(retryExecutionEngineTs);
    const retryHasBash = fs.existsSync(retryRunLoopSh);
    const retryHasTs = fs.existsSync(retryRunLoopTs);
    if (!retryHasExecutionEngine && !retryHasBash && !retryHasTs) {
      res.status(422).json({ error: `No execution engine found` });
      return;
    }
    // Prefer execution-engine.ts (same as regular trigger), fall back to legacy loops
    const retryUseExecutionEngine = retryHasExecutionEngine;
    const retryUseTs = !retryUseExecutionEngine && !retryHasBash && retryHasTs;

    // 6. Create a NEW pipeline_run linked to the original via retried_from_run_id
    const newRunResult = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, branch_name, worktree_path, retried_from_run_id)
       VALUES ($1, $2, 'running', 'retry', $3, $4, $5) RETURNING id`, [originalRun.spec_path,
      originalRun.workspace_id,
      originalRun.branch_name,
      originalRun.worktree_path,
      originalRunId,]);
    const newRunId = newRunResult!.id;

    // 7. Copy successful story results from the original run to the new run
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

    // 8. Insert 'retry' placeholder rows for stories being retried + emit WAL events
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

    // 9. Read the original spec and create a filtered version with only retry stories
    const absSpecPath = path.join(workspace.path, originalRun.spec_path);
    if (!fs.existsSync(absSpecPath)) {
      res.status(422).json({ error: `Spec file not found at ${absSpecPath}` });
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    const retryStoryIds = new Set(storiesToRetry.map(s => s.story_id));
    // Include all stories (not just failed ones) so dependency resolution works correctly.
    // Passed stories (passes:true) are skipped naturally by the engine. Filtering them out
    // breaks dep checks — stories that depend on a passed-but-filtered story get stuck blocked.
    const retrySpec = {
      ...specJson,
    };

    // Write temporary retry spec
    const retrySpecName = `retry-${newRunId}-${Date.now()}.json`;
    const retrySpecDir = path.join(workspace.path, 'forge', 'specs', 'approved');
    const retrySpecPath = path.join(retrySpecDir, retrySpecName);
    fs.mkdirSync(retrySpecDir, { recursive: true });
    fs.writeFileSync(retrySpecPath, JSON.stringify(retrySpec, null, 2));

    // 10. Build clean env
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
        env[k] = v;
      }
    }

    const wsEnvVars = getWorkspaceEnvVars(originalRun.workspace_id);
    for (const [k, v] of Object.entries(wsEnvVars)) {
      env[k] = v;
    }

    // 11. Spawn execution engine with the retry spec — detached, output to log file
    const retryLogPath = workspaceLogPath(workspace.path, newRunId);
    await execute('UPDATE pipeline_runs SET log_path = $1 WHERE id = $2', [retryLogPath, newRunId]);
    const retryLogFd = fs.openSync(retryLogPath, 'a');
    let child: ReturnType<typeof spawn>;
    if (retryUseExecutionEngine) {
      // Universal execution engine (same priority as regular trigger)
      const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const backendPort = process.env.PORT || '3030';
      const engineArgs = [
        retryExecutionEngineTs,
        '--json', retrySpecPath,
        '--cwd', cwd,
        '--run-id', String(newRunId),
        '--port', backendPort,
        '--parallelism', '1',
        '--agent', agentConfig.agentType,
      ];
      if (agentConfig.agentModel) {
        engineArgs.push('--model', agentConfig.agentModel);
      }
      child = spawn(tsxBin, engineArgs, {
        cwd,
        stdio: ['ignore', retryLogFd, retryLogFd],
        detached: true,
        env,
      });
    } else if (retryUseTs) {
      const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const backendPort = process.env.PORT || '3030';
      child = spawn(tsxBin, [
        retryRunLoopTs,
        '--json', retrySpecPath,
        '--cwd', cwd,
        '--run-id', String(newRunId),
        '--port', backendPort,
        '--parallelism', '1',
      ], {
        cwd,
        stdio: ['ignore', retryLogFd, retryLogFd],
        detached: true,
        env,
      });
    } else {
      child = spawn('bash', [retryRunLoopSh, '--json', retrySpecPath], {
        cwd,
        stdio: ['ignore', retryLogFd, retryLogFd],
        detached: true,
        env,
      });
    }
    fs.closeSync(retryLogFd);
    child.unref();

    if (child.pid) {
      await execute(`UPDATE pipeline_runs SET pid = $1 WHERE id = $2`, [child.pid, newRunId]);
    }

    // 12. Set up output buffer — tail log file for live streaming
    const buf: OutputBuffer = { chunks: [], done: false, subscribers: new Set() };
    outputBuffers.set(newRunId, buf);

    let retryTailPos = 0;
    const retryTailInterval = setInterval(() => {
      try {
        const stat = fs.statSync(retryLogPath);
        if (stat.size > retryTailPos) {
          const fd = fs.openSync(retryLogPath, 'r');
          const newBytes = Buffer.alloc(stat.size - retryTailPos);
          fs.readSync(fd, newBytes, 0, newBytes.length, retryTailPos);
          fs.closeSync(fd);
          retryTailPos = stat.size;
          const text = newBytes.toString('utf8');
          buf.chunks.push(text);
          buf.subscribers.forEach(cb => cb(text));
        }
      } catch { /* ignore */ }
    }, 200);

    // 13. Handle process exit — determine final status based on all story outcomes in new run
    child.on('exit', async (code) => {
      clearInterval(retryTailInterval);
      try {
        const stat = fs.statSync(retryLogPath);
        if (stat.size > retryTailPos) {
          const fd = fs.openSync(retryLogPath, 'r');
          const remaining = Buffer.alloc(stat.size - retryTailPos);
          fs.readSync(fd, remaining, 0, remaining.length, retryTailPos);
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

      // Check all stories in the new run (copied passes + retried stories)
      const currentStories = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [newRunId]) as StoryResultRow[];

      // Build latest status per story_id (last row wins)
      const latest = new Map<string, string>();
      for (const s of currentStories) {
        latest.set(s.story_id, s.status);
      }

      const hasFailures = Array.from(latest.values()).some(st => st === 'fail');
      const finalStatus = hasFailures ? 'partial_failure' : (code === 0 ? 'done' : 'partial_failure');

      await execute(`UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`, [finalStatus, newRunId]);

      // FR-005: Mark spec as completed when retry succeeds
      if (finalStatus === 'done') markSpecCompleted(originalRun.spec_path);

      // PG-021: Synthesize run-level memory (non-blocking, best-effort)
      synthesizeRunMemory(newRunId, originalRun.workspace_id).catch(() => {});

      const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [originalRun.workspace_id, JSON.stringify({
        run_id: newRunId,
        retried_from_run_id: originalRunId,
        status: finalStatus,
        exit_code: code,
      })]);
      broadcastAll(walEvent!);

      // PR-RQ-1: Advance run queue — promote next queued run if any
      advanceQueue(originalRun.workspace_id);

      // Notify terminal that the retry process exited
      const retryExitMsg = `\r\n\x1b[90m[Retry process exited with code ${code}]\x1b[0m\r\n`;
      buf.chunks.push(retryExitMsg);
      buf.subscribers.forEach(cb => cb(retryExitMsg));
      try { fs.appendFileSync(retryLogPath, retryExitMsg); } catch { /* best-effort */ }

      // Clean up temporary retry spec
      try { fs.unlinkSync(retrySpecPath); } catch { /* ignore */ }

      // Close the buffer — handles both worktree and non-worktree paths
      const closeRetryBuffer = () => {
        buf.done = true;
        buf.subscribers.clear();
        setTimeout(() => { outputBuffers.delete(newRunId); }, 30 * 60 * 1000);
      };

      // Auto-merge worktree if run used one — safety pre-check included
      const retryWorktreePath = originalRun.worktree_path as string | null;
      const retryBranchName = originalRun.branch_name as string | null;
      if (retryWorktreePath && retryBranchName) {
        autoMergeWorktree(
          workspace.path,
          retryWorktreePath,
          retryBranchName,
          originalRun.workspace_id,
          newRunId,
          buf,
          retryLogPath,
        )
          .then(closeRetryBuffer)
          .catch((err: Error) => {
            const errMsg = `\r\n\x1b[31m[auto-merge] Unexpected error: ${err.message}\x1b[0m\r\n`;
            buf.chunks.push(errMsg);
            try { fs.appendFileSync(retryLogPath, errMsg); } catch { /* best-effort */ }
            closeRetryBuffer();
          });
      } else {
        closeRetryBuffer();
      }
    });

    res.status(201).json({
      ok: true,
      runId: newRunId,
      originalRunId: originalRunId,
      retriedStories: retriedStoryInfo,
      copiedStories: passedStories.map(s => s.story_id),
    });
  } catch (error: any) {
    logger.error('[Pipeline] Retry error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    if (run.status !== 'running') {
      res.status(409).json({ error: `Cannot pause run with status '${run.status}'` });
      return;
    }

    if (!run.pid || !isPidAlive(run.pid)) {
      res.status(409).json({ error: 'Process is not alive' });
      return;
    }

    // Send SIGTSTP to the process group (negative pid) — the current story
    // finishes because SIGTSTP is a "soft" stop that the shell handles at
    // the next job-control boundary, letting the foreground child complete.
    try {
      process.kill(-run.pid, 'SIGTSTP');
    } catch (err: any) {
      res.status(500).json({ error: `Failed to send SIGTSTP: ${err.message}` });
      return;
    }

    // Update status to 'paused'
    await execute(`UPDATE pipeline_runs SET status = 'paused' WHERE id = $1`, [runId]);

    // Compute elapsed time and completed story count for the WAL event
    const elapsedMs = Date.now() - new Date(run.started_at + 'Z').getTime();
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const completedStories = await queryOne(`SELECT COUNT(*) as cnt FROM story_results WHERE run_id = $1 AND status IN ('pass', 'fail')`, [runId]) as { cnt: number };

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_paused', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
      run_id: runId,
      elapsed_seconds: elapsedSeconds,
      completed_stories: completedStories.cnt,
    })]);
    broadcastAll(walEvent!);

    res.json({ ok: true, runId, status: 'paused' });
  } catch (error: any) {
    logger.error('[Pipeline] Pause error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    if (run.status !== 'paused') {
      res.status(409).json({ error: `Cannot resume run with status '${run.status}'` });
      return;
    }

    if (!run.pid || !isPidAlive(run.pid)) {
      res.status(409).json({ error: 'Process is not alive' });
      return;
    }

    // Send SIGCONT to the process group
    try {
      process.kill(-run.pid, 'SIGCONT');
    } catch (err: any) {
      res.status(500).json({ error: `Failed to send SIGCONT: ${err.message}` });
      return;
    }

    // Update status back to 'running'
    await execute(`UPDATE pipeline_runs SET status = 'running' WHERE id = $1`, [runId]);

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_resumed', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({ run_id: runId })]);
    broadcastAll(walEvent!);

    res.json({ ok: true, runId, status: 'running' });
  } catch (error: any) {
    logger.error('[Pipeline] Resume error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const { context } = req.body as { context?: string };
    if (!context || context.trim().length === 0) {
      res.status(400).json({ error: 'Context is required and cannot be empty' });
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    // Accept context injection when run is blocked or paused
    if (run.status !== 'paused' && run.status !== 'running') {
      res.status(409).json({ error: `Cannot inject context into run with status '${run.status}'` });
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
    logger.error('[Pipeline] Context injection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/pipeline/runs/:runId/cancel — Cancel a running/paused pipeline ─
// Sends SIGTERM to the process group. If the process doesn't exit within 5s,
// escalates to SIGKILL. Idempotent: if the PID is already dead, still marks
// the run as cancelled.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/cancel:
 *   post:
 *     tags: [Pipeline]
 *     summary: Cancel a running or paused pipeline
 *     operationId: cancelPipelineRun
 *     description: Sends SIGTERM (escalating to SIGKILL after 5 seconds) to the pipeline process group and marks the run as cancelled.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Cancelled", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/cancel', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    if (run.status !== 'running' && run.status !== 'paused') {
      res.status(409).json({ error: `Cannot cancel run with status '${run.status}'` });
      return;
    }

    const pidAlive = run.pid != null && isPidAlive(run.pid);

    if (pidAlive) {
      // Send SIGTERM to process group (negative pid)
      try {
        process.kill(-run.pid!, 'SIGTERM');
      } catch {
        // Process may have died between check and kill — that's OK
      }

      // Schedule SIGKILL after 5s if still alive
      setTimeout(() => {
        try {
          if (isPidAlive(run.pid!)) {
            process.kill(-run.pid!, 'SIGKILL');
          }
        } catch {
          // Already dead — ignore
        }
      }, 5000);
    }

    // Mark run as cancelled
    await execute(`UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW() WHERE id = $1`, [runId]);

    // Append [Run cancelled] message to the output buffer
    const buf = outputBuffers.get(runId);
    if (buf) {
      const cancelMsg = '\r\n\x1b[1;33m[Run cancelled]\x1b[0m\r\n';
      buf.chunks.push(cancelMsg);
      for (const sub of buf.subscribers) sub(cancelMsg);
      buf.done = true;
      buf.subscribers.clear();
    }

    // Compute elapsed time and completed story count for the WAL event
    const elapsedMs = Date.now() - new Date(run.started_at + 'Z').getTime();
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const completedStories = await queryOne(`SELECT COUNT(*) as cnt FROM story_results WHERE run_id = $1 AND status IN ('pass', 'fail')`, [runId]) as { cnt: number };

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_cancelled', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
      run_id: runId,
      elapsed_seconds: elapsedSeconds,
      completed_stories: completedStories.cnt,
    })]);
    broadcastAll(walEvent!);

    res.json({ ok: true, runId, status: 'cancelled' });
  } catch (error: any) {
    logger.error('[Pipeline] Cancel error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    if (run.status !== 'queued') {
      res.status(409).json({ error: `Cannot cancel run with status '${run.status}' — only queued runs can be cancelled via DELETE` });
      return;
    }

    // Mark as failed
    await execute(`UPDATE pipeline_runs SET status = 'failed', finished_at = NOW(), queued_at = NULL, queue_position = NULL WHERE id = $1`, [runId]);

    // Recalculate positions for remaining queued runs
    const { recalculateQueuePositions } = require('../lib/run-queue') as typeof import('../lib/run-queue');
    recalculateQueuePositions(run.workspace_id);

    res.json({ ok: true, runId });
  } catch (error: any) {
    logger.error('[Pipeline] Delete queued run error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/pipeline/runs/:runId/output — Raw terminal output SSE ──────────
// Streams raw stdout/stderr (with ANSI codes) to xterm.js on the frontend.
// Late-joiners receive a full replay of buffered chunks, then live updates.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/output:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream raw terminal output (SSE)
 *     operationId: streamPipelineOutput
 *     description: Server-Sent Events stream of base64-encoded terminal output. Late joiners receive full buffer replay.
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
    res.status(400).json({ error: 'Invalid runId' });
    return;
  }

  // Validate workspace ownership if workspaceId is provided
  const wsId = req.query.workspaceId as string | undefined;
  if (wsId) {
    const ownerCheck = await queryOne('SELECT workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { workspace_id: number } | undefined;
    if (ownerCheck && String(ownerCheck.workspace_id) !== wsId) {
      res.status(403).json({ error: 'Run does not belong to this workspace' });
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const buf = outputBuffers.get(runId);
  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);

  // Resolve agent type for semantic parsing (defaults to 'claude')
  const runRow = await queryOne('SELECT agent_type, agent, agent_model FROM pipeline_runs WHERE id = $1', [runId]) as { agent_type: string; agent: string; agent_model: string | null } | undefined;
  const agent = runRow?.agent_type ?? runRow?.agent ?? 'claude';

  // Emit run metadata so frontend knows which renderer to use
  res.write(`event: run_meta\ndata: ${JSON.stringify({ agentType: agent, agentModel: runRow?.agent_model ?? null })}\n\n`);

  if (buf) {
    // ── Hot path: in-memory buffer exists ──────────────────────────────────
    // Replay buffered output + semantic steps
    for (const chunk of buf.chunks) {
      const encoded = Buffer.from(chunk).toString('base64');
      res.write(`event: chunk\ndata: ${encoded}\n\n`);
      emitSemanticSteps(chunk, agent, res);
    }

    if (buf.done) {
      clearInterval(hb);
      res.write('event: done\ndata: \n\n');
      res.end();
      return;
    }

    // Subscribe to live output
    const onChunk = (chunk: string) => {
      const encoded = Buffer.from(chunk).toString('base64');
      res.write(`event: chunk\ndata: ${encoded}\n\n`);
      emitSemanticSteps(chunk, agent, res);
    };
    buf.subscribers.add(onChunk);

    req.on('close', () => {
      buf.subscribers.delete(onChunk);
      clearInterval(hb);
    });
    return;
  }

  // ── Cold path: buffer not in memory (backend restarted) ──────────────────
  // Fall back to the persisted log file (check DB log_path, then legacy /tmp).
  const logPath = await resolveLogPath(runId);
  if (!logPath) {
    // No log file — run finished before this server started or never ran
    clearInterval(hb);
    res.write('event: done\ndata: \n\n');
    res.end();
    return;
  }

  // Replay everything written so far + semantic steps
  const existing = fs.readFileSync(logPath);
  if (existing.length > 0) {
    res.write(`event: chunk\ndata: ${existing.toString('base64')}\n\n`);
    emitSemanticSteps(existing.toString('utf8'), agent, res);
  }

  // Check if the original process is still alive
  const run = await queryOne('SELECT pid, status FROM pipeline_runs WHERE id = $1', [runId]) as { pid: number | null; status: string } | undefined;
  const stillRunning = (run?.status === 'running' || run?.status === 'paused') && run?.pid != null && isPidAlive(run.pid);

  if (!stillRunning) {
    clearInterval(hb);
    res.write('event: done\ndata: \n\n');
    res.end();
    return;
  }

  // Tail the log file — poll for new bytes every 200 ms
  let offset = existing.length;
  const tailInterval = setInterval(() => {
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

      // Stop tailing once the process exits
      if (run?.pid != null && !isPidAlive(run.pid)) {
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

  req.on('close', () => {
    clearInterval(tailInterval);
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

async function recordTokenUsage(runId: number, storyId: string, inputTokens: number, outputTokens: number, model?: string) {
  const run = await queryOne('SELECT workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { workspace_id: string } | undefined;
  if (!run) return;

  const modelName = model || 'unknown';
  const pricing = await queryOne('SELECT * FROM model_pricing WHERE model_id = $1', [modelName]) as ModelPricingRow | undefined;

  const costUsd = pricing
    ? (inputTokens / 1000) * pricing.input_cost_per_1k + (outputTokens / 1000) * pricing.output_cost_per_1k
    : 0;

  await execute(`INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [runId, storyId, run.workspace_id, modelName, inputTokens, outputTokens, Math.round(costUsd * 1_000_000) / 1_000_000]);
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
      inputTokens, outputTokens, modelUsed, costUsd,
      logPath, blockedBy, activeSkills,
    } = req.body as {
      runId?: number; storyId?: string; status?: string;
      worktreePath?: string; worktreeBranch?: string;
      inputTokens?: number; outputTokens?: number; modelUsed?: string; costUsd?: number;
      logPath?: string; blockedBy?: string[]; activeSkills?: string[];
    };

    if (!runId || !storyId || !status) {
      res.status(400).json({ error: 'runId, storyId, and status are required' });
      return;
    }

    if (!['pass', 'fail', 'skip', 'excluded'].includes(status)) {
      res.status(400).json({ error: `Invalid status: ${status}` });
      return;
    }

    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at, worktree_path, worktree_branch, input_tokens, output_tokens, model_used, cost_usd, log_path, blocked_by, active_skills)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [runId, storyId, status,
      worktreePath ?? null, worktreeBranch ?? null,
      inputTokens ?? null, outputTokens ?? null,
      modelUsed ?? null, costUsd ?? null,
      logPath ?? null,
      blockedBy && blockedBy.length > 0 ? JSON.stringify(blockedBy) : null,
      activeSkills && activeSkills.length > 0 ? JSON.stringify(activeSkills) : null,]);

    // Also record into token_usage analytics table if tokens are present
    if ((inputTokens && inputTokens > 0) || (outputTokens && outputTokens > 0)) {
      recordTokenUsage(runId, storyId, inputTokens || 0, outputTokens || 0, modelUsed);
    }

    res.status(201).json({ ok: true });
  } catch (error: any) {
    logger.error('[Pipeline] Story result error:', error);
    res.status(500).json({ error: error.message });
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
    const { inputTokens, outputTokens, model } = req.body as { inputTokens?: number; outputTokens?: number; model?: string };

    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    if (inputTokens == null && outputTokens == null) {
      res.status(400).json({ error: 'At least one of inputTokens or outputTokens required' });
      return;
    }

    // Find the latest story_result row for this run + storyId
    const row = await queryOne(`SELECT id FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1`, [runId, storyId]) as { id: number } | undefined;

    if (!row) {
      res.status(404).json({ error: 'Story result not found' });
      return;
    }

    await execute(`UPDATE story_results SET input_tokens = COALESCE($1, input_tokens), output_tokens = COALESCE($2, output_tokens) WHERE id = $3`, [inputTokens ?? null, outputTokens ?? null, row.id]);

    // Also record into token_usage analytics table
    recordTokenUsage(runId, storyId, inputTokens || 0, outputTokens || 0, model);

    res.json({ ok: true });
  } catch (error: any) {
    logger.error('[Pipeline] Record tokens error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    // 1. Check story_result exists
    const storyResult = await queryOne(`SELECT * FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1`, [runId, storyId]) as StoryResultRow | undefined;

    if (!storyResult) {
      res.status(404).json({ error: 'Story result not found' });
      return;
    }

    // 2. Try to get failure details from WAL events
    const walEvent = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'story_failed' AND story_id = $1 AND payload::text LIKE $2 ORDER BY id DESC LIMIT 1`, [storyId, `%"run_id":${runId}%`]) as { payload: string } | undefined;

    let failureReason: string | null = null;
    let failureAttempts: number | null = null;
    let blockedBy: string[] | null = null;
    if (walEvent?.payload) {
      try {
        const payload = JSON.parse(walEvent.payload);
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
    logger.error('[Pipeline] Story output error:', error);
    res.status(500).json({ error: error.message });
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
    res.status(400).json({ error: 'Invalid runId' });
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
  const walRow = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'story_started' AND story_id = $1 AND payload::text LIKE $2 ORDER BY id DESC LIMIT 1`, [storyId, `%"run_id":${runId}%`]) as { payload: string } | undefined;
  if (walRow?.payload) {
    try {
      const payload = JSON.parse(walRow.payload);
      if (payload.log_file && fs.existsSync(payload.log_file)) {
        storyLogPath = payload.log_file;
      }
    } catch { /* ignore */ }
  }

  // 2. Fallback: scan forge/logs/ for <storyId>_*.log pattern
  if (!storyLogPath && runRow?.workspace_id) {
    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [runRow.workspace_id]) as { path: string } | undefined;
    if (workspace) {
      const logDir = path.join(workspace.path, 'forge', 'logs');
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

  if (!storyLogPath) {
    // No log file yet — send waiting status, then poll until it appears or story finishes
    res.write(`event: status\ndata: waiting\n\n`);

    // Poll every 500ms for the log file to appear
    const pollForLog = setInterval(async () => {
      // Re-check WAL event
      const freshWal = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'story_started' AND story_id = $1 AND payload::text LIKE $2 ORDER BY id DESC LIMIT 1`, [storyId, `%"run_id":${runId}%`]) as { payload: string } | undefined;
      if (freshWal?.payload) {
        try {
          const payload = JSON.parse(freshWal.payload);
          if (payload.log_file && fs.existsSync(payload.log_file)) {
            storyLogPath = payload.log_file;
            clearInterval(pollForLog);
            startTailing(storyLogPath!, agent, res, hb, runId, storyId);
            return;
          }
        } catch { /* ignore */ }
      }

      // Check if story already finished (no log will come)
      const finishEvent = await queryOne(`SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND payload::text LIKE $2 LIMIT 1`, [storyId, `%"run_id":${runId}%`]);
      if (finishEvent) {
        clearInterval(pollForLog);
        clearInterval(hb);
        res.write('event: done\ndata: \n\n');
        res.end();
      }
    }, 500);

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
  const finishEvent = await queryOne(`SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND payload::text LIKE $2 LIMIT 1`, [storyId, `%"run_id":${runId}%`]);
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
      const done = await queryOne(`SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND payload::text LIKE $2 LIMIT 1`, [storyId, `%"run_id":${runId}%`]);
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

// ─── GET /api/pipeline/stream — SSE event stream ─────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * @swagger
 * /api/pipeline/stream:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream WAL events (SSE)
 *     operationId: streamPipelineEvents
 *     description: Server-Sent Events stream of WAL events (story progress). Polls wal_events table every 3s.
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
router.get('/stream', async (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial keepalive
  res.write(': keepalive\n\n');

  // Wire up real-time broadcast via sse-hub
  const unsubscribe = attachSSE(res);

  // Heartbeat every 15s
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  // Also poll WAL for events (catch events from external processes like Ralph)
  const runId = req.query.runId as string;
  const wsId = req.query.workspaceId as string | undefined;

  // Resolve workspace_id from the run if not provided explicitly
  let resolvedWsId = wsId ?? null;
  if (!resolvedWsId && runId) {
    const runRow = await queryOne('SELECT workspace_id FROM pipeline_runs WHERE id = $1', [Number(runId)]) as { workspace_id: number } | undefined;
    if (runRow) resolvedWsId = String(runRow.workspace_id);
  }

  let lastSeenId = 0;
  const pollInterval = setInterval(async () => {
    try {
      let events;
      if (runId && resolvedWsId) {
        events = await query(`SELECT * FROM wal_events
           WHERE id > $1
             AND event_type IN ('story_started','story_passed','story_failed','story_retry','story_retried','story_skipped','story_token_update','run_started','run_finished','run_failed','run_paused','run_resumed','run_blocked','run_cancelled','spec_generated','spec_approved','spec_rejected','batch_started','batch_progress')
             AND payload::text LIKE $2
             AND workspace_id = $3
           ORDER BY id ASC
           LIMIT 50`, [lastSeenId, `%"run_id":${runId}%`, resolvedWsId]);
      } else if (runId) {
        events = await query(`SELECT * FROM wal_events
           WHERE id > $1
             AND event_type IN ('story_started','story_passed','story_failed','story_retry','story_retried','story_skipped','story_token_update','run_started','run_finished','run_failed','run_paused','run_resumed','run_blocked','run_cancelled','spec_generated','spec_approved','spec_rejected','batch_started','batch_progress')
             AND payload::text LIKE $2
           ORDER BY id ASC
           LIMIT 50`, [lastSeenId, `%"run_id":${runId}%`]);
      } else if (resolvedWsId) {
        events = await query(`SELECT * FROM wal_events
           WHERE id > $1
             AND event_type IN ('story_started','story_passed','story_failed','story_retry','story_retried','story_skipped','story_token_update','run_started','run_finished','run_failed','run_paused','run_resumed','run_blocked','run_cancelled','spec_generated','spec_approved','spec_rejected','batch_started','batch_progress')
             AND workspace_id = $2
           ORDER BY id ASC
           LIMIT 50`, [lastSeenId, resolvedWsId]);
      } else {
        events = await query(`SELECT * FROM wal_events
           WHERE id > $1
             AND event_type IN ('story_started','story_passed','story_failed','story_retry','story_retried','story_skipped','story_token_update','run_started','run_finished','run_failed','run_paused','run_resumed','run_blocked','run_cancelled','spec_generated','spec_approved','spec_rejected','batch_started','batch_progress')
           ORDER BY id ASC
           LIMIT 50`, [lastSeenId]);
      }

      for (const event of events as any[]) {
        res.write(`event: wal_event\ndata: ${JSON.stringify(event)}\n\n`);
        lastSeenId = event.id;

        // V2-025: Auto-record token usage from WAL event payloads into story_results
        // V2-043: Also insert into token_usage analytics table
        if (event.story_id && event.payload && (event.event_type === 'story_passed' || event.event_type === 'story_failed')) {
          try {
            const payload = JSON.parse(event.payload);
            if (payload.input_tokens != null || payload.output_tokens != null) {
              const runIdFromPayload = payload.run_id;
              if (runIdFromPayload) {
                const storyRow = await queryOne(`SELECT id FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1`, [runIdFromPayload, event.story_id]) as { id: number } | undefined;
                if (storyRow) {
                  await execute(`UPDATE story_results SET input_tokens = COALESCE($1, input_tokens), output_tokens = COALESCE($2, output_tokens) WHERE id = $3`, [payload.input_tokens ?? null, payload.output_tokens ?? null, storyRow.id]);
                }
                // Record into token_usage analytics table
                recordTokenUsage(
                  runIdFromPayload,
                  event.story_id,
                  payload.input_tokens || 0,
                  payload.output_tokens || 0,
                  payload.model,
                );
              }
            }
          } catch { /* payload parse error — ignore */ }
        }
      }
    } catch {
      // DB may be locked briefly, skip this tick
    }
  }, 1000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeatInterval);
    clearInterval(pollInterval);
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
    res.status(400).json({ error: 'Invalid runId' });
    return;
  }

  const logPath = await resolveLogPath(runId);
  if (!logPath) {
    res.status(404).json({ error: 'Log file not found for this run' });
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
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;

    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
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
    logger.error('[Pipeline] Get run commits error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = await queryOne('SELECT id, spec_path, workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { id: number; spec_path: string; workspace_id: string } | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
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
    logger.error('[Pipeline] Get run skills error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── OC-015: Orphan Process Cleanup on Backend Startup ──────────────────────
// Scans pipeline_runs WHERE status='running', kills orphan PIDs (engine + OpenCode server),
// marks runs as failed. Called once at server startup.

export async function cleanupOrphanRuns(): Promise<number> {
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
    // Kill execution engine process (if alive)
    if (run.pid) {
      try {
        process.kill(run.pid, 0); // Check alive
        try {
          process.kill(-run.pid, 'SIGTERM'); // Kill process group
          logger.info(`[Cleanup] Sent SIGTERM to engine PID ${run.pid} (run ${run.id})`);
        } catch {
          try { process.kill(run.pid, 'SIGTERM'); } catch { /* already dead */ }
        }
      } catch {
        // Process already dead — expected after backend restart
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
      const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
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

export default router;
