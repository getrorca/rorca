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
  freezePiExecutableIdentity,
  resolveRorcaExecutionSandboxProfile,
  serializeOrdinaryLocalPiRuntimeProfile,
  type OrdinaryLocalPiProfileInput,
} from '../ordinary-local-pi-profile';

const explicitPiEnv = { PI_BIN: process.execPath } as NodeJS.ProcessEnv;

function safeDarwinInput(overrides: Partial<OrdinaryLocalPiProfileInput> = {}): OrdinaryLocalPiProfileInput {
  return {
    ordinaryLocalPiProfileRequested: true,
    agent: 'pi',
    allRequiredAgentsOrdinaryLocal: true,
    allRequiredAgentsOmp: false,
    allStoriesSelected: true,
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
      posture: 'ordinary-local-branch',
    });
  });

  test('a macOS isolated branch-only OMP preflight reuses the ordinary-local Pi runtime', () => {
    expect(resolveRorcaExecutionSandboxProfile(safeDarwinInput({ agent: 'omp' }))).toEqual({
      mode: 'darwin-local-pi',
      piBinPath: process.execPath,
      piRealPath: fs.realpathSync(process.execPath),
      posture: 'ordinary-local-branch',
    });
  });

  test('a macOS isolated branch-only OMP run admits native PTY only for an OMP-only story set', () => {
    expect(resolveRorcaExecutionSandboxProfile(safeDarwinInput({
      agent: 'omp',
      allRequiredAgentsOmp: true,
      terminalMode: 'native-pty',
    }))).toMatchObject({
      mode: 'darwin-local-pi',
      posture: 'ordinary-local-branch',
    });
    expectSandboxCode(
      () => resolveRorcaExecutionSandboxProfile(safeDarwinInput({
        agent: 'omp',
        allRequiredAgentsOmp: false,
        terminalMode: 'native-pty',
      })),
      'unsupported_sandbox_mode',
    );
  });

  test('a bounded macOS TaskManifest Pi PR preflight accepts the host-only release posture', () => {
    expect(resolveRorcaExecutionSandboxProfile(safeDarwinInput({
      taskManifestAuthority: true,
      mergeStrategy: 'draft-pr',
      externalSend: true,
      policyLocked: true,
    }))).toEqual({
      mode: 'darwin-local-pi',
      piBinPath: process.execPath,
      piRealPath: fs.realpathSync(process.execPath),
      posture: 'task-manifest-pr',
    });
  });

  test.each([
    ['external send', { externalSend: true }],
    ['deployment', { deploy: true }],
    ['auto merge', { autoMerge: true }],
    ['non-branch-only ordinary merge', { mergeStrategy: 'draft-pr' }],
    ['parallel execution', { parallelism: 2 }],
    ['interactive terminal', { terminalMode: 'native-pty' }],
    ['readiness override', { readinessOverride: true }],
    ['policy-locked ordinary work', { policyLocked: true }],
    ['unsupported engine story set', { allRequiredAgentsOrdinaryLocal: false }],
    ['partial story selection', { allStoriesSelected: false }],
  ])('rejects non-ordinary shapes on Darwin without demanding bwrap: %s', (_name, overrides) => {
    expectSandboxCode(
      () => resolveRorcaExecutionSandboxProfile(safeDarwinInput(overrides)),
      'unsupported_sandbox_mode',
    );
  });

  test.each([
    ['branch-only strategy', { mergeStrategy: 'branch-only' }],
    ['missing host release authority', { externalSend: false }],
    ['deployment authority', { deploy: true }],
    ['unlocked policy', { policyLocked: false }],
    ['auto merge', { autoMerge: true }],
    ['parallel workers', { parallelism: 2 }],
    ['unsupported agent', { agent: 'codex', allRequiredAgentsOrdinaryLocal: false }],
    ['single-story selection', { allStoriesSelected: false }],
  ])('rejects unsafe Darwin TaskManifest posture: %s', (_name, overrides) => {
    expectSandboxCode(
      () => resolveRorcaExecutionSandboxProfile(safeDarwinInput({
        taskManifestAuthority: true,
        mergeStrategy: 'pr',
        externalSend: true,
        policyLocked: true,
        ...overrides,
      })),
      'unsupported_sandbox_mode',
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

  test.each(['darwin', 'linux'] as const)(
    '%s rejects forbidden queued readiness authority instead of persisting it behind the platform sandbox choice',
    (platform) => {
      expectSandboxCode(
        () => resolveRorcaExecutionSandboxProfile(safeDarwinInput({ platform, readinessOverride: true })),
        platform === 'darwin' ? 'unsupported_sandbox_mode' : 'linux_bwrap_required_for_requested_mode',
      );
    },
  );

  test.each(['darwin', 'linux'] as const)(
    '%s worker revalidation requires and executes the exact immutable Pi identity',
    (platform) => {
      const frozen = freezePiExecutableIdentity(process.execPath);
      if (!frozen) throw new Error('expected executable Node fixture');
      expect(resolveRorcaExecutionSandboxProfile(safeDarwinInput({
        platform,
        frozenPiExecutable: frozen,
        requireFrozenPiExecutable: true,
      }))).toMatchObject({
        mode: platform === 'darwin' ? 'darwin-local-pi' : 'linux-bwrap',
        ...frozen,
      });
      expectSandboxCode(
        () => resolveRorcaExecutionSandboxProfile(safeDarwinInput({
          platform,
          requireFrozenPiExecutable: true,
        })),
        'pi_not_installed',
      );
    },
  );

  test.each(['darwin', 'linux'] as const)(
    '%s rejects immutable Pi realpath drift during worker sandbox revalidation',
    (platform) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-frozen-drift-'));
      const launcher = path.join(dir, 'pi');
      fs.symlinkSync(process.execPath, launcher);
      const frozen = freezePiExecutableIdentity(launcher);
      if (!frozen) throw new Error('expected frozen symlink fixture');
      try {
        fs.unlinkSync(launcher);
        fs.symlinkSync('/bin/sh', launcher);
        expectSandboxCode(
          () => resolveRorcaExecutionSandboxProfile(safeDarwinInput({
            platform,
            frozenPiExecutable: frozen,
            requireFrozenPiExecutable: true,
          })),
          'pi_not_installed',
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
          runtimeRoot: '/private/tmp/rorca-ordinary-local-pi-runtime-92-test',
          posture: resolved.posture!,
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
        runtimeRoot: '/private/tmp/rorca-ordinary-local-pi-runtime-91-test',
        posture: 'ordinary-local-branch',
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
