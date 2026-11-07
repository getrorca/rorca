/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { DeliveryAuthorityProviderAdapter, ProviderBinding } from '../authority-provider-adapter';
import { selectDeliveryAdapter, type DeliveryAdapterSelectionDependencies } from '../delivery-adapter-selection';
import {
  GITHUB_OPTIONAL_ADAPTER_DESCRIPTOR,
  LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR,
  type DeliveryAdapter,
} from '../delivery-adapter';

const HEALTHY_BINDING: ProviderBinding = {
  providerId: 'github-app',
  bindingId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'workspace-one',
  bindingGeneration: 1,
  bindingStatus: 'active',
  registrationStatus: 'active',
  installationStatus: 'active',
  installationId: 77,
  repositoryId: 88,
  repository: { owner: 'getrorca', name: 'rorca' },
  secretReferences: [
    { purpose: 'app-signing', secretId: '22222222-2222-4222-8222-222222222222' },
    { purpose: 'webhook-verification', secretId: '33333333-3333-4333-8333-333333333333' },
  ],
  providerProfileVerified: true,
};

function dependencies(binding: ProviderBinding | null): DeliveryAdapterSelectionDependencies & {
  githubAdapter: DeliveryAuthorityProviderAdapter & { getProviderBinding: jest.Mock };
} {
  const localAdapter: DeliveryAdapter = {
    descriptor: LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR,
    create: jest.fn(),
  };
  const githubAdapter = {
    contractVersion: 'rorca.authority-provider-adapter.v1' as const,
    descriptor: GITHUB_OPTIONAL_ADAPTER_DESCRIPTOR,
    capabilities: ['scm.repository.read'] as const,
    getProviderBinding: jest.fn().mockResolvedValue(binding),
    revalidateProviderBinding: jest.fn().mockResolvedValue(binding),
  };
  return { localAdapter, githubAdapter };
}

test.each([
  ['no policy', undefined, 'default'],
  ['denied decision', { decision: 'denied', externalSend: true } as const, 'external_send_not_accepted'],
  ['send disabled', { decision: 'accepted', externalSend: false } as const, 'external_send_not_accepted'],
])('%s selects local delivery without reading provider state', async (_label, policy, reason) => {
  const deps = dependencies(HEALTHY_BINDING);
  const selection = await selectDeliveryAdapter('workspace-one', policy, deps);

  expect(selection).toMatchObject({ kind: 'local', binding: null, reason });
  expect(selection.adapter.descriptor.adapterId).toBe('local-review-bundle');
  expect(deps.githubAdapter.getProviderBinding).not.toHaveBeenCalled();
});

test('accepted external-send authority without a binding remains local', async () => {
  const deps = dependencies(null);
  const selection = await selectDeliveryAdapter(
    'workspace-without-github',
    { decision: 'accepted', externalSend: true },
    deps,
  );

  expect(selection).toMatchObject({ kind: 'local', binding: null, reason: 'binding_missing' });
  expect(deps.githubAdapter.getProviderBinding).toHaveBeenCalledWith('workspace-without-github');
});

test.each([
  ['disabled binding', { bindingStatus: 'disabled' as const }],
  ['disabled registration', { registrationStatus: 'disabled' as const }],
  ['suspended installation', { installationStatus: 'suspended' as const }],
  ['unverified profile', { providerProfileVerified: false }],
])('%s cannot select GitHub', async (_label, patch) => {
  const deps = dependencies({ ...HEALTHY_BINDING, ...patch });
  const selection = await selectDeliveryAdapter(
    'workspace-one',
    { decision: 'accepted', externalSend: true },
    deps,
  );

  expect(selection).toMatchObject({ kind: 'local', binding: null, reason: 'binding_unhealthy' });
});

test('explicit healthy binding and accepted external-send authority select GitHub', async () => {
  const deps = dependencies(HEALTHY_BINDING);
  const selection = await selectDeliveryAdapter(
    'workspace-one',
    { decision: 'accepted', externalSend: true },
    deps,
  );

  expect(selection).toMatchObject({
    kind: 'provider',
    binding: HEALTHY_BINDING,
    reason: 'healthy_binding_and_accepted_external_send',
  });
  expect(selection.adapter).toBe(deps.githubAdapter);
});
