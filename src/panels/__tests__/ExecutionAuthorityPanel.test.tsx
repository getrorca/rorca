/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMockWorkspace, renderWithProviders } from '../../test/helpers';
import ExecutionAuthorityPanel from '../ExecutionAuthorityPanel';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  apiFetchAuthorityMutation: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

vi.mock('../../api/executionAuthority', () => ({
  EXECUTION_AUTHORITY_EVIDENCE_KINDS: ['migration', 'api', 'ui', 'crash_recovery', 'redaction', 'disposable_fixture_smoke'],
  authorityUiErrorMessage: vi.fn(() => 'Execution Authority data is temporarily unavailable. Retry without changing the request.'),
  getAuthorityRequestDetail: vi.fn(),
  getExecutionAuthorityProfile: vi.fn(),
  getAuthorityRunState: vi.fn(),
  listAuthorityRequests: vi.fn(),
  mutateAuthorityRequest: vi.fn(),
  transitionExecutionAuthorityProfile: vi.fn(),
}));

import { apiFetch } from '../../lib/apiFetch';
import {
  getAuthorityRequestDetail,
  getAuthorityRunState,
  getExecutionAuthorityProfile,
  listAuthorityRequests,
  mutateAuthorityRequest,
  transitionExecutionAuthorityProfile,
} from '../../api/executionAuthority';

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const SECOND_REQUEST_ID = '20000000-0000-4000-8000-000000000001';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const CHANGED_DIGEST = `sha256:${'c'.repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${'b'.repeat(64)}`;
const WORKSPACE = createMockWorkspace({ id: 'ws-1', label: 'Selected Workspace', path: '/tmp/selected' });

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'rorca.execution-authority.v1' as const,
    id: REQUEST_ID,
    intentId: '10000000-0000-4000-8000-000000000002',
    workspaceId: 'ws-1',
    runId: 42,
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
    status: 'pending' as const,
    maximumUses: 1,
    expiresAt: '2099-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

function detail(requestProjection = request()) {
  return {
    request: requestProjection,
    decision: null,
    grant: null,
    bindingHealth: 'healthy',
  };
}

const RUN_STATE = {
  runId: 42,
  workspaceId: 'ws-1',
  status: 'WAITING_FOR_AUTHORIZATION',
  lifecycleStatus: 'waiting_for_authorization',
  waitExpiresAt: '2099-08-24T12:00:00.000Z',
};
function profile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'rorca.execution-authority-profile.v1' as const,
    policyVersion: 'rorca.execution-authority-rollout.v1' as const,
    workspaceId: 'ws-1',
    state: 'disabled' as const,
    generation: 1,
    transitionPrincipal: 'system:migration',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    enabledAt: null,
    disabledAt: '2026-08-24T10:00:00.000Z',
    readyToEnable: false,
    missingEvidenceKinds: ['migration', 'api', 'ui', 'crash_recovery', 'redaction', 'disposable_fixture_smoke'],
    evidence: [],
    evidenceHistoryCount: 0,
    mutationProviderAdapterIds: [],
    ...overrides,
  };
}


beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return { items: [WORKSPACE], total: 1, hasMore: false };
    if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
    return {};
  });
  vi.mocked(getAuthorityRequestDetail).mockResolvedValue(detail() as never);
  vi.mocked(getAuthorityRunState).mockResolvedValue(RUN_STATE);
  vi.mocked(getExecutionAuthorityProfile).mockResolvedValue(profile() as never);
  vi.mocked(transitionExecutionAuthorityProfile).mockResolvedValue(profile() as never);
  vi.mocked(mutateAuthorityRequest).mockResolvedValue();
});

describe('ExecutionAuthorityPanel operator journey', () => {
  it('scopes the inbox, exposes every request state, and completes an accessible exact-digest journey', async () => {
    const active = request();
    const stale = request({ id: SECOND_REQUEST_ID, storyId: 'REA-005', expiresAt: '2020-01-01T00:00:00.000Z' });
    const denied = request({ id: '30000000-0000-4000-8000-000000000001', storyId: 'REA-004', status: 'denied', resolvedAt: '2026-08-24T11:00:00.000Z' });
    const resumed = request({ id: '40000000-0000-4000-8000-000000000001', storyId: 'REA-003', status: 'approved', resolvedAt: '2026-08-24T11:00:00.000Z' });
    const otherWorkspace = request({ id: '50000000-0000-4000-8000-000000000001', workspaceId: 'ws-2', storyId: 'OTHER-001' });
    const page = { items: [active, stale, denied, resumed, otherWorkspace], total: 5, hasMore: false };
    vi.mocked(listAuthorityRequests).mockResolvedValue(page as never);

    const user = userEvent.setup();
    renderWithProviders(<ExecutionAuthorityPanel />);

    const activeRow = await screen.findByRole('button', { name: /run 42, story REA-006, Active/i });
    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.getByText('Resumed')).toBeInTheDocument();
    expect(screen.queryByText('OTHER-001')).not.toBeInTheDocument();

    activeRow.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /story REA-005, Stale/i })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(activeRow).toHaveFocus();

    await user.click(activeRow);
    const slideOver = await screen.findByRole('dialog', { name: 'Authority request detail' });
    expect(within(slideOver).getByText(DIGEST)).toBeInTheDocument();
    expect(within(slideOver).getByText('execution:run:42')).toBeInTheDocument();
    expect(within(slideOver).getAllByText('create_branch').length).toBeGreaterThan(0);
    expect(within(slideOver).getAllByText('repository:rorca/core').length).toBeGreaterThan(0);
    expect(within(slideOver).getByText('staging')).toBeInTheDocument();
    expect(within(slideOver).getByText(EVIDENCE_DIGEST)).toBeInTheDocument();
    expect(within(slideOver).getByText('7')).toBeInTheDocument();
    expect(within(slideOver).getByText('Healthy at latest adapter preflight')).toBeInTheDocument();
    expect(within(slideOver).getByText(/"branch": "run\/42"/)).toBeInTheDocument();
    expect(within(slideOver).getByText(/Story execution timeout is stopped/i)).toBeInTheDocument();
    expect(slideOver.textContent?.toLowerCase()).not.toContain('credential');

    await user.click(within(slideOver).getByRole('button', { name: 'Deny authority request' }));
    const destructiveDialog = screen.getByRole('alertdialog', { name: 'Deny request' });
    expect(within(destructiveDialog).getByText('Destructive authority decision')).toBeInTheDocument();
    expect(mutateAuthorityRequest).not.toHaveBeenCalled();
    await user.click(within(destructiveDialog).getByRole('button', { name: 'Go back' }));

    await user.click(within(slideOver).getByRole('button', { name: 'Approve exact authority request' }));
    const approvalDialog = screen.getByRole('alertdialog', { name: 'Approve exact request' });
    expect(within(approvalDialog).getByText(DIGEST)).toBeInTheDocument();
    await user.click(within(approvalDialog).getByRole('button', { name: 'Confirm approve for exact request digest' }));

    await waitFor(() => expect(mutateAuthorityRequest).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      requestId: REQUEST_ID,
      requestDigest: DIGEST,
      action: 'approve',
      reasonCode: 'scope_reviewed',
    }));
    expect(await screen.findByText(/Request and run state refreshed/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(activeRow).toHaveFocus());
  });

  it('re-reads the exact request and refuses a changed digest before mutation', async () => {
    vi.mocked(listAuthorityRequests).mockResolvedValue({ items: [request()], total: 1, hasMore: false } as never);
    vi.mocked(getAuthorityRequestDetail)
      .mockResolvedValueOnce(detail() as never)
      .mockResolvedValueOnce(detail(request({ requestDigest: CHANGED_DIGEST })) as never);

    const user = userEvent.setup();
    renderWithProviders(<ExecutionAuthorityPanel />);
    await user.click(await screen.findByRole('button', { name: /story REA-006, Active/i }));
    const slideOver = await screen.findByRole('dialog', { name: 'Authority request detail' });
    await user.click(within(slideOver).getByRole('button', { name: 'Approve exact authority request' }));
    const confirmation = screen.getByRole('alertdialog', { name: 'Approve exact request' });
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm approve for exact request digest' }));

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('stale');
    expect(mutateAuthorityRequest).not.toHaveBeenCalled();
  });

  it('renders loading then the empty selected-workspace state', async () => {
    const { promise, resolve } = Promise.withResolvers<{ items: never[]; total: number; hasMore: boolean }>();
    vi.mocked(listAuthorityRequests).mockReturnValue(promise);

    renderWithProviders(<ExecutionAuthorityPanel />);
    expect(await screen.findByText('Loading selected workspace requests…')).toBeInTheDocument();
    resolve({ items: [], total: 0, hasMore: false });
    expect(await screen.findByText('No authority requests')).toBeInTheDocument();
  });

  it('renders a fixed safe error and retry control', async () => {
    vi.mocked(listAuthorityRequests).mockRejectedValue(new Error('unsafe backend detail'));

    renderWithProviders(<ExecutionAuthorityPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Execution Authority data is temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Retry selected workspace' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('unsafe backend detail');
  });
  it('keeps rollout disabled until all evidence passes, then enables with no mutation adapter', async () => {
    const evidenceKinds = ['migration', 'api', 'ui', 'crash_recovery', 'redaction', 'disposable_fixture_smoke'] as const;
    const ready = profile({
      readyToEnable: true,
      missingEvidenceKinds: [],
      evidenceHistoryCount: evidenceKinds.length,
      evidence: evidenceKinds.map((evidenceKind, index) => ({
        id: `evidence-${index}`,
        schemaVersion: 'rorca.execution-authority-rollout-evidence.v1',
        evidenceKind,
        result: 'passed',
        artifactReference: `fixture://rea-008/${evidenceKind}`,
        evidenceDigest: `sha256:${String(index + 1).repeat(64)}`,
        observedAt: '2026-08-24T12:00:00.000Z',
        operatorPrincipal: 'local-operator:admin',
        createdAt: '2026-08-24T12:00:00.000Z',
      })),
    });
    const enabled = profile({
      ...ready,
      state: 'enabled',
      generation: 2,
      enabledAt: '2026-08-24T12:01:00.000Z',
      disabledAt: null,
    });
    vi.mocked(getExecutionAuthorityProfile).mockResolvedValue(ready as never);
    vi.mocked(transitionExecutionAuthorityProfile).mockResolvedValue(enabled as never);
    vi.mocked(listAuthorityRequests).mockResolvedValue({ items: [], total: 0, hasMore: false } as never);

    const user = userEvent.setup();
    renderWithProviders(<ExecutionAuthorityPanel />);
    expect(await screen.findByText(/6 retained evidence records/)).toBeInTheDocument();
    expect(screen.getByText(/0 mutation adapters/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable Execution Authority capability profile' }));

    await waitFor(() => expect(transitionExecutionAuthorityProfile).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      enabled: true,
      expectedGeneration: 1,
    }));
    expect(await screen.findByText(/^Execution Authority enabled\./)).toBeInTheDocument();
  });

});
