/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  getCredentialLease,
  getProviderBindingByReference,
  transitionCredentialLease,
  type CredentialLeaseRecord,
  type CredentialLeaseStatus,
  type ProviderBindingRecord,
} from '../db/execution-authority';
import { AppError } from './errors';
import {
  type EphemeralSecretMaterial,
  type SecretAccessRequest,
  type SecretStore,
  type SecretStoreHealth,
} from './secret-store';

export const RUNTIME_SECRET_BINDING_ADAPTER_CONTRACT_VERSION = 'rorca.runtime-secret-binding-adapter.v1' as const;

export type RuntimeSecretBindingFailureCode =
  | 'SECRET_BINDING_SCOPE_MISMATCH'
  | 'SECRET_LEASE_EXHAUSTED'
  | 'SECRET_LEASE_TRANSITION_FAILED';

const FAILURE_MESSAGES: Readonly<Record<RuntimeSecretBindingFailureCode, string>> = Object.freeze({
  SECRET_BINDING_SCOPE_MISMATCH: 'Runtime secret binding does not match its exact durable scope',
  SECRET_LEASE_EXHAUSTED: 'Runtime credential lease cannot authorize another resolution',
  SECRET_LEASE_TRANSITION_FAILED: 'Runtime credential lease requires reconciliation',
});

export class RuntimeSecretBindingError extends AppError {
  readonly statusCode = 422 as const;
  declare readonly code: RuntimeSecretBindingFailureCode;

  constructor(code: RuntimeSecretBindingFailureCode) {
    super(FAILURE_MESSAGES[code], code);
    this.code = code;
  }
}

export interface RuntimeSecretBindingContext extends SecretAccessRequest {
  fencingGeneration: number;
}

export interface PreparedRuntimeSecretLease extends RuntimeSecretBindingContext {
  maximumUses: number;
  usesConsumed: number;
  expiresAt: string;
}

export interface RuntimeSecretBindingAdapter {
  readonly contractVersion: typeof RUNTIME_SECRET_BINDING_ADAPTER_CONTRACT_VERSION;
  healthPreflight(input: RuntimeSecretBindingContext): Promise<SecretStoreHealth>;
  prepareLease(input: RuntimeSecretBindingContext): Promise<PreparedRuntimeSecretLease>;
  resolve(input: PreparedRuntimeSecretLease): Promise<EphemeralSecretMaterial>;
  revoke(input: RuntimeSecretBindingContext): Promise<void>;
  markReconciliationRequired(input: RuntimeSecretBindingContext): Promise<void>;
}

export interface RuntimeSecretBindingDependencies {
  getLease(workspaceId: string, leaseId: string): Promise<CredentialLeaseRecord | null>;
  getBinding(workspaceId: string, bindingReference: string, generation: number): Promise<ProviderBindingRecord | null>;
  transitionLease(input: {
    workspaceId: string;
    leaseId: string;
    fencingGeneration: number;
    from: CredentialLeaseStatus;
    to: CredentialLeaseStatus;
    usesConsumed: number;
  }): Promise<boolean>;
  now(): Date;
}

const DEFAULT_DEPENDENCIES: RuntimeSecretBindingDependencies = {
  getLease: getCredentialLease,
  getBinding: getProviderBindingByReference,
  transitionLease: transitionCredentialLease,
  now: () => new Date(),
};

function exactBindingAndLease(
  input: RuntimeSecretBindingContext,
  lease: CredentialLeaseRecord | null,
  binding: ProviderBindingRecord | null,
): lease is CredentialLeaseRecord {
  return lease !== null
    && binding !== null
    && lease.workspaceId === input.workspaceId
    && binding.workspaceId === input.workspaceId
    && lease.id === input.leaseId
    && lease.bindingReference === input.bindingReference
    && binding.bindingReference === input.bindingReference
    && lease.bindingGeneration === input.bindingGeneration
    && binding.generation === input.bindingGeneration
    && lease.fencingGeneration === input.fencingGeneration
    && lease.environment === input.environment
    && binding.environment === input.environment
    && binding.provider === input.provider
    && lease.providerResourceId === input.providerResourceId
    && binding.providerResourceId === input.providerResourceId
    && lease.operation === input.action
    && lease.leasePurpose === input.leasePurpose
    && lease.secretReference === input.secretReference
    && binding.secretReference === input.secretReference
    && lease.secretFingerprint === input.secretFingerprint
    && binding.secretFingerprint === input.secretFingerprint;
}

export class SecretStoreRuntimeBindingAdapter implements RuntimeSecretBindingAdapter {
  readonly contractVersion = RUNTIME_SECRET_BINDING_ADAPTER_CONTRACT_VERSION;

  constructor(
    readonly secretStore: SecretStore,
    private readonly dependencies: RuntimeSecretBindingDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  private async loadExact(
    input: RuntimeSecretBindingContext,
    requireActiveBinding = true,
    requireUnexpired = true,
  ): Promise<CredentialLeaseRecord> {
    const [lease, binding] = await Promise.all([
      this.dependencies.getLease(input.workspaceId, input.leaseId),
      this.dependencies.getBinding(input.workspaceId, input.bindingReference, input.bindingGeneration),
    ]);
    if (binding === null || !exactBindingAndLease(input, lease, binding)
      || (requireActiveBinding && binding.status !== 'active')
      || (requireUnexpired && lease.expiresAt.getTime() <= this.dependencies.now().getTime())) {
      throw new RuntimeSecretBindingError('SECRET_BINDING_SCOPE_MISMATCH');
    }
    return lease;
  }

  async healthPreflight(input: RuntimeSecretBindingContext): Promise<SecretStoreHealth> {
    const lease = await this.loadExact(input);
    if (!['prepared', 'active'].includes(lease.status) || lease.usesConsumed >= lease.maximumUses) {
      return {
        status: 'unauthorized',
        checkedAt: new Date().toISOString(),
        reasonCode: 'SECRET_SCOPE_MISMATCH',
      };
    }
    return this.secretStore.healthPreflight(input);
  }

  async prepareLease(input: RuntimeSecretBindingContext): Promise<PreparedRuntimeSecretLease> {
    let lease = await this.loadExact(input);
    if (lease.status === 'prepared') {
      const activated = await this.dependencies.transitionLease({
        workspaceId: lease.workspaceId,
        leaseId: lease.id,
        fencingGeneration: lease.fencingGeneration,
        from: 'prepared',
        to: 'active',
        usesConsumed: lease.usesConsumed,
      });
      if (!activated) throw new RuntimeSecretBindingError('SECRET_LEASE_TRANSITION_FAILED');
      lease = { ...lease, status: 'active' };
    }
    if (lease.status !== 'active' || lease.usesConsumed >= lease.maximumUses) {
      throw new RuntimeSecretBindingError('SECRET_LEASE_EXHAUSTED');
    }
    return Object.freeze({
      ...input,
      maximumUses: lease.maximumUses,
      usesConsumed: lease.usesConsumed,
      expiresAt: lease.expiresAt.toISOString(),
    });
  }

  async resolve(input: PreparedRuntimeSecretLease): Promise<EphemeralSecretMaterial> {
    const lease = await this.loadExact(input);
    if (lease.status !== 'active' || lease.usesConsumed !== input.usesConsumed
      || lease.maximumUses !== input.maximumUses || lease.expiresAt.toISOString() !== input.expiresAt) {
      throw new RuntimeSecretBindingError('SECRET_LEASE_EXHAUSTED');
    }
    const material = await this.secretStore.resolve(input);
    const usesConsumed = lease.usesConsumed + 1;
    const transitioned = await this.dependencies.transitionLease({
      workspaceId: lease.workspaceId,
      leaseId: lease.id,
      fencingGeneration: lease.fencingGeneration,
      from: 'active',
      to: usesConsumed === lease.maximumUses ? 'exhausted' : 'active',
      usesConsumed,
    });
    if (!transitioned) {
      material.dispose();
      await this.markReconciliationRequired(input);
      throw new RuntimeSecretBindingError('SECRET_LEASE_TRANSITION_FAILED');
    }
    return material;
  }

  async markReconciliationRequired(input: RuntimeSecretBindingContext): Promise<void> {
    const lease = await this.loadExact(input, false, false);
    if (lease.status === 'reconciliation_required' || lease.status === 'revoked') return;
    const transitioned = await this.dependencies.transitionLease({
      workspaceId: input.workspaceId,
      leaseId: input.leaseId,
      fencingGeneration: input.fencingGeneration,
      from: lease.status,
      to: 'reconciliation_required',
      usesConsumed: lease.usesConsumed,
    });
    if (!transitioned) {
      const latest = await this.dependencies.getLease(input.workspaceId, input.leaseId);
      if (latest?.status !== 'reconciliation_required') {
        throw new RuntimeSecretBindingError('SECRET_LEASE_TRANSITION_FAILED');
      }
    }
  }

  async revoke(input: RuntimeSecretBindingContext): Promise<void> {
    try {
      await this.secretStore.revoke(input);
      const lease = await this.loadExact(input, false, false);
      if (lease.status === 'revoked') return;
      if (!['prepared', 'active', 'exhausted', 'expired', 'reconciliation_required'].includes(lease.status)
        || !await this.dependencies.transitionLease({
          workspaceId: lease.workspaceId,
          leaseId: lease.id,
          fencingGeneration: lease.fencingGeneration,
          from: lease.status,
          to: 'revoked',
          usesConsumed: lease.usesConsumed,
        })) {
        throw new RuntimeSecretBindingError('SECRET_LEASE_TRANSITION_FAILED');
      }
    } catch {
      await this.markReconciliationRequired(input);
      throw new RuntimeSecretBindingError('SECRET_LEASE_TRANSITION_FAILED');
    }
  }
}
