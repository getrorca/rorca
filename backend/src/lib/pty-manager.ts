
// ─── OpenCode PTY Session Manager ───────────────────────────────────────────
// OCT-001: Manages persistent PTY sessions for OpenCode terminal UI.
// Each session is an isolated opencode process with its own workspace context.

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { detectOpenCode } from './opencode-detector';
import { execute, queryOne, transaction } from '../db/index';
import { logger } from './logger';
import { TooManyRequestsError } from './errors';
import { runTerminalContextCleanup } from './terminal-context-cleanup';

// OCT-024: Graceful degradation when node-pty native module is not built
let ptySpawn: typeof import('node-pty').spawn | null = null;
let IPty: typeof import('node-pty').IPty | null = null;
let PTY_AVAILABLE = false;

try {
  const nodePty = require('node-pty');
  ptySpawn = nodePty.spawn;
  IPty = nodePty.IPty;
  PTY_AVAILABLE = true;
  logger.info('[pty-manager] node-pty native module loaded successfully');
} catch (err) {
  logger.warn(
    '[pty-manager] node-pty native module not available. Run: cd backend && npm rebuild node-pty'
  );
  logger.debug(`[pty-manager] node-pty load error: ${err instanceof Error ? err.message : String(err)}`);
}

export interface PtySession {
  sessionId: string;
  workspaceId: number;
  ptyProcess: any; // IPty when available, null otherwise
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
  sockets: Set<WebSocket>;
  shutdownNotified: boolean;
  shellIntegrationTempDir?: string;
  osc133Buffer: string;
  activeCommandStartedAt?: number;
  shellIntegrationEnabled: boolean;
}

export interface ShellEventMessage {
  type: 'shell_event';
  event: 'command_end';
  exitCode: number;
  durationMs: number;
}

const sessions = new Map<string, PtySession>();

// Idle timeout configuration
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FLUSH_INTERVAL_MS = 100;
const MAX_BUFFERED_CHUNKS = 50;
const MAX_SESSIONS = parseInt(process.env.TERMINAL_MAX_SESSIONS || '20', 10);
const MAX_SESSION_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_MESSAGE_BYTES = 1_048_576;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_SENTINEL =
  '\r\n[Output limit reached — streaming continues but history is truncated]\r\n';

// Claude env vars to strip (prevents nested agent spawning confusion)
const CLAUDE_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

function getShellType(shellPath: string | undefined): 'bash' | 'zsh' | null {
  if (!shellPath) return null;
  const base = path.basename(shellPath).toLowerCase();
  if (base.includes('bash')) return 'bash';
  if (base.includes('zsh')) return 'zsh';
  return null;
}

async function createShellIntegrationTemp(shellPath: string | undefined): Promise<{
  shellArgs: string[];
  envPatch: Record<string, string>;
  tempDir?: string;
  enabled: boolean;
}> {
  const shellType = getShellType(shellPath);
  if (!shellType) {
    logger.debug({ shellPath }, '[pty-manager] Skipping shell integration for unsupported shell');
    return { shellArgs: [], envPatch: {}, enabled: false };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rorca-shell-'));
  const integrationPath = path.join(tempDir, 'rorca-shell-integration.sh');
  const bashRcPath = path.join(tempDir, '.bashrc');
  const zshRcPath = path.join(tempDir, '.zshrc');
  const homeDir = process.env.HOME || os.homedir();

  const integrationScript = `export RORCA_SHELL_INTEGRATION=1
__rorca_prompt_start() { printf '\\033]133;A\\007'; }
__rorca_prompt_end() { printf '\\033]133;B\\007'; }
__rorca_output_start() { printf '\\033]133;C\\007'; }
__rorca_command_end() { local exit_code="$?"; printf '\\033]133;D;%s\\007' "$exit_code"; }
`;

  await fs.writeFile(integrationPath, integrationScript, 'utf8');

  if (shellType === 'bash') {
    const userRc = process.env.BASH_ENV || path.join(homeDir, '.bashrc');
    const bashRc = `source '${integrationPath}'\nif [ -f '${userRc}' ]; then source '${userRc}'; fi\nPROMPT_COMMAND="__rorca_output_start; __rorca_command_end${'${PROMPT_COMMAND:+; }'}${PROMPT_COMMAND}"\nPS1="\\[\\033]133;A\\007\\]${'${PS1:-\\u@\\h:\\w\\$ }'}\\[\\033]133;B\\007\\]"\n`;
    await fs.writeFile(bashRcPath, bashRc, 'utf8');
    return {
      shellArgs: ['--rcfile', bashRcPath, '-i'],
      envPatch: { RORCA_SHELL_INTEGRATION: '1' },
      tempDir,
      enabled: true,
    };
  }

  const userRc = process.env.ZDOTDIR ? path.join(process.env.ZDOTDIR, '.zshrc') : path.join(homeDir, '.zshrc');
  const zshRc = `source '${integrationPath}'\nif [ -f '${userRc}' ]; then source '${userRc}'; fi\nprecmd_functions+=(__rorca_prompt_start __rorca_command_end)\npreexec_functions+=(__rorca_prompt_end __rorca_output_start)\n`;
  await fs.writeFile(zshRcPath, zshRc, 'utf8');
  return {
    shellArgs: ['-i'],
    envPatch: { RORCA_SHELL_INTEGRATION: '1', ZDOTDIR: tempDir },
    tempDir,
    enabled: true,
  };
}

function parseOsc133Chunk(session: PtySession, chunk: string): { cleanData: string; shellEvents: ShellEventMessage[] } {
  const shellEvents: ShellEventMessage[] = [];
  let data = session.osc133Buffer + chunk;
  session.osc133Buffer = '';
  let cleanData = '';
  let index = 0;

  while (index < data.length) {
    const start = data.indexOf('\u001b]133;', index);
    if (start === -1) {
      cleanData += data.slice(index);
      break;
    }

    cleanData += data.slice(index, start);
    const terminator = data.indexOf('\u0007', start);
    if (terminator === -1) {
      session.osc133Buffer = data.slice(start);
      break;
    }

    const payload = data.slice(start + 6, terminator);
    if (payload === 'A') {
      // prompt start
    } else if (payload === 'B' || payload === 'C') {
      session.activeCommandStartedAt = Date.now();
    } else if (payload.startsWith('D;')) {
      const exitCode = Number.parseInt(payload.slice(2), 10);
      const startedAt = session.activeCommandStartedAt ?? Date.now();
      shellEvents.push({
        type: 'shell_event',
        event: 'command_end',
        exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      session.activeCommandStartedAt = undefined;
    }

    index = terminator + 1;
  }

  return { cleanData, shellEvents };
}

function emitTerminalSessionEnded(session: PtySession, exitCode: number | null): void {
  const port = process.env.PORT || '3030';
  const durationMs = Date.now() - session.createdAt.getTime();

  fetch(`http://localhost:${port}/api/wal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'terminal_session_ended',
      workspace_id: String(session.workspaceId),
      spec_id: null,
      payload: {
        sessionId: session.sessionId,
        exitCode,
        durationMs,
      },
    }),
  }).catch((error) => {
    logger.warn(
      `[pty-manager] Failed to emit terminal_session_ended WAL event for session ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
  });
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

export async function flushSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.dbWriteDisabled) {
    return;
  }

  await flushBufferedChunks(session);
}

async function flushAllSessions(): Promise<void> {
  await Promise.all(Array.from(sessions.keys()).map((sessionId) => flushSession(sessionId)));
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

export async function createSession(
  workspaceId: string,
  cwd: string,
  env: Record<string, string>,
  rows: number,
  cols: number
): Promise<string> {
  // OCT-024: Check if node-pty is available before proceeding
  if (!PTY_AVAILABLE || !ptySpawn) {
    throw {
      code: 'PTY_NOT_AVAILABLE',
      message: 'node-pty native module not loaded. Run: cd backend && npm rebuild node-pty',
    };
  }

  if (activeSessions().length >= MAX_SESSIONS) {
    throw new TooManyRequestsError('Maximum terminal sessions reached');
  }

  const status = detectOpenCode();
  if (!status.opencodeInstalled || !status.opencodeBinPath) {
    throw new Error('opencode binary not found — install via: npm i -g opencode-ai');
  }

  const sessionId = randomUUID();
  const cleanEnv = { ...env };
  CLAUDE_ENV_VARS.forEach((key) => delete cleanEnv[key]);
  const shellPath = cleanEnv.SHELL || process.env.SHELL;
  const { shellArgs, envPatch, tempDir, enabled } = await createShellIntegrationTemp(shellPath);

  const existingMax = await queryOne<{ max_seq: number | null }>(
    'SELECT MAX(sequence) AS max_seq FROM terminal_output_chunks WHERE session_id = $1',
    [sessionId]
  );

  const spawnCommand = shellPath || status.opencodeBinPath;
  const spawnArgs = enabled ? shellArgs : [];
  const ptyProcess = ptySpawn(spawnCommand, spawnArgs, {
    name: 'xterm-256color',
    rows,
    cols,
    cwd,
    env: { ...cleanEnv, ...envPatch },
  });

  const session: PtySession = {
    sessionId,
    workspaceId: Number(workspaceId),
    ptyProcess,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    cwd,
    rows,
    cols,
    nextSequence: (existingMax?.max_seq ?? 0) + 1,
    pendingChunks: [],
    pendingBytes: 0,
    isFlushing: false,
    dbWriteDisabled: false,
    outputLimitSentinelInserted: false,
    totalOutputBytes: 0,
    sockets: new Set<WebSocket>(),
    shutdownNotified: false,
    shellIntegrationTempDir: tempDir,
    osc133Buffer: '',
    shellIntegrationEnabled: enabled,
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
    const current = sessions.get(sessionId);
    if (!current || current.shutdownNotified) return;

    try {
      await runTerminalContextCleanup(sessionId);
      await flushSession(sessionId);
      await execute(
        `UPDATE terminal_sessions
         SET status = 'exited', exit_code = $2, exited_at = NOW(), last_activity_at = NOW()
         WHERE session_id = $1`,
        [sessionId, exitCode]
      );
      emitTerminalSessionEnded(session, exitCode ?? null);
      notifySocketsExit(current, exitCode ?? 0);
      closeSockets(current);
    } catch (err) {
      logger.error({ err, sessionId }, '[pty-manager] Failed to flush session on exit');
    } finally {
      if (current.shellIntegrationTempDir) {
        await fs.rm(current.shellIntegrationTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      sessions.delete(sessionId);
      logger.info(`[pty-manager] Session ${sessionId} exited and removed`);
    }
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
  void runTerminalContextCleanup(sessionId)
    .catch((err) => {
      logger.warn({ err, sessionId }, '[pty-manager] Failed terminal context cleanup on kill');
    })
    .then(() => flushBufferedChunks(session))
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
      try {
        session.ptyProcess.kill();
      } catch {}
      notifySocketsExit(session, -1);
      closeSockets(session);
      sessions.delete(sessionId);
    });

  logger.info(`[pty-manager] Killed session ${sessionId}`);
}

export function getSession(sessionId: string): PtySession | undefined {
  return sessions.get(sessionId);
}

export function processSessionOutput(sessionId: string, chunk: string): { cleanData: string; shellEvents: ShellEventMessage[] } {
  const session = sessions.get(sessionId);
  if (!session) {
    return { cleanData: chunk, shellEvents: [] };
  }
  return parseOsc133Chunk(session, chunk);
}

export function activeSessions(): PtySession[] {
  return Array.from(sessions.values());
}

export function killSessionsForWorkspace(workspaceId: string): void {
  const sessionIds = activeSessions()
    .filter((session) => session.workspaceId === Number(workspaceId))
    .map((session) => session.sessionId);

  for (const sessionId of sessionIds) {
    try {
      killSession(sessionId);
    } catch (error) {
      logger.warn(
        `[pty-manager] Failed to kill session ${sessionId} for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export function isSessionDbWriteDisabled(sessionId: string): boolean {
  return sessions.get(sessionId)?.dbWriteDisabled ?? false;
}

export function isInputTooLarge(rawMessage: Buffer | string): boolean {
  return Buffer.byteLength(rawMessage) > MAX_INPUT_MESSAGE_BYTES;
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
  await flushSession(session.sessionId);
  await execute(
    `UPDATE terminal_sessions
     SET status = 'killed', exit_code = -1, exited_at = NOW(), last_activity_at = NOW()
     WHERE session_id = $1`,
    [session.sessionId]
  );
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
        } catch {}
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
