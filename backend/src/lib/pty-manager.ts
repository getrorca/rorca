// ─── OpenCode PTY Session Manager ───────────────────────────────────────────
// OCT-001: Manages persistent PTY sessions for OpenCode terminal UI.
// Each session is an isolated opencode process with its own workspace context.

import { spawn as ptySpawn, IPty } from 'node-pty';
import { randomUUID } from 'crypto';
import { detectOpenCode } from './opencode-detector';
import { logger } from './logger';
import { execute } from '../db/index';

export interface PtySession {
  sessionId: string;
  workspaceId: string;
  ptyProcess: IPty;
  createdAt: Date;
  lastActivityAt: Date;
  cwd: string;
  rows: number;
  cols: number;
  outputSequence: number; // OCT-005: monotonic counter for terminal_output_chunks
}

// In-memory session map — sessions are lost on backend restart
const sessions = new Map<string, PtySession>();

// OCT-005: Sequence counters for terminal_output_chunks (per session, in-memory)
// Reset to 1 on backend restart — DB sequences are preserved
const sequenceCounters = new Map<string, number>();

// Idle timeout configuration
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Claude env vars to strip (prevents nested agent spawning confusion)
const CLAUDE_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

/**
 * Spawn a new OpenCode PTY session.
 * Returns the unique session ID.
 */
export async function createSession(
  workspaceId: string,
  cwd: string,
  env: Record<string, string>,
  rows: number,
  cols: number
): Promise<string> {
  const status = detectOpenCode();

  if (!status.opencodeInstalled || !status.opencodeBinPath) {
    throw new Error('opencode binary not found — install via: npm i -g opencode-ai');
  }

  const sessionId = randomUUID();

  // OCT-005: Insert terminal_sessions row (status='active')
  await execute(
    `INSERT INTO terminal_sessions (session_id, workspace_id, cwd, rows, cols, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())`,
    [sessionId, workspaceId, cwd, rows, cols]
  ).catch((err) => {
    logger.error({ err, sessionId }, '[pty-manager] Failed to insert terminal_sessions row');
    throw err;
  });

  // Strip Claude env vars from environment
  const cleanEnv = { ...env };
  CLAUDE_ENV_VARS.forEach((key) => delete cleanEnv[key]);

  // Spawn opencode process with PTY
  const ptyProcess = ptySpawn(status.opencodeBinPath, [], {
    name: 'xterm-256color',
    rows,
    cols,
    cwd,
    env: cleanEnv,
  });

  const session: PtySession = {
    sessionId,
    workspaceId,
    ptyProcess,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    cwd,
    rows,
    cols,
    outputSequence: 0,
  };

  sessions.set(sessionId, session);
  sequenceCounters.set(sessionId, 0); // OCT-005: initialize sequence counter

  // OCT-005: Persist PTY output to terminal_output_chunks + update last_activity_at
  ptyProcess.onData((data) => {
    const s = sessions.get(sessionId);
    if (s) {
      s.lastActivityAt = new Date();

      // Increment sequence atomically
      const currentSeq = (sequenceCounters.get(sessionId) ?? 0) + 1;
      sequenceCounters.set(sessionId, currentSeq);
      s.outputSequence = currentSeq;

      // Insert chunk (fire-and-forget — do not await inline)
      execute(
        `INSERT INTO terminal_output_chunks (session_id, sequence, data, recorded_at)
         VALUES ($1, $2, $3, NOW())`,
        [sessionId, currentSeq, data]
      ).catch((err) => {
        logger.error({ err, sessionId, sequence: currentSeq }, '[pty-manager] Failed to persist output chunk');
      });

      // Update last_activity_at (fire-and-forget)
      execute(
        `UPDATE terminal_sessions SET last_activity_at = NOW() WHERE session_id = $1`,
        [sessionId]
      ).catch((err) => {
        logger.error({ err, sessionId }, '[pty-manager] Failed to update last_activity_at');
      });
    }
  });

  // OCT-005: Update terminal_sessions on process exit
  ptyProcess.onExit(({ exitCode, signal }) => {
    const status = signal ? 'killed' : 'exited';

    execute(
      `UPDATE terminal_sessions
       SET status = $1, exit_code = $2, exited_at = NOW()
       WHERE session_id = $3`,
      [status, exitCode, sessionId]
    ).catch((err) => {
      logger.error({ err, sessionId }, '[pty-manager] Failed to update terminal_sessions on exit');
    });

    sessions.delete(sessionId);
    sequenceCounters.delete(sessionId); // Clean up sequence counter
    logger.info(`[pty-manager] Session ${sessionId} ${status} with code ${exitCode}`);
  });

  logger.info(
    `[pty-manager] Created session ${sessionId} for workspace ${workspaceId} at ${cwd}`
  );

  return sessionId;
}

/**
 * Resize an existing PTY session.
 */
export function resizeSession(sessionId: string, rows: number, cols: number): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // node-pty resize signature: resize(cols, rows) — columns first!
  session.ptyProcess.resize(cols, rows);
  session.rows = rows;
  session.cols = cols;

  logger.debug(`[pty-manager] Resized session ${sessionId} to ${cols}x${rows}`);
}

/**
 * Kill a PTY session and remove it from the map.
 * OCT-005: Updates terminal_sessions.status = 'killed' before removal.
 */
export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    logger.warn(`[pty-manager] Attempted to kill non-existent session ${sessionId}`);
    return;
  }

  // OCT-005: Mark as killed in DB (fire-and-forget)
  execute(
    `UPDATE terminal_sessions
     SET status = 'killed', exited_at = NOW()
     WHERE session_id = $1`,
    [sessionId]
  ).catch((err) => {
    logger.error({ err, sessionId }, '[pty-manager] Failed to update terminal_sessions on kill');
  });

  session.ptyProcess.kill();
  sessions.delete(sessionId);
  sequenceCounters.delete(sessionId); // Clean up sequence counter

  logger.info(`[pty-manager] Killed session ${sessionId}`);
}

/**
 * Get a session by ID.
 */
export function getSession(sessionId: string): PtySession | undefined {
  return sessions.get(sessionId);
}

/**
 * Return all active sessions.
 */
export function activeSessions(): PtySession[] {
  return Array.from(sessions.values());
}

/**
 * Background cleanup: kill sessions idle for more than 30 minutes.
 * OCT-005: Also deletes terminal_output_chunks older than 24 hours.
 */
function cleanupIdleSessions(): void {
  const now = Date.now();
  const staleSessionIds: string[] = [];

  for (const [sessionId, session] of sessions.entries()) {
    const idleMs = now - session.lastActivityAt.getTime();
    if (idleMs > IDLE_TIMEOUT_MS) {
      staleSessionIds.push(sessionId);
    }
  }

  if (staleSessionIds.length > 0) {
    logger.info(
      `[pty-manager] Cleaning up ${staleSessionIds.length} idle sessions: ${staleSessionIds.join(', ')}`
    );
    staleSessionIds.forEach((id) => killSession(id));
  }

  // OCT-005: Delete chunks older than 24 hours (fire-and-forget)
  execute(
    `DELETE FROM terminal_output_chunks WHERE recorded_at < NOW() - INTERVAL '24 hours'`
  )
    .then(({ rowCount }) => {
      if (rowCount > 0) {
        logger.info(`[pty-manager] Deleted ${rowCount} terminal_output_chunks older than 24 hours`);
      }
    })
    .catch((err) => {
      logger.error({ err }, '[pty-manager] Failed to delete old terminal_output_chunks');
    });
}

// Start idle session cleanup interval
setInterval(cleanupIdleSessions, CLEANUP_INTERVAL_MS);

logger.info(
  `[pty-manager] Initialized with ${IDLE_TIMEOUT_MS / 1000}s idle timeout, cleanup every ${CLEANUP_INTERVAL_MS / 1000}s`
);
