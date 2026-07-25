/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ORDINARY_LOCAL_PI_PROFILE_VERSION,
  RorcaExecutionSandboxError,
  assertOrdinaryLocalPiRuntimeProfile,
  resolveRorcaExecutionSandboxProfile,
  serializeOrdinaryLocalPiRuntimeProfile,
  type OrdinaryLocalPiProfileInput,
} from '../ordinary-local-pi-profile';

const explicitPiEnv = { PI_BIN: process.execPath } as NodeJS.ProcessEnv;

function safeDarwinInput(overrides: Partial<OrdinaryLocalPiProfileInput> = {}): OrdinaryLocalPiProfileInput {
  return {
    ordinaryLocalPiProfileRequested: true,
    agent: 'pi',
    allRequiredAgentsPi: true,
    autoWorktree: true,
    workspacePath: '/private/tmp/rorca-workspace',
    worktreePath: '/private/tmp/rorca-worktree',
    branchName: 'feat/ordinary-local',
    autoMerge: false,
    mergeStrategy: 'branch-only',
    deploy: false,
    externalSend: false,
    policyLocked: false,
    parallelism: 1,
    orchestrationMode: 'sequential',
    terminalMode: 'ansi-html',
    executionEnvironment: 'remote-rorca',
    taskManifestAuthority: false,
    readinessOverride: false,
    requireConcreteWorktree: true,
    platform: 'darwin',
    sandboxExecAvailable: true,
    env: explicitPiEnv,
    ...overrides,
  };
}

function expectSandboxCode(run: () => unknown, code: RorcaExecutionSandboxError['code']): void {
  try {
    run();
    throw new Error('expected sandbox resolution to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RorcaExecutionSandboxError);
    expect((error as RorcaExecutionSandboxError).code).toBe(code);
  }
}

describe('ordinary local Pi execution profile', () => {
  test('a macOS isolated branch-only Pi preflight accepts an explicit executable PI_BIN', () => {
    expect(resolveRorcaExecutionSandboxProfile(safeDarwinInput())).toEqual({
      mode: 'darwin-local-pi',
      piBinPath: process.execPath,
      piRealPath: fs.realpathSync(process.execPath),
    });
  });

  test.each([
    ['external send', { externalSend: true }],
    ['deployment', { deploy: true }],
    ['auto merge', { autoMerge: true }],
    ['non-branch-only merge', { mergeStrategy: 'draft-pr' }],
    ['parallel execution', { parallelism: 2 }],
    ['interactive terminal', { terminalMode: 'native-pty' }],
    ['TaskManifest delivery', { taskManifestAuthority: true }],
    ['readiness override', { readinessOverride: true }],
    ['policy-locked autonomous work', { policyLocked: true }],
    ['mixed engine story set', { allRequiredAgentsPi: false }],
  ])('requires Linux bwrap for %s', (_name, overrides) => {
    expectSandboxCode(
      () => resolveRorcaExecutionSandboxProfile(safeDarwinInput(overrides)),
      'linux_bwrap_required_for_requested_mode',
    );
  });

  test('reports a missing explicit Pi binary separately from a requested Linux-only mode', () => {
    expectSandboxCode(
      () => resolveRorcaExecutionSandboxProfile(safeDarwinInput({ env: {} })),
      'pi_not_installed',
    );
    expectSandboxCode(
      () => resolveRorcaExecutionSandboxProfile(safeDarwinInput({ sandboxExecAvailable: false })),
      'unsupported_sandbox_mode',
    );
  });

  test('Linux retains bwrap even for an otherwise ordinary local run', () => {
    expect(resolveRorcaExecutionSandboxProfile(safeDarwinInput({ platform: 'linux' }))).toEqual({ mode: 'linux-bwrap' });
  });

  test('rejects Pi launcher symlink drift after the profile is frozen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-profile-drift-'));
    const launcher = path.join(dir, 'pi');
    fs.symlinkSync(process.execPath, launcher);
    try {
      const resolved = resolveRorcaExecutionSandboxProfile(safeDarwinInput({ env: { PI_BIN: launcher } }));
      if (!resolved.piBinPath || !resolved.piRealPath) throw new Error('expected Darwin Pi profile');
      const env = {
        PI_BIN: launcher,
        RORCA_ORDINARY_LOCAL_PI_PROFILE: serializeOrdinaryLocalPiRuntimeProfile({
          schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION,
          runId: 92,
          workspacePath: '/private/tmp/rorca-workspace',
          worktreePath: '/private/tmp/rorca-worktree',
          branchName: 'feat/ordinary-local',
          piBinPath: resolved.piBinPath,
          piRealPath: resolved.piRealPath,
        }),
      } as NodeJS.ProcessEnv;
      fs.unlinkSync(launcher);
      fs.symlinkSync('/bin/sh', launcher);
      expectSandboxCode(
        () => assertOrdinaryLocalPiRuntimeProfile('/private/tmp/rorca-worktree', env, 'darwin'),
        'pi_not_installed',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a worker-issued runtime marker is bound to its exact worktree and Pi binary', () => {
    const env = {
      ...explicitPiEnv,
      RORCA_ORDINARY_LOCAL_PI_PROFILE: serializeOrdinaryLocalPiRuntimeProfile({
        schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION,
        runId: 91,
        workspacePath: '/private/tmp/rorca-workspace',
        worktreePath: '/private/tmp/rorca-worktree',
        branchName: 'feat/ordinary-local',
        piBinPath: process.execPath,
        piRealPath: fs.realpathSync(process.execPath),
      }),
    } as NodeJS.ProcessEnv;

    expect(assertOrdinaryLocalPiRuntimeProfile('/private/tmp/rorca-worktree', env, 'darwin')).toMatchObject({
      runId: 91,
      piBinPath: process.execPath,
    });
    expectSandboxCode(
      () => assertOrdinaryLocalPiRuntimeProfile('/private/tmp/rorca-workspace', env, 'darwin'),
      'unsupported_sandbox_mode',
    );
  });
});
