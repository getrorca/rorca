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
const migration = [
  fs.readFileSync(path.join(srcRoot, 'db', 'pg-migrations', '20260715170000_retry_preview_governance.sql'), 'utf8'),
  fs.readFileSync(path.join(srcRoot, 'db', 'pg-migrations', '20260715190000_lifecycle_mutation_apis.sql'), 'utf8'),
].join('\n');

function retryRouteSource(): string {
  const start = pipelineSource.indexOf('export async function retryPipelineRunHandler');
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

  test('preview is read-only and cancellation returns before queue creation and dispatch', () => {
    const preview = route.indexOf('if (!previewHash)');
    const cancellation = route.indexOf('if (cancelPreview)');
    const queueCreation = route.indexOf("boss.createQueue('pipeline:retry')");
    expect(preview).toBeGreaterThan(-1);
    expect(cancellation).toBeGreaterThan(preview);
    expect(queueCreation).toBeGreaterThan(cancellation);
    expect(route.slice(preview, cancellation)).not.toContain('INSERT INTO pipeline_retry_previews');
    expect(route.slice(cancellation, queueCreation)).toContain('return;');
  });

  test('queue unavailability refuses the preview and cancels the created retry run', () => {
    expect(route).toContain('if (!bossJobId)');
    expect(route).toContain("refusal_reason = 'pgboss_send_returned_null'");
    expect(route).toContain("summary = 'retry_dispatch_failed'");
    expect(route).toContain("throw new ServiceUnavailableError('Retry queue rejected dispatch')");
  });

  test('restart/network replay returns the existing dispatched run before creating another', () => {
    const duplicate = route.indexOf("storedPreviewRow?.status === 'dispatched'");
    const insertRun = route.indexOf('INSERT INTO pipeline_runs');
    expect(duplicate).toBeGreaterThan(-1);
    expect(insertRun).toBeGreaterThan(duplicate);
    expect(route.slice(duplicate, insertRun)).toContain('duplicate: true');
  });

  test('an atomic preview claim makes concurrent/restart replay fail closed before another run insert', () => {
    const claim = route.indexOf('INSERT INTO pipeline_retry_previews');
    const noClaim = route.indexOf('if (!approvalClaim)');
    const inProgress = route.indexOf('Retry preview dispatch is already in progress');
    const insertRun = route.indexOf('INSERT INTO pipeline_runs');
    expect(claim).toBeGreaterThan(-1);
    expect(noClaim).toBeGreaterThan(claim);
    expect(inProgress).toBeGreaterThan(noClaim);
    expect(insertRun).toBeGreaterThan(inProgress);
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

  test('destructive capabilities require explicit approval and policy defaults are host enforced', () => {
    expect(route).toContain('approvedPreview.requiresApproval && !approvalToken');
    expect(route).toContain('resolvePiRunSafetyOptions(originalRun.spec_path, sourceSpecJson');
    expect(route).toContain("? { strategy: 'branch-only', autoMerge: false }");
    expect(route).toContain('deploy: enforceSafeRetry ? false : retrySafety.deploy');
    expect(route).toContain('externalSend: enforceSafeRetry ? false : retrySafety.externalSend');
    expect(route).not.toMatch(/sourceSpecJson\._notes/);
  });
});
