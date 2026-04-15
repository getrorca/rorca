// ─── OpenCode PTY Session Manager ───────────────────────────────────────────
// OCT-001: Manages persistent PTY sessions for OpenCode terminal UI.
// Each session is an isolated opencode process with its own workspace context.

import { spawn as ptySpawn, IPty } from 'node-pty';
import { randomUUID } from 'crypto';
import { detectOpenCode } from './opencode-detector';
import { execute, transaction } from '../db/index';
import { logger } from './logger';

export interface PtySession {
  sessionId: string;
  workspaceId: string;
  ptyProcess: IPty;
  createdAt: Date;
  lastActivityAt: Date;
  cwd: string;
  rows: number;
  cols: number;
  nextSequence: number;
  pendingChunks: string[];
  pendingBytes: number;
  isFlushing: boolean;
  dbWriteDisabled: boolean;
  outputLimitSentinelInserted: boolean;
  totalOutputBytes: number;
}

// In-memory session map — sessions are lost on backend restart
const sessions = new Map<string, PtySession>();

// Idle timeout configuration
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FLUSH_INTERVAL_MS = 100;
const MAX_BUFFERED_CHUNKS = 50;
const MAX_SESSION_OUTPUT_BYTES = 100 * 1024 * 1024;
const OUTPUT_LIMIT_SENTINEL =
  '\r\n[Output limit reached — streaming continues but history is truncated]\r\n';

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
    nextSequence: 1,
    pendingChunks: [],
    pendingBytes: 0,
    isFlushing: false,
    dbWriteDisabled: false,
    outputLimitSentinelInserted: false,
    totalOutputBytes: 0,
  };

  await execute(
    `INSERT INTO terminal_sessions (session_id, workspace_id, cwd, rows, cols, status, total_output_bytes)
     VALUES ($1, $2, $3, $4, $5, 'active', 0)`,
    [sessionId, workspaceId, cwd, rows, cols]
  );

  sessions.set(sessionId, session);

  // Update lastActivityAt on every data event to reset idle timer
  ptyProcess.onData((data: string) => {
    const s = sessions.get(sessionId);
    if (s) {
      s.lastActivityAt = new Date();
      bufferOutputChunk(s, data);
    }
  });

  // Clean up session when process exits
  ptyProcess.onExit(async ({ exitCode }: { exitCode: number }) => {
    try {
      await flushSession(sessionId);
      await execute(
        `UPDATE terminal_sessions
         SET status = 'exited', exit_code = $2, exited_at = NOW(), last_activity_at = NOW()
         WHERE session_id = $1`,
        [sessionId, exitCode]
      );
    } catch (err) {
      logger.error({ err, sessionId }, '[pty-manager] Failed to flush session on exit');
    } finally {
      sessions.delete(sessionId);
      logger.info(`[pty-manager] Session ${sessionId} exited and removed`);
    }
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
 */
export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    logger.warn(`[pty-manager] Attempted to kill non-existent session ${sessionId}`);
    return;
  }

  session.ptyProcess.kill();
  void flushBufferedChunks(session)
    .then(() =>
      execute(
        `UPDATE terminal_sessions
         SET status = 'killed', exited_at = COALESCE(exited_at, NOW()), last_activity_at = NOW()
         WHERE session_id = $1`,
        [sessionId]
      )
    )
    .catch((err) => {
      logger.error({ err, sessionId }, '[pty-manager] Failed to flush session on kill');
    })
    .finally(() => {
      sessions.delete(sessionId);
    });

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
}

function bufferOutputChunk(session: PtySession, data: string): void {
  if (session.dbWriteDisabled) {
    return;
  }

  session.pendingChunks.push(data);
  session.pendingBytes += Buffer.byteLength(data, 'utf8');

  if (session.pendingChunks.length >= MAX_BUFFERED_CHUNKS) {
    void flushSession(session.sessionId);
  }
}

async function flushAllSessions(): Promise<void> {
  await Promise.all(Array.from(sessions.keys()).map((sessionId) => flushSession(sessionId)));
}

export async function flushSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.dbWriteDisabled) {
    return;
  }

  await flushBufferedChunks(session);
}

async function flushBufferedChunks(session: PtySession): Promise<void> {
  if (session.isFlushing || session.pendingChunks.length === 0) {
    return;
  }

  session.isFlushing = true;

  const chunks = [...session.pendingChunks];
  const bytes = session.pendingBytes;
  const startSequence = session.nextSequence;

  session.pendingChunks = [];
  session.pendingBytes = 0;
  session.nextSequence += chunks.length;

  try {
    await transaction(async (client) => {
      const valuesSql: string[] = [];
      const params: Array<string | number> = [];

      chunks.forEach((chunk, index) => {
        const paramOffset = index * 3;
        valuesSql.push(`($${paramOffset + 1}, $${paramOffset + 2}, $${paramOffset + 3})`);
        params.push(session.sessionId, startSequence + index, chunk);
      });

      await client.query(
        `INSERT INTO terminal_output_chunks (session_id, sequence, data)
         VALUES ${valuesSql.join(', ')}`,
        params
      );

      const updateResult = await client.query<{ total_output_bytes: string }>(
        `UPDATE terminal_sessions
         SET total_output_bytes = total_output_bytes + $2,
             last_activity_at = NOW()
         WHERE session_id = $1
         RETURNING total_output_bytes`,
        [session.sessionId, bytes]
      );

      const updatedTotal = Number(updateResult.rows[0]?.total_output_bytes ?? session.totalOutputBytes + bytes);
      session.totalOutputBytes = updatedTotal;

      if (updatedTotal > MAX_SESSION_OUTPUT_BYTES) {
        session.dbWriteDisabled = true;

        if (!session.outputLimitSentinelInserted) {
          await client.query(
            `INSERT INTO terminal_output_chunks (session_id, sequence, data)
             VALUES ($1, $2, $3)`,
            [session.sessionId, session.nextSequence, OUTPUT_LIMIT_SENTINEL]
          );
          session.nextSequence += 1;
          session.outputLimitSentinelInserted = true;
        }
      }
    });
  } catch (err) {
    session.pendingChunks = [...chunks, ...session.pendingChunks];
    session.pendingBytes += bytes;
    session.nextSequence = startSequence;
    throw err;
  } finally {
    session.isFlushing = false;
  }
}

// Start idle session cleanup interval
setInterval(cleanupIdleSessions, CLEANUP_INTERVAL_MS);
setInterval(() => {
  void flushAllSessions().catch((err) => {
    logger.error({ err }, '[pty-manager] Failed periodic terminal output flush');
  });
}, FLUSH_INTERVAL_MS);

logger.info(
  `[pty-manager] Initialized with ${IDLE_TIMEOUT_MS / 1000}s idle timeout, cleanup every ${CLEANUP_INTERVAL_MS / 1000}s`
);
