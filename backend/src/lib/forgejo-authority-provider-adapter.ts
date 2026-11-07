/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Forgejo authority adapter — the W5 Forgejo credential surface expressed
 * through the canonical authority-provider contract (rorca.authority-provider-adapter.v1).
 *
 * Mirrors github-authority-provider-adapter.ts: the adapter is a pure
 * projection over the existing workspace Forgejo credential store
 * (forgejo-token-credential-provider). It never mints tokens, never touches
 * secret values, and performs no network I/O; token minting and capability
 * probing remain in the provider, exactly as GitHub App token minting stays in
 * github-app-credential-provider.
 *
 * Forgejo is simpler than GitHub App: no JWT signing, no installation flow.
 * A repository-scoped access token is bound per workspace to exactly one
 * repository (owner/name), and the raw token is never persisted — only a
 * peppered digest and the capability-probe profile live in the credential
 * registry.
 */

import {
  DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
  ForgejoProviderBindingSchema,
  type AuthorityCapability,
  type DeliveryAuthorityProviderAdapter,
  type ProviderBinding,
} from './authority-provider-adapter';
import { FORGEJO_OPTIONAL_ADAPTER_DESCRIPTOR } from './delivery-adapter';
import {
  getWorkspaceForgejoCredential,
  type ForgejoCredentialBinding,
} from './forgejo-token-credential-provider';

export { ForgejoProviderBindingSchema };
export type ForgejoProviderBinding = Extract<ProviderBinding, { providerId: 'forgejo' }>;

export const FORGEJO_AUTHORITY_CAPABILITIES: readonly AuthorityCapability[] = Object.freeze([
  'scm.repository.read',
  'scm.branch.write',
  'scm.pull_request.write',
  'scm.checks.read',
  'scm.review.request',
]);

type BindingReader = (workspaceId: string) => Promise<ForgejoCredentialBinding | null>;

function bindingHealth(binding: ForgejoCredentialBinding | null): boolean {
  if (!binding) return false;
  return binding.status === 'active'
    && binding.validationErrorCode === null
    && typeof binding.credentialVersion === 'number'
    && binding.credentialVersion >= 1;
}

/**
 * Canonical Forgejo authority adapter over the existing workspace credential
 * registry. Token minting remains in forgejo-token-credential-provider and is
 * intentionally not performed by discovery or selection.
 */
export class ForgejoAuthorityProviderAdapter implements DeliveryAuthorityProviderAdapter {
  readonly contractVersion = DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  readonly descriptor = FORGEJO_OPTIONAL_ADAPTER_DESCRIPTOR;
  readonly capabilities = FORGEJO_AUTHORITY_CAPABILITIES;

  constructor(
    private readonly readBinding: BindingReader = getWorkspaceForgejoCredential,
  ) {}

  isBindingHealthy(binding: unknown): binding is ForgejoProviderBinding {
    const parsed = ForgejoProviderBindingSchema.safeParse(binding);
    return parsed.success && forgejoBindingIsHealthy(parsed.data);
  }

  async getProviderBinding(workspaceId: string): Promise<ProviderBinding | null> {
    const binding = await this.readBinding(workspaceId);
    if (!binding) return null;

    // Forgejo has no separate installation concept: the registry row IS the
    // binding, and its ciphertext token is the secret reference. An inactive
    // status maps to a suspended installation so the parity guard fails closed.
    const active = binding.status === 'active';
    const secretReferences: Array<{ purpose: 'token' | 'webhook-verification'; secretId: string }> = [
      { purpose: 'token', secretId: binding.bindingId },
    ];
    if (binding.webhookSecretEncrypted !== null) {
      secretReferences.push({ purpose: 'webhook-verification', secretId: binding.bindingId });
    }

    return ForgejoProviderBindingSchema.parse({
      providerId: 'forgejo',
      bindingId: binding.bindingId,
      workspaceId: binding.workspaceId,
      bindingStatus: binding.status === 'revoked' ? 'disabled' : binding.status,
      registrationStatus: active ? 'active' : 'disabled',
      installationStatus: active ? 'active' : 'suspended',
      instanceUrl: binding.instanceUrl,
      repositoryId: Number(binding.scopeProfile?.repositoryId ?? null) || null,
      repository: { owner: binding.owner, name: binding.name },
      secretReferences,
      providerProfileVerified: bindingHealth(binding),
    });
  }

  async revalidateProviderBinding(workspaceId: string): Promise<ProviderBinding> {
    const binding = await this.getProviderBinding(workspaceId);
    if (!binding) throw new Error('Provider binding not found');
    return binding;
  }
}

/** Convenience guard matching providerBindingIsHealthy for Forgejo bindings. */
export function forgejoBindingIsHealthy(binding: ForgejoProviderBinding | null): binding is ForgejoProviderBinding {
  return binding !== null
    && binding.bindingStatus === 'active'
    && binding.registrationStatus === 'active'
    && binding.installationStatus === 'active'
    && binding.providerProfileVerified;
}
