/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * One governed SSDLC decision service. It records deferrals, N/A confirmations,
 * QA/merge/production approvals, and narrowly policy-permitted gate overrides.
 * It never updates lifecycle evidence or persists request-body actor claims.
 */

import crypto from 'node:crypto';
import { simpleGit } from 'simple-git';
import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db/index';
import { LOCAL_ADMIN } from './auth-utils';
import { LifecyclePlanSchema, type LifecyclePlan, type PhaseId } from './ssdlc-contracts';
import { broadcastAll, type WalEvent } from './sse-hub';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from './errors';

export const SSDLC_DECISION_TYPES = [
  'defer',
  'not_applicable_confirmation',
  'gate_override',
  'qa_approval',
  'merge_approval',
  'production_approval',
] as const;

export type SsdlcDecisionType = typeof SSDLC_DECISION_TYPES[number];
export type DecisionPrincipalType = 'local_admin' | 'authenticated_user' | 'hermes' | 'internal_service';
export type DecisionSourceChannel = 'local' | 'api' | 'hermes' | 'internal';
export type DecisionSubjectType = 'commit_sha' | 'artifact_digest';
export type DerivedDecisionState = 'pending' | 'deferred' | 'not_applicable' | 'approved';
export type DecisionActivity = 'active' | 'expired' | 'revoked' | 'stale_revision';

type DbTimestamp = Date | string;

type GateDefinition = LifecyclePlan['gates'][number];

export interface DelegatedDecisionIdentity {
  principalId: string;
  displayLabel: string;
}

interface DecisionAuthUser {
  id: string;
  email: string;
  role?: string;
}

export interface DecisionPrincipal {
  principalType: DecisionPrincipalType;
  principalId: string;
  displayLabel: string;
  role: string;
  sourceChannel: DecisionSourceChannel;
  delegatedOnBehalfOf?: DelegatedDecisionIdentity;
}

export interface DecisionSubject {
  type: DecisionSubjectType;
  value: string;
}

export interface RecordSsdlcDecisionInput {
  workspaceId: string;
  specSlug: string;
  specVersion?: string | number | null;
  runId?: number | null;
  storyId?: string | null;
  phaseId: string;
  gateId?: string | null;
  decisionType: SsdlcDecisionType;
  rationale: string;
  expiresAt?: Date | string | null;
  evidenceGap?: string | null;
  subject?: DecisionSubject | null;
  sourceRequestId: string;
}

export interface RevokeSsdlcDecisionInput {
  workspaceId: string;
  decisionId: string;
  rationale: string;
  sourceRequestId: string;
}

interface SsdlcDecisionRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  spec_version: string | null;
  run_id: number | null;
  story_id: string | null;
  phase_id: string;
  gate_id: string | null;
  decision_type: SsdlcDecisionType;
  rationale: string;
  evidence_gap: string | null;
  subject_type: DecisionSubjectType | null;
  subject_value: string | null;
  policy_version: string;
  policy_reference: string;
  policy_authorized: boolean;
  principal_type: DecisionPrincipalType;
  principal_id: string;
  principal_display_label: string;
  actor: string;
  delegated_principal_id: string | null;
  delegated_display_label: string | null;
  source_request_id: string;
  source_channel: DecisionSourceChannel;
  scope_key: string;
  request_hash: string;
  created_at: DbTimestamp;
  expires_at: DbTimestamp | null;
  revoked_at: DbTimestamp | null;
  revoked_by_principal_type: DecisionPrincipalType | null;
  revoked_by_principal_id: string | null;
  revoked_by_display_label: string | null;
  revocation_rationale: string | null;
  revocation_source_request_id: string | null;
}

export interface SsdlcDecision {
  id: string;
  workspaceId: string;
  specSlug: string;
  specVersion: string | null;
  runId: number | null;
  storyId: string | null;
  phaseId: string;
  gateId: string | null;
  decisionType: SsdlcDecisionType;
  rationale: string;
  evidenceGap: string | null;
  subject: DecisionSubject | null;
  policy: { version: string; reference: string; authorized: boolean };
  actor: {
    principalType: DecisionPrincipalType;
    principalId: string;
    displayLabel: string;
    sourceChannel: DecisionSourceChannel;
    delegatedOnBehalfOf: DelegatedDecisionIdentity | null;
  };
  sourceRequestId: string;
  createdAt: DbTimestamp;
  expiresAt: DbTimestamp | null;
  revokedAt: DbTimestamp | null;
  revocation: {
    principalType: DecisionPrincipalType;
    principalId: string;
    displayLabel: string;
    rationale: string;
    sourceRequestId: string;
  } | null;
}

export interface EvaluatedSsdlcDecision extends SsdlcDecision {
  activity: DecisionActivity;
  inactiveReason: string | null;
}

export interface SsdlcDecisionState {
  state: DerivedDecisionState;
  effectiveDecisions: EvaluatedSsdlcDecision[];
  history: EvaluatedSsdlcDecision[];
}

interface PolicyContext {
  workspacePath: string;
  plan: LifecyclePlan;
}

interface PersistCandidate {
  workspaceId: string;
  specSlug: string;
  specVersion: string | null;
  runId: number | null;
  storyId: string | null;
  phaseId: PhaseId;
  gateId: string | null;
  decisionType: SsdlcDecisionType;
  rationale: string;
  evidenceGap: string | null;
  subject: DecisionSubject | null;
  expiresAt: Date | null;
  policyVersion: string;
  policyReference: string;
  principal: DecisionPrincipal;
  sourceRequestId: string;
  scopeKey: string;
  requestHash: string;
}

interface PersistResult {
  row: SsdlcDecisionRow;
  replayed: boolean;
  walEvent: WalEvent | null;
}

interface DecisionStore {
  loadPolicyContext(workspaceId: string, specSlug: string): Promise<PolicyContext>;
  resolveCurrentIdentity(context: PolicyContext, candidate: Pick<PersistCandidate, 'workspaceId' | 'specSlug' | 'subject'>): Promise<string>;
  persist(candidate: PersistCandidate): Promise<PersistResult>;
  revoke(input: RevokeSsdlcDecisionInput, principal: DecisionPrincipal): Promise<PersistResult>;
  list(workspaceId: string, specSlug: string, phaseId: string, gateId: string | null, activeOnly: boolean): Promise<SsdlcDecisionRow[]>;
}

export interface SsdlcDecisionDependencies {
  store?: DecisionStore;
  broadcast?: (event: WalEvent) => void;
  now?: () => Date;
}

const APPROVAL_TYPES = new Set<SsdlcDecisionType>([
  'qa_approval',
  'merge_approval',
  'production_approval',
]);

const HIGH_RISK_PHASES = new Set<string>(['security', 'staging', 'qa', 'merge', 'production']);
const HARD_DENY_TERMS = /(?:security|credential|secret|destructive[_ -]?migration|external[_ -]?send|merge|deploy|production)/i;
const CONCRETE_RATIONALE_MIN_LENGTH = 10;
const NON_CONCRETE_NA_RATIONALE = /^(?:n\/?a|not applicable|not needed|none|skip(?:ped)?)(?:[.!])?$/i;

function text(value: unknown, field: string, minimumLength = 1): string {
  if (typeof value !== 'string' || value.trim().length < minimumLength) {
    throw new ValidationError(`${field} must contain at least ${minimumLength} non-whitespace characters`, { field });
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field);
}

function normalizeVersion(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new ValidationError('specVersion must be a non-empty string or number', { field: 'specVersion' });
  }
  return String(value).trim();
}

function normalizeRunId(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('runId must be a positive integer', { field: 'runId' });
  }
  return value;
}

function normalizeExpiry(value: Date | string | null | undefined, now: Date): Date | null {
  if (value === undefined || value === null) return null;
  const expiry = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(expiry.getTime())) throw new ValidationError('expiresAt must be a valid timestamp', { field: 'expiresAt' });
  if (expiry.getTime() <= now.getTime()) throw new ValidationError('expiresAt must be in the future', { field: 'expiresAt' });
  return expiry;
}

function normalizeSubject(subject: DecisionSubject | null | undefined): DecisionSubject | null {
  if (!subject) return null;
  if (subject.type !== 'commit_sha' && subject.type !== 'artifact_digest') {
    throw new ValidationError('subject.type must be commit_sha or artifact_digest', { field: 'subject.type' });
  }
  const value = text(subject.value, 'subject.value').toLowerCase();
  if (subject.type === 'commit_sha' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new ValidationError('commit_sha must be a full 40 or 64 character hexadecimal revision', { field: 'subject.value' });
  }
  if (subject.type === 'artifact_digest' && !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ValidationError('artifact_digest must be an immutable sha256 digest', { field: 'subject.value' });
  }
  return { type: subject.type, value };
}

function canonicalHash(value: Record<string, unknown>): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function asIso(value: DbTimestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isHermesUser(user: DecisionAuthUser): boolean {
  return user.role === 'admin'
    && user.email.toLowerCase() === 'hermes@rorca.internal';
}

function isInternalServiceUser(user: DecisionAuthUser): boolean {
  return user.role === 'admin'
    && (user.email.toLowerCase().endsWith('@rorca.internal')
      || user.id === 'system'
      || user.id === '00000000-0000-0000-0000-000000000000');
}

/** Derive immutable decision authority from the authenticated server request context. */
export function deriveDecisionPrincipal(
  user: DecisionAuthUser | null | undefined,
  delegatedOnBehalfOf?: DelegatedDecisionIdentity | null,
): DecisionPrincipal {
  if (!user) throw new ForbiddenError('An authenticated decision principal is required');
  let principalType: DecisionPrincipalType;
  let sourceChannel: DecisionSourceChannel;
  if (user.id === LOCAL_ADMIN.id) {
    principalType = 'local_admin';
    sourceChannel = 'local';
  } else if (isHermesUser(user)) {
    principalType = 'hermes';
    sourceChannel = 'hermes';
  } else if (isInternalServiceUser(user)) {
    principalType = 'internal_service';
    sourceChannel = 'internal';
  } else {
    principalType = 'authenticated_user';
    sourceChannel = 'api';
  }

  let delegated: DelegatedDecisionIdentity | undefined;
  if (delegatedOnBehalfOf) {
    if (principalType !== 'hermes') {
      throw new ValidationError('delegatedOnBehalfOf is accepted only from authenticated Hermes');
    }
    delegated = {
      principalId: text(delegatedOnBehalfOf.principalId, 'delegatedOnBehalfOf.principalId'),
      displayLabel: text(delegatedOnBehalfOf.displayLabel, 'delegatedOnBehalfOf.displayLabel'),
    };
  }

  return {
    principalType,
    principalId: text(user.id, 'authenticatedUser.id'),
    displayLabel: text(user.email, 'authenticatedUser.email'),
    role: user.role ?? 'user',
    sourceChannel,
    ...(delegated ? { delegatedOnBehalfOf: delegated } : {}),
  };
}

function isApprover(principal: DecisionPrincipal): boolean {
  if (principal.principalType === 'local_admin') return true;
  if (principal.principalType === 'hermes') return Boolean(principal.delegatedOnBehalfOf);
  return principal.principalType === 'authenticated_user' && principal.role === 'admin';
}

function gateFor(plan: LifecyclePlan, gateId: string | null, phaseId: PhaseId): GateDefinition | null {
  if (!gateId) return null;
  const gate = plan.gates.find((candidate) => candidate.gateId === gateId);
  if (!gate) throw new ValidationError(`gateId '${gateId}' is not present in the active lifecycle policy`, { gateId });
  if (gate.phaseId !== phaseId) {
    throw new ValidationError(`gateId '${gateId}' belongs to phase '${gate.phaseId}', not '${phaseId}'`, {
      gateId,
      expectedPhaseId: gate.phaseId,
      requestedPhaseId: phaseId,
    });
  }
  return gate;
}

/** Hard-deny classification runs before approval/override authorization. */
export function isHardDenyGate(gate: GateDefinition): boolean {
  return HARD_DENY_TERMS.test(`${gate.phaseId} ${gate.gateId} ${gate.title} ${gate.evidenceKind}`);
}

function policyHasAuditedApprovalPath(gate: GateDefinition | null): boolean {
  return gate !== null && gate.approvalRequirement !== 'none';
}

function phaseIsHighRisk(plan: LifecyclePlan, phaseId: PhaseId): boolean {
  if (HIGH_RISK_PHASES.has(phaseId)) return true;
  return plan.gates.some((gate) => gate.phaseId === phaseId
    && (gate.blockingSeverity === 'release_blocking' || isHardDenyGate(gate)));
}

function assertApprover(principal: DecisionPrincipal): void {
  if (!isApprover(principal)) {
    throw new ForbiddenError('This governed decision requires an authenticated policy approver');
  }
}

function expectedApprovalPhase(decisionType: SsdlcDecisionType): PhaseId | null {
  if (decisionType === 'qa_approval') return 'qa';
  if (decisionType === 'merge_approval') return 'merge';
  if (decisionType === 'production_approval') return 'production';
  return null;
}

function validatePolicy(
  plan: LifecyclePlan,
  phaseId: PhaseId,
  gate: GateDefinition | null,
  decisionType: SsdlcDecisionType,
  principal: DecisionPrincipal,
  expiresAt: Date | null,
  rationale: string,
  evidenceGap: string | null,
  subject: DecisionSubject | null,
): void {
  // Security and release controls are never overrideable. Their explicit human
  // or policy approval decision remains the only audited path when configured.
  if (decisionType === 'gate_override' && gate && isHardDenyGate(gate)) {
    throw new ForbiddenError(`Gate '${gate.gateId}' is a non-bypassable hard-deny control`);
  }

  if (principal.principalType === 'internal_service') {
    throw new ForbiddenError('Internal service principals may submit evidence but cannot make governed decisions');
  }

  if (decisionType === 'defer') {
    assertApprover(principal);
    if (!expiresAt) throw new ValidationError('Deferral requires an expiry/revisit date', { field: 'expiresAt' });
    return;
  }

  if (decisionType === 'not_applicable_confirmation') {
    if (rationale.length < CONCRETE_RATIONALE_MIN_LENGTH || NON_CONCRETE_NA_RATIONALE.test(rationale)) {
      throw new ValidationError('Not-applicable confirmation requires a concrete rationale', { field: 'rationale' });
    }
    if (phaseIsHighRisk(plan, phaseId)) {
      assertApprover(principal);
      const phaseGates = plan.gates.filter((candidate) => candidate.phaseId === phaseId);
      if (!phaseGates.some(policyHasAuditedApprovalPath)) {
        throw new ForbiddenError(`Phase '${phaseId}' has no policy-authorized audited N/A approval path`);
      }
    }
    return;
  }

  if (decisionType === 'gate_override') {
    assertApprover(principal);
    if (!gate) throw new ValidationError('Gate override requires an exact gateId', { field: 'gateId' });
    if (!policyHasAuditedApprovalPath(gate)) {
      throw new ForbiddenError(`Policy does not permit an audited override for gate '${gate.gateId}'`);
    }
    if (!evidenceGap || evidenceGap.length < CONCRETE_RATIONALE_MIN_LENGTH) {
      throw new ValidationError('Gate override requires a concrete evidenceGap', { field: 'evidenceGap' });
    }
    if (!expiresAt) throw new ValidationError('Gate override requires an expiry date', { field: 'expiresAt' });
    return;
  }

  const expectedPhase = expectedApprovalPhase(decisionType);
  if (expectedPhase) {
    assertApprover(principal);
    if (phaseId !== expectedPhase) {
      throw new ValidationError(`${decisionType} must be scoped to phase '${expectedPhase}'`, { field: 'phaseId' });
    }
    if (!gate) throw new ValidationError(`${decisionType} requires an exact gateId`, { field: 'gateId' });
    if (!policyHasAuditedApprovalPath(gate)) {
      throw new ForbiddenError(`Gate '${gate.gateId}' has no policy-authorized audited approval path`);
    }
    if (!subject) {
      throw new ValidationError(`${decisionType} requires an immutable commit/image subject`, { field: 'subject' });
    }
  }
}

function decisionFromRow(row: SsdlcDecisionRow): SsdlcDecision {
  const delegatedOnBehalfOf = row.delegated_principal_id && row.delegated_display_label
    ? { principalId: row.delegated_principal_id, displayLabel: row.delegated_display_label }
    : null;
  const revocation = row.revoked_at
    && row.revoked_by_principal_type
    && row.revoked_by_principal_id
    && row.revoked_by_display_label
    && row.revocation_rationale
    && row.revocation_source_request_id
    ? {
      principalType: row.revoked_by_principal_type,
      principalId: row.revoked_by_principal_id,
      displayLabel: row.revoked_by_display_label,
      rationale: row.revocation_rationale,
      sourceRequestId: row.revocation_source_request_id,
    }
    : null;
  return {
    id: String(row.id),
    workspaceId: row.workspace_id,
    specSlug: row.spec_slug,
    specVersion: row.spec_version,
    runId: row.run_id,
    storyId: row.story_id,
    phaseId: row.phase_id,
    gateId: row.gate_id,
    decisionType: row.decision_type,
    rationale: row.rationale,
    evidenceGap: row.evidence_gap,
    subject: row.subject_type && row.subject_value ? { type: row.subject_type, value: row.subject_value } : null,
    policy: {
      version: row.policy_version,
      reference: row.policy_reference,
      authorized: row.policy_authorized,
    },
    actor: {
      principalType: row.principal_type,
      principalId: row.principal_id,
      displayLabel: row.principal_display_label,
      sourceChannel: row.source_channel,
      delegatedOnBehalfOf,
    },
    sourceRequestId: row.source_request_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocation,
  };
}

async function lock(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

async function insertWalEvent(
  client: PoolClient,
  row: SsdlcDecisionRow,
  action: 'recorded' | 'revoked',
  actor: DecisionPrincipal,
): Promise<WalEvent> {
  const result = await client.query<WalEvent>(`
    INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
    VALUES ('decision_recorded', $1, $2, $3, $4, $5::jsonb)
    RETURNING *
  `, [
    row.workspace_id,
    row.spec_slug,
    row.story_id,
    actor.principalId,
    JSON.stringify({
      action,
      decisionId: String(row.id),
      decisionType: row.decision_type,
      phaseId: row.phase_id,
      gateId: row.gate_id,
      sourceRequestId: action === 'recorded' ? row.source_request_id : row.revocation_source_request_id,
    }),
  ]);
  return result.rows[0];
}

const pgStore: DecisionStore = {
  async loadPolicyContext(workspaceId, specSlug) {
    const row = await queryOne<{ workspace_path: string; plan_json: unknown | null }>(`
      SELECT w.path AS workspace_path, cp.plan_json
      FROM workspaces w
      LEFT JOIN LATERAL (
        SELECT plan_json
        FROM ssdlc_compiled_plans
        WHERE workspace_id = w.id AND spec_slug = $2 AND is_current = TRUE
        ORDER BY created_at DESC
        LIMIT 1
      ) cp ON TRUE
      WHERE w.id = $1
    `, [workspaceId, specSlug]);
    if (!row) throw new NotFoundError('Workspace', workspaceId);
    if (!row.plan_json) throw new NotFoundError('Current lifecycle policy', `${workspaceId}/${specSlug}`);
    const parsed = LifecyclePlanSchema.safeParse(row.plan_json);
    if (!parsed.success) {
      throw new UnprocessableError('The current lifecycle policy is invalid', 'INVALID_LIFECYCLE_POLICY', {
        specSlug,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    if (parsed.data.workspaceId !== workspaceId || parsed.data.specId !== specSlug) {
      throw new NotFoundError('Current lifecycle policy', `${workspaceId}/${specSlug}`);
    }
    return { workspacePath: row.workspace_path, plan: parsed.data };
  },

  async resolveCurrentIdentity(context, candidate) {
    const subject = candidate.subject;
    if (!subject) throw new ValidationError('An immutable approval subject is required');
    if (subject.type === 'commit_sha') {
      try {
        return (await simpleGit(context.workspacePath).revparse(['HEAD'])).trim().toLowerCase();
      } catch {
        throw new UnprocessableError('Current workspace HEAD could not be resolved', 'REVISION_UNAVAILABLE');
      }
    }
    const current = await queryOne<{ subject_value: string }>(`
      SELECT subject_value
      FROM ssdlc_lifecycle_evidence
      WHERE workspace_id = $1
        AND spec_slug = $2
        AND subject_type = 'artifact_digest'
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `, [candidate.workspaceId, candidate.specSlug]);
    if (!current) throw new UnprocessableError('No current image digest is available for approval', 'REVISION_UNAVAILABLE');
    return current.subject_value.toLowerCase();
  },

  async persist(candidate) {
    return await transaction(async (client) => {
      await lock(client, `ssdlc-decision-request:${candidate.workspaceId}:${candidate.sourceRequestId}`);
      // Lock the broad phase scope, not only the exact gate key: a concurrent
      // phase-wide deferral/N/A decision overlaps every gate-scoped decision.
      await lock(client, `ssdlc-decision-phase:${candidate.workspaceId}:${candidate.specSlug}:${candidate.phaseId}`);

      const replay = (await client.query<SsdlcDecisionRow>(`
        SELECT * FROM ssdlc_decisions
        WHERE workspace_id = $1 AND source_request_id = $2
        FOR UPDATE
      `, [candidate.workspaceId, candidate.sourceRequestId])).rows[0];
      if (replay) {
        if (replay.request_hash !== candidate.requestHash) {
          throw new ConflictError('Decision idempotency key was reused with a different request', {
            existingDecisionId: String(replay.id),
            sourceRequestId: candidate.sourceRequestId,
          });
        }
        return { row: replay, replayed: true, walEvent: null };
      }

      if (candidate.runId !== null) {
        const scopedRun = (await client.query<{ id: number }>(`
          SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND id = $2
        `, [candidate.workspaceId, candidate.runId])).rows[0];
        if (!scopedRun) {
          throw new ValidationError('runId does not belong to the decision workspace', {
            workspaceId: candidate.workspaceId,
            runId: candidate.runId,
          });
        }
      }

      const active = (await client.query<SsdlcDecisionRow>(`
        SELECT * FROM ssdlc_decisions
        WHERE workspace_id = $1
          AND spec_slug = $2
          AND phase_id = $3
          AND (gate_id IS NULL OR $4::text IS NULL OR gate_id = $4)
          AND (story_id IS NULL OR $5::text IS NULL OR story_id = $5)
          AND (run_id IS NULL OR $6::integer IS NULL OR run_id = $6)
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        FOR UPDATE
      `, [
        candidate.workspaceId,
        candidate.specSlug,
        candidate.phaseId,
        candidate.gateId,
        candidate.storyId,
        candidate.runId,
      ])).rows[0];
      if (active) {
        if (active.request_hash === candidate.requestHash) {
          return { row: active, replayed: true, walEvent: null };
        }
        throw new ConflictError('A conflicting active decision already overlaps this lifecycle scope', {
          existingDecisionId: String(active.id),
          existingDecisionType: active.decision_type,
          requestedDecisionType: candidate.decisionType,
          phaseId: candidate.phaseId,
          gateId: candidate.gateId,
        });
      }

      const inserted = (await client.query<SsdlcDecisionRow>(`
        INSERT INTO ssdlc_decisions (
          workspace_id, spec_slug, spec_version, run_id, story_id, phase_id, gate_id,
          decision_type, rationale, evidence_gap, subject_type, subject_value,
          policy_version, policy_reference, policy_authorized,
          principal_type, principal_id, principal_display_label, actor,
          delegated_principal_id, delegated_display_label,
          source_request_id, source_channel, scope_key, request_hash, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, TRUE,
          $15, $16, $17, $17,
          $18, $19,
          $20, $21, $22, $23, $24
        )
        RETURNING *
      `, [
        candidate.workspaceId,
        candidate.specSlug,
        candidate.specVersion,
        candidate.runId,
        candidate.storyId,
        candidate.phaseId,
        candidate.gateId,
        candidate.decisionType,
        candidate.rationale,
        candidate.evidenceGap,
        candidate.subject?.type ?? null,
        candidate.subject?.value ?? null,
        candidate.policyVersion,
        candidate.policyReference,
        candidate.principal.principalType,
        candidate.principal.principalId,
        candidate.principal.displayLabel,
        candidate.principal.delegatedOnBehalfOf?.principalId ?? null,
        candidate.principal.delegatedOnBehalfOf?.displayLabel ?? null,
        candidate.sourceRequestId,
        candidate.principal.sourceChannel,
        candidate.scopeKey,
        candidate.requestHash,
        candidate.expiresAt,
      ])).rows[0];
      const walEvent = await insertWalEvent(client, inserted, 'recorded', candidate.principal);
      return { row: inserted, replayed: false, walEvent };
    });
  },

  async revoke(input, principal) {
    return await transaction(async (client) => {
      await lock(client, `ssdlc-decision-revoke:${input.workspaceId}:${input.decisionId}`);
      const existing = (await client.query<SsdlcDecisionRow>(`
        SELECT * FROM ssdlc_decisions
        WHERE workspace_id = $1 AND id = $2
        FOR UPDATE
      `, [input.workspaceId, input.decisionId])).rows[0];
      if (!existing) throw new NotFoundError('SSDLC decision', input.decisionId);
      if (existing.revoked_at) {
        const exactReplay = existing.revocation_source_request_id === input.sourceRequestId
          && existing.revocation_rationale === input.rationale
          && existing.revoked_by_principal_type === principal.principalType
          && existing.revoked_by_principal_id === principal.principalId;
        if (exactReplay) return { row: existing, replayed: true, walEvent: null };
        throw new ConflictError('SSDLC decision has already been revoked', {
          decisionId: input.decisionId,
          revokedAt: asIso(existing.revoked_at),
        });
      }
      const row = (await client.query<SsdlcDecisionRow>(`
        UPDATE ssdlc_decisions
        SET revoked_at = NOW(),
            revoked_by_principal_type = $3,
            revoked_by_principal_id = $4,
            revoked_by_display_label = $5,
            revocation_rationale = $6,
            revocation_source_request_id = $7
        WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
        RETURNING *
      `, [
        input.workspaceId,
        input.decisionId,
        principal.principalType,
        principal.principalId,
        principal.displayLabel,
        input.rationale,
        input.sourceRequestId,
      ])).rows[0];
      const walEvent = await insertWalEvent(client, row, 'revoked', principal);
      return { row, replayed: false, walEvent };
    });
  },

  async list(workspaceId, specSlug, phaseId, gateId, activeOnly) {
    return await query<SsdlcDecisionRow>(`
      SELECT * FROM ssdlc_decisions
      WHERE workspace_id = $1
        AND spec_slug = $2
        AND phase_id = $3
        AND ($4::text IS NULL OR gate_id = $4)
        ${activeOnly ? 'AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())' : ''}
      ORDER BY created_at DESC, id DESC
    `, [workspaceId, specSlug, phaseId, gateId]);
  },
};

function dependencies(overrides: SsdlcDecisionDependencies): Required<SsdlcDecisionDependencies> {
  return {
    store: overrides.store ?? pgStore,
    broadcast: overrides.broadcast ?? broadcastAll,
    now: overrides.now ?? (() => new Date()),
  };
}

/** Record one policy-authorized decision and emit SSE only after durable commit. */
export async function recordSsdlcDecision(
  input: RecordSsdlcDecisionInput,
  principal: DecisionPrincipal,
  dependencyOverrides: SsdlcDecisionDependencies = {},
): Promise<{ decision: SsdlcDecision; replayed: boolean }> {
  const deps = dependencies(dependencyOverrides);
  const now = deps.now();
  const workspaceId = text(input.workspaceId, 'workspaceId');
  const specSlug = text(input.specSlug, 'specSlug');
  const phaseIdText = text(input.phaseId, 'phaseId');
  if (!SSDLC_DECISION_TYPES.includes(input.decisionType)) {
    throw new ValidationError(`decisionType must be one of: ${SSDLC_DECISION_TYPES.join(', ')}`, { field: 'decisionType' });
  }
  const rationale = text(input.rationale, 'rationale', CONCRETE_RATIONALE_MIN_LENGTH);
  const gateId = optionalText(input.gateId, 'gateId');
  const evidenceGap = optionalText(input.evidenceGap, 'evidenceGap');
  const subject = normalizeSubject(input.subject);
  const expiresAt = normalizeExpiry(input.expiresAt, now);
  const sourceRequestId = text(input.sourceRequestId, 'sourceRequestId');
  const specVersion = normalizeVersion(input.specVersion);
  const runId = normalizeRunId(input.runId);
  const storyId = optionalText(input.storyId, 'storyId');
  const context = await deps.store.loadPolicyContext(workspaceId, specSlug);
  const phase = context.plan.phases.find((candidate) => candidate.phaseId === phaseIdText);
  if (!phase) throw new ValidationError(`phaseId '${phaseIdText}' is not present in the active lifecycle policy`, { phaseId: phaseIdText });
  const phaseId = phase.phaseId;
  const gate = gateFor(context.plan, gateId, phaseId);

  validatePolicy(context.plan, phaseId, gate, input.decisionType, principal, expiresAt, rationale, evidenceGap, subject);

  if (APPROVAL_TYPES.has(input.decisionType)) {
    const currentIdentity = (await deps.store.resolveCurrentIdentity(context, {
      workspaceId,
      specSlug,
      subject,
    })).toLowerCase();
    if (subject?.value !== currentIdentity) {
      throw new ConflictError('Approval subject does not match the current immutable revision/image identity', {
        reason: 'revision_mismatch',
        subjectType: subject?.type,
        requestedIdentity: subject?.value,
        currentIdentity,
      });
    }
  }

  const scopeKey = [specSlug, phaseId, gateId ?? '*', storyId ?? '*', runId ?? '*'].join('|');
  const policyReference = `${context.plan.policyVersion}:${gateId ?? phaseId}`;
  const hashBody = {
    workspaceId,
    specSlug,
    specVersion,
    runId,
    storyId,
    phaseId,
    gateId,
    decisionType: input.decisionType,
    rationale,
    evidenceGap,
    subject,
    expiresAt: expiresAt?.toISOString() ?? null,
    policyVersion: context.plan.policyVersion,
    policyReference,
    principalType: principal.principalType,
    principalId: principal.principalId,
    delegatedOnBehalfOf: principal.delegatedOnBehalfOf ?? null,
  };
  const result = await deps.store.persist({
    workspaceId,
    specSlug,
    specVersion,
    runId,
    storyId,
    phaseId,
    gateId,
    decisionType: input.decisionType,
    rationale,
    evidenceGap,
    subject,
    expiresAt,
    policyVersion: context.plan.policyVersion,
    policyReference,
    principal,
    sourceRequestId,
    scopeKey,
    requestHash: canonicalHash(hashBody),
  });
  if (result.walEvent) deps.broadcast(result.walEvent);
  return { decision: decisionFromRow(result.row), replayed: result.replayed };
}

/** Revoke one decision without deleting or rewriting its audit history. */
export async function revokeSsdlcDecision(
  input: RevokeSsdlcDecisionInput,
  principal: DecisionPrincipal,
  dependencyOverrides: SsdlcDecisionDependencies = {},
): Promise<{ decision: SsdlcDecision; replayed: boolean }> {
  const deps = dependencies(dependencyOverrides);
  const normalized = {
    workspaceId: text(input.workspaceId, 'workspaceId'),
    decisionId: text(input.decisionId, 'decisionId'),
    rationale: text(input.rationale, 'rationale', CONCRETE_RATIONALE_MIN_LENGTH),
    sourceRequestId: text(input.sourceRequestId, 'sourceRequestId'),
  };
  assertApprover(principal);
  const result = await deps.store.revoke(normalized, principal);
  if (result.walEvent) deps.broadcast(result.walEvent);
  return { decision: decisionFromRow(result.row), replayed: result.replayed };
}

async function evaluateActivity(
  decision: SsdlcDecision,
  activeIds: ReadonlySet<string>,
  context: PolicyContext,
  store: DecisionStore,
  now: Date,
): Promise<EvaluatedSsdlcDecision> {
  if (decision.revokedAt) return { ...decision, activity: 'revoked', inactiveReason: 'Decision was revoked' };
  if (decision.expiresAt && new Date(decision.expiresAt).getTime() <= now.getTime()) {
    return { ...decision, activity: 'expired', inactiveReason: 'Decision expired' };
  }
  if (!activeIds.has(decision.id)) {
    return { ...decision, activity: 'expired', inactiveReason: 'Decision is not active' };
  }
  if (decision.subject) {
    const currentIdentity = (await store.resolveCurrentIdentity(context, {
      workspaceId: decision.workspaceId,
      specSlug: decision.specSlug,
      subject: decision.subject,
    })).toLowerCase();
    if (decision.subject.value !== currentIdentity) {
      return {
        ...decision,
        activity: 'stale_revision',
        inactiveReason: `Stored ${decision.subject.type} no longer matches the current identity`,
      };
    }
  }
  return { ...decision, activity: 'active', inactiveReason: null };
}

/**
 * Derive state from active decisions on every read. The active query explicitly
 * excludes expired/revoked rows; immutable-subject mismatches are then marked stale.
 */
export async function getSsdlcDecisionState(
  scope: { workspaceId: string; specSlug: string; phaseId: string; gateId?: string | null },
  dependencyOverrides: SsdlcDecisionDependencies = {},
): Promise<SsdlcDecisionState> {
  const deps = dependencies(dependencyOverrides);
  const workspaceId = text(scope.workspaceId, 'workspaceId');
  const specSlug = text(scope.specSlug, 'specSlug');
  const phaseId = text(scope.phaseId, 'phaseId');
  const gateId = optionalText(scope.gateId, 'gateId');
  const context = await deps.store.loadPolicyContext(workspaceId, specSlug);
  if (!context.plan.phases.some((phase) => phase.phaseId === phaseId)) {
    throw new ValidationError(`phaseId '${phaseId}' is not present in the active lifecycle policy`, { phaseId });
  }
  const [historyRows, activeRows] = await Promise.all([
    deps.store.list(workspaceId, specSlug, phaseId, gateId, false),
    deps.store.list(workspaceId, specSlug, phaseId, gateId, true),
  ]);
  const activeIds = new Set(activeRows.map((row) => String(row.id)));
  const history = await Promise.all(historyRows.map((row) =>
    evaluateActivity(decisionFromRow(row), activeIds, context, deps.store, deps.now())));
  const effectiveDecisions = history.filter((decision) => decision.activity === 'active');
  const types = new Set(effectiveDecisions.map((decision) => decision.decisionType));
  const state: DerivedDecisionState = types.has('defer')
    ? 'deferred'
    : types.has('not_applicable_confirmation')
      ? 'not_applicable'
      : types.has('gate_override')
        || types.has('qa_approval')
        || types.has('merge_approval')
        || types.has('production_approval')
        ? 'approved'
        : 'pending';
  return { state, effectiveDecisions, history };
}
