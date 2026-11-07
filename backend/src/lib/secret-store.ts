/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import {
  getCredentialLease,
  getProviderBindingByReference,
  type CredentialLeaseRecord,
  type ProviderBindingRecord,
} from '../db/execution-authority';
import {
  recordSecretAccessAudit,
  type SecretAccessAuditEvent,
  type SecretAccessAuditRecordInput,
} from '../db/execution-authority-secret-access';
import { getIntegrationSecret, getOAuthTokenById, type IntegrationProvider } from './integration-vault';
import { AppError, ValidationError } from './errors';

export const SECRET_STORE_CONTRACT_VERSION = 'rorca.secret-store.v1' as const;
export const SECRET_REFERENCE_PATTERN = /^(vault|infisical):\/\/[^\s]+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const INTEGRATION_PROVIDERS: Readonly<Record<IntegrationProvider, true>> = Object.freeze({
  github: true,
  linear: true,
  vercel: true,
  slack: true,
});

const FORBIDDEN_REFERENCE_PARAMETER_PATTERN = /(^|[_-])(secret|credential|password|token|authorization|private[_-]?key)([_-]|$)/i;
export type SecretStoreFailureCode =
  | 'SECRET_SCOPE_MISMATCH'
  | 'SECRET_REFERENCE_INVALID'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_STALE'
  | 'SECRET_UNAUTHORIZED'
  | 'SECRET_STORE_OFFLINE'
  | 'SECRET_STORE_TIMEOUT'
  | 'SECRET_AUDIT_FAILED'
  | 'SECRET_REVOCATION_FAILED';

const SECRET_STORE_FAILURE_MESSAGES: Readonly<Record<SecretStoreFailureCode, string>> = Object.freeze({
  SECRET_SCOPE_MISMATCH: 'Secret access scope does not match its durable binding and lease',
  SECRET_REFERENCE_INVALID: 'Secret reference is invalid for the configured backend',
  SECRET_NOT_FOUND: 'Referenced secret is unavailable',
  SECRET_STALE: 'Referenced secret is stale',
  SECRET_UNAUTHORIZED: 'Secret store denied the scoped request',
  SECRET_STORE_OFFLINE: 'Secret store is explicitly offline',
  SECRET_STORE_TIMEOUT: 'Secret store exceeded its bounded latency',
  SECRET_AUDIT_FAILED: 'Secret access audit could not be persisted',
  SECRET_REVOCATION_FAILED: 'Secret lease revocation failed',
});

/** Fixed-message failure safe for errors, logs, WAL, receipts, APIs, and SSE. */
export class SecretStoreError extends AppError {
  readonly statusCode = 422 as const;
  declare readonly code: SecretStoreFailureCode;

  constructor(code: SecretStoreFailureCode) {
    super(SECRET_STORE_FAILURE_MESSAGES[code], code);
    this.code = code;
  }
}

export interface SecretAccessScope {
  workspaceId: string;
  environment: string;
  provider: string;
  providerResourceId: string;
  action: string;
  leasePurpose: string;
}

export interface SecretAccessRequest extends SecretAccessScope {
  principal: string;
  leaseId: string;
  bindingReference: string;
  bindingGeneration: number;
  secretReference: string;
  secretFingerprint: string;
}

export interface SecretStoreHealth {
  status: 'available' | 'offline' | 'unauthorized' | 'stale';
  checkedAt: string;
  reasonCode: SecretStoreFailureCode | null;
}

/**
 * A credential can only be borrowed through this callback. The backing bytes
 * are zeroed immediately afterward and no material-bearing result is exposed by
 * the store contract.
 */
export interface EphemeralSecretMaterial {
  readonly fingerprint: string;
  readonly disposed: boolean;
  use<TResult>(consumer: (value: Uint8Array) => Promise<TResult> | TResult): Promise<TResult>;
  dispose(): void;
}

export interface SecretStore {
  readonly contractVersion: typeof SECRET_STORE_CONTRACT_VERSION;
  readonly backend: 'database' | 'infisical';
  healthPreflight(request: SecretAccessRequest): Promise<SecretStoreHealth>;
  resolve(request: SecretAccessRequest): Promise<EphemeralSecretMaterial>;
  revoke(request: SecretAccessRequest): Promise<void>;
}

export type SecretAccessAuditWriter = (input: SecretAccessAuditRecordInput) => Promise<void>;

class BufferSecretMaterial implements EphemeralSecretMaterial {
  private bytes: Buffer | null;
  private inUse = false;

  constructor(value: string, readonly fingerprint: string) {
    this.bytes = Buffer.from(value, 'utf8');
  }

  get disposed(): boolean {
    return this.bytes === null;
  }

  async use<TResult>(consumer: (value: Uint8Array) => Promise<TResult> | TResult): Promise<TResult> {
    if (!this.bytes || this.inUse) throw new SecretStoreError('SECRET_UNAUTHORIZED');
    this.inUse = true;
    try {
      return await consumer(this.bytes);
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    this.bytes?.fill(0);
    this.bytes = null;
    this.inUse = false;
  }
}

function validateAccessRequest(request: SecretAccessRequest, backend: SecretStore['backend']): void {
  const boundedStrings: Readonly<Record<string, string>> = {
    workspaceId: request.workspaceId,
    environment: request.environment,
    provider: request.provider,
    providerResourceId: request.providerResourceId,
    action: request.action,
    leasePurpose: request.leasePurpose,
    principal: request.principal,
    leaseId: request.leaseId,
    bindingReference: request.bindingReference,
  };
  if (Object.values(boundedStrings).some((value) => typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 1024)
    || !Number.isSafeInteger(request.bindingGeneration) || request.bindingGeneration < 1
    || !DIGEST_PATTERN.test(request.secretFingerprint)
    || !SECRET_REFERENCE_PATTERN.test(request.secretReference)
    || !request.secretReference.startsWith(`${backend === 'database' ? 'vault' : 'infisical'}://`)) {
    throw new SecretStoreError('SECRET_REFERENCE_INVALID');
  }
  try {
    const reference = new URL(request.secretReference);
    if (reference.username || reference.password || reference.hash
      || [...reference.searchParams].some(([key, value]) => (
        FORBIDDEN_REFERENCE_PARAMETER_PATTERN.test(key) || Buffer.byteLength(value) > 256
      ))) {
      throw new SecretStoreError('SECRET_REFERENCE_INVALID');
    }
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    throw new SecretStoreError('SECRET_REFERENCE_INVALID');
  }
}

function sameSecretScope(left: SecretAccessScope, right: SecretAccessScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.environment === right.environment
    && left.provider === right.provider
    && left.providerResourceId === right.providerResourceId
    && left.action === right.action
    && left.leasePurpose === right.leasePurpose;
}

function fingerprint(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function exactDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

class SecretAccessAuditor {
  constructor(private readonly write: SecretAccessAuditWriter) {}

  async record(
    request: SecretAccessRequest,
    event: SecretAccessAuditEvent,
    failureCode: SecretStoreFailureCode | null = null,
  ): Promise<void> {
    try {
      await this.write({
        ...request,
        event,
        failureCode,
        provenance: Object.freeze({ source: 'trusted-secret-broker', contractVersion: SECRET_STORE_CONTRACT_VERSION }),
      });
    } catch {
      throw new SecretStoreError('SECRET_AUDIT_FAILED');
    }
  }
}

export interface DatabaseVaultSecretStoreDependencies {
  getLease(workspaceId: string, leaseId: string): Promise<CredentialLeaseRecord | null>;
  getBinding(workspaceId: string, bindingReference: string, generation: number): Promise<ProviderBindingRecord | null>;
  loadVaultValue(request: SecretAccessRequest): Promise<string | null>;
  audit: SecretAccessAuditWriter;
  now(): Date;
}

async function loadExistingVaultValue(request: SecretAccessRequest): Promise<string | null> {
  let reference: URL;
  try {
    reference = new URL(request.secretReference);
  } catch {
    return null;
  }
  if (reference.protocol !== 'vault:' || reference.username || reference.password || reference.hash) return null;
  const id = decodeURIComponent(reference.pathname.replace(/^\//, ''));
  if (!id || id.includes('/') || reference.searchParams.size > 1) return null;

  if (reference.hostname === 'integration-tokens' && reference.search === '') {
    if (!(request.provider in INTEGRATION_PROVIDERS)) return null;
    return (await getOAuthTokenById(id, request.workspaceId, request.provider as IntegrationProvider))?.token ?? null;
  }
  if (reference.hostname === 'integration-secrets'
    && request.provider === 'github-app'
    && reference.searchParams.size === 1) {
    const kind = reference.searchParams.get('kind');
    if (kind !== 'private_key' && kind !== 'webhook_secret') return null;
    return getIntegrationSecret(id, kind);
  }
  return null;
}

const DEFAULT_DATABASE_VAULT_DEPENDENCIES: DatabaseVaultSecretStoreDependencies = {
  getLease: getCredentialLease,
  getBinding: getProviderBindingByReference,
  loadVaultValue: loadExistingVaultValue,
  audit: recordSecretAccessAudit,
  now: () => new Date(),
};

/** Zero-network SecretStore over the existing encrypted integration vault. */
export class DatabaseVaultSecretStore implements SecretStore {
  readonly contractVersion = SECRET_STORE_CONTRACT_VERSION;
  readonly backend = 'database' as const;

  constructor(private readonly dependencies: DatabaseVaultSecretStoreDependencies = DEFAULT_DATABASE_VAULT_DEPENDENCIES) {}

  private async assertExactAuthorityScope(
    request: SecretAccessRequest,
    allowedLeaseStatuses: readonly CredentialLeaseRecord['status'][] = ['prepared', 'active'],
    requireActiveBinding = true,
    requireUnexpired = true,
  ): Promise<void> {
    const [lease, binding] = await Promise.all([
      this.dependencies.getLease(request.workspaceId, request.leaseId),
      this.dependencies.getBinding(request.workspaceId, request.bindingReference, request.bindingGeneration),
    ]);
    const now = this.dependencies.now();
    const expectedScope: SecretAccessScope | null = lease && binding ? {
      workspaceId: lease.workspaceId,
      environment: lease.environment,
      provider: binding.provider,
      providerResourceId: lease.providerResourceId,
      action: lease.operation,
      leasePurpose: lease.leasePurpose,
    } : null;
    if (!lease || !binding || !expectedScope || !sameSecretScope(request, expectedScope)
      || lease.bindingReference !== request.bindingReference
      || lease.bindingGeneration !== request.bindingGeneration
      || binding.bindingReference !== request.bindingReference
      || binding.generation !== request.bindingGeneration
      || binding.environment !== request.environment
      || binding.providerResourceId !== request.providerResourceId
      || lease.secretReference !== request.secretReference
      || binding.secretReference !== request.secretReference
      || lease.secretFingerprint !== request.secretFingerprint
      || binding.secretFingerprint !== request.secretFingerprint
      || (requireActiveBinding && binding.status !== 'active')
      || !allowedLeaseStatuses.includes(lease.status)
      || (requireUnexpired && lease.expiresAt.getTime() <= now.getTime())) {
      throw new SecretStoreError('SECRET_SCOPE_MISMATCH');
    }
  }

  async healthPreflight(request: SecretAccessRequest): Promise<SecretStoreHealth> {
    validateAccessRequest(request, this.backend);
    try {
      await this.assertExactAuthorityScope(request);
      return { status: 'available', checkedAt: this.dependencies.now().toISOString(), reasonCode: null };
    } catch (error) {
      if (!(error instanceof SecretStoreError)) throw error;
      return { status: 'unauthorized', checkedAt: this.dependencies.now().toISOString(), reasonCode: error.code };
    }
  }

  async resolve(request: SecretAccessRequest): Promise<EphemeralSecretMaterial> {
    validateAccessRequest(request, this.backend);
    const auditor = new SecretAccessAuditor(this.dependencies.audit);
    await auditor.record(request, 'resolution_started');
    try {
      await this.assertExactAuthorityScope(request);
      const value = await this.dependencies.loadVaultValue(request);
      if (value === null) throw new SecretStoreError('SECRET_NOT_FOUND');
      if (!exactDigest(fingerprint(value), request.secretFingerprint)) throw new SecretStoreError('SECRET_STALE');
      const material = new BufferSecretMaterial(value, request.secretFingerprint);
      try {
        await auditor.record(request, 'resolution_succeeded');
        return material;
      } catch (error) {
        material.dispose();
        throw error;
      }
    } catch (error) {
      const failure = error instanceof SecretStoreError ? error : new SecretStoreError('SECRET_NOT_FOUND');
      if (failure.code !== 'SECRET_AUDIT_FAILED') await auditor.record(request, 'resolution_failed', failure.code);
      throw failure;
    }
  }

  async revoke(request: SecretAccessRequest): Promise<void> {
    validateAccessRequest(request, this.backend);
    const auditor = new SecretAccessAuditor(this.dependencies.audit);
    await auditor.record(request, 'revocation_started');
    try {
      await this.assertExactAuthorityScope(
        request,
        ['prepared', 'active', 'exhausted', 'reconciliation_required'],
        false,
        false,
      );
      await auditor.record(request, 'revocation_succeeded');
    } catch (error) {
      const failure = error instanceof SecretStoreError ? error : new SecretStoreError('SECRET_REVOCATION_FAILED');
      if (failure.code !== 'SECRET_AUDIT_FAILED') await auditor.record(request, 'revocation_failed', failure.code);
      throw failure;
    }
  }
}

export interface InfisicalSecretResponse {
  value: string;
  fingerprint: string;
  observedAt: string;
  expiresAt: string | null;
  scope: SecretAccessScope;
}

export interface InfisicalReferenceRequest extends SecretAccessScope {
  reference: string;
  principal: string;
  leaseId: string;
  signal: AbortSignal;
}

export interface InfisicalTransport {
  health(input: InfisicalReferenceRequest): Promise<'available' | 'offline' | 'unauthorized'>;
  resolve(input: InfisicalReferenceRequest): Promise<InfisicalSecretResponse>;
  revoke(input: InfisicalReferenceRequest): Promise<void>;
}

export interface InfisicalSecretStoreConfig {
  online: boolean;
  timeoutMs: number;
  maximumStalenessMs: number;
}

export interface InfisicalSecretStoreDependencies {
  transport: InfisicalTransport;
  audit: SecretAccessAuditWriter;
  now(): Date;
}

function infisicalReferenceRequest(request: SecretAccessRequest, signal: AbortSignal): InfisicalReferenceRequest {
  return Object.freeze({
    reference: request.secretReference,
    workspaceId: request.workspaceId,
    environment: request.environment,
    provider: request.provider,
    providerResourceId: request.providerResourceId,
    action: request.action,
    leasePurpose: request.leasePurpose,
    principal: request.principal,
    leaseId: request.leaseId,
    signal,
  });
}

async function runBounded<TResult>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<TResult>): Promise<TResult> {
  const controller = new AbortController();
  return new Promise<TResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new SecretStoreError('SECRET_STORE_TIMEOUT'));
    }, timeoutMs);
    operation(controller.signal).then(
      (value) => { clearTimeout(timeout); resolve(value); },
      () => { clearTimeout(timeout); reject(new SecretStoreError('SECRET_UNAUTHORIZED')); },
    );
  });
}

/** Optional external SecretStore. It has no process.env or plaintext fallback. */
export class InfisicalSecretStore implements SecretStore {
  readonly contractVersion = SECRET_STORE_CONTRACT_VERSION;
  readonly backend = 'infisical' as const;

  constructor(
    private readonly config: InfisicalSecretStoreConfig,
    private readonly dependencies: InfisicalSecretStoreDependencies,
  ) {
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 10 || config.timeoutMs > 10_000
      || !Number.isSafeInteger(config.maximumStalenessMs) || config.maximumStalenessMs < 0
      || config.maximumStalenessMs > 24 * 60 * 60 * 1000) {
      throw new ValidationError('Infisical secret-store latency and staleness bounds are invalid');
    }
  }

  private assertOnline(): void {
    if (!this.config.online) throw new SecretStoreError('SECRET_STORE_OFFLINE');
  }

  async healthPreflight(request: SecretAccessRequest): Promise<SecretStoreHealth> {
    validateAccessRequest(request, this.backend);
    const checkedAt = this.dependencies.now().toISOString();
    if (!this.config.online) return { status: 'offline', checkedAt, reasonCode: 'SECRET_STORE_OFFLINE' };
    try {
      const status = await runBounded(this.config.timeoutMs, (signal) => (
        this.dependencies.transport.health(infisicalReferenceRequest(request, signal))
      ));
      return status === 'available'
        ? { status, checkedAt, reasonCode: null }
        : { status, checkedAt, reasonCode: status === 'offline' ? 'SECRET_STORE_OFFLINE' : 'SECRET_UNAUTHORIZED' };
    } catch (error) {
      const code = error instanceof SecretStoreError ? error.code : 'SECRET_UNAUTHORIZED';
      return { status: code === 'SECRET_STORE_TIMEOUT' ? 'offline' : 'unauthorized', checkedAt, reasonCode: code };
    }
  }

  async resolve(request: SecretAccessRequest): Promise<EphemeralSecretMaterial> {
    validateAccessRequest(request, this.backend);
    const auditor = new SecretAccessAuditor(this.dependencies.audit);
    await auditor.record(request, 'resolution_started');
    try {
      this.assertOnline();
      const response = await runBounded(this.config.timeoutMs, (signal) => (
        this.dependencies.transport.resolve(infisicalReferenceRequest(request, signal))
      ));
      const observedAt = Date.parse(response.observedAt);
      const expiresAt = response.expiresAt === null ? null : Date.parse(response.expiresAt);
      const now = this.dependencies.now().getTime();
      if (!sameSecretScope(request, response.scope)) throw new SecretStoreError('SECRET_SCOPE_MISMATCH');
      if (!DIGEST_PATTERN.test(response.fingerprint)
        || !exactDigest(response.fingerprint, request.secretFingerprint)
        || !exactDigest(fingerprint(response.value), request.secretFingerprint)
        || !Number.isFinite(observedAt)
        || observedAt > now
        || now - observedAt > this.config.maximumStalenessMs
        || (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now))) {
        throw new SecretStoreError('SECRET_STALE');
      }
      const material = new BufferSecretMaterial(response.value, response.fingerprint);
      try {
        await auditor.record(request, 'resolution_succeeded');
        return material;
      } catch (error) {
        material.dispose();
        throw error;
      }
    } catch (error) {
      const failure = error instanceof SecretStoreError ? error : new SecretStoreError('SECRET_UNAUTHORIZED');
      if (failure.code !== 'SECRET_AUDIT_FAILED') await auditor.record(request, 'resolution_failed', failure.code);
      throw failure;
    }
  }

  async revoke(request: SecretAccessRequest): Promise<void> {
    validateAccessRequest(request, this.backend);
    const auditor = new SecretAccessAuditor(this.dependencies.audit);
    await auditor.record(request, 'revocation_started');
    try {
      this.assertOnline();
      await runBounded(this.config.timeoutMs, (signal) => (
        this.dependencies.transport.revoke(infisicalReferenceRequest(request, signal))
      ));
      await auditor.record(request, 'revocation_succeeded');
    } catch (error) {
      const failure = error instanceof SecretStoreError ? error : new SecretStoreError('SECRET_REVOCATION_FAILED');
      if (failure.code !== 'SECRET_AUDIT_FAILED') await auditor.record(request, 'revocation_failed', failure.code);
      throw failure.code === 'SECRET_STORE_TIMEOUT' || failure.code === 'SECRET_STORE_OFFLINE'
        ? failure
        : new SecretStoreError('SECRET_REVOCATION_FAILED');
    }
  }
}
