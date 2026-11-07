/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import type { AuthorityJson } from '../db/execution-authority';
import type { DeliveryAdapterDescriptor } from './delivery-adapter';
import type { SecretAccessScope } from './secret-store';

export const DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION = 'rorca.authority-provider-adapter.v1' as const;
export const AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION = 'rorca.authority-effect-provider-adapter.v1' as const;

export const ScmCapabilitySchema = z.enum([
  'scm.repository.read',
  'scm.branch.write',
  'scm.pull_request.write',
  'scm.checks.read',
  'scm.review.request',
]);
export type ScmCapability = z.infer<typeof ScmCapabilitySchema>;

export const DeploymentCapabilitySchema = z.enum([
  'deploy.staging',
  'deploy.production',
]);
export type DeploymentCapability = z.infer<typeof DeploymentCapabilitySchema>;
export const BrowserCapabilitySchema = z.enum([
  'browser.profile.enroll',
  'browser.profile.read',
  'browser.profile.quarantine',
  'browser.profile.destroy',
  'browser.session.request',
  'browser.session.use',
  'browser.session.revoke',
  'browser.session.reconcile',
  'browser.authentication.read',
  'browser.authentication.resolve',
]);
export type BrowserCapability = z.infer<typeof BrowserCapabilitySchema>;
export const OpenRouterCapabilitySchema = z.enum([
  'list_keys',
  'create_limited_key',
  'disable_key',
  'delete_key',
  'verify_binding',
]);
export type OpenRouterCapability = z.infer<typeof OpenRouterCapabilitySchema>;
export const AuthorityCapabilitySchema = z.union([
  ScmCapabilitySchema,
  DeploymentCapabilitySchema,
  BrowserCapabilitySchema,
  OpenRouterCapabilitySchema,
]);
export type AuthorityCapability = z.infer<typeof AuthorityCapabilitySchema>;

export const GithubProviderBindingSchema = z.object({
  providerId: z.literal('github-app'),
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingGeneration: z.number().int().positive(),
  bindingStatus: z.enum(['active', 'disabled', 'invalid']),
  registrationStatus: z.enum(['active', 'disabled']),
  installationStatus: z.enum(['active', 'suspended', 'removed']),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  repository: z.object({
    owner: z.string().min(1).max(39),
    name: z.string().min(1).max(100),
  }).strict(),
  secretReferences: z.array(z.object({
    purpose: z.enum(['app-signing', 'webhook-verification']),
    secretId: z.string().uuid(),
  }).strict()).length(2),
  providerProfileVerified: z.boolean(),
}).strict();

export const ForgejoProviderBindingSchema = z.object({
  providerId: z.literal('forgejo'),
  bindingId: z.string().min(1).max(255),
  workspaceId: z.string().min(1).max(255),
  bindingStatus: z.enum(['active', 'disabled', 'invalid']),
  registrationStatus: z.enum(['active', 'disabled']),
  installationStatus: z.enum(['active', 'suspended', 'removed']),
  instanceUrl: z.string().url(),
  repositoryId: z.number().int().positive().nullable(),
  repository: z.object({
    owner: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
  }).strict(),
  secretReferences: z.array(z.object({
    purpose: z.enum(['token', 'webhook-verification']),
    secretId: z.string().min(1).max(255),
  }).strict()).min(1),
  providerProfileVerified: z.boolean(),
}).strict();

export const ProductionApprovalModeSchema = z.enum([
  'local_operator',
  'independent_external',
]);
export type ProductionApprovalMode = z.infer<typeof ProductionApprovalModeSchema>;

export const CoolifyCapabilityPolicySchema = z.object({
  allowedActions: z.array(DeploymentCapabilitySchema).min(1).max(2),
  preauthorizedStaging: z.boolean(),
  productionApprovalMode: ProductionApprovalModeSchema.optional(),
  maxLeaseSeconds: z.number().int().min(30).max(3600),
}).strict();

const CoolifyIdentitySchema = z.object({
  uuid: z.string().uuid(),
  numericId: z.number().int().positive().nullable(),
}).strict();

export const CoolifyVerifiedProfileSchema = z.object({
  schemaVersion: z.literal('rorca.coolify-verified-profile.v1'),
  providerVersion: z.string().min(1).max(80).nullable(),
  target: z.object({
    project: CoolifyIdentitySchema,
    application: CoolifyIdentitySchema,
    environment: CoolifyIdentitySchema,
  }).strict(),
  principal: z.object({
    subjectId: z.string().min(1).max(255),
    teamId: z.string().min(1).max(255),
    scopes: z.array(z.string().min(1).max(120)).max(128),
  }).strict(),
  allowedActions: z.array(DeploymentCapabilitySchema).min(1).max(2),
  verifiedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const CoolifyProviderBindingSchema = z.object({
  providerId: z.literal('coolify'),
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingStatus: z.enum(['active', 'disabled', 'invalid']),
  environmentKind: z.enum(['staging', 'production']),
  baseUrl: z.string().url(),
  target: z.object({
    projectUuid: z.string().uuid(),
    applicationUuid: z.string().uuid(),
    environmentUuid: z.string().uuid(),
  }).strict(),
  capabilityPolicy: CoolifyCapabilityPolicySchema,
  bindingGeneration: z.number().int().positive(),
  secretReference: z.object({
    store: z.literal('api-key-vault'),
    secretId: z.string().uuid(),
    purpose: z.literal('control-token'),
  }).strict(),
  verifiedProfile: CoolifyVerifiedProfileSchema.nullable(),
  lastValidationError: z.enum([
    'unreachable',
    'stale',
    'ambiguous',
    'wrong_environment',
    'permission_deficient',
    'not_resolvable',
  ]).nullable(),
}).strict().superRefine((binding, context) => {
  const requiredAction = binding.environmentKind === 'staging' ? 'deploy.staging' : 'deploy.production';
  if (!binding.capabilityPolicy.allowedActions.includes(requiredAction)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilityPolicy', 'allowedActions'],
      message: `A ${binding.environmentKind} binding must allow ${requiredAction}`,
    });
  }
  if (binding.capabilityPolicy.allowedActions.some((action) => action !== requiredAction)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilityPolicy', 'allowedActions'],
      message: 'Cross-environment deployment capabilities are prohibited',
    });
  }
  if (binding.environmentKind === 'production' && binding.capabilityPolicy.preauthorizedStaging) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilityPolicy', 'preauthorizedStaging'],
      message: 'Production bindings cannot use staging preauthorization',
    });
  }
  if (binding.environmentKind === 'staging'
    && binding.capabilityPolicy.productionApprovalMode !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilityPolicy', 'productionApprovalMode'],
      message: 'Staging bindings cannot define production approval policy',
    });
  }

  const profile = binding.verifiedProfile;
  if (profile !== null) {
    const targetPairs = [
      ['project', profile.target.project.uuid, binding.target.projectUuid],
      ['application', profile.target.application.uuid, binding.target.applicationUuid],
      ['environment', profile.target.environment.uuid, binding.target.environmentUuid],
    ] as const;
    for (const [subject, observed, expected] of targetPairs) {
      if (observed.toLowerCase() !== expected.toLowerCase()) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verifiedProfile', 'target', subject, 'uuid'],
          message: `Verified ${subject} UUID must match the immutable binding target`,
        });
      }
    }
    if (profile.allowedActions.length !== binding.capabilityPolicy.allowedActions.length
      || profile.allowedActions.some((action, index) => action !== binding.capabilityPolicy.allowedActions[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verifiedProfile', 'allowedActions'],
        message: 'Verified actions must match the bound capability policy',
      });
    }
    if (Date.parse(profile.expiresAt) <= Date.parse(profile.verifiedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verifiedProfile', 'expiresAt'],
        message: 'Verified profile expiry must follow verification',
      });
    }
  }
  if (binding.bindingStatus === 'active' && (profile === null || binding.lastValidationError !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bindingStatus'],
      message: 'An active binding requires a verified profile without a validation error',
    });
  }
  if (binding.bindingStatus === 'invalid' && (profile !== null || binding.lastValidationError === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bindingStatus'],
      message: 'An invalid binding requires a validation error and no verified profile',
    });
  }
});

const ExactOriginSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return url.origin === value
      && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch {
    return false;
  }
});

export const BrowserProfileProviderBindingSchema = z.object({
  providerId: z.literal('browser-session'),
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingStatus: z.enum(['active', 'disabled', 'invalid']),
  externalProvider: z.enum(['claude', 'chatgpt']),
  accountAlias: z.string().min(1).max(120),
  allowedOrigins: z.array(ExactOriginSchema).min(1).max(32)
    .refine((origins) => new Set(origins).size === origins.length, 'Origins must be unique'),
  profileGeneration: z.number().int().positive(),
  profileStatus: z.enum(['active', 'quarantined', 'deleted']),
  retentionPolicy: z.object({
    mode: z.enum(['preserve', 'quarantine', 'destroy']),
    retainUntil: z.string().datetime().nullable(),
  }).strict(),
  destructionPolicy: z.enum(['operator_delete', 'delete_after_retention']),
  enrollmentProvenance: z.object({
    kind: z.literal('human_operator'),
    operatorId: z.string().min(1).max(255),
    surface: z.literal('operator_takeover'),
    enrolledAt: z.string().datetime(),
  }).strict(),
  health: z.object({
    provider: z.enum(['healthy', 'degraded', 'locked']),
    session: z.enum(['healthy', 'expired', 'unknown']),
    observedAt: z.string().datetime(),
  }).strict(),
  secretReferences: z.array(z.object({
    purpose: z.literal('browser-profile-artifact'),
    secretId: z.string().uuid(),
  }).strict()).length(1),
  providerProfileVerified: z.boolean(),
}).strict();

export const OpenRouterManagementOperationSchema = z.enum([
  'list_keys',
  'create_limited_key',
  'disable_key',
  'delete_key',
  'verify_binding',
]);
export type OpenRouterManagementOperation = z.infer<typeof OpenRouterManagementOperationSchema>;

export const OpenRouterPolicyLimitsSchema = z.object({
  maxCreditUsd: z.number().finite().positive().max(10_000),
  maxUsage: z.number().finite().nonnegative().max(1_000_000_000).nullable().default(null),
  allowedLimitResets: z.array(z.enum(['daily', 'weekly', 'monthly'])).max(3).default([]),
  includeByokInLimit: z.boolean().default(false),
}).strict();
export type OpenRouterPolicyLimits = z.infer<typeof OpenRouterPolicyLimitsSchema>;

export const OpenRouterProviderBindingSchema = z.object({
  providerId: z.literal('openrouter'),
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingStatus: z.enum(['active', 'disabled', 'invalid']),
  providerAccountId: z.string().min(1).max(255),
  generation: z.number().int().positive(),
  managementSecretReference: z.object({
    secretId: z.string().uuid(),
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict(),
  policyLimits: OpenRouterPolicyLimitsSchema,
  approvedOperations: z.array(OpenRouterManagementOperationSchema).max(5),
  health: z.object({
    providerAccountVerified: z.boolean(),
    completionProbeRejected: z.boolean(),
    verifiedAt: z.string().datetime().nullable(),
    validationErrorCode: z.string().max(120).nullable(),
  }).strict(),
}).strict();
export type OpenRouterProviderBinding = z.infer<typeof OpenRouterProviderBindingSchema>;

export const ProviderBindingSchema = z.union([
  GithubProviderBindingSchema,
  ForgejoProviderBindingSchema,
  BrowserProfileProviderBindingSchema,
  OpenRouterProviderBindingSchema,
  CoolifyProviderBindingSchema,
]);

/**
 * Safe provider-binding projection. It deliberately contains immutable provider
 * identifiers and vault references only; credential values and ephemeral leases
 * are not members of this contract.
 */
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;
export type CoolifyProviderBinding = z.infer<typeof CoolifyProviderBindingSchema>;
export type GithubProviderBinding = z.infer<typeof GithubProviderBindingSchema>;
export type ForgejoProviderBinding = z.infer<typeof ForgejoProviderBindingSchema>;
export type BrowserProfileProviderBinding = z.infer<typeof BrowserProfileProviderBindingSchema>;

export interface ProviderBindingSelector {
  externalProvider: 'claude' | 'chatgpt';
  accountAlias: string;
}

const ImmutableSourceRevisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const ImmutableImageDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const StagingDeploymentRevisionSchema = z.object({
  sourceRevision: ImmutableSourceRevisionSchema.nullable(),
  imageDigest: ImmutableImageDigestSchema.nullable(),
}).strict().refine(
  (revision) => revision.sourceRevision !== null || revision.imageDigest !== null,
  { message: 'An immutable source revision or image digest is required' },
);
export type StagingDeploymentRevision = z.infer<typeof StagingDeploymentRevisionSchema>;

export const DeclaredDeploymentHealthSignalSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9._-]{0,119}$/),
  source: z.enum(['deployment', 'application']),
  field: z.enum(['status', 'health_status']),
  expectedValue: z.enum([
    'active',
    'completed',
    'finished',
    'healthy',
    'ready',
    'running',
    'success',
    'succeeded',
  ]),
}).strict();
export type DeclaredDeploymentHealthSignal = z.infer<typeof DeclaredDeploymentHealthSignalSchema>;

export const ObservedDeploymentHealthSignalSchema = DeclaredDeploymentHealthSignalSchema.extend({
  actualValue: z.string().max(120).nullable(),
  passed: z.boolean(),
}).strict();
export type ObservedDeploymentHealthSignal = z.infer<typeof ObservedDeploymentHealthSignalSchema>;

export const ProviderDeploymentAcceptanceSchema = z.object({
  providerDeploymentId: z.string().min(1).max(255),
  acceptedAt: z.string().datetime(),
}).strict();
export type ProviderDeploymentAcceptance = z.infer<typeof ProviderDeploymentAcceptanceSchema>;

export const ProviderDeploymentObservationSchema = z.object({
  providerDeploymentId: z.string().min(1).max(255),
  providerStatus: z.string().min(1).max(120),
  outcome: z.enum(['pending', 'healthy', 'unhealthy']),
  signals: z.array(ObservedDeploymentHealthSignalSchema).max(32),
  observedAt: z.string().datetime(),
}).strict();
export type ProviderDeploymentObservation = z.infer<typeof ProviderDeploymentObservationSchema>;

export const StagingExecutionReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.staging-execution-receipt.v1'),
  receiptId: z.string().uuid(),
  operationId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  capability: z.literal('deploy.staging'),
  target: z.object({
    providerId: z.string().min(1).max(80),
    bindingId: z.string().uuid(),
    projectUuid: z.string().uuid(),
    applicationUuid: z.string().uuid(),
    environmentUuid: z.string().uuid(),
  }).strict(),
  revision: StagingDeploymentRevisionSchema,
  configurationBindingGeneration: z.number().int().positive(),
  bindingGeneration: z.number().int().positive(),
  providerDeploymentId: z.string().min(1).max(255),
  health: ProviderDeploymentObservationSchema
    .omit({ providerDeploymentId: true })
    .extend({ outcome: z.enum(['healthy', 'unhealthy']) })
    .strict(),
  lease: z.object({
    leaseId: z.string().uuid(),
    revoked: z.literal(true),
    revokedAt: z.string().datetime(),
  }).strict(),
  settledAt: z.string().datetime(),
}).strict();
export type StagingExecutionReceipt = z.infer<typeof StagingExecutionReceiptSchema>;

export const StagingDeploymentRequestSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  operationId: z.string().uuid(),
  revision: StagingDeploymentRevisionSchema,
  configurationBindingGeneration: z.number().int().positive(),
  healthSignals: z.array(DeclaredDeploymentHealthSignalSchema).min(1).max(32),
  requestedLeaseSeconds: z.number().int().min(30).max(3600).optional(),
}).strict();
export type StagingDeploymentRequest = z.infer<typeof StagingDeploymentRequestSchema>;

export const StagingDeploymentResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('waiting_for_authorization'),
    operationId: z.string().uuid(),
  }).strict(),
  z.object({
    status: z.literal('reconciliation_required'),
    operationId: z.string().uuid(),
    providerDeploymentId: z.string().min(1).max(255),
  }).strict(),
  z.object({
    status: z.literal('settled'),
    receipt: StagingExecutionReceiptSchema,
  }).strict(),
]);
export type StagingDeploymentResult = z.infer<typeof StagingDeploymentResultSchema>;

export const ExternalSendAuthorityPolicySchema = z.object({
  decision: z.enum(['accepted', 'denied']),
  externalSend: z.boolean(),
}).strict();
export type ExternalSendAuthorityPolicy = z.infer<typeof ExternalSendAuthorityPolicySchema>;

/** Legacy delivery selection is reference-only and cannot execute effects. */
export interface DeliveryAuthorityProviderAdapter {
  readonly contractVersion: typeof DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  readonly descriptor: DeliveryAdapterDescriptor;
  readonly capabilities: readonly AuthorityCapability[];

  getProviderBinding(
    workspaceId: string,
    selector?: { bindingId?: string; environmentKind?: 'staging' | 'production' } & Partial<ProviderBindingSelector>,
  ): Promise<ProviderBinding | null>;

  /**
   * Revalidate exact provider identity and capability scope.
   * Providers MUST NOT return credentials or secrets in the profile.
   */
  revalidateProviderBinding(workspaceId: string, bindingId: string): Promise<ProviderBinding>;
}

/**
 * Specialized adapter for providers that support immutable deployment leases
 * and generation-fenced preflight (Coolify, AWS, GCP, etc.).
 */
export interface DeploymentAuthorityProviderAdapter extends DeliveryAuthorityProviderAdapter {
  readonly capabilities: readonly DeploymentCapability[];

  createProviderBinding(input: unknown): Promise<ProviderBinding>;

  preflight(input: {
    workspaceId: string;
    bindingId: string;
    action: DeploymentCapability;
    bindingGeneration?: number;
  }): Promise<ProviderBinding>;

  acquireLease(input: {
    workspaceId: string;
    bindingId: string;
    bindingGeneration: number;
    action: DeploymentCapability;
    operationId: string;
    requestedSeconds?: number;
  }): Promise<unknown>;

  disableProviderBinding(workspaceId: string, bindingId: string, reason: string): Promise<{
    binding: ProviderBinding;
    revoked: number;
    revocationRequired: number;
    reconciliationRequired: number;
  }>;

  dispatchDeployment(input: {
    binding: ProviderBinding;
    leaseId: string;
    operationId: string;
    revision: StagingDeploymentRevision;
    configurationBindingGeneration: number;
  }): Promise<ProviderDeploymentAcceptance>;

  observeDeployment(input: {
    binding: ProviderBinding;
    providerDeploymentId: string;
    revision: StagingDeploymentRevision;
    configurationBindingGeneration: number;
    healthSignals: readonly DeclaredDeploymentHealthSignal[];
  }): Promise<ProviderDeploymentObservation>;

  revokeLease(input: {
    workspaceId: string;
    leaseId: string;
    providerDeploymentId: string;
  }): Promise<{ revokedAt: string }>;
}

export interface AuthorityCapabilityDescriptor {
  contractVersion: typeof AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  provider: string;
  capabilityId: string;
  operations: readonly string[];
  mutationCapable: boolean;
}

export interface AuthorityProviderReferenceContext extends SecretAccessScope {
  attemptId: string;
  intentId: string;
  grantId: string;
  leaseId: string;
  requestingPrincipal: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  requestDigest: string;
  evidenceDigest: string;
  idempotencyKey: string;
  fencingGeneration: number;
  constraints: AuthorityJson;
  secretReference: string;
  secretFingerprint: string;
}

export interface AuthorityProviderHealth {
  status: 'available' | 'offline' | 'unauthorized' | 'stale';
  reasonCode: string | null;
  checkedAt: string;
}

export interface PreparedAuthorityProviderLease {
  providerLeaseReference: string;
  expiresAt: string;
  redactedMetadata: AuthorityJson;
}

export type AuthorityProviderEgressMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AuthorityProviderEgressRequest {
  url: string;
  method: AuthorityProviderEgressMethod;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  timeoutMs?: number;
}

export interface AuthorityProviderEgressResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

/** The only network path exposed to a mutation-capable provider adapter. */
export interface AuthorityProviderEgress {
  request(input: AuthorityProviderEgressRequest): Promise<AuthorityProviderEgressResponse>;
}

export interface AuthorityProviderExecuteInput extends AuthorityProviderReferenceContext {
  providerLease: PreparedAuthorityProviderLease;
  /** Exact HTTPS-host mediated egress; direct ambient network use is outside the adapter contract. */
  egress: AuthorityProviderEgress;
  /** Borrowed bytes are zeroed by the broker immediately after execute returns. */
  credential: Uint8Array;
}

export type AuthorityProviderObservation =
  | {
      state: 'settled';
      outcome: 'succeeded' | 'failed';
      providerOperationReference: string;
      providerReceiptReference: string;
      redactedResult: AuthorityJson;
    }
  | { state: 'uncertain'; providerOperationReference?: string };

export type AuthorityProviderReconciliation = AuthorityProviderObservation | { state: 'not_accepted' };

export interface AuthorityProviderReceiptProjection {
  providerOperationReference: string;
  providerReceiptReference: string;
  redactedPayload: AuthorityJson;
}

/**
 * Provider-neutral effect contract. References cross the durable boundary;
 * credential bytes exist only in execute input and cannot appear in any result.
 */
export interface AuthorityProviderAdapter {
  readonly contractVersion: typeof AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  readonly provider: string;
  /** Exact lowercase provider hostnames. Wildcards, URL paths, credentials, and ports are invalid. */
  readonly allowedHosts: readonly string[];
  describeCapability(capabilityId: string): Promise<AuthorityCapabilityDescriptor | null>;
  healthPreflight(input: AuthorityProviderReferenceContext): Promise<AuthorityProviderHealth>;
  prepareLease(input: AuthorityProviderReferenceContext): Promise<PreparedAuthorityProviderLease>;
  execute(input: AuthorityProviderExecuteInput): Promise<AuthorityProviderObservation>;
  reconcile(input: AuthorityProviderReferenceContext): Promise<AuthorityProviderReconciliation>;
  revoke(input: AuthorityProviderReferenceContext): Promise<void>;
  projectReceipt(input: Extract<AuthorityProviderObservation, { state: 'settled' }>): Promise<AuthorityProviderReceiptProjection>;
}

export function acceptsExternalSend(policy: ExternalSendAuthorityPolicy | null | undefined): boolean {
  return policy?.decision === 'accepted' && policy.externalSend === true;
}

export function providerBindingIsHealthy(binding: ProviderBinding | null): binding is ProviderBinding {
  if (binding === null || binding.bindingStatus !== 'active') return false;
  if (binding.providerId === 'coolify') {
    return binding.verifiedProfile !== null
      && binding.lastValidationError === null
      && Date.parse(binding.verifiedProfile.expiresAt) > Date.now();
  }
  if (binding.providerId === 'browser-session') {
    return binding.health.provider === 'healthy'
      && binding.health.session === 'healthy'
      && binding.providerProfileVerified;
  }
  if (binding.providerId === 'openrouter') {
    return binding.health.providerAccountVerified
      && !binding.health.completionProbeRejected
      && binding.health.validationErrorCode === null;
  }
  return binding.registrationStatus === 'active'
    && binding.installationStatus === 'active'
    && binding.providerProfileVerified;
}
