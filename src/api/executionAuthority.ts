/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  ApiError,
  apiFetch,
  apiFetchAuthorityMutation,
} from '../lib/apiFetch';

export type AuthorityRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
export type AuthorityAction = 'approve' | 'deny' | 'cancel';
export type AuthorityJson = null | boolean | number | string | AuthorityJson[] | { [key: string]: AuthorityJson };

export interface AuthorityRequestProjection {
  schemaVersion: 'rorca.execution-authority.v1';
  id: string;
  intentId: string;
  workspaceId: string;
  runId: number;
  storyId: string;
  requestingPrincipal: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  environment: string;
  providerResourceId: string;
  operation: string;
  constraints: AuthorityJson;
  evidenceDigest: string;
  requestDigest: string;
  status: AuthorityRequestStatus;
  maximumUses: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface AuthorityDecisionProjection {
  operatorPrincipal: string;
  decision: 'approved' | 'denied';
  reasonCode: string;
  createdAt: string;
}

export interface AuthorityGrantProjection {
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  maximumUses: number;
  usesConsumed: number;
  fencingGeneration: number;
  expiresAt: string;
}

export interface AuthorityRequestDetailProjection {
  request: AuthorityRequestProjection;
  decision: AuthorityDecisionProjection | null;
  grant: AuthorityGrantProjection | null;
  bindingHealth: 'healthy' | 'unhealthy' | 'not_assessed';
}

export interface AuthorityRequestPage {
  items: AuthorityRequestProjection[];
  total: number;
  hasMore: boolean;
}

export interface AuthorityRunStateProjection {
  runId: number;
  workspaceId: string;
  status: string;
  lifecycleStatus: string;
  waitExpiresAt: string | null;
}
export const EXECUTION_AUTHORITY_EVIDENCE_KINDS = [
  'migration',
  'api',
  'ui',
  'crash_recovery',
  'redaction',
  'disposable_fixture_smoke',
] as const;
export type ExecutionAuthorityEvidenceKind = typeof EXECUTION_AUTHORITY_EVIDENCE_KINDS[number];

export interface ExecutionAuthorityEvidenceProjection {
  id: string;
  schemaVersion: 'rorca.execution-authority-rollout-evidence.v1';
  evidenceKind: ExecutionAuthorityEvidenceKind;
  result: 'passed' | 'failed';
  artifactReference: string;
  evidenceDigest: string;
  observedAt: string;
  operatorPrincipal: string;
  createdAt: string;
}

export interface ExecutionAuthorityProfileProjection {
  schemaVersion: 'rorca.execution-authority-profile.v1';
  policyVersion: 'rorca.execution-authority-rollout.v1';
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
  mutationProviderAdapterIds: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_KEY_PATTERN = /(^|[_-])(secret|credential|password|token|authorization|private[_-]?key)([_-]|$)/i;
const CREDENTIAL_VALUE_PATTERNS = [
  /(?:^|\s)(?:Bearer|Basic)\s+[A-Za-z0-9+/=_:.-]{4,}/i,
  /gh[pousr]_[A-Za-z0-9_]{8,}/i,
  /sk-[A-Za-z0-9_-]{16,}/i,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
  /\b(?:rea-\d+-|rorca[-_])?secret[-_]canary[-_](?:value|[a-z0-9]{12,})\b/i,
] as const;
const MAX_BOUNDARY_DEPTH = 32;
const MAX_BOUNDARY_CHARS = 256 * 1024;

export class AuthorityUiBoundaryError extends Error {
  constructor() {
    super('Execution Authority response failed the redacted UI boundary');
    this.name = 'AuthorityUiBoundaryError';
  }
}

/** Reject credential-shaped keys and values before any authority response reaches React state. */
export function assertAuthorityUiRedactedValue(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): asserts value is AuthorityJson {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) throw new AuthorityUiBoundaryError();
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AuthorityUiBoundaryError();
    return;
  }
  if (typeof value !== 'object' || value instanceof Date || seen.has(value) || depth > MAX_BOUNDARY_DEPTH) {
    throw new AuthorityUiBoundaryError();
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertAuthorityUiRedactedValue(item, seen, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_PATTERN.test(key) || item === undefined) throw new AuthorityUiBoundaryError();
      assertAuthorityUiRedactedValue(item, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
  if (depth === 0) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new AuthorityUiBoundaryError();
    }
    if (serialized.length > MAX_BOUNDARY_CHARS) throw new AuthorityUiBoundaryError();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthorityUiBoundaryError();
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || !value) throw new AuthorityUiBoundaryError();
  return value;
}

function dateField(source: Record<string, unknown>, key: string): string {
  const value = stringField(source, key);
  if (!Number.isFinite(Date.parse(value))) throw new AuthorityUiBoundaryError();
  return value;
}

function integerField(source: Record<string, unknown>, key: string, minimum = 0): number {
  const value = source[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new AuthorityUiBoundaryError();
  return value as number;
}

function nullableStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new AuthorityUiBoundaryError();
  return value;
}
function nullableDateField(source: Record<string, unknown>, key: string): string | null {
  const value = nullableStringField(source, key);
  if (value !== null && !Number.isFinite(Date.parse(value))) throw new AuthorityUiBoundaryError();
  return value;
}

function booleanField(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') throw new AuthorityUiBoundaryError();
  return value;
}

function parseAuthorityRequest(value: unknown): AuthorityRequestProjection {
  assertAuthorityUiRedactedValue(value);
  const source = record(value);
  const status = stringField(source, 'status');
  if (!['pending', 'approved', 'denied', 'cancelled', 'expired'].includes(status)) throw new AuthorityUiBoundaryError();
  const id = stringField(source, 'id');
  const intentId = stringField(source, 'intentId');
  const requestDigest = stringField(source, 'requestDigest');
  const evidenceDigest = stringField(source, 'evidenceDigest');
  const schemaVersion = stringField(source, 'schemaVersion');
  const resolvedAt = nullableStringField(source, 'resolvedAt');
  if (schemaVersion !== 'rorca.execution-authority.v1'
    || (resolvedAt !== null && !Number.isFinite(Date.parse(resolvedAt)))) {
    throw new AuthorityUiBoundaryError();
  }
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(intentId)
    || !DIGEST_PATTERN.test(requestDigest) || !DIGEST_PATTERN.test(evidenceDigest)) {
    throw new AuthorityUiBoundaryError();
  }
  const constraints = source.constraints;
  assertAuthorityUiRedactedValue(constraints);
  return {
    schemaVersion,
    id,
    intentId,
    workspaceId: stringField(source, 'workspaceId'),
    runId: integerField(source, 'runId', 1),
    storyId: stringField(source, 'storyId'),
    requestingPrincipal: stringField(source, 'requestingPrincipal'),
    capabilityId: stringField(source, 'capabilityId'),
    bindingReference: stringField(source, 'bindingReference'),
    bindingGeneration: integerField(source, 'bindingGeneration', 1),
    environment: stringField(source, 'environment'),
    providerResourceId: stringField(source, 'providerResourceId'),
    operation: stringField(source, 'operation'),
    constraints,
    evidenceDigest,
    requestDigest,
    status: status as AuthorityRequestStatus,
    maximumUses: integerField(source, 'maximumUses', 1),
    expiresAt: dateField(source, 'expiresAt'),
    createdAt: dateField(source, 'createdAt'),
    updatedAt: dateField(source, 'updatedAt'),
    resolvedAt,
  };
}

function parseAuthorityDecision(value: unknown): AuthorityDecisionProjection | null {
  if (value === null) return null;
  const source = record(value);
  const decision = stringField(source, 'decision');
  if (decision !== 'approved' && decision !== 'denied') throw new AuthorityUiBoundaryError();
  return {
    operatorPrincipal: stringField(source, 'operatorPrincipal'),
    decision,
    reasonCode: stringField(source, 'reasonCode'),
    createdAt: dateField(source, 'createdAt'),
  };
}

function parseAuthorityGrant(value: unknown): AuthorityGrantProjection | null {
  if (value === null) return null;
  const source = record(value);
  const status = stringField(source, 'status');
  if (!['active', 'exhausted', 'expired', 'revoked'].includes(status)) throw new AuthorityUiBoundaryError();
  return {
    status: status as AuthorityGrantProjection['status'],
    maximumUses: integerField(source, 'maximumUses', 1),
    usesConsumed: integerField(source, 'usesConsumed'),
    fencingGeneration: integerField(source, 'fencingGeneration', 1),
    expiresAt: dateField(source, 'expiresAt'),
  };
}
function parseAuthorityEvidence(value: unknown): ExecutionAuthorityEvidenceProjection {
  assertAuthorityUiRedactedValue(value);
  const source = record(value);
  const evidenceKind = stringField(source, 'evidenceKind');
  const result = stringField(source, 'result');
  const evidenceDigest = stringField(source, 'evidenceDigest');
  if (!EXECUTION_AUTHORITY_EVIDENCE_KINDS.includes(evidenceKind as ExecutionAuthorityEvidenceKind)
    || (result !== 'passed' && result !== 'failed')
    || !DIGEST_PATTERN.test(evidenceDigest)
    || stringField(source, 'schemaVersion') !== 'rorca.execution-authority-rollout-evidence.v1') {
    throw new AuthorityUiBoundaryError();
  }
  return {
    id: stringField(source, 'id'),
    schemaVersion: 'rorca.execution-authority-rollout-evidence.v1',
    evidenceKind: evidenceKind as ExecutionAuthorityEvidenceKind,
    result,
    artifactReference: stringField(source, 'artifactReference'),
    evidenceDigest,
    observedAt: dateField(source, 'observedAt'),
    operatorPrincipal: stringField(source, 'operatorPrincipal'),
    createdAt: dateField(source, 'createdAt'),
  };
}

function parseAuthorityProfile(value: unknown, expectedWorkspaceId: string): ExecutionAuthorityProfileProjection {
  assertAuthorityUiRedactedValue(value);
  const source = record(value);
  const state = stringField(source, 'state');
  if (state !== 'disabled' && state !== 'enabled') throw new AuthorityUiBoundaryError();
  if (stringField(source, 'schemaVersion') !== 'rorca.execution-authority-profile.v1'
    || stringField(source, 'policyVersion') !== 'rorca.execution-authority-rollout.v1'
    || stringField(source, 'workspaceId') !== expectedWorkspaceId
    || !Array.isArray(source.evidence)
    || !Array.isArray(source.missingEvidenceKinds)
    || !Array.isArray(source.mutationProviderAdapterIds)) {
    throw new AuthorityUiBoundaryError();
  }
  const missingEvidenceKinds = source.missingEvidenceKinds.map((kind) => {
    if (typeof kind !== 'string' || !EXECUTION_AUTHORITY_EVIDENCE_KINDS.includes(kind as ExecutionAuthorityEvidenceKind)) {
      throw new AuthorityUiBoundaryError();
    }
    return kind as ExecutionAuthorityEvidenceKind;
  });
  const mutationProviderAdapterIds = source.mutationProviderAdapterIds.map((adapterId) => {
    if (typeof adapterId !== 'string' || !adapterId) throw new AuthorityUiBoundaryError();
    return adapterId;
  });
  return {
    schemaVersion: 'rorca.execution-authority-profile.v1',
    policyVersion: 'rorca.execution-authority-rollout.v1',
    workspaceId: expectedWorkspaceId,
    state,
    generation: integerField(source, 'generation', 1),
    transitionPrincipal: stringField(source, 'transitionPrincipal'),
    createdAt: dateField(source, 'createdAt'),
    updatedAt: dateField(source, 'updatedAt'),
    enabledAt: nullableDateField(source, 'enabledAt'),
    disabledAt: nullableDateField(source, 'disabledAt'),
    readyToEnable: booleanField(source, 'readyToEnable'),
    missingEvidenceKinds,
    evidence: source.evidence.map(parseAuthorityEvidence),
    evidenceHistoryCount: integerField(source, 'evidenceHistoryCount'),
    mutationProviderAdapterIds,
  };
}

function workspacePathSegment(workspaceId: string): string {
  const value = workspaceId.trim();
  if (!value || value.length > 160 || /[/\\\u0000-\u001f\u007f]/.test(value)) throw new AuthorityUiBoundaryError();
  return encodeURIComponent(value);
}

function requestPath(workspaceId: string, requestId?: string): string {
  const base = `/api/admin/execution-authority/workspaces/${workspacePathSegment(workspaceId)}/requests`;
  if (requestId === undefined) return base;
  if (!UUID_PATTERN.test(requestId)) throw new AuthorityUiBoundaryError();
  return `${base}/${requestId}`;
}
function profilePath(workspaceId: string): string {
  return `/api/admin/execution-authority/workspaces/${workspacePathSegment(workspaceId)}/profile`;
}

export async function getExecutionAuthorityProfile(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ExecutionAuthorityProfileProjection> {
  const response = await apiFetch<unknown>(profilePath(workspaceId), { signal, silent: true });
  return parseAuthorityProfile(response, workspaceId);
}

export async function transitionExecutionAuthorityProfile(input: {
  workspaceId: string;
  enabled: boolean;
  expectedGeneration: number;
}): Promise<ExecutionAuthorityProfileProjection> {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw new AuthorityUiBoundaryError();
  }
  const response = await apiFetchAuthorityMutation<unknown>(profilePath(input.workspaceId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: input.enabled,
      expectedGeneration: input.expectedGeneration,
    }),
    silent: true,
  });
  assertAuthorityUiRedactedValue(response);
  const source = record(response);
  return parseAuthorityProfile('profile' in source ? source.profile : source, input.workspaceId);
}

export async function attachExecutionAuthorityRolloutEvidence(input: {
  workspaceId: string;
  evidenceKind: ExecutionAuthorityEvidenceKind;
  result: 'passed' | 'failed';
  artifactReference: string;
  evidenceDigest: string;
  observedAt: string;
}): Promise<ExecutionAuthorityProfileProjection> {
  if (!EXECUTION_AUTHORITY_EVIDENCE_KINDS.includes(input.evidenceKind)
    || !DIGEST_PATTERN.test(input.evidenceDigest)
    || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new AuthorityUiBoundaryError();
  }
  const response = await apiFetchAuthorityMutation<unknown>(`${profilePath(input.workspaceId)}/evidence`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `execution-authority-ui:evidence:${input.evidenceKind}:${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      evidenceKind: input.evidenceKind,
      result: input.result,
      artifactReference: input.artifactReference,
      evidenceDigest: input.evidenceDigest,
      observedAt: input.observedAt,
    }),
    silent: true,
  });
  return parseAuthorityProfile(response, input.workspaceId);
}
export async function listAuthorityRequests(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<AuthorityRequestPage> {
  const response = await apiFetch<unknown>(`${requestPath(workspaceId)}?limit=250`, { signal, silent: true });
  assertAuthorityUiRedactedValue(response);
  const source = record(response);
  if (!Array.isArray(source.items) || typeof source.hasMore !== 'boolean') throw new AuthorityUiBoundaryError();
  const items = source.items
    .map(parseAuthorityRequest)
    .filter((request) => request.workspaceId === workspaceId);
  return {
    items,
    total: items.length,
    hasMore: source.hasMore,
  };
}

export async function getAuthorityRequestDetail(
  workspaceId: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<AuthorityRequestDetailProjection> {
  const response = await apiFetch<unknown>(requestPath(workspaceId, requestId), { signal, silent: true });
  assertAuthorityUiRedactedValue(response);
  const source = record(response);
  const bindingHealth = stringField(source, 'bindingHealth');
  if (!['healthy', 'unhealthy', 'not_assessed'].includes(bindingHealth)) throw new AuthorityUiBoundaryError();
  const request = parseAuthorityRequest(source.request);
  if (request.workspaceId !== workspaceId || request.id !== requestId) throw new AuthorityUiBoundaryError();
  return {
    request,
    decision: parseAuthorityDecision(source.decision),
    grant: parseAuthorityGrant(source.grant),
    bindingHealth: bindingHealth as AuthorityRequestDetailProjection['bindingHealth'],
  };
}

export async function getAuthorityRunState(
  workspaceId: string,
  runId: number,
  signal?: AbortSignal,
): Promise<AuthorityRunStateProjection> {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new AuthorityUiBoundaryError();
  const response = record(await apiFetch<unknown>(`/api/pipeline/runs/${runId}`, { signal, silent: true }));
  const run = record(response.run);
  const responseWorkspaceId = stringField(run, 'workspace_id');
  if (responseWorkspaceId !== workspaceId) throw new AuthorityUiBoundaryError();
  const status = stringField(run, 'status');
  const lifecycleStatus = typeof run.lifecycleStatus === 'string'
    ? run.lifecycleStatus
    : stringField(run, 'lifecycle_status');
  let diagnostics: Record<string, unknown> | null = null;
  if (typeof run.lifecycle_diagnostics === 'string') {
    try {
      diagnostics = record(JSON.parse(run.lifecycle_diagnostics));
    } catch {
      throw new AuthorityUiBoundaryError();
    }
  } else if (run.lifecycle_diagnostics !== null && run.lifecycle_diagnostics !== undefined) {
    diagnostics = record(run.lifecycle_diagnostics);
  }
  const waitExpiresAt = diagnostics?.authorityWaitExpiresAt;
  if (waitExpiresAt !== undefined && waitExpiresAt !== null
    && (typeof waitExpiresAt !== 'string' || !Number.isFinite(Date.parse(waitExpiresAt)))) {
    throw new AuthorityUiBoundaryError();
  }
  const projection = {
    runId,
    workspaceId,
    status,
    lifecycleStatus,
    waitExpiresAt: typeof waitExpiresAt === 'string' ? waitExpiresAt : null,
  };
  assertAuthorityUiRedactedValue(projection);
  return projection;
}

export async function mutateAuthorityRequest(input: {
  workspaceId: string;
  requestId: string;
  requestDigest: string;
  action: AuthorityAction;
  reasonCode?: string;
}): Promise<void> {
  if (!DIGEST_PATTERN.test(input.requestDigest)) throw new AuthorityUiBoundaryError();
  const body = input.action === 'cancel'
    ? { requestDigest: input.requestDigest }
    : { requestDigest: input.requestDigest, reasonCode: input.reasonCode };
  const idempotencyKey = `execution-authority-ui:${input.action}:${input.requestId}:${crypto.randomUUID()}`;
  const response = await apiFetchAuthorityMutation<unknown>(
    `${requestPath(input.workspaceId, input.requestId)}/${input.action}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      silent: true,
    },
  );
  assertAuthorityUiRedactedValue(response);
}

/** Fixed-copy error projection: backend values never become operator DOM text. */
export function authorityUiErrorMessage(error: unknown): string {
  if (error instanceof AuthorityUiBoundaryError) return error.message;
  if (error instanceof ApiError) {
    if (error.code === 'OPERATOR_CAPABILITY_REQUIRED') {
      return 'Unlock the local operator capability in Settings before deciding authority requests.';
    }
    if (error.code === 'AUTHORITY_REQUEST_ALTERED' || error.code === 'AUTHORITY_REQUEST_REPLAYED'
      || error.code === 'AUTHORITY_BINDING_STALE' || error.status === 409 || error.status === 410) {
      return 'This exact request is stale. Review the refreshed digest and state before taking another action.';
    }
    if (error.status === 403) return 'This session is not permitted to decide Execution Authority requests.';
  }
  return 'Execution Authority data is temporarily unavailable. Retry without changing the request.';
}
