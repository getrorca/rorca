
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

jest.mock('../autonomous-sandbox', () => ({
  prepareAutonomousSandboxLaunch: jest.fn((options: any) => ({
    command: options.command, args: [...options.args], cwd: options.cwd, env: options.env, isolated: true,
  })),
}));

import { createStoryExecutionManifest } from '../story-execution-packet';
import { runHostValidationRequirement } from '../story-host-validation';

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

  test('records an unavailable command as a typed blocker with remediation', () => {
    const contract = manifest('rorca-command-that-does-not-exist', []);
    const observation = runHostValidationRequirement(contract, contract.validationPlan[0]);

    expect(observation.classification).toBe('environment_unavailable');
    expect(observation.termination).toEqual({ kind: 'cancelled', reason: 'command_unavailable' });
    expect(observation.remediation).toContain('Install or configure');
  });
});
