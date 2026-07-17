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

test('only ready PR routing auto-enqueues; draft/direct paths remain distinct', () => {
  const prStart = worker.indexOf("case 'pr':");
  const draftStart = worker.indexOf("case 'draft-pr':", prStart);
  const directStart = worker.indexOf("case 'direct':");
  const prBlock = worker.slice(prStart, draftStart);
  const directBlock = worker.slice(directStart, prStart);
  expect(prBlock).toContain('queueAutonomousPrDeliveryForRun');
  expect(prBlock).toContain('finalizeDraftPr');
  expect(directBlock).not.toContain('queueAutonomousPrDeliveryForRun');
  expect(worker.slice(draftStart, worker.indexOf("case 'branch-only':", draftStart)))
    .not.toContain('queueAutonomousPrDeliveryForRun');
});

test('GitHub PR actuation never calls the local direct-merge handler or dispatches deployment', () => {
  expect(delivery).not.toContain('performMerge');
  expect(delivery).not.toContain('dispatchWorkflowIfConfigured');
  expect(delivery).toContain("safetyOptions: { deploy: false, externalSend: true, policyLocked: true }");
  expect(delivery).toContain("source: 'autonomous-delivery'");
});
