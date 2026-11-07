/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Sandboxed, networkless probes for model/tool CLI version and help output. */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareAutonomousSandboxLaunch } from './autonomous-sandbox';
import {
  ordinaryLocalPiRuntimeProfileFromEnv,
  RorcaExecutionSandboxError,
  resolveExplicitLocalPiBinary,
  type RorcaExecutionSandboxMode,
} from './ordinary-local-pi-profile';

export interface AutonomousCliProbeResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function probeWorkspace(env: NodeJS.ProcessEnv): { cwd: string; cleanup: () => void } {
  // The execution engine already runs inside the worker-issued Darwin
  // Seatbelt profile. A nested compatibility probe must remain in that
  // profile's exact frozen worktree; using an unrelated mkdtemp checkout makes
  // the launch fail closed before `--version` or `--help` can run.
  const runtimeProfile = ordinaryLocalPiRuntimeProfileFromEnv(env);
  if (runtimeProfile) {
    return { cwd: fs.realpathSync(runtimeProfile.worktreePath), cleanup: () => {} };
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cli-probe-'));
  execFileSync('git', ['init', '--quiet'], {
    cwd,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

export interface AutonomousCliProbeOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Explicitly selected only for the frozen ordinary-local Pi profile. */
  sandboxMode?: RorcaExecutionSandboxMode;
}

function isDarwinPiProbeArgs(args: readonly string[]): boolean {
  const joined = args.join('\u0000');
  return joined === '--no-extensions\u0000--offline\u0000--version'
    || joined === '--list-models'
    || joined === '--no-extensions\u0000--list-models';
}

function prepareProbeLaunch(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  options: AutonomousCliProbeOptions,
) {
  if (options.sandboxMode !== 'darwin-local-pi') {
    return prepareAutonomousSandboxLaunch({ command, args, cwd, env });
  }

  const piBinPath = resolveExplicitLocalPiBinary(options.env);
  if (!piBinPath) {
    throw new RorcaExecutionSandboxError(
      'pi_not_installed',
      'pi_not_installed: Darwin ordinary-local probes require an executable absolute PI_BIN',
    );
  }
  let commandRealPath: string;
  try { commandRealPath = fs.realpathSync(command); } catch {
    throw new RorcaExecutionSandboxError('pi_not_installed', 'pi_not_installed: configured PI_BIN is unavailable');
  }
  let piRealPath: string;
  try { piRealPath = fs.realpathSync(piBinPath); } catch {
    throw new RorcaExecutionSandboxError('pi_not_installed', 'pi_not_installed: configured PI_BIN is unavailable');
  }
  if (commandRealPath !== piRealPath || !isDarwinPiProbeArgs(args)) {
    throw new RorcaExecutionSandboxError(
      'unsupported_sandbox_mode',
      'unsupported_sandbox_mode: the Darwin local probe is restricted to Pi version/model discovery',
    );
  }
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    throw new RorcaExecutionSandboxError(
      'unsupported_sandbox_mode',
      'unsupported_sandbox_mode: the Darwin no-network Pi probe sandbox is unavailable',
    );
  }

  // Pi discovery is host-appropriate but still networkless. The actual model
  // run is authorized separately by the worker-issued frozen local profile.
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-n', 'no-network', piBinPath, ...args],
    cwd,
    env: {
      PATH: `${path.dirname(piBinPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: String(options.env?.HOME ?? process.env.HOME ?? os.homedir()),
      ...(options.env?.LANG ? { LANG: options.env.LANG } : {}),
      ...(options.env?.LC_ALL ? { LC_ALL: options.env.LC_ALL } : {}),
      ...(options.env?.LC_CTYPE ? { LC_CTYPE: options.env.LC_CTYPE } : {}),
      PI_OFFLINE: '1',
    },
    isolated: true,
  };
}

export function probeAutonomousCliSync(
  command: string,
  args: readonly string[],
  options: AutonomousCliProbeOptions = {},
): AutonomousCliProbeResult {
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const workspace = probeWorkspace(env);
  try {
    const launch = prepareProbeLaunch(command, args, workspace.cwd, env, options);
    const result = spawnSync(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 2_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    workspace.cleanup();
  }
}

export async function probeAutonomousCli(
  command: string,
  args: readonly string[],
  options: AutonomousCliProbeOptions = {},
): Promise<AutonomousCliProbeResult> {
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const workspace = probeWorkspace(env);
  try {
    const launch = prepareProbeLaunch(command, args, workspace.cwd, env, options);
    let resolveProbe!: (result: AutonomousCliProbeResult) => void;
    const promise = new Promise<AutonomousCliProbeResult>((resolve) => {
      resolveProbe = resolve;
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (status: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe({ status, signal, stdout, stderr, ...(error ? { error } : {}) });
    };
    child.stdout?.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    child.once('error', error => finish(null, null, error));
    child.once('close', (status, signal) => finish(status, signal));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, 'SIGKILL', new Error('Autonomous CLI probe timed out'));
    }, options.timeoutMs ?? 2_000);
    timer.unref();
    return await promise;
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    workspace.cleanup();
  }
}
