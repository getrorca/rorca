/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Buffer } from 'node:buffer';
import { createDecipheriv, createHash } from 'node:crypto';
import https from 'node:https';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalTransaction } from '../db/index';
import { ConflictError, ForbiddenError, UnprocessableError } from './errors';
import { StripePermissionManifestSchema } from './stripe-authority-provider-adapter';
import { readStripeCredentialStoreEncryptionKey } from './stripe-credential-capture';
import { StripeRotationCanarySchema } from './stripe-credential-rotation';

const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SafeSecretReferenceSchema = z.string().trim().min(1).max(2048).refine(
  (value) => !/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(value),
  { message: 'Credential-shaped values are forbidden in Stripe operation metadata' },
);
const ProviderCredentialSecretReferenceSchema = z.string().regex(
  /^secret-store:\/\/rorca\/provider-credentials\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const SUPPORTED_READ_RESOURCES: Readonly<Record<string, true>> = Object.freeze({
  charges: true,
  customers: true,
  invoices: true,
  payment_intents: true,
  prices: true,
  products: true,
  setup_intents: true,
  subscriptions: true,
});

export const StripeCredentialOperationInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  accountId: z.string().trim().min(1).max(255),
  mode: z.literal('test'),
  secretStoreReference: SafeSecretReferenceSchema,
  expectedFingerprint: FingerprintSchema,
  permissionManifest: StripePermissionManifestSchema.min(1),
  canary: StripeRotationCanarySchema,
}).strict().superRefine((input, context) => {
  if (input.canary.operation !== `${input.canary.resourceType}.read`
      || SUPPORTED_READ_RESOURCES[input.canary.resourceType] !== true) {
    context.addIssue({
      code: 'custom',
      path: ['canary', 'operation'],
      message: 'Stripe canary must be a supported bounded provider read operation',
    });
  }
  if (!input.permissionManifest.includes(input.canary.operation)) {
    context.addIssue({
      code: 'custom',
      path: ['permissionManifest'],
      message: 'Stripe canary permission must be present in the exact manifest',
    });
  }
});
export type StripeCredentialOperationInput = z.infer<typeof StripeCredentialOperationInputSchema>;

export const StripeCanaryReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.stripe-canary-receipt.v1'),
  mode: z.literal('test'),
  operation: z.string().min(1).max(128),
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(255),
  providerRequestReference: z.string().min(1).max(255),
  verifiedAt: z.string().datetime({ offset: true }),
}).strict();
export type StripeCanaryReceipt = z.infer<typeof StripeCanaryReceiptSchema>;

export const StripeOldKeyRejectionReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.stripe-old-key-rejection-receipt.v1'),
  mode: z.literal('test'),
  operation: z.string().min(1).max(128),
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(255),
  providerRequestReference: z.string().min(1).max(255),
  rejectedAt: z.string().datetime({ offset: true }),
  result: z.literal('authentication_rejected'),
}).strict();
export type StripeOldKeyRejectionReceipt = z.infer<typeof StripeOldKeyRejectionReceiptSchema>;

export const StripeCredentialStatusReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.stripe-credential-status-receipt.v1'),
  fingerprint: FingerprintSchema,
  status: z.enum(['active', 'rejected', 'unknown']),
  mode: z.literal('test'),
  operation: z.string().min(1).max(128),
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(255),
  providerRequestReference: z.string().min(1).max(255).nullable(),
  evidenceCode: z.enum([
    'provider_operation_succeeded',
    'provider_authentication_rejected',
    'provider_response_indeterminate',
    'provider_readback_unavailable',
  ]),
  observedAt: z.string().datetime({ offset: true }),
}).strict();
export type StripeCredentialStatusReceipt = z.infer<typeof StripeCredentialStatusReceiptSchema>;

interface EncryptedCredentialRow {
  encrypted_value: Buffer;
  encryption_iv: Buffer;
  encryption_auth_tag: Buffer;
  fingerprint: string;
}

export interface StripeCredentialSecretExecutor {
  useCredential<T>(input: {
    secretStoreReference: string;
    expectedFingerprint: string;
    operation: (credential: Uint8Array) => Promise<T>;
  }): Promise<T>;
}

async function selectEncryptedCredential(
  client: PoolClient,
  secretStoreReference: string,
): Promise<EncryptedCredentialRow | null> {
  const match = /^secret-store:\/\/rorca\/provider-credentials\/([0-9a-f-]{36})$/.exec(secretStoreReference);
  if (!match) return null;
  const result = await client.query<EncryptedCredentialRow>(
    `SELECT encrypted_value, encryption_iv, encryption_auth_tag, fingerprint
       FROM provider_credential_secret_objects
      WHERE id = $1 AND provider = 'stripe' AND status IN ('captured', 'active')`,
    [match[1]],
  );
  return result.rows[0] ?? null;
}

/** Trusted SecretStore execution boundary. Plaintext is never returned or logged. */
export class PostgresStripeCredentialSecretExecutor implements StripeCredentialSecretExecutor {
  async useCredential<T>(input: {
    secretStoreReference: string;
    expectedFingerprint: string;
    operation: (credential: Uint8Array) => Promise<T>;
  }): Promise<T> {
    const secretStoreReference = ProviderCredentialSecretReferenceSchema.parse(input.secretStoreReference);
    const expectedFingerprint = FingerprintSchema.parse(input.expectedFingerprint);
    const encrypted = await canonicalTransaction((client) => selectEncryptedCredential(client, secretStoreReference));
    if (!encrypted || encrypted.fingerprint !== expectedFingerprint) {
      throw new ForbiddenError('Stripe SecretStore credential does not match the approved fingerprint');
    }

    const encryptionKey = readStripeCredentialStoreEncryptionKey();
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, encrypted.encryption_iv);
      decipher.setAuthTag(encrypted.encryption_auth_tag);
      plaintext = Buffer.concat([decipher.update(encrypted.encrypted_value), decipher.final()]);
    } catch {
      throw new ForbiddenError('Stripe SecretStore credential could not be decrypted');
    } finally {
      encryptionKey.fill(0);
    }

    try {
      const actualFingerprint = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
      if (actualFingerprint !== expectedFingerprint) {
        throw new ForbiddenError('Stripe SecretStore credential integrity verification failed');
      }
      return await input.operation(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }
}

export interface StripeHttpOperationResult {
  statusCode: number;
  providerRequestReference: string;
  body: unknown;
}

export interface StripeHttpTransport {
  request(input: {
    path: string;
    credential: Uint8Array;
    timeoutMs: number;
  }): Promise<StripeHttpOperationResult>;
}

/** Fixed-host Stripe transport. It cannot be redirected to a local health endpoint. */
export class StripeApiHttpTransport implements StripeHttpTransport {
  async request(input: {
    path: string;
    credential: Uint8Array;
    timeoutMs: number;
  }): Promise<StripeHttpOperationResult> {
    const credential = Buffer.from(input.credential.buffer, input.credential.byteOffset, input.credential.byteLength);
    const authorization = `Bearer ${credential.toString('ascii')}`;
    const { promise, resolve, reject } = Promise.withResolvers<StripeHttpOperationResult>();
    const request = https.request({
      protocol: 'https:',
      hostname: 'api.stripe.com',
      port: 443,
      method: 'GET',
      path: input.path,
      headers: {
        accept: 'application/json',
        authorization,
        'user-agent': 'rorca-stripe-credential-canary/1',
      },
      timeout: input.timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.byteLength;
        if (received > 65_536) {
          request.destroy(new ConflictError('Stripe canary response exceeded the safe bound'));
          return;
        }
        chunks.push(bytes);
      });
      response.on('end', () => {
        const providerRequestReference = String(response.headers['request-id'] ?? '').trim();
        if (!providerRequestReference) {
          reject(new ConflictError('Stripe operation returned no provider request reference'));
          return;
        }
        let body: unknown = null;
        const bytes = Buffer.concat(chunks);
        if (bytes.byteLength > 0) {
          try {
            body = JSON.parse(bytes.toString('utf8')) as unknown;
          } catch {
            reject(new ConflictError('Stripe operation returned invalid JSON'));
            return;
          }
        }
        resolve({ statusCode: response.statusCode ?? 0, providerRequestReference, body });
      });
    });
    request.on('timeout', () => request.destroy(new ConflictError('Stripe credential operation timed out')));
    request.on('error', (error) => reject(
      error instanceof ConflictError ? error : new ConflictError('Stripe credential operation failed'),
    ));
    request.end();
    return promise;
  }
}

function stripeResourcePath(input: StripeCredentialOperationInput): string {
  return `/v1/${encodeURIComponent(input.canary.resourceType)}/${encodeURIComponent(input.canary.resourceId)}`;
}

function parseSuccessfulResource(body: unknown, expectedResourceId: string): void {
  const resource = z.object({
    id: z.string().min(1).max(255),
    livemode: z.literal(false),
  }).passthrough().safeParse(body);
  if (!resource.success || resource.data.id !== expectedResourceId) {
    throw new ConflictError('Stripe canary did not return the exact declared test-mode resource');
  }
}

export interface StripeCredentialCanaryAdapter {
  runCanary(input: StripeCredentialOperationInput, now?: Date): Promise<StripeCanaryReceipt>;
  verifyRejected(input: StripeCredentialOperationInput, now?: Date): Promise<StripeOldKeyRejectionReceipt>;
}

export interface StripeCredentialStatusReader {
  readStatus(
    input: StripeCredentialOperationInput,
    now?: Date,
  ): Promise<StripeCredentialStatusReceipt>;
}

export class StripeTestModeCredentialCanaryAdapter implements
  StripeCredentialCanaryAdapter,
  StripeCredentialStatusReader {
  constructor(
    private readonly secrets: StripeCredentialSecretExecutor = new PostgresStripeCredentialSecretExecutor(),
    private readonly transport: StripeHttpTransport = new StripeApiHttpTransport(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async execute(input: StripeCredentialOperationInput): Promise<StripeHttpOperationResult> {
    const parsed = StripeCredentialOperationInputSchema.parse(input);
    return this.secrets.useCredential({
      secretStoreReference: parsed.secretStoreReference,
      expectedFingerprint: parsed.expectedFingerprint,
      operation: (credential) => this.transport.request({
        path: stripeResourcePath(parsed),
        credential,
        timeoutMs: parsed.canary.timeoutMs,
      }),
    });
  }

  async runCanary(input: StripeCredentialOperationInput, observedAt?: Date): Promise<StripeCanaryReceipt> {
    const parsed = StripeCredentialOperationInputSchema.parse(input);
    const response = await this.execute(parsed);
    if (response.statusCode === 401) {
      throw new ForbiddenError('Stripe rejected the replacement credential during the real canary');
    }
    if (response.statusCode === 403) {
      throw new UnprocessableError(
        'Stripe replacement lacks the declared canary permission',
        'STRIPE_CANARY_PERMISSION_REJECTED',
        { operation: parsed.canary.operation },
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ConflictError('Stripe canary operation did not complete successfully', {
        status: response.statusCode,
        operation: parsed.canary.operation,
      });
    }
    parseSuccessfulResource(response.body, parsed.canary.resourceId);
    return StripeCanaryReceiptSchema.parse({
      schemaVersion: 'rorca.stripe-canary-receipt.v1',
      mode: 'test',
      operation: parsed.canary.operation,
      resourceType: parsed.canary.resourceType,
      resourceId: parsed.canary.resourceId,
      providerRequestReference: response.providerRequestReference,
      verifiedAt: (observedAt ?? this.clock()).toISOString(),
    });
  }

  async verifyRejected(
    input: StripeCredentialOperationInput,
    observedAt?: Date,
  ): Promise<StripeOldKeyRejectionReceipt> {
    const parsed = StripeCredentialOperationInputSchema.parse(input);
    const response = await this.execute(parsed);
    if (response.statusCode !== 401) {
      throw new ConflictError('Stripe old credential has not been verified as rejected', {
        status: response.statusCode,
        operation: parsed.canary.operation,
      });
    }
    return StripeOldKeyRejectionReceiptSchema.parse({
      schemaVersion: 'rorca.stripe-old-key-rejection-receipt.v1',
      mode: 'test',
      operation: parsed.canary.operation,
      resourceType: parsed.canary.resourceType,
      resourceId: parsed.canary.resourceId,
      providerRequestReference: response.providerRequestReference,
      rejectedAt: (observedAt ?? this.clock()).toISOString(),
      result: 'authentication_rejected',
    });
  }

  async readStatus(
    input: StripeCredentialOperationInput,
    observedAt?: Date,
  ): Promise<StripeCredentialStatusReceipt> {
    const parsed = StripeCredentialOperationInputSchema.parse(input);
    const statusObservedAt = (observedAt ?? this.clock()).toISOString();
    try {
      const response = await this.execute(parsed);
      if (response.statusCode === 401) {
        return StripeCredentialStatusReceiptSchema.parse({
          schemaVersion: 'rorca.stripe-credential-status-receipt.v1',
          fingerprint: parsed.expectedFingerprint,
          status: 'rejected',
          mode: 'test',
          operation: parsed.canary.operation,
          resourceType: parsed.canary.resourceType,
          resourceId: parsed.canary.resourceId,
          providerRequestReference: response.providerRequestReference,
          evidenceCode: 'provider_authentication_rejected',
          observedAt: statusObservedAt,
        });
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        try {
          parseSuccessfulResource(response.body, parsed.canary.resourceId);
        } catch {
          return StripeCredentialStatusReceiptSchema.parse({
            schemaVersion: 'rorca.stripe-credential-status-receipt.v1',
            fingerprint: parsed.expectedFingerprint,
            status: 'unknown',
            mode: 'test',
            operation: parsed.canary.operation,
            resourceType: parsed.canary.resourceType,
            resourceId: parsed.canary.resourceId,
            providerRequestReference: response.providerRequestReference,
            evidenceCode: 'provider_response_indeterminate',
            observedAt: statusObservedAt,
          });
        }
        return StripeCredentialStatusReceiptSchema.parse({
          schemaVersion: 'rorca.stripe-credential-status-receipt.v1',
          fingerprint: parsed.expectedFingerprint,
          status: 'active',
          mode: 'test',
          operation: parsed.canary.operation,
          resourceType: parsed.canary.resourceType,
          resourceId: parsed.canary.resourceId,
          providerRequestReference: response.providerRequestReference,
          evidenceCode: 'provider_operation_succeeded',
          observedAt: statusObservedAt,
        });
      }
      return StripeCredentialStatusReceiptSchema.parse({
        schemaVersion: 'rorca.stripe-credential-status-receipt.v1',
        fingerprint: parsed.expectedFingerprint,
        status: 'unknown',
        mode: 'test',
        operation: parsed.canary.operation,
        resourceType: parsed.canary.resourceType,
        resourceId: parsed.canary.resourceId,
        providerRequestReference: response.providerRequestReference,
        evidenceCode: 'provider_response_indeterminate',
        observedAt: statusObservedAt,
      });
    } catch {
      return StripeCredentialStatusReceiptSchema.parse({
        schemaVersion: 'rorca.stripe-credential-status-receipt.v1',
        fingerprint: parsed.expectedFingerprint,
        status: 'unknown',
        mode: 'test',
        operation: parsed.canary.operation,
        resourceType: parsed.canary.resourceType,
        resourceId: parsed.canary.resourceId,
        providerRequestReference: null,
        evidenceCode: 'provider_readback_unavailable',
        observedAt: statusObservedAt,
      });
    }
  }
}
