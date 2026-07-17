/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AutonomousDeliverySettings from '../AutonomousDeliverySettings';
import { apiFetch } from '../../lib/apiFetch';

vi.mock('../../lib/apiFetch', () => ({ apiFetch: vi.fn() }));

const mockApiFetch = vi.mocked(apiFetch);
const policyDigest = `sha256:${'a'.repeat(64)}`;

function policy(status: 'disabled' | 'active' | 'revoked' = 'disabled') {
  return {
    id: 'policy-1', revision: 1, repository: { owner: 'getrorca', name: 'rorca' }, baseBranch: 'main',
    allowedRiskLevels: ['low'], requiredChecks: ['Backend Tests'],
    reviewRules: { minimumApprovals: 1, requireCodeOwnerReview: false, dismissStaleApprovals: true, requiredReviewers: ['release-owner'] },
    mergeMethod: 'squash', retryBudget: { maxAttempts: 2, maxElapsedMinutes: 90 }, deploymentAllowed: false,
    policyDigest, status, effectiveStatus: status, expiresAt: '2026-08-01T12:00:00.000Z',
    activatedAt: status === 'active' ? '2026-07-16T12:00:00.000Z' : null,
    revokedAt: status === 'revoked' ? '2026-07-16T13:00:00.000Z' : null, revocationReason: null,
  };
}

function installLoads(policies: ReturnType<typeof policy>[] = [], evidence: unknown[] = [], deliveries: unknown[] = []) {
  mockApiFetch.mockImplementation(async (url, init) => {
    if (!init && url.includes('/delivery-policies')) {
      return { active: policies.find((item) => item.status === 'active') ?? null, policies } as any;
    }
    if (!init && url.includes('/delivery-evidence')) return { items: evidence } as any;
    if (!init && url.includes('/autonomous-deliveries')) return { items: deliveries } as any;
    if (init?.method === 'POST' && url.includes('/autonomous-deliveries')) return { queued: true, deliveryId: 'delivery-1', reason: null } as any;
    return { policy: policies[0] ?? policy(), replayed: false } as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('AutonomousDeliverySettings', () => {
  it('makes the disabled-by-default state and separate deployment authority explicit', async () => {
    installLoads();
    render(<AutonomousDeliverySettings workspaceId="ws-1" connected showToast={vi.fn()} />);
    expect(await screen.findByText(/Autonomous PR delivery is disabled/)).toBeInTheDocument();
    expect(screen.getByText(/Deployment authority is always separate/)).toBeInTheDocument();
  });

  it('creates only a disabled policy revision with hard-bounded safety fields', async () => {
    const user = userEvent.setup();
    installLoads();
    render(<AutonomousDeliverySettings workspaceId="ws-1" connected showToast={vi.fn()} />);
    await screen.findByText(/Autonomous PR delivery is disabled/);
    await user.click(screen.getByRole('button', { name: 'Draft a new policy revision' }));
    await user.click(screen.getByRole('button', { name: 'Create disabled revision' }));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/github/delivery-policies',
      expect.objectContaining({ method: 'POST' }),
    ));
    const createCall = mockApiFetch.mock.calls.find(([, init]) => init?.method === 'POST' && !String(init?.body).includes('ENABLE_AUTONOMOUS'))!;
    const body = JSON.parse(String(createCall[1]?.body));
    expect(body).toMatchObject({
      allowedRiskLevels: ['low'],
      requiredChecks: ['Backend Tests', 'Frontend Tests'],
      reviewRules: { minimumApprovals: 1, dismissStaleApprovals: true },
      mergeMethod: 'squash',
    });
    expect(body).not.toHaveProperty('deploymentAllowed');
    expect(createCall[1]?.headers).toMatchObject({ 'Idempotency-Key': expect.stringMatching(/^delivery-policy-create-/) });
  });

  it('requires digest-bound explicit confirmation before enabling a disabled revision', async () => {
    const user = userEvent.setup();
    installLoads([policy('disabled')]);
    render(<AutonomousDeliverySettings workspaceId="ws-1" connected showToast={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Review and enable' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Deployment remains separately controlled'));
    await waitFor(() => {
      const activation = mockApiFetch.mock.calls.find(([url, init]) => url.endsWith('/policy-1/activate') && init?.method === 'POST');
      expect(activation).toBeDefined();
      expect(JSON.parse(String(activation?.[1]?.body))).toEqual({
        expectedPolicyDigest: policyDigest,
        confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
      });
    });
  });

  it('starts only a run-derived worker delivery with an idempotency key', async () => {
    const user = userEvent.setup();
    installLoads([policy('active')]);
    render(<AutonomousDeliverySettings workspaceId="ws-1" connected showToast={vi.fn()} />);
    await screen.findByText(/Enabled for getrorca\/rorca:main/);
    await user.type(screen.getByLabelText('Delivery evidence run ID'), '20260316000001');
    await user.click(screen.getByRole('button', { name: /Start\/recheck delivery/ }));
    await waitFor(() => {
      const start = mockApiFetch.mock.calls.find(([url, init]) => url.endsWith('/autonomous-deliveries') && init?.method === 'POST');
      expect(start).toBeDefined();
      expect(JSON.parse(String(start?.[1]?.body))).toEqual({ runId: 20260316000001 });
      expect(start?.[1]?.headers).toMatchObject({ 'Idempotency-Key': expect.stringMatching(/^autonomous-delivery-start-/) });
    });
  });

  it('pins manual evidence observation to a canonical run and full expected SHA', async () => {
    const user = userEvent.setup();
    installLoads([policy('active')]);
    render(<AutonomousDeliverySettings workspaceId="ws-1" connected showToast={vi.fn()} />);
    await screen.findByText(/Enabled for getrorca\/rorca:main/);
    await user.type(screen.getByLabelText('Delivery evidence run ID'), '20260316000001');
    await user.type(screen.getByLabelText('Expected PR head SHA'), 'b'.repeat(40));
    await user.click(screen.getByRole('button', { name: 'Observe' }));

    await waitFor(() => {
      const observation = mockApiFetch.mock.calls.find(([url, init]) => url.endsWith('/delivery-evidence') && init?.method === 'POST');
      expect(observation).toBeDefined();
      expect(JSON.parse(String(observation?.[1]?.body))).toEqual({
        runId: 20260316000001,
        expectedHeadSha: 'b'.repeat(40),
      });
    });
  });
});
