/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';

export interface BountyFeaturePolicy {
  enabled: boolean;
  state: 'enabled' | 'disabled';
  revision: number;
  authoritySource: string;
}

export interface BountyQualificationStatus {
  state: 'requalification-required';
  featureState: 'disabled';
  releaseEnableAvailable: false;
  qualificationMode: 'hermetic';
  requiredSuiteCount: number;
  fixturePassedSuiteCount: number;
  requiredControlProofCount: number;
  requalificationTriggerCount: number;
  reason: string;
}

export interface MissionAuthorityProjection {
  id: string;
  programId: string;
  programName: string;
  programRevision: number;
  title: string;
  state: string;
  epoch: number;
  contractHash: string;
  scopeHash: string;
  scopeExpiresAt: string;
  budgetRevision: number | null;
  budgetLimitCents: number | null;
  workTotal: number;
  workActive: number;
  evidenceTotal: number;
  findingTotal: number;
  draftTotal: number;
  holdTotal: number;
  createdAt: string;
}

export interface WorkPackageProjection {
  id: string;
  releaseSequence: number;
  status: string;
  packageHash: string;
  createdAt: string;
}

export interface EvidenceProjection {
  id: string;
  evidenceIdentity: string;
  digest: string;
  authorityEpoch: number;
  createdAt: string;
}

export interface FindingProjection {
  id: string;
  findingIdentity: string;
  status: string;
  authorityEpoch: number;
  createdAt: string;
}

export interface HoldProjection {
  id: string;
  reason: string;
  createdAt: string;
  releasedAt: string | null;
}

export interface DraftProjection {
  id: string;
  findingId: string;
  revision: number;
  bundleHash: string;
  markdownHash: string;
  jsonHash: string;
  releaseStatus: string;
  createdAt: string;
}

export interface SessionEventProjection {
  id: string;
  cursor: number;
  eventIdentity: string;
  sourceRole: string;
  workerId: string;
  sessionId: string;
  eventType: string;
  sourceHash: string;
  occurredAt: string;
}

export interface TelemetryProjection {
  workerId: string;
  phase: string;
  activity: string;
  skill: string;
  model: string;
  costMicrousd: number;
  requests: number;
  effectCalls: number;
}

export interface MissionControlProjection {
  mission: MissionAuthorityProjection;
  work: WorkPackageProjection[];
  evidence: EvidenceProjection[];
  findings: FindingProjection[];
  holds: HoldProjection[];
  drafts: DraftProjection[];
  sessions: { events: SessionEventProjection[]; nextCursor: number; hasMore: boolean };
  telemetry: TelemetryProjection[];
}

export interface MissionControlIdentity {
  workspaceId: string;
  programId: string;
  missionId: string;
}

export interface MissionControlReceipt {
  receiptId: string;
  action?: string;
  state?: string;
  epoch?: number;
  replayed: boolean;
  uncertainEffects?: number;
  cancelledPreparedEffects?: number;
  bundleHash?: string;
  submitted?: false;
}

type ApiRecord = Record<string, unknown>;
type Page = { items?: ApiRecord[] };

const text = (row: ApiRecord, camel: string, snake = camel): string => String(row[camel] ?? row[snake] ?? '');
const number = (row: ApiRecord, camel: string, snake = camel): number => Number(row[camel] ?? row[snake] ?? 0);
const nullableNumber = (row: ApiRecord, camel: string, snake = camel): number | null => {
  const value = row[camel] ?? row[snake];
  return value === null || value === undefined ? null : Number(value);
};
const nullableText = (row: ApiRecord, camel: string, snake = camel): string | null => {
  const value = row[camel] ?? row[snake];
  return value === null || value === undefined ? null : String(value);
};

function query(identity: MissionControlIdentity): string {
  const params = new URLSearchParams({ workspaceId: identity.workspaceId, programId: identity.programId });
  return params.toString();
}

export function getBountyFeaturePolicy(): Promise<BountyFeaturePolicy> {
  return apiFetch<BountyFeaturePolicy>('/api/admin/bounty/policy', { silent: true });
}

export function getBountyQualificationStatus(): Promise<BountyQualificationStatus> {
  return apiFetch<BountyQualificationStatus>('/api/admin/bounty/qualification', { silent: true });
}

export async function getMissionAuthority(identity: MissionControlIdentity): Promise<MissionAuthorityProjection> {
  const row = await apiFetch<ApiRecord>(`/api/bounty/missions/${encodeURIComponent(identity.missionId)}?${query(identity)}`, { silent: true });
  return {
    id: text(row, 'id'),
    programId: text(row, 'programId', 'program_id'),
    programName: text(row, 'programName', 'program_name'),
    programRevision: number(row, 'programRevision', 'program_revision'),
    title: text(row, 'title'),
    state: text(row, 'state'),
    epoch: number(row, 'epoch'),
    contractHash: text(row, 'contractHash', 'contract_hash'),
    scopeHash: text(row, 'scopeHash', 'scope_hash'),
    scopeExpiresAt: text(row, 'scopeExpiresAt', 'scope_expires_at'),
    budgetRevision: nullableNumber(row, 'budgetRevision', 'budget_revision'),
    budgetLimitCents: nullableNumber(row, 'budgetLimitCents', 'budget_limit_cents'),
    workTotal: number(row, 'workTotal', 'work_total'),
    workActive: number(row, 'workActive', 'work_active'),
    evidenceTotal: number(row, 'evidenceTotal', 'evidence_total'),
    findingTotal: number(row, 'findingTotal', 'finding_total'),
    draftTotal: number(row, 'draftTotal', 'draft_total'),
    holdTotal: number(row, 'holdTotal', 'hold_total'),
    createdAt: text(row, 'createdAt', 'created_at'),
  };
}

async function list(identity: MissionControlIdentity, resource: 'work' | 'evidence' | 'findings' | 'holds' | 'drafts'): Promise<ApiRecord[]> {
  // Deliberately never append `raw=true`: Mission Control consumes redacted metadata projections only.
  const page = await apiFetch<Page>(`/api/bounty/missions/${encodeURIComponent(identity.missionId)}/${resource}?${query(identity)}&limit=100`, { silent: true });
  return page.items ?? [];
}

export async function getSessionEvents(identity: MissionControlIdentity, after = 0): Promise<MissionControlProjection['sessions']> {
  const params = new URLSearchParams({ workspaceId: identity.workspaceId, after: String(after), limit: '200' });
  const page = await apiFetch<{ events?: ApiRecord[]; nextCursor?: number; hasMore?: boolean }>(
    `/api/admin/bounty/sessions/${encodeURIComponent(identity.missionId)}/events?${params.toString()}`,
    { silent: true },
  );
  return {
    events: (page.events ?? []).map((row) => ({
      id: text(row, 'id'), cursor: number(row, 'cursor'), eventIdentity: text(row, 'eventIdentity', 'event_identity'),
      sourceRole: text(row, 'sourceRole', 'source_role'), workerId: text(row, 'workerId', 'worker_id'),
      sessionId: text(row, 'sessionId', 'session_id'), eventType: text(row, 'eventType', 'event_type'),
      sourceHash: text(row, 'sourceHash', 'source_hash'), occurredAt: text(row, 'occurredAt', 'occurred_at'),
    })),
    nextCursor: Number(page.nextCursor ?? after),
    hasMore: Boolean(page.hasMore),
  };
}

async function getTelemetry(identity: MissionControlIdentity): Promise<TelemetryProjection[]> {
  const params = new URLSearchParams({ workspaceId: identity.workspaceId });
  const result = await apiFetch<{ dimensions?: ApiRecord[] }>(
    `/api/admin/bounty/sessions/${encodeURIComponent(identity.missionId)}/telemetry?${params.toString()}`,
    { silent: true },
  );
  return (result.dimensions ?? []).map((row) => ({
    workerId: text(row, 'workerId', 'worker_id'), phase: text(row, 'phase'), activity: text(row, 'activity'),
    skill: text(row, 'skill'), model: text(row, 'model'), costMicrousd: number(row, 'costMicrousd', 'cost_microusd'),
    requests: number(row, 'requests'), effectCalls: number(row, 'effectCalls', 'effect_calls'),
  }));
}

export async function loadMissionControl(identity: MissionControlIdentity): Promise<MissionControlProjection> {
  const [mission, workRows, evidenceRows, findingRows, holdRows, draftRows, sessions, telemetry] = await Promise.all([
    getMissionAuthority(identity), list(identity, 'work'), list(identity, 'evidence'), list(identity, 'findings'),
    list(identity, 'holds'), list(identity, 'drafts'), getSessionEvents(identity), getTelemetry(identity),
  ]);
  return {
    mission,
    work: workRows.map((row) => ({ id: text(row, 'id'), releaseSequence: number(row, 'releaseSequence', 'release_sequence'), status: text(row, 'status'), packageHash: text(row, 'packageHash', 'package_hash'), createdAt: text(row, 'createdAt', 'created_at') })),
    evidence: evidenceRows.map((row) => ({ id: text(row, 'id'), evidenceIdentity: text(row, 'evidenceIdentity', 'evidence_identity'), digest: text(row, 'digest'), authorityEpoch: number(row, 'authorityEpoch', 'authority_epoch'), createdAt: text(row, 'createdAt', 'created_at') })),
    findings: findingRows.map((row) => ({ id: text(row, 'id'), findingIdentity: text(row, 'findingIdentity', 'finding_identity'), status: text(row, 'status'), authorityEpoch: number(row, 'authorityEpoch', 'authority_epoch'), createdAt: text(row, 'createdAt', 'created_at') })),
    holds: holdRows.map((row) => ({ id: text(row, 'id'), reason: text(row, 'reason'), createdAt: text(row, 'createdAt', 'created_at'), releasedAt: nullableText(row, 'releasedAt', 'released_at') })),
    drafts: draftRows.map((row) => ({ id: text(row, 'id'), findingId: text(row, 'findingId', 'finding_id'), revision: number(row, 'revision'), bundleHash: text(row, 'bundleHash', 'bundle_hash'), markdownHash: text(row, 'markdownHash', 'markdown_hash'), jsonHash: text(row, 'jsonHash', 'json_hash'), releaseStatus: text(row, 'releaseStatus', 'release_status'), createdAt: text(row, 'createdAt', 'created_at') })),
    sessions, telemetry,
  };
}

function idempotencyKey(action: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `mission-control-${action}-${id}`;
}

export async function mutateMissionControl(
  identity: MissionControlIdentity,
  action: 'pause' | 'stop' | 'kill' | 'hold-release' | 'approve-readiness' | 'reject',
  input: { expectedEpoch: number; reason: string; holdId?: string; draftId?: string },
): Promise<MissionControlReceipt> {
  let path: string;
  if (action === 'hold-release') {
    path = `/api/bounty/missions/${encodeURIComponent(identity.missionId)}/holds/${encodeURIComponent(input.holdId ?? '')}/release`;
  } else if (action === 'approve-readiness' || action === 'reject') {
    path = `/api/bounty/missions/${encodeURIComponent(identity.missionId)}/drafts/${encodeURIComponent(input.draftId ?? '')}/release-review`;
  } else {
    path = `/api/bounty/missions/${encodeURIComponent(identity.missionId)}/${action}`;
  }
  const isDraftReview = action === 'approve-readiness' || action === 'reject';
  return apiFetch<MissionControlReceipt>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey(action) },
    body: JSON.stringify(isDraftReview
      ? { workspaceId: identity.workspaceId, programId: identity.programId, decision: action, reason: input.reason }
      : { workspaceId: identity.workspaceId, programId: identity.programId, expectedEpoch: input.expectedEpoch, reason: input.reason }),
    silent: true,
  });
}
