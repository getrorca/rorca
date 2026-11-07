/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  EXECUTION_AUTHORITY_EVIDENCE_KINDS,
  appendExecutionAuthorityRolloutEvidence,
  disableExecutionAuthorityProfile,
  enableExecutionAuthorityProfile,
  getExecutionAuthorityEvidenceByIdempotencyKey,
  getExecutionAuthorityProfile,
  listExecutionAuthorityRolloutEvidence,
  type ExecutionAuthorityDisableResult,
  type ExecutionAuthorityEvidenceKind,
  type ExecutionAuthorityProfileRecord,
  type ExecutionAuthorityRolloutEvidenceRecord,
} from '../db/execution-authority-rollout';
import { assertAuthorityRedactedValue } from './authority-redaction';
import {
  EXECUTION_AUTHORITY_PREFLIGHT_ADAPTER_VERSION,
  ExecutionAuthorityPreflightAdapterRegistry,
  prepareExecutionAuthorityPreflight,
  type AuthorityPreflightPreparationDependencies,
  type ExecutionAuthorityPreflightAdapter,
  type PreparedAuthorityPreflight,
  type RequiredCapabilityStory,
} from './execution-authority-preflight';
import { authorityDigest } from './execution-authority-policy';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
  ValidationError,
} from './errors';

export const EXECUTION_AUTHORITY_ROLLOUT_POLICY_VERSION = 'rorca.execution-authority-rollout.v1' as const;
export const EXECUTION_AUTHORITY_PROGRAM_SPEC_ID = 'rorca-execution-authority-program' as const;
export const REGISTERED_MUTATION_AUTHORITY_ADAPTER_IDS: readonly string[] = Object.freeze([]);

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ARTIFACT_REFERENCE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/\S+$/;
const PROGRAM_STORY_IDS: Readonly<Record<string, true>> = Object.freeze({
  'REA-001': true,
  'REA-002': true,
  'REA-003': true,
  'REA-004': true,
  'REA-005': true,
  'REA-006': true,
  'REA-007': true,
  'REA-008': true,
});

const PENDING_CAPABILITY_MODES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'scm.repository.read': Object.freeze(['repository.read']),
  'scm.branch.write': Object.freeze(['branch.write', 'repository.commit', 'repository.push']),
  'scm.protected_branch.push': Object.freeze(['repository.push']),
  'scm.pull_request.write': Object.freeze(['pull_request.create', 'pull_request.merge']),
  'scm.checks.read': Object.freeze(['checks.read']),
  'scm.review.request': Object.freeze(['review.request']),
  'release.publish': Object.freeze(['release.publish']),
  'production.mutate': Object.freeze(['production.mutate']),
});

const unavailablePreflightAdapter: ExecutionAuthorityPreflightAdapter = Object.freeze({
  contractVersion: EXECUTION_AUTHORITY_PREFLIGHT_ADAPTER_VERSION,
  adapterId: 'rorca.core.no-mutation-provider',
  policyRevision: authorityDigest('rorca.execution-authority.no-mutation-provider.v1', PENDING_CAPABILITY_MODES),
  describeCapabilities: () => Object.entries(PENDING_CAPABILITY_MODES).map(([capabilityId, requestedModes]) => ({
    capabilityId,
    requestedModes,
  })),
  validatePreflight: async () => ({
    bindingHealth: 'healthy' as const,
    credentialMintability: 'unavailable' as const,
    changeWindow: 'open' as const,
  }),
});

/** Preflight-only classifier. It cannot mint leases, execute, reconcile, revoke, or send externally. */
export const unavailableExecutionAuthorityPreflightRegistry = new ExecutionAuthorityPreflightAdapterRegistry();
unavailableExecutionAuthorityPreflightRegistry.register(unavailablePreflightAdapter);

export interface ExecutionAuthorityEvidenceProjection {
  id: string;
  schemaVersion: string;
  evidenceKind: ExecutionAuthorityEvidenceKind;
  result: 'passed' | 'failed';
  artifactReference: string;
  evidenceDigest: string;
  observedAt: string;
  operatorPrincipal: string;
  createdAt: string;
}

export interface ExecutionAuthorityProfileProjection {
  schemaVersion: string;
  policyVersion: typeof EXECUTION_AUTHORITY_ROLLOUT_POLICY_VERSION;
  workspaceId: string;
  state: 'disabled' | 'enabled';
  generation: number;
  transitionPrincipal: string;
  createdAt: string;
  updatedAt: string;
  enabledAt: string | null;
  disabledAt: string | null;
  readyToEnable: boolean;
  missingEvidenceKinds: ExecutionAuthorityEvidenceKind[];
  evidence: ExecutionAuthorityEvidenceProjection[];
  evidenceHistoryCount: number;
  mutationProviderAdapterIds: readonly string[];
}

export interface ExecutionAuthorityDisableProjection {
  profile: ExecutionAuthorityProfileProjection;
  cancelledRequests: number;
  revokedGrants: number;
  revokedLeases: number;
  receiptsPreserved: true;
  auditHistoryPreserved: true;
}

export interface ExecutionAuthorityRolloutStore {
  getProfile(workspaceId: string): Promise<ExecutionAuthorityProfileRecord | null>;
  listEvidence(workspaceId: string): Promise<ExecutionAuthorityRolloutEvidenceRecord[]>;
  getEvidenceByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<ExecutionAuthorityRolloutEvidenceRecord | null>;
  appendEvidence(input: Parameters<typeof appendExecutionAuthorityRolloutEvidence>[0]): Promise<ExecutionAuthorityRolloutEvidenceRecord | null>;
  enableProfile(input: Parameters<typeof enableExecutionAuthorityProfile>[0]): Promise<ExecutionAuthorityProfileRecord | null>;
  disableProfile(input: Parameters<typeof disableExecutionAuthorityProfile>[0]): Promise<ExecutionAuthorityDisableResult | null>;
}

const DEFAULT_STORE: ExecutionAuthorityRolloutStore = {
  getProfile: getExecutionAuthorityProfile,
  listEvidence: listExecutionAuthorityRolloutEvidence,
  getEvidenceByIdempotencyKey: getExecutionAuthorityEvidenceByIdempotencyKey,
  appendEvidence: appendExecutionAuthorityRolloutEvidence,
  enableProfile: enableExecutionAuthorityProfile,
  disableProfile: disableExecutionAuthorityProfile,
};

function evidenceProjection(evidence: ExecutionAuthorityRolloutEvidenceRecord): ExecutionAuthorityEvidenceProjection {
  const projection: ExecutionAuthorityEvidenceProjection = {
    id: evidence.id,
    schemaVersion: evidence.schemaVersion,
    evidenceKind: evidence.evidenceKind,
    result: evidence.result,
    artifactReference: evidence.artifactReference,
    evidenceDigest: evidence.evidenceDigest,
    observedAt: evidence.observedAt.toISOString(),
    operatorPrincipal: evidence.operatorPrincipal,
    createdAt: evidence.createdAt.toISOString(),
  };
  assertAuthorityRedactedValue(projection);
  return projection;
}

function currentEvidence(evidence: readonly ExecutionAuthorityRolloutEvidenceRecord[]): ExecutionAuthorityRolloutEvidenceRecord[] {
  const latest = new Map<ExecutionAuthorityEvidenceKind, ExecutionAuthorityRolloutEvidenceRecord>();
  for (const item of evidence) {
    const current = latest.get(item.evidenceKind);
    if (!current || item.observedAt.getTime() > current.observedAt.getTime()
      || (item.observedAt.getTime() === current.observedAt.getTime() && item.createdAt.getTime() > current.createdAt.getTime())) {
      latest.set(item.evidenceKind, item);
    }
  }
  return EXECUTION_AUTHORITY_EVIDENCE_KINDS.flatMap((kind) => {
    const item = latest.get(kind);
    return item ? [item] : [];
  });
}

function profileProjection(
  profile: ExecutionAuthorityProfileRecord,
  evidence: readonly ExecutionAuthorityRolloutEvidenceRecord[],
): ExecutionAuthorityProfileProjection {
  const latest = currentEvidence(evidence);
  const passedKinds = new Set(latest.filter((item) => item.result === 'passed').map((item) => item.evidenceKind));
  const missingEvidenceKinds = EXECUTION_AUTHORITY_EVIDENCE_KINDS.filter((kind) => !passedKinds.has(kind));
  const projection: ExecutionAuthorityProfileProjection = {
    schemaVersion: profile.schemaVersion,
    policyVersion: EXECUTION_AUTHORITY_ROLLOUT_POLICY_VERSION,
    workspaceId: profile.workspaceId,
    state: profile.state,
    generation: profile.generation,
    transitionPrincipal: profile.transitionPrincipal,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
    enabledAt: profile.enabledAt?.toISOString() ?? null,
    disabledAt: profile.disabledAt?.toISOString() ?? null,
    readyToEnable: missingEvidenceKinds.length === 0,
    missingEvidenceKinds: [...missingEvidenceKinds],
    evidence: latest.map(evidenceProjection),
    evidenceHistoryCount: evidence.length,
    mutationProviderAdapterIds: REGISTERED_MUTATION_AUTHORITY_ADAPTER_IDS,
  };
  assertAuthorityRedactedValue(projection);
  return projection;
}

async function requireProfile(
  workspaceId: string,
  store: ExecutionAuthorityRolloutStore,
): Promise<ExecutionAuthorityProfileRecord> {
  const profile = await store.getProfile(workspaceId);
  if (!profile) throw new NotFoundError('Execution Authority workspace profile', workspaceId);
  return profile;
}

export async function getExecutionAuthorityProfileProjection(
  workspaceId: string,
  store: ExecutionAuthorityRolloutStore = DEFAULT_STORE,
): Promise<ExecutionAuthorityProfileProjection> {
  const [profile, evidence] = await Promise.all([
    requireProfile(workspaceId, store),
    store.listEvidence(workspaceId),
  ]);
  return profileProjection(profile, evidence);
}

export async function executionAuthorityProfileIsEnabled(
  workspaceId: string,
  store: ExecutionAuthorityRolloutStore = DEFAULT_STORE,
): Promise<boolean> {
  return (await requireProfile(workspaceId, store)).state === 'enabled';
}
export async function assertExecutionAuthorityMutationProviderAvailable(
  workspaceId: string,
  store: ExecutionAuthorityRolloutStore = DEFAULT_STORE,
): Promise<void> {
  if (!await executionAuthorityProfileIsEnabled(workspaceId, store)) {
    throw new ForbiddenError('Execution Authority workspace capability profile is disabled');
  }
  if (REGISTERED_MUTATION_AUTHORITY_ADAPTER_IDS.length === 0) {
    throw new ServiceUnavailableError('No mutation-capable Execution Authority provider adapter is registered');
  }
}
export async function prepareWorkspaceExecutionAuthorityPreflight(input: {
  workspaceId: string;
  specRevision: string;
  environment: string;
  stories: readonly RequiredCapabilityStory[];
  specificStoryId?: string;
  profileStore?: ExecutionAuthorityRolloutStore;
  preflightRegistry?: ExecutionAuthorityPreflightAdapterRegistry;
  preflightDependencies?: AuthorityPreflightPreparationDependencies;
}): Promise<PreparedAuthorityPreflight | null> {
  const profileStore = input.profileStore ?? DEFAULT_STORE;
  if (!await executionAuthorityProfileIsEnabled(input.workspaceId, profileStore)) return null;
  return prepareExecutionAuthorityPreflight({
    workspaceId: input.workspaceId,
    specRevision: input.specRevision,
    environment: input.environment,
    stories: input.stories,
    ...(input.specificStoryId ? { specificStoryId: input.specificStoryId } : {}),
    registry: input.preflightRegistry ?? unavailableExecutionAuthorityPreflightRegistry,
    ...(input.preflightDependencies ? { dependencies: input.preflightDependencies } : {}),
  });
}

function evidenceReplayMatches(existing: ExecutionAuthorityRolloutEvidenceRecord, input: {
  evidenceKind: ExecutionAuthorityEvidenceKind;
  result: 'passed' | 'failed';
  artifactReference: string;
  evidenceDigest: string;
  observedAt: Date;
  operatorPrincipal: string;
}): boolean {
  return existing.evidenceKind === input.evidenceKind
    && existing.result === input.result
    && existing.artifactReference === input.artifactReference
    && existing.evidenceDigest === input.evidenceDigest
    && existing.observedAt.getTime() === input.observedAt.getTime()
    && existing.operatorPrincipal === input.operatorPrincipal;
}

export async function recordExecutionAuthorityRolloutEvidence(input: {
  workspaceId: string;
  evidenceKind: ExecutionAuthorityEvidenceKind;
  result: 'passed' | 'failed';
  artifactReference: string;
  evidenceDigest: string;
  observedAt: Date;
  operatorPrincipal: string;
  idempotencyKey: string;
  store?: ExecutionAuthorityRolloutStore;
}): Promise<ExecutionAuthorityProfileProjection> {
  const store = input.store ?? DEFAULT_STORE;
  await requireProfile(input.workspaceId, store);
  if (!ARTIFACT_REFERENCE_PATTERN.test(input.artifactReference) || input.artifactReference.length > 2048) {
    throw new ValidationError('Rollout evidence artifact reference is malformed');
  }
  if (!DIGEST_PATTERN.test(input.evidenceDigest)) throw new ValidationError('Rollout evidence digest is malformed');
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 512) {
    throw new ValidationError('Rollout evidence idempotency key is malformed');
  }
  assertAuthorityRedactedValue({
    artifactReference: input.artifactReference,
    evidenceDigest: input.evidenceDigest,
    operatorPrincipal: input.operatorPrincipal,
  });
  const persisted = await store.appendEvidence({
    workspaceId: input.workspaceId,
    evidenceKind: input.evidenceKind,
    result: input.result,
    artifactReference: input.artifactReference,
    evidenceDigest: input.evidenceDigest,
    observedAt: input.observedAt,
    operatorPrincipal: input.operatorPrincipal,
    idempotencyKey: input.idempotencyKey,
    provenance: {
      schemaVersion: EXECUTION_AUTHORITY_ROLLOUT_POLICY_VERSION,
      source: 'local-operator-rollout-evidence',
    },
  });
  if (!persisted) {
    const existing = await store.getEvidenceByIdempotencyKey(input.workspaceId, input.idempotencyKey);
    if (!existing || !evidenceReplayMatches(existing, input)) {
      throw new ConflictError('Rollout evidence idempotency key was reused for different evidence');
    }
  }
  return getExecutionAuthorityProfileProjection(input.workspaceId, store);
}

export async function transitionExecutionAuthorityProfile(input: {
  workspaceId: string;
  enabled: boolean;
  expectedGeneration: number;
  operatorPrincipal: string;
  store?: ExecutionAuthorityRolloutStore;
}): Promise<ExecutionAuthorityProfileProjection | ExecutionAuthorityDisableProjection> {
  const store = input.store ?? DEFAULT_STORE;
  const profile = await requireProfile(input.workspaceId, store);
  if (profile.generation !== input.expectedGeneration) {
    throw new ConflictError('Execution Authority profile generation is stale', {
      expectedGeneration: profile.generation,
    });
  }
  if (input.enabled) {
    if (profile.state === 'enabled') return getExecutionAuthorityProfileProjection(input.workspaceId, store);
    const evidence = await store.listEvidence(input.workspaceId);
    const readiness = profileProjection(profile, evidence);
    if (!readiness.readyToEnable) {
      throw new UnprocessableError(
        'Execution Authority profile cannot be enabled until all rollout evidence passes',
        'EXECUTION_AUTHORITY_EVIDENCE_INCOMPLETE',
        { missingEvidenceKinds: readiness.missingEvidenceKinds },
      );
    }
    if (REGISTERED_MUTATION_AUTHORITY_ADAPTER_IDS.length !== 0) {
      throw new ConflictError('Initial Execution Authority rollout must not register mutation-capable provider adapters');
    }
    const enabled = await store.enableProfile({
      workspaceId: input.workspaceId,
      expectedGeneration: input.expectedGeneration,
      operatorPrincipal: input.operatorPrincipal,
    });
    if (!enabled) throw new ConflictError('Execution Authority profile changed before enablement');
    return profileProjection(enabled, evidence);
  }

  if (profile.state === 'disabled') return getExecutionAuthorityProfileProjection(input.workspaceId, store);
  const disabled = await store.disableProfile({
    workspaceId: input.workspaceId,
    expectedGeneration: input.expectedGeneration,
    operatorPrincipal: input.operatorPrincipal,
  });
  if (!disabled) throw new ConflictError('Execution Authority profile changed before disablement');
  const evidence = await store.listEvidence(input.workspaceId);
  return {
    profile: profileProjection(disabled.profile, evidence),
    cancelledRequests: disabled.cancelledRequests,
    revokedGrants: disabled.revokedGrants,
    revokedLeases: disabled.revokedLeases,
    receiptsPreserved: true,
    auditHistoryPreserved: true,
  };
}

export function isExecutionAuthorityProgramSpec(spec: Readonly<Record<string, unknown>>): boolean {
  return spec.id === EXECUTION_AUTHORITY_PROGRAM_SPEC_ID
    || spec.slug === EXECUTION_AUTHORITY_PROGRAM_SPEC_ID
    || spec.sourceSpecId === EXECUTION_AUTHORITY_PROGRAM_SPEC_ID
    || (spec.title === 'Rorca Execution Authority Core'
      && Array.isArray(spec.userStories)
      && spec.userStories.some((story) => (
        typeof story === 'object' && story !== null && 'id' in story
        && typeof story.id === 'string' && PROGRAM_STORY_IDS[story.id] === true
      )));
}

export function assertExecutionAuthorityProgramDeliveryPolicy(input: {
  spec: Readonly<Record<string, unknown>>;
  autoWorktree: boolean;
  autoMerge: boolean;
  mergeStrategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
}): void {
  if (!isExecutionAuthorityProgramSpec(input.spec)) return;
  if (!input.autoWorktree || input.autoMerge || input.mergeStrategy !== 'branch-only') {
    throw new UnprocessableError(
      'The pending Execution Authority program is restricted to an isolated branch until an accepted GitHub external-send policy exists',
      'EXECUTION_AUTHORITY_PROGRAM_BRANCH_ONLY',
      { requiredMergeStrategy: 'branch-only', autoWorktreeRequired: true, autoMergeAllowed: false },
    );
  }
}

export function assertExecutionAuthorityProgramCannotSelfApprove(storyId: string): void {
  if (PROGRAM_STORY_IDS[storyId] === true) {
    throw new ForbiddenError(
      'The pending Execution Authority program cannot approve its own authority requests',
      { storyId, policyVersion: EXECUTION_AUTHORITY_ROLLOUT_POLICY_VERSION },
    );
  }
}
