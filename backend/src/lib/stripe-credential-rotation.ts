/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ForbiddenError, UnprocessableError } from './errors';
import {
  StripeModeSchema,
  StripePermissionManifestSchema,
  StripePermissionSchema,
  StripeProviderBindingSchema,
  type StripeProviderBinding,
} from './stripe-authority-provider-adapter';
import { stableWalJson } from './trusted-wal';

export const STRIPE_ROTATION_INTENT_VERSION = 'rorca.stripe-rotation-intent.v1' as const;
export const STRIPE_ROTATION_APPROVAL_VERSION = 'rorca.stripe-rotation-approval.v1' as const;

const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SecretFreeReferenceSchema = z.string().trim().min(1).max(2048).refine(
  (value) => !/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(value),
  { message: 'Credential-shaped values are forbidden at the rotation boundary' },
);

export const StripeRotationCanarySchema = z.object({
  operation: StripePermissionSchema,
  resourceType: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  resourceId: z.string().trim().min(1).max(255),
  timeoutMs: z.number().int().min(1_000).max(60_000),
}).strict();

export const StripeRotationRollbackSchema = z.object({
  strategy: z.literal('restore_previous_binding'),
  keepPriorCredentialActive: z.literal(true),
  quarantineReplacement: z.literal(true),
  verificationTimeoutMs: z.number().int().min(1_000).max(60_000),
}).strict();

export const StripeRotationHumanStepsSchema = z.object({
  dashboardReauthentication: z.literal('required'),
  restrictedKeyCreation: z.literal('required'),
  mfaAutomation: z.literal('forbidden'),
  providerControlBypass: z.literal('forbidden'),
}).strict();

/**
 * Exact authority target approved before a Stripe operator is prompted. The
 * replacement class is deliberately fixed: this ceremony cannot mint or map an
 * unrestricted account credential.
 */
export const StripeRotationIntentInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  bindingId: z.string().uuid(),
  accountId: z.string().trim().min(1).max(255),
  currentFingerprint: FingerprintSchema,
  permissionManifest: StripePermissionManifestSchema.min(1),
  mode: StripeModeSchema,
  targetBindingReference: SecretFreeReferenceSchema,
  replacementCredentialClass: z.literal('restricted_api_key'),
  canary: StripeRotationCanarySchema,
  gracePeriodSeconds: z.number().int().min(1).max(7 * 24 * 60 * 60),
  rollback: StripeRotationRollbackSchema,
  humanSteps: StripeRotationHumanStepsSchema,
}).strict().superRefine((intent, context) => {
  if (!intent.permissionManifest.includes(intent.canary.operation)) {
    context.addIssue({
      code: 'custom',
      path: ['canary', 'operation'],
      message: 'Canary operation must be authorized by the exact permission manifest',
    });
  }
});
export type StripeRotationIntentInput = z.infer<typeof StripeRotationIntentInputSchema>;

export const StripeRotationApprovalSchema = z.object({
  schemaVersion: z.literal(STRIPE_ROTATION_APPROVAL_VERSION),
  intentDigest: FingerprintSchema,
  authorityReceiptId: z.string().uuid(),
  approvedBy: z.string().trim().min(1).max(255),
  approvedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type StripeRotationApproval = z.infer<typeof StripeRotationApprovalSchema>;

const StripeRotationIntentPayloadSchema = StripeRotationIntentInputSchema.safeExtend({
  schemaVersion: z.literal(STRIPE_ROTATION_INTENT_VERSION),
}).strict();
export type StripeRotationIntentPayload = z.infer<typeof StripeRotationIntentPayloadSchema>;

export const StripeRotationIntentSchema = StripeRotationIntentPayloadSchema.safeExtend({
  intentId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  approval: StripeRotationApprovalSchema,
  state: z.literal('WAITING_FOR_AUTHENTICATION'),
  timeout: z.object({
    disposition: z.literal('paused'),
    activeElapsedMs: z.literal(0),
    pausedAt: z.string().datetime({ offset: true }),
  }).strict(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type StripeRotationIntent = z.infer<typeof StripeRotationIntentSchema>;

export const StripeOperatorCeremonySchema = z.object({
  ceremonyVersion: z.literal('rorca.stripe-secure-operator-ceremony.v1'),
  intentId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  state: z.literal('WAITING_FOR_AUTHENTICATION'),
  timeoutDisposition: z.literal('paused'),
  captureChannel: z.literal('trusted_local_operator'),
  targetBindingReference: SecretFreeReferenceSchema,
  mode: StripeModeSchema,
  permissionManifest: StripePermissionManifestSchema.min(1),
  requiredActions: z.tuple([
    z.literal('reauthenticate_in_stripe_dashboard'),
    z.literal('create_exact_restricted_key'),
    z.literal('capture_directly_to_secret_store'),
  ]),
  prohibitedActions: z.tuple([
    z.literal('submit_secret_to_api_or_model'),
    z.literal('automate_mfa'),
    z.literal('bypass_provider_controls'),
    z.literal('use_unrestricted_account_key'),
  ]),
}).strict();
export type StripeOperatorCeremony = z.infer<typeof StripeOperatorCeremonySchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function stripeRotationIntentPayload(input: StripeRotationIntentInput): StripeRotationIntentPayload {
  const parsed = StripeRotationIntentInputSchema.parse(input);
  return StripeRotationIntentPayloadSchema.parse({
    schemaVersion: STRIPE_ROTATION_INTENT_VERSION,
    ...parsed,
    permissionManifest: [...parsed.permissionManifest].sort(),
  });
}

export function stripeRotationIntentAuthorityInput(
  intentInput: StripeRotationIntent,
): StripeRotationIntentInput {
  const intent = StripeRotationIntentSchema.parse(intentInput);
  return StripeRotationIntentInputSchema.parse({
    workspaceId: intent.workspaceId,
    bindingId: intent.bindingId,
    accountId: intent.accountId,
    currentFingerprint: intent.currentFingerprint,
    permissionManifest: intent.permissionManifest,
    mode: intent.mode,
    targetBindingReference: intent.targetBindingReference,
    replacementCredentialClass: intent.replacementCredentialClass,
    canary: intent.canary,
    gracePeriodSeconds: intent.gracePeriodSeconds,
    rollback: intent.rollback,
    humanSteps: intent.humanSteps,
  });
}

export function stripeRotationIntentDigest(input: StripeRotationIntentInput): `sha256:${string}` {
  const payload = stripeRotationIntentPayload(input);
  return `sha256:${createHash('sha256').update(stableWalJson(payload), 'utf8').digest('hex')}`;
}

export function assertStripeRotationApproval(
  input: StripeRotationIntentInput,
  approvalInput: StripeRotationApproval,
  now = new Date(),
): StripeRotationApproval {
  const approval = StripeRotationApprovalSchema.parse(approvalInput);
  const digest = stripeRotationIntentDigest(input);
  if (approval.intentDigest !== digest) {
    throw new ForbiddenError('Stripe rotation approval does not match the exact immutable intent', {
      expectedIntentDigest: digest,
      approvedIntentDigest: approval.intentDigest,
    });
  }
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (approvedAt > now.getTime() + 60_000 || expiresAt <= approvedAt || expiresAt <= now.getTime()) {
    throw new ForbiddenError('Stripe rotation approval is not temporally valid');
  }
  return approval;
}

function sameManifest(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((permission, index) => permission === normalizedRight[index]);
}

export function assertStripeRotationIntentMatchesBinding(
  input: StripeRotationIntentInput,
  bindingInput: StripeProviderBinding,
): void {
  const intent = StripeRotationIntentInputSchema.parse(input);
  const binding = StripeProviderBindingSchema.parse(bindingInput);
  if (binding.credentialClass !== 'restricted_api_key' || binding.keyKind !== 'restricted') {
    throw new UnprocessableError(
      'Restricted-key creation requires an existing restricted API-key binding authority target',
      'STRIPE_RESTRICTED_ROTATION_REQUIRED',
      { bindingId: binding.bindingId, credentialClass: binding.credentialClass },
    );
  }
  if (binding.status !== 'active') {
    throw new UnprocessableError(
      'Stripe rotation requires an active current binding',
      'STRIPE_ROTATION_BINDING_NOT_ACTIVE',
      { bindingId: binding.bindingId, status: binding.status },
    );
  }
  if (intent.workspaceId !== binding.workspaceId
      || intent.bindingId !== binding.bindingId
      || intent.accountId !== binding.accountId
      || intent.mode !== binding.mode
      || intent.targetBindingReference !== binding.targetBindingReference) {
    throw new UnprocessableError(
      'Stripe rotation intent must match the current workspace, account, mode, binding, and target exactly',
      'STRIPE_ROTATION_INTENT_SCOPE_MISMATCH',
      { bindingId: binding.bindingId, requestedMode: intent.mode, bindingMode: binding.mode },
    );
  }
  if (intent.currentFingerprint !== binding.fingerprint) {
    throw new UnprocessableError(
      'Stripe rotation current fingerprint is stale',
      'STRIPE_ROTATION_FINGERPRINT_MISMATCH',
      { bindingId: binding.bindingId },
    );
  }
  if (!sameManifest(intent.permissionManifest, binding.permissionManifest)) {
    throw new UnprocessableError(
      'Stripe rotation permission manifest must equal the approved binding manifest',
      'STRIPE_ROTATION_PERMISSION_MANIFEST_MISMATCH',
      { bindingId: binding.bindingId },
    );
  }
}

export function createStripeRotationIntent(input: {
  intentId?: string;
  intent: StripeRotationIntentInput;
  approval: StripeRotationApproval;
  binding: StripeProviderBinding;
  now?: Date;
}): StripeRotationIntent {
  const now = input.now ?? new Date();
  const payload = stripeRotationIntentPayload(input.intent);
  assertStripeRotationIntentMatchesBinding(input.intent, input.binding);
  const approval = assertStripeRotationApproval(input.intent, input.approval, now);
  const timestamp = now.toISOString();
  const intent = StripeRotationIntentSchema.parse({
    ...payload,
    intentId: input.intentId ?? randomUUID(),
    intentDigest: approval.intentDigest,
    approval,
    state: 'WAITING_FOR_AUTHENTICATION',
    timeout: { disposition: 'paused', activeElapsedMs: 0, pausedAt: timestamp },
    createdAt: timestamp,
  });
  return deepFreeze(intent);
}

export function stripeOperatorCeremony(intentInput: StripeRotationIntent): StripeOperatorCeremony {
  const intent = StripeRotationIntentSchema.parse(intentInput);
  return deepFreeze(StripeOperatorCeremonySchema.parse({
    ceremonyVersion: 'rorca.stripe-secure-operator-ceremony.v1',
    intentId: intent.intentId,
    intentDigest: intent.intentDigest,
    state: intent.state,
    timeoutDisposition: intent.timeout.disposition,
    captureChannel: 'trusted_local_operator',
    targetBindingReference: intent.targetBindingReference,
    mode: intent.mode,
    permissionManifest: intent.permissionManifest,
    requiredActions: [
      'reauthenticate_in_stripe_dashboard',
      'create_exact_restricted_key',
      'capture_directly_to_secret_store',
    ],
    prohibitedActions: [
      'submit_secret_to_api_or_model',
      'automate_mfa',
      'bypass_provider_controls',
      'use_unrestricted_account_key',
    ],
  }));
}
