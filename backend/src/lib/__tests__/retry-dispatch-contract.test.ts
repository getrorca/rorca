/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const srcRoot = path.resolve(__dirname, '..', '..');
const pipelineSource = fs.readFileSync(path.join(srcRoot, 'routes', 'pipeline.ts'), 'utf8');
const workerSource = fs.readFileSync(path.join(srcRoot, 'worker.ts'), 'utf8');
const migration = fs.readFileSync(path.join(srcRoot, 'db', 'pg-migrations', '20260715170000_retry_preview_governance.sql'), 'utf8');

function retryRouteSource(): string {
  const start = pipelineSource.indexOf("router.post('/runs/:runId/retry'");
  const end = pipelineSource.indexOf("router.post('/runs/:runId/retry-merge'", start);
  return pipelineSource.slice(start, end);
}

describe('governed retry dispatch contract', () => {
  const route = retryRouteSource();

  test('recomputes generated scope after manifest resolution and immediately before pg-boss dispatch', () => {
    const manifests = route.indexOf('resolveAndPersistDispatchManifests');
    const comparison = route.indexOf('compareRetryPlanToPreview(specJson, approvedPreview)');
    const send = route.indexOf("boss.send('pipeline:retry'");
    expect(manifests).toBeGreaterThan(-1);
    expect(comparison).toBeGreaterThan(manifests);
    expect(send).toBeGreaterThan(comparison);
  });

  test('creates the existing retry queue, leaves UUID generation to pg-boss, and persists duplicate suppression', () => {
    expect(route).toContain("boss.createQueue('pipeline:retry')");
    expect(route).not.toMatch(/boss\.send\('pipeline:retry',[\s\S]{0,500}\bid\s*:/);
    expect(route).toContain("data->>'originalRunId'");
    expect(route).toContain("data->>'scopeHash'");
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_retry_one_dispatched_scope');
    expect(migration).toContain("WHERE status = 'dispatched'");
  });

  test('cancellation returns before queue creation and dispatch', () => {
    const cancellation = route.indexOf('if (cancelPreview)');
    const queueCreation = route.indexOf("boss.createQueue('pipeline:retry')");
    expect(cancellation).toBeGreaterThan(-1);
    expect(queueCreation).toBeGreaterThan(cancellation);
    expect(route.slice(cancellation, queueCreation)).toContain("status = 'cancelled'");
    expect(route.slice(cancellation, queueCreation)).toContain('return;');
  });

  test('worker refuses unauthorized or mismatched previews before setting running status', () => {
    const handler = workerSource.slice(workerSource.indexOf('async function handlePipelineRetry'), workerSource.indexOf('// ── Job handler: pipeline:cancel'));
    const authorization = handler.indexOf("previewRow?.status !== 'dispatched'");
    const comparison = handler.indexOf('compareRetryPlanToPreview(actualRetrySpec, approvedPreview)');
    const running = handler.indexOf("status = 'running', started_at = NOW()");
    expect(authorization).toBeGreaterThan(-1);
    expect(comparison).toBeGreaterThan(authorization);
    expect(running).toBeGreaterThan(comparison);
    expect(handler).toContain("emitWalEvent('retry_scope_mismatch'");
  });

  test('destructive capabilities require explicit approval and are never silently defaulted', () => {
    expect(route).toContain('approvedPreview.requiresApproval && !approvalToken');
    expect(route).toContain("merge: safeMode\n        ? { strategy: 'branch-only', autoMerge: false }");
    expect(route).toContain('externalSend: safeMode ? false : originalEffectiveOptions.safety.externalSend');
    expect(route).toContain('deploy: safeMode ? false : originalEffectiveOptions.safety.deploy');
  });
});
