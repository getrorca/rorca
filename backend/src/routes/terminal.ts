// ─── Terminal Routes (OCT-005) ──────────────────────────────────────────────
// Endpoints for managing PTY sessions and retrieving scrollback buffers.

import { Router } from 'express';
import { query } from '../db/index';
import { logger } from '../lib/logger';

const router = Router();

interface TerminalOutputChunk {
  sequence: number;
  data: string;
  recordedAt: string;
}

/**
 * GET /api/terminal/sessions/:sessionId/scrollback
 *
 * Returns the last 5000 chunks of terminal output for the given session.
 * Used when the frontend reconnects to an existing session to replay scrollback.
 *
 * @swagger
 * /api/terminal/sessions/{sessionId}/scrollback:
 *   get:
 *     summary: Get terminal scrollback buffer
 *     description: Returns up to 5000 most recent output chunks for session replay
 *     tags: [Terminal]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The PTY session UUID
 *     responses:
 *       200:
 *         description: Scrollback chunks ordered by sequence
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 chunks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sequence:
 *                         type: integer
 *                       data:
 *                         type: string
 *                       recordedAt:
 *                         type: string
 *                         format: date-time
 *       404:
 *         description: Session not found
 */
router.get('/sessions/:sessionId/scrollback', async (req, res) => {
  const { sessionId } = req.params;

  try {
    // Query last 5000 chunks ordered by sequence (most recent)
    // Use a subquery to limit, then re-order by sequence ASC for replay
    const chunks = await query<TerminalOutputChunk>(
      `SELECT sequence, data, recorded_at AS "recordedAt"
       FROM (
         SELECT sequence, data, recorded_at
         FROM terminal_output_chunks
         WHERE session_id = $1
         ORDER BY sequence DESC
         LIMIT 5000
       ) sub
       ORDER BY sequence ASC`,
      [sessionId]
    );

    if (chunks.length === 0) {
      // Check if session exists but has no output yet
      const sessionExists = await query(
        `SELECT 1 FROM terminal_sessions WHERE session_id = $1`,
        [sessionId]
      );

      if (sessionExists.length === 0) {
        return res.status(404).json({ error: 'Session not found' });
      }
    }

    logger.debug(
      { sessionId, chunkCount: chunks.length },
      '[terminal] Returned scrollback buffer'
    );

    res.json({ chunks });
  } catch (err) {
    logger.error({ err, sessionId }, '[terminal] Failed to fetch scrollback');
    res.status(500).json({ error: 'Failed to fetch scrollback' });
  }
});

export default router;
