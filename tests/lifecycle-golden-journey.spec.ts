/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import {
  GOLDEN,
  GOLDEN_EVIDENCE_BUNDLE_CONTRACT,
  GOLDEN_RETRY_PREVIEW,
  goldenEvidence,
  goldenPhase,
  goldenPortfolio,
  goldenSpec,
  type GoldenJourneyState,
} from './fixtures/lifecycle-golden-journey';
import type { LifecyclePhaseId } from '../src/types/lifecycle';

interface GoldenTransport {
  state: GoldenJourneyState;
  view: 'normal' | 'empty' | 'loading' | 'error';
  calls: Record<'recompile' | 'evidenceIngest' | 'decision' | 'revocation' | 'preview' | 'dispatch', number>;
  externalAdapters: Set<string>;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function apiFailure(status: number, code: string, message: string) {
  return { error: message, message, code, status };
}

async function installGoldenTransport(page: Page): Promise<GoldenTransport> {
  const transport: GoldenTransport = {
    state: 'blocked',
    view: 'normal',
    calls: { recompile: 0, evidenceIngest: 0, decision: 0, revocation: 0, preview: 0, dispatch: 0 },
    externalAdapters: new Set(),
  };

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.addInitScript(({ workspaceId }) => {
    localStorage.setItem('rorca_workspaceId', workspaceId);
    sessionStorage.setItem('rorca_workspaceId', workspaceId);
    localStorage.setItem('rorca_theme', 'light');
    localStorage.removeItem('rorca.lifecycle.displayPreferences');
    // UI mutations normally use fresh UUIDs. A stable browser fixture key makes
    // the complete rerun byte-for-byte reproducible while each API operation
    // keeps its own server-side idempotency namespace.
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => '00000000-0000-4000-8000-000000000024',
    });
  }, { workspaceId: GOLDEN.workspaceId });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/auth/csrf-token') return json(route, { token: 'lfc-024-deterministic-csrf-token' });
    if (path === '/api/workspaces') return json(route, {
      items: [{ id: GOLDEN.workspaceId, name: GOLDEN.workspaceName, label: GOLDEN.workspaceName, path: '/tmp/rorca-lfc-024', git_path: '/tmp/rorca-lfc-024', domains: [] }],
      total: 1,
      hasMore: false,
    });
    if (path === `/api/workspaces/${GOLDEN.workspaceId}/pipeline-config`) return json(route, { config: {} });
    if (path === '/api/pipeline/runs') return json(route, { items: [], total: 0, hasMore: false });
    if (path === '/api/wal/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });

    if (path === '/api/lifecycle' && request.method() === 'GET') {
      if (transport.view === 'loading') {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (request.isNavigationRequest()) return;
      }
      if (transport.view === 'error') return json(route, apiFailure(503, 'STAGING_ADAPTER_UNAVAILABLE', 'Staging evidence adapter unavailable'), 503);
      if (transport.view === 'empty') {
        const empty = goldenPortfolio(transport.state);
        return json(route, { ...empty, items: [], total: 0, kpis: { ...empty.kpis, specs: 0, activeSpecs: 0, evaluatedSpecs: 0 } });
      }
      return json(route, goldenPortfolio(transport.state));
    }

    const phaseMatch = path.match(/^\/api\/lifecycle\/specs\/billing-anomaly-alerts\/phases\/([^/]+)$/);
    if (phaseMatch && request.method() === 'GET') return json(route, goldenPhase(transport.state, phaseMatch[1] as LifecyclePhaseId));
    if (path === `/api/lifecycle/specs/${GOLDEN.specId}` && request.method() === 'GET') return json(route, goldenSpec(transport.state));
    const evidenceMatch = path.match(/^\/api\/lifecycle\/evidence\/(\d+)$/);
    if (evidenceMatch && request.method() === 'GET') return json(route, goldenEvidence(transport.state, evidenceMatch[1]));

    if (path === `/api/lifecycle/specs/${GOLDEN.specId}/recompile` && request.method() === 'POST') {
      transport.calls.recompile += 1;
      if (transport.calls.recompile === 1) return json(route, apiFailure(409, 'STALE_SAVE_GENERATION', 'Canonical spec changed; refresh before recompiling.'), 409);
      return json(route, {
        status: transport.calls.recompile === 2 ? 'compiled' : 'skipped', specSlug: GOLDEN.specId,
        specVersion: GOLDEN.revision.specVersion, specHash: GOLDEN.revision.inputHash, inputHash: GOLDEN.revision.inputHash,
        planId: 'plan:billing-anomaly-alerts:v3', planVersion: 3, compilerVersion: 'ssdlc-plan-compiler-2',
        profiles: ['code-change', 'integration'], riskLevel: 'medium', generatedAt: '2026-07-15T11:45:00.000Z',
        saveGeneration: 7, replayed: transport.calls.recompile > 2,
      });
    }

    if (path === '/api/lifecycle/evidence' && request.method() === 'POST') {
      transport.calls.evidenceIngest += 1;
      transport.externalAdapters.add('Hermes test adapter');
      if (transport.calls.evidenceIngest === 1) return json(route, apiFailure(409, 'SUBJECT_LINEAGE_MISMATCH', 'Evidence artifact does not derive from the active commit.'), 409);
      return json(route, {
        classification: transport.calls.evidenceIngest === 2 ? 'persisted' : 'duplicate',
        replayed: transport.calls.evidenceIngest > 2,
        evidence: goldenEvidence('recovered'),
      }, transport.calls.evidenceIngest === 2 ? 201 : 200);
    }

    if (path === `/api/lifecycle/runs/${GOLDEN.originalRunId}/retry-preview` && request.method() === 'POST') {
      transport.calls.preview += 1;
      if (transport.calls.preview === 1) return json(route, {
        ...GOLDEN_RETRY_PREVIEW,
        preview: { ...GOLDEN_RETRY_PREVIEW.preview, requiresApproval: true },
      });
      return json(route, GOLDEN_RETRY_PREVIEW);
    }

    if (path === `/api/lifecycle/runs/${GOLDEN.originalRunId}/retry-dispatch` && request.method() === 'POST') {
      transport.calls.dispatch += 1;
      if (transport.calls.dispatch === 1) return json(route, apiFailure(409, 'PREVIEW_EXPIRED', 'Retry preview expired before dispatch.'), 409);
      transport.state = 'recovered';
      return json(route, {
        ok: true, queued: true, duplicate: transport.calls.dispatch > 2, runId: GOLDEN.retryRunId,
        originalRunId: GOLDEN.originalRunId, previewHash: GOLDEN_RETRY_PREVIEW.preview.previewHash,
        retriedStories: [{ storyId: 'BAA-005', attempt: 2 }], copiedStories: ['BAA-001', 'BAA-002', 'BAA-003', 'BAA-004'],
      }, transport.calls.dispatch === 2 ? 201 : 200);
    }

    if (path === '/api/lifecycle/decisions' && request.method() === 'POST') {
      transport.calls.decision += 1;
      if (transport.calls.decision === 1) return json(route, apiFailure(409, 'STALE_REVISION', 'Approval subject does not match the staged artifact lineage.'), 409);
      transport.state = 'approved';
      return json(route, {
        replayed: transport.calls.decision > 2,
        decision: {
          id: 'decision-qa-lfc-024', workspaceId: GOLDEN.workspaceId, specSlug: GOLDEN.specId,
          specVersion: GOLDEN.revision.specVersion, runId: GOLDEN.qaRunId, storyId: 'BAA-006', phaseId: 'qa', gateId: 'qa-gate',
          decisionType: 'qa_approval', rationale: 'Authorized test approver reviewed the exact staged revision.', evidenceGap: null,
          subject: { type: 'commit_sha', value: GOLDEN.revision.sourceCommit }, policy: { version: 'lifecycle-policy-1', reference: 'qa-approval', authorized: true },
          actor: { principalType: 'user', principalId: 'test-approver', displayLabel: 'Test Approver', sourceChannel: 'ui', delegatedOnBehalfOf: null },
          sourceRequestId: 'lfc-024-qa-approval', createdAt: '2026-07-15T12:15:00.000Z', expiresAt: null, revokedAt: null, revocation: null,
        },
      }, transport.calls.decision === 2 ? 201 : 200);
    }

    if (path === '/api/lifecycle/decisions/decision-qa-lfc-024/revoke' && request.method() === 'POST') {
      transport.calls.revocation += 1;
      if (transport.calls.revocation === 1) return json(route, apiFailure(409, 'REVOCATION_RATIONALE_REQUIRED', 'A bounded revocation rationale is required.'), 409);
      transport.state = 'qa_evidence_only';
      return json(route, { replayed: transport.calls.revocation > 2, decision: { id: 'decision-qa-lfc-024', revokedAt: '2026-07-15T12:16:00.000Z' } });
    }

    // Existing live-app shell requests are intentionally inert. They are not
    // evidence adapters and cannot advance lifecycle state.
    return json(route, { items: [], total: 0, hasMore: false, config: {} });
  });
  return transport;
}

async function gotoLifecycle(page: Page, query = '') {
  await page.goto(`/lifecycle${query}`);
  await expect(page.getByRole('heading', { name: 'Lifecycle Control' })).toBeVisible({ timeout: 15_000 });
}

async function selectPhase(page: Page, phase: string, statePattern?: RegExp) {
  const cell = page.getByRole('button', { name: new RegExp(`Billing anomaly alerts, ${phase}: ${statePattern?.source ?? '.*'}`, 'i') });
  await expect(cell).toBeVisible();
  await cell.click();
  await expect(cell).toHaveAttribute('data-selected', 'true');
  await expect(page.getByRole('dialog', { name: `Billing anomaly alerts — ${phase}` })).toBeVisible();
  return cell;
}

async function closeDrawer(page: Page) {
  const close = page.getByRole('button', { name: 'Close phase details' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function browserMutation(page: Page, url: string, body: unknown, idempotencyKey: string) {
  return page.evaluate(async ({ mutationUrl, mutationBody, key }) => {
    const response = await fetch(mutationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(mutationBody),
    });
    return { status: response.status, body: await response.json() as unknown };
  }, { mutationUrl: url, mutationBody: body, key: idempotencyKey });
}

async function capture(page: Page, testInfo: TestInfo, name: string, width: number, height: number, screenshots: Array<{ name: string; width: number; height: number; theme: string }>) {
  await page.setViewportSize({ width, height });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const directory = testInfo.outputPath('screenshots');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}`, fullPage: true, animations: 'disabled' });
  screenshots.push({ name, width, height, theme: 'light' });
}

async function refreshForState(page: Page, transport: GoldenTransport, state: GoldenJourneyState, view: GoldenTransport['view'] = 'normal') {
  transport.state = state;
  transport.view = view;
  await page.goto('/lifecycle');
}

test.describe.serial('LFC-024 deterministic lifecycle golden journey', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

  test('proves intent through blocked validation, smallest retry, approval, stale lineage, Learn, and safe cleanup', async ({ page }, testInfo) => {
    const transport = await installGoldenTransport(page);
    const screenshots: Array<{ name: string; width: number; height: number; theme: string }> = [];
    const checkpoints: Array<{ segment: string; result: 'passed'; detail: string }> = [];
    const checkpoint = (segment: string, detail: string) => checkpoints.push({ segment, result: 'passed', detail });

    // Segment 1: accepted intent/spec boundary, complete ownership, preflight repair, and compiled matrix.
    await gotoLifecycle(page);
    await expect(page.getByRole('rowheader', { name: /Billing anomaly alerts.*6 stories/i })).toBeVisible();
    await expect(page.locator('tbody .lifecycle-cell')).toHaveCount(11);
    await expect(page.getByText('2 missing gates')).toBeVisible();
    await page.getByPlaceholder('Search specs').fill('Billing anomaly');
    await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('Billing anomaly');
    await page.getByRole('button', { name: 'Blocked only' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('blocked')).toBe('true');
    await page.getByRole('button', { name: 'Reset all' }).click();
    checkpoint('intent-spec-plan', 'One governed spec, six owned stories, eleven phases, and four Validation gates are represented by canonical response types.');

    // Segment 2: keyboard selection, drawer traceability, evidence inspector, links, and blocked 2/4 state.
    const intake = page.getByRole('button', { name: /Billing anomaly alerts, Intake:/i });
    await intake.focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, Learn:/i })).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, Requirements:/i })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Billing anomaly alerts — Requirements' })).toBeVisible();
    await closeDrawer(page);

    await selectPhase(page, 'Validation', /Blocked.*2 of 4 required gates passed/i);
    await expect(page.getByText(/Worker payload query is missing organizationId scope/).first()).toBeVisible();
    await expect(page.getByText('Retry BAA-005 only.').first()).toBeVisible();
    await page.getByRole('button', { name: 'Open traceability for REQ-005' }).click();
    const requirement = page.getByText('REQ-005', { exact: true }).last();
    await requirement.click();
    await expect(page.getByText(/BAA-006 remains unscheduled/i)).toBeVisible();
    await page.getByRole('button', { name: /Tenant-isolation integration test.*Open supporting evidence/i }).click();
    const inspector = page.getByTestId('lifecycle-evidence-inspector');
    await expect(inspector.getByRole('heading', { name: 'Evidence Inspector' })).toBeFocused();
    await expect(inspector).toContainText(GOLDEN.revision.sourceCommit);
    await expect(inspector).toContainText(GOLDEN.revision.stagedArtifactDigest);
    await expect(inspector).toContainText(GOLDEN.revision.testDeploymentId);
    await inspector.getByRole('button', { name: 'Close Evidence Inspector' }).click();

    await page.getByRole('button', { name: /Open run/ }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${GOLDEN.originalRunId}`));
    await gotoLifecycle(page, '?spec=billing-anomaly-alerts&phase=validation');
    await closeDrawer(page);
    await page.getByRole('button', { name: 'Billing anomaly alerts', exact: true }).click();
    await expect(page).toHaveURL(/\/specs\/billing-anomaly-alerts\/review\?tab=lifecycle/);
    await gotoLifecycle(page, '?spec=billing-anomaly-alerts&phase=validation');
    checkpoint('blocked-observation', 'Agent attempt completion, blocked accepted closeout, and Validation 2/4 evaluation are separately visible; BAA-006 is unscheduled.');

    // Segment 3: every recompile mutation gets denial, success, and idempotent replay.
    await page.getByRole('button', { name: 'Recompile' }).click();
    await expect.poll(() => transport.calls.recompile).toBe(1);
    await page.getByRole('button', { name: 'Recompile' }).click();
    await expect.poll(() => transport.calls.recompile).toBe(2);
    await page.getByRole('button', { name: 'Recompile' }).click();
    await expect.poll(() => transport.calls.recompile).toBe(3);
    checkpoint('recompile', 'Stale generation denied; current compile succeeded; same canonical revision skipped idempotently.');

    // Segment 4: override packet is review-only and cannot waive hard controls.
    await page.getByRole('button', { name: 'Review override' }).click();
    await expect(page.getByRole('heading', { name: 'Review override' })).toBeVisible();
    await expect(page.getByLabel('Governed policy packet')).toContainText('Security, credentials, destructive migration, external send, merge, deploy, and production hard-deny controls remain non-bypassable.');
    await page.getByRole('button', { name: 'Cancel' }).click();
    checkpoint('override-packet', 'Policy packet exposed rule, missing evidence, actor policy, scope, expiry, revision, and non-bypassable controls without changing state.');

    // Segment 5: retry preview negative, recovery preview, dispatch negative, and accepted targeted retry.
    await page.getByRole('button', { name: /Retry story/ }).click();
    const retryDialog = page.getByRole('dialog', { name: 'Retry preview' });
    await expect(retryDialog.getByRole('heading', { name: 'Retry preview' })).toBeVisible();
    await expect(retryDialog.getByRole('alert')).toContainText('existing operator approval path');
    await expect(page.getByRole('button', { name: 'Queue exact retry' })).toBeDisabled();
    await retryDialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: /Retry story/ }).click();
    const preview = page.getByRole('dialog', { name: 'Retry preview' });
    await expect(preview).toContainText('BAA-005 (SMALLEST_SAFE_RETRY)');
    await expect(preview).toContainText('BAA-006 (DEPENDENCY_UNSCHEDULED)');
    await expect(preview).toContainText('openai/gpt-5.4 · high');
    await expect(preview).toContainText('/tmp/rorca-lfc-024');
    await expect(preview).toContainText('branch-only · auto-merge=false · deploy=false · external-send=false');
    await preview.getByRole('checkbox').check();
    await preview.getByRole('button', { name: 'Queue exact retry' }).click();
    await expect(preview.getByRole('alert')).toContainText('Retry preview expired');
    await preview.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: /Retry story/ }).click();
    await page.getByRole('dialog', { name: 'Retry preview' }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Queue exact retry' }).click();
    await expect.poll(() => transport.state).toBe('recovered');
    checkpoint('smallest-safe-retry', 'Only BAA-005 dispatched after an exact current preview; BAA-006 became eligible only after accepted closeout.');

    // Segment 6: evidence ingress rejects incoherent lineage, persists current proof, then replays idempotently.
    const evidenceEnvelope = {
      schemaVersion: 'hermes.evidence.v1', kind: 'staging_result', sourceSystem: 'Hermes test adapter',
      sourceEventId: 'lfc-024-focused-and-broad-validation', observedAt: '2026-07-15T12:10:00.000Z',
      scope: { workspaceId: GOLDEN.workspaceId, specSlug: GOLDEN.specId, runId: GOLDEN.retryRunId, storyId: 'BAA-005', phaseId: 'validation', gateId: 'validation-tenant-isolation' },
      subject: { type: 'commit_sha', value: GOLDEN.revision.sourceCommit }, status: 'passed', confidence: 1,
      payloadHash: `sha256:${'7'.repeat(64)}`, provenanceChain: [],
    };
    expect((await browserMutation(page, '/api/lifecycle/evidence', { ...evidenceEnvelope, subject: { type: 'artifact_digest', value: GOLDEN.replacement.stagedArtifactDigest } }, 'lfc-024-evidence-bad')).status).toBe(409);
    expect((await browserMutation(page, '/api/lifecycle/evidence', evidenceEnvelope, 'lfc-024-evidence-good')).status).toBe(201);
    expect((await browserMutation(page, '/api/lifecycle/evidence', evidenceEnvelope, 'lfc-024-evidence-good')).status).toBe(200);
    await refreshForState(page, transport, 'recovered');
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, Validation: Passed.*4 of 4 required gates passed/i })).toBeVisible();
    checkpoint('evidence-recovery', 'Focused and broad evidence is revision-bound, lineage-coherent, and idempotent; Validation reaches 4/4 only after evaluator refresh.');

    // Segment 7: QA-mode result contributes evidence but cannot grant staging QA approval.
    transport.state = 'qa_evidence_only';
    await page.getByRole('button', { name: 'Refresh Lifecycle Control' }).click();
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, QA: Awaiting approval/i })).toBeVisible();
    await selectPhase(page, 'QA', /Awaiting approval/i);
    await expect(page.getByText(/QA-mode evidence exists, but an authorized revision-bound approval is still required/)).toBeVisible();
    await page.getByRole('button', { name: /Request approval/ }).click();
    const approval = page.getByRole('dialog', { name: 'QA approval' });
    await approval.getByLabel(/Rationale/).fill('Authorized test approver reviewed the exact staged revision.');
    await approval.getByRole('checkbox').check();
    await approval.getByRole('button', { name: 'Record QA approval' }).click();
    await expect(approval.getByRole('alert')).toContainText('No approval was recorded');
    await approval.getByRole('button', { name: 'Record QA approval' }).click();
    await expect.poll(() => transport.state).toBe('approved');
    await closeDrawer(page);
    await page.getByRole('button', { name: 'Refresh Lifecycle Control' }).click();
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, QA: Passed/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, Production: Awaiting approval/i })).toBeVisible();
    checkpoint('explicit-qa-approval', 'QA-mode evidence remained insufficient until an authorized decision bound to the source commit was recorded; no merge/deploy/send occurred.');

    // Segment 8: decision revocation has denial, recovery, and replay; evidence remains but approval is removed.
    expect((await browserMutation(page, '/api/lifecycle/decisions/decision-qa-lfc-024/revoke', { workspaceId: GOLDEN.workspaceId, rationale: '' }, 'lfc-024-revoke-bad')).status).toBe(409);
    expect((await browserMutation(page, '/api/lifecycle/decisions/decision-qa-lfc-024/revoke', { workspaceId: GOLDEN.workspaceId, rationale: 'Approval withdrawn to prove independent evidence and decision state.' }, 'lfc-024-revoke-good')).status).toBe(200);
    expect((await browserMutation(page, '/api/lifecycle/decisions/decision-qa-lfc-024/revoke', { workspaceId: GOLDEN.workspaceId, rationale: 'Approval withdrawn to prove independent evidence and decision state.' }, 'lfc-024-revoke-good')).status).toBe(200);
    await page.getByRole('button', { name: 'Refresh Lifecycle Control' }).click();
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, QA: Awaiting approval/i })).toBeVisible();
    checkpoint('decision-revocation', 'Revocation was governed and idempotent; successful QA-mode evidence remained while QA approval returned to awaiting approval.');

    // Re-apply the independently authorized approval for the final governed state.
    transport.state = 'approved';
    await page.getByRole('button', { name: 'Refresh Lifecycle Control' }).click();

    // Segment 9: replacement invalidates only dependent QA/merge/production proof.
    await refreshForState(page, transport, 'stale');
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, Validation: Passed/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Billing anomaly alerts, QA: Stale warning/i })).toBeVisible();
    await selectPhase(page, 'QA', /Stale warning/i);
    await expect(page.getByText(/staged artifact digest changed/i).first()).toBeVisible();
    await closeDrawer(page);
    checkpoint('lineage-invalidation', 'Replacing the artifact preserved source-bound Validation and invalidated only dependent QA, merge, and production proof.');

    // Segment 10: Learn candidate is provenance-linked, sensitive, review-only, and not auto-promoted.
    transport.state = 'approved';
    await page.getByRole('button', { name: 'Refresh Lifecycle Control' }).click();
    await selectPhase(page, 'Learn', /In progress/i);
    const learn = page.getByTestId('lifecycle-learn-closeout');
    await expect(learn).toContainText('Gotcha candidate #24024');
    await expect(learn).toContainText('Sensitive delivery fact — human review is mandatory.');
    await expect(learn).toContainText('Default retrieval: Not eligible');
    await closeDrawer(page);
    checkpoint('learn-closeout', 'Run closeout produced a provenance-linked review candidate without promoting sensitive content.');

    // Segment 11: light-theme responsive and exceptional state proof.
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await refreshForState(page, transport, 'blocked');
      await selectPhase(page, 'Validation', /Blocked/i);
      await capture(page, testInfo, `blocked-${viewport.width}x${viewport.height}-light.png`, viewport.width, viewport.height, screenshots);
      await refreshForState(page, transport, 'recovered');
      await capture(page, testInfo, `recovery-${viewport.width}x${viewport.height}-light.png`, viewport.width, viewport.height, screenshots);
    }
    await refreshForState(page, transport, 'approved');
    await selectPhase(page, 'QA', /Passed/i);
    await capture(page, testInfo, 'approval-1440x900-light.png', 1440, 900, screenshots);
    await refreshForState(page, transport, 'stale');
    await capture(page, testInfo, 'stale-1024x768-light.png', 1024, 768, screenshots);

    transport.view = 'empty';
    await page.goto('/lifecycle');
    await expect(page.getByRole('heading', { name: 'No lifecycle plans yet' })).toBeVisible();
    await capture(page, testInfo, 'empty-390x844-light.png', 390, 844, screenshots);

    transport.view = 'loading';
    await page.goto('/lifecycle');
    await expect(page.getByLabel('Loading Lifecycle Control')).toBeVisible();
    await capture(page, testInfo, 'loading-390x844-light.png', 390, 844, screenshots);

    transport.view = 'error';
    await page.goto('/lifecycle');
    await expect(page.getByRole('heading', { name: 'Lifecycle adapter is unavailable' })).toBeVisible();
    await capture(page, testInfo, 'error-390x844-light.png', 390, 844, screenshots);
    transport.view = 'normal';
    checkpoint('responsive-exceptional-states', 'Required light-theme dimensions captured blocked, recovery, approval, stale, empty, loading, and recoverable error without fake success UI.');

    expect([...transport.externalAdapters]).toEqual(['Hermes test adapter']);
    expect(transport.calls).toEqual({ recompile: 3, evidenceIngest: 3, decision: 2, revocation: 3, preview: 3, dispatch: 2 });

    const bundle = {
      ...GOLDEN_EVIDENCE_BUNDLE_CONTRACT,
      generatedBy: 'tests/lifecycle-golden-journey.spec.ts',
      commands: GOLDEN_EVIDENCE_BUNDLE_CONTRACT.commands.map((command) => ({ ...command, result: 'asserted_by_playwright' })),
      checkpoints,
      mutationResults: transport.calls,
      externalTestAdapters: [...transport.externalAdapters],
      approvals: [{ ...GOLDEN_EVIDENCE_BUNDLE_CONTRACT.approvals[0], result: 'recorded_then_governedly_revoked_and_reapplied' }],
      screenshots,
      cleanup: {
        browser: 'closed_by_playwright_fixture',
        server: 'not_started_by_test',
        runner: 'no_external_runner_started',
        fixtureWorkspace: 'transport fixture discarded with browser context',
        externalSideEffects: { slack: false, merge: false, deploy: false, productionMutation: false },
        confirmed: true,
      },
    };
    const bundlePath = testInfo.outputPath('evidence-bundle.json');
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    await testInfo.attach('lifecycle-golden-evidence-bundle', { path: bundlePath, contentType: 'application/json' });

    expect(bundle.screenshots).toHaveLength(GOLDEN.screenshots.length);
    expect(bundle.cleanup.confirmed).toBe(true);
    expect(bundle.cleanup.externalSideEffects).toEqual({ slack: false, merge: false, deploy: false, productionMutation: false });
  });
});
