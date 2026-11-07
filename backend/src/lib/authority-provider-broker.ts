/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { appendAuthorityWalEvent, type AuthorityJson } from '../db/execution-authority';
import { AppError } from './errors';
import {
  AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
  type AuthorityProviderAdapter,
  type AuthorityProviderEgress,
  type AuthorityProviderEgressRequest,
  type AuthorityProviderEgressResponse,
  type AuthorityProviderObservation,
  type AuthorityProviderReceiptProjection,
  type AuthorityProviderReferenceContext,
  type AuthorityProviderReconciliation,
  type PreparedAuthorityProviderLease,
} from './authority-provider-adapter';
import {
  type RuntimeSecretBindingAdapter,
  type RuntimeSecretBindingContext,
} from './runtime-secret-binding-adapter';
import {
  TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION,
  type TrustedOperationAdapter,
  type TrustedOperationAdapterContext,
  type TrustedOperationAdapterSettlement,
  type TrustedOperationExecutionObservation,
  type TrustedOperationReconciliation,
} from './trusted-operation-executor';
import {
  assertAuthorityRedactedReference,
  assertAuthorityRedactedValue,
} from './authority-redaction';

export const AUTHORITY_PROVIDER_BROKER_CONTRACT_VERSION = 'rorca.authority-provider-broker.v1' as const;
const PROVIDER_HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_EGRESS_RESPONSE_BYTES = 4 * 1024 * 1024;

export type AuthorityProviderBrokerFailureCode =
  | 'PROVIDER_ADAPTER_INVALID'
  | 'PROVIDER_PREFLIGHT_FAILED'
  | 'PROVIDER_LEASE_PREPARATION_FAILED'
  | 'PROVIDER_EXECUTION_FAILED'
  | 'PROVIDER_RECONCILIATION_FAILED'
  | 'PROVIDER_REVOCATION_FAILED'
  | 'PROVIDER_RESULT_NOT_REDACTED'
  | 'PROVIDER_EGRESS_DENIED';

const FAILURE_MESSAGES: Readonly<Record<AuthorityProviderBrokerFailureCode, string>> = Object.freeze({
  PROVIDER_ADAPTER_INVALID: 'Authority provider adapter contract is invalid',
  PROVIDER_PREFLIGHT_FAILED: 'Authority provider preflight failed closed',
  PROVIDER_LEASE_PREPARATION_FAILED: 'Authority provider lease preparation failed closed',
  PROVIDER_EXECUTION_FAILED: 'Authority provider execution requires reconciliation',
  PROVIDER_RECONCILIATION_FAILED: 'Authority provider reconciliation remains required',
  PROVIDER_REVOCATION_FAILED: 'Authority provider revocation remains required',
  PROVIDER_RESULT_NOT_REDACTED: 'Authority provider returned a non-redacted result',
  PROVIDER_EGRESS_DENIED: 'Authority provider egress was denied',
});

/** Fixed-message boundary error; provider exceptions are never propagated. */
export class AuthorityProviderBrokerError extends AppError {
  readonly statusCode = 422 as const;
  declare readonly code: AuthorityProviderBrokerFailureCode;

  constructor(code: AuthorityProviderBrokerFailureCode) {
    super(FAILURE_MESSAGES[code], code);
    this.code = code;
  }
}

function providerContext(input: TrustedOperationAdapterContext): AuthorityProviderReferenceContext {
  return Object.freeze({
    workspaceId: input.workspaceId,
    environment: input.environment,
    provider: input.provider,
    providerResourceId: input.providerResourceId,
    action: input.operation,
    leasePurpose: input.leasePurpose,
    attemptId: input.attemptId,
    intentId: input.intentId,
    grantId: input.grantId,
    leaseId: input.leaseId,
    requestingPrincipal: input.requestingPrincipal,
    capabilityId: input.capabilityId,
    bindingReference: input.bindingReference,
    bindingGeneration: input.bindingGeneration,
    requestDigest: input.requestDigest,
    evidenceDigest: input.evidenceDigest,
    idempotencyKey: input.idempotencyKey,
    fencingGeneration: input.fencingGeneration,
    constraints: input.constraints,
    secretReference: input.secretReference,
    secretFingerprint: input.secretFingerprint,
  });
}

function secretContext(input: TrustedOperationAdapterContext): RuntimeSecretBindingContext {
  return Object.freeze({
    workspaceId: input.workspaceId,
    environment: input.environment,
    provider: input.provider,
    providerResourceId: input.providerResourceId,
    action: input.operation,
    leasePurpose: input.leasePurpose,
    principal: input.requestingPrincipal,
    leaseId: input.leaseId,
    bindingReference: input.bindingReference,
    bindingGeneration: input.bindingGeneration,
    secretReference: input.secretReference,
    secretFingerprint: input.secretFingerprint,
    fencingGeneration: input.leaseFencingGeneration,
  });
}

function assertReference(value: unknown, field: string): asserts value is string {
  try {
    assertAuthorityRedactedReference(value);
  } catch {
    throw new AuthorityProviderBrokerError('PROVIDER_RESULT_NOT_REDACTED');
  }
  if (field === 'expiresAt' && !Number.isFinite(Date.parse(value))) {
    throw new AuthorityProviderBrokerError('PROVIDER_LEASE_PREPARATION_FAILED');
  }
}

function assertAdapter(adapter: AuthorityProviderAdapter, provider: string): void {
  if (adapter.contractVersion !== AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION
    || adapter.provider !== provider
    || !Array.isArray(adapter.allowedHosts)
    || adapter.allowedHosts.length === 0
    || adapter.allowedHosts.length > 32
    || new Set(adapter.allowedHosts).size !== adapter.allowedHosts.length
    || adapter.allowedHosts.some((host) => typeof host !== 'string'
      || host !== host.toLowerCase()
      || !PROVIDER_HOST_PATTERN.test(host))
    || typeof adapter.describeCapability !== 'function'
    || typeof adapter.healthPreflight !== 'function'
    || typeof adapter.prepareLease !== 'function'
    || typeof adapter.execute !== 'function'
    || typeof adapter.reconcile !== 'function'
    || typeof adapter.revoke !== 'function'
    || typeof adapter.projectReceipt !== 'function') {
    throw new AuthorityProviderBrokerError('PROVIDER_ADAPTER_INVALID');
  }
}

function assertProviderHealth(value: unknown): void {
  if (!value || typeof value !== 'object'
    || Object.keys(value).some((key) => !['status', 'reasonCode', 'checkedAt'].includes(key))) {
    throw new AuthorityProviderBrokerError('PROVIDER_PREFLIGHT_FAILED');
  }
  const health = value as Record<string, unknown>;
  if (!['available', 'offline', 'unauthorized', 'stale'].includes(String(health.status))
    || typeof health.checkedAt !== 'string' || !Number.isFinite(Date.parse(health.checkedAt))
    || (health.status === 'available' && health.reasonCode !== null)
    || (health.status !== 'available'
      && (typeof health.reasonCode !== 'string' || !/^[A-Z0-9][A-Z0-9_.:-]{0,127}$/.test(health.reasonCode)))) {
    throw new AuthorityProviderBrokerError('PROVIDER_PREFLIGHT_FAILED');
  }
}

function assertProviderLease(value: unknown): asserts value is PreparedAuthorityProviderLease {
  if (!value || typeof value !== 'object'
    || Object.keys(value).some((key) => !['providerLeaseReference', 'expiresAt', 'redactedMetadata'].includes(key))) {
    throw new AuthorityProviderBrokerError('PROVIDER_LEASE_PREPARATION_FAILED');
  }
  const lease = value as Record<string, unknown>;
  assertReference(lease.providerLeaseReference, 'providerLeaseReference');
  assertReference(lease.expiresAt, 'expiresAt');
  assertAuthorityRedactedValue(lease.redactedMetadata);
}

function assertObservation(
  value: unknown,
  reconciliation: boolean,
  credentialCanary: string | null,
): asserts value is AuthorityProviderReconciliation {
  if (!value || typeof value !== 'object' || !('state' in value)) {
    throw new AuthorityProviderBrokerError('PROVIDER_RESULT_NOT_REDACTED');
  }
  const observation = value as Record<string, unknown>;
  if (observation.state === 'not_accepted') {
    if (!reconciliation || Object.keys(observation).some((key) => key !== 'state')) {
      throw new AuthorityProviderBrokerError('PROVIDER_RESULT_NOT_REDACTED');
    }
    return;
  }
  if (observation.state === 'uncertain') {
    if (Object.keys(observation).some((key) => !['state', 'providerOperationReference'].includes(key))) {
      throw new AuthorityProviderBrokerError('PROVIDER_RESULT_NOT_REDACTED');
    }
    if (observation.providerOperationReference !== undefined) {
      assertReference(observation.providerOperationReference, 'providerOperationReference');
    }
    return;
  }
  if (observation.state !== 'settled'
    || (observation.outcome !== 'succeeded' && observation.outcome !== 'failed')
    || Object.keys(observation).some((key) => ![
      'state', 'outcome', 'providerOperationReference', 'providerReceiptReference', 'redactedResult',
    ].includes(key))) {
    throw new AuthorityProviderBrokerError('PROVIDER_RESULT_NOT_REDACTED');
  }
  assertReference(observation.providerOperationReference, 'providerOperationReference');
  assertReference(observation.providerReceiptReference, 'providerReceiptReference');
  assertAuthorityRedactedValue(observation.redactedResult, {
    secretCanaries: credentialCanary === null ? [] : [credentialCanary],
  });
}

function assertReceipt(
  receipt: unknown,
  observation: Extract<AuthorityProviderObservation, { state: 'settled' }>,
  credentialCanary: string | null,
): asserts receipt is AuthorityProviderReceiptProjection {
  if (!receipt || typeof receipt !== 'object'
    || Object.keys(receipt).some((key) => ![
      'providerOperationReference', 'providerReceiptReference', 'redactedPayload',
    ].includes(key))) {
    throw new AuthorityProviderBrokerError('PROVIDER_RESULT_NOT_REDACTED');
  }
  const projected = receipt as Record<string, unknown>;
  assertReference(projected.providerOperationReference, 'providerOperationReference');
  assertReference(projected.providerReceiptReference, 'providerReceiptReference');
  if (projected.providerOperationReference !== observation.providerOperationReference
    || projected.providerReceiptReference !== observation.providerReceiptReference) {
    throw new AuthorityProviderBrokerError('PROVIDER_RESULT_NOT_REDACTED');
  }
  assertAuthorityRedactedValue(projected.redactedPayload, {
    secretCanaries: credentialCanary === null ? [] : [credentialCanary],
  });
}

async function projectSettlement(
  adapter: AuthorityProviderAdapter,
  observation: Extract<AuthorityProviderObservation, { state: 'settled' }>,
  credentialCanary: string | null,
): Promise<TrustedOperationAdapterSettlement> {
  const receipt = await adapter.projectReceipt(observation);
  assertReceipt(receipt, observation, credentialCanary);
  return {
    state: 'settled',
    outcome: observation.outcome,
    providerOperationReference: receipt.providerOperationReference,
    providerReceiptReference: receipt.providerReceiptReference,
    redactedPayload: receipt.redactedPayload,
  };
}

export interface AuthoritySecurityEvent {
  schemaVersion: typeof AUTHORITY_PROVIDER_BROKER_CONTRACT_VERSION;
  reasonCode: 'PROVIDER_EGRESS_HOST_DENIED';
  workspaceId: string;
  runId: number;
  storyId: string;
  attemptId: string;
  provider: string;
  targetHost: string | null;
}

export interface AuthorityProviderBrokerDependencies {
  fetch?: typeof globalThis.fetch;
  recordSecurityEvent?: (event: AuthoritySecurityEvent) => Promise<void>;
}

class ProviderEgressGateway implements AuthorityProviderEgress {
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(
    private readonly context: TrustedOperationAdapterContext,
    hosts: readonly string[],
    private readonly dependencies: AuthorityProviderBrokerDependencies,
  ) {
    this.allowedHosts = new Set(hosts);
  }

  private async deny(targetHost: string | null): Promise<never> {
    const event: AuthoritySecurityEvent = Object.freeze({
      schemaVersion: AUTHORITY_PROVIDER_BROKER_CONTRACT_VERSION,
      reasonCode: 'PROVIDER_EGRESS_HOST_DENIED',
      workspaceId: this.context.workspaceId,
      runId: this.context.runId,
      storyId: this.context.storyId,
      attemptId: this.context.attemptId,
      provider: this.context.provider,
      targetHost,
    });
    assertAuthorityRedactedValue(event);
    try {
      if (this.dependencies.recordSecurityEvent) {
        await this.dependencies.recordSecurityEvent(event);
      } else {
        await appendAuthorityWalEvent({
          eventType: 'authority_security_violation',
          workspaceId: event.workspaceId,
          storyId: event.storyId,
          payload: event as unknown as AuthorityJson,
        });
      }
    } catch {
      throw new AuthorityProviderBrokerError('PROVIDER_EGRESS_DENIED');
    }
    throw new AuthorityProviderBrokerError('PROVIDER_EGRESS_DENIED');
  }

  async request(input: AuthorityProviderEgressRequest): Promise<AuthorityProviderEgressResponse> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return this.deny(null);
    }
    const targetHost = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== ''
      || !this.allowedHosts.has(targetHost)
      || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)
      || (input.timeoutMs !== undefined
        && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000))) {
      return this.deny(PROVIDER_HOST_PATTERN.test(targetHost) ? targetHost : null);
    }

    const response = await (this.dependencies.fetch ?? globalThis.fetch)(url, {
      method: input.method,
      headers: input.headers,
      body: input.body ? Buffer.from(input.body) : undefined,
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      redirect: 'error',
    });
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_EGRESS_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new AuthorityProviderBrokerError('PROVIDER_EXECUTION_FAILED');
    }
    const chunks: Uint8Array[] = [];
    let bodyBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bodyBytes += chunk.value.byteLength;
        if (bodyBytes > MAX_EGRESS_RESPONSE_BYTES) {
          await reader.cancel();
          throw new AuthorityProviderBrokerError('PROVIDER_EXECUTION_FAILED');
        }
        chunks.push(chunk.value);
      }
    }
    const body = Buffer.concat(chunks, bodyBytes);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!['authorization', 'proxy-authorization', 'set-cookie', 'www-authenticate'].includes(key.toLowerCase())) {
        headers[key.toLowerCase()] = value;
      }
    });
    return Object.freeze({ status: response.status, headers: Object.freeze(headers), body });
  }
}

/**
 * Only this adapter bridges durable references to ephemeral material. Provider
 * results are structurally redacted before they can reach executor, receipt,
 * error, log, WAL, API, or SSE types.
 */
export class BrokeredAuthorityProviderAdapter implements TrustedOperationAdapter {
  readonly contractVersion = TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION;

  constructor(
    private readonly providerAdapter: AuthorityProviderAdapter,
    private readonly runtimeSecretBinding: RuntimeSecretBindingAdapter,
    private readonly dependencies: AuthorityProviderBrokerDependencies = {},
  ) {}

  async execute(input: TrustedOperationAdapterContext): Promise<TrustedOperationExecutionObservation> {
    const providerInput = providerContext(input);
    const runtimeInput = secretContext(input);
    assertAdapter(this.providerAdapter, input.provider);
    try {
      const [providerHealth, secretHealth] = await Promise.all([
        this.providerAdapter.healthPreflight(providerInput),
        this.runtimeSecretBinding.healthPreflight(runtimeInput),
      ]);
      assertProviderHealth(providerHealth);
      if (providerHealth.status !== 'available' || secretHealth.status !== 'available') {
        throw new AuthorityProviderBrokerError('PROVIDER_PREFLIGHT_FAILED');
      }
      const providerLease = await this.providerAdapter.prepareLease(providerInput);
      assertProviderLease(providerLease);
      const runtimeLease = await this.runtimeSecretBinding.prepareLease(runtimeInput);
      const material = await this.runtimeSecretBinding.resolve(runtimeLease);
      return await material.use(async (credential) => {
        const credentialCanary = Buffer.from(credential).toString('utf8');
        const egress = new ProviderEgressGateway(input, this.providerAdapter.allowedHosts, this.dependencies);
        const observation = await this.providerAdapter.execute({
          ...providerInput,
          providerLease,
          egress,
          credential,
        });
        assertObservation(observation, false, credentialCanary);
        return observation.state === 'settled'
          ? projectSettlement(this.providerAdapter, observation, credentialCanary)
          : observation;
      });
    } catch {
      try {
        await this.runtimeSecretBinding.markReconciliationRequired(runtimeInput);
      } catch {
        // The durable lease remains tracked in its prior state for recovery.
      }
      throw new AuthorityProviderBrokerError('PROVIDER_EXECUTION_FAILED');
    }
  }

  async reconcile(input: TrustedOperationAdapterContext): Promise<TrustedOperationReconciliation> {
    const providerInput = providerContext(input);
    const runtimeInput = secretContext(input);
    assertAdapter(this.providerAdapter, input.provider);
    try {
      const observation = await this.providerAdapter.reconcile(providerInput);
      assertObservation(observation, true, null);
      return observation.state === 'settled'
        ? await projectSettlement(this.providerAdapter, observation, null)
        : observation;
    } catch {
      try {
        await this.runtimeSecretBinding.markReconciliationRequired(runtimeInput);
      } catch {
        // The durable lease remains tracked in its prior state for recovery.
      }
      throw new AuthorityProviderBrokerError('PROVIDER_RECONCILIATION_FAILED');
    }
  }

  async revoke(input: TrustedOperationAdapterContext): Promise<void> {
    const providerInput = providerContext(input);
    const runtimeInput = secretContext(input);
    assertAdapter(this.providerAdapter, input.provider);
    try {
      await this.providerAdapter.revoke(providerInput);
      await this.runtimeSecretBinding.revoke(runtimeInput);
    } catch {
      try {
        await this.runtimeSecretBinding.markReconciliationRequired(runtimeInput);
      } catch {
        // The durable lease remains tracked in its prior state for recovery.
      }
      throw new AuthorityProviderBrokerError('PROVIDER_REVOCATION_FAILED');
    }
  }
}

