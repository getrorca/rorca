/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTONOMOUS_GIT_STATE_ROOT_ENV,
  createAutonomousGitState,
  removeAutonomousGitState,
} from '../autonomous-git-state';
import { probeAutonomousCliSync } from '../autonomous-cli-probe';
import {
  ORDINARY_LOCAL_PI_PROFILE_ENV,
  ORDINARY_LOCAL_PI_PROFILE_VERSION,
  RorcaExecutionSandboxError,
  serializeOrdinaryLocalPiRuntimeProfile,
} from '../ordinary-local-pi-profile';
const originalPiBin = process.env.PI_BIN;

afterEach(() => {
  if (originalPiBin === undefined) delete process.env.PI_BIN;
  else process.env.PI_BIN = originalPiBin;
});

test('Darwin local discovery refuses arbitrary commands rather than becoming a generic local shell', () => {
  process.env.PI_BIN = process.execPath;
  const result = probeAutonomousCliSync(process.execPath, ['--help'], {
    sandboxMode: 'darwin-local-pi',
  });

  expect(result.status).toBeNull();
  expect(result.error).toBeInstanceOf(RorcaExecutionSandboxError);
  expect((result.error as RorcaExecutionSandboxError).code).toBe('unsupported_sandbox_mode');
});

const darwinTest = process.platform === 'darwin' ? test : test.skip;
darwinTest('frozen Darwin runtime probes remain inside the admitted worktree', () => {

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-local-probe-profile-'));
  const workspaceDirectory = path.join(root, 'workspace');
  const worktreeDirectory = path.join(root, 'worktree');
  const runtimeRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rorca-ordinary-local-pi-runtime-700-'));
  fs.chmodSync(runtimeRoot, 0o700);
  fs.mkdirSync(workspaceDirectory, { recursive: true });
  fs.mkdirSync(worktreeDirectory, { recursive: true });
  const workspacePath = fs.realpathSync(workspaceDirectory);
  const worktreePath = fs.realpathSync(worktreeDirectory);
  execFileSync('git', ['init', '--quiet', '-b', 'feat/probe'], { cwd: worktreePath });
  fs.writeFileSync(path.join(worktreePath, 'fixture.txt'), 'probe\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: worktreePath });
  execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: worktreePath });
  const gitStateRoot = createAutonomousGitState(700, worktreePath, 'feat/probe');

  try {
    const piRealPath = fs.realpathSync(process.execPath);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_BIN: process.execPath,
      [AUTONOMOUS_GIT_STATE_ROOT_ENV]: gitStateRoot,
      [ORDINARY_LOCAL_PI_PROFILE_ENV]: serializeOrdinaryLocalPiRuntimeProfile({
        schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION,
        runId: 700,
        workspacePath,
        worktreePath,
        branchName: 'feat/probe',
        piBinPath: process.execPath,
        piRealPath,
        runtimeRoot,
        posture: 'ordinary-local-branch',
      }),
    };

    const result = probeAutonomousCliSync(process.execPath, ['--version'], {
      env,
      timeoutMs: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(process.version);
  } finally {
    removeAutonomousGitState(gitStateRoot);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
