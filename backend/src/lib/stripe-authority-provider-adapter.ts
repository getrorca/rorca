/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import { query } from '../db/index';
import { UnprocessableError } from './errors';

export const STRIPE_AUTHORITY_PROVIDER_ADAPTER_VERSION = 'rorca.stripe-authority-provider-adapter.v1' as const;

export const StripeModeSchema = z.enum(['test', 'live']);
export type StripeMode = z.infer<typeof StripeModeSchema>;

export const StripeCredentialClassSchema = z.enum([
  'restricted_api_key',
  'unrestricted_api_key',
  'webhook_signing_secret',
]);
export type StripeCredentialClass = z.infer<typeof StripeCredentialClassSchema>;

const STRIPE_CREDENTIAL_VALUE = /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/;

export const StripeKeyKindSchema = z.enum(['restricted', 'unrestricted', 'signing_secret']);
export type StripeKeyKind = z.infer<typeof StripeKeyKindSchema>;

export const StripePermissionSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._:-]*$/)
  .refine((permission) => !STRIPE_CREDENTIAL_VALUE.test(permission), {
    message: 'Credential-shaped values are forbidden in permission manifests',
  });

export const StripePermissionManifestSchema = z.array(StripePermissionSchema)
  .max(256)
  .superRefine((permissions, context) => {
    if (new Set(permissions).size !== permissions.length) {
      context.addIssue({ code: 'custom', message: 'Permission manifest entries must be unique' });
    }
  });

/**
 * SCR-001: Secret-free inventory projection. Strict parsing prevents an accidental
 * key, webhook secret, or provider response payload from crossing this boundary.
 */
export const StripeProviderBindingSchema = z.object({
  providerId: z.literal('stripe'),
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  accountId: z.string().min(1).max(255),
  mode: StripeModeSchema,
  scope: z.object({
    applicationId: z.string().min(1).max(255),
    resourceType: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    resourceId: z.string().min(1).max(255),
  }).strict(),
  credentialClass: StripeCredentialClassSchema,
  keyKind: StripeKeyKindSchema,
  permissionManifest: StripePermissionManifestSchema,
  owner: z.string().min(1).max(255),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  secretStoreReference: z.string().min(1).max(2048),
  targetBindingReference: z.string().min(1).max(2048),
  status: z.enum(['active', 'staged', 'quarantined', 'revoked', 'invalid']),
  generation: z.number().int().positive(),
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((binding, context) => {
  const expectedKind: Record<StripeCredentialClass, StripeKeyKind> = {
    restricted_api_key: 'restricted',
    unrestricted_api_key: 'unrestricted',
    webhook_signing_secret: 'signing_secret',
  };
  if (binding.keyKind !== expectedKind[binding.credentialClass]) {
    context.addIssue({
      code: 'custom',
      path: ['keyKind'],
      message: `Key kind must be ${expectedKind[binding.credentialClass]} for ${binding.credentialClass}`,
    });
  }
  if (STRIPE_CREDENTIAL_VALUE.test(JSON.stringify(binding))) {
    context.addIssue({
      code: 'custom',
      message: 'Credential-shaped values are forbidden in provider binding inventory',
    });
  }
});
export type StripeProviderBinding = z.infer<typeof StripeProviderBindingSchema>;

interface StripeProviderBindingRow {
  id: string;
  workspace_id: string;
  provider_account_id: string;
  mode: StripeMode;
  application_id: string;
  resource_type: string;
  resource_id: string;
  credential_class: StripeCredentialClass;
  key_kind: StripeKeyKind;
  permission_manifest: unknown;
  owner: string;
  fingerprint: string;
  secret_store_reference: string;
  target_binding_reference: string;
  status: StripeProviderBinding['status'];
  binding_generation: string | number;
  last_verified_at: Date | string | null;
}

export type StripeBindingReader = (workspaceId: string) => Promise<readonly StripeProviderBindingRow[]>;

async function readStripeBindings(workspaceId: string): Promise<readonly StripeProviderBindingRow[]> {
  return query<StripeProviderBindingRow>(
    `SELECT id, workspace_id, provider_account_id, mode, application_id,
            resource_type, resource_id, credential_class, key_kind,
            permission_manifest, owner, fingerprint, secret_store_reference,
            target_binding_reference, status, binding_generation, last_verified_at
       FROM provider_credential_bindings
      WHERE workspace_id = $1 AND provider = 'stripe'
      ORDER BY mode, application_id, resource_type, resource_id,
               credential_class, binding_generation DESC`,
    [workspaceId],
  );
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function projectStripeBinding(row: StripeProviderBindingRow): StripeProviderBinding {
  return StripeProviderBindingSchema.parse({
    providerId: 'stripe',
    bindingId: row.id,
    workspaceId: row.workspace_id,
    accountId: row.provider_account_id,
    mode: row.mode,
    scope: {
      applicationId: row.application_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
    },
    credentialClass: row.credential_class,
    keyKind: row.key_kind,
    permissionManifest: row.permission_manifest,
    owner: row.owner,
    fingerprint: row.fingerprint,
    secretStoreReference: row.secret_store_reference,
    targetBindingReference: row.target_binding_reference,
    status: row.status,
    generation: Number(row.binding_generation),
    lastVerifiedAt: timestamp(row.last_verified_at),
  });
}

export const StripeBindingSelectorSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  accountId: z.string().min(1).max(255),
  mode: StripeModeSchema,
  applicationId: z.string().min(1).max(255),
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(255),
  credentialClass: StripeCredentialClassSchema,
}).strict();
export type StripeBindingSelector = z.infer<typeof StripeBindingSelectorSchema>;

export const StripeApplicationMappingSchema = StripeBindingSelectorSchema.extend({
  bindingId: z.string().uuid(),
  targetBindingReference: z.string().min(1).max(2048),
  permissions: StripePermissionManifestSchema,
}).strict();
export type StripeApplicationMapping = z.infer<typeof StripeApplicationMappingSchema>;

function hasExactIdentity(binding: StripeProviderBinding, selector: StripeBindingSelector): boolean {
  return binding.workspaceId === selector.workspaceId
    && binding.accountId === selector.accountId
    && binding.mode === selector.mode
    && binding.scope.applicationId === selector.applicationId
    && binding.scope.resourceType === selector.resourceType
    && binding.scope.resourceId === selector.resourceId
    && binding.credentialClass === selector.credentialClass;
}

function canSatisfy(binding: StripeProviderBinding, permissions: readonly string[]): boolean {
  const approved = new Set(binding.permissionManifest);
  return permissions.every((permission) => approved.has(permission));
}

/**
 * SCR-001: Enforces exact scope/mode and least privilege for a runtime mapping.
 * Error details contain only identifiers and permission names, never secret
 * material.
 */
export function assertStripeApplicationMapping(
  bindingInput: StripeProviderBinding,
  mappingInput: StripeApplicationMapping,
  inventoryInput: readonly StripeProviderBinding[],
): void {
  const binding = StripeProviderBindingSchema.parse(bindingInput);
  const mapping = StripeApplicationMappingSchema.parse(mappingInput);
  const inventory = inventoryInput.map((candidate) => StripeProviderBindingSchema.parse(candidate));

  if (mapping.bindingId !== binding.bindingId || !hasExactIdentity(binding, mapping)) {
    throw new UnprocessableError(
      'Stripe application mapping must match the binding workspace, account, mode, scope, and credential class exactly',
      'STRIPE_BINDING_SCOPE_MISMATCH',
      { bindingId: binding.bindingId, requestedMode: mapping.mode, bindingMode: binding.mode },
    );
  }
  if (mapping.targetBindingReference !== binding.targetBindingReference) {
    throw new UnprocessableError(
      'Stripe application mapping target does not match the approved target binding',
      'STRIPE_TARGET_BINDING_MISMATCH',
      { bindingId: binding.bindingId },
    );
  }

  if (binding.status !== 'active') {
    throw new UnprocessableError(
      'Stripe application mappings require an active credential binding',
      'STRIPE_BINDING_NOT_ACTIVE',
      { bindingId: binding.bindingId, status: binding.status },
    );
  }

  const approved = new Set(binding.permissionManifest);
  const unapprovedPermissions = mapping.permissions.filter((permission) => !approved.has(permission));
  if (unapprovedPermissions.length > 0) {
    throw new UnprocessableError(
      `Stripe application mapping exceeds the approved permission manifest: ${unapprovedPermissions.join(', ')}`,
      'STRIPE_PERMISSION_MANIFEST_EXCEEDED',
      { bindingId: binding.bindingId, unapprovedPermissions },
    );
  }

  if (binding.credentialClass === 'unrestricted_api_key') {
    const sufficientRestrictedBinding = inventory.find((candidate) =>
      candidate.status === 'active'
      && candidate.credentialClass === 'restricted_api_key'
      && candidate.workspaceId === mapping.workspaceId
      && candidate.accountId === mapping.accountId
      && candidate.mode === mapping.mode
      && candidate.scope.applicationId === mapping.applicationId
      && candidate.scope.resourceType === mapping.resourceType
      && candidate.scope.resourceId === mapping.resourceId
      && canSatisfy(candidate, mapping.permissions));
    if (sufficientRestrictedBinding) {
      throw new UnprocessableError(
        `Unrestricted Stripe account credentials cannot be mapped for ${mapping.applicationId} when an active restricted key satisfies the approved operations`,
        'STRIPE_RESTRICTED_KEY_REQUIRED',
        { bindingId: binding.bindingId, restrictedBindingId: sufficientRestrictedBinding.bindingId },
      );
    }
  }
}

export const StripeRotationGrantSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  accountId: z.string().min(1).max(255),
  mode: StripeModeSchema,
  authorityKind: z.enum(['restricted_api_key_grant', 'stripe_dashboard_operator']),
  permissions: StripePermissionManifestSchema,
}).strict();
export type StripeRotationGrant = z.infer<typeof StripeRotationGrantSchema>;

/** SCR-001: Restricted API-key authority can never rotate a webhook signing secret. */
export function assertStripeRotationAuthorized(
  bindingInput: StripeProviderBinding,
  grantInput: StripeRotationGrant,
): void {
  const binding = StripeProviderBindingSchema.parse(bindingInput);
  const grant = StripeRotationGrantSchema.parse(grantInput);
  if (binding.workspaceId !== grant.workspaceId
      || binding.accountId !== grant.accountId
      || binding.mode !== grant.mode) {
    throw new UnprocessableError(
      'Stripe rotation grant must match the binding workspace, account, and mode exactly',
      'STRIPE_ROTATION_GRANT_SCOPE_MISMATCH',
    );
  }
  if (binding.credentialClass === 'webhook_signing_secret'
      && (grant.authorityKind !== 'stripe_dashboard_operator'
        || !grant.permissions.includes('credentials.webhook_signing_secret.rotate'))) {
    throw new UnprocessableError(
      'Webhook signing-secret rotation requires an explicit Stripe Dashboard operator grant; restricted API-key grants are insufficient',
      'STRIPE_WEBHOOK_ROTATION_AUTHORITY_REQUIRED',
      { bindingId: binding.bindingId },
    );
  }
}

/** SCR-001: Rorca Stripe Credential Authority Adapter. */
export class StripeAuthorityProviderAdapter {
  readonly contractVersion = STRIPE_AUTHORITY_PROVIDER_ADAPTER_VERSION;
  readonly providerId = 'stripe' as const;

  constructor(private readonly readBindings: StripeBindingReader = readStripeBindings) {}

  async inventory(workspaceId: string): Promise<readonly StripeProviderBinding[]> {
    const parsedWorkspaceId = z.string().min(1).max(255).parse(workspaceId);
    const rows = await this.readBindings(parsedWorkspaceId);
    return Object.freeze(rows.map(projectStripeBinding));
  }

  /**
   * Resolves only an exact active binding. No account, workspace, or test/live
   * fallback exists by design.
   */
  async getProviderBinding(selectorInput: StripeBindingSelector): Promise<StripeProviderBinding | null> {
    const selector = StripeBindingSelectorSchema.parse(selectorInput);
    const inventory = await this.inventory(selector.workspaceId);
    return inventory.find((binding) => binding.status === 'active' && hasExactIdentity(binding, selector)) ?? null;
  }

  async assertApplicationMapping(mappingInput: StripeApplicationMapping): Promise<StripeProviderBinding> {
    const mapping = StripeApplicationMappingSchema.parse(mappingInput);
    const inventory = await this.inventory(mapping.workspaceId);
    const binding = inventory.find((candidate) => candidate.bindingId === mapping.bindingId);
    if (!binding) {
      throw new UnprocessableError(
        'Stripe application mapping references a binding outside the workspace inventory',
        'STRIPE_BINDING_NOT_IN_INVENTORY',
        { bindingId: mapping.bindingId },
      );
    }
    assertStripeApplicationMapping(binding, mapping, inventory);
    return binding;
  }
}
