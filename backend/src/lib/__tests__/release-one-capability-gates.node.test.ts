/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_ONE_CAPABILITY_PROFILE,
  assertReleaseOneCapabilityEnabled,
  assertReleaseOnePipelineExecutionRequest,
} from '../release-one-capability-profile';
import { UnprocessableError } from '../errors';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function expectDisabled(run: () => void, capabilityId: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof UnprocessableError);
    assert.equal(error.code, 'RELEASE_ONE_CAPABILITY_DISABLED');
    assert.equal(error.details?.profileId, 'release-1-supervised-core');
    assert.equal(error.details?.capabilityId, capabilityId);
    return true;
  });
}

test('every Release-1 exclusion fails closed independent of runtime state', () => {
  for (const capability of RELEASE_ONE_CAPABILITY_PROFILE.capabilities) {
    if (capability.state !== 'disabled') continue;
    expectDisabled(
      () => assertReleaseOneCapabilityEnabled(capability.id, { adversarialEnableRequest: true }),
      capability.id,
    );
  }
});

test('pipeline execution permits local branch-only work but rejects external or broadened authority before mutation', () => {
  expectDisabled(() => assertReleaseOnePipelineExecutionRequest({ triggerType: 'scheduled', autoWorktree: true, mergeStrategy: 'draft-pr' }), 'scheduled_autonomy');
  expectDisabled(() => assertReleaseOnePipelineExecutionRequest({ orchestrationMode: 'wave-parallel', parallelism: 2, autoWorktree: true, mergeStrategy: 'draft-pr' }), 'high_risk_parallel_autonomy');
  expectDisabled(() => assertReleaseOnePipelineExecutionRequest({ parallelism: 2, autoWorktree: true, mergeStrategy: 'draft-pr' }), 'high_risk_parallel_autonomy');
  expectDisabled(() => assertReleaseOnePipelineExecutionRequest({ autoWorktree: true, autoMerge: true, mergeStrategy: 'draft-pr' }), 'auto_merge');
  expectDisabled(() => assertReleaseOnePipelineExecutionRequest({ autoWorktree: false, mergeStrategy: 'draft-pr' }), 'protected_branch_direct_update');
  expectDisabled(() => assertReleaseOnePipelineExecutionRequest({ autoWorktree: true, mergeStrategy: 'direct' }), 'protected_branch_direct_update');
  expectDisabled(() => assertReleaseOnePipelineExecutionRequest({ autoWorktree: true, mergeStrategy: 'branch-only' }), 'branch_only_external_push');
  expectDisabled(() => assertReleaseOnePipelineExecutionRequest({ autoWorktree: true, mergeStrategy: 'draft-pr', executionEnvironment: 'local-user' }), 'local_user_execution_bridge');

  assert.throws(
    () => assertReleaseOnePipelineExecutionRequest({ autoWorktree: true, mergeStrategy: 'draft-pr' }),
    (error: unknown) => error instanceof UnprocessableError
      && error.code === 'RELEASE_ONE_TASK_MANIFEST_REQUIRED'
      && error.details?.capabilityId === 'bounded_task_manifest',
  );
  assert.doesNotThrow(() => assertReleaseOnePipelineExecutionRequest({
    autoWorktree: true, autoMerge: false, mergeStrategy: 'branch-only', externalSend: false,
  }));
  assert.doesNotThrow(() => assertReleaseOnePipelineExecutionRequest({ autoWorktree: true, mergeStrategy: 'draft-pr', externalSend: true, taskManifestAuthority: true }));
  assert.doesNotThrow(() => assertReleaseOnePipelineExecutionRequest({ autoWorktree: true, mergeStrategy: 'pr', externalSend: true, taskManifestAuthority: true }));
  assert.doesNotThrow(() => assertReleaseOnePipelineExecutionRequest({ dryRun: true }));
});

test('release preparation rejects auto-merge and branch-only publication before host or provider reads', async () => {
  const { prepareRunReleaseIntent } = await import('../release-authority');
  const hostAuthority = {} as never;
  await assert.rejects(
    prepareRunReleaseIntent({ hostAuthority, mergeStrategy: 'draft-pr', autoMerge: true, externalSend: true }),
    (error: unknown) => error instanceof UnprocessableError
      && error.code === 'RELEASE_ONE_CAPABILITY_DISABLED'
      && error.details?.capabilityId === 'auto_merge',
  );
  await assert.rejects(
    prepareRunReleaseIntent({ hostAuthority, mergeStrategy: 'branch-only', autoMerge: false, externalSend: true }),
    (error: unknown) => error instanceof UnprocessableError
      && error.code === 'RELEASE_ONE_CAPABILITY_DISABLED'
      && error.details?.capabilityId === 'branch_only_external_push',
  );
});

test('production actuator sources bind the canonical profile before excluded effects', () => {
  const pipeline = readFileSync(path.join(repositoryRoot, 'backend/src/routes/pipeline.ts'), 'utf8');
  const delivery = readFileSync(path.join(repositoryRoot, 'backend/src/lib/autonomous-pr-delivery.ts'), 'utf8');
  const release = readFileSync(path.join(repositoryRoot, 'backend/src/lib/release-authority.ts'), 'utf8');
  const worker = readFileSync(path.join(repositoryRoot, 'backend/src/worker.ts'), 'utf8');
  const taskManifest = readFileSync(path.join(repositoryRoot, 'backend/src/lib/task-manifest.ts'), 'utf8');
  const executionEnvironment = readFileSync(path.join(repositoryRoot, 'backend/src/lib/execution-environment.ts'), 'utf8');
  const executionEnvironmentRoutes = readFileSync(path.join(repositoryRoot, 'backend/src/routes/execution-environments.ts'), 'utf8');
  const openCodeServer = readFileSync(path.join(repositoryRoot, 'backend/src/lib/opencode-server.ts'), 'utf8');
  const worktrees = readFileSync(path.join(repositoryRoot, 'backend/src/routes/worktrees.ts'), 'utf8');
  const planGate = readFileSync(path.join(repositoryRoot, 'backend/src/lib/plan-gate.ts'), 'utf8');

  assert.match(pipeline, /assertReleaseOnePipelineExecutionRequest\s*\(/);
  assert.match(delivery, /assertReleaseOneCapabilityEnabled\(\s*['"]autonomous_provider_merge['"]/);
  assert.match(release, /assertReleaseOneCapabilityEnabled\(\s*['"]auto_merge['"]/);
  assert.match(release, /assertReleaseOneCapabilityEnabled\(\s*['"]branch_only_external_push['"]/);
  assert.match(worker, /Workflow\/deployment dispatch is intentionally disabled/);
  assert.match(taskManifest, /autoMerge:\s*z\.literal\(false\)/);
  assert.match(taskManifest, /deploysAllowed:\s*z\.literal\(false\)/);
  assert.match(taskManifest, /credentialCopyingAllowed:\s*z\.literal\(false\)/);
  assert.match(executionEnvironment, /local-user execution is deprecated and unavailable/);
  assert.match(executionEnvironmentRoutes, /assertReleaseOneCapabilityEnabled\('local_user_execution_bridge'\)/);
  assert.match(executionEnvironmentRoutes, /assertReleaseOneCapabilityEnabled\('unattended_control_plane_mutation'\)/);
  assert.match(openCodeServer, /Warm OpenCode server mode is retired/);
  assert.match(worktrees, /Arbitrary worktree merge is retired/);
  assert.match(planGate, /Native API requires human administrator authority/);
});
