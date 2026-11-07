
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_CLOSEOUT_OUTPUT_EXCERPT_BYTES } from '../story-closeout';

jest.mock('../autonomous-sandbox', () => ({
  prepareAutonomousSandboxLaunch: jest.fn((options: any) => ({
    command: options.command, args: [...options.args], cwd: options.cwd, env: options.env, isolated: true,
  })),
}));
import { prepareAutonomousSandboxLaunch } from '../autonomous-sandbox';
import { createStoryExecutionManifest } from '../story-execution-packet';
import {
  isRetryableHostValidationClassification,
  runHostValidationRequirement,
} from '../story-host-validation';
import { storyLifecycleFixture } from './fixtures/story-execution-manifest.fixture';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('story-host-validation', () => {
  let cwd: string;
  let head: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-host-validation-'));
    git(cwd, ['init']);
    git(cwd, ['config', 'user.email', 'test@rorca.local']);
    git(cwd, ['config', 'user.name', 'Rorca Test']);
    fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n');
    git(cwd, ['add', 'README.md']);
    git(cwd, ['commit', '-m', 'test fixture']);
    head = git(cwd, ['rev-parse', 'HEAD']);
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  function manifest(command: string, args: string[]) {
    return createStoryExecutionManifest({
      identity: { workspaceId: 'rorca', specId: 'ssdlc', storyId: 'LFC-008', runId: 42, attempt: 1 },
      revisions: { specRevision: 'sha256:spec', storyRevision: 'sha256:story' },
      executionMode: 'impl',
      lifecycle: storyLifecycleFixture('rorca', 'ssdlc', 'LFC-008'),
      execution: {
        agent: 'pi', model: null, effort: null, terminal: 'ansi-html',
        worktree: { enabled: false, path: cwd, branch: null, baseRevision: head },
        merge: { enabled: false, strategy: 'branch-only', targetBranch: null },
      },
      validationPlan: [{ id: 'focused', command, args, required: true, revisionSensitive: true, timeoutMs: 10_000 }],
      evidenceExpectations: [{
        criterionId: 'LFC-008:ac:1',
        description: 'Host validation is observed.',
        requiredEvidenceKinds: ['validation'],
      }],
      repositoryProfile: {
        profileId: 'code-v1', changePolicy: 'code_required', noCodeReason: null, runtimeMetadataPaths: [],
      },
      commandSafety: {
        profileId: 'autonomous-command-guard-v1',
        guardVersion: '1',
        guardedWorkingDirectory: cwd,
        allowedWorkingDirectories: [cwd],
        blockedCommandPatterns: ['backend Jest without *_test'],
        redactedEnvironmentKeys: ['API_TOKEN', 'DATABASE_URL'],
        allowBackendJest: false,
        baselineFailurePolicy: 'block',
      },
    });
  }

  test('records canonical command, guarded cwd, redacted environment, time, output, and immutable subject', () => {
    const contract = manifest(process.execPath, ['-e', 'console.log("validation passed")']);
    const observation = runHostValidationRequirement(contract, contract.validationPlan[0], {
      env: { API_TOKEN: 'must-not-appear' },
      now: (() => {
        const times = [new Date('2026-07-15T12:00:00Z'), new Date('2026-07-15T12:00:01Z')];
        return () => times.shift()!;
      })(),
    });

    expect(observation.classification).toBe('passed');
    expect(observation.commandHash).toBe(contract.validationPlan[0].commandHash);
    expect(observation.guardedWorkingDirectory).toBe(cwd);
    expect(observation.environment).toMatchObject({
      profileId: contract.commandSafety.profileId,
      redactedKeys: expect.arrayContaining(['API_TOKEN', 'DATABASE_URL']),
    });
    expect(observation.startedAt).toBe('2026-07-15T12:00:00.000Z');
    expect(observation.finishedAt).toBe('2026-07-15T12:00:01.000Z');
    expect(observation.termination).toEqual({ kind: 'exited', exitCode: 0 });
    expect(observation.output.redactedExcerpt).toContain('validation passed');
    expect(observation.output.reference).toContain('host-validation:42:LFC-008:focused');
    expect(observation.subject).toMatchObject({ commitSha: head, worktreePath: cwd });
    expect(observation.repositoryRevisionBefore).toBe(head);
    expect(observation.repositoryRevisionAfter).toBe(head);
  });

  test('runs frozen shell validations without a denied login-profile read in the Darwin local Pi profile', () => {
    const contract = manifest('/bin/sh', ['-lc', 'printf "validation passed\\n"']);
    const observation = runHostValidationRequirement(contract, contract.validationPlan[0], {
      env: { RORCA_ORDINARY_LOCAL_PI_PROFILE: 'worker-issued-profile' },
    });

    expect(observation.classification).toBe('passed');
    expect(observation.command).toBe('/bin/sh');
    expect(observation.args).toEqual(['-lc', 'printf "validation passed\\n"']);
    expect(prepareAutonomousSandboxLaunch).toHaveBeenLastCalledWith(expect.objectContaining({
      command: '/bin/sh',
      args: ['-c', 'printf "validation passed\\n"'],
    }));
  });

  test('bounds a truncated UTF-8 excerpt including its suffix', () => {
    const contract = manifest(process.execPath, ['-e', 'process.stdout.write("🙂".repeat(3_000))']);
    const observation = runHostValidationRequirement(contract, contract.validationPlan[0]);

    expect(observation.classification).toBe('passed');
    expect(observation.output.byteLength).toBe(12_000);
    expect(observation.output.truncated).toBe(true);
    expect(observation.output.redactedExcerpt?.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(observation.output.redactedExcerpt!, 'utf8'))
      .toBeLessThanOrEqual(MAX_CLOSEOUT_OUTPUT_EXCERPT_BYTES);
    expect(observation.output.redactedExcerpt).not.toContain('�');
  });

  test('records an unavailable command as a typed blocker with remediation', () => {
    const contract = manifest('rorca-command-that-does-not-exist', []);
    const observation = runHostValidationRequirement(contract, contract.validationPlan[0]);

    expect(observation.classification).toBe('environment_unavailable');
    expect(observation.termination).toEqual({ kind: 'cancelled', reason: 'command_unavailable' });
    expect(observation.remediation).toContain('Install or configure');
  });

  test('classifies a Darwin native-binding failure as an environment blocker that cannot consume a retry', () => {
    const contract = manifest(process.execPath, [
      '-e',
      'process.stderr.write("Cannot find module @rolldown/binding-darwin-x64\\n"); process.exit(1)',
    ]);
    const observation = runHostValidationRequirement(contract, contract.validationPlan[0]);

    expect(observation.classification).toBe('environment_unavailable');
    expect(observation.remediation).toContain('managed validation runtime');
    expect(isRetryableHostValidationClassification(observation.classification)).toBe(false);
  });

  test.each([
    ['a sandbox-denied SuperTest listener', 'Error: listen EPERM: operation not permitted 0.0.0.0'],
    ['missing managed JavaScript tooling', '/bin/sh: eslint: command not found'],
    ['an unavailable package registry', 'npm error code E403\nnpm error 403 Forbidden - GET https://registry.npmjs.org/zwitch'],
  ])('classifies %s as an environment blocker without consuming a retry', (_label, stderr) => {
    const contract = manifest(process.execPath, [
      '-e',
      `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`,
    ]);
    const observation = runHostValidationRequirement(contract, contract.validationPlan[0]);

    expect(observation.classification).toBe('environment_unavailable');
    expect(isRetryableHostValidationClassification(observation.classification)).toBe(false);
  });

  test('keeps source assertion failures retryable', () => {
    const contract = manifest(process.execPath, [
      '-e',
      'process.stderr.write("Expected immutable snapshot count 2, received 1\\n"); process.exit(1)',
    ]);
    const observation = runHostValidationRequirement(contract, contract.validationPlan[0]);

    expect(observation.classification).toBe('story_caused_failure');
    expect(isRetryableHostValidationClassification(observation.classification)).toBe(true);
  });

  test.each([
    ['story_caused_failure', true],
    ['environment_unavailable', false],
    ['blocked_by_policy', false],
    ['unrelated_baseline', false],
  ] as const)('retries host validation only when it is %s', (classification, expected) => {
    expect(isRetryableHostValidationClassification(classification)).toBe(expected);
  });
});
