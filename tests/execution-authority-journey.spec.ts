/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { expect, test, type Page, type Route } from '@playwright/test';

const WORKSPACE_ID = 'ws-1';
const RUN_ID = 42;
const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const STALE_REQUEST_ID = '20000000-0000-4000-8000-000000000001';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${'b'.repeat(64)}`;
const WAIT_EXPIRY = '2099-08-24T12:00:00.000Z';
const EVIDENCE_KINDS = [
  'migration',
  'api',
  'ui',
  'crash_recovery',
  'redaction',
  'disposable_fixture_smoke',
] as const;

type WaitState = 'waiting_for_authorization' | 'waiting_for_authentication' | 'waiting_for_change_window';

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function authorityRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'rorca.execution-authority.v1',
    id: REQUEST_ID,
    intentId: '10000000-0000-4000-8000-000000000002',
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    storyId: 'REA-006',
    requestingPrincipal: 'execution:run:42',
    capabilityId: 'github.branch.write',
    bindingReference: 'binding://github/repository',
    bindingGeneration: 7,
    environment: 'staging',
    providerResourceId: 'repository:rorca/core',
    operation: 'create_branch',
    constraints: { branch: 'run/42', protected: false },
    evidenceDigest: EVIDENCE_DIGEST,
    requestDigest: DIGEST,
    status: 'pending',
    maximumUses: 1,
    expiresAt: WAIT_EXPIRY,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}
function authorityProfile(state: 'disabled' | 'enabled') {
  return {
    schemaVersion: 'rorca.execution-authority-profile.v1',
    policyVersion: 'rorca.execution-authority-rollout.v1',
    workspaceId: WORKSPACE_ID,
    state,
    generation: state === 'enabled' ? 2 : 1,
    transitionPrincipal: state === 'enabled' ? 'local-operator:local-admin' : 'system:migration',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T11:00:00.000Z',
    enabledAt: state === 'enabled' ? '2026-08-24T11:00:00.000Z' : null,
    disabledAt: state === 'disabled' ? '2026-08-24T10:00:00.000Z' : null,
    readyToEnable: true,
    missingEvidenceKinds: [],
    evidence: EVIDENCE_KINDS.map((evidenceKind, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      schemaVersion: 'rorca.execution-authority-rollout-evidence.v1',
      evidenceKind,
      result: 'passed',
      artifactReference: `fixture://rea-008/${evidenceKind}`,
      evidenceDigest: `sha256:${String(index + 1).repeat(64)}`,
      observedAt: '2026-08-24T10:30:00.000Z',
      operatorPrincipal: 'local-operator:local-admin',
      createdAt: '2026-08-24T10:30:00.000Z',
    })),
    evidenceHistoryCount: 6,
    mutationProviderAdapterIds: [],
  };
}

async function installAuthorityTransport(page: Page) {
  let lifecycleStatus: WaitState = 'waiting_for_authorization';
  let currentRequest = authorityRequest();
  const staleRequest = authorityRequest({
    id: STALE_REQUEST_ID,
    storyId: 'REA-005',
    expiresAt: '2020-01-01T00:00:00.000Z',
  });
  let decision: Record<string, unknown> | null = null;
  let grant: Record<string, unknown> | null = null;
  let profile = authorityProfile('disabled');
  let mutationCapabilityHeader: string | null = null;

  await page.addInitScript((workspaceId) => {
    localStorage.setItem('rorca_workspaceId', workspaceId);
    sessionStorage.setItem('rorca_workspaceId', workspaceId);
    localStorage.setItem('rorca_theme', 'light');
  }, WORKSPACE_ID);

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/csrf-token') return json(route, { token: 'authority-journey-csrf' });
    if (path === '/api/workspaces') return json(route, {
      items: [{ id: WORKSPACE_ID, label: 'Authority Journey', path: '/tmp/authority-journey', domains: ['rorca-platform'] }],
      total: 1,
      hasMore: false,
    });
    if (path === `/api/admin/execution-authority/workspaces/${WORKSPACE_ID}/profile`) {
      if (request.method() === 'POST') {
        mutationCapabilityHeader = request.headers()['x-rorca-operator-capability'] ?? null;
        profile = authorityProfile('enabled');
      }
      return json(route, profile);
    }
    if (path === `/api/admin/execution-authority/workspaces/${WORKSPACE_ID}/requests`) {
      return json(route, { items: [currentRequest, staleRequest], total: 2, hasMore: false });
    }
    if (path === `/api/admin/execution-authority/workspaces/${WORKSPACE_ID}/requests/${REQUEST_ID}`) {
      return json(route, { request: currentRequest, decision, grant, bindingHealth: 'healthy' });
    }
    if (path === `/api/admin/execution-authority/workspaces/${WORKSPACE_ID}/requests/${STALE_REQUEST_ID}`) {
      return json(route, { request: staleRequest, decision: null, grant: null, bindingHealth: 'healthy' });
    }
    if (path === `/api/admin/execution-authority/workspaces/${WORKSPACE_ID}/requests/${REQUEST_ID}/approve`
      && request.method() === 'POST') {
      mutationCapabilityHeader = request.headers()['x-rorca-operator-capability'] ?? null;
      currentRequest = {
        ...currentRequest,
        status: 'approved',
        updatedAt: '2026-08-24T11:00:00.000Z',
        resolvedAt: '2026-08-24T11:00:00.000Z',
      };
      decision = {
        operatorPrincipal: 'local-operator:local-admin',
        decision: 'approved',
        reasonCode: 'scope_reviewed',
        createdAt: '2026-08-24T11:00:00.000Z',
      };
      grant = {
        status: 'active',
        maximumUses: 1,
        usesConsumed: 0,
        fencingGeneration: 1,
        expiresAt: WAIT_EXPIRY,
      };
      lifecycleStatus = 'waiting_for_authorization';
      return json(route, { decision, grant });
    }
    if (path === `/api/pipeline/runs/${RUN_ID}`) {
      return json(route, {
        run: {
          id: RUN_ID,
          spec_path: 'forge/specs/approved/execution-authority.json',
          workspace_id: WORKSPACE_ID,
          status: lifecycleStatus.toUpperCase(),
          lifecycleStatus,
          lifecycle_status: lifecycleStatus,
          lifecycle_diagnostics: { authorityWaitExpiresAt: WAIT_EXPIRY },
          pid: null,
          branch_name: 'run/42',
          worktree_path: '/tmp/run-42',
          started_at: '2026-08-24T10:00:00.000Z',
          finished_at: null,
          agent_type: 'pi',
          agent_model: null,
          terminal_mode: 'ansi-html',
          parallelism: 1,
        },
        stories: [],
        specStories: [],
        storyTokenBreakdown: [],
        contextComparison: null,
        runState: null,
      });
    }
    if (path === `/api/pipeline/runs/${RUN_ID}/output`
      || path === '/api/pipeline/stream'
      || path === '/api/wal/stream') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }
    if (path === '/api/pipeline/runs') return json(route, { items: [], total: 0, hasMore: false });
    return json(route, { items: [], total: 0, hasMore: false, config: {}, connected: false });
  });

  return {
    setWaitState(next: WaitState) { lifecycleStatus = next; },
    capabilityHeader() { return mutationCapabilityHeader; },
  };
}

test('operator inspects and decides an exact workspace request with keyboard and focus safety', async ({ page }) => {
  const transport = await installAuthorityTransport(page);
  await page.goto('/settings/github');
  const capabilityInput = page.getByLabel('Local operator capability');
  await capabilityInput.fill('operator-preimage-never-render');
  await page.getByRole('button', { name: 'Unlock provider changes' }).click();
  await expect(capabilityInput).toHaveValue('');
  await page.getByRole('link', { name: 'Back to Rorca' }).click();
  await page.getByRole('link', { name: 'Execution Authority' }).click();
  await expect(page).toHaveURL(/\/execution-authority$/);
  const enableProfile = page.getByRole('button', { name: 'Enable Execution Authority capability profile' });
  await expect(page.getByText('Generation 1 · 6 retained evidence records · 0 mutation adapters')).toBeVisible();
  await expect(enableProfile).toBeEnabled();
  await enableProfile.click();
  await expect(page.getByText('Execution Authority enabled. No mutation-capable provider adapter is registered.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disable Execution Authority capability profile' })).toBeVisible();

  const selectedWorkspaceList = page.getByRole('list', { name: 'Selected workspace authority requests' });
  const activeRow = selectedWorkspaceList.getByRole('button').filter({ hasText: 'REA-006' });
  const staleRow = selectedWorkspaceList.getByRole('button').filter({ hasText: 'REA-005' });
  await expect(activeRow).toContainText('Active');
  await expect(staleRow).toContainText('Stale');
  await activeRow.focus();
  await page.keyboard.press('ArrowDown');
  await expect(staleRow).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(activeRow).toBeFocused();

  await activeRow.press('Enter');
  const detail = page.getByRole('dialog', { name: 'Authority request detail' });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(DIGEST);
  await expect(detail).toContainText('execution:run:42');
  await expect(detail).toContainText('create_branch');
  await expect(detail).toContainText('repository:rorca/core');
  await expect(detail).toContainText('staging');
  await expect(detail).toContainText(EVIDENCE_DIGEST);
  await expect(detail).toContainText('Binding generation');
  await expect(detail).toContainText('Healthy at latest adapter preflight');
  await expect(detail).toContainText('Maximum uses');
  await expect(detail).not.toContainText('operator-preimage-never-render');

  await detail.getByRole('button', { name: 'Deny authority request' }).click();
  const destructive = page.getByRole('alertdialog', { name: 'Deny request' });
  await expect(destructive).toContainText('Destructive authority decision');
  await destructive.getByRole('button', { name: 'Go back' }).click();
  await expect(destructive).toBeHidden();

  await detail.getByRole('button', { name: 'Approve exact authority request' }).click();
  const approval = page.getByRole('alertdialog', { name: 'Approve exact request' });
  await expect(approval).toContainText(DIGEST);
  await approval.getByRole('button', { name: 'Confirm approve for exact request digest' }).click();
  await expect(detail).toContainText('Request and run state refreshed');
  expect(transport.capabilityHeader()).toBe('operator-preimage-never-render');
  await expect(page.locator('body')).not.toContainText('operator-preimage-never-render');

  await detail.getByRole('button', { name: 'Close panel' }).click();
  await expect(activeRow).toBeFocused();

  await staleRow.press('Enter');
  const staleDetail = page.getByRole('dialog', { name: 'Authority request detail' });
  await expect(staleDetail).toContainText('Decision controls are disabled');
  await expect(staleDetail.getByRole('button', { name: 'Approve exact authority request' })).toBeDisabled();
});

test('Run View distinguishes every durable authority wait while story timeout stays stopped', async ({ page }) => {
  const transport = await installAuthorityTransport(page);
  const states: Array<[WaitState, string]> = [
    ['waiting_for_authorization', 'Waiting for authorization'],
    ['waiting_for_authentication', 'Waiting for authentication'],
    ['waiting_for_change_window', 'Waiting for change window'],
  ];

  for (const [state, label] of states) {
    transport.setWaitState(state);
    await page.goto(`/runs/${RUN_ID}`);
    const banner = page.getByTestId('authority-wait-state');
    await expect(banner).toHaveAccessibleName(label);
    await expect(banner).toContainText(state.toUpperCase());
    await expect(banner).toContainText('Story execution timeout is stopped');
    await expect(banner).toContainText('Authority wait expires independently');
    await expect(page.getByRole('button', { name: 'Pause unavailable while waiting for Execution Authority' })).toBeDisabled();
  }
});
