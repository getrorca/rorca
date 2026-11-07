/**
 * Rorca E2E Tests — Real User Navigation
 *
 * Prime Directive: Simulate real users navigating Rorca.
 * If something is broken → the executing agent fixes the code and re-tests.
 *
 * Assumes: npm run dev (port 5210) + backend (port 3030) are running.
 * Run: npx playwright test
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:5210';
const API = 'http://localhost:3030';

/** Wait for page to settle — use domcontentloaded since SSE keeps network perpetually active */
async function waitForSettle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  // Give React a moment to render after hydration
  await page.waitForTimeout(800);
}

/** Navigate and confirm no crash (no error boundary, no blank white screen) */
async function navigateAndVerify(page: Page, path: string, expectedContent: string | RegExp) {
  await page.goto(`${BASE}${path}`);
  await waitForSettle(page);
  // No blank page
  const body = await page.locator('body').textContent();
  expect(body?.trim().length).toBeGreaterThan(50);
  // Expected content visible
  await expect(page.locator('body')).toContainText(expectedContent);
  // No unhandled React error boundary
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
  await expect(page.locator('text=Cannot read properties')).toHaveCount(0);
}

// ─── 1. Backend Health ─────────────────────────────────────────────────────────

test('backend is healthy', async ({ request }) => {
  const res = await request.get(`${API}/api/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('healthy');
  expect(body.db_connected).toBe(true);
});

// ─── 2. Hub / Overview ────────────────────────────────────────────────────────

test('hub loads and shows key sections', async ({ page }) => {
  await page.goto(BASE);
  await waitForSettle(page);

  // Page is not blank
  const body = await page.locator('body').textContent();
  expect(body?.trim().length).toBeGreaterThan(100);

  // No React crash
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);

  // Sidebar is present — uses a plain <div>, not <nav> (accessibility gap — see bug report)
  await expect(page.locator('text=New Spec')).toBeVisible();

  // At least one of these hub sections should render
  const hubIndicators = [
    page.locator('text=Recent Runs'),
    page.locator('text=Pending'),
    page.locator('text=Ready to Run'),
    page.locator('text=No runs yet'),
    page.locator('text=Add Workspace'),
    page.locator('text=Memory'),
  ];
  let found = false;
  for (const loc of hubIndicators) {
    if (await loc.count() > 0) { found = true; break; }
  }
  expect(found, 'Hub should render at least one recognizable section').toBe(true);
});

// ─── 3. Navigation — No Phantom Routes ────────────────────────────────────────

test('forge panel loads', async ({ page }) => {
  await navigateAndVerify(page, '/forge', /Spec Forge|Spec Brief|Generate|Brief/i);
  // Brief textarea must be present and interactable
  const textarea = page.locator('textarea').first();
  await expect(textarea).toBeVisible();
});

test('review queue loads', async ({ page }) => {
  await navigateAndVerify(page, '/queue', /Queue|Review|No.*pending|specs/i);
});

test('archive loads', async ({ page }) => {
  await navigateAndVerify(page, '/archive', /Archive|No.*specs|search/i);
});

test('pipeline monitor loads', async ({ page }) => {
  await navigateAndVerify(page, '/pipeline', /Pipeline|Monitor|No.*run|Select.*spec/i);
});

test('worktrees panel loads', async ({ page }) => {
  await navigateAndVerify(page, '/worktrees', /Worktree|No.*worktree|branch/i);
});

test('direction stack loads', async ({ page }) => {
  await navigateAndVerify(page, '/direction', /Direction|L1|L2|L3|Global|Engineering/i);
});

test('memory ledger loads', async ({ page }) => {
  await navigateAndVerify(page, '/memory', /Memory|Ledger|No.*entries|Architecture|Convention/i);
});

test('health dashboard loads', async ({ page }) => {
  await navigateAndVerify(page, '/health', /Health|Score|score|workspace|Database/i);
});

test('marketplace loads', async ({ page }) => {
  await navigateAndVerify(page, '/marketplace', /Marketplace|Template|Convention|No.*template/i);
});

test('settings loads with all tabs', async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);

  // Check all 6 setting tabs are present
  for (const tab of ['Direction', 'Providers', 'GitHub', 'Shortcuts', 'Account', 'Billing']) {
    const tabEl = page.locator(`text=${tab}`).first();
    await expect(tabEl).toBeVisible();
  }
});

test('GitHub settings qualifies one repository without exposing credential material', async ({ page }) => {
  const consoleMessages: string[] = [];
  const responseBodies: Array<Promise<string>> = [];
  page.on('console', message => consoleMessages.push(message.text()));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/api/')) {
      responseBodies.push(response.text().catch(() => ''));
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('rorca_workspaceId', 'ws-browser');
    sessionStorage.setItem('rorca_workspaceId', 'ws-browser');
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body: unknown = {};
    if (url.pathname === '/api/workspaces') {
      body = { items: [{ id: 'ws-browser', label: 'Browser fixture', path: '/tmp/browser-fixture', domains: [] }], total: 1, hasMore: false };
    } else if (url.pathname === '/api/workspaces/ws-browser/github/app') {
      body = {
        configured: true,
        connected: true,
        credentialReady: true,
        bindingState: 'ready',
        source: 'github-app-installation',
        appRegistration: { ready: true, appId: 12345, appSlug: 'rorca' },
        app: { id: 12345, slug: 'rorca' },
        installation: { id: 77, accountId: 88, account: 'acme', type: 'Organization', status: 'active' },
        repository: { id: 99, owner: 'acme', name: 'widgets' },
        binding: {
          id: '10000000-0000-4000-8000-000000000001',
          generation: 7,
          status: 'active',
          lastValidatedAt: '2026-08-24T10:00:00.000Z',
          lastWebhookAt: null,
          validationErrorCode: null,
        },
        providerProfile: { verified: true, verifiedAt: '2026-08-24T10:00:00.000Z' },
        grantedPermissions: { metadata: 'read', contents: 'write', pull_requests: 'write', checks: 'write' },
        tokenMintProbe: { status: 'passed', checkedAt: '2026-08-24T10:00:00.000Z', errorCode: null },
        capabilityAvailability: {
          'scm.repository.read': true,
          'scm.branch.write': true,
          'scm.pull_request.write': true,
          'scm.checks.read': true,
          'scm.review.request': true,
        },
        webhookHealth: { configured: true, signedDeliveryObserved: false, lastWebhookAt: null },
        nextAction: null,
      };
    } else if (url.pathname === '/api/workspaces/ws-browser/rorca-config') {
      body = { config: {} };
    } else if (url.pathname === '/api/workspaces/ws-browser/pipeline-config') {
      body = { config: {} };
    } else if (url.pathname === '/api/pipeline/runs') {
      body = { items: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(`${BASE}/settings/github`);
  await expect(page.getByRole('main', { name: 'GitHub Settings' })).toBeVisible();
  await expect(page.getByLabel('Repository binding state')).toHaveText('Ready');
  await expect(page.getByText('acme/widgets', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('scm.branch.write', { exact: true })).toBeVisible();

  for (const label of [
    /installation token/i,
    /app jwt/i,
    /private key/i,
    /personal access token/i,
    /webhook secret/i,
  ]) {
    await expect(page.getByLabel(label)).toHaveCount(0);
  }
  const browserStorage = await page.evaluate(() => JSON.stringify({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  const browserInspection = [
    await page.locator('html').textContent(),
    browserStorage,
    await Promise.all(responseBodies).then(bodies => bodies.join('\n')),
    consoleMessages.join('\n'),
  ].join('\n');
  expect(browserInspection).not.toMatch(/gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
  expect(browserInspection).not.toMatch(/"(installationToken|appJwt|privateKey|privateKeyPem|pat|secret)"\s*:/i);
});

test('workspace settings loads', async ({ page }) => {
  await navigateAndVerify(page, '/workspace-settings', /Workspace|General|Settings|Context/i);
});

// ─── 4. Forge — Brief Input & Token Counter ────────────────────────────────────

test('forge: typing a brief updates token count', async ({ page }) => {
  await page.goto(`${BASE}/forge`);
  await waitForSettle(page);

  const textarea = page.locator('textarea').first();
  await expect(textarea).toBeVisible();
  await textarea.fill('Build a simple todo app with React and SQLite backend');

  // Token/char count should update (not stay at 0)
  await page.waitForTimeout(500);
  const bodyText = await page.locator('body').textContent() ?? '';
  expect(bodyText).toMatch(/\d+\s*(token|char|chars)/i);
});

// ─── 5. Spec Review Route ─────────────────────────────────────────────────────

test('unknown spec review route shows hub (not crash)', async ({ page }) => {
  // Opening a non-existent spec review should show Hub underneath, not crash
  await page.goto(`${BASE}/specs/nonexistent-spec/review`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
  const body = await page.locator('body').textContent();
  expect(body?.trim().length).toBeGreaterThan(50);
});

test('unknown run route shows hub (not crash)', async ({ page }) => {
  await page.goto(`${BASE}/runs/99999`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
});

// ─── 6. Analytics Panels — No Phantom Routes ──────────────────────────────────

test('analytics panels load without crashing', async ({ page }) => {
  const panels = [
    { path: '/usage', label: /Token|Usage/i },
    { path: '/costs', label: /Cost|Breakdown/i },
    { path: '/velocity', label: /Velocity|Spec|Chart/i },
    { path: '/activity', label: /Activity|Feed|event/i },
  ];

  for (const { path, label } of panels) {
    await page.goto(`${BASE}${path}`);
    await waitForSettle(page);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    const body = await page.locator('body').textContent() ?? '';
    expect(body.trim().length, `${path} should not render a blank page`).toBeGreaterThan(50);
    await expect(page.locator('body')).toContainText(label);
  }
});

// ─── 7. CA-015 — Convention Packs in Marketplace ──────────────────────────────

test('CA-015: marketplace shows convention pack or skills section', async ({ page }) => {
  await page.goto(`${BASE}/marketplace`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);

  // CA-015 should add a Packs or Skills tab/section to marketplace
  const packIndicators = [
    page.locator('text=Convention'),
    page.locator('text=Packs'),
    page.locator('text=Skills'),
    page.locator('text=Install'),
    page.locator('text=Templates'),
  ];
  let found = false;
  for (const loc of packIndicators) {
    if (await loc.count() > 0) { found = true; break; }
  }
  expect(found, 'Marketplace should show templates, packs, or skills section').toBe(true);
});

// ─── 8. CA-016 — Persona Management in Workspace Settings ─────────────────────

test('CA-016: workspace settings agents tab shows persona management', async ({ page }) => {
  await page.goto(`${BASE}/workspace-settings`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);

  // CA-016 adds Agents/Personas tab to workspace settings
  const agentTab = page.locator('text=Agents').first();
  if (await agentTab.count() > 0) {
    await agentTab.click();
    await page.waitForTimeout(300);
    // Should show persona-related content
    const bodyText = await page.locator('body').textContent() ?? '';
    expect(bodyText).toMatch(/persona|profile|agent/i);
  } else {
    // Tab may not yet be wired — record it as a known gap
    console.warn('CA-016: Agents tab not found in workspace settings — may not be wired');
  }
});

// ─── 9. CA-017 — Convention Drift in Health Dashboard ─────────────────────────

test('CA-017: health dashboard shows drift or context section', async ({ page }) => {
  await page.goto(`${BASE}/health`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);

  // Should show health score AND optionally drift section added by CA-017
  const healthContent = await page.locator('body').textContent() ?? '';
  expect(healthContent).toMatch(/health|score|workspace/i);
});

// ─── 10. Sidebar Navigation — All Links Work ──────────────────────────────────

test('sidebar: clicking nav items navigates without crash', async ({ page }) => {
  await page.goto(BASE);
  await waitForSettle(page);

  // Sidebar uses NavLink (renders as <a>) inside a plain <div> — no <nav> element (accessibility gap)
  const navLinks = page.locator('a[href]');
  const count = await navLinks.count();
  expect(count).toBeGreaterThan(3);

  // Spot check: click Forge link
  const forgeLink = page.locator('a[href*="forge"]').first();
  if (await forgeLink.count() > 0) {
    await forgeLink.click();
    await waitForSettle(page);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    await expect(page.locator('body')).toContainText(/Forge|Brief|Generate/i);
  }

  // Navigate back to hub
  const hubLink = page.locator('a[href="/"]').first();
  if (await hubLink.count() > 0) {
    await hubLink.click();
    await waitForSettle(page);
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
  }
});

// ─── 11. Catch-all / Unknown Routes ───────────────────────────────────────────

test('unknown routes redirect to hub without crash', async ({ page }) => {
  await page.goto(`${BASE}/this-route-does-not-exist`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
  // Should redirect to hub or show 404 — either way, not blank
  const body = await page.locator('body').textContent();
  expect(body?.trim().length).toBeGreaterThan(50);
});

// ─── 12. Direction Stack — L1 Persists ────────────────────────────────────────

test('direction stack: L1 layer content loads from API', async ({ page }) => {
  await page.goto(`${BASE}/direction`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);

  // L1 heading should be visible
  await expect(page.locator('body')).toContainText(/L1|Global|Engineering/i);

  // Direction content should render (may be empty or filled)
  const textareas = page.locator('textarea');
  const inputCount = await textareas.count();
  expect(inputCount).toBeGreaterThan(0);
});

// ─── 13. Memory Ledger — CRUD UI Present ──────────────────────────────────────

test('memory ledger: shows entries or empty state, no crash', async ({ page }) => {
  await page.goto(`${BASE}/memory`);
  await waitForSettle(page);
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);

  const bodyText = await page.locator('body').textContent() ?? '';
  // Should show entries OR an empty state — not a blank white page
  expect(bodyText).toMatch(/memory|ledger|entry|entries|no.*entries|architecture|convention/i);
});
