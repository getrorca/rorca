/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'workspace-stripe-ui' }),
}));

vi.mock('../../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../lib/apiFetch';
import { StripeCredentialAuthoritySection } from '../StripeCredentialAuthoritySection';

const mockApiFetch = vi.mocked(apiFetch);
const PRIOR_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const REPLACEMENT_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-08-24T16:00:00.000Z';

const inventory = {
  items: [{
    bindingId: 'b0000000-0000-4000-8000-000000000001',
    mode: 'test',
    scope: {
      applicationId: 'rorca-disposable-payments',
      resourceType: 'payment_intents',
      resourceId: 'disposable-ui-target',
    },
    credentialClass: 'restricted_api_key',
    permissionManifest: ['payment_intents.read'],
    fingerprint: PRIOR_FINGERPRINT,
    status: 'active',
    generation: 4,
    lastVerifiedAt: NOW,
  }],
};

function activeStatus(fingerprint: string) {
  return { status: 'active', fingerprint, observedAt: NOW };
}

const rollback = {
  kind: 'rollback',
  receipt: {
    receiptId: 'b0000000-0000-4000-8000-000000000002',
    bindingId: inventory.items[0].bindingId,
    priorFingerprint: PRIOR_FINGERPRINT,
    replacementFingerprint: REPLACEMENT_FINGERPRINT,
    failurePhase: 'CANARY',
    disposition: 'ROLLED_BACK',
    priorBindingStatus: 'retained_active',
    replacementSecretStatus: 'quarantined',
    targetDisposition: 'prior_restored',
    priorProviderStatus: activeStatus(PRIOR_FINGERPRINT),
    replacementProviderStatus: activeStatus(REPLACEMENT_FINGERPRINT),
    manualReconciliation: null,
    settledAt: NOW,
  },
};

const emergency = {
  kind: 'emergency',
  request: {
    requestId: 'b0000000-0000-4000-8000-000000000003',
    requestType: 'RUNTIME_AUTHENTICATION_FAILURE',
    bindingId: inventory.items[0].bindingId,
    fingerprint: PRIOR_FINGERPRINT,
    mode: 'test',
    affectedResource: inventory.items[0].scope,
    permissionManifest: ['payment_intents.read'],
    evidence: {
      operation: 'payment_intents.read',
      providerHttpStatus: 401,
      observedAt: NOW,
    },
    state: 'AWAITING_DASHBOARD_AUTHENTICATION',
    authority: {
      canGrant: false,
      canBroadenPermissions: false,
      canCrossWorkspace: false,
      canCrossMode: false,
      canInjectSecret: false,
      requiresDashboardAuthentication: true,
    },
    requestedAt: NOW,
  },
};

function wireResponses(items: unknown[]) {
  mockApiFetch.mockImplementation(((url: string) => {
    if (url.includes('/credential-incidents')) return Promise.resolve({ items });
    if (url.includes('/provider-bindings')) return Promise.resolve(inventory);
    return Promise.reject(new Error('Unexpected API request'));
  }) as typeof apiFetch);
}

describe('StripeCredentialAuthoritySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows restored prior access, quarantined replacement, and inert emergency authority', async () => {
    wireResponses([emergency, rollback]);
    render(<StripeCredentialAuthoritySection />);

    expect(await screen.findByText('Prior binding restored')).toBeInTheDocument();
    expect(screen.getByText(/replacement quarantined · old binding retained active/i)).toBeInTheDocument();
    expect(screen.getByText('Runtime authentication failure')).toBeInTheDocument();
    expect(screen.getByText(/No emergency authority was granted/i)).toBeInTheDocument();
    expect(screen.getByText(/Reauthenticate in the Stripe Dashboard/i)).toBeInTheDocument();
    expect(screen.getByText(/Live-mode rotation is disabled/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /grant|approve|skip authentication/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/);
  });

  it('presents unknown key state as a retry blocker requiring exact manual reconciliation', async () => {
    wireResponses([{
      kind: 'reconciliation',
      receipt: {
        receiptId: 'b0000000-0000-4000-8000-000000000004',
        bindingId: inventory.items[0].bindingId,
        priorFingerprint: PRIOR_FINGERPRINT,
        replacementFingerprint: REPLACEMENT_FINGERPRINT,
        disposition: 'MANUAL_RECONCILIATION',
        retryAllowed: false,
        priorProviderStatus: { status: 'unknown', observedAt: NOW },
        replacementProviderStatus: { status: 'active', observedAt: NOW },
        requiredDashboardAuthentication: true,
        reconciledAt: NOW,
      },
    }]);
    render(<StripeCredentialAuthoritySection />);

    expect(await screen.findByText('Provider key-status reconciliation')).toBeInTheDocument();
    expect(screen.getByText('Manual reconciliation')).toBeInTheDocument();
    expect(screen.getByText(/retry blocked/i)).toBeInTheDocument();
    expect(screen.getByText(/No retry or authority change is available/i)).toBeInTheDocument();
    expect(screen.getByText(/exact fingerprints in the Stripe Dashboard/i)).toBeInTheDocument();
  });

  it('redacts credential-shaped API errors before they reach the UI', async () => {
    const credential = ['rk', 'test', 'uiErrorSecretMaterial123'].join('_');
    mockApiFetch.mockRejectedValue(new Error(`Provider rejected ${credential}`));
    render(<StripeCredentialAuthoritySection />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(REDACTED_TEXT);
    expect(alert.textContent).not.toContain(credential);
    expect(document.body.textContent).not.toContain(credential);
  });
});

const REDACTED_TEXT = '[credential redacted]';
