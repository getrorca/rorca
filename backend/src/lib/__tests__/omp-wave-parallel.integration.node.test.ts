/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { projectOmpOrchestrationEvent } from '../omp-orchestration-events';
import { runWaveTasksWithRejectionFence } from '../parallel-wave-core';
import type { ManagedAgent, ManagedEngineRequest } from '../rorca-managed-executor';
import {
  assertWavePolicyEnvelope,
  evaluateWaveProductionPolicy,
  type WavePolicyEvaluationInput,
} from '../wave-production-policy';
import { commitGuardedMerge, createOwnedStoryWorktree } from '../story-worktree-lifecycle';

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Rorca OMP Wave Test',
  GIT_AUTHOR_EMAIL: 'omp-wave-test@rorca.invalid',
  GIT_COMMITTER_NAME: 'Rorca OMP Wave Test',
  GIT_COMMITTER_EMAIL: 'omp-wave-test@rorca.invalid',
};
// The autonomous host itself runs under a guarded Git namespace. This fixture
// must address its temporary repository rather than inheriting the host's
// alternate index/worktree authority.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnvironment[key];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function productionPolicyInput(revision: string, killSwitch = 'false'): WavePolicyEvaluationInput {
  return {
    request: {
      orchestrationMode: 'wave-parallel', parallelism: 4,
      qualificationReceiptId: 'receipt:omp-wave', rolloutCohort: 'canary',
    },
    environment: { nodeEnv: 'production', productionEnabled: 'true', experimentalEnabled: undefined, killSwitch },
    workspaceId: 'workspace-omp-wave',
    runId: 804,
    currentRevision: revision,
    receipt: {
      id: 'receipt:omp-wave', reportHash: `sha256:${'a'.repeat(64)}`,
      sourceRevision: revision, current: true, productionEnableAvailable: true,
    },
    rollout: {
      enabled: true, cohort: 'canary', workspaceAllowlist: ['workspace-omp-wave'], runAllowlist: [],
      maxParallelism: 4, maxActiveWaveRuns: 2, maxActiveWaveRunsPerWorkspace: 1,
      maxCpuPercent: 90, maxMemoryPercent: 90, maxErrorRate: 0.1,
      observedCpuPercent: 10, observedMemoryPercent: 10, observedErrorRate: 0,
      halted: false, draining: false, rationale: 'focused OMP wave verification',
      releaseReadinessPacketId: 'release:omp-wave', productionActivationApprovalId: 'activation:omp-wave',
      releaseReadinessCurrent: true, operatorActivationCurrent: true, policyEpoch: 7,
    },
    activeWaveRuns: 0,
    activeWorkspaceWaveRuns: 0,
  };
}

const specHash = `sha256:${'b'.repeat(64)}`;
function managedRequest(storyId: string): ManagedEngineRequest {
  return {
    requestHash: `sha256:${(storyId === 'OMP-001' ? 'c' : 'd').repeat(64)}`,
    workspaceId: 'workspace-omp-wave', runId: 804,
    specId: 'spec:omp-wave', specVersion: 11, specHash,
    storyId, storyVersion: 3, storyHash: `sha256:${'e'.repeat(64)}`,
    attemptId: `attempt:${storyId}:2`, generation: 2,
  } as ManagedEngineRequest;
}

describe('OMP wave-parallel executor verification', () => {
  test('runs a heterogeneous wave concurrently in isolated worktrees and guarded-merges every branch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-omp-wave-'));
    const repository = path.join(root, 'run');
    fs.mkdirSync(repository);
    const gitStateKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'] as const;
    const inheritedGitState = new Map(gitStateKeys.map((key) => [key, process.env[key]]));
    for (const key of gitStateKeys) delete process.env[key];
    try {
      git(repository, ['init', '-b', 'run-804']);
      fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
      git(repository, ['add', 'base.txt']);
      git(repository, ['commit', '-m', 'base']);
      const baseRevision = git(repository, ['rev-parse', 'HEAD']);
      const policy = evaluateWaveProductionPolicy(productionPolicyInput(baseRevision));
      assert.equal(policy.allowed, true);
      assert.deepEqual(policy.effective, { orchestrationMode: 'wave-parallel', parallelism: 4 });
      assert.doesNotThrow(() => assertWavePolicyEnvelope(policy, productionPolicyInput(baseRevision)));

      const assignments: Array<{ storyId: string; agent: ManagedAgent }> = [
        { storyId: 'OMP-001', agent: 'omp' },
        { storyId: 'OMP-002', agent: 'omp' },
        { storyId: 'CLAUDE-001', agent: 'claude' },
        { storyId: 'PI-001', agent: 'pi' },
      ];
      const worktrees = assignments.map((assignment) => createOwnedStoryWorktree({
        repositoryPath: repository,
        worktreePath: path.join(root, `worktree-${assignment.storyId.toLowerCase()}`),
        branchName: `story/run-804-${assignment.storyId.toLowerCase()}`,
        runId: 804, waveIndex: 0, storyId: assignment.storyId, attempt: 2,
        baseRevision, qualificationNamespace: 'MIG-004',
      }));
      assert.equal(new Set(worktrees.map((worktree) => worktree.worktreeRealpath)).size, assignments.length);

      let active = 0;
      let maximumActive = 0;
      const startedAgents: ManagedAgent[] = [];
      let releaseWave!: () => void;
      const allStarted = new Promise<void>((resolve) => { releaseWave = resolve; });
      const results = await runWaveTasksWithRejectionFence(assignments.map((assignment, index) => async () => {
        startedAgents.push(assignment.agent);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === assignments.length) releaseWave();
        await allStarted;
        const worktree = worktrees[index].worktreeRealpath;
        assert.notEqual(worktree, repository);
        fs.writeFileSync(path.join(worktree, `${assignment.storyId}.txt`), `${assignment.agent}:${assignment.storyId}\n`);
        git(worktree, ['add', `${assignment.storyId}.txt`]);
        git(worktree, ['commit', '-m', `${assignment.agent}: ${assignment.storyId}`]);
        active -= 1;
        return { ...assignment, worktree };
      }), policy.effective.parallelism);

      assert.equal(maximumActive, assignments.length, 'all stories must overlap before any session is released');
      assert.deepEqual(new Set(startedAgents), new Set<ManagedAgent>(['omp', 'claude', 'pi']));
      assert.equal(results.every((result) => result.status === 'fulfilled'), true);

      for (const worktree of worktrees) {
        const expectedParent = git(repository, ['rev-parse', 'HEAD']);
        git(repository, ['merge', '--no-ff', '--no-commit', worktree.branchName]);
        const mergedHead = commitGuardedMerge(repository, `merge: ${worktree.storyId}`, expectedParent);
        assert.equal(git(repository, ['rev-parse', 'HEAD']), mergedHead);
      }
      for (const assignment of assignments) {
        assert.equal(fs.readFileSync(path.join(repository, `${assignment.storyId}.txt`), 'utf8'), `${assignment.agent}:${assignment.storyId}\n`);
      }
      assert.equal(git(repository, ['rev-list', '--first-parent', '--count', `${baseRevision}..HEAD`]), String(assignments.length));
    } finally {
      for (const key of gitStateKeys) {
        const value = inheritedGitState.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('production policy fences dispatch and each OMP session emits stable exact identity', () => {
    const revision = 'f'.repeat(40);
    const deniedInput = productionPolicyInput(revision, 'true');
    const denied = evaluateWaveProductionPolicy(deniedInput);
    assert.equal(denied.allowed, false);
    assert.equal(denied.status, 'halted');
    assert.throws(() => assertWavePolicyEnvelope(denied, deniedInput), /wave dispatch denied/);

    for (const storyId of ['OMP-001', 'OMP-002']) {
      const request = managedRequest(storyId);
      const processIdentity = `managed-omp:v17.0.9:${storyId}:process`;
      const input = {
        request, processIdentity, sourceOrdinal: 1,
        event: { type: 'agent_start', id: `omp:${storyId}:1` },
        observedAt: '2026-03-16T00:06:34.000Z',
      };
      const first = projectOmpOrchestrationEvent(input, 1);
      const replay = projectOmpOrchestrationEvent(input, 1);
      assert.deepEqual(replay, first);
      assert.equal(first.run.id, '804');
      assert.equal(first.story.id, storyId);
      assert.equal(first.attempt.id, `attempt:${storyId}:2`);
      assert.equal(first.process.id, processIdentity);
      assert.equal(first.spec.id, 'spec:omp-wave');
      assert.deepEqual(first.spec.revision, { kind: 'spec_version', value: '11' });
      assert.equal(first.specRevisionHash, specHash);
    }
  });
});
