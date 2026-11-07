/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import { transaction } from '../db/index';
import {
  createOperationIntent,
  getProviderBindingByReference,
  type AuthorityGrantRecord,
  type AuthorityJson,
  type AuthorityRequestRecord,
  type OperationIntentRecord,
  type ProviderBindingRecord,
} from '../db/execution-authority';
import {
  createAuthorityPreflightRequirement,
  createAuthorityRunPreflight,
  getActiveAuthorityRunPreflight,
  getCompletedRunStoryIds,
  getLatestAuthorityProviderBinding,
  getPreflightAuthorityGrant,
  getPreflightAuthorityRequest,
  invalidateAuthorityRunPreflight,
  listAuthorityPreflightRequirements,
  setRunAuthorityPreflightState,
  updateAuthorityPreflightRequirement,
  updateAuthorityRunPreflight,
  type AuthorityBindingHealth,
  type AuthorityChangeWindow,
  type AuthorityCredentialMintability,
  type AuthorityPreflightRequirementRecord,
  type AuthorityRequirementOutcome,
  type AuthorityRunPreflightRecord,
  type AuthorityRunWaitState,
} from '../db/execution-authority-preflight';
import { ConflictError, ServiceUnavailableError, ValidationError } from './errors';
import {
  authorityDigest,
  createPolicyAuthorityRequest,
  type AuthorityRequestProjection,
} from './execution-authority-policy';
import {
  REQUIRED_CAPABILITY_SET_SCHEMA_VERSION,
  RequiredCapabilityDeclarationSchema,
  parseRequiredCapabilityDeclarations,
  type RequiredCapabilityDeclaration,
} from './required-capability';

export const EXECUTION_AUTHORITY_PREFLIGHT_ADAPTER_VERSION = 'rorca.execution-authority-preflight-adapter.v1' as const;
export const DEFAULT_AUTHORITY_WAIT_TTL_MS = 24 * 60 * 60 * 1000;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const AdapterAssessmentSchema = z.object({
  bindingHealth: z.enum(['healthy', 'unhealthy']),
  credentialMintability: z.enum(['mintable', 'authentication_required', 'unavailable']),
  changeWindow: z.enum(['open', 'closed']),
}).strict();

export interface AuthorityCapabilityDescription {
  capabilityId: string;
  requestedModes: readonly string[];
}

export interface AuthorityPreflightAdapterInput {
  workspaceId: string;
  storyId: string;
  declaration: RequiredCapabilityDeclaration;
  binding: ProviderBindingRecord;
}

export interface AuthorityPreflightAdapterAssessment {
  bindingHealth: AuthorityBindingHealth;
  credentialMintability: AuthorityCredentialMintability;
  changeWindow: AuthorityChangeWindow;
}

export interface ExecutionAuthorityPreflightAdapter {
  readonly contractVersion: typeof EXECUTION_AUTHORITY_PREFLIGHT_ADAPTER_VERSION;
  readonly adapterId: string;
  readonly policyRevision: string;
  describeCapabilities(): readonly AuthorityCapabilityDescription[];
  validatePreflight(input: AuthorityPreflightAdapterInput): Promise<AuthorityPreflightAdapterAssessment>;
}

interface RegisteredCapability {
  adapter: ExecutionAuthorityPreflightAdapter;
  requestedModes: ReadonlySet<string>;
}

export class ExecutionAuthorityPreflightAdapterRegistry {
  private readonly capabilities = new Map<string, RegisteredCapability>();

  register(adapter: ExecutionAuthorityPreflightAdapter): () => void {
    if (adapter.contractVersion !== EXECUTION_AUTHORITY_PREFLIGHT_ADAPTER_VERSION) {
      throw new ValidationError(`Unsupported authority preflight adapter contract ${adapter.contractVersion}`);
    }
    if (!adapter.adapterId.trim() || !DIGEST_PATTERN.test(adapter.policyRevision)) {
      throw new ValidationError('Authority preflight adapter identity or policy revision is malformed');
    }
    const descriptions = adapter.describeCapabilities();
    if (descriptions.length === 0) throw new ValidationError('Authority preflight adapter must describe at least one capability');
    const pending: Array<{ capabilityId: string; requestedModes: ReadonlySet<string> }> = [];
    const pendingIds = new Set<string>();
    for (const description of descriptions) {
      if (description.requestedModes.length === 0) {
        throw new ValidationError(`Authority capability ${description.capabilityId} must allow at least one requested mode`);
      }
      const requestedModes = new Set<string>();
      let capabilityId: string | null = null;
      for (const requestedMode of description.requestedModes) {
        const parsed = RequiredCapabilityDeclarationSchema.safeParse({
          schemaVersion: 'rorca.required-capability.v1',
          capabilityId: description.capabilityId,
          bindingReference: 'registry-validation',
          bindingGeneration: 1,
          scope: { environment: 'registry', resource: 'registry' },
          requestedMode,
          evidenceRequirements: [],
          constraints: {},
        });
        if (!parsed.success) {
          throw new ValidationError(`Authority adapter ${adapter.adapterId} contains a malformed capability description`);
        }
        capabilityId = parsed.data.capabilityId;
        if (requestedModes.has(parsed.data.requestedMode)) {
          throw new ValidationError(`Authority capability ${capabilityId} contains duplicate requested modes`);
        }
        requestedModes.add(parsed.data.requestedMode);
      }
      if (!capabilityId) throw new ValidationError('Authority capability description is empty');
      if (pendingIds.has(capabilityId) || this.capabilities.has(capabilityId)) {
        throw new ConflictError(`Authority capability ${capabilityId} is already registered`);
      }
      pendingIds.add(capabilityId);
      pending.push({ capabilityId, requestedModes });
    }
    const registeredIds = pending.map(({ capabilityId, requestedModes }) => {
      this.capabilities.set(capabilityId, { adapter, requestedModes });
      return capabilityId;
    });
    return () => {
      for (const capabilityId of registeredIds) {
        const current = this.capabilities.get(capabilityId);
        if (current?.adapter === adapter) this.capabilities.delete(capabilityId);
      }
    };
  }

  resolve(capabilityId: string): RegisteredCapability | null {
    return this.capabilities.get(capabilityId) ?? null;
  }
}

export const executionAuthorityPreflightAdapters = new ExecutionAuthorityPreflightAdapterRegistry();

export interface RequiredCapabilityStory {
  id: string;
  excluded?: boolean;
  requiredCapabilities?: unknown;
}

export interface PreparedAuthorityRequirement {
  ordinal: number;
  storyId: string;
  declaration: RequiredCapabilityDeclaration;
  binding: ProviderBindingRecord;
  adapterId: string;
  adapterPolicyRevision: string;
  assessment: AuthorityPreflightAdapterAssessment;
  evidenceDigest: string;
  requirementDigest: string;
}

export interface PreparedAuthorityPreflight {
  schemaVersion: typeof REQUIRED_CAPABILITY_SET_SCHEMA_VERSION;
  workspaceId: string;
  specRevision: string;
  environment: string;
  policyRevision: string;
  preflightDigest: string;
  runnableStoryIds: string[];
  requirements: PreparedAuthorityRequirement[];
}

export interface AuthorityPreflightPreparationDependencies {
  getLatestBinding(workspaceId: string, bindingReference: string): Promise<ProviderBindingRecord | null>;
  getExactBinding(workspaceId: string, bindingReference: string, generation: number): Promise<ProviderBindingRecord | null>;
}

const DEFAULT_PREPARATION_DEPENDENCIES: AuthorityPreflightPreparationDependencies = {
  getLatestBinding: getLatestAuthorityProviderBinding,
  getExactBinding: getProviderBindingByReference,
};

function normalizedDeclaration(declaration: RequiredCapabilityDeclaration): RequiredCapabilityDeclaration {
  return {
    ...declaration,
    scope: { ...declaration.scope },
    evidenceRequirements: [...declaration.evidenceRequirements]
      .map((requirement) => ({ ...requirement }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    constraints: { ...declaration.constraints },
  };
}

function assertNoSecretMaterial(value: unknown, field: string, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new ValidationError(`${field} must not contain cyclic data`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${field}.${index}`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (/(^|[_-])(secret|credential|password|token|authorization|private[_-]?key)([_-]|$)/i.test(key)) {
        throw new ValidationError(`${field}.${key} is not permitted in an authority declaration`);
      }
      assertNoSecretMaterial(item, `${field}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export async function prepareExecutionAuthorityPreflight(input: {
  workspaceId: string;
  specRevision: string;
  environment: string;
  stories: readonly RequiredCapabilityStory[];
  specificStoryId?: string;
  registry?: ExecutionAuthorityPreflightAdapterRegistry;
  dependencies?: AuthorityPreflightPreparationDependencies;
}): Promise<PreparedAuthorityPreflight | null> {
  if (!DIGEST_PATTERN.test(input.specRevision)) throw new ValidationError('Authority preflight requires a canonical spec revision');
  const registry = input.registry ?? executionAuthorityPreflightAdapters;
  const dependencies = input.dependencies ?? DEFAULT_PREPARATION_DEPENDENCIES;
  const runnableStories = input.stories.filter((story) => (
    !story.excluded && (input.specificStoryId === undefined || story.id === input.specificStoryId)
  ));
  const compiled: Array<{ storyId: string; declaration: RequiredCapabilityDeclaration; registered: RegisteredCapability }> = [];

  for (const story of runnableStories) {
    if (typeof story.id !== 'string' || !story.id.trim()) throw new ValidationError('Runnable authority story requires an id');
    if (story.requiredCapabilities === undefined) continue;
    let declarations: RequiredCapabilityDeclaration[];
    try {
      declarations = parseRequiredCapabilityDeclarations(story.requiredCapabilities, `stories.${story.id}.requiredCapabilities`);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : 'Malformed required-capability declaration', {
        code: 'AUTHORITY_CAPABILITY_DECLARATION_INVALID', storyId: story.id,
      });
    }
    for (const rawDeclaration of declarations) {
      const declaration = normalizedDeclaration(rawDeclaration);
      assertNoSecretMaterial(declaration.constraints, `stories.${story.id}.requiredCapabilities.constraints`);
      if (declaration.scope.environment !== input.environment) {
        throw new ValidationError(
          `Capability ${declaration.capabilityId} environment ${declaration.scope.environment} does not match run environment ${input.environment}`,
          { code: 'AUTHORITY_SCOPE_ENVIRONMENT_MISMATCH', storyId: story.id },
        );
      }
      const registered = registry.resolve(declaration.capabilityId);
      if (!registered) {
        throw new ValidationError(`Unknown execution capability ${declaration.capabilityId}`, {
          code: 'AUTHORITY_CAPABILITY_UNKNOWN', storyId: story.id,
        });
      }
      if (!registered.requestedModes.has(declaration.requestedMode)) {
        throw new ValidationError(
          `Capability ${declaration.capabilityId} does not support requested mode ${declaration.requestedMode}`,
          { code: 'AUTHORITY_CAPABILITY_MODE_UNKNOWN', storyId: story.id },
        );
      }
      compiled.push({ storyId: story.id, declaration, registered });
    }
  }

  if (compiled.length === 0) return null;

  const requirements: PreparedAuthorityRequirement[] = [];
  const seenRequirements = new Set<string>();
  for (const item of compiled) {
    const latestBinding = await dependencies.getLatestBinding(input.workspaceId, item.declaration.bindingReference);
    if (!latestBinding) {
      throw new ValidationError(`Missing provider binding ${item.declaration.bindingReference}`, {
        code: 'AUTHORITY_BINDING_MISSING', storyId: item.storyId,
      });
    }
    if (latestBinding.generation !== item.declaration.bindingGeneration || latestBinding.status !== 'active') {
      throw new ConflictError(`Provider binding ${item.declaration.bindingReference} generation is stale`, {
        code: 'AUTHORITY_BINDING_STALE', expectedGeneration: latestBinding.generation,
        declaredGeneration: item.declaration.bindingGeneration,
      });
    }
    const binding = await dependencies.getExactBinding(
      input.workspaceId,
      item.declaration.bindingReference,
      item.declaration.bindingGeneration,
    );
    if (!binding) {
      throw new ConflictError(`Provider binding ${item.declaration.bindingReference} generation is stale`, {
        code: 'AUTHORITY_BINDING_STALE', declaredGeneration: item.declaration.bindingGeneration,
      });
    }
    if (binding.capabilityId !== item.declaration.capabilityId
      || binding.environment !== item.declaration.scope.environment
      || binding.providerResourceId !== item.declaration.scope.resource) {
      throw new ValidationError(`Provider binding ${item.declaration.bindingReference} does not match the declared capability scope`, {
        code: 'AUTHORITY_BINDING_SCOPE_MISMATCH', storyId: item.storyId,
      });
    }

    let assessment: AuthorityPreflightAdapterAssessment;
    try {
      assessment = AdapterAssessmentSchema.parse(await item.registered.adapter.validatePreflight({
        workspaceId: input.workspaceId,
        storyId: item.storyId,
        declaration: item.declaration,
        binding,
      }));
    } catch {
      throw new ServiceUnavailableError(
        `Authority adapter ${item.registered.adapter.adapterId} failed closed during preflight`,
      );
    }
    const evidenceDigest = authorityDigest('rorca.execution-authority.preflight-evidence.v1', item.declaration.evidenceRequirements);
    const requirementDigest = authorityDigest('rorca.execution-authority.preflight-requirement.v1', {
      storyId: item.storyId,
      declaration: item.declaration,
      bindingId: binding.id,
      adapterId: item.registered.adapter.adapterId,
      adapterPolicyRevision: item.registered.adapter.policyRevision,
      evidenceDigest,
    });
    if (seenRequirements.has(requirementDigest)) continue;
    seenRequirements.add(requirementDigest);
    requirements.push({
      ordinal: 0,
      storyId: item.storyId,
      declaration: item.declaration,
      binding,
      adapterId: item.registered.adapter.adapterId,
      adapterPolicyRevision: item.registered.adapter.policyRevision,
      assessment,
      evidenceDigest,
      requirementDigest,
    });
  }
  requirements.sort((left, right) => left.requirementDigest.localeCompare(right.requirementDigest));
  requirements.forEach((requirement, ordinal) => { requirement.ordinal = ordinal; });
  const policyRevision = authorityDigest('rorca.execution-authority.preflight-policy.v1', [...new Set(
    requirements.map((requirement) => `${requirement.adapterId}:${requirement.adapterPolicyRevision}`),
  )].sort());
  const preflightDigest = authorityDigest('rorca.execution-authority.preflight.v1', {
    schemaVersion: REQUIRED_CAPABILITY_SET_SCHEMA_VERSION,
    specRevision: input.specRevision,
    environment: input.environment,
    policyRevision,
    requirements: requirements.map((requirement) => ({
      storyId: requirement.storyId,
      requirementDigest: requirement.requirementDigest,
      bindingGeneration: requirement.declaration.bindingGeneration,
    })),
  });
  return {
    schemaVersion: REQUIRED_CAPABILITY_SET_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    specRevision: input.specRevision,
    environment: input.environment,
    policyRevision,
    preflightDigest,
    runnableStoryIds: runnableStories.map((story) => story.id),
    requirements,
  };
}

export interface AuthorityPreflightStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  getActivePreflight(workspaceId: string, runId: number): Promise<AuthorityRunPreflightRecord | null>;
  invalidatePreflight(preflightId: string, reason: string): Promise<boolean>;
  createPreflight: typeof createAuthorityRunPreflight;
  listRequirements(workspaceId: string, preflightId: string): Promise<AuthorityPreflightRequirementRecord[]>;
  createRequirement: typeof createAuthorityPreflightRequirement;
  updateRequirement: typeof updateAuthorityPreflightRequirement;
  updatePreflight: typeof updateAuthorityRunPreflight;
  createIntent(input: Parameters<typeof createOperationIntent>[0]): Promise<OperationIntentRecord>;
  createRequest(input: Parameters<typeof createPolicyAuthorityRequest>[0]): Promise<AuthorityRequestProjection>;
  getRequest(workspaceId: string, requestId: string): Promise<AuthorityRequestRecord | null>;
  getGrant(workspaceId: string, requestId: string): Promise<AuthorityGrantRecord | null>;
  getCompletedStoryIds(runId: number): Promise<Set<string>>;
  setRunState(runId: number, status: 'AUTHORIZED' | AuthorityRunWaitState, diagnostics: Record<string, unknown>): Promise<boolean>;
}

const DEFAULT_PREFLIGHT_STORE: AuthorityPreflightStore = {
  transaction: async <T>(operation: () => Promise<T>) => transaction(operation),
  getActivePreflight: getActiveAuthorityRunPreflight,
  invalidatePreflight: invalidateAuthorityRunPreflight,
  createPreflight: createAuthorityRunPreflight,
  listRequirements: listAuthorityPreflightRequirements,
  createRequirement: createAuthorityPreflightRequirement,
  updateRequirement: updateAuthorityPreflightRequirement,
  updatePreflight: updateAuthorityRunPreflight,
  createIntent: createOperationIntent,
  createRequest: createPolicyAuthorityRequest,
  getRequest: getPreflightAuthorityRequest,
  getGrant: getPreflightAuthorityGrant,
  getCompletedStoryIds: getCompletedRunStoryIds,
  setRunState: setRunAuthorityPreflightState,
};

export interface AuthorityPreflightRequirementProjection {
  storyId: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  environment: string;
  resource: string;
  requestedMode: string;
  requirementDigest: string;
  bindingHealth: AuthorityBindingHealth;
  credentialMintability: AuthorityCredentialMintability;
  changeWindow: AuthorityChangeWindow;
  outcome: AuthorityRequirementOutcome;
  authorityRequestId: string | null;
  requestDigest: string | null;
  authorityGrantId: string | null;
}

export interface AuthorityPreflightResult {
  schemaVersion: 'rorca.execution-authority-preflight-result.v1';
  required: boolean;
  runId: number;
  preflightId: string | null;
  preflightDigest: string | null;
  specRevision: string;
  policyRevision: string | null;
  status: 'NOT_REQUIRED' | 'AUTHORIZED' | AuthorityRunWaitState;
  dispatchAllowed: boolean;
  waitExpiresAt: string | null;
  waitExpired: boolean;
  pendingStoryPosition: number;
  requirements: AuthorityPreflightRequirementProjection[];
}

function waitOutcome(assessment: AuthorityPreflightAdapterAssessment): AuthorityRunWaitState | null {
  if (assessment.bindingHealth === 'unhealthy'
    || assessment.credentialMintability !== 'mintable') return 'WAITING_FOR_AUTHENTICATION';
  if (assessment.changeWindow === 'closed') return 'WAITING_FOR_CHANGE_WINDOW';
  return null;
}

function exactGrantMatches(
  grant: AuthorityGrantRecord | null,
  prepared: PreparedAuthorityRequirement,
  runId: number,
  now: Date,
): grant is AuthorityGrantRecord {
  return grant !== null
    && grant.status === 'active'
    && grant.expiresAt.getTime() > now.getTime()
    && grant.usesConsumed < grant.maximumUses
    && grant.runId === runId
    && grant.storyId === prepared.storyId
    && grant.capabilityId === prepared.declaration.capabilityId
    && grant.bindingReference === prepared.declaration.bindingReference
    && grant.bindingGeneration === prepared.declaration.bindingGeneration
    && grant.environment === prepared.declaration.scope.environment
    && grant.providerResourceId === prepared.declaration.scope.resource
    && grant.operation === prepared.declaration.requestedMode
    && grant.evidenceDigest === prepared.evidenceDigest
    && authorityDigest('rorca.execution-authority.constraints.v1', grant.constraints)
      === authorityDigest('rorca.execution-authority.constraints.v1', prepared.declaration.constraints);
}

function overallPreflightStatus(outcomes: readonly AuthorityRequirementOutcome[]): 'AUTHORIZED' | AuthorityRunWaitState {
  if (outcomes.includes('WAITING_FOR_AUTHENTICATION')) return 'WAITING_FOR_AUTHENTICATION';
  if (outcomes.includes('WAITING_FOR_CHANGE_WINDOW')) return 'WAITING_FOR_CHANGE_WINDOW';
  if (outcomes.includes('WAITING_FOR_AUTHORIZATION')) return 'WAITING_FOR_AUTHORIZATION';
  return 'AUTHORIZED';
}

async function createExactPreflightRequest(input: {
  store: AuthorityPreflightStore;
  prepared: PreparedAuthorityRequirement;
  preflightDigest: string;
  workspaceId: string;
  runId: number;
  requestingPrincipal: string;
  expiresAt: Date;
  now: Date;
}): Promise<{ intent: OperationIntentRecord; request: AuthorityRequestProjection }> {
  const scope = {
    workspaceId: input.workspaceId,
    runId: input.runId,
    storyId: input.prepared.storyId,
    environment: input.prepared.declaration.scope.environment,
    providerResourceId: input.prepared.declaration.scope.resource,
    operation: input.prepared.declaration.requestedMode,
  };
  const idempotencyKey = `preflight:${input.preflightDigest}:${input.prepared.requirementDigest}`;
  const intent = await input.store.createIntent({
    ...scope,
    requestingPrincipal: input.requestingPrincipal,
    capabilityId: input.prepared.declaration.capabilityId,
    bindingReference: input.prepared.declaration.bindingReference,
    bindingGeneration: input.prepared.declaration.bindingGeneration,
    constraints: input.prepared.declaration.constraints as AuthorityJson,
    evidenceDigest: input.prepared.evidenceDigest,
    canonicalDigest: authorityDigest('rorca.execution-authority.preflight-intent.v1', {
      preflightDigest: input.preflightDigest,
      requirementDigest: input.prepared.requirementDigest,
      ...scope,
    }),
    idempotencyKey,
    provenance: {
      schemaVersion: 'rorca.execution-authority-preflight.v1',
      source: 'run-enqueue',
      preflightDigest: input.preflightDigest,
      requirementDigest: input.prepared.requirementDigest,
    },
  });
  const request = await input.store.createRequest({
    workspaceId: input.workspaceId,
    intentId: intent.id,
    maximumUses: 1,
    expiresAt: input.expiresAt,
    idempotencyKey,
    now: input.now,
  });
  return { intent, request };
}

export async function settleExecutionAuthorityPreflight(input: {
  runId: number;
  prepared: PreparedAuthorityPreflight | null;
  specRevision: string;
  requestingPrincipal?: string;
  waitTtlMs?: number;
  now?: Date;
  store?: AuthorityPreflightStore;
}): Promise<AuthorityPreflightResult> {
  if (!input.prepared) {
    return {
      schemaVersion: 'rorca.execution-authority-preflight-result.v1', required: false, runId: input.runId,
      preflightId: null, preflightDigest: null, specRevision: input.specRevision, policyRevision: null,
      status: 'NOT_REQUIRED', dispatchAllowed: true, waitExpiresAt: null, waitExpired: false,
      pendingStoryPosition: 0, requirements: [],
    };
  }
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw new ValidationError('Authority preflight runId is invalid');
  const store = input.store ?? DEFAULT_PREFLIGHT_STORE;
  const now = input.now ?? new Date();
  const waitTtlMs = input.waitTtlMs ?? DEFAULT_AUTHORITY_WAIT_TTL_MS;
  if (!Number.isSafeInteger(waitTtlMs) || waitTtlMs < 60_000 || waitTtlMs > 7 * 24 * 60 * 60 * 1000) {
    throw new ValidationError('Authority wait TTL must be between one minute and seven days');
  }
  const requestingPrincipal = input.requestingPrincipal?.trim() || `execution:run:${input.runId}`;

  return store.transaction(async () => {
    const completedStoryIds = await store.getCompletedStoryIds(input.runId);
    const firstPending = input.prepared!.runnableStoryIds.findIndex((storyId) => !completedStoryIds.has(storyId));
    const pendingStoryPosition = firstPending === -1 ? input.prepared!.runnableStoryIds.length : firstPending;
    let active = await store.getActivePreflight(input.prepared!.workspaceId, input.runId);
    if (active && active.preflightDigest !== input.prepared!.preflightDigest) {
      await store.invalidatePreflight(active.id, 'preflight_context_changed');
      active = null;
    }

    let waitExpiresAt = active?.waitExpiresAt ?? new Date(now.getTime() + waitTtlMs);
    let existingRequirements = active
      ? await store.listRequirements(input.prepared!.workspaceId, active.id)
      : [];
    if (active && (existingRequirements.length !== input.prepared!.requirements.length
      || existingRequirements.some((requirement, index) => (
        requirement.requirementDigest !== input.prepared!.requirements[index]?.requirementDigest
      )))) {
      throw new ConflictError('Persisted authority preflight requirement set does not match its canonical digest');
    }

    const provisionalOutcomes = input.prepared!.requirements.map((requirement) => (
      waitOutcome(requirement.assessment) ?? 'WAITING_FOR_AUTHORIZATION'
    ));
    const provisionalStatus = overallPreflightStatus(provisionalOutcomes);
    if (!active) {
      active = await store.createPreflight({
        workspaceId: input.prepared!.workspaceId,
        runId: input.runId,
        specRevision: input.prepared!.specRevision,
        environment: input.prepared!.environment,
        policyRevision: input.prepared!.policyRevision,
        preflightDigest: input.prepared!.preflightDigest,
        status: provisionalStatus,
        waitExpiresAt,
        pendingStoryPosition,
      });
    }

    const projections: AuthorityPreflightRequirementProjection[] = [];
    const outcomes: AuthorityRequirementOutcome[] = [];
    for (const preparedRequirement of input.prepared!.requirements) {
      const existing = existingRequirements[preparedRequirement.ordinal] ?? null;
      const adapterWait = waitOutcome(preparedRequirement.assessment);
      let outcome: AuthorityRequirementOutcome;
      let intentId = existing?.operationIntentId ?? null;
      let requestId = existing?.authorityRequestId ?? null;
      let requestDigest: string | null = null;
      let grantId = existing?.authorityGrantId ?? null;

      if (adapterWait) {
        outcome = adapterWait;
      } else if (requestId) {
        const request = await store.getRequest(input.prepared!.workspaceId, requestId);
        const grant = await store.getGrant(input.prepared!.workspaceId, requestId);
        requestDigest = request?.requestDigest ?? null;
        if (request?.status === 'approved' && exactGrantMatches(grant, preparedRequirement, input.runId, now)) {
          outcome = 'AUTHORIZED';
          grantId = grant.id;
        } else {
          outcome = 'WAITING_FOR_AUTHORIZATION';
        }
      } else {
        const created = await createExactPreflightRequest({
          store,
          prepared: preparedRequirement,
          preflightDigest: input.prepared!.preflightDigest,
          workspaceId: input.prepared!.workspaceId,
          runId: input.runId,
          requestingPrincipal,
          expiresAt: waitExpiresAt,
          now,
        });
        intentId = created.intent.id;
        requestId = created.request.id;
        requestDigest = created.request.requestDigest;
        outcome = 'WAITING_FOR_AUTHORIZATION';
      }

      const requirementWaitExpiry = outcome === 'AUTHORIZED' ? null : waitExpiresAt;
      const persisted = existing
        ? await store.updateRequirement({
            workspaceId: input.prepared!.workspaceId,
            requirementId: existing.id,
            bindingHealth: preparedRequirement.assessment.bindingHealth,
            credentialMintability: preparedRequirement.assessment.credentialMintability,
            changeWindow: preparedRequirement.assessment.changeWindow,
            outcome,
            operationIntentId: intentId,
            authorityRequestId: requestId,
            authorityGrantId: grantId,
            waitExpiresAt: requirementWaitExpiry,
          })
        : await store.createRequirement({
            workspaceId: input.prepared!.workspaceId,
            runId: input.runId,
            preflightId: active.id,
            ordinal: preparedRequirement.ordinal,
            storyId: preparedRequirement.storyId,
            capabilityId: preparedRequirement.declaration.capabilityId,
            bindingReference: preparedRequirement.declaration.bindingReference,
            bindingGeneration: preparedRequirement.declaration.bindingGeneration,
            environment: preparedRequirement.declaration.scope.environment,
            providerResourceId: preparedRequirement.declaration.scope.resource,
            requestedMode: preparedRequirement.declaration.requestedMode,
            constraints: preparedRequirement.declaration.constraints as AuthorityJson,
            evidenceDigest: preparedRequirement.evidenceDigest,
            requirementDigest: preparedRequirement.requirementDigest,
            adapterId: preparedRequirement.adapterId,
            adapterPolicyRevision: preparedRequirement.adapterPolicyRevision,
            bindingHealth: preparedRequirement.assessment.bindingHealth,
            credentialMintability: preparedRequirement.assessment.credentialMintability,
            changeWindow: preparedRequirement.assessment.changeWindow,
            outcome,
            operationIntentId: intentId,
            authorityRequestId: requestId,
            authorityGrantId: grantId,
            waitExpiresAt: requirementWaitExpiry,
          });
      if (!persisted) throw new ConflictError('Authority preflight requirement changed concurrently');
      outcomes.push(outcome);
      projections.push({
        storyId: preparedRequirement.storyId,
        capabilityId: preparedRequirement.declaration.capabilityId,
        bindingReference: preparedRequirement.declaration.bindingReference,
        bindingGeneration: preparedRequirement.declaration.bindingGeneration,
        environment: preparedRequirement.declaration.scope.environment,
        resource: preparedRequirement.declaration.scope.resource,
        requestedMode: preparedRequirement.declaration.requestedMode,
        requirementDigest: preparedRequirement.requirementDigest,
        bindingHealth: preparedRequirement.assessment.bindingHealth,
        credentialMintability: preparedRequirement.assessment.credentialMintability,
        changeWindow: preparedRequirement.assessment.changeWindow,
        outcome,
        authorityRequestId: requestId,
        requestDigest,
        authorityGrantId: grantId,
      });
    }

    const status = overallPreflightStatus(outcomes);
    const batchWaitExpiry = status === 'AUTHORIZED' ? null : waitExpiresAt;
    const updated = await store.updatePreflight({
      workspaceId: input.prepared!.workspaceId,
      preflightId: active.id,
      status,
      waitExpiresAt: batchWaitExpiry,
      pendingStoryPosition,
    });
    if (!updated) throw new ConflictError('Authority preflight changed concurrently');
    const runUpdated = await store.setRunState(input.runId, status, {
      authorityPreflightId: active.id,
      authorityPreflightDigest: active.preflightDigest,
      authorityWaitExpiresAt: batchWaitExpiry?.toISOString() ?? null,
      authorityPendingStoryPosition: updated.pendingStoryPosition,
    });
    if (!runUpdated) throw new ConflictError('Pipeline run cannot transition through authority preflight');

    return {
      schemaVersion: 'rorca.execution-authority-preflight-result.v1',
      required: true,
      runId: input.runId,
      preflightId: active.id,
      preflightDigest: active.preflightDigest,
      specRevision: active.specRevision,
      policyRevision: active.policyRevision,
      status,
      dispatchAllowed: status === 'AUTHORIZED',
      waitExpiresAt: batchWaitExpiry?.toISOString() ?? null,
      waitExpired: batchWaitExpiry !== null && batchWaitExpiry.getTime() <= now.getTime(),
      pendingStoryPosition: updated.pendingStoryPosition,
      requirements: projections,
    };
  });
}
