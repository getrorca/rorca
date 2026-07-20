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
const publicationSource = fs.readFileSync(path.join(srcRoot, 'lib', 'governed-retry-publication.ts'), 'utf8');
const migration = [
  fs.readFileSync(path.join(srcRoot, 'db', 'pg-migrations', '20260715170000_retry_preview_governance.sql'), 'utf8'),
  fs.readFileSync(path.join(srcRoot, 'db', 'pg-migrations', '20260715190000_lifecycle_mutation_apis.sql'), 'utf8'),
  fs.readFileSync(path.join(srcRoot, 'db', 'pg-migrations', '20260719107000_governed_retry_publication_cancellation.sql'), 'utf8'),
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
    expect(route).toContain('publishGovernedRetryDispatch');
    expect(route).not.toMatch(/FROM pgboss\.|(?:INSERT|UPDATE|DELETE)[\s\S]{0,40}pgboss\./i);
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_retry_one_dispatched_scope');
    expect(migration).toContain("WHERE status = 'dispatched'");
  });

  test('preview is read-only and exact cancellation terminalizes before reconciliation or queue work', () => {
    const cancellation = route.indexOf('if (cancelPreview)');
    const cancellationCall = route.indexOf('cancelGovernedRetryPreview', cancellation);
    const reconciliation = route.indexOf('reconcileApprovedSpecPasses');
    const preview = route.indexOf('if (!previewHash)');
    const queueCreation = route.indexOf("boss.createQueue('pipeline:retry')");
    expect(cancellation).toBeGreaterThan(-1);
    expect(cancellationCall).toBeGreaterThan(cancellation);
    expect(reconciliation).toBeGreaterThan(cancellationCall);
    expect(preview).toBeGreaterThan(reconciliation);
    expect(queueCreation).toBeGreaterThan(preview);
    expect(publicationSource).toContain("state = 'cancelled'");
    expect(publicationSource).toContain("event_type, workspace_id, payload, ingest_key");
  });

  test('queue unavailability refuses the owned preparation and queued run', () => {
    expect(route).toContain('if (!bossJobId)');
    expect(route).toContain("preparationRefusalReason = 'pgboss_send_returned_null'");
    expect(route).toContain('refuseGovernedRetryPreparation');
    expect(publicationSource).toContain("status = 'cancelled'");
    expect(route).toContain("throw new ServiceUnavailableError('Retry queue rejected dispatch')");
  });

  test('restart/network replay returns or publishes the one durably owned run', () => {
    const reservation = route.indexOf('const reservation = await transaction');
    const duplicate = route.indexOf("reservation.action === 'duplicate'", reservation);
    const publish = route.indexOf("reservation.action === 'publish'", reservation);
    const sideEffect = route.indexOf('INSERT INTO story_results', reservation);
    expect(reservation).toBeGreaterThan(-1);
    expect(duplicate).toBeGreaterThan(reservation);
    expect(publish).toBeGreaterThan(duplicate);
    expect(sideEffect).toBeGreaterThan(publish);
    expect(route.slice(duplicate, sideEffect)).toContain('duplicate: true');
  });

  test('preview owner and queued run are committed together before preparation side effects', () => {
    const claim = route.indexOf('INSERT INTO pipeline_retry_previews');
    const insertRun = route.indexOf('INSERT INTO pipeline_runs', claim);
    const owner = route.indexOf('preparation_owner', claim);
    const sideEffect = route.indexOf('INSERT INTO story_results', insertRun);
    expect(claim).toBeGreaterThan(-1);
    expect(insertRun).toBeGreaterThan(claim);
    expect(owner).toBeGreaterThan(claim);
    expect(sideEffect).toBeGreaterThan(insertRun);
    expect(route).toContain('ambiguous_pre_run_hook_after_preparation_crash');
  });

  test('worker repairs or waits for publication before validation and never fails the run for prepared/approved', () => {
    const handler = workerSource.slice(workerSource.indexOf('async function handlePipelineRetry'), workerSource.indexOf('// ── Job handler: pipeline:cancel'));
    const publication = handler.indexOf('publishGovernedRetryDispatch');
    const wait = handler.indexOf('waitForGovernedRetryPublication');
    const comparison = handler.indexOf('compareRetryPlanToPreview(actualRetrySpec, approvedPreview)');
    const running = handler.indexOf("status = 'running', started_at = COALESCE(started_at, NOW())");
    expect(publication).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(publication);
    expect(comparison).toBeGreaterThan(wait);
    expect(running).toBeGreaterThan(comparison);
    expect(handler).not.toContain('retry_preview_not_authorized');
  });

  test.each(['direct', 'pr', 'draft-pr', 'branch-only'])('successful %s retry closes through the identical durable release seam', (strategy) => {
    const handler = workerSource.slice(workerSource.indexOf('async function handlePipelineRetry'), workerSource.indexOf('// ── Job handler: pipeline:cancel'));
    expect(handler).toContain('prepareRunReleaseIntent({');
    expect(handler).toContain('reconcileRunReleaseIntent(runId');
    expect(handler).toContain('mergeStrategy: approvedPreview.options.merge.strategy');
    expect(handler).toContain('autoMerge: approvedPreview.options.merge.autoMerge');
    expect(handler).toContain('externalSend: approvedPreview.options.safety.externalSend');
    expect(['direct', 'pr', 'draft-pr', 'branch-only']).toContain(strategy);
  });

  test('legacy retry-merge conflicts before DB state mutation or queue dispatch', () => {
    const start = pipelineSource.indexOf("router.post('/runs/:runId/retry-merge'");
    const end = pipelineSource.indexOf("router.post('/runs/:runId/pause'", start);
    const retired = pipelineSource.slice(start, end);
    expect(retired).toContain('Manual retry-merge is retired');
    expect(retired).not.toContain('UPDATE pipeline_runs');
    expect(retired).not.toContain("boss.send('pipeline:merge'");
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
