/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalTransaction, queryOne } from '../db/index';
import {
  DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
  CoolifyCapabilityPolicySchema,
  CoolifyProviderBindingSchema,
  CoolifyVerifiedProfileSchema,
  ProviderDeploymentAcceptanceSchema,
  ProviderDeploymentObservationSchema,
  StagingDeploymentRevisionSchema,
  type CoolifyProviderBinding,
  type DeclaredDeploymentHealthSignal,
  type DeploymentAuthorityProviderAdapter,
  type DeploymentCapability,
  type ProviderBinding,
  type ProviderDeploymentAcceptance,
  type ProviderDeploymentObservation,
  type StagingDeploymentRevision,
} from './authority-provider-adapter';
import { boundedOutboundFetch, parsePrivateHostAllowlist } from './bounded-outbound-fetch';
import { encryptToken, decryptToken } from './auth-utils';
import { DELIVERY_ADAPTER_CONTRACT_VERSION, type DeliveryAdapterDescriptor } from './delivery-adapter';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import {
  ReleaseIntentSchema,
  ReleaseRolloutCohortSchema,
  type ReleaseIntent,
} from './release-intent';
import {
  PostgresProductionDeploymentStore,
  type ProductionAuthorizationClaimStore,
  type ProductionAuthorizationTicket,
  type ProductionDispatchAdapter,
} from './production-deployment';
import {
  PRODUCTION_HEALTH_EVIDENCE_VERSION,
  ProductionActionAcceptanceSchema,
  ProductionActionObservationSchema,
  ProductionCanaryAcceptanceSchema,
  ProductionProviderStateSchema,
  ProductionRevokedLeaseSchema,
  ProductionRolloutAuthoritySchema,
  ProductionRolloutPhaseSchema,
  ProductionRevisionSchema,
  productionCohortsMatch,
  type ProductionActionAcceptance,
  type ProductionActionObservation,
  type ProductionCanaryAcceptance,
  type ProductionProviderState,
  type ProductionRevokedLease,
  type ProductionRolloutAdapter,
  type ProductionRolloutAuthority,
  type ProductionRolloutPhase,
  type ProductionRevision,
} from './production-rollout';

const UUID = z.string().uuid();
const PROFILE_TTL_MS = 15 * 60_000;
const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_CONNECTION_TIMEOUT_MS = 3_000;
const SUCCESSFUL_DEPLOYMENT_STATUS: Record<string, true> = {
  finished: true,
  success: true,
  succeeded: true,
  completed: true,
};
const FAILED_DEPLOYMENT_STATUS: Record<string, true> = {
  failed: true,
  cancelled: true,
  canceled: true,
  error: true,
};
const PROVIDER_MAX_RESPONSE_BYTES = 256 * 1024;
const REQUIRED_PERMISSION: Record<string, true> = {
  '*': true,
  deploy: true,
  'applications.deploy': true,
  'applications.write': true,
};

export const COOLIFY_AUTHORITY_CAPABILITIES: readonly DeploymentCapability[] = Object.freeze([
  'deploy.staging',
  'deploy.production',
]);

export const COOLIFY_AUTHORITY_DESCRIPTOR: DeliveryAdapterDescriptor = Object.freeze({
  contractVersion: DELIVERY_ADAPTER_CONTRACT_VERSION,
  adapterId: 'coolify',
  adapterVersion: '1.0.0',
  label: 'Coolify deployment authority',
  kind: 'provider',
  default: false,
  optional: true,
  requiresNetwork: true,
  requiresCredentials: true,
  supportsReviewBundle: false,
  supportsExternalChangeRequest: false,
  implementationStatus: 'canonical_adapter',
  mergeAuthority: 'none',
  // Deployment authorization is represented by fenced core leases, not by the
  // delivery descriptor. This adapter can resolve credentials only in preflight.
  deploymentAuthority: 'none',
});

const CreateCoolifyBindingFieldsSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  userId: z.string().min(1).max(255),
  baseUrl: z.string().url(),
  projectUuid: UUID,
  applicationUuid: UUID,
  environmentUuid: UUID,
  environmentKind: z.enum(['staging', 'production']),
  controlToken: z.string().min(16).max(4096),
  capabilityPolicy: CoolifyCapabilityPolicySchema,
}).strict();

function enforceEnvironmentCapabilityPolicy(
  input: Pick<z.infer<typeof CreateCoolifyBindingFieldsSchema>, 'environmentKind' | 'capabilityPolicy'>,
  context: z.RefinementCtx,
): void {
  const expected = input.environmentKind === 'staging' ? 'deploy.staging' : 'deploy.production';
  if (input.capabilityPolicy.allowedActions.length !== 1
    || input.capabilityPolicy.allowedActions[0] !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilityPolicy', 'allowedActions'],
      message: 'Capability policy must contain only the exact bound environment action',
    });
  }
  if (input.environmentKind === 'production' && input.capabilityPolicy.preauthorizedStaging) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilityPolicy', 'preauthorizedStaging'],
      message: 'Production bindings cannot use staging preauthorization',
    });
  }
  if (input.environmentKind === 'staging'
    && input.capabilityPolicy.productionApprovalMode !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilityPolicy', 'productionApprovalMode'],
      message: 'Staging bindings cannot define production approval policy',
    });
  }
}

export const CreateCoolifyBindingRequestSchema = CreateCoolifyBindingFieldsSchema
  .omit({ userId: true })
  .superRefine(enforceEnvironmentCapabilityPolicy);
export const CreateCoolifyBindingSchema = CreateCoolifyBindingFieldsSchema
  .superRefine(enforceEnvironmentCapabilityPolicy);
export type CreateCoolifyBindingInput = z.infer<typeof CreateCoolifyBindingSchema>;

export type CoolifyValidationErrorCode = NonNullable<CoolifyProviderBinding['lastValidationError']>;

export class CoolifyBindingValidationError extends UnprocessableError {
  constructor(readonly reason: CoolifyValidationErrorCode, message: string) {
    super(message, `COOLIFY_BINDING_${reason.toUpperCase()}`);
  }
}

interface ProviderDependencies {
  fetch: typeof fetch;
  now: () => Date;
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
}

const DEFAULT_PROVIDER_DEPENDENCIES: ProviderDependencies = { fetch, now: () => new Date() };

interface BindingRow {
  id: string;
  workspace_id: string;
  provider_id: string;
  environment_kind: 'staging' | 'production';
  base_url: string;
  project_uuid: string;
  application_uuid: string;
  environment_uuid: string;
  secret_store_id: string;
  capability_policy: unknown;
  verified_profile: unknown | null;
  binding_generation: number | string;
  status: 'active' | 'disabled' | 'invalid';
  validation_error_code: CoolifyValidationErrorCode | null;
}

interface SecretRow {
  encrypted_key: string;
}

export interface CoolifyLeaseProjection {
  leaseId: string;
  bindingId: string;
  bindingGeneration: number;
  capability: DeploymentCapability;
  operationId: string;
  status: 'leased';
  issuedAt: string;
  expiresAt: string;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ValidationError('Coolify baseUrl must be an absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw new ValidationError('Coolify baseUrl must use https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ValidationError('Coolify baseUrl cannot contain credentials, query parameters, or fragments');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
function postgresErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}


function numericId(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function stringId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const number = numericId(value);
  return number === null ? null : String(number);
}

function publicValueContainsCredential(controlToken: string, values: readonly (string | null)[]): boolean {
  return values.some((value) => value?.includes(controlToken) === true);
}

function exactUuid(value: unknown, expected: string, subject: string): string {
  if (typeof value !== 'string' || !UUID.safeParse(value).success) {
    throw new CoolifyBindingValidationError('not_resolvable', `Coolify ${subject} did not expose an immutable UUID`);
  }
  if (value.toLowerCase() !== expected.toLowerCase()) {
    throw new CoolifyBindingValidationError('not_resolvable', `Coolify ${subject} identity did not match the bound UUID`);
  }
  return value.toLowerCase();
}

function exactObject(value: unknown, subject: string): Record<string, unknown> {
  if (Array.isArray(value)) {
    throw new CoolifyBindingValidationError('ambiguous', `Coolify returned multiple candidates for the exact ${subject} UUID`);
  }
  if (value === null || typeof value !== 'object') {
    throw new CoolifyBindingValidationError('not_resolvable', `Coolify did not resolve the exact ${subject} UUID`);
  }
  return value as Record<string, unknown>;
}

function associationUuid(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && UUID.safeParse(value).success) return value.toLowerCase();
  }
  return null;
}

function associationId(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = numericId(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function requireAssociation(input: {
  source: Record<string, unknown>;
  uuidKeys: readonly string[];
  idKeys: readonly string[];
  expectedUuid: string;
  expectedId: number | null;
  subject: string;
}): void {
  const uuid = associationUuid(input.source, input.uuidKeys);
  const id = associationId(input.source, input.idKeys);
  if (uuid !== null && uuid !== input.expectedUuid.toLowerCase()) {
    throw new CoolifyBindingValidationError('wrong_environment', `Coolify ${input.subject} UUID association conflicts with the binding`);
  }
  if (id !== null && input.expectedId !== null && id !== input.expectedId) {
    throw new CoolifyBindingValidationError('wrong_environment', `Coolify ${input.subject} numeric association conflicts with the binding`);
  }
  if (uuid === null && (id === null || input.expectedId === null)) {
    throw new CoolifyBindingValidationError('not_resolvable', `Coolify ${input.subject} association is not resolvable from immutable identity`);
  }
}

function environmentMatchesKind(environment: Record<string, unknown>, kind: 'staging' | 'production'): boolean {
  const name = String(environment.name ?? environment.name ?? '').toLowerCase();
  // Strict environment isolation: staging MUST NOT match production indicators,
  // and production MUST NOT match staging indicators.
  const isProd = name.includes('prod') || name.includes('live');
  const isStaging = name.includes('staging') || name.includes('dev') || name.includes('test');

  if (kind === 'staging') return isStaging && !isProd;
  if (kind === 'production') return isProd && !isStaging;
  return false;
}

function scopesFrom(...records: Record<string, unknown>[]): string[] {
  const scopes = new Set<string>();
  for (const record of records) {
    for (const field of ['permissions', 'abilities', 'scopes']) {
      const value = record[field];
      if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string' && item.trim()) scopes.add(item.trim().toLowerCase());
      } else if (value !== null && typeof value === 'object') {
        for (const [key, allowed] of Object.entries(value as Record<string, unknown>)) {
          if (allowed === true) scopes.add(key.toLowerCase());
        }
      }
    }
  }
  return [...scopes].sort();
}

async function providerJson(
  baseUrl: string,
  path: string,
  controlToken: string,
  dependencies: ProviderDependencies,
): Promise<{ body: unknown; response: Response }> {
  let response: Response;
  try {
    response = await boundedOutboundFetch(`${baseUrl}${path}`, {
      fetchImpl: dependencies.fetch,
      resolveHostname: dependencies.resolveHostname,
      allowedPrivateHosts: parsePrivateHostAllowlist(process.env.RORCA_COOLIFY_PRIVATE_HOST_ALLOWLIST),
      maxRedirects: 0,
      maxResponseBytes: PROVIDER_MAX_RESPONSE_BYTES,
      connectionTimeoutMs: PROVIDER_CONNECTION_TIMEOUT_MS,
      totalTimeoutMs: PROVIDER_TIMEOUT_MS,
      requestInit: {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${controlToken}`,
          Accept: 'application/json',
          'User-Agent': 'Rorca-Worker',
        },
      },
    });
  } catch {
    throw new CoolifyBindingValidationError('unreachable', 'Coolify API is unreachable');
  }

  if (response.status === 401 || response.status === 403) {
    throw new CoolifyBindingValidationError('permission_deficient', 'Coolify rejected the control credential');
  }
  if (response.status === 404) {
    throw new CoolifyBindingValidationError('not_resolvable', 'Coolify could not resolve an exact bound target');
  }
  if (!response.ok) {
    throw new CoolifyBindingValidationError('unreachable', 'Coolify API did not return a successful bounded response');
  }
  try {
    return { body: await response.json(), response };
  } catch {
    throw new CoolifyBindingValidationError('not_resolvable', 'Coolify returned an invalid target profile');
  }
}

async function providerMutationJson(
  baseUrl: string,
  path: string,
  controlToken: string,
  body: object,
  operationId: string,
  dependencies: ProviderDependencies,
): Promise<unknown> {
  let response: Response;
  try {
    response = await boundedOutboundFetch(`${baseUrl}${path}`, {
      fetchImpl: dependencies.fetch,
      resolveHostname: dependencies.resolveHostname,
      allowedPrivateHosts: parsePrivateHostAllowlist(process.env.RORCA_COOLIFY_PRIVATE_HOST_ALLOWLIST),
      maxRedirects: 0,
      maxResponseBytes: PROVIDER_MAX_RESPONSE_BYTES,
      connectionTimeoutMs: PROVIDER_CONNECTION_TIMEOUT_MS,
      totalTimeoutMs: PROVIDER_TIMEOUT_MS,
      requestInit: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${controlToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': operationId,
          'User-Agent': 'Rorca-Worker',
        },
        body: JSON.stringify(body),
      },
    });
  } catch {
    throw new UnprocessableError(
      'Coolify deployment acceptance is unknown and requires reconciliation',
      'COOLIFY_DEPLOYMENT_OUTCOME_UNKNOWN',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new CoolifyBindingValidationError('permission_deficient', 'Coolify rejected the deployment capability');
  }
  if (response.status === 404) {
    throw new CoolifyBindingValidationError('not_resolvable', 'Coolify could not resolve the bound staging application');
  }
  if (!response.ok) {
    throw new UnprocessableError(
      'Coolify deployment acceptance is unknown and requires reconciliation',
      'COOLIFY_DEPLOYMENT_OUTCOME_UNKNOWN',
    );
  }
  try {
    return await response.json();
  } catch {
    throw new UnprocessableError(
      'Coolify deployment acceptance response is invalid and requires reconciliation',
      'COOLIFY_DEPLOYMENT_OUTCOME_UNKNOWN',
    );
  }
}

export async function probeCoolifyBinding(input: {
  baseUrl: string;
  projectUuid: string;
  applicationUuid: string;
  environmentUuid: string;
  environmentKind: 'staging' | 'production';
  capabilityPolicy: z.infer<typeof CoolifyCapabilityPolicySchema>;
  controlToken: string;
}, dependencies: ProviderDependencies = DEFAULT_PROVIDER_DEPENDENCIES): Promise<z.infer<typeof CoolifyVerifiedProfileSchema>> {
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  const projectUuid = UUID.parse(input.projectUuid).toLowerCase();
  const applicationUuid = UUID.parse(input.applicationUuid).toLowerCase();
  const environmentUuid = UUID.parse(input.environmentUuid).toLowerCase();
  if (publicValueContainsCredential(input.controlToken, [
    baseUrl,
    projectUuid,
    applicationUuid,
    environmentUuid,
  ])) {
    throw new CoolifyBindingValidationError(
      'not_resolvable',
      'Coolify binding metadata must not contain credential material',
    );
  }
  const capabilityPolicy = CoolifyCapabilityPolicySchema.parse(input.capabilityPolicy);
  const expectedAction = input.environmentKind === 'staging' ? 'deploy.staging' : 'deploy.production';
  if (capabilityPolicy.allowedActions.length !== 1
    || capabilityPolicy.allowedActions[0] !== expectedAction) {
    throw new CoolifyBindingValidationError('wrong_environment', 'Coolify capability policy crosses the exact bound environment');
  }
  if (input.environmentKind === 'production' && capabilityPolicy.preauthorizedStaging) {
    throw new CoolifyBindingValidationError('wrong_environment', 'Production bindings cannot use staging preauthorization');
  }

  const [projectResult, applicationResult, environmentResult, teamResult] = await Promise.all([
    providerJson(baseUrl, `/api/v1/projects/${projectUuid}`, input.controlToken, dependencies),
    providerJson(baseUrl, `/api/v1/applications/${applicationUuid}`, input.controlToken, dependencies),
    providerJson(baseUrl, `/api/v1/projects/${projectUuid}/${environmentUuid}`, input.controlToken, dependencies),
    providerJson(baseUrl, '/api/v1/teams/current', input.controlToken, dependencies),
  ]);

  const project = exactObject(projectResult.body, 'project');
  const application = exactObject(applicationResult.body, 'application');
  const environment = exactObject(environmentResult.body, 'environment');
  const team = exactObject(teamResult.body, 'team');
  exactUuid(project.uuid, projectUuid, 'project');
  exactUuid(application.uuid, applicationUuid, 'application');
  exactUuid(environment.uuid, environmentUuid, 'environment');

  const projectId = numericId(project.id);
  const applicationId = numericId(application.id);
  const environmentId = numericId(environment.id);
  requireAssociation({
    source: environment,
    uuidKeys: ['project_uuid', 'projectUuid'], idKeys: ['project_id', 'projectId'],
    expectedUuid: projectUuid, expectedId: projectId, subject: 'environment-to-project',
  });
  requireAssociation({
    source: application,
    uuidKeys: ['environment_uuid', 'environmentUuid'], idKeys: ['environment_id', 'environmentId'],
    expectedUuid: environmentUuid, expectedId: environmentId, subject: 'application-to-environment',
  });
  const applicationProjectUuid = associationUuid(application, ['project_uuid', 'projectUuid']);
  const applicationProjectId = associationId(application, ['project_id', 'projectId']);
  if (applicationProjectUuid !== null || applicationProjectId !== null) {
    requireAssociation({
      source: application,
      uuidKeys: ['project_uuid', 'projectUuid'], idKeys: ['project_id', 'projectId'],
      expectedUuid: projectUuid, expectedId: projectId, subject: 'application-to-project',
    });
  }

  if (!environmentMatchesKind(environment, input.environmentKind)) {
    throw new CoolifyBindingValidationError('wrong_environment', 'Coolify environment classification conflicts with the requested binding kind');
  }
  if (!Array.isArray(environment.applications)) {
    throw new CoolifyBindingValidationError('not_resolvable', 'Coolify environment does not list applications');
  }
  const applicationMatch = environment.applications.find((candidate: unknown) => {
    const item = candidate !== null && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    return typeof item.uuid === 'string' && item.uuid.toLowerCase() === applicationUuid;
  });

  if (!applicationMatch) {
    throw new CoolifyBindingValidationError('wrong_environment', 'Coolify application is not a member of the bound environment');
  }

  const listedApplicationsCount = environment.applications.filter((candidate: unknown) => {
    const item = candidate !== null && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    return typeof item.uuid === 'string' && item.uuid.toLowerCase() === applicationUuid;
  }).length;

  if (listedApplicationsCount > 1) {
    throw new CoolifyBindingValidationError('ambiguous', 'Coolify environment membership resolves multiple instances of the application');
  }

  const scopes = scopesFrom(team);
  if (!scopes.some((scope) => REQUIRED_PERMISSION[scope] === true)) {
    throw new CoolifyBindingValidationError('permission_deficient', 'Coolify token lacks the required application deployment capability');
  }
  const teamId = stringId(team.id ?? team.uuid);
  const subjectId = stringId(team.user_id ?? team.userId ?? team.owner_id ?? team.id);
  if (!teamId || !subjectId) {
    throw new CoolifyBindingValidationError('not_resolvable', 'Coolify token scope identity is not resolvable');
  }

  const verifiedAt = dependencies.now();
  const versionHeader = projectResult.response.headers.get('x-coolify-version')
    ?? applicationResult.response.headers.get('x-coolify-version');
  if (publicValueContainsCredential(input.controlToken, [
    versionHeader,
    subjectId,
    teamId,
    ...scopes,
  ])) {
    throw new CoolifyBindingValidationError(
      'not_resolvable',
      'Coolify returned an unsafe capability profile',
    );
  }
  const profile = CoolifyVerifiedProfileSchema.safeParse({
    schemaVersion: 'rorca.coolify-verified-profile.v1',
    providerVersion: versionHeader,
    target: {
      project: { uuid: projectUuid, numericId: projectId },
      application: { uuid: applicationUuid, numericId: applicationId },
      environment: { uuid: environmentUuid, numericId: environmentId },
    },
    principal: { subjectId, teamId, scopes },
    allowedActions: capabilityPolicy.allowedActions,
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: new Date(verifiedAt.getTime() + PROFILE_TTL_MS).toISOString(),
  });
  if (!profile.success) {
    throw new CoolifyBindingValidationError(
      'not_resolvable',
      'Coolify returned an invalid redacted capability profile',
    );
  }
  return profile.data;
}

function mapBinding(row: BindingRow): CoolifyProviderBinding {
  return CoolifyProviderBindingSchema.parse({
    providerId: 'coolify',
    bindingId: row.id,
    workspaceId: row.workspace_id,
    bindingStatus: row.status,
    environmentKind: row.environment_kind,
    baseUrl: row.base_url,
    target: {
      projectUuid: row.project_uuid,
      applicationUuid: row.application_uuid,
      environmentUuid: row.environment_uuid,
    },
    capabilityPolicy: jsonObject(row.capability_policy),
    bindingGeneration: Number(row.binding_generation),
    secretReference: { store: 'api-key-vault', secretId: row.secret_store_id, purpose: 'control-token' },
    verifiedProfile: row.verified_profile === null ? null : jsonObject(row.verified_profile),
    lastValidationError: row.validation_error_code,
  });
}

const BINDING_COLUMNS = `id, workspace_id, provider_id, environment_kind, base_url,
  project_uuid, application_uuid, environment_uuid, secret_store_id,
  capability_policy, verified_profile, binding_generation, status, validation_error_code`;

async function readCoolifyBinding(
  workspaceId: string,
  selector: { bindingId?: string; environmentKind?: 'staging' | 'production' } = {},
): Promise<CoolifyProviderBinding | null> {
  if (!selector.bindingId && !selector.environmentKind) {
    throw new CoolifyBindingValidationError(
      'ambiguous',
      'Coolify binding selection requires an exact binding id or environment kind',
    );
  }
  if (selector.bindingId) {
    const params = selector.environmentKind
      ? [workspaceId, selector.bindingId, selector.environmentKind]
      : [workspaceId, selector.bindingId];
    const environmentPredicate = selector.environmentKind ? ' AND environment_kind = $3' : '';
    const row = await queryOne<BindingRow>(
      `SELECT ${BINDING_COLUMNS} FROM rorca.deployment_provider_bindings
        WHERE workspace_id = $1 AND provider_id = 'coolify' AND id = $2${environmentPredicate}`,
      params,
    );
    return row ? mapBinding(row) : null;
  }
  const row = await queryOne<BindingRow>(
    `SELECT ${BINDING_COLUMNS} FROM rorca.deployment_provider_bindings
      WHERE workspace_id = $1 AND provider_id = 'coolify' AND environment_kind = $2`,
    [workspaceId, selector.environmentKind],
  );
  return row ? mapBinding(row) : null;
}

async function resolveControlToken(binding: CoolifyProviderBinding): Promise<string> {
  const secret = await queryOne<SecretRow>(
    `SELECT encrypted_key FROM rorca.api_key_vault
      WHERE id = $1 AND workspace_id = $2 AND provider = 'coolify'`,
    [binding.secretReference.secretId, binding.workspaceId],
  );
  if (!secret) throw new CoolifyBindingValidationError('not_resolvable', 'Coolify control credential reference cannot be resolved');
  try {
    const token = decryptToken(secret.encrypted_key);
    if (token.length < 16 || token.length > 4096) throw new Error('invalid secret length');
    return token;
  } catch {
    throw new CoolifyBindingValidationError('not_resolvable', 'Coolify control credential reference cannot be resolved');
  }
}

async function persistValidationFailure(bindingId: string, reason: CoolifyValidationErrorCode): Promise<void> {
  await canonicalTransaction(async (client) => {
    await client.query(
      `UPDATE rorca.deployment_provider_bindings
          SET status = CASE WHEN status = 'disabled' THEN status ELSE 'invalid' END,
              validation_error_code = $2, verified_profile = NULL,
              profile_verified_at = NULL, profile_expires_at = NULL
        WHERE id = $1`,
      [bindingId, reason],
    );
  });
}

function requireStagingBinding(binding: ProviderBinding): CoolifyProviderBinding {
  const parsed = CoolifyProviderBindingSchema.safeParse(binding);
  if (!parsed.success
    || parsed.data.environmentKind !== 'staging'
    || parsed.data.capabilityPolicy.allowedActions.length !== 1
    || parsed.data.capabilityPolicy.allowedActions[0] !== 'deploy.staging') {
    throw new CoolifyBindingValidationError(
      'wrong_environment',
      'Staging deployment authority cannot address a production or cross-environment binding',
    );
  }
  if (parsed.data.verifiedProfile === null) {
    throw new CoolifyBindingValidationError('stale', 'Staging deployment requires a verified binding profile');
  }
  exactUuid(parsed.data.verifiedProfile.target.project.uuid, parsed.data.target.projectUuid, 'project');
  exactUuid(parsed.data.verifiedProfile.target.application.uuid, parsed.data.target.applicationUuid, 'application');
  exactUuid(parsed.data.verifiedProfile.target.environment.uuid, parsed.data.target.environmentUuid, 'environment');
  return parsed.data;
}

function requireProductionBinding(binding: ProviderBinding): CoolifyProviderBinding {
  const parsed = CoolifyProviderBindingSchema.safeParse(binding);
  if (!parsed.success
    || parsed.data.environmentKind !== 'production'
    || parsed.data.capabilityPolicy.allowedActions.length !== 1
    || parsed.data.capabilityPolicy.allowedActions[0] !== 'deploy.production') {
    throw new CoolifyBindingValidationError(
      'wrong_environment',
      'Production deployment authority cannot address a staging or cross-environment binding',
    );
  }
  if (parsed.data.verifiedProfile === null) {
    throw new CoolifyBindingValidationError('stale', 'Production deployment requires a verified binding profile');
  }
  exactUuid(parsed.data.verifiedProfile.target.project.uuid, parsed.data.target.projectUuid, 'project');
  exactUuid(parsed.data.verifiedProfile.target.application.uuid, parsed.data.target.applicationUuid, 'application');
  exactUuid(parsed.data.verifiedProfile.target.environment.uuid, parsed.data.target.environmentUuid, 'environment');
  return parsed.data;
}

export interface CoolifyStagingDeploymentPayload {
  uuid: string;
  commit_sha: string | null;
  image_digest: string | null;
  configuration_binding_generation: number;
}

function stagingDeploymentPayload(
  binding: CoolifyProviderBinding,
  rawRevision: StagingDeploymentRevision,
  configurationBindingGeneration: number,
): CoolifyStagingDeploymentPayload {
  const revision = StagingDeploymentRevisionSchema.parse(rawRevision);
  if (!Number.isSafeInteger(configurationBindingGeneration) || configurationBindingGeneration < 1) {
    throw new ValidationError('configurationBindingGeneration must be a positive integer');
  }
  return {
    uuid: binding.target.applicationUuid,
    commit_sha: revision.sourceRevision,
    image_digest: revision.imageDigest,
    configuration_binding_generation: configurationBindingGeneration,
  };
}

export function buildCoolifyStagingDeploymentPayload(
  binding: ProviderBinding,
  revision: StagingDeploymentRevision,
  configurationBindingGeneration: number,
): CoolifyStagingDeploymentPayload {
  return stagingDeploymentPayload(
    requireStagingBinding(binding),
    revision,
    configurationBindingGeneration,
  );
}

export interface CoolifyProductionDeploymentPayload {
  uuid: string;
  commit_sha: string;
  artifact_digests: string[];
  image_digests: string[];
  migration_set_digest: string;
  configuration_binding_generation: number;
  feature_flag_digest: string;
  rollout_cohort: ReleaseIntent['rolloutCohort'];
  rollout_phase: 'canary';
}

export function buildCoolifyProductionDeploymentPayload(
  binding: ProviderBinding,
  rawReleaseIntent: ReleaseIntent,
): CoolifyProductionDeploymentPayload {
  const productionBinding = requireProductionBinding(binding);
  const releaseIntent = ReleaseIntentSchema.parse(rawReleaseIntent);
  return {
    uuid: productionBinding.target.applicationUuid,
    commit_sha: releaseIntent.sourceRevision,
    artifact_digests: releaseIntent.artifacts.artifactDigests,
    image_digests: releaseIntent.artifacts.imageDigests,
    migration_set_digest: releaseIntent.migrationSetDigest,
    configuration_binding_generation: releaseIntent.configurationBindingGeneration,
    feature_flag_digest: releaseIntent.featureFlagDigest,
    rollout_cohort: releaseIntent.rolloutCohort,
    rollout_phase: 'canary',
  };
}

function deploymentRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return exactObject(value[0], 'deployment');
  const record = exactObject(value, 'deployment');
  if (Array.isArray(record.deployments)) return exactObject(record.deployments[0], 'deployment');
  if (record.deployment !== null && typeof record.deployment === 'object') {
    return exactObject(record.deployment, 'deployment');
  }
  return record;
}

function releaseRevision(releaseIntent: ReleaseIntent): ProductionRevision {
  return ProductionRevisionSchema.parse({
    sourceRevision: releaseIntent.sourceRevision,
    imageDigest: releaseIntent.artifacts.imageDigests[0]!,
    configurationBindingGeneration: releaseIntent.configurationBindingGeneration,
  });
}

function providerRevision(record: Record<string, unknown>, subject: string): ProductionRevision {
  const rawSourceRevision = record.commit_sha ?? record.commit
    ?? record.source_revision ?? record.sourceRevision ?? null;
  const rawImageDigest = record.image_digest ?? record.imageDigest ?? null;
  const configurationBindingGeneration = Number(
    record.configuration_binding_generation ?? record.configurationBindingGeneration,
  );
  const parsed = ProductionRevisionSchema.safeParse({
    sourceRevision: rawSourceRevision === null ? null : String(rawSourceRevision).toLowerCase(),
    imageDigest: rawImageDigest === null ? null : String(rawImageDigest).toLowerCase(),
    configurationBindingGeneration,
  });
  if (!parsed.success) {
    throw new CoolifyBindingValidationError(
      'not_resolvable',
      `Coolify ${subject} does not expose an immutable revision and configuration generation`,
    );
  }
  return parsed.data;
}

function requireProductionRevision(
  record: Record<string, unknown>,
  expected: ProductionRevision,
  subject: string,
): void {
  const observed = providerRevision(record, subject);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new CoolifyBindingValidationError(
      'stale',
      `Coolify ${subject} differs from the exact production revision`,
    );
  }
}

function requireProductionCohort(
  record: Record<string, unknown>,
  expected: ReleaseIntent['rolloutCohort'],
): void {
  const parsed = ReleaseRolloutCohortSchema.safeParse(
    record.rollout_cohort ?? record.rolloutCohort,
  );
  if (!parsed.success || !productionCohortsMatch(parsed.data, expected)) {
    throw new CoolifyBindingValidationError(
      'stale',
      'Coolify deployment did not preserve the exact approved production cohort',
    );
  }
}

function productionTarget(binding: CoolifyProviderBinding) {
  return {
    providerId: binding.providerId,
    bindingId: binding.bindingId,
    projectUuid: binding.target.projectUuid,
    applicationUuid: binding.target.applicationUuid,
    environmentUuid: binding.target.environmentUuid,
  };
}

function productionActionPayload(input: {
  binding: CoolifyProviderBinding;
  releaseIntent: ReleaseIntent;
  phase: 'expansion' | 'rollback';
  priorState: ProductionProviderState;
}): object {
  if (input.phase === 'expansion') {
    return {
      ...buildCoolifyProductionDeploymentPayload(input.binding, input.releaseIntent),
      rollout_phase: 'expansion',
    };
  }
  return {
    uuid: input.binding.target.applicationUuid,
    commit_sha: input.priorState.revision.sourceRevision,
    image_digest: input.priorState.revision.imageDigest,
    configuration_binding_generation:
      input.priorState.revision.configurationBindingGeneration,
    rollout_cohort: input.releaseIntent.rolloutCohort,
    rollout_phase: 'rollback',
    rollback_owner: input.releaseIntent.rollback.owner,
    rollback_procedure: input.releaseIntent.rollback.procedure,
  };
}


function productionAcceptanceRecord(input: {
  value: unknown;
  binding: CoolifyProviderBinding;
  targetRevision: ProductionRevision;
  cohort: ReleaseIntent['rolloutCohort'];
  controlToken: string;
}): { record: Record<string, unknown>; providerDeploymentId: string } {
  const record = deploymentRecord(input.value);
  const providerDeploymentId = z.string().min(1).max(255).parse(stringId(
    record.deployment_uuid ?? record.deploymentUuid ?? record.uuid ?? record.id,
  ));
  if (publicValueContainsCredential(input.controlToken, [providerDeploymentId])) {
    throw new CoolifyBindingValidationError(
      'not_resolvable',
      'Coolify returned an unsafe production deployment acceptance',
    );
  }
  exactUuid(
    record.resource_uuid ?? record.resourceUuid
      ?? record.application_uuid ?? record.applicationUuid,
    input.binding.target.applicationUuid,
    'deployment application',
  );
  requireProductionRevision(record, input.targetRevision, 'deployment acceptance');
  requireProductionCohort(record, input.cohort);
  return { record, providerDeploymentId };
}

async function lookupProductionAcceptance(input: {
  binding: CoolifyProviderBinding;
  controlToken: string;
  actionId: string;
  targetRevision: ProductionRevision;
  cohort: ReleaseIntent['rolloutCohort'];
  dependencies: ProviderDependencies;
}): Promise<{ providerDeploymentId: string; acceptedAt: string } | null> {
  const result = await providerJson(
    input.binding.baseUrl,
    `/api/v1/deployments?operation_id=${encodeURIComponent(input.actionId)}`,
    input.controlToken,
    input.dependencies,
  );
  if (Array.isArray(result.body) && result.body.length === 0) return null;
  const resultRecord = jsonObject(result.body);
  if (Array.isArray(resultRecord.deployments) && resultRecord.deployments.length === 0) {
    return null;
  }
  const { record, providerDeploymentId } = productionAcceptanceRecord({
    value: result.body,
    binding: input.binding,
    targetRevision: input.targetRevision,
    cohort: input.cohort,
    controlToken: input.controlToken,
  });
  const providerOperationId = record.operation_id ?? record.operationId
    ?? record.idempotency_key ?? record.idempotencyKey;
  if (providerOperationId !== undefined && providerOperationId !== input.actionId) {
    throw new CoolifyBindingValidationError(
      'stale',
      'Coolify reconciliation returned a deployment for a different provider operation',
    );
  }
  const acceptedAt = z.string().datetime({ offset: true })
    .transform((value) => new Date(value).toISOString())
    .safeParse(record.accepted_at ?? record.acceptedAt ?? record.created_at ?? record.createdAt);
  return {
    providerDeploymentId,
    acceptedAt: acceptedAt.success
      ? acceptedAt.data
      : input.dependencies.now().toISOString(),
  };
}

function nestedProviderValue(record: Record<string, unknown>, evidenceKey: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, evidenceKey)) return record[evidenceKey];
  let value: unknown = record;
  for (const segment of evidenceKey.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const objectValue = value as Record<string, unknown>;
    value = objectValue[segment];
  }
  return value;
}

function productionHealthSamples(input: {
  signal: ReleaseIntent['healthSignals'][number];
  source: Record<string, unknown>;
  observedAt: string;
}) {
  const raw = nestedProviderValue(input.source, input.signal.evidenceKey);
  const rawRecord = jsonObject(raw);
  const values = Array.isArray(raw)
    ? raw
    : Array.isArray(rawRecord.samples)
      ? rawRecord.samples
      : [raw];
  return values.flatMap((entry) => {
    const record = jsonObject(entry);
    const rawValue = record.value ?? entry;
    const value = typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string' && rawValue.trim() !== ''
        ? Number(rawValue)
        : Number.NaN;
    if (!Number.isFinite(value)) return [];
    const sampledAt = z.string().datetime({ offset: true })
      .transform((timestamp) => new Date(timestamp).toISOString())
      .safeParse(record.sampled_at ?? record.sampledAt ?? input.observedAt);
    if (!sampledAt.success) return [];
    return [{
      signalId: input.signal.signalId,
      source: input.signal.source,
      evidenceKey: input.signal.evidenceKey,
      value,
      sampledAt: sampledAt.data,
    }];
  });
}
export class CoolifyAuthorityProviderAdapter implements
  DeploymentAuthorityProviderAdapter,
  ProductionDispatchAdapter,
  ProductionRolloutAdapter {
  readonly contractVersion = DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  readonly descriptor = COOLIFY_AUTHORITY_DESCRIPTOR;
  readonly capabilities = COOLIFY_AUTHORITY_CAPABILITIES;

  constructor(
    private readonly providerDependencies: ProviderDependencies = DEFAULT_PROVIDER_DEPENDENCIES,
    private readonly productionAuthorizations: ProductionAuthorizationClaimStore =
      new PostgresProductionDeploymentStore(),
  ) {}

  async getProviderBinding(
    workspaceId: string,
    selector: { bindingId?: string; environmentKind?: 'staging' | 'production' } = {},
  ): Promise<ProviderBinding | null> {
    return readCoolifyBinding(workspaceId, selector);
  }

  async createProviderBinding(rawInput: CreateCoolifyBindingInput): Promise<CoolifyProviderBinding> {
    const input = CreateCoolifyBindingSchema.parse(rawInput);
    const baseUrl = normalizedBaseUrl(input.baseUrl);
    if (publicValueContainsCredential(input.controlToken, [input.workspaceId, input.userId])) {
      throw new ValidationError('Coolify binding metadata must not contain credential material');
    }
    const profile = await probeCoolifyBinding({ ...input, baseUrl }, this.providerDependencies);
    const bindingId = crypto.randomUUID();
    const secretId = crypto.randomUUID();
    try {
      const row = await canonicalTransaction(async (client) => {
        const workspace = await client.query<{ id: string }>('SELECT id FROM rorca.workspaces WHERE id = $1', [input.workspaceId]);
        if (!workspace.rows[0]) throw new NotFoundError('Workspace not found');
        const user = await client.query<{ id: string }>('SELECT id FROM rorca.users WHERE id = $1', [input.userId]);
        if (!user.rows[0]) throw new NotFoundError('User not found');
        await client.query(
          `INSERT INTO rorca.api_key_vault
            (id, user_id, workspace_id, provider, encrypted_key, label, base_url)
           VALUES ($1, $2, $3, 'coolify', $4, 'Coolify control token', $5)`,
          [secretId, input.userId, input.workspaceId, encryptToken(input.controlToken), baseUrl],
        );
        const result = await client.query<BindingRow>(
          `INSERT INTO rorca.deployment_provider_bindings
            (id, workspace_id, provider_id, environment_kind, base_url,
             project_uuid, application_uuid, environment_uuid, secret_store_id,
             capability_policy, verified_profile, binding_generation, status,
             validation_error_code, profile_verified_at, profile_expires_at)
           VALUES ($1, $2, 'coolify', $3, $4, $5, $6, $7, $8, $9::jsonb,
                   $10::jsonb, 1, 'active', NULL, $11, $12)
           RETURNING ${BINDING_COLUMNS}`,
          [
            bindingId, input.workspaceId, input.environmentKind, baseUrl,
            input.projectUuid.toLowerCase(), input.applicationUuid.toLowerCase(), input.environmentUuid.toLowerCase(),
            secretId, JSON.stringify(input.capabilityPolicy), JSON.stringify(profile), profile.verifiedAt, profile.expiresAt,
          ],
        );
        return result.rows[0]!;
      });
      return mapBinding(row);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      if (postgresErrorCode(error) === '23505') {
        throw new ConflictError('A Coolify binding already owns this environment or application identity');
      }
      throw error;
    }
  }

  async revalidateProviderBinding(workspaceId: string, bindingId: string): Promise<CoolifyProviderBinding> {
    const binding = await readCoolifyBinding(workspaceId, { bindingId });
    if (!binding) throw new NotFoundError('Provider binding not found');
    if (binding.environmentKind === 'production') {
      throw new ForbiddenError(
        'Production binding revalidation requires verified authorization and an open change window',
      );
    }
    return (await this.revalidateAndResolveControlToken(binding)).binding;
  }

  private async revalidateAndResolveControlToken(binding: CoolifyProviderBinding): Promise<{
    binding: CoolifyProviderBinding;
    controlToken: string;
  }> {
    try {
      const controlToken = await resolveControlToken(binding);
      const profile = await probeCoolifyBinding({
        baseUrl: binding.baseUrl,
        ...binding.target,
        environmentKind: binding.environmentKind,
        capabilityPolicy: binding.capabilityPolicy,
        controlToken,
      }, this.providerDependencies);
      const row = await canonicalTransaction(async (client) => {
        const result = await client.query<BindingRow>(
          `UPDATE rorca.deployment_provider_bindings
              SET status = CASE WHEN status = 'disabled' THEN status ELSE 'active' END,
                  verified_profile = $2::jsonb, validation_error_code = NULL,
                  profile_verified_at = $3, profile_expires_at = $4
            WHERE id = $1 AND workspace_id = $5
            RETURNING ${BINDING_COLUMNS}`,
          [
            binding.bindingId,
            JSON.stringify(profile),
            profile.verifiedAt,
            profile.expiresAt,
            binding.workspaceId,
          ],
        );
        return result.rows[0];
      });
      if (!row) throw new NotFoundError('Provider binding not found');
      return { binding: mapBinding(row), controlToken };
    } catch (error) {
      if (error instanceof CoolifyBindingValidationError) {
        await persistValidationFailure(binding.bindingId, error.reason);
      }
      throw error;
    }
  }

  async preflight(input: {
    workspaceId: string;
    bindingId: string;
    action: DeploymentCapability;
    bindingGeneration?: number;
  }): Promise<CoolifyProviderBinding> {
    const before = await readCoolifyBinding(input.workspaceId, { bindingId: input.bindingId });
    if (!before) throw new CoolifyBindingValidationError('not_resolvable', 'Coolify binding cannot be resolved');
    if (before.bindingStatus !== 'active') {
      throw new CoolifyBindingValidationError('stale', 'Coolify binding is not active');
    }
    if (input.bindingGeneration !== undefined && input.bindingGeneration !== before.bindingGeneration) {
      throw new CoolifyBindingValidationError('stale', 'Coolify binding generation is stale');
    }
    const expected = before.environmentKind === 'staging' ? 'deploy.staging' : 'deploy.production';
    if (input.action !== expected) {
      throw new CoolifyBindingValidationError('wrong_environment', 'Requested capability does not match the bound environment kind');
    }
    if (!before.capabilityPolicy.allowedActions.includes(input.action)) {
      throw new CoolifyBindingValidationError('permission_deficient', 'Requested capability is not allowed by the bound policy');
    }
    if (input.action === 'deploy.production') {
      throw new ForbiddenError(
        'Production preflight requires verified authorization and an open change window',
      );
    }
    if (before.verifiedProfile === null
      || Date.parse(before.verifiedProfile.expiresAt) <= this.providerDependencies.now().getTime()) {
      throw new CoolifyBindingValidationError('stale', 'Coolify binding verified profile is stale');
    }
    const binding = await this.revalidateProviderBinding(input.workspaceId, input.bindingId);
    if (input.bindingGeneration !== undefined && input.bindingGeneration !== binding.bindingGeneration) {
      throw new CoolifyBindingValidationError('stale', 'Coolify binding generation changed during revalidation');
    }
    if (binding.bindingStatus !== 'active' || binding.verifiedProfile === null) {
      throw new CoolifyBindingValidationError('stale', 'Coolify binding did not produce a current verified profile');
    }
    return binding;
  }

  async dispatchDeployment(input: {
    binding: ProviderBinding;
    leaseId: string;
    operationId: string;
    revision: StagingDeploymentRevision;
    configurationBindingGeneration: number;
  }): Promise<ProviderDeploymentAcceptance> {
    const binding = requireStagingBinding(input.binding);
    const payload = stagingDeploymentPayload(
      binding,
      input.revision,
      input.configurationBindingGeneration,
    );
    const leaseId = UUID.parse(input.leaseId);
    const operationId = UUID.parse(input.operationId);

    const lease = await canonicalTransaction(async (client) => {
      const result = await client.query<{
        status: string; provider_deployment_id: string | null; updated_at: string;
      }>(
        `SELECT l.status, l.provider_deployment_id, l.updated_at
           FROM rorca.authority_capability_leases l
           JOIN rorca.deployment_provider_bindings b ON b.id = l.binding_id
          WHERE l.id = $1 AND l.operation_id = $2 AND l.binding_id = $3
            AND l.binding_generation = $4 AND l.capability = 'deploy.staging'
            AND b.workspace_id = $5 AND l.expires_at > NOW()
          FOR UPDATE OF l`,
        [leaseId, operationId, binding.bindingId, binding.bindingGeneration, binding.workspaceId],
      );
      const row = result.rows[0];
      if (!row || !['leased', 'dispatched', 'outcome_unknown'].includes(row.status)) {
        throw new CoolifyBindingValidationError('stale', 'Staging deployment lease is not active');
      }
      if (row.provider_deployment_id) return row;
      if (row.status !== 'leased') {
        throw new UnprocessableError(
          'Coolify deployment acceptance is unknown and cannot be dispatched again',
          'COOLIFY_DEPLOYMENT_OUTCOME_UNKNOWN',
        );
      }
      await client.query(
        `UPDATE rorca.authority_capability_leases
            SET status = 'dispatched', updated_at = NOW()
          WHERE id = $1`,
        [leaseId],
      );
      return row;
    });
    if (lease.provider_deployment_id) {
      return ProviderDeploymentAcceptanceSchema.parse({
        providerDeploymentId: lease.provider_deployment_id,
        acceptedAt: new Date(lease.updated_at).toISOString(),
      });
    }

    try {
      const controlToken = await resolveControlToken(binding);
      const responseBody = await providerMutationJson(
        binding.baseUrl,
        '/api/v1/deploy',
        controlToken,
        payload,
        operationId,
        this.providerDependencies,
      );
      const accepted = deploymentRecord(responseBody);
      const rawProviderDeploymentId = stringId(
        accepted.deployment_uuid ?? accepted.deploymentUuid ?? accepted.uuid ?? accepted.id,
      );
      const parsedProviderDeploymentId = z.string().min(1).max(255).safeParse(rawProviderDeploymentId);
      if (!parsedProviderDeploymentId.success) {
        throw new UnprocessableError(
          'Coolify deployment acceptance omitted a bounded deployment id',
          'COOLIFY_DEPLOYMENT_OUTCOME_UNKNOWN',
        );
      }
      const providerDeploymentId = parsedProviderDeploymentId.data;
      if (publicValueContainsCredential(controlToken, [providerDeploymentId])) {
        throw new CoolifyBindingValidationError(
          'not_resolvable',
          'Coolify returned an unsafe deployment acceptance',
        );
      }
      const acceptedAt = this.providerDependencies.now();
      await canonicalTransaction(async (client) => {
        const result = await client.query(
          `UPDATE rorca.authority_capability_leases
              SET status = 'dispatched', provider_deployment_id = $2, updated_at = $3
            WHERE id = $1
              AND status IN ('dispatched', 'outcome_unknown')
              AND (provider_deployment_id IS NULL OR provider_deployment_id = $2)
           RETURNING id`,
          [leaseId, providerDeploymentId, acceptedAt],
        );
        if (result.rowCount === 0) {
          throw new ConflictError('Staging deployment lease has a conflicting provider deployment');
        }
      });
      exactUuid(
        accepted.resource_uuid ?? accepted.resourceUuid ?? accepted.application_uuid ?? accepted.applicationUuid,
        binding.target.applicationUuid,
        'deployment application',
      );
      return ProviderDeploymentAcceptanceSchema.parse({
        providerDeploymentId,
        acceptedAt: acceptedAt.toISOString(),
      });
    } catch (error) {
      await canonicalTransaction(async (client) => {
        await client.query(
          `UPDATE rorca.authority_capability_leases
              SET status = 'outcome_unknown', updated_at = NOW()
            WHERE id = $1 AND status = 'dispatched'`,
          [leaseId],
        );
      });
      throw error;
    }
  }

  async dispatchAuthorizedProduction(input: {
    ticket: ProductionAuthorizationTicket;
    releaseIntent: ReleaseIntent;
    requestedLeaseSeconds?: number;
  }): Promise<ProductionCanaryAcceptance> {
    const claimed = await this.productionAuthorizations.claimAuthorizedDispatch(
      input.ticket,
      this.providerDependencies.now(),
    );
    const requestedIntent = ReleaseIntentSchema.parse(input.releaseIntent);
    if (JSON.stringify(requestedIntent) !== JSON.stringify(claimed.releaseIntent)) {
      throw new ForbiddenError('Production dispatch release material changed after authorization');
    }

    const unresolvedBinding = await readCoolifyBinding(
      claimed.ticket.workspaceId,
      { bindingId: claimed.ticket.bindingId },
    );
    if (!unresolvedBinding) throw new NotFoundError('Provider binding not found');
    requireProductionBinding(unresolvedBinding);
    const resolved = await this.revalidateAndResolveControlToken(unresolvedBinding);
    const binding = requireProductionBinding(resolved.binding);
    if (binding.bindingGeneration !== claimed.ticket.bindingGeneration) {
      throw new CoolifyBindingValidationError(
        'stale',
        'Production binding generation changed after authorization',
      );
    }

    const targetRevision = releaseRevision(claimed.releaseIntent);
    const checkpoint = await queryOne<{
      production_prior_state: unknown | null;
      production_rollout_cohort: unknown | null;
    }>(
      `SELECT production_prior_state, production_rollout_cohort
         FROM rorca.authority_deployment_operations
        WHERE id = $1 AND workspace_id = $2`,
      [claimed.ticket.operationId, claimed.ticket.workspaceId],
    );
    if (!checkpoint) throw new NotFoundError('Production deployment operation not found');
    let priorState: ProductionProviderState;
    if (checkpoint.production_prior_state === null) {
      const currentApplication = await providerJson(
        binding.baseUrl,
        `/api/v1/applications/${binding.target.applicationUuid}`,
        resolved.controlToken,
        this.providerDependencies,
      );
      const application = exactObject(currentApplication.body, 'application');
      exactUuid(application.uuid, binding.target.applicationUuid, 'application');
      priorState = ProductionProviderStateSchema.parse({
        revision: providerRevision(application, 'application prior state'),
        authorityBindingGeneration: binding.bindingGeneration,
        capturedAt: this.providerDependencies.now().toISOString(),
      });
      await canonicalTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE rorca.authority_deployment_operations
              SET production_prior_state = $3::jsonb,
                  production_rollout_cohort = $4::jsonb
            WHERE id = $1 AND workspace_id = $2
              AND status IN ('authorized', 'leased', 'dispatched', 'outcome_unknown')
              AND (
                (production_prior_state IS NULL AND production_rollout_cohort IS NULL)
                OR (production_prior_state = $3::jsonb AND production_rollout_cohort = $4::jsonb)
              )
           RETURNING id`,
          [
            claimed.ticket.operationId,
            claimed.ticket.workspaceId,
            JSON.stringify(priorState),
            JSON.stringify(claimed.releaseIntent.rolloutCohort),
          ],
        );
        if (updated.rowCount === 0) {
          throw new ConflictError('Production prior state or approved cohort changed before dispatch');
        }
      });
    } else {
      priorState = ProductionProviderStateSchema.parse(
        typeof checkpoint.production_prior_state === 'string'
          ? JSON.parse(checkpoint.production_prior_state) as unknown
          : checkpoint.production_prior_state,
      );
      const storedCohort = ReleaseRolloutCohortSchema.parse(
        typeof checkpoint.production_rollout_cohort === 'string'
          ? JSON.parse(checkpoint.production_rollout_cohort) as unknown
          : checkpoint.production_rollout_cohort,
      );
      if (priorState.authorityBindingGeneration !== binding.bindingGeneration
        || !productionCohortsMatch(storedCohort, claimed.releaseIntent.rolloutCohort)) {
        throw new ConflictError('Production dispatch checkpoint differs from exact authorization');
      }
    }

    const requestedSeconds = input.requestedLeaseSeconds
      ?? binding.capabilityPolicy.maxLeaseSeconds;
    if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds < 30) {
      throw new ValidationError('requestedLeaseSeconds must be an integer of at least 30 seconds');
    }
    const verifiedProfile = binding.verifiedProfile;
    if (verifiedProfile === null) {
      throw new CoolifyBindingValidationError('stale', 'Production binding lost its verified profile');
    }
    const issuedAt = this.providerDependencies.now();
    const profileLifetimeSeconds = Math.floor(
      (Date.parse(verifiedProfile.expiresAt) - issuedAt.getTime()) / 1000,
    );
    const leaseSeconds = Math.min(
      requestedSeconds,
      binding.capabilityPolicy.maxLeaseSeconds,
      profileLifetimeSeconds,
    );
    if (leaseSeconds < 30) {
      throw new CoolifyBindingValidationError(
        'stale',
        'Production verified profile cannot bound the authorized lease',
      );
    }
    const expiresAt = new Date(issuedAt.getTime() + leaseSeconds * 1000);
    const lease = await canonicalTransaction(async (client) => {
      const authority = await client.query<{ status: string }>(
        `SELECT status
           FROM rorca.authority_production_authorizations
          WHERE id = $1 AND operation_id = $2 AND workspace_id = $3
            AND binding_id = $4 AND binding_generation = $5
          FOR UPDATE`,
        [
          claimed.ticket.authorizationId,
          claimed.ticket.operationId,
          claimed.ticket.workspaceId,
          claimed.ticket.bindingId,
          claimed.ticket.bindingGeneration,
        ],
      );
      if (!authority.rows[0]
        || !['dispatch_claimed', 'dispatched'].includes(authority.rows[0].status)) {
        throw new ForbiddenError('Production dispatch authorization has not been claimed');
      }
      const existing = await client.query<{
        id: string;
        status: string;
        provider_deployment_id: string | null;
        updated_at: Date | string;
        expires_at: Date | string;
      }>(
        `SELECT id, status, provider_deployment_id, updated_at, expires_at
           FROM rorca.authority_capability_leases
          WHERE binding_id = $1 AND operation_id = $2 AND capability = 'deploy.production'
          FOR UPDATE`,
        [binding.bindingId, claimed.ticket.operationId],
      );
      if (existing.rows[0]) return existing.rows[0];

      const leaseId = crypto.randomUUID();
      const inserted = await client.query<{
        id: string;
        status: string;
        provider_deployment_id: string | null;
        updated_at: Date | string;
        expires_at: Date | string;
      }>(
        `INSERT INTO rorca.authority_capability_leases
          (id, binding_id, binding_generation, capability, operation_id,
           status, issued_at, expires_at)
         VALUES ($1, $2, $3, 'deploy.production', $4, 'leased', $5, $6)
         RETURNING id, status, provider_deployment_id, updated_at, expires_at`,
        [
          leaseId,
          binding.bindingId,
          binding.bindingGeneration,
          claimed.ticket.operationId,
          issuedAt,
          expiresAt,
        ],
      );
      await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET lease_id = $2, status = 'leased'
          WHERE id = $1 AND workspace_id = $3 AND status = 'authorized'`,
        [claimed.ticket.operationId, leaseId, claimed.ticket.workspaceId],
      );
      return inserted.rows[0]!;
    });

    if (lease.provider_deployment_id) {
      const acceptedAt = claimed.existingAcceptance?.providerDeploymentId
        === lease.provider_deployment_id
        ? claimed.existingAcceptance.acceptedAt
        : new Date(lease.updated_at).toISOString();
      return ProductionCanaryAcceptanceSchema.parse({
        action: {
          actionId: claimed.ticket.operationId,
          phase: 'canary',
          leaseId: lease.id,
          providerDeploymentId: lease.provider_deployment_id,
          acceptedAt,
          cohort: claimed.releaseIntent.rolloutCohort,
          targetRevision,
        },
        priorState,
        target: productionTarget(binding),
      });
    }
    if (lease.status === 'outcome_unknown') {
      const reconciled = await lookupProductionAcceptance({
        binding,
        controlToken: resolved.controlToken,
        actionId: claimed.ticket.operationId,
        targetRevision,
        cohort: claimed.releaseIntent.rolloutCohort,
        dependencies: this.providerDependencies,
      });
      if (reconciled === null) {
        throw new UnprocessableError(
          'Production provider outcome remains unknown and blocks another action',
          'COOLIFY_PRODUCTION_OUTCOME_UNKNOWN',
        );
      }
      await canonicalTransaction(async (client) => {
        await client.query(
          `UPDATE rorca.authority_capability_leases
              SET status = 'dispatched', provider_deployment_id = $2, updated_at = $3
            WHERE id = $1 AND status = 'outcome_unknown' AND provider_deployment_id IS NULL`,
          [lease.id, reconciled.providerDeploymentId, reconciled.acceptedAt],
        );
        await client.query(
          `UPDATE rorca.authority_deployment_operations
              SET status = 'dispatched', provider_deployment_id = $2,
                  provider_accepted_at = $3
            WHERE id = $1 AND workspace_id = $4 AND status = 'outcome_unknown'
              AND provider_deployment_id IS NULL`,
          [
            claimed.ticket.operationId,
            reconciled.providerDeploymentId,
            reconciled.acceptedAt,
            claimed.ticket.workspaceId,
          ],
        );
      });
      return ProductionCanaryAcceptanceSchema.parse({
        action: {
          actionId: claimed.ticket.operationId,
          phase: 'canary',
          leaseId: lease.id,
          ...reconciled,
          cohort: claimed.releaseIntent.rolloutCohort,
          targetRevision,
        },
        priorState,
        target: productionTarget(binding),
      });
    }
    if (lease.status !== 'leased' || Date.parse(String(lease.expires_at)) <= issuedAt.getTime()) {
      throw new UnprocessableError(
        'Production provider outcome requires reconciliation and cannot be dispatched again',
        'COOLIFY_PRODUCTION_OUTCOME_UNKNOWN',
      );
    }

    const payload = buildCoolifyProductionDeploymentPayload(binding, claimed.releaseIntent);
    await canonicalTransaction(async (client) => {
      await client.query(
        `UPDATE rorca.authority_capability_leases
            SET status = 'dispatched', updated_at = NOW()
          WHERE id = $1 AND status = 'leased'`,
        [lease.id],
      );
      await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET status = 'dispatched'
          WHERE id = $1 AND workspace_id = $2 AND status = 'leased'`,
        [claimed.ticket.operationId, claimed.ticket.workspaceId],
      );
    });

    try {
      const responseBody = await providerMutationJson(
        binding.baseUrl,
        '/api/v1/deploy',
        resolved.controlToken,
        payload,
        claimed.ticket.operationId,
        this.providerDependencies,
      );
      const { providerDeploymentId } = productionAcceptanceRecord({
        value: responseBody,
        binding,
        targetRevision,
        cohort: claimed.releaseIntent.rolloutCohort,
        controlToken: resolved.controlToken,
      });
      const acceptedAt = this.providerDependencies.now();
      await canonicalTransaction(async (client) => {
        await client.query(
          `UPDATE rorca.authority_capability_leases
              SET status = 'dispatched', provider_deployment_id = $2, updated_at = $3
            WHERE id = $1 AND status IN ('dispatched', 'outcome_unknown')
              AND (provider_deployment_id IS NULL OR provider_deployment_id = $2)`,
          [lease.id, providerDeploymentId, acceptedAt],
        );

        await client.query(
          `UPDATE rorca.authority_deployment_operations
              SET status = 'dispatched', provider_deployment_id = $2,
                  provider_accepted_at = $3
            WHERE id = $1 AND workspace_id = $4
              AND (provider_deployment_id IS NULL OR provider_deployment_id = $2)`,
          [
            claimed.ticket.operationId,
            providerDeploymentId,
            acceptedAt,
            claimed.ticket.workspaceId,
          ],
        );
      });
      return ProductionCanaryAcceptanceSchema.parse({
        action: {
          actionId: claimed.ticket.operationId,
          phase: 'canary',
          leaseId: lease.id,
          providerDeploymentId,
          acceptedAt: acceptedAt.toISOString(),
          cohort: claimed.releaseIntent.rolloutCohort,
          targetRevision,
        },
        priorState,
        target: productionTarget(binding),
      });
    } catch (error) {
      await canonicalTransaction(async (client) => {
        await client.query(
          `UPDATE rorca.authority_capability_leases
              SET status = 'outcome_unknown', updated_at = NOW()
            WHERE id = $1 AND status = 'dispatched' AND provider_deployment_id IS NULL`,
          [lease.id],
        );
        await client.query(
          `UPDATE rorca.authority_deployment_operations
              SET status = 'outcome_unknown'
            WHERE id = $1 AND workspace_id = $2
              AND status = 'dispatched' AND provider_deployment_id IS NULL`,
          [claimed.ticket.operationId, claimed.ticket.workspaceId],
        );
      });
      throw error;
    }
  }
  async observeProductionAction(input: {
    authority: ProductionRolloutAuthority;
    action: ProductionActionAcceptance;
    releaseIntent: ReleaseIntent;
  }): Promise<ProductionActionObservation> {
    const authority = ProductionRolloutAuthoritySchema.parse(input.authority);
    const action = ProductionActionAcceptanceSchema.parse(input.action);
    const releaseIntent = ReleaseIntentSchema.parse(input.releaseIntent);
    const context = await this.resolveProductionActionContext(
      authority,
      action.actionId,
      action.phase,
    );
    if (context.providerDeploymentId !== action.providerDeploymentId
      || context.leaseId !== action.leaseId
      || JSON.stringify(context.targetRevision) !== JSON.stringify(action.targetRevision)
      || !productionCohortsMatch(context.cohort, action.cohort)
      || !productionCohortsMatch(action.cohort, releaseIntent.rolloutCohort)) {
      throw new ConflictError('Production observation action differs from persisted rollout authority');
    }

    const [deploymentResult, applicationResult] = await Promise.all([
      providerJson(
        context.binding.baseUrl,
        `/api/v1/deployments/${encodeURIComponent(action.providerDeploymentId)}`,
        context.controlToken,
        this.providerDependencies,
      ),
      providerJson(
        context.binding.baseUrl,
        `/api/v1/applications/${context.binding.target.applicationUuid}`,
        context.controlToken,
        this.providerDependencies,
      ),
    ]);
    const deployment = deploymentRecord(deploymentResult.body);
    const application = exactObject(applicationResult.body, 'application');
    exactUuid(application.uuid, context.binding.target.applicationUuid, 'application');
    exactUuid(
      deployment.resource_uuid ?? deployment.resourceUuid
        ?? deployment.application_uuid ?? deployment.applicationUuid,
      context.binding.target.applicationUuid,
      'deployment application',
    );
    requireProductionRevision(deployment, action.targetRevision, 'deployment observation');
    requireProductionCohort(deployment, action.cohort);

    const providerStatus = String(deployment.status ?? '').trim().toLowerCase();
    if (!providerStatus) {
      throw new CoolifyBindingValidationError(
        'not_resolvable',
        'Coolify production deployment status is not resolvable',
      );
    }
    if (publicValueContainsCredential(context.controlToken, [providerStatus])) {
      throw new CoolifyBindingValidationError(
        'not_resolvable',
        'Coolify returned unsafe production health evidence',
      );
    }
    const observedAt = this.providerDependencies.now().toISOString();
    const metrics = {
      ...jsonObject(application.metrics),
      ...jsonObject(deployment.metrics),
    };
    const samples = releaseIntent.healthSignals.flatMap((signal) =>
      productionHealthSamples({
        signal,
        source: signal.source === 'deployment'
          ? deployment
          : signal.source === 'application'
            ? application
            : metrics,
        observedAt,
      }));
    const providerOutcome = FAILED_DEPLOYMENT_STATUS[providerStatus]
      ? 'unhealthy'
      : SUCCESSFUL_DEPLOYMENT_STATUS[providerStatus] ? 'healthy' : 'pending';
    return ProductionActionObservationSchema.parse({
      actionId: action.actionId,
      phase: action.phase,
      evidence: {
        schemaVersion: PRODUCTION_HEALTH_EVIDENCE_VERSION,
        providerDeploymentId: action.providerDeploymentId,
        rolloutCohort: action.cohort,
        revision: action.targetRevision,
        providerStatus,
        providerOutcome,
        samples,
        observedAt,
      },
    });
  }

  async dispatchProductionAction(input: {
    authority: ProductionRolloutAuthority;
    actionId: string;
    phase: 'expansion' | 'rollback';
    releaseIntent: ReleaseIntent;
    priorState: ProductionProviderState;
  }): Promise<ProductionActionAcceptance> {
    const authority = ProductionRolloutAuthoritySchema.parse(input.authority);
    const actionId = UUID.parse(input.actionId);
    const phase = z.enum(['expansion', 'rollback']).parse(input.phase);
    const releaseIntent = ReleaseIntentSchema.parse(input.releaseIntent);
    const priorState = ProductionProviderStateSchema.parse(input.priorState);
    const targetRevision = phase === 'rollback'
      ? priorState.revision
      : releaseRevision(releaseIntent);
    const initialContext = await this.resolveProductionActionContext(authority, actionId, phase);
    if (JSON.stringify(initialContext.targetRevision) !== JSON.stringify(targetRevision)
      || !productionCohortsMatch(initialContext.cohort, releaseIntent.rolloutCohort)
      || priorState.authorityBindingGeneration !== authority.bindingGeneration) {
      throw new ConflictError('Production action differs from exact release or rollback authority');
    }
    if (initialContext.providerDeploymentId !== null
      && initialContext.leaseId !== null
      && initialContext.providerAcceptedAt !== null) {
      return ProductionActionAcceptanceSchema.parse({
        actionId,
        phase,
        leaseId: initialContext.leaseId,
        providerDeploymentId: initialContext.providerDeploymentId,
        acceptedAt: initialContext.providerAcceptedAt,
        cohort: initialContext.cohort,
        targetRevision,
      });
    }
    if (initialContext.status === 'outcome_unknown') {
      const reconciled = await this.reconcileProductionAction({
        authority,
        actionId,
        phase,
        releaseIntent,
        priorState,
      });
      if (reconciled !== null) return reconciled;
      throw new UnprocessableError(
        'Production action outcome remains unknown and blocks another provider mutation',
        'COOLIFY_PRODUCTION_OUTCOME_UNKNOWN',
      );
    }
    if (initialContext.status !== 'prepared' || initialContext.leaseId !== null) {
      throw new ConflictError('Production action is not dispatchable from its persisted checkpoint');
    }

    const binding = initialContext.binding;
    const verifiedProfile = binding.verifiedProfile;
    if (verifiedProfile === null) {
      throw new CoolifyBindingValidationError('stale', 'Production binding lost its verified profile');
    }
    const issuedAt = this.providerDependencies.now();
    const leaseSeconds = Math.min(
      binding.capabilityPolicy.maxLeaseSeconds,
      Math.floor((Date.parse(verifiedProfile.expiresAt) - issuedAt.getTime()) / 1000),
    );
    if (leaseSeconds < 30) {
      throw new CoolifyBindingValidationError(
        'stale',
        'Production verified profile cannot fence the rollout action',
      );
    }
    const leaseId = crypto.randomUUID();
    await canonicalTransaction(async (client) => {
      const action = await client.query<{ status: string }>(
        `SELECT status
           FROM rorca.authority_production_rollout_actions
          WHERE id = $1 AND rollout_operation_id = $2 AND phase = $3
          FOR UPDATE`,
        [actionId, authority.operationId, phase],
      );
      if (action.rows[0]?.status !== 'prepared') {
        throw new ConflictError('Production action was claimed by another reconciler');
      }
      await client.query(
        `INSERT INTO rorca.authority_capability_leases
          (id, binding_id, binding_generation, capability, operation_id,
           status, issued_at, expires_at)
         VALUES ($1, $2, $3, 'deploy.production', $4, 'dispatched', $5, $6)`,
        [
          leaseId,
          binding.bindingId,
          binding.bindingGeneration,
          actionId,
          issuedAt,
          new Date(issuedAt.getTime() + leaseSeconds * 1000),
        ],
      );
      await client.query(
        `UPDATE rorca.authority_production_rollout_actions
            SET status = 'outcome_unknown', lease_id = $2, updated_at = NOW()
          WHERE id = $1 AND status = 'prepared'`,
        [actionId, leaseId],
      );
      await client.query(
        `UPDATE rorca.authority_production_rollouts
            SET status = 'reconciliation_required', updated_at = NOW()
          WHERE operation_id = $1 AND status <> 'settled'`,
        [authority.operationId],
      );
    });

    try {
      const responseBody = await providerMutationJson(
        binding.baseUrl,
        '/api/v1/deploy',
        initialContext.controlToken,
        productionActionPayload({ binding, releaseIntent, phase, priorState }),
        actionId,
        this.providerDependencies,
      );
      const { providerDeploymentId } = productionAcceptanceRecord({
        value: responseBody,
        binding,
        targetRevision,
        cohort: releaseIntent.rolloutCohort,
        controlToken: initialContext.controlToken,
      });
      const acceptance = ProductionActionAcceptanceSchema.parse({
        actionId,
        phase,
        leaseId,
        providerDeploymentId,
        acceptedAt: this.providerDependencies.now().toISOString(),
        cohort: releaseIntent.rolloutCohort,
        targetRevision,
      });
      await this.persistProductionActionAcceptance(authority, acceptance);
      return acceptance;
    } catch (error) {
      await canonicalTransaction(async (client) => {
        await client.query(
          `UPDATE rorca.authority_capability_leases
              SET status = 'outcome_unknown', updated_at = NOW()
            WHERE id = $1 AND provider_deployment_id IS NULL`,
          [leaseId],
        );
        await client.query(
          `UPDATE rorca.authority_production_rollout_actions
              SET status = 'outcome_unknown', updated_at = NOW()
            WHERE id = $1 AND provider_deployment_id IS NULL`,
          [actionId],
        );
      });
      throw error;
    }
  }

  async reconcileProductionAction(input: {
    authority: ProductionRolloutAuthority;
    actionId: string;
    phase: ProductionRolloutPhase;
    releaseIntent: ReleaseIntent;
    priorState: ProductionProviderState;
  }): Promise<ProductionActionAcceptance | null> {
    const authority = ProductionRolloutAuthoritySchema.parse(input.authority);
    const actionId = UUID.parse(input.actionId);
    const phase = ProductionRolloutPhaseSchema.parse(input.phase);
    const releaseIntent = ReleaseIntentSchema.parse(input.releaseIntent);
    const priorState = ProductionProviderStateSchema.parse(input.priorState);
    const context = await this.resolveProductionActionContext(authority, actionId, phase);
    const targetRevision = phase === 'rollback'
      ? priorState.revision
      : releaseRevision(releaseIntent);
    if (JSON.stringify(context.targetRevision) !== JSON.stringify(targetRevision)
      || !productionCohortsMatch(context.cohort, releaseIntent.rolloutCohort)) {
      throw new ConflictError('Production reconciliation differs from exact action authority');
    }
    if (context.providerDeploymentId !== null
      && context.leaseId !== null
      && context.providerAcceptedAt !== null) {
      return ProductionActionAcceptanceSchema.parse({
        actionId,
        phase,
        leaseId: context.leaseId,
        providerDeploymentId: context.providerDeploymentId,
        acceptedAt: context.providerAcceptedAt,
        cohort: context.cohort,
        targetRevision,
      });
    }
    if (context.status !== 'outcome_unknown' || context.leaseId === null) {
      throw new ConflictError('Production action has no unknown provider outcome to reconcile');
    }
    const reconciled = await lookupProductionAcceptance({
      binding: context.binding,
      controlToken: context.controlToken,
      actionId,
      targetRevision,
      cohort: context.cohort,
      dependencies: this.providerDependencies,
    });
    if (reconciled === null) return null;
    const acceptance = ProductionActionAcceptanceSchema.parse({
      actionId,
      phase,
      leaseId: context.leaseId,
      ...reconciled,
      cohort: context.cohort,
      targetRevision,
    });
    await this.persistProductionActionAcceptance(authority, acceptance);
    return acceptance;
  }

  async revokeProductionActionLease(input: {
    authority: ProductionRolloutAuthority;
    action: ProductionActionAcceptance;
  }): Promise<ProductionRevokedLease> {
    const authority = ProductionRolloutAuthoritySchema.parse(input.authority);
    const action = ProductionActionAcceptanceSchema.parse(input.action);
    const context = await this.resolveProductionActionContext(
      authority,
      action.actionId,
      action.phase,
    );
    if (context.leaseId !== action.leaseId
      || context.providerDeploymentId !== action.providerDeploymentId) {
      throw new ConflictError('Production lease revocation differs from exact action lineage');
    }
    const revokedAt = await canonicalTransaction(async (client) => {
      const lease = await client.query<{ status: string; updated_at: Date | string }>(
        `SELECT status, updated_at
           FROM rorca.authority_capability_leases
          WHERE id = $1 AND binding_id = $2 AND operation_id = $3
            AND capability = 'deploy.production'
            AND provider_deployment_id = $4
          FOR UPDATE`,
        [
          action.leaseId,
          authority.bindingId,
          action.actionId,
          action.providerDeploymentId,
        ],
      );
      const row = lease.rows[0];
      if (!row) throw new NotFoundError('Production action lease not found');
      if (row.status === 'revoked') return new Date(row.updated_at).toISOString();
      if (!['dispatched', 'outcome_unknown', 'settled'].includes(row.status)) {
        throw new ConflictError('Production action lease cannot be revoked from its current state');
      }
      const timestamp = this.providerDependencies.now();
      await client.query(
        `UPDATE rorca.authority_capability_leases
            SET status = 'revoked', updated_at = $2
          WHERE id = $1`,
        [action.leaseId, timestamp],
      );
      return timestamp.toISOString();
    });
    return ProductionRevokedLeaseSchema.parse({
      actionId: action.actionId,
      phase: action.phase,
      leaseId: action.leaseId,
      providerDeploymentId: action.providerDeploymentId,
      revokedAt,
    });
  }

  private async resolveProductionActionContext(
    rawAuthority: ProductionRolloutAuthority,
    rawActionId: string,
    rawPhase: ProductionRolloutPhase,
  ): Promise<{
    binding: CoolifyProviderBinding;
    controlToken: string;
    status: string;
    targetRevision: ProductionRevision;
    cohort: ReleaseIntent['rolloutCohort'];
    leaseId: string | null;
    providerDeploymentId: string | null;
    providerAcceptedAt: string | null;
  }> {
    const authority = ProductionRolloutAuthoritySchema.parse(rawAuthority);
    const actionId = UUID.parse(rawActionId);
    const phase = ProductionRolloutPhaseSchema.parse(rawPhase);
    const row = await queryOne<{
      status: string;
      target_revision: unknown;
      cohort: unknown;
      lease_id: string | null;
      provider_deployment_id: string | null;
      provider_accepted_at: Date | string | null;
    }>(
      `SELECT a.status, a.target_revision, a.cohort, a.lease_id,
              a.provider_deployment_id, a.provider_accepted_at
         FROM rorca.authority_production_rollout_actions a
         JOIN rorca.authority_production_rollouts r
           ON r.operation_id = a.rollout_operation_id
        WHERE a.id = $1 AND a.phase = $2
          AND r.operation_id = $3 AND r.workspace_id = $4
          AND r.authorization_id = $5 AND r.binding_id = $6
          AND r.binding_generation = $7 AND r.operation_intent_id = $8
          AND r.intent_digest = $9 AND r.ci_evidence_digest = $10
          AND r.grant_id = $11
          AND r.external_gate_evidence_id IS NOT DISTINCT FROM $12
          AND r.authorized_at = $13`,
      [
        actionId, phase, authority.operationId, authority.workspaceId,
        authority.authorizationId, authority.bindingId, authority.bindingGeneration,
        authority.operationIntentId, authority.intentDigest, authority.ciEvidenceDigest,
        authority.grantId, authority.gateEvidenceId, authority.authorizedAt,
      ],
    );
    if (!row) throw new ForbiddenError('Production action authority is missing or differs from exact rollout');
    const unresolvedBinding = await readCoolifyBinding(
      authority.workspaceId,
      { bindingId: authority.bindingId },
    );
    if (!unresolvedBinding) throw new NotFoundError('Production provider binding not found');
    const resolved = await this.revalidateAndResolveControlToken(
      requireProductionBinding(unresolvedBinding),
    );
    const binding = requireProductionBinding(resolved.binding);
    if (binding.bindingGeneration !== authority.bindingGeneration) {
      throw new CoolifyBindingValidationError(
        'stale',
        'Production binding generation changed during rollout reconciliation',
      );
    }
    return {
      binding,
      controlToken: resolved.controlToken,
      status: row.status,
      targetRevision: ProductionRevisionSchema.parse(
        typeof row.target_revision === 'string'
          ? JSON.parse(row.target_revision) as unknown
          : row.target_revision,
      ),
      cohort: ReleaseRolloutCohortSchema.parse(
        typeof row.cohort === 'string' ? JSON.parse(row.cohort) as unknown : row.cohort,
      ),
      leaseId: row.lease_id,
      providerDeploymentId: row.provider_deployment_id,
      providerAcceptedAt: row.provider_accepted_at === null
        ? null
        : new Date(row.provider_accepted_at).toISOString(),
    };
  }

  private async persistProductionActionAcceptance(
    authority: ProductionRolloutAuthority,
    rawAcceptance: ProductionActionAcceptance,
  ): Promise<void> {
    const acceptance = ProductionActionAcceptanceSchema.parse(rawAcceptance);
    await canonicalTransaction(async (client) => {
      const lease = await client.query(
        `UPDATE rorca.authority_capability_leases
            SET status = 'dispatched', provider_deployment_id = $2, updated_at = $3
          WHERE id = $1 AND binding_id = $4 AND operation_id = $5
            AND status IN ('dispatched', 'outcome_unknown')
            AND (provider_deployment_id IS NULL OR provider_deployment_id = $2)
         RETURNING id`,
        [
          acceptance.leaseId, acceptance.providerDeploymentId, acceptance.acceptedAt,
          authority.bindingId, acceptance.actionId,
        ],
      );
      if (lease.rowCount === 0) {
        throw new ConflictError('Production provider acceptance has no exact fenced lease');
      }
      const action = await client.query(
        `UPDATE rorca.authority_production_rollout_actions
            SET status = 'dispatched', lease_id = $4,
                provider_deployment_id = $5, provider_accepted_at = $6,
                updated_at = NOW()
          WHERE id = $1 AND rollout_operation_id = $2 AND phase = $3
            AND target_revision = $7::jsonb AND cohort = $8::jsonb
            AND status IN ('outcome_unknown', 'dispatched')
            AND (provider_deployment_id IS NULL OR provider_deployment_id = $5)
         RETURNING id`,
        [
          acceptance.actionId, authority.operationId, acceptance.phase,
          acceptance.leaseId, acceptance.providerDeploymentId, acceptance.acceptedAt,
          JSON.stringify(acceptance.targetRevision), JSON.stringify(acceptance.cohort),
        ],
      );
      if (action.rowCount === 0) {
        throw new ConflictError('Production provider acceptance differs from persisted action');
      }
      await client.query(
        `UPDATE rorca.authority_production_rollouts
            SET status = $2, updated_at = NOW()
          WHERE operation_id = $1 AND status <> 'settled'`,
        [
          authority.operationId,
          acceptance.phase === 'expansion' ? 'expansion_dispatched'
            : acceptance.phase === 'rollback' ? 'rollback_dispatched' : 'canary_dispatched',
        ],
      );
    });
  }

  async observeDeployment(input: {
    binding: ProviderBinding;
    providerDeploymentId: string;
    revision: StagingDeploymentRevision;
    configurationBindingGeneration: number;
    healthSignals: readonly DeclaredDeploymentHealthSignal[];
  }): Promise<ProviderDeploymentObservation> {
    const binding = requireStagingBinding(input.binding);
    const revision = StagingDeploymentRevisionSchema.parse(input.revision);
    const providerDeploymentId = z.string().min(1).max(255).parse(input.providerDeploymentId);
    const controlToken = await resolveControlToken(binding);
    const [deploymentResult, applicationResult] = await Promise.all([
      providerJson(
        binding.baseUrl,
        `/api/v1/deployments/${encodeURIComponent(providerDeploymentId)}`,
        controlToken,
        this.providerDependencies,
      ),
      providerJson(
        binding.baseUrl,
        `/api/v1/applications/${binding.target.applicationUuid}`,
        controlToken,
        this.providerDependencies,
      ),
    ]);
    const deployment = deploymentRecord(deploymentResult.body);
    const application = exactObject(applicationResult.body, 'application');
    exactUuid(application.uuid, binding.target.applicationUuid, 'application');
    exactUuid(
      deployment.resource_uuid
        ?? deployment.resourceUuid
        ?? deployment.application_uuid
        ?? deployment.applicationUuid,
      binding.target.applicationUuid,
      'deployment application',
    );
    if (revision.sourceRevision !== null
      && String(deployment.commit_sha ?? deployment.commit ?? deployment.source_revision ?? '').toLowerCase()
        !== revision.sourceRevision) {
      throw new CoolifyBindingValidationError('stale', 'Coolify deployment revision differs from the approved revision');
    }
    if (revision.imageDigest !== null
      && String(deployment.image_digest ?? deployment.imageDigest ?? '').toLowerCase() !== revision.imageDigest) {
      throw new CoolifyBindingValidationError('stale', 'Coolify deployment image differs from the approved digest');
    }
    if (Number(deployment.configuration_binding_generation ?? deployment.configurationBindingGeneration)
      !== input.configurationBindingGeneration) {
      throw new CoolifyBindingValidationError(
        'stale',
        'Coolify deployment configuration generation differs from the approved generation',
      );
    }

    const providerStatus = String(deployment.status ?? '').trim().toLowerCase();
    if (!providerStatus) {
      throw new CoolifyBindingValidationError('not_resolvable', 'Coolify deployment status is not resolvable');
    }
    const signals = input.healthSignals.map((signal) => {
      const source = signal.source === 'deployment' ? deployment : application;
      const rawValue = source[signal.field];
      const actualValue = rawValue === null || rawValue === undefined ? null : String(rawValue);
      return {
        ...signal,
        actualValue,
        passed: actualValue === signal.expectedValue,
      };
    });
    if (publicValueContainsCredential(controlToken, [
      providerDeploymentId,
      providerStatus,
      ...signals.map((signal) => signal.actualValue),
    ])) {
      throw new CoolifyBindingValidationError(
        'not_resolvable',
        'Coolify returned unsafe deployment health evidence',
      );
    }
    const outcome = FAILED_DEPLOYMENT_STATUS[providerStatus]
      ? 'unhealthy'
      : SUCCESSFUL_DEPLOYMENT_STATUS[providerStatus]
        ? signals.every((signal) => signal.passed) ? 'healthy' : 'unhealthy'
        : 'pending';
    return ProviderDeploymentObservationSchema.parse({
      providerDeploymentId,
      providerStatus,
      outcome,
      signals,
      observedAt: this.providerDependencies.now().toISOString(),
    });
  }

  async revokeLease(input: {
    workspaceId: string;
    leaseId: string;
    providerDeploymentId: string;
  }): Promise<{ revokedAt: string }> {
    const leaseId = UUID.parse(input.leaseId);
    return canonicalTransaction(async (client) => {
      const existing = await client.query<{
        status: string; provider_deployment_id: string | null; updated_at: Date | string;
      }>(
        `SELECT l.status, l.provider_deployment_id, l.updated_at
           FROM rorca.authority_capability_leases l
           JOIN rorca.deployment_provider_bindings b ON b.id = l.binding_id
          WHERE l.id = $1 AND b.workspace_id = $2 AND b.environment_kind = 'staging'
          FOR UPDATE OF l`,
        [leaseId, input.workspaceId],
      );
      const row = existing.rows[0];
      if (!row) throw new NotFoundError('Active staging capability lease not found');
      if (row.provider_deployment_id !== null
        && row.provider_deployment_id !== input.providerDeploymentId) {
        throw new ConflictError('Staging capability lease belongs to a different provider deployment');
      }
      if (row.status === 'revoked') {
        return { revokedAt: new Date(row.updated_at).toISOString() };
      }
      if (!['leased', 'dispatched', 'outcome_unknown'].includes(row.status)) {
        throw new NotFoundError('Active staging capability lease not found');
      }
      const revokedAt = this.providerDependencies.now();
      await client.query(
        `UPDATE rorca.authority_capability_leases
            SET status = 'revoked', provider_deployment_id = $2, updated_at = $3
          WHERE id = $1`,
        [leaseId, input.providerDeploymentId, revokedAt],
      );
      return { revokedAt: revokedAt.toISOString() };
    });
  }

  async acquireLease(input: {
    workspaceId: string;
    bindingId: string;
    bindingGeneration: number;
    action: DeploymentCapability;
    operationId: string;
    requestedSeconds?: number;
  }): Promise<CoolifyLeaseProjection> {
    UUID.parse(input.operationId);
    if (input.action === 'deploy.production') {
      throw new ForbiddenError(
        'Production leases require verified authorization and an open change window',
      );
    }
    const binding = await this.preflight(input);
    if (binding.verifiedProfile === null) {
      throw new CoolifyBindingValidationError('stale', 'Coolify binding did not retain a verified profile');
    }
    const requestedSeconds = input.requestedSeconds ?? binding.capabilityPolicy.maxLeaseSeconds;
    if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds < 30) {
      throw new ValidationError('requestedSeconds must be an integer of at least 30 seconds');
    }
    const issuedAt = this.providerDependencies.now();
    const profileLifetimeSeconds = Math.floor(
      (Date.parse(binding.verifiedProfile.expiresAt) - issuedAt.getTime()) / 1000,
    );
    const leaseSeconds = Math.min(
      requestedSeconds,
      binding.capabilityPolicy.maxLeaseSeconds,
      profileLifetimeSeconds,
    );
    if (leaseSeconds < 30) {
      throw new CoolifyBindingValidationError('stale', 'Coolify verified profile cannot bound the requested lease');
    }
    const leaseId = crypto.randomUUID();
    const expiresAt = new Date(issuedAt.getTime() + leaseSeconds * 1000);
    try {
      return await canonicalTransaction(async (client) => {
        const result = await client.query<{
          id: string; binding_id: string; binding_generation: number | string; capability: DeploymentCapability;
          operation_id: string; status: 'leased'; issued_at: string; expires_at: string;
        }>(
          `INSERT INTO rorca.authority_capability_leases
            (id, binding_id, binding_generation, capability, operation_id, status, issued_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'leased', $6, $7)
           RETURNING id, binding_id, binding_generation, capability, operation_id, status, issued_at, expires_at`,
          [leaseId, binding.bindingId, binding.bindingGeneration, input.action, input.operationId, issuedAt, expiresAt],
        );
        const row = result.rows[0]!;
        return {
          leaseId: row.id,
          bindingId: row.binding_id,
          bindingGeneration: Number(row.binding_generation),
          capability: row.capability,
          operationId: row.operation_id,
          status: row.status,
          issuedAt: new Date(row.issued_at).toISOString(),
          expiresAt: new Date(row.expires_at).toISOString(),
        };
      });
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === '23505') {
        throw new ConflictError('A capability lease already exists for this binding operation');
      }
      if (code === '55000') {
        throw new CoolifyBindingValidationError('stale', 'Coolify binding changed before the lease could be fenced');
      }
      if (code === '42501') {
        throw new CoolifyBindingValidationError('permission_deficient', 'Coolify capability policy denied the lease');
      }
      throw error;
    }
  }

  async disableProviderBinding(workspaceId: string, bindingId: string, reason: string): Promise<{
    binding: CoolifyProviderBinding;
    revoked: number;
    revocationRequired: number;
    reconciliationRequired: number;
  }> {
    if (!reason.trim() || reason.length > 500) throw new ValidationError('Disable reason must contain 1 to 500 characters');
    return canonicalTransaction(async (client) => {
      const before = await client.query<{ status: string }>(
        `SELECT status FROM rorca.deployment_provider_bindings
          WHERE id = $1 AND workspace_id = $2 AND provider_id = 'coolify' FOR UPDATE`,
        [bindingId, workspaceId],
      );
      if (!before.rows[0]) throw new NotFoundError('Provider binding not found');
      let revoked = 0;
      let revocationRequired = 0;
      let reconciliationRequired = 0;
      if (before.rows[0].status === 'active') {
        const activeAttempts = await client.query<{ status: 'leased' | 'dispatched' | 'outcome_unknown' }>(
          `SELECT status FROM rorca.authority_capability_leases
            WHERE binding_id = $1 AND status IN ('leased', 'dispatched', 'outcome_unknown')
            FOR UPDATE`,
          [bindingId],
        );
        for (const attempt of activeAttempts.rows) {
          if (attempt.status === 'leased') revoked += 1;
          else if (attempt.status === 'dispatched') revocationRequired += 1;
          else reconciliationRequired += 1;
        }
      }
      const result = await client.query<BindingRow>(
        `UPDATE rorca.deployment_provider_bindings
            SET status = 'disabled', disabled_reason = $3
          WHERE id = $1 AND workspace_id = $2
          RETURNING ${BINDING_COLUMNS}`,
        [bindingId, workspaceId, reason.trim()],
      );
      return {
        binding: mapBinding(result.rows[0]!),
        revoked,
        revocationRequired,
        reconciliationRequired,
      };
    });
  }
}
