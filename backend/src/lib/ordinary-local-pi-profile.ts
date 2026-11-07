/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * The only non-Linux execution posture. It is intentionally narrower than the
 * autonomous sandbox: an operator-owned Pi binary may run on a Darwin host
 * only for either a frozen local-only branch workflow or an immutable bounded
 * TaskManifest PR workflow. Every other execution shape continues through the
 * Linux bwrap boundary.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ORDINARY_LOCAL_PI_PROFILE_ENV = 'RORCA_ORDINARY_LOCAL_PI_PROFILE';
export const ORDINARY_LOCAL_PI_PROFILE_VERSION = 'rorca.ordinary-local-pi/v3';

export type DarwinLocalPiPosture = 'ordinary-local-branch' | 'task-manifest-pr';

export type RorcaExecutionSandboxMode = 'linux-bwrap' | 'darwin-local-pi';
export type RorcaExecutionSandboxFailureCode =
  | 'pi_not_installed'
  | 'linux_bwrap_required_for_requested_mode'
  | 'unsupported_sandbox_mode';

export class RorcaExecutionSandboxError extends Error {
  constructor(
    readonly code: RorcaExecutionSandboxFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'RorcaExecutionSandboxError';
  }
}

export interface OrdinaryLocalPiProfileInput {
  /** A persisted/local-profile request; absence must fall back to Linux bwrap. */
  ordinaryLocalPiProfileRequested: boolean;
  agent: string;
  /** Route-side scan proves every story uses a sandbox-compatible local engine. */
  allRequiredAgentsOrdinaryLocal: boolean;
  /** Native PTY is admitted only when every executable story uses OMP. */
  allRequiredAgentsOmp: boolean;
  /** The run selects the complete non-excluded frozen story set. */
  allStoriesSelected: boolean;
  autoWorktree: boolean;
  worktreePath?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  autoMerge: boolean;
  mergeStrategy: string;
  deploy: boolean;
  externalSend: boolean;
  policyLocked: boolean;
  parallelism: number;
  orchestrationMode: string;
  terminalMode: string;
  executionEnvironment: string;
  taskManifestAuthority: boolean;
  readinessOverride: boolean;
  /** Require a concrete, separate host-created worktree (worker boundary). */
  requireConcreteWorktree?: boolean;
  /** Route-admitted executable identity; required by the worker revalidation path. */
  frozenPiExecutable?: FrozenPiExecutableIdentity;
  /** Fail closed for compatibility rows that predate executable freezing. */
  requireFrozenPiExecutable?: boolean;
  /** Test seams; production defaults to the host values. */
  platform?: NodeJS.Platform;
  sandboxExecAvailable?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface FrozenPiExecutableIdentity {
  /** Absolute launcher path selected by the admitting route. */
  piBinPath: string;
  /** Exact real target bound into immutable run authority. */
  piRealPath: string;
}

export interface ResolvedExecutionSandboxProfile {
  mode: RorcaExecutionSandboxMode;
  /** Explicit launcher path, retained to locate the matching Node runtime. */
  piBinPath?: string;
  /** Real target frozen at route/worker preflight to reject symlink drift. */
  piRealPath?: string;
  /** Exact Darwin authority shape; absent for Linux bwrap. */
  posture?: DarwinLocalPiPosture;
}

export interface OrdinaryLocalPiRuntimeProfile {
  schemaVersion: typeof ORDINARY_LOCAL_PI_PROFILE_VERSION;
  runId: number;
  workspacePath: string;
  worktreePath: string;
  branchName: string;
  piBinPath: string;
  piRealPath: string;
  /** Worker-created private host runtime; never stored in the model-writable worktree. */
  runtimeRoot: string;
  posture: DarwinLocalPiPosture;
}

function realExecutable(pathname: string): string | null {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return fs.realpathSync(pathname);
  } catch {
    return null;
  }
}

/**
 * Local Pi is deliberately never PATH-discovered. A managed service must name
 * the operator-selected binary explicitly so a changed PATH cannot redirect a
 * local-only run to an arbitrary executable.
 */
export function resolveExplicitLocalPiBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = String(env.PI_BIN ?? '').trim();
  if (!configured || !path.isAbsolute(configured)) return null;
  return realExecutable(configured) ? path.resolve(configured) : null;
}

export function freezePiExecutableIdentity(piBinPath: string): FrozenPiExecutableIdentity | null {
  if (!path.isAbsolute(piBinPath)) return null;
  const resolved = path.resolve(piBinPath);
  const real = realExecutable(resolved);
  return real ? { piBinPath: resolved, piRealPath: real } : null;
}

export function revalidateFrozenPiExecutableIdentity(
  frozen: FrozenPiExecutableIdentity,
): FrozenPiExecutableIdentity {
  if (!path.isAbsolute(frozen.piBinPath) || !path.isAbsolute(frozen.piRealPath)) {
    throw new RorcaExecutionSandboxError(
      'pi_not_installed',
      'pi_not_installed: immutable Pi executable identity is malformed',
    );
  }
  const current = freezePiExecutableIdentity(frozen.piBinPath);
  if (!current || current.piRealPath !== frozen.piRealPath) {
    throw new RorcaExecutionSandboxError(
      'pi_not_installed',
      'pi_not_installed: immutable Pi executable identity no longer matches its admitted realpath',
    );
  }
  return current;
}

function canonicalPath(value: string): string {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function pathsAreSeparate(workspacePath: string | null | undefined, worktreePath: string | null | undefined): boolean {
  if (!workspacePath || !worktreePath) return false;
  const workspace = canonicalPath(workspacePath);
  const worktree = canonicalPath(worktreePath);
  if (workspace === worktree) return false;
  return !workspace.startsWith(`${worktree}${path.sep}`)
    && !worktree.startsWith(`${workspace}${path.sep}`);
}

function localInvariantFailure(input: OrdinaryLocalPiProfileInput): string | null {
  if (!['pi', 'omp'].includes(input.agent) || !input.allRequiredAgentsOrdinaryLocal) {
    return 'the frozen run must use Pi or OMP for every executable story';
  }
  if (!input.allStoriesSelected) return 'the complete frozen story set is required';
  if (input.autoWorktree !== true) return 'an isolated worktree is required';
  if (input.autoMerge !== false) return 'auto-merge must be disabled';
  if (input.parallelism !== 1 || input.orchestrationMode !== 'sequential') return 'sequential single-worker execution is required';
  const terminalModeAllowed = input.terminalMode === 'ansi-html'
    || (input.agent === 'omp' && input.allRequiredAgentsOmp && input.terminalMode === 'native-pty');
  if (!terminalModeAllowed) return 'noninteractive ansi-html terminal mode or OMP-only native PTY is required';
  if (input.executionEnvironment !== 'remote-rorca') return 'the Rorca host execution environment is required';
  if (input.readinessOverride) return 'readiness override is not permitted';

  if (input.taskManifestAuthority) {
    if (input.mergeStrategy !== 'pr' && input.mergeStrategy !== 'draft-pr') return 'TaskManifest delivery requires PR or draft-PR strategy';
    if (input.deploy !== false || input.externalSend !== true || input.policyLocked !== true) {
      return 'TaskManifest PR authority must be policy-locked, deployment-disabled, and host-release-only';
    }
  } else {
    if (input.mergeStrategy !== 'branch-only') return 'ordinary local execution must remain branch-only';
    if (input.deploy !== false || input.externalSend !== false) return 'deployment and external-send authority must both be disabled';
    if (input.policyLocked) return 'ordinary local execution cannot acquire policy-locked authority';
  }

  if (input.requireConcreteWorktree) {
    if (!input.branchName) return 'a frozen isolated-worktree branch is required';
    if (!pathsAreSeparate(input.workspacePath, input.worktreePath)) return 'the concrete worktree must be separate from the workspace checkout';
  }
  return null;
}

/**
 * Resolve the only allowed host-appropriate alternative to bwrap. Linux still
 * uses bwrap even for a local-only run; Darwin may use the narrowly scoped Pi
 * profile after every immutable local-only invariant has been proven.
 */
export function resolveRorcaExecutionSandboxProfile(
  input: OrdinaryLocalPiProfileInput,
): ResolvedExecutionSandboxProfile {
  const platform = input.platform ?? process.platform;
  const failedInvariant = localInvariantFailure(input);
  // A request carrying the ordinary/TaskManifest profile marker must satisfy
  // its immutable authority on Linux too. bwrap remains the Linux primitive,
  // but it must not make forbidden queued authority durable by skipping these
  // invariants. On Darwin there is no bwrap, so the same refusal is reported
  // as an unsupported execution shape instead of demanding a Linux primitive.
  if (input.ordinaryLocalPiProfileRequested && failedInvariant) {
    throw new RorcaExecutionSandboxError(
      platform === 'darwin' ? 'unsupported_sandbox_mode' : 'linux_bwrap_required_for_requested_mode',
      platform === 'darwin'
        ? `unsupported_sandbox_mode: on Darwin the only sanctioned execution shape is the ordinary local Pi profile (${failedInvariant})`
        : `linux_bwrap_required_for_requested_mode: ${failedInvariant}`,
    );
  }
  if (platform === 'linux') {
    const frozen = input.frozenPiExecutable
      ? revalidateFrozenPiExecutableIdentity(input.frozenPiExecutable)
      : null;
    if (input.requireFrozenPiExecutable && !frozen) {
      throw new RorcaExecutionSandboxError(
        'pi_not_installed',
        'pi_not_installed: immutable run authority lacks its frozen Pi executable identity',
      );
    }
    return { mode: 'linux-bwrap', ...(frozen ?? {}) };
  }

  // On Darwin there is no bwrap. A run shape that is not the explicit
  // ordinary-local-Pi profile is unsupported on this host — say so plainly
  // instead of demanding the Linux primitive. A valid shape continues to the
  // Pi-binary validation below (missing binary reports pi_not_installed).
  if (platform !== 'darwin') {
    throw new RorcaExecutionSandboxError(
      'linux_bwrap_required_for_requested_mode',
      `linux_bwrap_required_for_requested_mode: ${failedInvariant ?? 'the requested run is not the explicit ordinary local Pi profile'}`,
    );
  }
  if (!input.ordinaryLocalPiProfileRequested || failedInvariant) {
    throw new RorcaExecutionSandboxError(
      'unsupported_sandbox_mode',
      `unsupported_sandbox_mode: on Darwin the only sanctioned execution shape is the ordinary local Pi profile (${failedInvariant ?? 'the requested run is not the explicit ordinary local Pi profile'})`,
    );
  }

  const frozen = input.frozenPiExecutable
    ? revalidateFrozenPiExecutableIdentity(input.frozenPiExecutable)
    : null;
  if (input.requireFrozenPiExecutable && !frozen) {
    throw new RorcaExecutionSandboxError(
      'pi_not_installed',
      'pi_not_installed: immutable run authority lacks its frozen Pi executable identity',
    );
  }
  const admitted = frozen ?? (() => {
    const piBinPath = resolveExplicitLocalPiBinary(input.env);
    return piBinPath ? freezePiExecutableIdentity(piBinPath) : null;
  })();
  if (!admitted) {
    throw new RorcaExecutionSandboxError(
      'pi_not_installed',
      'pi_not_installed: ordinary local Pi requires an executable absolute PI_BIN',
    );
  }
  const sandboxExecAvailable = input.sandboxExecAvailable ?? (() => {
    try {
      fs.accessSync('/usr/bin/sandbox-exec', fs.constants.X_OK);
      return fs.realpathSync('/usr/bin/sandbox-exec') === '/usr/bin/sandbox-exec';
    } catch {
      return false;
    }
  })();
  if (!sandboxExecAvailable) {
    throw new RorcaExecutionSandboxError(
      'unsupported_sandbox_mode',
      'unsupported_sandbox_mode: the Darwin no-network Pi preflight sandbox is unavailable',
    );
  }
  return {
    mode: 'darwin-local-pi',
    ...admitted,
    posture: input.taskManifestAuthority ? 'task-manifest-pr' : 'ordinary-local-branch',
  };
}

export function serializeOrdinaryLocalPiRuntimeProfile(profile: OrdinaryLocalPiRuntimeProfile): string {
  return JSON.stringify(profile);
}

function parseRuntimeProfile(value: string): OrdinaryLocalPiRuntimeProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RorcaExecutionSandboxError('unsupported_sandbox_mode', 'unsupported_sandbox_mode: ordinary local Pi profile is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RorcaExecutionSandboxError('unsupported_sandbox_mode', 'unsupported_sandbox_mode: ordinary local Pi profile is malformed');
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== ORDINARY_LOCAL_PI_PROFILE_VERSION
    || !Number.isSafeInteger(candidate.runId) || Number(candidate.runId) <= 0
    || typeof candidate.workspacePath !== 'string' || !path.isAbsolute(candidate.workspacePath)
    || typeof candidate.worktreePath !== 'string' || !path.isAbsolute(candidate.worktreePath)
    || typeof candidate.branchName !== 'string' || candidate.branchName.length === 0
    || typeof candidate.piBinPath !== 'string' || !path.isAbsolute(candidate.piBinPath)
    || typeof candidate.piRealPath !== 'string' || !path.isAbsolute(candidate.piRealPath)
    || typeof candidate.runtimeRoot !== 'string' || !path.isAbsolute(candidate.runtimeRoot)
    || (candidate.posture !== 'ordinary-local-branch' && candidate.posture !== 'task-manifest-pr')) {
    throw new RorcaExecutionSandboxError('unsupported_sandbox_mode', 'unsupported_sandbox_mode: ordinary local Pi profile is malformed');
  }
  return candidate as unknown as OrdinaryLocalPiRuntimeProfile;
}

/** Read a worker-issued local profile without accepting a caller supplied mode. */
export function ordinaryLocalPiRuntimeProfileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OrdinaryLocalPiRuntimeProfile | null {
  const raw = env[ORDINARY_LOCAL_PI_PROFILE_ENV];
  if (!raw) return null;
  if (platform !== 'darwin') {
    throw new RorcaExecutionSandboxError(
      'unsupported_sandbox_mode',
      `unsupported_sandbox_mode: ordinary local Pi profile cannot run on ${platform}`,
    );
  }
  const profile = parseRuntimeProfile(raw);
  const configuredPi = resolveExplicitLocalPiBinary(env);
  const configuredRealPi = configuredPi ? realExecutable(configuredPi) : null;
  if (!configuredPi
    || path.resolve(configuredPi) !== path.resolve(profile.piBinPath)
    || configuredRealPi !== profile.piRealPath) {
    throw new RorcaExecutionSandboxError(
      'pi_not_installed',
      'pi_not_installed: worker-issued ordinary local Pi profile no longer matches executable PI_BIN',
    );
  }
  return profile;
}

/**
 * Validate the profile again at every agent/tool launch. The marker is created
 * only by the worker after frozen DB/worktree checks; a malformed or stale
 * marker is a hard failure rather than a fallback to an unsandboxed process.
 */
export function assertOrdinaryLocalPiRuntimeProfile(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OrdinaryLocalPiRuntimeProfile | null {
  const profile = ordinaryLocalPiRuntimeProfileFromEnv(env, platform);
  if (!profile) return null;
  if (path.resolve(cwd) !== path.resolve(profile.worktreePath)
    || !pathsAreSeparate(profile.workspacePath, profile.worktreePath)) {
    throw new RorcaExecutionSandboxError(
      'unsupported_sandbox_mode',
      'unsupported_sandbox_mode: ordinary local Pi launch escaped its frozen worktree',
    );
  }
  return profile;
}
