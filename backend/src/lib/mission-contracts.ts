/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';

// Backend-local primitive mirrors. The backend TypeScript project cannot import
// root shared sources because its production rootDir is backend/src.
const workspaceId = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/,
  'workspaceId must be 1–200 chars of [A-Za-z0-9_-] and must not start with a separator',
);
const isoTimestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
  'must be an ISO-8601 timestamp with timezone (e.g. 2026-06-27T12:00:00Z)',
);
const idempotencyKey = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9:._-]{7,255}$/,
  'idempotencyKey must be 8–256 chars of [A-Za-z0-9:._-] and must not start with a separator',
);

export const MISSION_CONTRACT_VERSIONS = {
  entityRef: 'rorca.entity-ref.v1',
  operationalStatePacket: 'rorca.operational-state-packet.v1',
  actionEnvelope: 'rorca.action-envelope.v1',
  deliveryCaseSummary: 'rorca.delivery-case-summary.v2',
  returnContext: 'rorca.return-context.v1',
  executionReceipt: 'rorca.execution-receipt.v1',
  runControlProjection: 'rorca.run-control-projection.v1',
} as const;

export const ENTITY_KINDS = [
  'workspace',
  'mission',
  'spec',
  'story',
  'run',
  'attempt',
  'process',
  'phase',
  'gate',
  'evidence',
  'decision',
  'commit',
  'bundle',
  'knowledge',
  'insight',
] as const;
export const REVISION_KINDS = [
  'spec_version',
  'snapshot',
  'commit_sha',
  'artifact_digest',
  'deployment_id',
  'version',
] as const;

const boundedId = z.string().min(1).max(256);
const boundedLabel = z.string().min(1).max(160);
const boundedText = z.string().min(1).max(2000);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a lowercase sha256 digest');
const entityKind = z.enum(ENTITY_KINDS);
const revisionKind = z.enum(REVISION_KINDS);

export const RevisionRefV1Schema = z.object({
  kind: revisionKind,
  value: z.string().min(1).max(256),
}).strict();
export type RevisionRefV1 = z.infer<typeof RevisionRefV1Schema>;

export const ParentEntityRefV1Schema = z.object({
  workspaceId,
  kind: entityKind,
  id: boundedId,
  revision: RevisionRefV1Schema.optional(),
  label: boundedLabel,
}).strict();
export type ParentEntityRefV1 = z.infer<typeof ParentEntityRefV1Schema>;

export const EntityRefV1Schema = z.object({
  schemaVersion: z.literal(MISSION_CONTRACT_VERSIONS.entityRef),
  workspaceId,
  kind: entityKind,
  id: boundedId,
  parent: ParentEntityRefV1Schema.optional(),
  revision: RevisionRefV1Schema.optional(),
  label: boundedLabel,
}).strict().superRefine((value, context) => {
  if (value.parent && value.parent.workspaceId !== value.workspaceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parent', 'workspaceId'],
      message: 'parent must belong to the same workspace',
    });
  }
});
export type EntityRefV1 = z.infer<typeof EntityRefV1Schema>;

export const OUTCOME_STATES = ['unknown', 'not_available', 'pending', 'partial', 'succeeded', 'failed', 'cancelled'] as const;
export const LIVENESS_STATES = ['unknown', 'not_started', 'queued', 'running', 'paused', 'stalled', 'completed'] as const;
export const RISK_STATES = ['unknown', 'none', 'low', 'medium', 'high', 'critical'] as const;
export const CONFIDENCE_STATES = ['unknown', 'low', 'medium', 'high'] as const;
export const FRESHNESS_STATES = ['unknown', 'fresh', 'aging', 'stale'] as const;
export const AUTHORITY_STATES = ['unknown', 'authoritative', 'derived', 'reported', 'unverified'] as const;
export const STATE_SOURCE_KINDS = ['backend', 'database', 'worker', 'provider', 'operator', 'derived'] as const;
export const ACTION_AUTHORITIES = ['user', 'workspace_admin', 'mission_owner', 'reviewer', 'system'] as const;

export const OutcomeStateV1Schema = z.enum(OUTCOME_STATES);
export const LivenessStateV1Schema = z.enum(LIVENESS_STATES);
export const RiskStateV1Schema = z.enum(RISK_STATES);
export const ConfidenceStateV1Schema = z.enum(CONFIDENCE_STATES);
export const FreshnessStateV1Schema = z.enum(FRESHNESS_STATES);
export const AuthorityStateV1Schema = z.enum(AUTHORITY_STATES);
export const ActionAuthorityV1Schema = z.enum(ACTION_AUTHORITIES);

export const StateSourceV1Schema = z.object({
  kind: z.enum(STATE_SOURCE_KINDS),
  id: boundedId,
  label: boundedLabel,
}).strict();
export type StateSourceV1 = z.infer<typeof StateSourceV1Schema>;

export const BlockerV1Schema = z.object({
  code: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  message: boundedText,
  remediation: boundedText,
}).strict();
export type BlockerV1 = z.infer<typeof BlockerV1Schema>;

const internalHref = z.string().min(1).max(1024)
  .refine((value) => value.startsWith('/') && !value.startsWith('//'), 'href must be an internal root-relative path')
  .refine((value) => !/[\\\u0000-\u001f]/.test(value), 'href contains unsafe characters')
  .refine((value) => !/(?:^|[?&])returnTo=/i.test(value), 'nested returnTo is forbidden');

export const NextSafeActionV1Schema = z.object({
  actionId: boundedId,
  label: boundedLabel,
  rationale: boundedText,
  requiresApproval: z.boolean(),
  authority: ActionAuthorityV1Schema,
  href: internalHref,
}).strict();
export type NextSafeActionV1 = z.infer<typeof NextSafeActionV1Schema>;

export const OperationalStatePacketV1Schema = z.object({
  schemaVersion: z.literal(MISSION_CONTRACT_VERSIONS.operationalStatePacket),
  outcome: OutcomeStateV1Schema,
  liveness: LivenessStateV1Schema,
  risk: RiskStateV1Schema,
  confidence: ConfidenceStateV1Schema,
  freshness: FreshnessStateV1Schema,
  authority: AuthorityStateV1Schema,
  observedAt: isoTimestamp,
  source: StateSourceV1Schema,
  blocker: BlockerV1Schema.optional(),
  consequence: boundedText,
  nextSafeAction: NextSafeActionV1Schema,
}).strict();
export type OperationalStatePacketV1 = z.infer<typeof OperationalStatePacketV1Schema>;

export const ACTION_PRIORITIES = ['safety', 'decision', 'blocked', 'ready', 'informational'] as const;
export const OWNER_KINDS = ['user', 'team', 'system', 'unassigned'] as const;
export const PERMITTED_ACTION_KINDS = [
  'view',
  'review',
  'approve',
  'reject',
  'defer',
  'start_run',
  'queue_run',
  'pause_run',
  'resume_run',
  'cancel_run',
  'retry_run',
  'open_evidence',
  'open_decision',
  'resolve_blocker',
] as const;

export const OwnerRefV1Schema = z.object({
  kind: z.enum(OWNER_KINDS),
  id: boundedId.optional(),
  label: boundedLabel,
}).strict().superRefine((value, context) => {
  if (value.kind === 'unassigned' && value.id !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'unassigned owner cannot have an id' });
  }
  if (value.kind !== 'unassigned' && value.id === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'assigned owner requires an id' });
  }
});
export type OwnerRefV1 = z.infer<typeof OwnerRefV1Schema>;

export const PermittedActionV1Schema = z.object({
  actionId: boundedId,
  kind: z.enum(PERMITTED_ACTION_KINDS),
  label: boundedLabel,
  requiresApproval: z.boolean(),
  authority: ActionAuthorityV1Schema,
  href: internalHref,
}).strict();
export type PermittedActionV1 = z.infer<typeof PermittedActionV1Schema>;

export const ActionEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(MISSION_CONTRACT_VERSIONS.actionEnvelope),
  actionId: boundedId,
  workspaceId,
  entity: EntityRefV1Schema,
  mission: EntityRefV1Schema.optional(),
  priority: z.enum(ACTION_PRIORITIES),
  whyNow: boundedText,
  state: OperationalStatePacketV1Schema,
  owner: OwnerRefV1Schema,
  createdAt: isoTimestamp,
  freshness: FreshnessStateV1Schema,
  permittedAction: PermittedActionV1Schema,
}).strict().superRefine((value, context) => {
  if (value.entity.workspaceId !== value.workspaceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['entity', 'workspaceId'], message: 'entity must belong to the envelope workspace' });
  }
  if (value.mission && (value.mission.workspaceId !== value.workspaceId || value.mission.kind !== 'mission')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mission'], message: 'mission must be a mission in the envelope workspace' });
  }
  if (value.permittedAction.actionId !== value.actionId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['permittedAction', 'actionId'], message: 'permitted action must match the envelope actionId' });
  }
});
export type ActionEnvelopeV1 = z.infer<typeof ActionEnvelopeV1Schema>;

export const DELIVERY_STAGES = ['planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance'] as const;
export const REVIEW_PROJECTION_STATES = ['unknown', 'not_required', 'pending', 'in_review', 'approved', 'changes_requested'] as const;
export const READINESS_PROJECTION_STATES = ['unknown', 'not_ready', 'at_risk', 'ready'] as const;
export const LIFECYCLE_PROJECTION_STATES = ['unknown', 'draft', 'active', 'paused', 'completed', 'cancelled'] as const;
export const RUN_PROJECTION_STATES = ['unknown', 'not_scheduled', 'queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export const RELEASE_PROJECTION_STATES = ['unknown', 'not_started', 'preparing', 'ready', 'released', 'failed', 'rolled_back'] as const;

export const DeliveryStageProjectionV1Schema = z.object({
  label: boundedLabel,
  summary: boundedText,
  state: OperationalStatePacketV1Schema,
  updatedAt: isoTimestamp,
  entity: EntityRefV1Schema.optional(),
}).strict();
export type DeliveryStageProjectionV1 = z.infer<typeof DeliveryStageProjectionV1Schema>;

export const ReviewHeaderProjectionV1Schema = z.object({
  state: z.enum(REVIEW_PROJECTION_STATES),
  requiredDecisions: z.number().int().nonnegative().max(10_000),
  unresolvedDecisions: z.number().int().nonnegative().max(10_000),
}).strict().refine((value) => value.unresolvedDecisions <= value.requiredDecisions, {
  path: ['unresolvedDecisions'], message: 'unresolved decisions cannot exceed required decisions',
});

export const ReadinessHeaderProjectionV1Schema = z.object({
  state: z.enum(READINESS_PROJECTION_STATES),
  completedChecks: z.number().int().nonnegative().max(10_000),
  totalChecks: z.number().int().nonnegative().max(10_000),
}).strict().refine((value) => value.completedChecks <= value.totalChecks, {
  path: ['completedChecks'], message: 'completed checks cannot exceed total checks',
});

export const LifecycleHeaderProjectionV1Schema = z.object({
  state: z.enum(LIFECYCLE_PROJECTION_STATES),
  currentStage: z.enum(DELIVERY_STAGES),
}).strict();

export const RunHeaderProjectionV1Schema = z.object({
  state: z.enum(RUN_PROJECTION_STATES),
  run: EntityRefV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.run && value.run.kind !== 'run') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['run', 'kind'], message: 'run projection requires a run entity' });
  }
});

export const ReleaseHeaderProjectionV1Schema = z.object({
  state: z.enum(RELEASE_PROJECTION_STATES),
  revision: RevisionRefV1Schema.optional(),
  releasedAt: isoTimestamp.optional(),
}).strict();

export const SourceContextDriftV1Schema = z.object({
  contextState: z.enum(['fresh', 'stale', 'unavailable', 'unknown']),
  stale: z.boolean(),
  bundleHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  checkedAt: isoTimestamp,
  sources: z.array(z.object({
    sourceId: z.string().min(1), locator: z.string().min(1),
    state: z.enum(['unchanged', 'changed', 'deleted', 'unavailable', 'unknown']),
    oldHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    newHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(), detail: z.string().min(1),
  }).strict()).max(500),
}).strict();

export const IntentSourceBundleProjectionV1Schema = z.object({
  bundleId: z.string().min(1),
  bundleHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  compiledAt: isoTimestamp,
  includedSources: z.array(z.object({
    sourceId: z.string().min(1), title: z.string().min(1), sourceVersion: z.string().min(1),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    selectedSections: z.array(z.string().min(1)).max(500),
  }).strict()).min(1).max(500),
  excludedSources: z.array(z.object({
    source: z.object({
      sourceId: z.string().min(1), title: z.string().min(1), sourceVersion: z.string().min(1),
      contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      selectedSections: z.array(z.string().min(1)).max(500),
    }).strict(),
    reason: z.string().min(1),
  }).strict()).max(500),
  citations: z.array(z.object({
    citationId: z.string().min(1), sourceId: z.string().min(1), section: z.string().min(1),
    excerptHash: z.string().regex(/^sha256:[0-9a-f]{64}$/), rationale: z.string().min(1),
  }).strict()).max(1_000),
  conflicts: z.array(z.object({
    conflictId: z.string().min(1), sourceIds: z.array(z.string().min(1)).min(2).max(32),
    summary: z.string().min(1), resolution: z.string().min(1).nullable(),
  }).strict()).max(100),
}).strict();
export type IntentSourceBundleProjectionV1 = z.infer<typeof IntentSourceBundleProjectionV1Schema>;

export const DeliveryCaseSummaryV1Schema = z.object({
  schemaVersion: z.literal(MISSION_CONTRACT_VERSIONS.deliveryCaseSummary),
  workspaceId,
  mission: EntityRefV1Schema,
  spec: EntityRefV1Schema,
  stages: z.object({
    planning: DeliveryStageProjectionV1Schema,
    requirements: DeliveryStageProjectionV1Schema,
    design: DeliveryStageProjectionV1Schema,
    development: DeliveryStageProjectionV1Schema,
    testing: DeliveryStageProjectionV1Schema,
    deployment: DeliveryStageProjectionV1Schema,
    maintenance: DeliveryStageProjectionV1Schema,
  }).strict(),
  review: ReviewHeaderProjectionV1Schema,
  readiness: ReadinessHeaderProjectionV1Schema,
  lifecycle: LifecycleHeaderProjectionV1Schema,
  run: RunHeaderProjectionV1Schema,
  release: ReleaseHeaderProjectionV1Schema,
  sourceBundle: IntentSourceBundleProjectionV1Schema.optional(),
  sourceContext: SourceContextDriftV1Schema.optional(),
  state: OperationalStatePacketV1Schema,
  actions: z.array(ActionEnvelopeV1Schema).max(12),
  projectedAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  for (const [key, ref, kind] of [['mission', value.mission, 'mission'], ['spec', value.spec, 'spec']] as const) {
    if (ref.workspaceId !== value.workspaceId || ref.kind !== kind || !ref.revision) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} must be an exact revision in the summary workspace` });
    }
  }
  if (value.actions.some((action) => action.workspaceId !== value.workspaceId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['actions'], message: 'all actions must belong to the summary workspace' });
  }
});
export type DeliveryCaseSummaryV1 = z.infer<typeof DeliveryCaseSummaryV1Schema>;

const returnPath = z.string().min(1).max(512)
  .refine((value) => value.startsWith('/') && !value.startsWith('//'), 'path must be an internal root-relative path')
  .refine((value) => !/[?#\\\u0000-\u001f]/.test(value), 'path must not contain query, fragment, backslash, or control characters')
  .refine((value) => !value.split('/').some((segment) => segment === '.' || segment === '..'), 'path traversal is forbidden');

function hasNestedReturnTo(value: string): boolean {
  let decoded = value;
  for (let index = 0; index < 3; index += 1) {
    if (/(?:^|[?&])(?:returnTo|return_to)=/i.test(decoded)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return true;
    }
  }
  return /(?:^|[?&])(?:returnTo|return_to)=/i.test(decoded);
}

const returnSearch = z.string().max(512)
  .refine((value) => value === '' || value.startsWith('?'), 'search must be empty or begin with ?')
  .refine((value) => !/[#\\\u0000-\u001f]/.test(value), 'search contains unsafe characters')
  .refine((value) => !hasNestedReturnTo(value), 'nested returnTo is forbidden');
const contextToken = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const ReturnContextV1Schema = z.object({
  schemaVersion: z.literal(MISSION_CONTRACT_VERSIONS.returnContext),
  path: returnPath,
  search: returnSearch.optional(),
  focus: contextToken.optional(),
  lens: contextToken.optional(),
}).strict();
export type ReturnContextV1 = z.infer<typeof ReturnContextV1Schema>;

export const EXECUTION_SCHEDULING = ['run', 'queue'] as const;
export const EXECUTION_MODES = ['sequential', 'parallel'] as const;
export const MERGE_STRATEGIES = ['branch-only', 'draft-pr', 'direct'] as const;
export const EXECUTION_EFFORTS = ['low', 'medium', 'high'] as const;

export const EffectiveExecutionOptionsV1Schema = z.object({
  agent: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  model: z.string().min(1).max(160).optional(),
  effort: z.enum(EXECUTION_EFFORTS).optional(),
  mode: z.enum(EXECUTION_MODES),
  parallelism: z.number().int().min(1).max(32),
  storyIds: z.array(boundedId).max(500),
  worktree: z.object({ enabled: z.boolean() }).strict(),
  merge: z.object({ strategy: z.enum(MERGE_STRATEGIES), autoMerge: z.boolean() }).strict(),
}).strict();
export type EffectiveExecutionOptionsV1 = z.infer<typeof EffectiveExecutionOptionsV1Schema>;

export const ExecutionReceiptV1Schema = z.object({
  schemaVersion: z.literal(MISSION_CONTRACT_VERSIONS.executionReceipt),
  workspaceId,
  spec: EntityRefV1Schema,
  specHash: sha256,
  effectiveOptions: EffectiveExecutionOptionsV1Schema,
  scheduling: z.enum(EXECUTION_SCHEDULING),
  previewHash: sha256,
  idempotencyKey,
  returnedEntity: EntityRefV1Schema,
  acceptedAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (value.spec.workspaceId !== value.workspaceId || value.spec.kind !== 'spec' || !value.spec.revision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['spec'], message: 'spec must be an exact spec revision in the receipt workspace' });
  }
  if (value.returnedEntity.workspaceId !== value.workspaceId || value.returnedEntity.kind !== 'run') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['returnedEntity'], message: `scheduling ${value.scheduling} must return the accepted run entity` });
  }
});
export type ExecutionReceiptV1 = z.infer<typeof ExecutionReceiptV1Schema>;

export const AgentLaneV1Schema = z.object({
  laneId: boundedId,
  label: boundedLabel,
  agent: z.string().min(1).max(80),
  model: z.string().min(1).max(160).optional(),
  story: EntityRefV1Schema.optional(),
  state: OperationalStatePacketV1Schema,
  startedAt: isoTimestamp.optional(),
  completedAt: isoTimestamp.optional(),
}).strict().superRefine((value, context) => {
  if (value.story && value.story.kind !== 'story') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['story', 'kind'], message: 'agent lane story must be a story entity' });
  }
});
export type AgentLaneV1 = z.infer<typeof AgentLaneV1Schema>;

export const RunWaveV1Schema = z.object({
  waveId: boundedId,
  label: boundedLabel,
  ordinal: z.number().int().nonnegative().max(10_000),
  state: OperationalStatePacketV1Schema,
  lanes: z.array(AgentLaneV1Schema).max(64),
}).strict();
export type RunWaveV1 = z.infer<typeof RunWaveV1Schema>;

const nullableNonNegative = z.number().finite().nonnegative().nullable();
const nullableTokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const CostTokenSummaryV1Schema = z.object({
  currency: z.literal('USD'),
  estimatedCost: nullableNonNegative,
  actualCost: nullableNonNegative,
  inputTokens: nullableTokenCount,
  outputTokens: nullableTokenCount,
  totalTokens: nullableTokenCount,
}).strict().superRefine((value, context) => {
  if (value.inputTokens !== null && value.outputTokens !== null && value.totalTokens !== value.inputTokens + value.outputTokens) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['totalTokens'], message: 'totalTokens must equal inputTokens plus outputTokens' });
  }
});
export type CostTokenSummaryV1 = z.infer<typeof CostTokenSummaryV1Schema>;

export const EvidenceFreshnessV1Schema = z.object({
  state: FreshnessStateV1Schema,
  observedAt: isoTimestamp,
  newestEvidenceAt: isoTimestamp.optional(),
  staleAfterSeconds: z.number().int().positive().max(31_536_000),
  evidenceCount: z.number().int().nonnegative().max(1_000_000),
}).strict();
export type EvidenceFreshnessV1 = z.infer<typeof EvidenceFreshnessV1Schema>;

export const RunControlProjectionV1Schema = z.object({
  schemaVersion: z.literal(MISSION_CONTRACT_VERSIONS.runControlProjection),
  workspaceId,
  run: EntityRefV1Schema,
  mission: EntityRefV1Schema,
  spec: EntityRefV1Schema,
  stories: z.array(EntityRefV1Schema).max(500),
  state: OperationalStatePacketV1Schema,
  waves: z.array(RunWaveV1Schema).max(128),
  costTokens: CostTokenSummaryV1Schema,
  evidenceFreshness: EvidenceFreshnessV1Schema,
  permittedActions: z.array(PermittedActionV1Schema).max(16),
  projectedAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  for (const [key, ref, kind] of [['run', value.run, 'run'], ['mission', value.mission, 'mission'], ['spec', value.spec, 'spec']] as const) {
    if (ref.workspaceId !== value.workspaceId || ref.kind !== kind) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} must be a ${kind} in the projection workspace` });
    }
  }
  if (!value.spec.revision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['spec', 'revision'], message: 'run projection requires the exact spec revision' });
  }
  if (value.stories.some((story) => story.workspaceId !== value.workspaceId || story.kind !== 'story')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['stories'], message: 'stories must be story entities in the projection workspace' });
  }
});
export type RunControlProjectionV1 = z.infer<typeof RunControlProjectionV1Schema>;
