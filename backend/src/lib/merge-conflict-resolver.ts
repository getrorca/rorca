/**
 * Configured semantic merge resolver. It deliberately has no default/fallback
 * agent: a merge must be resolved by the posture which produced its changes.
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createAutonomousCommandGuard } from './autonomous-command-guard';
import { getClaudeAuthState } from './claude-auth';
import { getCodexAuthState } from './codex-auth';
import { detectOpenCode } from './opencode-detector';
import { detectPi, listPiModels } from './pi-detector';
import { logger } from './logger';
import { normalizeOpenCodeModel, shouldResolvePiRpcStory } from './agent-completion-protocol';

export type ResolverAgent = 'claude' | 'opencode' | 'codex' | 'pi';
export type ResolverReason = 'not_ready' | 'timeout' | 'agent_exit' | 'validation_failed' | 'spawn_error';
export type ResolverPostureSource = 'story' | 'run' | 'manual-retry';

export interface MergeResolutionPosture {
  agent: ResolverAgent;
  model: string | null;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  source: ResolverPostureSource;
}

export interface MergeResolutionRequest {
  runId: number;
  storyId?: string;
  workspaceId: string;
  cwd: string;
  branchName: string;
  conflictFiles: string[];
  logPath: string;
  posture: MergeResolutionPosture;
  /** Ephemeral provider variables from an active worker payload. Never persisted. */
  env?: Record<string, string>;
  /** Engine-specific validation (for example configured integration gates). */
  validate?: () => boolean | Promise<boolean>;
  /** Existing OpenCode server attachment supplied by the run, never inferred from env. */
  attachAddr?: string | null;
  timeoutMs?: number;
}

/** A semantic resolver may act only when all conflicting contributions share one posture. */
export function resolvePostureConsensus(postures: Array<MergeResolutionPosture | undefined>): MergeResolutionPosture | null {
  const defined = postures.filter((posture): posture is MergeResolutionPosture => posture !== undefined);
  if (defined.length === 0) return null;
  const key = (posture: MergeResolutionPosture) => JSON.stringify({
    agent: posture.agent, model: posture.model, thinkingEnabled: posture.thinkingEnabled ?? false,
    thinkingBudget: posture.thinkingBudget ?? null, effortLevel: posture.effortLevel ?? null,
  });
  return defined.every(posture => key(posture) === key(defined[0])) ? defined[0] : null;
}

export type MergeResolutionResult =
  | { ok: true; agent: ResolverAgent; model: string | null; resolvedFiles: string[]; elapsedMs: number }
  | { ok: false; agent: ResolverAgent; model: string | null; reason: ResolverReason; elapsedMs: number };

const CLAUDE_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
] as const;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const KILL_DELAY_MS = 10_000;

function binary(envName: string, fallback: string): string {
  if (process.env[envName]?.trim()) return process.env[envName]!;
  try { return execFileSync('which', [fallback], { encoding: 'utf8', timeout: 2_000 }).trim() || fallback; } catch { return fallback; }
}

/** Shared nested-agent environment policy. */
export function buildCleanResolverEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
    if (value !== undefined && !CLAUDE_ENV_VARS.includes(key as typeof CLAUDE_ENV_VARS[number])) clean[key] = value;
  }
  // Overrides must not be able to re-introduce nested-Claude state.
  for (const key of CLAUDE_ENV_VARS) delete clean[key];
  return clean;
}

function piSelection(model: string | null): { provider: string | null; model: string | null; ready: boolean } {
  if (!model?.trim()) return { provider: null, model: null, ready: true };
  const trimmed = model.trim().replace(/^pi\//, '');
  const slash = trimmed.indexOf('/');
  const provider = slash > 0 ? trimmed.slice(0, slash) : null;
  const selectedModel = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  const models = listPiModels(process.env.PI_BIN || 'pi');
  // A model list is unavailable for some authenticated providers. In that case
  // defer provider validation to Pi; do not change the requested posture.
  const ready = models.length === 0 || models.some(entry =>
    entry.model === selectedModel && (!provider || entry.provider === provider));
  return { provider, model: selectedModel, ready };
}

export function checkMergeResolverReadiness(posture: MergeResolutionPosture): boolean {
  switch (posture.agent) {
    case 'claude': {
      const state = getClaudeAuthState();
      return state.cliInstalled && state.connected;
    }
    case 'opencode':
      return detectOpenCode().opencodeInstalled;
    case 'codex': {
      const state = getCodexAuthState();
      return state.cliInstalled && state.connected;
    }
    case 'pi':
      return detectPi().piInstalled && piSelection(posture.model).ready;
  }
}

export function buildMergeResolverCommand(posture: MergeResolutionPosture): { command: string; args: string[] } {
  switch (posture.agent) {
    case 'claude': {
      const model = posture.model && /^claude-/.test(posture.model) && !posture.model.includes('/')
        ? posture.model.replace(/-(\d+)\.(\d+)(-\d{8})?$/, '-$1-$2$3') : null;
      return { command: binary('CLAUDE_BIN', 'claude'), args: ['--dangerously-skip-permissions', '--print', '--verbose', '--output-format', 'stream-json', ...(model ? ['--model', model] : []), ...(posture.thinkingEnabled ? ['--thinking'] : []), ...(posture.thinkingBudget ? ['--thinking-budget', String(posture.thinkingBudget)] : []), ...(posture.effortLevel ? ['--effort', posture.effortLevel] : [])] };
    }
    case 'opencode':
      return { command: detectOpenCode().opencodeBinPath ?? binary('OPENCODE_BIN', 'opencode'), args: ['run', '--format', 'json', ...(posture.model ? ['--model', normalizeOpenCodeModel(posture.model)] : [])] };
    case 'codex':
      return { command: binary('CODEX_BIN', 'codex'), args: ['exec', '--dangerously-bypass-approvals-and-sandbox', ...(posture.model ? ['--model', posture.model] : [])] };
    case 'pi': {
      const selection = piSelection(posture.model);
      return { command: binary('PI_BIN', 'pi'), args: ['--mode', 'rpc', '--no-extensions', '--tools', 'read,bash,edit,write,grep,find,ls', ...(selection.provider ? ['--provider', selection.provider] : []), ...(selection.model ? ['--model', selection.model] : [])] };
    }
  }
}

function runGit(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
}

function normalizedPathSet(paths: string[]): Set<string> | null {
  const result = new Set<string>();
  for (const raw of paths) {
    const value = raw.trim().replace(/\\/g, '/');
    if (!value || value.startsWith('/') || value === '..' || value.startsWith('../') || value.includes('/../')) return null;
    result.add(value);
  }
  return result;
}

function samePathSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(path => right.has(path));
}

/**
 * A semantic resolver is contained to the exact conflict set.  It may neither
 * smuggle unrelated staged files into the merge nor leave working-tree debris
 * behind for a later commit.
 */
export function validateGitResolution(request: MergeResolutionRequest): boolean {
  const allowed = normalizedPathSet(request.conflictFiles);
  if (!allowed || allowed.size !== request.conflictFiles.length) return false;
  const unmerged = runGit(request.cwd, ['ls-files', '-u']);
  const staged = runGit(request.cwd, ['diff', '--cached', '--name-only']);
  const unstaged = runGit(request.cwd, ['diff', '--name-only']);
  const untracked = runGit(request.cwd, ['ls-files', '--others', '--exclude-standard']);
  if ([unmerged, staged, unstaged, untracked].some(value => value === null)) return false;
  if (unmerged!.trim() || unstaged!.trim() || untracked!.trim()) return false;
  const stagedSet = normalizedPathSet(staged!.split('\n').filter(Boolean));
  if (!stagedSet || !samePathSet(stagedSet, allowed)) return false;
  return runGit(request.cwd, ['diff', '--cached', '--check']) !== null;
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch { /* fall back to the direct child */ }
  try { child.kill(signal); } catch { /* already gone */ }
}

function promptFor(request: MergeResolutionRequest): string {
  return [
    'Resolve the existing git merge conflict in-place.',
    `Only edit these unmerged files: ${request.conflictFiles.join(', ')}.`,
    'Use read/edit/bash tools. Preserve both sides where appropriate.',
    'Do not commit, abort the merge, create a worktree, change branches, or edit files outside that list.',
    'After editing, stage every listed file with git add. Finish only after git ls-files -u is empty and git diff --cached --check passes.',
  ].join('\n');
}

/**
 * Runs one configured agent against an already-conflicted merge. The caller owns
 * merge --abort and worktree removal policy, so failures never delete evidence.
 */
export async function resolveMergeConflict(request: MergeResolutionRequest): Promise<MergeResolutionResult> {
  const started = Date.now();
  const { posture } = request;
  const result = (reason: ResolverReason): MergeResolutionResult => ({ ok: false, agent: posture.agent, model: posture.model, reason, elapsedMs: Date.now() - started });
  if (!checkMergeResolverReadiness(posture)) {
    logger.warn({ runId: request.runId, storyId: request.storyId, agent: posture.agent, model: posture.model, source: posture.source, reason: 'not_ready' }, '[merge-resolver] unavailable');
    return result('not_ready');
  }

  fs.mkdirSync(path.dirname(request.logPath), { recursive: true });
  const env = createAutonomousCommandGuard({ cwd: request.cwd, env: buildCleanResolverEnv(request.env) }).env;
  const command = buildMergeResolverCommand(posture);
  if (posture.agent === 'opencode' && request.attachAddr) {
    command.args.splice(3, 0, '--attach', request.attachAddr);
  }
  const log = fs.createWriteStream(request.logPath, { flags: 'a' });
  log.write(`[merge-resolver] agent=${posture.agent} model=${posture.model ?? 'default'} source=${posture.source} files=${request.conflictFiles.join(',')}\n`);

  return new Promise<MergeResolutionResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command.command, command.args, {
        cwd: request.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Group ownership lets timeout cleanup kill tools/tests spawned by the resolver.
        detached: process.platform !== 'win32',
      });
    } catch {
      log.end();
      resolve(result('spawn_error'));
      return;
    }
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    let piCompleted = false;
    if (posture.agent === 'pi') {
      let piOutput = '';
      child.stdout?.on('data', (chunk: Buffer | string) => {
        piOutput += chunk.toString();
        const lines = piOutput.split('\n');
        piOutput = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as { type?: string };
            if (shouldResolvePiRpcStory(String(event.type ?? ''))) {
              piCompleted = true;
              terminateProcessGroup(child, 'SIGTERM');
            }
          } catch { /* Pi diagnostics are recorded in the resolution log */ }
        }
      });
    }
    const prompt = promptFor(request);
    if (posture.agent === 'pi') {
      // Pi RPC is the same configured execution surface used by stories.
      child.stdin?.write(JSON.stringify({ type: 'new_session', id: 'merge-session' }) + '\n');
      child.stdin?.write(JSON.stringify({ type: 'prompt', id: 'merge-prompt', message: prompt }) + '\n');
    } else {
      child.stdin?.write(prompt);
      child.stdin?.end();
    }

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      log.write('[merge-resolver] timeout; SIGTERM\n');
      terminateProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), KILL_DELAY_MS);
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let settled = false;
    const finish = async (reason?: ResolverReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      log.end(() => {
        if (reason) return resolve(result(reason));
        Promise.resolve(request.validate?.()).then(extraValid => {
          if (!validateGitResolution(request) || extraValid === false) return resolve(result('validation_failed'));
          resolve({ ok: true, agent: posture.agent, model: posture.model, resolvedFiles: request.conflictFiles, elapsedMs: Date.now() - started });
        }).catch(() => resolve(result('validation_failed')));
      });
    };
    child.once('error', () => { void finish('spawn_error'); });
    // close guarantees stdio/log writers are fully drained before result handling.
    child.once('close', (code) => { void finish(timedOut ? 'timeout' : (code === 0 || piCompleted) ? undefined : 'agent_exit'); });
  });
}
