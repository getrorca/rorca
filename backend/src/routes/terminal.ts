import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { execute, query, queryOne } from '../db/index';
import { validateBody } from '../lib/validate';
import { getWorkspaceEnvVars } from './env-vars';
import * as ptyManager from '../lib/pty-manager';
import { NotFoundError, ServiceUnavailableError, ValidationError, TooManyRequestsError, UnprocessableError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { logger } from '../lib/logger';
import { broadcastAll } from '../lib/sse-hub';
import { resolveVaultProvider, ALL_MODELS, SUPPORTED_MODELS } from '../lib/llm-client';
import { getDecryptedProviderKey } from '../lib/integration-vault';
import { injectDirectionStack } from '../lib/terminal-context-injector';
import { registerTerminalContextCleanup, runTerminalContextCleanup } from '../lib/terminal-context-cleanup';
import { detectOpenCode } from '../lib/opencode-detector';

const router = Router();

// OCT-021: Short-lived WebSocket connection tokens (60s TTL)
// Maps wsToken -> sessionId to prevent sessionId enumeration
const wsTokenMap = new Map<string, { sessionId: string; expiresAt: number }>();
const WS_TOKEN_TTL_MS = 60_000; // 60 seconds

function generateWsToken(sessionId: string): string {
  const token = randomUUID();
  const expiresAt = Date.now() + WS_TOKEN_TTL_MS;
  wsTokenMap.set(token, { sessionId, expiresAt });
  return token;
}

export function validateWsToken(token: string): string | null {
  const entry = wsTokenMap.get(token);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    wsTokenMap.delete(token);
    return null;
  }
  // One-time use: delete after validation
  wsTokenMap.delete(token);
  return entry.sessionId;
}

// Cleanup expired tokens every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of wsTokenMap.entries()) {
    if (now > entry.expiresAt) {
      wsTokenMap.delete(token);
    }
  }
}, 30_000);

async function emitTerminalContextInjectedEvent(sessionId: string, workspaceId: string, workspacePath: string): Promise<void> {
  const port = process.env.PORT || '3030';
  try {
    await fetch(`http://localhost:${port}/api/wal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'terminal_context_injected',
        workspace_id: workspaceId,
        spec_id: null,
        payload: { sessionId, workspacePath },
      }),
    });
  } catch (error) {
    logger.warn(
      `[terminal] Failed to emit terminal_context_injected WAL event for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

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
  model: z.string().min(1).optional(),
});

function isSupportedSessionModel(model: string): boolean {
  return (SUPPORTED_MODELS as readonly string[]).includes(model)
    || ALL_MODELS.some((entry) => entry.id === model);
}

const resizeSessionSchema = z.object({
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
});

const historyQuerySchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/terminal/sessions:
 *   post:
 *     tags: [Terminal]
 *     summary: Create a new PTY session
 *     operationId: createTerminalSession
 *     description: |
 *       Spawns a new OpenCode PTY session for the specified workspace.
 *       The session is isolated with workspace-specific environment variables.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionId:
 *                   type: string
 *                   description: Unique session identifier (UUID)
 *                 wsToken:
 *                   type: string
 *                   description: Short-lived WebSocket connection token (60s TTL)
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
 *       422:
 *         description: OpenCode binary not found
 *       503:
 *         description: node-pty native module not available
 */
router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const body = validateBody(createSessionSchema, req.body);

    // OCT-015: Check if OpenCode is installed before creating session
    const opencodeStatus = detectOpenCode();
    if (!opencodeStatus.opencodeInstalled) {
      throw new UnprocessableError(
        'OpenCode binary not found',
        'OPENCODE_NOT_INSTALLED',
        { hint: 'Install OpenCode with: npm install -g opencode' }
      );
    }

    // Look up workspace
    const workspace = await queryOne<{ id: string; path: string; label?: string }>(
      'SELECT id, path, label FROM workspaces WHERE id = $1',
      [body.workspaceId]
    );

    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    if (body.model && !isSupportedSessionModel(body.model)) {
      throw new ValidationError('Invalid model');
    }

    // Resolve workspace model from request override, workspace env, L3 preferred_model, then process env
    const workspaceEnv = await getWorkspaceEnvVars(body.workspaceId);
    const l3Pref = await queryOne<{ preferred_model: string | null }>(
      `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
      [body.workspaceId]
    );
    const activeModel = body.model ?? workspaceEnv.RORCA_MODEL ?? l3Pref?.preferred_model ?? process.env.RORCA_MODEL ?? '';

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
      RORCA_MODEL: activeModel,
      OPENCODE_MODEL: activeModel,
      ...workspaceEnv,
      ...vaultEnv,
    } as Record<string, string>;

    for (const key of CLAUDE_NESTED_SESSION_ENV_VARS) {
      delete mergedEnv[key];
    }

    const { cleanup } = await injectDirectionStack(body.workspaceId, workspace.path, activeModel);

    // Create PTY session — throws { code, message } if node-pty not available
    let sessionId: string;
    try {
      sessionId = await ptyManager.createSession(
        body.workspaceId,
        workspace.label ?? workspace.path.split('/').pop() ?? 'Workspace',
        workspace.path,
        mergedEnv,
        body.rows,
        body.cols
      );
      registerTerminalContextCleanup(sessionId, cleanup);
    } catch (err: any) {
      await cleanup();
      if (err.code === 'PTY_NOT_AVAILABLE') {
        // OCT-024: Return 503 with hint when node-pty is not built
        throw new ServiceUnavailableError(err.message);
      }
      throw err;
    }

    await execute(
      `INSERT INTO terminal_sessions (session_id, workspace_id, cwd, rows, cols, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [sessionId, body.workspaceId, workspace.path, body.rows, body.cols]
    );

    logger.info(
      `[terminal] Created session ${sessionId} for workspace ${body.workspaceId} (${workspace.path})`
    );

    await emitTerminalContextInjectedEvent(sessionId, body.workspaceId, workspace.path);

    broadcastAll({
      type: 'terminal_session_started',
      workspaceId: body.workspaceId,
      payload: {
        sessionId,
        cwd: workspace.path,
      },
    });

    // OCT-021: Generate short-lived WebSocket connection token
    const wsToken = generateWsToken(sessionId);

    res.status(201).json({
      sessionId,
      wsToken,
      workspaceId: body.workspaceId,
      cwd: workspace.path,
      rows: body.rows,
      cols: body.cols,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof TooManyRequestsError && err.message === 'Maximum terminal sessions reached') {
      res.status(429).json({ error: 'SESSION_LIMIT_REACHED' });
      return;
    }
    handleRouteError(req, res, err);
  }
});

/**
 * @swagger
 * /api/terminal/sessions/{sessionId}:
 *   get:
 *     tags: [Terminal]
 *     summary: Get a PTY session by ID
 *     operationId: getTerminalSession
 *     description: |
 *       Returns session details if the session is still active.
 *       Used for reattachment after page reload (OCT-026).
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID (UUID)
 *     responses:
 *       200:
 *         description: Session details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionId:
 *                   type: string
 *                 wsToken:
 *                   type: string
 *                   description: Fresh WebSocket connection token (60s TTL)
 *                 workspaceId:
 *                   type: string
 *                 cwd:
 *                   type: string
 *                 rows:
 *                   type: integer
 *                 cols:
 *                   type: integer
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Session not found
 *   delete:
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
router.get('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = ptyManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    // Generate fresh WebSocket connection token for reattachment
    const wsToken = generateWsToken(sessionId);

    res.json({
      sessionId: session.sessionId,
      wsToken,
      workspaceId: session.workspaceId,
      cwd: session.cwd,
      rows: session.rows,
      cols: session.cols,
      createdAt: session.createdAt.toISOString(),
    });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = ptyManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    await runTerminalContextCleanup(sessionId);
    ptyManager.killSession(sessionId);
    logger.info(`[terminal] Killed session ${sessionId}`);

    res.status(204).send();
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

/**
 * @swagger
 * /api/terminal/sessions:
 *   get:
 *     tags: [Terminal]
 *     summary: List active PTY sessions
 *     operationId: listTerminalSessions
 *     description: |
 *       Returns all currently active PTY sessions across all workspaces.
 *     responses:
 *       200:
 *         description: List of active sessions
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
 *                         type: string
 *                       cwd:
 *                         type: string
 *                       rows:
 *                         type: integer
 *                       cols:
 *                         type: integer
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       lastActivityAt:
 *                         type: string
 *                         format: date-time
 */
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
 * /api/terminal/sessions/history:
 *   get:
 *     tags: [Terminal]
 *     summary: List terminal session history
 *     operationId: listTerminalSessionHistory
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *     responses:
 *       200:
 *         description: Recent terminal sessions for a workspace
 *   delete:
 *     tags: [Terminal]
 *     summary: Clear terminal session history
 *     operationId: clearTerminalSessionHistory
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Number of deleted sessions
 */
router.get('/sessions/history', async (req: Request, res: Response) => {
  try {
    const { workspaceId, limit } = historyQuerySchema.parse(req.query);

    const sessions = await query<{
      session_id: string;
      cwd: string;
      status: string;
      exit_code: number | null;
      created_at: string;
      exited_at: string | null;
      total_output_bytes: number | null;
    }>(
      `SELECT session_id, cwd, status, exit_code, created_at, exited_at, total_output_bytes
         FROM terminal_sessions
        WHERE workspace_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [workspaceId, limit]
    );

    res.json({
      sessions: sessions.map((session) => ({
        sessionId: session.session_id,
        cwd: session.cwd,
        status: session.status,
        exitCode: session.exit_code,
        createdAt: session.created_at,
        exitedAt: session.exited_at,
        totalOutputBytes: Number(session.total_output_bytes ?? 0),
      })),
    });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

router.delete('/sessions/history', async (req: Request, res: Response) => {
  try {
    const { workspaceId } = historyQuerySchema.pick({ workspaceId: true }).parse(req.query);

    const result = await execute(
      `DELETE FROM terminal_sessions
        WHERE workspace_id = $1
          AND status != 'active'`,
      [workspaceId]
    );

    res.json({ deleted: result.rowCount });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

/**
 * @swagger
 * /api/terminal/health:
 *   get:
 *     tags: [Terminal]
 *     summary: Get terminal subsystem health
 *     operationId: getTerminalHealth
 *     description: Returns aggregate terminal session and output chunk counts for dashboards.
 *     responses:
 *       200:
 *         description: Terminal health metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activeSessions:
 *                   type: integer
 *                 totalChunks:
 *                   type: integer
 *       500:
 *         description: Internal server error
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const activeSessionsRow = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM terminal_sessions WHERE status = 'active'"
    );
    const totalChunksRow = await queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM terminal_output_chunks'
    );

    res.json({
      activeSessions: Number(activeSessionsRow?.count ?? '0'),
      totalChunks: Number(totalChunksRow?.count ?? '0'),
    });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

/**
 * @swagger
 * /api/terminal/sessions/{sessionId}/scrollback:
 *   get:
 *     tags: [Terminal]
 *     summary: Get terminal scrollback chunks
 *     operationId: getTerminalSessionScrollback
 *     description: |
 *       Returns persisted terminal output chunks for a session in ascending sequence order.
 *       Use the optional `since` query parameter to fetch only chunks after a known sequence cursor.
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID (UUID)
 *       - in: query
 *         name: since
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Return only chunks with sequence greater than this value
 *     responses:
 *       200:
 *         description: Scrollback chunks in sequence order
 *       400:
 *         description: Invalid since parameter
 */
router.get('/sessions/:sessionId/scrollback', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const sinceRaw = req.query.since;

    let since = 0;
    if (sinceRaw !== undefined) {
      const parsed = parseInt(String(sinceRaw), 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        throw new ValidationError('since must be a non-negative integer');
      }
      since = parsed;
    }

    const chunks = await query<{ sequence: number; data: string }>(
      `SELECT sequence, data
         FROM terminal_output_chunks
        WHERE session_id = $1 AND sequence > $2
        ORDER BY sequence ASC
        LIMIT 5000`,
      [sessionId, since]
    );

    res.json({ chunks });
  } catch (err) {
    handleRouteError(req, res, err);
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
  }
});

export default router;
