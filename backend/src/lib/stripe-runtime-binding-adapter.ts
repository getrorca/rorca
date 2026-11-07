/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { z } from 'zod';
import { ConflictError, ValidationError } from './errors';
import {
  StripeOldKeyRejectionReceiptSchema,
  type StripeOldKeyRejectionReceipt,
} from './stripe-credential-canary';
import { StripePermissionManifestSchema } from './stripe-authority-provider-adapter';
import { StripeRotationCanarySchema } from './stripe-credential-rotation';

const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SafeReferenceSchema = z.string().trim().min(1).max(2048).refine(
  (value) => !/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(value),
  { message: 'Credential-shaped values are forbidden in runtime-binding metadata' },
);

export const RuntimeSecretBindingStateSchema = z.object({
  targetBindingReference: SafeReferenceSchema,
  activeFingerprint: FingerprintSchema,
  health: z.enum(['healthy', 'unhealthy']),
  bindingGeneration: z.number().int().positive(),
  observedAt: z.string().datetime({ offset: true }),
}).strict();
export type RuntimeSecretBindingState = z.infer<typeof RuntimeSecretBindingStateSchema>;

export const RuntimeSecretBindingInspectInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  provider: z.literal('stripe'),
  accountId: z.string().trim().min(1).max(255),
  mode: z.literal('test'),
  targetBindingReference: SafeReferenceSchema,
  timeoutMs: z.number().int().min(1_000).max(60_000),
}).strict();
export type RuntimeSecretBindingInspectInput = z.infer<typeof RuntimeSecretBindingInspectInputSchema>;

export const RuntimeSecretBindingStageInputSchema = RuntimeSecretBindingInspectInputSchema.extend({
  idempotencyKey: z.string().uuid(),
  expectedCurrentFingerprint: FingerprintSchema,
  replacementFingerprint: FingerprintSchema,
  replacementSecretReference: SafeReferenceSchema,
}).strict();
export type RuntimeSecretBindingStageInput = z.infer<typeof RuntimeSecretBindingStageInputSchema>;

export const RuntimeSecretBindingRestoreInputSchema = RuntimeSecretBindingInspectInputSchema.extend({
  idempotencyKey: z.string().uuid(),
  expectedActiveFingerprint: FingerprintSchema,
  retainedPriorFingerprint: FingerprintSchema,
}).strict().superRefine((input, context) => {
  if (input.expectedActiveFingerprint === input.retainedPriorFingerprint) {
    context.addIssue({
      code: 'custom',
      path: ['retainedPriorFingerprint'],
      message: 'Rollback prior credential must differ from the failed replacement',
    });
  }
});
export type RuntimeSecretBindingRestoreInput = z.infer<typeof RuntimeSecretBindingRestoreInputSchema>;

export const RuntimeStripeRejectionVerificationInputSchema = RuntimeSecretBindingInspectInputSchema.extend({
  expectedActiveFingerprint: FingerprintSchema,
  retainedPriorFingerprint: FingerprintSchema,
  permissionManifest: StripePermissionManifestSchema.min(1),
  canary: StripeRotationCanarySchema,
}).strict().superRefine((input, context) => {
  if (input.expectedActiveFingerprint === input.retainedPriorFingerprint) {
    context.addIssue({
      code: 'custom',
      path: ['retainedPriorFingerprint'],
      message: 'Retained prior credential must differ from the active replacement',
    });
  }
  if (!input.permissionManifest.includes(input.canary.operation)) {
    context.addIssue({
      code: 'custom',
      path: ['canary', 'operation'],
      message: 'Old-key rejection probe must use the declared permission manifest',
    });
  }
});
export type RuntimeStripeRejectionVerificationInput = z.infer<
  typeof RuntimeStripeRejectionVerificationInputSchema
>;

/**
 * Target-owned boundary. It receives SecretStore references, never credential
 * bytes, and must make a compare-and-swap binding update under idempotencyKey.
 * Stage retains the prior generation until verifyStripeCredentialRejected has
 * exercised the exact declared Stripe operation and observed provider 401.
 */
export interface RuntimeSecretBindingAdapter {
  inspect(input: RuntimeSecretBindingInspectInput): Promise<RuntimeSecretBindingState>;
  stage(input: RuntimeSecretBindingStageInput): Promise<RuntimeSecretBindingState>;
  restore(input: RuntimeSecretBindingRestoreInput): Promise<RuntimeSecretBindingState>;
  verifyStripeCredentialRejected(
    input: RuntimeStripeRejectionVerificationInput,
  ): Promise<StripeOldKeyRejectionReceipt>;
}

function adapterBaseUrl(configured?: string): URL {
  const raw = String(configured ?? process.env.RORCA_RUNTIME_SECRET_BINDING_ADAPTER_URL ?? '').trim();
  if (!raw) {
    throw new ValidationError('RORCA_RUNTIME_SECRET_BINDING_ADAPTER_URL is required for credential cutover');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('RuntimeSecretBindingAdapter URL is invalid');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ValidationError('RuntimeSecretBindingAdapter requires HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ValidationError('RuntimeSecretBindingAdapter URL must not contain credentials, query, or fragment');
  }
  return url;
}

async function postJson(
  baseUrl: URL,
  operation: 'inspect' | 'stage' | 'restore' | 'verify-stripe-rejection',
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
  const target = new URL(`v1/runtime-secret-bindings/${operation}`, new URL(basePath, baseUrl));
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const transport = target.protocol === 'https:' ? https : http;

  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const request = transport.request(target, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': body.byteLength,
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.byteLength;
        if (received > 65_536) {
          request.destroy(new ConflictError('RuntimeSecretBindingAdapter response exceeded the safe bound'));
          return;
        }
        chunks.push(bytes);
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new ConflictError('RuntimeSecretBindingAdapter rejected the credential binding operation', {
            operation,
            status,
          }));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(new ConflictError('RuntimeSecretBindingAdapter returned invalid JSON', { operation }));
        }
      });
    });
    request.on('timeout', () => request.destroy(new ConflictError(
      'RuntimeSecretBindingAdapter operation timed out',
      { operation },
    )));
    request.on('error', (error) => reject(
      error instanceof ConflictError
        ? error
        : new ConflictError('RuntimeSecretBindingAdapter operation failed', { operation }),
    ));
    request.end(body);
  return promise;
}

export class HttpRuntimeSecretBindingAdapter implements RuntimeSecretBindingAdapter {
  constructor(private readonly configuredBaseUrl?: string) {}

  async inspect(input: RuntimeSecretBindingInspectInput): Promise<RuntimeSecretBindingState> {
    const parsed = RuntimeSecretBindingInspectInputSchema.parse(input);
    const result = await postJson(adapterBaseUrl(this.configuredBaseUrl), 'inspect', parsed, parsed.timeoutMs);
    return RuntimeSecretBindingStateSchema.parse(result);
  }

  async stage(input: RuntimeSecretBindingStageInput): Promise<RuntimeSecretBindingState> {
    const parsed = RuntimeSecretBindingStageInputSchema.parse(input);
    if (parsed.expectedCurrentFingerprint === parsed.replacementFingerprint) {
      throw new ConflictError('RuntimeSecretBindingAdapter replacement must differ from the current credential');
    }
    const result = await postJson(adapterBaseUrl(this.configuredBaseUrl), 'stage', parsed, parsed.timeoutMs);
    return RuntimeSecretBindingStateSchema.parse(result);
  }

  async restore(input: RuntimeSecretBindingRestoreInput): Promise<RuntimeSecretBindingState> {
    const parsed = RuntimeSecretBindingRestoreInputSchema.parse(input);
    const result = await postJson(
      adapterBaseUrl(this.configuredBaseUrl),
      'restore',
      parsed,
      parsed.timeoutMs,
    );
    return RuntimeSecretBindingStateSchema.parse(result);
  }

  async verifyStripeCredentialRejected(
    input: RuntimeStripeRejectionVerificationInput,
  ): Promise<StripeOldKeyRejectionReceipt> {
    const parsed = RuntimeStripeRejectionVerificationInputSchema.parse(input);
    const result = await postJson(
      adapterBaseUrl(this.configuredBaseUrl),
      'verify-stripe-rejection',
      parsed,
      parsed.canary.timeoutMs,
    );
    return StripeOldKeyRejectionReceiptSchema.parse(result);
  }
}
