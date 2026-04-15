// ─── OpenCode PTY Session Manager ───────────────────────────────────────────
// OCT-001: Manages persistent PTY sessions for OpenCode terminal UI.
// Each session is an isolated opencode process with its own workspace context.

import { spawn as ptySpawn, IPty } from 'node-pty';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { detectOpenCode } from './opencode-detector';
import { logger } from './logger';

export interface PtySession {
  sessionId: string;
  workspaceId: number;
  ptyProcess: IPty;
  createdAt: Date;
  lastActivityAt: Date;
  cwd: string;
  rows: number;
  cols: number;
  shellIntegration?: ShellIntegrationState;
  osc133State?: Osc133ParserState;
}

export interface ShellEvent {
  type: 'shell_event';
  event: 'command_end';
  exitCode: number;
  durationMs: number;
}

interface ShellIntegrationState {
  tempDir: string;
}

interface ShellLaunchConfig {
  env: Record<string, string>;
  command: string;
  args: string[];
  state?: ShellIntegrationState;
}

interface Osc133ParserState {
  pending: string;
  commandStartedAt?: number;
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

const OSC_TERMINATORS = ['\u0007', '\u001b\\'];

async function setupShellIntegration(
  env: Record<string, string>
): Promise<ShellLaunchConfig> {
  const shellPath = env.SHELL || process.env.SHELL || '';
  const shellName = path.basename(shellPath);
  const nextEnv = { ...env, RORCA_SHELL_INTEGRATION: '1' };

  if (shellName.includes('bash')) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rorca-shell-bash-'));
    const integrationPath = path.join(tempDir, 'rorca-shell-integration.sh');
    const rcPath = path.join(tempDir, '.bashrc');
    const userRcPath = env.HOME ? path.join(env.HOME, '.bashrc') : '';

    await fs.writeFile(integrationPath, buildShellIntegrationScript('bash'), 'utf8');
    await fs.writeFile(
      rcPath,
      `${buildSourceLine(integrationPath)}\n${buildSourceLine(userRcPath)}\n`,
      'utf8'
    );

    return {
      env: nextEnv,
      command: shellPath,
      args: ['--rcfile', rcPath, '-i'],
      state: { tempDir },
    };
  }

  if (shellName.includes('zsh')) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rorca-shell-zsh-'));
    const integrationPath = path.join(tempDir, 'rorca-shell-integration.sh');
    const zshenvPath = path.join(tempDir, '.zshenv');
    const zshrcPath = path.join(tempDir, '.zshrc');
    const userRcPath = env.ZDOTDIR
      ? path.join(env.ZDOTDIR, '.zshrc')
      : env.HOME
        ? path.join(env.HOME, '.zshrc')
        : '';

    await fs.writeFile(integrationPath, buildShellIntegrationScript('zsh'), 'utf8');
    await fs.writeFile(zshenvPath, `export RORCA_ORIGINAL_ZDOTDIR=${shellEscape(env.ZDOTDIR || '')}\n`, 'utf8');
    await fs.writeFile(
      zshrcPath,
      `${buildSourceLine(integrationPath)}\n${buildSourceLine(userRcPath)}\n`,
      'utf8'
    );

    return {
      env: { ...nextEnv, ZDOTDIR: tempDir },
      command: shellPath,
      args: ['-i'],
      state: { tempDir },
    };
  }

  logger.debug({ shellPath }, '[pty-manager] Shell integration skipped for unsupported shell');
  return { env: nextEnv, command: '', args: [], state: undefined };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildSourceLine(targetPath: string): string {
  if (!targetPath) return '';
  return `[ -f ${shellEscape(targetPath)} ] && source ${shellEscape(targetPath)}`;
}

function buildShellIntegrationScript(shell: 'bash' | 'zsh'): string {
  const common = `
rorca_emit_prompt_start() { printf '\\033]133;A\\007'; }
rorca_emit_prompt_end() { printf '\\033]133;B\\007'; }
rorca_emit_output_start() { printf '\\033]133;C\\007'; }
rorca_emit_command_end() {
  local exit_code="$1"
  printf '\\033]133;D;%s\\007' "$exit_code"
}
`;

  if (shell === 'bash') {
    return `${common}
__rorca_last_exit=0
__rorca_preexec() {
  __rorca_last_exit=$?
  rorca_emit_command_end "$__rorca_last_exit"
  rorca_emit_output_start
}
__rorca_precmd() {
  local last_exit=$?
  rorca_emit_prompt_start
  rorca_emit_prompt_end
  __rorca_last_exit=$last_exit
}
if [[ -n "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND="__rorca_preexec; $PROMPT_COMMAND; __rorca_precmd"
else
  PROMPT_COMMAND="__rorca_preexec; __rorca_precmd"
fi
`;
  }

  return `${common}
autoload -Uz add-zsh-hook
rorca_precmd_hook() {
  local exit_code=$?
  rorca_emit_command_end "$exit_code"
  rorca_emit_prompt_start
  rorca_emit_prompt_end
}
rorca_preexec_hook() {
  rorca_emit_output_start
}
add-zsh-hook preexec rorca_preexec_hook
add-zsh-hook precmd rorca_precmd_hook
`;
}

async function cleanupShellIntegration(state?: ShellIntegrationState): Promise<void> {
  if (!state) return;
  try {
    await fs.rm(state.tempDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, tempDir: state.tempDir }, '[pty-manager] Failed to clean temp shell integration dir');
  }
}

export function parseOsc133Chunk(
  input: string,
  state?: Osc133ParserState
): { cleanData: string; events: ShellEvent[]; state: Osc133ParserState } {
  const nextState: Osc133ParserState = state ?? { pending: '' };
  let buffer = `${nextState.pending}${input}`;
  let cleanData = '';
  const events: ShellEvent[] = [];
  nextState.pending = '';

  while (buffer.length > 0) {
    const oscIndex = buffer.indexOf('\u001b]133;');
    if (oscIndex === -1) {
      cleanData += buffer;
      buffer = '';
      break;
    }

    cleanData += buffer.slice(0, oscIndex);
    buffer = buffer.slice(oscIndex);

    const bellIndex = buffer.indexOf('\u0007');
    const stIndex = buffer.indexOf('\u001b\\');
    const terminatorIndex = [bellIndex, stIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];

    if (terminatorIndex === undefined) {
      nextState.pending = buffer;
      buffer = '';
      break;
    }

    const terminator = OSC_TERMINATORS.find((token) => buffer.startsWith(token, terminatorIndex)) ?? '\u0007';
    const sequence = buffer.slice(0, terminatorIndex);
    buffer = buffer.slice(terminatorIndex + terminator.length);

    const payload = sequence.slice('\u001b]133;'.length);
    const parts = payload.split(';');
    const kind = parts[0];

    if (kind === 'B' || kind === 'C') {
      nextState.commandStartedAt = Date.now();
    }

    if (kind === 'D') {
      const exitCode = Number.parseInt(parts[1] ?? '1', 10);
      const durationMs = nextState.commandStartedAt ? Math.max(0, Date.now() - nextState.commandStartedAt) : 0;
      nextState.commandStartedAt = undefined;
      events.push({
        type: 'shell_event',
        event: 'command_end',
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
        durationMs,
      });
    }
  }

  return { cleanData, events, state: nextState };
}

/**
 * Spawn a new OpenCode PTY session.
 * Returns the unique session ID.
 */
export async function createSession(
  workspaceId: number,
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

  const shellIntegration = await setupShellIntegration(cleanEnv);

  // Spawn opencode process with PTY
  const spawnCommand = shellIntegration.command || status.opencodeBinPath;
  const spawnArgs = shellIntegration.command
    ? [...shellIntegration.args, '-c', `${shellEscape(status.opencodeBinPath)} --continue`]
    : [];
  const ptyProcess = ptySpawn(spawnCommand, spawnArgs, {
    name: 'xterm-256color',
    rows,
    cols,
    cwd,
    env: shellIntegration.env,
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
    shellIntegration: shellIntegration.state,
    osc133State: { pending: '' },
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
    void cleanupShellIntegration(session.shellIntegration);
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
