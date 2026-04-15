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

/**
 * @swagger
 * /api/terminal/sessions:
 *   post:
 *     summary: Create a new PTY session for OpenCode
 *     tags: [Terminal]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionId:
 *                   type: string
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
  }
});

/**
 * @swagger
 * /api/terminal/sessions/{sessionId}:
 *   delete:
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
  }
});

/**
 * @swagger
 * /api/terminal/sessions:
 *   get:
 *     summary: List all active PTY sessions
 *     tags: [Terminal]
 *     responses:
 *       200:
 *         description: Array of active sessions
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
 *                         type: integer
 *                       cwd:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       lastActivityAt:
 *                         type: string
 *                         format: date-time
 */
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
  }
});

export default router;
