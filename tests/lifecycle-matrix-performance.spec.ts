import { expect, test } from '@playwright/test';
import { createLifecycleMatrixFixture } from '../src/fixtures/lifecycleMatrix';
import { LIFECYCLE_PHASES } from '../src/types/lifecycle';

const marks = {
  snapshotId: 'snapshot:matrix-performance',
  evidenceHighWaterMark: 'evidence:12',
  decisionHighWaterMark: 'decision:4',
};

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

const items = createLifecycleMatrixFixture(50).map((item) => ({ ...item, ...marks }));

const portfolio = {
  items,
  total: 50,
  hasMore: false,
  workspace: { id: 'ws-1', label: 'Lifecycle CI fixture' },
  phaseOrder: LIFECYCLE_PHASES,
  ...marks,
  kpis: {
    specs: 50,
    activeSpecs: 50,
    evaluatedSpecs: 50,
    needsCompilation: 0,
    blockedSpecs: 50,
    missingGates: 100,
    readyForQa: 0,
    waitingApprovals: 50,
    recentPhaseTransitions: 12,
    stories: 300,
    phases: { total: 550, excluded: 100, denominator: 450, passed: 100, completionRate: 2 / 9, byStatus: {} },
  },
};

const detail = {
  workspaceId: 'ws-1',
  specId: 'billing-anomaly-alerts',
  title: 'Billing anomaly alerts',
  state: 'current',
  plan: null,
  provenance: null,
  overallReadiness: { ready: false, status: 'blocked', completionRate: 0.5, counts: null },
  phaseTimeline: items[0].phases,
  traceability: {
    requirements: { items: [], total: 0, truncated: false },
    stories: { items: [], total: 0, truncated: false },
    architectureDecisions: { items: [], total: 0, truncated: false },
    gates: { items: [], total: 0, truncated: false },
    evidence: { total: 0, validForCurrentRevision: 0, stale: 0, boundedAt: 0 },
  },
  currentRun: null,
  evaluationSnapshot: marks,
  ...marks,
};

const phaseDetail = {
  workspaceId: 'ws-1',
  specId: 'billing-anomaly-alerts',
  phaseId: 'validation',
  state: 'current',
  status: 'blocked',
  disposition: 'required',
  whyRequired: 'User-visible background processing requires integration and tenant-isolation validation.',
  mappedRequirements: { items: [], total: 0, truncated: false },
  mappedDecisions: { items: [], total: 0, truncated: false },
  mappedStories: { items: [], total: 0, truncated: false },
  governedDecisions: { items: [], total: 0, truncated: false },
  requiredGates: { items: [], total: 4, truncated: false },
  evidence: { items: [], total: 0, hasMore: false },
  blocker: { gateId: 'validation-tenant-isolation', reason: 'Tenant-isolation integration test is failing.' },
  nextSafeAction: 'Retry the smallest validation scope.',
  permittedActions: ['inspect_evidence', 'retry_smallest_scope'],
  evaluationSnapshot: marks,
  ...marks,
};

test('50-row lifecycle matrix meets the documented interaction budget', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The acceptance budget is defined for the Chromium CI profile.');
  await page.addInitScript(() => {
    localStorage.setItem('rorca_workspaceId', 'ws-1');
    sessionStorage.setItem('rorca_workspaceId', 'ws-1');
  });

  await page.route('**/api/workspaces', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'ws-1', label: 'Lifecycle CI fixture', path: '/tmp/fixture', domains: [] }], total: 1, hasMore: false }),
  }));
  await page.route('**/api/pipeline/runs?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route('**/api/workspaces/ws-1/pipeline-config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"config":{}}' }));
  await page.route('**/api/lifecycle?*', (route) => {
    const workspaceId = new URL(route.request().url()).searchParams.get('workspaceId');
    return route.fulfill({
      status: workspaceId === 'ws-1' ? 200 : 400,
      contentType: 'application/json',
      body: workspaceId === 'ws-1' ? JSON.stringify(portfolio) : JSON.stringify({ error: 'Missing active workspace scope' }),
    });
  });
  await page.route('**/api/lifecycle/specs/billing-anomaly-alerts/phases/validation?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(phaseDetail) }));
  await page.route('**/api/lifecycle/specs/billing-anomaly-alerts?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }));

  const responseReady = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/lifecycle');
  await page.goto('/lifecycle?limit=50&mode=matrix');
  await responseReady;
  const dataAvailableAt = await page.evaluate(() => performance.now());
  const validationCell = page.getByRole('button', { name: /Billing anomaly alerts, Validation: Blocked.*2 of 4 required gates passed/i });
  await expect(validationCell).toBeVisible();
  const interactiveAt = await page.evaluate(() => performance.now());
  expect(interactiveAt - dataAvailableAt).toBeLessThanOrEqual(1_000);
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await expect(page.locator('tbody .lifecycle-cell')).toHaveCount(550);

  const openAndMeasure = async () => {
    const elapsed = await validationCell.evaluate(async (button) => {
      const start = performance.now();
      (button as HTMLButtonElement).click();
      await new Promise<void>((resolve, reject) => {
        const deadline = start + 1_000;
        const inspect = () => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
          const selected = button.getAttribute('data-selected') === 'true';
          if (selected && dialog && dialog.getBoundingClientRect().width > 0) return resolve();
          if (performance.now() > deadline) return reject(new Error('Phase drawer did not become visible'));
          requestAnimationFrame(inspect);
        };
        inspect();
      });
      return performance.now() - start;
    });
    await expect(page.getByRole('dialog', { name: 'Billing anomaly alerts — Validation' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 1_000 });
    return elapsed;
  };

  await openAndMeasure(); // warm-up is deliberately excluded
  const measurements: number[] = [];
  for (let run = 0; run < 20; run += 1) measurements.push(await openAndMeasure());
  console.log(`drawer feedback ms: ${measurements.map((value) => value.toFixed(1)).join(', ')}`);
  expect(Math.max(...measurements)).toBeLessThanOrEqual(100);
});
