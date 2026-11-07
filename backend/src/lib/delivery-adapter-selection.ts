/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  ExternalSendAuthorityPolicySchema,
  acceptsExternalSend,
  providerBindingIsHealthy,
  type DeliveryAuthorityProviderAdapter,
  type ExternalSendAuthorityPolicy,
  type ProviderBinding,
} from './authority-provider-adapter';
import type { DeliveryAdapter } from './delivery-adapter';
import { GitHubAuthorityProviderAdapter } from './github-authority-provider-adapter';
import { LocalReviewBundleAdapter } from './local-review-bundle-adapter';

export type DeliveryAdapterSelection =
  | {
    kind: 'local';
    adapter: DeliveryAdapter;
    binding: null;
    reason: 'default' | 'external_send_not_accepted' | 'binding_missing' | 'binding_unhealthy';
  }
  | {
    kind: 'provider';
    adapter: DeliveryAuthorityProviderAdapter;
    binding: ProviderBinding;
    reason: 'healthy_binding_and_accepted_external_send';
  };

export interface DeliveryAdapterSelectionDependencies {
  localAdapter: DeliveryAdapter;
  githubAdapter: DeliveryAuthorityProviderAdapter;
}

const defaultDependencies: DeliveryAdapterSelectionDependencies = {
  localAdapter: new LocalReviewBundleAdapter(),
  githubAdapter: new GitHubAuthorityProviderAdapter(),
};

/**
 * Select external delivery only when both independent authorities are present.
 * Missing/denied policy does not even read provider state, so ordinary local
 * delivery cannot initiate provider discovery or network delivery.
 */
export async function selectDeliveryAdapter(
  workspaceId: string,
  policy?: ExternalSendAuthorityPolicy | null,
  dependencies: DeliveryAdapterSelectionDependencies = defaultDependencies,
): Promise<DeliveryAdapterSelection> {
  if (!policy) {
    return { kind: 'local', adapter: dependencies.localAdapter, binding: null, reason: 'default' };
  }
  const parsedPolicy = ExternalSendAuthorityPolicySchema.safeParse(policy);
  if (!parsedPolicy.success || !acceptsExternalSend(parsedPolicy.data)) {
    return { kind: 'local', adapter: dependencies.localAdapter, binding: null, reason: 'external_send_not_accepted' };
  }

  const githubBinding = await dependencies.githubAdapter.getProviderBinding(workspaceId);

  if (githubBinding && providerBindingIsHealthy(githubBinding)) {
    return {
      kind: 'provider',
      adapter: dependencies.githubAdapter,
      binding: githubBinding,
      reason: 'healthy_binding_and_accepted_external_send',
    };
  }


  return {
    kind: 'local',
    adapter: dependencies.localAdapter,
    binding: null,
    reason: githubBinding ? 'binding_unhealthy' : 'binding_missing',
  };
}
