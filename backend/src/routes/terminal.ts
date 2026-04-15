<<<<<<< HEAD
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { execute, queryOne } from '../db/index';
import { validateBody } from '../lib/validate';
import { getWorkspaceEnvVars } from './env-vars';
import * as ptyManager from '../lib/pty-manager';
import { NotFoundError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { logger } from '../lib/logger';
import { resolveVaultProvider } from '../lib/llm-client';
import { getDecryptedProviderKey } from '../lib/vault';

const router = Router();

const CLAUDE_NESTED_SESSION_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
] as const;

function providerEnvVarName(vaultProvider: string): string | null {
  switch (vaultProvider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai-compat':
      return 'OPENAI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    default:
      return null;
  }
}

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createSessionSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  rows: z.number().int().positive().default(24),
  cols: z.number().int().positive().default(80),
});

const resizeSessionSchema = z.object({
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
});

// ─── Routes ─────────────────────────────────────────────────────────────────

=======
/**
 * OCT-002–OCT-004: Terminal WebSocket API Routes
 * POST /api/terminal/sessions — Create PTY session
 * WS /api/terminal/sessions/:sessionId — Attach to PTY via WebSocket
 * POST /api/terminal/sessions/:sessionId/resize — Resize PTY
 * DELETE /api/terminal/sessions/:sessionId — Kill PTY
 */

import { Router } from 'express';
import { createSession, resizeSession, killSession, activeSessions } from '../lib/pty-manager';
import { queryOne } from '../db';
import { ServiceUnavailableError, NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

>>>>>>> feat/rorca-opencode-terminal-OCT-024-1776241347295
/**
 * @swagger
 * /api/terminal/sessions:
 *   post:
<<<<<<< HEAD
 *     tags: [Terminal]
 *     summary: Create a new PTY session
 *     operationId: createTerminalSession
 *     description: |
 *       Spawns a new OpenCode PTY session for the specified workspace.
 *       The session is isolated with workspace-specific environment variables.
=======
 *     summary: Create a new PTY session for OpenCode
 *     tags: [Terminal]
>>>>>>> feat/rorca-opencode-terminal-OCT-024-1776241347295
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
<<<<<<< HEAD
 *                 type: string
 *                 description: ID of the workspace to attach the session to
 *               rows:
 *                 type: integer
 *                 description: Terminal height in rows
 *                 default: 24
 *               cols:
 *                 type: integer
 *                 description: Terminal width in columns
 *                 default: 80
 *     responses:
 *       201:
 *         description: PTY session created successfully
=======
 *                 type: integer
 *               rows:
 *                 type: integer
 *                 default: 24
 *               cols:
 *                 type: integer
 *                 default: 80
 *     responses:
 *       201:
 *         description: PTY session created
>>>>>>> feat/rorca-opencode-terminal-OCT-024-1776241347295
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionId:
 *                   type: string
<<<<<<< HEAD
 *                   description: Unique session identifier (UUID)
 *                 workspaceId:
 *                   type: string
 *                 cwd:
 *                   type: string
 *                   description: Working directory (workspace path)
 *                 rows:
 *                   type: integer
 *                 cols:
 *                   type: integer
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Workspace not found
 *       500:
 *         description: Failed to create session (opencode binary not found)
 */
router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const body = validateBody(createSessionSchema, req.body);

    // Look up workspace
    const workspace = await queryOne<{ id: string; path: string }>(
      'SELECT id, path FROM workspaces WHERE id = $1',
      [body.workspaceId]
    );

    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    // Resolve workspace model from workspace env, L3 preferred_model, then process env
    const workspaceEnv = await getWorkspaceEnvVars(body.workspaceId);
    const l3Pref = await queryOne<{ preferred_model: string | null }>(
      `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
      [body.workspaceId]
    );
    const activeModel = workspaceEnv.RORCA_MODEL ?? l3Pref?.preferred_model ?? process.env.RORCA_MODEL ?? '';

    // Resolve active vault provider key for the model, surfacing failures clearly
    const vaultProvider = activeModel ? resolveVaultProvider(activeModel) : null;
    const vaultEnv: Record<string, string> = {};
    if (vaultProvider) {
      const apiKey = await getDecryptedProviderKey(body.workspaceId, vaultProvider);
      if (!apiKey) {
        throw new Error(`Failed to resolve active vault API key for provider '${vaultProvider}' and workspace '${body.workspaceId}'`);
      }
      const apiKeyEnvVar = providerEnvVarName(vaultProvider);
      if (apiKeyEnvVar) {
        vaultEnv[apiKeyEnvVar] = apiKey;
      }
    }

    // Merge env with workspace vars and vault keys taking precedence over process.env
    const mergedEnv = {
      ...process.env,
      RORCA_WORKSPACE_ID: body.workspaceId,
      OPENCODE_MODEL: activeModel,
      ...workspaceEnv,
      ...vaultEnv,
    } as Record<string, string>;

    for (const key of CLAUDE_NESTED_SESSION_ENV_VARS) {
      delete mergedEnv[key];
    }

    // Create PTY session
    const sessionId = await ptyManager.createSession(
      body.workspaceId as any,
      workspace.path,
      mergedEnv,
      body.rows,
      body.cols
    );

    await execute(
      `INSERT INTO terminal_sessions (session_id, workspace_id, cwd, rows, cols, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [sessionId, body.workspaceId, workspace.path, body.rows, body.cols]
    );

    logger.info(
      `[terminal] Created session ${sessionId} for workspace ${body.workspaceId} (${workspace.path})`
    );

    res.status(201).json({
      sessionId,
      workspaceId: body.workspaceId,
      cwd: workspace.path,
      rows: body.rows,
      cols: body.cols,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    handleRouteError(req, res, err);
=======
 *                   format: uuid
 *       503:
 *         description: node-pty native module not available
 */
router.post('/sessions', async (req, res, next) => {
  try {
    const { workspaceId, rows = 24, cols = 80 } = req.body;

    if (!workspaceId || typeof workspaceId !== 'number') {
      throw new ValidationError('workspaceId is required and must be a number');
    }

    // Fetch workspace to get path
    const workspace = await queryOne<{ id: number; path: string }>(
      'SELECT id, path FROM rorca.workspaces WHERE id = $1',
      [workspaceId]
    );

    if (!workspace) {
      throw new NotFoundError('Workspace', String(workspaceId));
    }

    // Create PTY session — throws { code, message } if node-pty not available
    let sessionId: string;
    try {
      sessionId = await createSession(workspaceId, workspace.path, process.env as Record<string, string>, rows, cols);
    } catch (err: any) {
      if (err.code === 'PTY_NOT_AVAILABLE') {
        // OCT-024: Return 503 with hint when node-pty is not built
        throw new ServiceUnavailableError(err.message);
      }
      throw err;
    }

    res.status(201).json({ sessionId });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/terminal/sessions/{sessionId}/resize:
 *   post:
 *     summary: Resize a PTY session
 *     tags: [Terminal]
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rows, cols]
 *             properties:
 *               rows:
 *                 type: integer
 *               cols:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Session resized successfully
 */
router.post('/sessions/:sessionId/resize', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { rows, cols } = req.body;

    if (!rows || !cols || typeof rows !== 'number' || typeof cols !== 'number') {
      throw new ValidationError('rows and cols are required and must be numbers');
    }

    resizeSession(sessionId, rows, cols);

    res.json({ success: true });
  } catch (err) {
    next(err);
>>>>>>> feat/rorca-opencode-terminal-OCT-024-1776241347295
  }
});

/**
 * @swagger
 * /api/terminal/sessions/{sessionId}:
 *   delete:
<<<<<<< HEAD
 *     tags: [Terminal]
 *     summary: Kill a PTY session
 *     operationId: killTerminalSession
 *     description: |
 *       Terminates the PTY process and removes the session from the active sessions map.
 *       Returns 404 if the session does not exist.
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID (UUID)
 *     responses:
 *       204:
 *         description: Session killed successfully
 *       404:
 *         description: Session not found
 */
router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = ptyManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    ptyManager.killSession(sessionId);
    logger.info(`[terminal] Killed session ${sessionId}`);

    res.status(204).send();
  } catch (err) {
    handleRouteError(req, res, err);
=======
 *     summary: Kill a PTY session
 *     tags: [Terminal]
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Session terminated successfully
 */
router.delete('/sessions/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    killSession(sessionId);

    res.json({ success: true });
  } catch (err) {
    next(err);
>>>>>>> feat/rorca-opencode-terminal-OCT-024-1776241347295
  }
});

/**
 * @swagger
 * /api/terminal/sessions:
 *   get:
<<<<<<< HEAD
 *     tags: [Terminal]
 *     summary: List active PTY sessions
 *     operationId: listTerminalSessions
 *     description: |
 *       Returns all currently active PTY sessions across all workspaces.
 *     responses:
 *       200:
 *         description: List of active sessions
=======
 *     summary: List all active PTY sessions
 *     tags: [Terminal]
 *     responses:
 *       200:
 *         description: Array of active sessions
>>>>>>> feat/rorca-opencode-terminal-OCT-024-1776241347295
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sessionId:
 *                         type: string
 *                       workspaceId:
<<<<<<< HEAD
 *                         type: number
 *                       cwd:
 *                         type: string
 *                       rows:
 *                         type: integer
 *                       cols:
 *                         type: integer
=======
 *                         type: integer
 *                       cwd:
 *                         type: string
>>>>>>> feat/rorca-opencode-terminal-OCT-024-1776241347295
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       lastActivityAt:
 *                         type: string
 *                         format: date-time
 */
<<<<<<< HEAD
router.get('/sessions', async (_req: Request, res: Response) => {
  try {
    const activeSessions = ptyManager.activeSessions();

    const sessions = activeSessions.map((s) => ({
      sessionId: s.sessionId,
      workspaceId: s.workspaceId,
      cwd: s.cwd,
      rows: s.rows,
      cols: s.cols,
      createdAt: s.createdAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
    }));

    res.json({ sessions });
  } catch (err) {
    handleRouteError(_req, res, err);
  }
});

/**
 * @swagger
 * /api/terminal/sessions/{sessionId}/resize:
 *   patch:
 *     tags: [Terminal]
 *     summary: Resize a PTY session
 *     operationId: resizeTerminalSession
 *     description: |
 *       Updates the terminal dimensions (rows × cols) for an active session.
 *       The PTY process is notified of the resize via node-pty's resize() method.
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID (UUID)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rows, cols]
 *             properties:
 *               rows:
 *                 type: integer
 *                 description: New terminal height in rows
 *               cols:
 *                 type: integer
 *                 description: New terminal width in columns
 *     responses:
 *       200:
 *         description: Session resized successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       404:
 *         description: Session not found
 */
router.patch('/sessions/:sessionId/resize', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const body = validateBody(resizeSessionSchema, req.body);

    // resizeSession throws if session not found
    try {
      ptyManager.resizeSession(sessionId, body.rows, body.cols);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        throw new NotFoundError('Session not found');
      }
      throw err;
    }

    logger.debug(`[terminal] Resized session ${sessionId} to ${body.cols}x${body.rows}`);

    res.json({ ok: true });
  } catch (err) {
    handleRouteError(req, res, err);
=======
router.get('/sessions', async (req, res, next) => {
  try {
    const sessions = activeSessions();
    const serialized = sessions.map((s) => ({
      sessionId: s.sessionId,
      workspaceId: s.workspaceId,
      cwd: s.cwd,
      createdAt: s.createdAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
      rows: s.rows,
      cols: s.cols,
    }));

    res.json({ sessions: serialized });
  } catch (err) {
    next(err);
>>>>>>> feat/rorca-opencode-terminal-OCT-024-1776241347295
  }
});

export default router;
