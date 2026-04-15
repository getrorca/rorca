import { spawn as ptySpawn, IPty } from 'node-pty';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { detectOpenCode } from './opencode-detector';
import { logger } from './logger';
import { execute, queryOne } from '../db';

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
  pendingChunks: Array<{ sequence: number; data: string }>;
  flushPromise: Promise<void> | null;
  sockets: Set<WebSocket>;
  shutdownNotified: boolean;
}

const sessions = new Map<string, PtySession>();
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CLAUDE_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

async function persistSessionRow(session: PtySession): Promise<void> {
  await execute(
    `INSERT INTO terminal_sessions (session_id, workspace_id, cwd, rows, cols, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
     ON CONFLICT (session_id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id,
           cwd = EXCLUDED.cwd,
           rows = EXCLUDED.rows,
           cols = EXCLUDED.cols,
           status = 'active',
           last_activity_at = EXCLUDED.last_activity_at`,
    [
      session.sessionId,
      session.workspaceId,
      session.cwd,
      session.rows,
      session.cols,
      session.createdAt,
      session.lastActivityAt,
    ]
  );
}

async function appendChunks(sessionId: string, chunks: Array<{ sequence: number; data: string }>): Promise<void> {
  if (chunks.length === 0) return;

  const valuesSql = chunks
    .map((_, index) => {
      const base = index * 3;
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    })
    .join(', ');
  const params = chunks.flatMap((chunk) => [sessionId, chunk.sequence, chunk.data]);

  await execute(
    `INSERT INTO terminal_output_chunks (session_id, sequence, data)
     VALUES ${valuesSql}
     ON CONFLICT (session_id, sequence) DO NOTHING`,
    params
  );
}

export async function flushPendingOutput(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.flushPromise) {
    await session.flushPromise;
    return;
  }

  const chunks = session.pendingChunks.splice(0, session.pendingChunks.length);
  if (chunks.length === 0) return;

  session.flushPromise = appendChunks(sessionId, chunks)
    .catch((err) => {
      logger.error({ err, sessionId }, '[pty-manager] Failed to flush terminal output chunks');
      session.pendingChunks.unshift(...chunks);
      throw err;
    })
    .finally(() => {
      const current = sessions.get(sessionId);
      if (current) {
        current.flushPromise = null;
      }
    });

  await session.flushPromise;
}

function enqueueOutput(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (!session || data.length === 0) return;
  session.pendingChunks.push({ sequence: session.nextSequence++, data });
}

async function updateSessionExit(
  sessionId: string,
  status: 'exited' | 'killed',
  exitCode: number | null
): Promise<void> {
  await execute(
    `UPDATE terminal_sessions
        SET status = $2,
            exit_code = $3,
            exited_at = NOW(),
            last_activity_at = NOW()
      WHERE session_id = $1`,
    [sessionId, status, exitCode]
  );
}

function notifySocketsExit(session: PtySession, exitCode: number): void {
  const payload = JSON.stringify({ type: 'exit', exitCode });
  session.sockets.forEach((socket) => {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    } catch (err) {
      logger.warn({ err, sessionId: session.sessionId }, '[pty-manager] Failed to notify socket of exit');
    }
  });
}

function closeSockets(session: PtySession): void {
  session.sockets.forEach((socket) => {
    try {
      socket.close();
    } catch (err) {
      logger.warn({ err, sessionId: session.sessionId }, '[pty-manager] Failed to close socket');
    }
  });
  session.sockets.clear();
}

async function finalizeSession(sessionId: string, status: 'exited' | 'killed', exitCode: number): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  await flushPendingOutput(sessionId);
  await updateSessionExit(sessionId, status, exitCode);
  notifySocketsExit(session, exitCode);
  closeSockets(session);
  sessions.delete(sessionId);
}

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
  const cleanEnv = { ...env };
  CLAUDE_ENV_VARS.forEach((key) => delete cleanEnv[key]);

  const existingMax = await queryOne<{ max_seq: number | null }>(
    'SELECT MAX(sequence) AS max_seq FROM terminal_output_chunks WHERE session_id = $1',
    [sessionId]
  );

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
    nextSequence: (existingMax?.max_seq ?? 0) + 1,
    pendingChunks: [],
    flushPromise: null,
    sockets: new Set<WebSocket>(),
    shutdownNotified: false,
  };

  sessions.set(sessionId, session);
  await persistSessionRow(session);

  ptyProcess.onData((data: string) => {
    const current = sessions.get(sessionId);
    if (!current) return;
    current.lastActivityAt = new Date();
    enqueueOutput(sessionId, data);
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    const current = sessions.get(sessionId);
    if (!current || current.shutdownNotified) return;
    void finalizeSession(sessionId, 'exited', exitCode ?? 0).catch((err) => {
      logger.error({ err, sessionId }, '[pty-manager] Failed to finalize exited session');
      sessions.delete(sessionId);
    });
  });

  logger.info(`[pty-manager] Created session ${sessionId} for workspace ${workspaceId} at ${cwd}`);
  return sessionId;
}

export function resizeSession(sessionId: string, rows: number, cols: number): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  session.ptyProcess.resize(cols, rows);
  session.rows = rows;
  session.cols = cols;

  void execute(
    'UPDATE terminal_sessions SET rows = $2, cols = $3, last_activity_at = NOW() WHERE session_id = $1',
    [sessionId, rows, cols]
  ).catch((err) => {
    logger.warn({ err, sessionId }, '[pty-manager] Failed to persist terminal resize');
  });

  logger.debug(`[pty-manager] Resized session ${sessionId} to ${cols}x${rows}`);
}

export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    logger.warn(`[pty-manager] Attempted to kill non-existent session ${sessionId}`);
    return;
  }

  session.shutdownNotified = true;
  void finalizeSession(sessionId, 'killed', -1)
    .catch((err) => {
      logger.error({ err, sessionId }, '[pty-manager] Failed to finalize killed session');
    })
    .finally(() => {
      try {
        session.ptyProcess.kill();
      } catch {
      }
      sessions.delete(sessionId);
    });

  logger.info(`[pty-manager] Killed session ${sessionId}`);
}

export function getSession(sessionId: string): PtySession | undefined {
  return sessions.get(sessionId);
}

export function activeSessions(): PtySession[] {
  return Array.from(sessions.values());
}

export function attachSocket(sessionId: string, socket: WebSocket): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  session.sockets.add(socket);
}

export function detachSocket(sessionId: string, socket: WebSocket): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.sockets.delete(socket);
}

async function shutdownSession(session: PtySession): Promise<void> {
  session.shutdownNotified = true;
  await flushPendingOutput(session.sessionId);
  await updateSessionExit(session.sessionId, 'killed', -1);
  notifySocketsExit(session, -1);
  closeSockets(session);
  try {
    session.ptyProcess.kill();
  } catch (err) {
    logger.warn({ err, sessionId: session.sessionId }, '[pty-manager] Failed to kill PTY during shutdown');
  }
  sessions.delete(session.sessionId);
}

export async function shutdownAll(): Promise<void> {
  const active = Array.from(sessions.values());
  if (active.length === 0) return;

  logger.info({ count: active.length }, '[pty-manager] shutdownAll — shutting down active PTY sessions');

  const shutdownWork = Promise.allSettled(active.map((session) => shutdownSession(session))).then(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      Array.from(sessions.values()).forEach((session) => {
        try {
          session.ptyProcess.kill();
        } catch {
        }
        closeSockets(session);
        sessions.delete(session.sessionId);
      });
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
  });

  await Promise.race([shutdownWork, timeout]);
}

function cleanupIdleSessions(): void {
  const now = Date.now();
  const staleSessionIds = Array.from(sessions.entries())
    .filter(([, session]) => now - session.lastActivityAt.getTime() > IDLE_TIMEOUT_MS)
    .map(([sessionId]) => sessionId);

  if (staleSessionIds.length > 0) {
    logger.info(`[pty-manager] Cleaning up ${staleSessionIds.length} idle sessions: ${staleSessionIds.join(', ')}`);
    staleSessionIds.forEach((id) => killSession(id));
  }
}

setInterval(cleanupIdleSessions, CLEANUP_INTERVAL_MS);
logger.info(`[pty-manager] Initialized with ${IDLE_TIMEOUT_MS / 1000}s idle timeout, cleanup every ${CLEANUP_INTERVAL_MS / 1000}s`);
