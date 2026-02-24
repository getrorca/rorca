import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import simpleGit from 'simple-git';
import { db } from '../db/index';
import { broadcastAll, attachSSE, type WalEvent } from '../lib/sse-hub';
import { runHooks } from '../lib/hook-runner';
import { estimateDryRunCost } from '../lib/cost-estimator';
import { DEFAULT_MODEL } from '../lib/llm-client';
import { getWorkspaceEnvVars } from './env-vars';
import { checkBudgetThresholds } from './budget';
import { getVaultKey } from './vault';
import type { AuthUser } from './auth';
import type { AgentProfileRow } from './agent-profiles';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';

/** Legacy tmp-based log path (used as fallback for old runs) */
const tmpLogPath = (runId: number) => path.join(os.tmpdir(), `rorcha-run-${runId}.log`);

/** Persistent log file path inside workspace/scripts/ralph/logs/ — survives backend restarts */
function workspaceLogPath(workspacePath: string, runId: number): string {
  const logDir = path.join(workspacePath, 'scripts', 'ralph', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `run-${runId}.log`);
}

/** Resolve log path for a run: check DB log_path, then legacy /tmp path */
function resolveLogPath(runId: number): string | null {
  const row = db.prepare('SELECT log_path FROM pipeline_runs WHERE id = ?').get(runId) as { log_path: string | null } | undefined;
  if (row?.log_path && fs.existsSync(row.log_path)) return row.log_path;
  const legacy = tmpLogPath(runId);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** True if the given PID is still alive */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// All Claude Code env vars that block nested invocation (same as llm-client.ts)
const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

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
}

/**
 * @swagger
 * /api/pipeline/trigger:
 *   post:
 *     tags: [Pipeline]
 *     summary: Trigger a pipeline run (spawn run-loop.sh)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string, example: "ralph/specs/approved/my-spec.json" }
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
router.post('/trigger', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId, autoWorktree, dryRun, triggerType } = req.body;

    if (!specPath || !workspaceId) {
      res.status(400).json({ error: 'Missing required fields: specPath, workspaceId' });
      return;
    }

    // 1. Look up workspace path
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
      { id: string; label: string; path: string; domain?: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // ── Plan enforcement: Free tier cannot execute pipelines ─────
    const authReq = req as Request & { user?: { id: string } };
    if (authReq.user?.id) {
      const userRow = db.prepare('SELECT plan FROM users WHERE id = ?').get(authReq.user.id) as { plan: string } | undefined;
      const plan = userRow?.plan || 'free';
      if (plan === 'free' && !dryRun) {
        res.status(403).json({ error: 'plan_required', message: 'Pipeline execution requires a paid plan. Upgrade to Solo, Pro, or Team.' });
        return;
      }
    }

    // ── Dry-run: return cost estimate without spawning any processes ─────
    if (dryRun) {
      const absSpecPath = path.join(workspace.path, 'scripts', specPath);
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
        const l3Pref = db.prepare(
          `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
        ).get(workspaceId) as { preferred_model: string | null } | undefined;
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

    // 3. Verify run-loop engine is available.
    //    Priority: bash run-loop.sh in workspace (backward compat + test stubs) → TS run-loop.ts in backend
    const runLoopSh = path.join(workspace.path, 'scripts', 'run-loop.sh');
    const runLoopTs = path.join(__dirname, '..', 'lib', 'run-loop.ts');
    const hasBashRunLoop = fs.existsSync(runLoopSh);
    const hasTsRunLoop = fs.existsSync(runLoopTs);
    if (!hasBashRunLoop && !hasTsRunLoop) {
      res.status(422).json({ error: `run-loop.sh not found at ${runLoopSh}` });
      return;
    }
    const useTypescriptRunLoop = !hasBashRunLoop && hasTsRunLoop;

    // 4. Conflict check — is there already an active run for this workspace?
    const activeRun = db.prepare(
      `SELECT * FROM pipeline_runs WHERE workspace_id = ? AND status IN ('running', 'paused') LIMIT 1`
    ).get(workspaceId) as PipelineRunRow | undefined;

    if (activeRun && !autoWorktree) {
      res.json({ conflict: true, activeRunId: activeRun.id });
      return;
    }

    // 4. Build absolute spec path: workspace/scripts/<specPath>
    const absSpecPath = path.join(workspace.path, 'scripts', specPath);

    // 5. Determine CWD — main workspace or new worktree
    let cwd = workspace.path;
    let branchName: string | null = null;
    let worktreePath: string | null = null;

    if (autoWorktree) {
      const specSlug = path.basename(specPath, '.json').replace(/[^a-z0-9-]/gi, '-');
      branchName = `feat/${specSlug}-${Date.now()}`;
      const repoName = path.basename(workspace.path);
      const branchSlug = branchName.replace(/\//g, '-');
      worktreePath = path.resolve(workspace.path, '..', `${repoName}-${branchSlug}`);

      const git = simpleGit(workspace.path);
      await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
      cwd = worktreePath;
    }

    // 6. Create pipeline_runs record
    const validTriggerType = triggerType === 'scheduled' ? 'scheduled' : 'manual';
    const runResult = db.prepare(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type) VALUES (?, ?, 'running', ?)`
    ).run(specPath, workspaceId, validTriggerType);
    const runId = runResult.lastInsertRowid as number;

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
    const pipelineUser = (req as Request & { user: AuthUser }).user;
    const anthropicVaultKey = getVaultKey(pipelineUser.id, 'anthropic');
    if (anthropicVaultKey) {
      env['ANTHROPIC_API_KEY'] = anthropicVaultKey.key;
    }
    const openaiVaultKey = getVaultKey(pipelineUser.id, 'openai-compat');
    if (openaiVaultKey) {
      env['OPENAI_API_KEY'] = openaiVaultKey.key;
      if (openaiVaultKey.baseUrl) {
        env['OPENAI_BASE_URL'] = openaiVaultKey.baseUrl;
      }
    }
    const openrouterVaultKey = getVaultKey(pipelineUser.id, 'openrouter');
    if (openrouterVaultKey) {
      env['OPENROUTER_API_KEY'] = openrouterVaultKey.key;
    }

    // 7d. Inject active agent profile (system prompt + allowed tools + model override)
    const activeProfile = db.prepare(
      'SELECT * FROM agent_profiles WHERE workspace_id = ? AND is_active = 1 LIMIT 1'
    ).get(workspaceId) as AgentProfileRow | undefined;

    if (activeProfile) {
      if (activeProfile.system_prompt_override) {
        env['RORCHA_AGENT_SYSTEM_PROMPT'] = activeProfile.system_prompt_override;
      }
      const tools = JSON.parse(activeProfile.allowed_tools) as string[];
      if (tools.length > 0) {
        env['RORCHA_AGENT_ALLOWED_TOOLS'] = tools.join(',');
      }
      if (activeProfile.model_override) {
        env['RORCHA_AGENT_MODEL_OVERRIDE'] = activeProfile.model_override;
      }
    }

    // 8. Run pre-run hooks — abort if any exit non-zero
    const logPath = workspaceLogPath(workspace.path, runId);
    db.prepare('UPDATE pipeline_runs SET log_path = ? WHERE id = ?').run(logPath, runId);
    const preRunResults = runHooks(workspaceId, 'pre_run', cwd, env);
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
        db.prepare(
          `UPDATE pipeline_runs SET status = 'failed', finished_at = datetime('now') WHERE id = ?`
        ).run(runId);

        const walResult = db.prepare(
          `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', ?, ?)`
        ).run(workspaceId, JSON.stringify({
          run_id: runId, status: 'failed', reason: 'pre_run_hook_failed',
          hook_command: failed.command, exit_code: failed.exitCode,
        }));
        const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
          walResult.lastInsertRowid
        ) as WalEvent;
        broadcastAll(walEvent);

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

    // 9. Spawn run-loop — detached so it survives backend restarts.
    //    stdout+stderr go directly to the log file via file descriptor (no pipes).
    //    Pipes break on parent death (SIGPIPE), but file descriptors don't.
    const logFd = fs.openSync(logPath, 'a');
    let child: ReturnType<typeof spawn>;

    if (useTypescriptRunLoop) {
      // TypeScript run-loop (cross-platform, no bash/gtimeout/python dependency)
      const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const backendPort = process.env.PORT || '3030';
      child = spawn(tsxBin, [
        runLoopTs,
        '--json', absSpecPath,
        '--cwd', cwd,
        '--run-id', String(runId),
        '--port', backendPort,
      ], {
        cwd,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      });
    } else {
      // Legacy bash run-loop (fallback for workspaces that still have run-loop.sh)
      const scriptInCwd = path.join(cwd, 'scripts', 'run-loop.sh');
      child = spawn('bash', [scriptInCwd, '--json', absSpecPath], {
        cwd,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      });
    }
    fs.closeSync(logFd);  // parent closes its copy; child keeps its own fd
    child.unref();        // don't keep Node alive waiting for this child

    // 9. Store PID + branch info
    if (child.pid) {
      db.prepare(`UPDATE pipeline_runs SET pid = ?, branch_name = ?, worktree_path = ? WHERE id = ?`)
        .run(child.pid, branchName, worktreePath, runId);
    }

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
      const insertExcluded = db.prepare(
        `INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES (?, ?, 'excluded', datetime('now'))`
      );
      for (const s of excludedStories) {
        insertExcluded.run(runId, s.id);
        const walResult = db.prepare(
          `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ('story_excluded_from_run', ?, ?, ?, ?)`
        ).run(workspaceId, specSlug, s.id, JSON.stringify({ run_id: runId }));
        const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(walResult.lastInsertRowid) as WalEvent;
        broadcastAll(walEvent);
      }

      // 9c — backfill already-passing stories as 'skipped'
      const alreadyPassing = (specJson.userStories ?? []).filter(
        (s: { passes?: boolean; excluded?: boolean }) => s.passes === true && s.excluded !== true
      );
      const insertSkipped = db.prepare(
        `INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES (?, ?, 'skip', datetime('now'))`
      );
      for (const s of alreadyPassing) {
        insertSkipped.run(runId, s.id);
        const walResult = db.prepare(
          `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ('story_skipped', ?, ?, ?, ?)`
        ).run(workspaceId, specSlug, s.id, JSON.stringify({ run_id: runId, reason: 'already_passing' }));
        const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(walResult.lastInsertRowid) as WalEvent;
        broadcastAll(walEvent);
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

    // 11. Update status when process exits
    child.on('exit', (code) => {
      clearInterval(tailInterval);

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
      if (!db.open) {
        buf.done = true;
        buf.subscribers.clear();
        return;
      }

      const status = code === 0 ? 'done' : 'failed';
      db.prepare(
        `UPDATE pipeline_runs SET status = ?, finished_at = datetime('now') WHERE id = ?`
      ).run(status, runId);

      // Run post-run hooks with RUN_STATUS and RUN_ID env vars
      const postRunEnv = { ...env, RUN_STATUS: status, RUN_ID: String(runId) };
      const postRunResults = runHooks(workspaceId, 'post_run', cwd, postRunEnv);
      if (postRunResults.length > 0) {
        const hookOutput = postRunResults.map(r =>
          `\r\n\x1b[36m[post_run hook: ${r.command}]\x1b[0m\r\n${r.output}` +
          (r.exitCode !== 0 ? `\r\n\x1b[31m[Hook exited with code ${r.exitCode}]\x1b[0m\r\n` : '\r\n')
        ).join('');
        buf.chunks.push(hookOutput);
        buf.subscribers.forEach(cb => cb(hookOutput));
        fs.appendFileSync(logPath, hookOutput);
      }

      const walResult = db.prepare(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', ?, ?)`
      ).run(workspaceId, JSON.stringify({ run_id: runId, status, exit_code: code }));

      const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
        walResult.lastInsertRowid
      ) as WalEvent;
      broadcastAll(walEvent);

      // Mark buffer done; notify subscribers; clean up buffer after 30 min (log file retained on disk)
      buf.done = true;
      buf.subscribers.forEach(cb => cb(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`));
      buf.subscribers.clear();
      setTimeout(() => {
        outputBuffers.delete(runId);
      }, 30 * 60 * 1000);
    });

    res.status(201).json({ ok: true, runId, worktreePath, branchName });
  } catch (error: any) {
    console.error('[Pipeline] Trigger error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/pipeline/runs — Create a pipeline run ────────────────────────

router.post('/runs', (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;

    if (!specPath || !workspaceId) {
      res.status(400).json({ error: 'Missing required fields: specPath, workspaceId' });
      return;
    }

    const result = db.prepare(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES (?, ?, 'running')`
    ).run(specPath, workspaceId);

    const runId = result.lastInsertRowid as number;

    const run = db.prepare(
      'SELECT * FROM pipeline_runs WHERE id = ?'
    ).get(runId) as PipelineRunRow;

    // Insert WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_started', ?, ?)`
    ).run(workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath }));

    // Broadcast to SSE subscribers
    const walEvent = db.prepare(
      'SELECT * FROM wal_events WHERE id = ?'
    ).get(walResult.lastInsertRowid) as WalEvent;

    broadcastAll(walEvent);

    res.status(201).json({ run });
  } catch (error: any) {
    console.error('[Pipeline] Create run error:', error);
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
router.get('/runs', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const pagination = parsePaginationParams(req);
    const result = paginateQuery<PipelineRunRow>(db, {
      query: 'SELECT * FROM pipeline_runs WHERE workspace_id = ?',
      countQuery: 'SELECT COUNT(*) as total FROM pipeline_runs WHERE workspace_id = ?',
      params: [workspaceId],
      pagination,
      orderBy: 'id DESC',
      cursorColumn: 'id',
      cursorDirection: 'desc',
    });

    res.json(result);
  } catch (error: any) {
    console.error('[Pipeline] List runs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/pipeline/runs/compare — Compare two pipeline runs side-by-side ─

router.get('/runs/compare', (req: Request, res: Response) => {
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
    const run1 = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(run1Id) as PipelineRunRow | undefined;
    const run2 = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(run2Id) as PipelineRunRow | undefined;

    if (!run1) { res.status(404).json({ error: `Run ${run1Id} not found` }); return; }
    if (!run2) { res.status(404).json({ error: `Run ${run2Id} not found` }); return; }

    // Fetch story results for both runs (latest per story_id by highest id)
    const stories1All = db.prepare(
      'SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC'
    ).all(run1Id) as StoryResultRow[];
    const stories2All = db.prepare(
      'SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC'
    ).all(run2Id) as StoryResultRow[];

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
    console.error('[Pipeline] Compare runs error:', error);
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
router.get('/runs/:runId', (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = db.prepare(
      'SELECT * FROM pipeline_runs WHERE id = ?'
    ).get(runId) as PipelineRunRow | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const stories = db.prepare(
      'SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC'
    ).all(runId) as StoryResultRow[];

    res.json({ run, stories });
  } catch (error: any) {
    console.error('[Pipeline] Get run error:', error);
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
    const originalRun = db.prepare(
      'SELECT * FROM pipeline_runs WHERE id = ?'
    ).get(originalRunId) as PipelineRunRow | undefined;

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
    const allStories = db.prepare(
      'SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC'
    ).all(originalRunId) as StoryResultRow[];

    // Get the latest result per story_id (last row wins — ordered by id ASC)
    const latestByStory = new Map<string, StoryResultRow>();
    for (const s of allStories) {
      latestByStory.set(s.story_id, s);
    }

    const failedStories = Array.from(latestByStory.values()).filter(s => s.status === 'fail');
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
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(originalRun.workspace_id) as
      { id: string; label: string; path: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // 5. Verify run-loop engine is available
    const cwd = originalRun.worktree_path || workspace.path;
    const retryRunLoopSh = path.join(cwd, 'scripts', 'run-loop.sh');
    const retryRunLoopTs = path.join(__dirname, '..', 'lib', 'run-loop.ts');
    const retryHasBash = fs.existsSync(retryRunLoopSh);
    const retryHasTs = fs.existsSync(retryRunLoopTs);
    if (!retryHasBash && !retryHasTs) {
      res.status(422).json({ error: `run-loop.sh not found at ${retryRunLoopSh}` });
      return;
    }
    const retryUseTs = !retryHasBash && retryHasTs;

    // 6. Create a NEW pipeline_run linked to the original via retried_from_run_id
    const newRunResult = db.prepare(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, branch_name, worktree_path, retried_from_run_id)
       VALUES (?, ?, 'running', 'retry', ?, ?, ?)`
    ).run(
      originalRun.spec_path,
      originalRun.workspace_id,
      originalRun.branch_name,
      originalRun.worktree_path,
      originalRunId,
    );
    const newRunId = newRunResult.lastInsertRowid as number;

    // 7. Copy successful story results from the original run to the new run
    const insertCopied = db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, retries, log_path, started_at, finished_at, elapsed_seconds, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const passed of passedStories) {
      insertCopied.run(
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
      );
    }

    // 8. Insert 'retry' placeholder rows for stories being retried + emit WAL events
    const retriedStoryInfo: Array<{ storyId: string; attempt: number }> = [];
    const insertRetryStory = db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, retries) VALUES (?, ?, 'retry', ?)`
    );
    const insertWal = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, story_id, payload) VALUES ('story_retried', ?, ?, ?)`
    );

    for (const story of storiesToRetry) {
      const attempt = story.retries + 1;
      insertRetryStory.run(newRunId, story.story_id, attempt);

      const walResult = insertWal.run(
        originalRun.workspace_id,
        story.story_id,
        JSON.stringify({ run_id: newRunId, original_run_id: originalRunId, story_id: story.story_id, attempt }),
      );
      const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
        walResult.lastInsertRowid
      ) as WalEvent;
      broadcastAll(walEvent);

      retriedStoryInfo.push({ storyId: story.story_id, attempt });
    }

    // Emit run_started WAL event for the new retry run
    const runStartWal = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_started', ?, ?)`
    ).run(originalRun.workspace_id, JSON.stringify({
      run_id: newRunId,
      spec_path: originalRun.spec_path,
      retried_from_run_id: originalRunId,
      retried_stories: storiesToRetry.map(s => s.story_id),
    }));
    const runStartEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      runStartWal.lastInsertRowid
    ) as WalEvent;
    broadcastAll(runStartEvent);

    // 9. Read the original spec and create a filtered version with only retry stories
    const absSpecPath = path.join(workspace.path, 'scripts', originalRun.spec_path);
    if (!fs.existsSync(absSpecPath)) {
      res.status(422).json({ error: `Spec file not found at ${absSpecPath}` });
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    const retryStoryIds = new Set(storiesToRetry.map(s => s.story_id));
    const retrySpec = {
      ...specJson,
      userStories: specJson.userStories.filter((s: { id: string }) => retryStoryIds.has(s.id)),
    };

    // Write temporary retry spec
    const retrySpecName = `retry-${newRunId}-${Date.now()}.json`;
    const retrySpecDir = path.join(workspace.path, 'scripts', 'ralph', 'specs', 'approved');
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

    // 11. Spawn run-loop with the retry spec — detached, output to log file
    const retryLogPath = workspaceLogPath(workspace.path, newRunId);
    db.prepare('UPDATE pipeline_runs SET log_path = ? WHERE id = ?').run(retryLogPath, newRunId);
    const retryLogFd = fs.openSync(retryLogPath, 'a');
    let child: ReturnType<typeof spawn>;
    if (retryUseTs) {
      const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const backendPort = process.env.PORT || '3030';
      child = spawn(tsxBin, [
        retryRunLoopTs,
        '--json', retrySpecPath,
        '--cwd', cwd,
        '--run-id', String(newRunId),
        '--port', backendPort,
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
      db.prepare(`UPDATE pipeline_runs SET pid = ? WHERE id = ?`).run(child.pid, newRunId);
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
    child.on('exit', (code) => {
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

      if (!db.open) {
        buf.done = true;
        buf.subscribers.clear();
        return;
      }

      // Check all stories in the new run (copied passes + retried stories)
      const currentStories = db.prepare(
        'SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC'
      ).all(newRunId) as StoryResultRow[];

      // Build latest status per story_id (last row wins)
      const latest = new Map<string, string>();
      for (const s of currentStories) {
        latest.set(s.story_id, s.status);
      }

      const hasFailures = Array.from(latest.values()).some(st => st === 'fail');
      const finalStatus = hasFailures ? 'partial_failure' : (code === 0 ? 'done' : 'partial_failure');

      db.prepare(
        `UPDATE pipeline_runs SET status = ?, finished_at = datetime('now') WHERE id = ?`
      ).run(finalStatus, newRunId);

      const walResult = db.prepare(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', ?, ?)`
      ).run(originalRun.workspace_id, JSON.stringify({
        run_id: newRunId,
        retried_from_run_id: originalRunId,
        status: finalStatus,
        exit_code: code,
      }));
      const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
        walResult.lastInsertRowid
      ) as WalEvent;
      broadcastAll(walEvent);

      buf.done = true;
      buf.subscribers.forEach(cb => cb(`\r\n\x1b[90m[Retry process exited with code ${code}]\x1b[0m\r\n`));
      buf.subscribers.clear();
      setTimeout(() => {
        outputBuffers.delete(newRunId);
      }, 30 * 60 * 1000);

      // Clean up temporary retry spec
      try { fs.unlinkSync(retrySpecPath); } catch { /* ignore */ }
    });

    res.status(201).json({
      ok: true,
      runId: newRunId,
      originalRunId: originalRunId,
      retriedStories: retriedStoryInfo,
      copiedStories: passedStories.map(s => s.story_id),
    });
  } catch (error: any) {
    console.error('[Pipeline] Retry error:', error);
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
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Paused", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/pause', (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = db.prepare(
      'SELECT * FROM pipeline_runs WHERE id = ?'
    ).get(runId) as PipelineRunRow | undefined;

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
    db.prepare(
      `UPDATE pipeline_runs SET status = 'paused' WHERE id = ?`
    ).run(runId);

    // Compute elapsed time and completed story count for the WAL event
    const elapsedMs = Date.now() - new Date(run.started_at + 'Z').getTime();
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const completedStories = db.prepare(
      `SELECT COUNT(*) as cnt FROM story_results WHERE run_id = ? AND status IN ('pass', 'fail')`
    ).get(runId) as { cnt: number };

    // Emit WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_paused', ?, ?)`
    ).run(run.workspace_id, JSON.stringify({
      run_id: runId,
      elapsed_seconds: elapsedSeconds,
      completed_stories: completedStories.cnt,
    }));

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({ ok: true, runId, status: 'paused' });
  } catch (error: any) {
    console.error('[Pipeline] Pause error:', error);
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
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Resumed", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/resume', (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = db.prepare(
      'SELECT * FROM pipeline_runs WHERE id = ?'
    ).get(runId) as PipelineRunRow | undefined;

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
    db.prepare(
      `UPDATE pipeline_runs SET status = 'running' WHERE id = ?`
    ).run(runId);

    // Emit WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_resumed', ?, ?)`
    ).run(run.workspace_id, JSON.stringify({ run_id: runId }));

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({ ok: true, runId, status: 'running' });
  } catch (error: any) {
    console.error('[Pipeline] Resume error:', error);
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
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Cancelled", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/cancel', (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    const run = db.prepare(
      'SELECT * FROM pipeline_runs WHERE id = ?'
    ).get(runId) as PipelineRunRow | undefined;

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
    db.prepare(
      `UPDATE pipeline_runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`
    ).run(runId);

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
    const completedStories = db.prepare(
      `SELECT COUNT(*) as cnt FROM story_results WHERE run_id = ? AND status IN ('pass', 'fail')`
    ).get(runId) as { cnt: number };

    // Emit WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_cancelled', ?, ?)`
    ).run(run.workspace_id, JSON.stringify({
      run_id: runId,
      elapsed_seconds: elapsedSeconds,
      completed_stories: completedStories.cnt,
    }));

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({ ok: true, runId, status: 'cancelled' });
  } catch (error: any) {
    console.error('[Pipeline] Cancel error:', error);
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
router.get('/runs/:runId/output', (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.runId), 10);
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

  const buf = outputBuffers.get(runId);
  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);

  if (buf) {
    // ── Hot path: in-memory buffer exists ──────────────────────────────────
    // Replay buffered output
    for (const chunk of buf.chunks) {
      const encoded = Buffer.from(chunk).toString('base64');
      res.write(`event: chunk\ndata: ${encoded}\n\n`);
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
  const logPath = resolveLogPath(runId);
  if (!logPath) {
    // No log file — run finished before this server started or never ran
    clearInterval(hb);
    res.write('event: done\ndata: \n\n');
    res.end();
    return;
  }

  // Replay everything written so far
  const existing = fs.readFileSync(logPath);
  if (existing.length > 0) {
    res.write(`event: chunk\ndata: ${existing.toString('base64')}\n\n`);
  }

  // Check if the original process is still alive
  const run = db.prepare('SELECT pid, status FROM pipeline_runs WHERE id = ?')
    .get(runId) as { pid: number | null; status: string } | undefined;
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
        res.write(`event: chunk\ndata: ${newBytes.toString('base64')}\n\n`);
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

function recordTokenUsage(runId: number, storyId: string, inputTokens: number, outputTokens: number, model?: string) {
  const run = db.prepare(
    'SELECT workspace_id FROM pipeline_runs WHERE id = ?'
  ).get(runId) as { workspace_id: string } | undefined;
  if (!run) return;

  const modelName = model || 'unknown';
  const pricing = db.prepare(
    'SELECT * FROM model_pricing WHERE model_id = ?'
  ).get(modelName) as ModelPricingRow | undefined;

  const costUsd = pricing
    ? (inputTokens / 1000) * pricing.input_cost_per_1k + (outputTokens / 1000) * pricing.output_cost_per_1k
    : 0;

  db.prepare(
    `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, storyId, run.workspace_id, modelName, inputTokens, outputTokens, Math.round(costUsd * 1_000_000) / 1_000_000);
}

// ─── POST /api/pipeline/story-result — Record story outcome from run-loop.ts ──
// Called by the TypeScript run-loop to insert story_results rows.

router.post('/story-result', (req: Request, res: Response) => {
  try {
    const { runId, storyId, status } = req.body as { runId?: number; storyId?: string; status?: string };

    if (!runId || !storyId || !status) {
      res.status(400).json({ error: 'runId, storyId, and status are required' });
      return;
    }

    if (!['pass', 'fail', 'skip', 'excluded'].includes(status)) {
      res.status(400).json({ error: `Invalid status: ${status}` });
      return;
    }

    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(runId, storyId, status);

    res.status(201).json({ ok: true });
  } catch (error: any) {
    console.error('[Pipeline] Story result error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/pipeline/runs/:runId/stories/:storyId/tokens — Record token usage ─
// Allows run-loop.ts or external callers to report token usage for a story.

router.post('/runs/:runId/stories/:storyId/tokens', (req: Request, res: Response) => {
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
    const row = db.prepare(
      `SELECT id FROM story_results WHERE run_id = ? AND story_id = ? ORDER BY id DESC LIMIT 1`
    ).get(runId, storyId) as { id: number } | undefined;

    if (!row) {
      res.status(404).json({ error: 'Story result not found' });
      return;
    }

    db.prepare(
      `UPDATE story_results SET input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens) WHERE id = ?`
    ).run(inputTokens ?? null, outputTokens ?? null, row.id);

    // Also record into token_usage analytics table
    recordTokenUsage(runId, storyId, inputTokens || 0, outputTokens || 0, model);

    res.json({ ok: true });
  } catch (error: any) {
    console.error('[Pipeline] Record tokens error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/pipeline/stream — SSE event stream ─────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * @swagger
 * /api/pipeline/stream:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream WAL events (SSE)
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
router.get('/stream', (req: Request, res: Response) => {
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
  let lastSeenId = 0;
  const pollInterval = setInterval(() => {
    try {
      let events;
      if (runId) {
        events = db.prepare(
          `SELECT * FROM wal_events
           WHERE id > ?
             AND event_type IN ('story_started','story_passed','story_failed','story_retry','story_retried','story_skipped','run_started','run_finished','run_failed','run_paused','run_resumed','spec_generated','spec_approved','spec_rejected','batch_started','batch_progress')
             AND (payload LIKE ? OR spec_id IS NOT NULL)
           ORDER BY id ASC
           LIMIT 50`
        ).all(lastSeenId, `%"run_id":${runId}%`);
      } else {
        events = db.prepare(
          `SELECT * FROM wal_events
           WHERE id > ?
             AND event_type IN ('story_started','story_passed','story_failed','story_retry','story_retried','story_skipped','run_started','run_finished','run_failed','run_paused','run_resumed','spec_generated','spec_approved','spec_rejected','batch_started','batch_progress')
           ORDER BY id ASC
           LIMIT 50`
        ).all(lastSeenId);
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
                const storyRow = db.prepare(
                  `SELECT id FROM story_results WHERE run_id = ? AND story_id = ? ORDER BY id DESC LIMIT 1`
                ).get(runIdFromPayload, event.story_id) as { id: number } | undefined;
                if (storyRow) {
                  db.prepare(
                    `UPDATE story_results SET input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens) WHERE id = ?`
                  ).run(payload.input_tokens ?? null, payload.output_tokens ?? null, storyRow.id);
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
router.get('/runs/:runId/log', (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.runId), 10);
  if (isNaN(runId)) {
    res.status(400).json({ error: 'Invalid runId' });
    return;
  }

  const logPath = resolveLogPath(runId);
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

export function cleanupOldLogs(): number {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  // Clean logs referenced in pipeline_runs.log_path
  const rows = db.prepare(
    `SELECT id, log_path FROM pipeline_runs WHERE log_path IS NOT NULL AND finished_at IS NOT NULL`
  ).all() as { id: number; log_path: string }[];

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
  const legacyRows = db.prepare(
    `SELECT id FROM pipeline_runs WHERE log_path IS NULL AND finished_at IS NOT NULL`
  ).all() as { id: number }[];

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
    console.log(`[Pipeline] Cleaned up ${deleted} log file(s) older than ${LOG_RETENTION_DAYS} days`);
  }
  return deleted;
}

export default router;
