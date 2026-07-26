/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../../..');
const pipeline = fs.readFileSync(path.join(root, 'backend/src/routes/pipeline.ts'), 'utf8');
const triggerPopover = fs.readFileSync(path.join(root, 'src/components/TriggerPopover.tsx'), 'utf8');
const runnerJobs = fs.readFileSync(path.join(root, 'backend/src/lib/execution-runner-jobs.ts'), 'utf8');
const executionEnvironment = fs.readFileSync(path.join(root, 'backend/src/lib/execution-environment.ts'), 'utf8');
const executionEnvironmentRoutes = fs.readFileSync(path.join(root, 'backend/src/routes/execution-environments.ts'), 'utf8');

function slice(start: string, end: string): string {
  const from = pipeline.indexOf(start);
  const to = pipeline.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return pipeline.slice(from, to);
}

test('canonical trigger rejects local-user before the first workspace query and has no runner-job enqueue branch', () => {
  const handler = slice('async function handlePipelineTrigger(', 'const TaskManifestTriggerRequestSchema');
  const resolution = handler.indexOf('const resolvedExecutionEnvironment = resolveExecutionEnvironment(executionEnvironment)');
  const firstWorkspaceRead = handler.indexOf("queryOne('SELECT * FROM workspaces WHERE id = $1'");
  expect(resolution).toBeGreaterThan(-1);
  expect(firstWorkspaceRead).toBeGreaterThan(resolution);
  expect(handler).not.toContain('createRunnerJob(');
  expect(handler).not.toContain("effective === 'local-user'");
  expect(pipeline).not.toContain("import { createRunnerJob }");
});

test('task-manifest trigger rejects local-user before workspace reads, artifact writes, reservation, or queueing', () => {
  const handler = slice('async function handleTaskManifestTrigger(', "router.post('/task-manifests/trigger'");
  const resolution = handler.indexOf('resolveTaskManifestExecutionEnvironment(requestBody, manifest)');
  for (const mutationBoundary of [
    "queryOne('SELECT * FROM workspaces WHERE id = $1'",
    'writeTaskManifestExecutionEnvelope({',
    'reserveTaskManifestRun({',
    'await handlePipelineTrigger(req, res)',
  ]) {
    expect(handler.indexOf(mutationBoundary)).toBeGreaterThan(resolution);
  }
});

test('stable public schema advertises only the available host while its parser retains fail-closed compatibility input', () => {
  expect(pipeline).toContain('enum: [remote-rorca]');
  expect(pipeline).not.toContain('enum: [remote-rorca, local-user]');
  expect(pipeline).toContain('422: { description: "Spec is not executable or the request asks for a disabled Release-1 capability" }');
  expect(executionEnvironment).toContain("z.enum(['remote-rorca', 'local-user'])");
  expect(executionEnvironment).toContain("'LOCAL_USER_EXECUTION_UNAVAILABLE'");
  expect(executionEnvironmentRoutes).toContain("unavailable: [{ id: 'local-user', deprecated: true, reason: 'LOCAL_USER_EXECUTION_UNAVAILABLE' }]");
});

test('normal trigger UI filters local-user and historical transport cannot remain release_pending', () => {
  expect(triggerPopover).toContain("filter((environment) => environment.id === 'remote-rorca')");
  const completion = runnerJobs.slice(
    runnerJobs.indexOf('export async function completeRunnerJob('),
    runnerJobs.indexOf('export async function cancelRunnerJobForRun('),
  );
  expect(completion).toContain("input.status === 'cancelled' ? 'cancelled' : 'failed'");
  expect(completion).toContain('local_user_execution_unavailable');
  expect(completion).not.toContain("? 'release_pending'");
});
