/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AutonomousPrDeliveryJobPayload } from '../pg-boss-schemas';

const root = path.resolve(__dirname, '../..');
const worker = fs.readFileSync(path.join(root, 'worker.ts'), 'utf8');
const boss = fs.readFileSync(path.join(root, 'lib', 'pg-boss.ts'), 'utf8');
const delivery = fs.readFileSync(path.join(root, 'lib', 'autonomous-pr-delivery.ts'), 'utf8');

test('uses one strict existing-worker queue with no authority or secret payload', () => {
  expect(AutonomousPrDeliveryJobPayload.safeParse({
    deliveryId: '10000000-0000-4000-8000-000000000001',
    expectedHeadSha: 'a'.repeat(40),
  }).success).toBe(true);
  expect(AutonomousPrDeliveryJobPayload.safeParse({
    deliveryId: '10000000-0000-4000-8000-000000000001',
    expectedHeadSha: 'a'.repeat(40),
    policyDigest: `sha256:${'b'.repeat(64)}`,
  }).success).toBe(false);
  expect(boss).toContain("createQueue('pipeline:pr-delivery')");
  expect(worker).toContain('registerAutonomousPrDeliveryWorker(boss)');
});

test('run release routing has one host-owned seam and no inline PR/push fallback', () => {
  expect(worker).toContain('prepareRunReleaseIntent({');
  expect(worker).toContain('reconcileRunReleaseIntent(runId');
  expect(worker).not.toContain("case 'pr':");
  expect(worker).not.toContain('gh pr');
  expect(worker).not.toContain("git.push('origin'");
});

test('GitHub PR actuation never calls the local direct-merge handler or dispatches deployment', () => {
  expect(delivery).not.toContain('performMerge');
  expect(delivery).not.toContain('dispatchWorkflowIfConfigured');
  expect(delivery).toContain('Reviewed delivery is');
  expect(delivery).toContain('not a second execution/release orchestrator');
  expect(delivery).toContain("withGithubReleaseActuation(releaseIdentity, 'merge'");
  expect(delivery).toContain('Conflict recovery requires a new explicitly authorized run/release identity');
});
