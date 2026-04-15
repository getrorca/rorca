```typescript
// ─── OpenCode PTY Session Manager ───────────────────────────────────────────
// OCT-001: Manages persistent PTY sessions for OpenCode terminal UI.
// Each session is an isolated opencode process with its own workspace context.

import { randomUUID } from 'crypto';
import { detectOpenCode } from './opencode-detector';
import { logger } from './logger';

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
  workspaceId: string;
  ptyProcess: any; // IPty when available, null otherwise
  createdAt: Date;
  lastActivityAt: Date;
  cwd: string;
  rows: number;
  cols: number;
}

// In-memory session map — sessions are lost on backend restart
const sessions = new Map<string, PtySession>();

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
  // OCT-024: Check if node-pty is available before proceeding
  if (!PTY_AVAILABLE || !ptySpawn) {
    throw {
      code: 'PTY_NOT_AVAILABLE',
      message: 'node-pty native module not loaded. Run: cd backend && npm rebuild node-pty',
    };
  }

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
  };

  sessions.set(sessionId, session);

  // Update lastActivityAt on every data event to reset idle timer
  ptyProcess.onData(() => {
    const s = sessions.get(sessionId);
    if (s) {
      s.lastActivityAt = new Date();
    }
  });

  // Clean up session when process exits
  ptyProcess.onExit(() => {
    sessions.delete(sessionId);
    logger.info(`[pty-manager] Session ${sessionId} exited and removed`);
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
  sessions.delete(sessionId);

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

export function killSessionsForWorkspace(workspaceId: string): void {
  const sessionIds = activeSessions()
    .filter((session) => session.workspaceId === workspaceId)
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

// Start idle session cleanup interval
setInterval(cleanupIdleSessions, CLEANUP_INTERVAL_MS);

logger.info(
  `[pty-manager] Initialized with ${IDLE_TIMEOUT_MS / 1000}s idle timeout, cleanup every ${CLEANUP_INTERVAL_MS / 1000}s`
);
```
