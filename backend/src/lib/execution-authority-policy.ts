/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import {
  EXECUTION_AUTHORITY_SCHEMA_VERSION,
  appendAuthorityWalEvent,
  consumeAuthorityGrant,
  createAuthorityGrant,
  createAuthorityRequest,
  expireAuthorityGrant,
  getAuthorityDecisionForRequest,
  getAuthorityGrant,
  getAuthorityGrantForRequest,
  getAuthorityRequest,
  getAuthorityRequestByIdempotencyKey,
  getExecutionReceipt,
  getOperationIntent,
  getProviderBindingByReference,
  listAuthorityRequestsPage,
  listExecutionReceiptsPage,
  recordAuthorityDecision,
  transitionOperationIntent,
  updateAuthorityRequestStatus,
  type AuthorityDecisionKind,
  type AuthorityDecisionRecord,
  type AuthorityGrantRecord,
  type AuthorityJson,
  type AuthorityRequestRecord,
  type AuthorityRequestStatus,
  type AuthorityScope,
  type ExecutionReceiptRecord,
  type OperationIntentRecord,
  type ProviderBindingRecord,
} from '../db/execution-authority';
import { transaction } from '../db/index';
import {
  getAuthorityRequestBindingHealth,
  type AuthorityBindingHealth,
} from '../db/execution-authority-preflight';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';
import { decodeCursor, encodeCursor, type PaginatedResponse, type PaginationParams } from './paginate';
import { assertAuthorityRedactedValue } from './authority-redaction';

export const AUTHORITY_POLICY_SCHEMA_VERSION = 'rorca.execution-authority-policy.v1' as const;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_IDEMPOTENCY_KEY_BYTES = 512;

export const AUTHORITY_APPROVAL_REASON_CODES = [
  'scope_reviewed',
  'change_window_confirmed',
  'policy_exception_approved',
] as const;
export const AUTHORITY_DENIAL_REASON_CODES = [
  'scope_rejected',
  'evidence_insufficient',
  'binding_unhealthy',
  'request_not_needed',
] as const;
export type AuthorityApprovalReasonCode = typeof AUTHORITY_APPROVAL_REASON_CODES[number];
export type AuthorityDenialReasonCode = typeof AUTHORITY_DENIAL_REASON_CODES[number];
export type AuthorityDecisionReasonCode = AuthorityApprovalReasonCode | AuthorityDenialReasonCode;

export type AuthorityFailureCode =
  | 'AUTHORITY_REQUEST_DENIED'
  | 'AUTHORITY_REQUEST_CANCELLED'
  | 'AUTHORITY_REQUEST_EXPIRED'
  | 'AUTHORITY_REQUEST_ALTERED'
  | 'AUTHORITY_REQUEST_REPLAYED'
  | 'AUTHORITY_BINDING_STALE'
  | 'AUTHORITY_GRANT_EXPIRED'
  | 'AUTHORITY_GRANT_REVOKED'
  | 'AUTHORITY_GRANT_ALTERED'
  | 'AUTHORITY_GRANT_REPLAYED'
  | 'AUTHORITY_GRANT_OVER_USED';

export interface AuthorityFailureProjection {
  schemaVersion: typeof AUTHORITY_POLICY_SCHEMA_VERSION;
  code: AuthorityFailureCode;
  state: string;
  retryable: false;
  requestId?: string;
  grantId?: string;
}

const FAILURE_MESSAGES: Readonly<Record<AuthorityFailureCode, string>> = {
  AUTHORITY_REQUEST_DENIED: 'Authority request was denied',
  AUTHORITY_REQUEST_CANCELLED: 'Authority request was cancelled',
  AUTHORITY_REQUEST_EXPIRED: 'Authority request expired',
  AUTHORITY_REQUEST_ALTERED: 'Authority request digest does not match the current exact request',
  AUTHORITY_REQUEST_REPLAYED: 'Authority request has already been decided',
  AUTHORITY_BINDING_STALE: 'Authority request no longer has an active exact provider binding',
  AUTHORITY_GRANT_EXPIRED: 'Authority grant expired',
  AUTHORITY_GRANT_REVOKED: 'Authority grant was revoked',
  AUTHORITY_GRANT_ALTERED: 'Authority grant does not match the exact request and operation scope',
  AUTHORITY_GRANT_REPLAYED: 'Authority grant fencing generation is stale',
  AUTHORITY_GRANT_OVER_USED: 'Authority grant maximum use count is exhausted',
};

export class AuthorityPolicyError extends AppError {
  readonly statusCode: number;
  readonly failure: AuthorityFailureProjection;

  constructor(code: AuthorityFailureCode, state: string, ids: { requestId?: string; grantId?: string } = {}) {
    const failure: AuthorityFailureProjection = {
      schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
      code,
      state,
      retryable: false,
      ...ids,
    };
    super(FAILURE_MESSAGES[code], code, { failure });
    this.statusCode = code.endsWith('_EXPIRED') ? 410 : 409;
    this.failure = failure;
  }
}

export interface AuthorityScopeProjection {
  workspaceId: string;
  runId: number;
  storyId: string;
  environment: string;
  providerResourceId: string;
  operation: string;
}

export interface AuthorityRequestProjection extends AuthorityScopeProjection {
  schemaVersion: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION;
  id: string;
  intentId: string;
  requestingPrincipal: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
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
  schemaVersion: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  requestId: string;
  requestDigest: string;
  requestingPrincipal: string;
  operatorPrincipal: string;
  decision: AuthorityDecisionKind;
  decisionDigest: string;
  reasonCode: AuthorityDecisionReasonCode;
  createdAt: string;
}

export interface AuthorityGrantProjection extends AuthorityScopeProjection {
  schemaVersion: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION;
  id: string;
  requestId: string;
  decisionId: string;
  requestDigest: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  constraints: AuthorityJson;
  evidenceDigest: string;
  maximumUses: number;
  usesConsumed: number;
  fencingGeneration: number;
  status: AuthorityGrantRecord['status'];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface ExecutionReceiptProjection extends AuthorityScopeProjection {
  schemaVersion: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION;
  id: string;
  attemptId: string;
  intentId: string;
  grantId: string;
  requestDigest: string;
  receiptDigest: string;
  fencingGeneration: number;
  outcome: ExecutionReceiptRecord['outcome'];
  providerReceiptReference: string;
  redactedPayload: AuthorityJson;
  status: 'settled';
  retentionClass: ExecutionReceiptRecord['retentionClass'];
  retainedUntil: string | null;
  createdAt: string;
  settledAt: string;
}

export interface AuthorityRequestDetailProjection {
  request: AuthorityRequestProjection;
  decision: AuthorityDecisionProjection | null;
  grant: AuthorityGrantProjection | null;
  bindingHealth: AuthorityBindingHealth | 'not_assessed';
}

export interface AuthorityDecisionResultProjection {
  decision: AuthorityDecisionProjection;
  grant: AuthorityGrantProjection | null;
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('Authority digest input contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ValidationError('Authority digest input must not be cyclic');
    seen.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value !== 'object' || value instanceof Date) {
    throw new ValidationError('Authority digest input must contain only JSON values');
  }
  if (seen.has(value)) throw new ValidationError('Authority digest input must not be cyclic');
  seen.add(value);
  try {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new ValidationError('Authority digest input must not contain undefined values');
      return `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`;
    }).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function authorityDigest(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(domain).update('\0').update(canonicalJson(value)).digest('hex')}`;
}

function persistedIdempotencyKey(domain: string, supplied: string): `sha256:${string}` {
  if (typeof supplied !== 'string' || supplied.trim() === ''
    || Buffer.byteLength(supplied, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new ValidationError(`Idempotency-Key must contain between 1 and ${MAX_IDEMPOTENCY_KEY_BYTES} bytes`);
  }
  return authorityDigest(`rorca.execution-authority.idempotency.${domain}.v1`, supplied);
}

function requestDigest(intent: OperationIntentRecord, maximumUses: number, expiresAt: Date): `sha256:${string}` {
  return authorityDigest('rorca.execution-authority.request.v1', {
    schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
    intentId: intent.id,
    intentDigest: intent.canonicalDigest,
    workspaceId: intent.workspaceId,
    runId: intent.runId,
    storyId: intent.storyId,
    requestingPrincipal: intent.requestingPrincipal,
    capabilityId: intent.capabilityId,
    bindingReference: intent.bindingReference,
    bindingGeneration: intent.bindingGeneration,
    environment: intent.environment,
    providerResourceId: intent.providerResourceId,
    operation: intent.operation,
    constraints: intent.constraints,
    evidenceDigest: intent.evidenceDigest,
    maximumUses,
    expiresAt: expiresAt.toISOString(),
  });
}

function decisionDigest(input: {
  request: AuthorityRequestRecord;
  operatorPrincipal: string;
  decision: AuthorityDecisionKind;
  reasonCode: AuthorityDecisionReasonCode;
}): `sha256:${string}` {
  return authorityDigest('rorca.execution-authority.decision.v1', {
    schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
    requestId: input.request.id,
    requestDigest: input.request.requestDigest,
    requestingPrincipal: input.request.requestingPrincipal,
    operatorPrincipal: input.operatorPrincipal,
    decision: input.decision,
    reasonCode: input.reasonCode,
  });
}

function fixedProvenance(action: string): AuthorityJson {
  return Object.freeze({
    schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
    source: 'execution-authority-policy',
    action,
  });
}

function exactDigest(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left.slice(7), 'hex'), Buffer.from(right.slice(7), 'hex'));
}

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return String(error.code ?? '');
}

function requestStateError(request: AuthorityRequestRecord): AuthorityPolicyError | null {
  if (request.status === 'denied') {
    return new AuthorityPolicyError('AUTHORITY_REQUEST_DENIED', request.status, { requestId: request.id });
  }
  if (request.status === 'cancelled') {
    return new AuthorityPolicyError('AUTHORITY_REQUEST_CANCELLED', request.status, { requestId: request.id });
  }
  if (request.status === 'expired') {
    return new AuthorityPolicyError('AUTHORITY_REQUEST_EXPIRED', request.status, { requestId: request.id });
  }
  if (request.status === 'approved') {
    return new AuthorityPolicyError('AUTHORITY_REQUEST_REPLAYED', request.status, { requestId: request.id });
  }
  return null;
}

function assertExactCurrentRequest(request: AuthorityRequestRecord, suppliedDigest: string): void {
  if (!exactDigest(request.requestDigest, suppliedDigest)) {
    throw new AuthorityPolicyError('AUTHORITY_REQUEST_ALTERED', request.status, { requestId: request.id });
  }
  const stateError = requestStateError(request);
  if (stateError) throw stateError;
}

async function expirePendingRequest(request: AuthorityRequestRecord): Promise<void> {
  await transaction(async () => {
    const expired = await updateAuthorityRequestStatus(request.workspaceId, request.id, 'expired');
    if (!expired) return;
    await transitionOperationIntent(request.workspaceId, request.intentId, 'proposed', 'cancelled');
    await appendAuthorityWalEvent({
      eventType: 'authority_request_expired',
      workspaceId: request.workspaceId,
      storyId: request.storyId,
      payload: {
        schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
        requestId: request.id,
        requestDigest: request.requestDigest,
        runId: request.runId,
        status: 'expired',
      },
    });
  });
}

async function currentRequestOrThrow(workspaceId: string, requestId: string): Promise<AuthorityRequestRecord> {
  const request = await getAuthorityRequest(workspaceId, requestId);
  if (!request) throw new NotFoundError('Authority request', requestId);
  return request;
}

async function assertUnexpiredPendingRequest(
  workspaceId: string,
  requestId: string,
  suppliedDigest: string,
  now: Date,
): Promise<AuthorityRequestRecord> {
  const request = await currentRequestOrThrow(workspaceId, requestId);
  assertExactCurrentRequest(request, suppliedDigest);
  if (request.expiresAt.getTime() <= now.getTime()) {
    await expirePendingRequest(request);
    throw new AuthorityPolicyError('AUTHORITY_REQUEST_EXPIRED', 'expired', { requestId: request.id });
  }
  return request;
}
function authorityProjection<T>(value: T): T {
  assertAuthorityRedactedValue(value);
  return Object.freeze(value);
}


export function toAuthorityRequestProjection(request: AuthorityRequestRecord): AuthorityRequestProjection {
  return authorityProjection({
    schemaVersion: request.schemaVersion,
    id: request.id,
    intentId: request.intentId,
    workspaceId: request.workspaceId,
    runId: request.runId,
    storyId: request.storyId,
    requestingPrincipal: request.requestingPrincipal,
    capabilityId: request.capabilityId,
    bindingReference: request.bindingReference,
    bindingGeneration: request.bindingGeneration,
    environment: request.environment,
    providerResourceId: request.providerResourceId,
    operation: request.operation,
    constraints: request.constraints,
    evidenceDigest: request.evidenceDigest,
    requestDigest: request.requestDigest,
    status: request.status,
    maximumUses: request.maximumUses,
    expiresAt: request.expiresAt.toISOString(),
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
  });
}

export function toAuthorityDecisionProjection(decision: AuthorityDecisionRecord): AuthorityDecisionProjection {
  return authorityProjection({
    schemaVersion: decision.schemaVersion,
    id: decision.id,
    workspaceId: decision.workspaceId,
    requestId: decision.requestId,
    requestDigest: decision.requestDigest,
    requestingPrincipal: decision.requestingPrincipal,
    operatorPrincipal: decision.operatorPrincipal,
    decision: decision.decision,
    decisionDigest: decision.decisionDigest,
    reasonCode: decision.reasonCode as AuthorityDecisionReasonCode,
    createdAt: decision.createdAt.toISOString(),
  });
}

export function toAuthorityGrantProjection(grant: AuthorityGrantRecord): AuthorityGrantProjection {
  return authorityProjection({
    schemaVersion: grant.schemaVersion,
    id: grant.id,
    workspaceId: grant.workspaceId,
    requestId: grant.requestId,
    decisionId: grant.decisionId,
    requestDigest: grant.requestDigest,
    runId: grant.runId,
    storyId: grant.storyId,
    capabilityId: grant.capabilityId,
    bindingReference: grant.bindingReference,
    bindingGeneration: grant.bindingGeneration,
    environment: grant.environment,
    providerResourceId: grant.providerResourceId,
    operation: grant.operation,
    constraints: grant.constraints,
    evidenceDigest: grant.evidenceDigest,
    maximumUses: grant.maximumUses,
    usesConsumed: grant.usesConsumed,
    fencingGeneration: grant.fencingGeneration,
    status: grant.status,
    expiresAt: grant.expiresAt.toISOString(),
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
    revokedAt: grant.revokedAt?.toISOString() ?? null,
  });
}

export function toExecutionReceiptProjection(receipt: ExecutionReceiptRecord): ExecutionReceiptProjection {
  return authorityProjection({
    schemaVersion: receipt.schemaVersion,
    id: receipt.id,
    workspaceId: receipt.workspaceId,
    attemptId: receipt.attemptId,
    intentId: receipt.intentId,
    grantId: receipt.grantId,
    runId: receipt.runId,
    storyId: receipt.storyId,
    environment: receipt.environment,
    providerResourceId: receipt.providerResourceId,
    operation: receipt.operation,
    requestDigest: receipt.requestDigest,
    receiptDigest: receipt.receiptDigest,
    fencingGeneration: receipt.fencingGeneration,
    outcome: receipt.outcome,
    providerReceiptReference: receipt.providerReceiptReference,
    redactedPayload: receipt.redactedPayload,
    status: receipt.status,
    retentionClass: receipt.retentionClass,
    retainedUntil: receipt.retainedUntil?.toISOString() ?? null,
    createdAt: receipt.createdAt.toISOString(),
    settledAt: receipt.settledAt.toISOString(),
  });
}

export async function createPolicyAuthorityRequest(input: {
  workspaceId: string;
  intentId: string;
  maximumUses: number;
  expiresAt: Date;
  idempotencyKey: string;
  now?: Date;
}): Promise<AuthorityRequestProjection> {
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(input.maximumUses) || input.maximumUses < 1 || input.maximumUses > 1000) {
    throw new ValidationError('Authority request maximumUses must be an integer between 1 and 1000');
  }
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())
    || input.expiresAt.getTime() <= now.getTime()) {
    throw new ValidationError('Authority request expiresAt must be a future date-time');
  }
  const intent = await getOperationIntent(input.workspaceId, input.intentId);
  if (!intent) throw new NotFoundError('Operation intent', input.intentId);
  assertAuthorityRedactedValue(intent.constraints, { maximumBytes: 32_768 });
  assertAuthorityRedactedValue(intent.provenance, { maximumBytes: 16_384 });
  if (intent.status !== 'proposed') {
    throw new AuthorityPolicyError('AUTHORITY_REQUEST_REPLAYED', intent.status);
  }
  const digest = requestDigest(intent, input.maximumUses, input.expiresAt);
  const storedIdempotencyKey = persistedIdempotencyKey('request', input.idempotencyKey);
  const existing = await getAuthorityRequestByIdempotencyKey(input.workspaceId, storedIdempotencyKey);
  if (existing) {
    if (exactDigest(existing.requestDigest, digest)) return toAuthorityRequestProjection(existing);
    throw new ConflictError('Authority request idempotency key is already bound to a different exact request');
  }

  try {
    const request = await transaction(async () => {
      const created = await createAuthorityRequest({
        workspaceId: intent.workspaceId,
        intentId: intent.id,
        runId: intent.runId,
        storyId: intent.storyId,
        requestingPrincipal: intent.requestingPrincipal,
        capabilityId: intent.capabilityId,
        bindingReference: intent.bindingReference,
        bindingGeneration: intent.bindingGeneration,
        environment: intent.environment,
        providerResourceId: intent.providerResourceId,
        operation: intent.operation,
        constraints: intent.constraints,
        evidenceDigest: intent.evidenceDigest,
        requestDigest: digest,
        idempotencyKey: storedIdempotencyKey,
        maximumUses: input.maximumUses,
        expiresAt: input.expiresAt,
        provenance: fixedProvenance('request.create'),
      });
      await appendAuthorityWalEvent({
        eventType: 'authority_request_created',
        workspaceId: created.workspaceId,
        storyId: created.storyId,
        payload: {
          schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
          requestId: created.id,
          requestDigest: created.requestDigest,
          runId: created.runId,
          status: created.status,
        },
      });
      return created;
    });
    return toAuthorityRequestProjection(request);
  } catch (error) {
    if (pgCode(error) !== '23505') throw error;
    const replay = await getAuthorityRequestByIdempotencyKey(input.workspaceId, storedIdempotencyKey);
    if (replay && exactDigest(replay.requestDigest, digest)) return toAuthorityRequestProjection(replay);
    throw new ConflictError('Authority request conflicts with an existing exact request');
  }
}

export async function getPolicyAuthorityRequest(
  workspaceId: string,
  requestId: string,
): Promise<AuthorityRequestDetailProjection> {
  const request = await currentRequestOrThrow(workspaceId, requestId);
  const [decision, grant, bindingHealth] = await Promise.all([
    getAuthorityDecisionForRequest(workspaceId, requestId),
    getAuthorityGrantForRequest(workspaceId, requestId),
    getAuthorityRequestBindingHealth(workspaceId, requestId),
  ]);
  return {
    request: toAuthorityRequestProjection(request),
    decision: decision ? toAuthorityDecisionProjection(decision) : null,
    grant: grant ? toAuthorityGrantProjection(grant) : null,
    bindingHealth: bindingHealth ?? 'not_assessed',
  };
}

export async function listPolicyAuthorityRequests(input: {
  workspaceId: string;
  status?: AuthorityRequestStatus;
  pagination: PaginationParams;
}): Promise<PaginatedResponse<AuthorityRequestProjection>> {
  const page = await listAuthorityRequestsPage({
    workspaceId: input.workspaceId,
    status: input.status,
    limit: input.pagination.limit,
    offset: input.pagination.offset,
    cursorId: input.pagination.cursor ? decodeCursor(input.pagination.cursor) : null,
  });
  return {
    items: page.items.map(toAuthorityRequestProjection),
    total: page.total,
    hasMore: page.hasMore,
    ...(page.cursorId ? { cursor: encodeCursor(page.cursorId) } : {}),
  };
}

export async function cancelPolicyAuthorityRequest(input: {
  workspaceId: string;
  requestId: string;
  requestDigest: string;
  now?: Date;
}): Promise<AuthorityRequestProjection> {
  const request = await assertUnexpiredPendingRequest(
    input.workspaceId,
    input.requestId,
    input.requestDigest,
    input.now ?? new Date(),
  );
  try {
    await transaction(async () => {
      if (!await updateAuthorityRequestStatus(request.workspaceId, request.id, 'cancelled')) {
        throw new AuthorityPolicyError('AUTHORITY_REQUEST_REPLAYED', 'resolved', { requestId: request.id });
      }
      if (!await transitionOperationIntent(request.workspaceId, request.intentId, 'proposed', 'cancelled')) {
        throw new AuthorityPolicyError('AUTHORITY_REQUEST_REPLAYED', 'intent_resolved', { requestId: request.id });
      }
      await appendAuthorityWalEvent({
        eventType: 'authority_request_cancelled',
        workspaceId: request.workspaceId,
        storyId: request.storyId,
        payload: {
          schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
          requestId: request.id,
          requestDigest: request.requestDigest,
          runId: request.runId,
          status: 'cancelled',
        },
      });
    });
  } catch (error) {
    if (error instanceof AuthorityPolicyError) throw await classifyRequestRace(request.workspaceId, request.id, error);
    throw error;
  }
  return toAuthorityRequestProjection(await currentRequestOrThrow(request.workspaceId, request.id));
}

function assertDecisionReason(decision: AuthorityDecisionKind, reasonCode: AuthorityDecisionReasonCode): void {
  const allowed: readonly string[] = decision === 'approved'
    ? AUTHORITY_APPROVAL_REASON_CODES
    : AUTHORITY_DENIAL_REASON_CODES;
  if (!allowed.includes(reasonCode)) {
    throw new ValidationError(`Reason code is not valid for an ${decision} authority decision`);
  }
}

async function classifyRequestRace(
  workspaceId: string,
  requestId: string,
  fallback: AuthorityPolicyError,
  now = new Date(),
): Promise<AuthorityPolicyError> {
  const current = await getAuthorityRequest(workspaceId, requestId);
  if (current?.status === 'pending' && current.expiresAt.getTime() <= now.getTime()) {
    await expirePendingRequest(current);
    return new AuthorityPolicyError('AUTHORITY_REQUEST_EXPIRED', 'expired', { requestId });
  }
  return (current && requestStateError(current)) || fallback;
}


function bindingMatchesRequest(
  binding: ProviderBindingRecord | null,
  request: AuthorityRequestRecord,
): boolean {
  return binding !== null
    && binding.status === 'active'
    && binding.capabilityId === request.capabilityId
    && binding.bindingReference === request.bindingReference
    && binding.generation === request.bindingGeneration
    && binding.environment === request.environment
    && binding.providerResourceId === request.providerResourceId;
}
export async function decidePolicyAuthorityRequest(input: {
  workspaceId: string;
  requestId: string;
  requestDigest: string;
  operatorPrincipal: string;
  decision: AuthorityDecisionKind;
  reasonCode: AuthorityDecisionReasonCode;
  idempotencyKey: string;
  now?: Date;
}): Promise<AuthorityDecisionResultProjection> {
  assertDecisionReason(input.decision, input.reasonCode);
  const request = await assertUnexpiredPendingRequest(
    input.workspaceId,
    input.requestId,
    input.requestDigest,
    input.now ?? new Date(),
  );
  assertAuthorityRedactedValue(request.constraints, { maximumBytes: 32_768 });
  assertAuthorityRedactedValue(request.provenance, { maximumBytes: 16_384 });
  if (!input.operatorPrincipal || input.operatorPrincipal === request.requestingPrincipal) {
    throw new ForbiddenError('Authority decision requires a distinct local operator principal');
  }
  const digest = decisionDigest({
    request,
    operatorPrincipal: input.operatorPrincipal,
    decision: input.decision,
    reasonCode: input.reasonCode,
  });
  const decisionIdempotencyKey = persistedIdempotencyKey('decision', input.idempotencyKey);
  const binding = input.decision === 'approved'
    ? await getProviderBindingByReference(
      request.workspaceId,
      request.bindingReference,
      request.bindingGeneration,
    )
    : null;
  if (input.decision === 'approved' && !bindingMatchesRequest(binding, request)) {
    throw new AuthorityPolicyError('AUTHORITY_BINDING_STALE', binding?.status ?? 'missing', { requestId: request.id });
  }

  try {
    const result = await transaction(async () => {
      const decision = await recordAuthorityDecision({
        workspaceId: request.workspaceId,
        requestId: request.id,
        requestDigest: request.requestDigest,
        requestingPrincipal: request.requestingPrincipal,
        operatorPrincipal: input.operatorPrincipal,
        decision: input.decision,
        decisionDigest: digest,
        idempotencyKey: decisionIdempotencyKey,
        reasonCode: input.reasonCode,
        provenance: fixedProvenance(`request.${input.decision}`),
      });
      let grant: AuthorityGrantRecord | null = null;
      if (input.decision === 'approved' && binding) {
        grant = await createAuthorityGrant({
          workspaceId: request.workspaceId,
          requestId: request.id,
          decisionId: decision.id,
          requestDigest: request.requestDigest,
          runId: request.runId,
          storyId: request.storyId,
          capabilityId: request.capabilityId,
          bindingReference: request.bindingReference,
          bindingGeneration: request.bindingGeneration,
          environment: request.environment,
          providerResourceId: request.providerResourceId,
          operation: request.operation,
          constraints: request.constraints,
          evidenceDigest: request.evidenceDigest,
          secretReference: binding.secretReference,
          secretFingerprint: binding.secretFingerprint,
          maximumUses: request.maximumUses,
          fencingGeneration: 1,
          idempotencyKey: persistedIdempotencyKey('grant', digest),
          provenance: fixedProvenance('grant.create'),
          expiresAt: request.expiresAt,
        });
      }
      const intentStatus = input.decision === 'approved' ? 'authorized' : 'cancelled';
      if (!await transitionOperationIntent(request.workspaceId, request.intentId, 'proposed', intentStatus)) {
        throw new AuthorityPolicyError('AUTHORITY_REQUEST_REPLAYED', 'intent_resolved', { requestId: request.id });
      }
      await appendAuthorityWalEvent({
        eventType: input.decision === 'approved' ? 'authority_request_approved' : 'authority_request_denied',
        workspaceId: request.workspaceId,
        storyId: request.storyId,
        payload: {
          schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
          requestId: request.id,
          requestDigest: request.requestDigest,
          decisionId: decision.id,
          grantId: grant?.id ?? null,
          runId: request.runId,
          status: input.decision,
        },
      });
      return { decision, grant };
    });
    return {
      decision: toAuthorityDecisionProjection(result.decision),
      grant: result.grant ? toAuthorityGrantProjection(result.grant) : null,
    };
  } catch (error) {
    if (error instanceof AuthorityPolicyError || ['23505', '55000'].includes(pgCode(error) ?? '')) {
      if (input.decision === 'approved') {
        const currentBinding = await getProviderBindingByReference(
          request.workspaceId,
          request.bindingReference,
          request.bindingGeneration,
        );
        if (!bindingMatchesRequest(currentBinding, request)) {
          throw new AuthorityPolicyError(
            'AUTHORITY_BINDING_STALE',
            currentBinding?.status ?? 'missing',
            { requestId: request.id },
          );
        }
      }
      throw await classifyRequestRace(
        request.workspaceId,
        request.id,
        error instanceof AuthorityPolicyError
          ? error
          : new AuthorityPolicyError('AUTHORITY_REQUEST_REPLAYED', 'resolved', { requestId: request.id }),
        input.now ?? new Date(),
      );
    }
    throw error;
  }
}

function sameScope(left: AuthorityGrantRecord, right: AuthorityScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.runId === right.runId
    && left.storyId === right.storyId
    && left.environment === right.environment
    && left.providerResourceId === right.providerResourceId
    && left.operation === right.operation;
}

function grantStateError(grant: AuthorityGrantRecord, now: Date): AuthorityPolicyError | null {
  if (grant.status === 'revoked') {
    return new AuthorityPolicyError('AUTHORITY_GRANT_REVOKED', grant.status, { requestId: grant.requestId, grantId: grant.id });
  }
  if (grant.status === 'expired' || grant.expiresAt.getTime() <= now.getTime()) {
    return new AuthorityPolicyError('AUTHORITY_GRANT_EXPIRED', 'expired', { requestId: grant.requestId, grantId: grant.id });
  }
  if (grant.status === 'exhausted' || grant.usesConsumed >= grant.maximumUses) {
    return new AuthorityPolicyError('AUTHORITY_GRANT_OVER_USED', 'exhausted', { requestId: grant.requestId, grantId: grant.id });
  }
  return null;
}

/**
 * The trusted execution boundary calls this before any provider adapter. It
 * performs no provider operation itself and consumes a use only after every
 * exact digest, scope, state, expiry, use-count, and fencing check succeeds.
 */
export async function consumeExactAuthorityGrant(input: {
  workspaceId: string;
  grantId: string;
  requestDigest: string;
  scope: AuthorityScope;
  fencingGeneration: number;
  now?: Date;
}): Promise<AuthorityGrantProjection> {
  const now = input.now ?? new Date();
  const grant = await getAuthorityGrant(input.workspaceId, input.grantId);
  if (!grant) throw new NotFoundError('Authority grant', input.grantId);
  const request = await currentRequestOrThrow(input.workspaceId, grant.requestId);
  assertAuthorityRedactedValue(grant.constraints, { maximumBytes: 32_768 });
  assertAuthorityRedactedValue(grant.provenance, { maximumBytes: 16_384 });
  assertAuthorityRedactedValue(request.constraints, { maximumBytes: 32_768 });
  assertAuthorityRedactedValue(request.provenance, { maximumBytes: 16_384 });
  if (request.status !== 'approved') {
    const requestError = requestStateError(request);
    if (requestError) throw requestError;
    throw new AuthorityPolicyError('AUTHORITY_REQUEST_REPLAYED', request.status, { requestId: request.id, grantId: grant.id });
  }
  if (!exactDigest(grant.requestDigest, input.requestDigest)
    || !exactDigest(request.requestDigest, input.requestDigest)
    || !sameScope(grant, input.scope)) {
    throw new AuthorityPolicyError('AUTHORITY_GRANT_ALTERED', grant.status, { requestId: request.id, grantId: grant.id });
  }
  if (grant.fencingGeneration !== input.fencingGeneration) {
    throw new AuthorityPolicyError('AUTHORITY_GRANT_REPLAYED', grant.status, { requestId: request.id, grantId: grant.id });
  }
  const stateError = grantStateError(grant, now);
  if (stateError) {
    if (stateError.failure.code === 'AUTHORITY_GRANT_EXPIRED' && grant.status === 'active') {
      await expireAuthorityGrant(grant.workspaceId, grant.id);
    }
    throw stateError;
  }
  const currentBinding = await getProviderBindingByReference(
    grant.workspaceId,
    grant.bindingReference,
    grant.bindingGeneration,
  );
  if (currentBinding === null
    || !bindingMatchesRequest(currentBinding, request)
    || currentBinding.secretReference !== grant.secretReference
    || currentBinding.secretFingerprint !== grant.secretFingerprint) {
    throw new AuthorityPolicyError(
      'AUTHORITY_BINDING_STALE',
      currentBinding?.status ?? 'missing',
      { requestId: request.id, grantId: grant.id },
    );
  }

  try {
    const consumed = await transaction(async () => {
      const updated = await consumeAuthorityGrant({
        grantId: grant.id,
        requestDigest: input.requestDigest,
        scope: input.scope,
        fencingGeneration: input.fencingGeneration,
      });
      await appendAuthorityWalEvent({
        eventType: 'authority_grant_consumed',
        workspaceId: updated.workspaceId,
        storyId: updated.storyId,
        payload: {
          schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
          requestId: updated.requestId,
          requestDigest: updated.requestDigest,
          grantId: updated.id,
          runId: updated.runId,
          usesConsumed: updated.usesConsumed,
          maximumUses: updated.maximumUses,
          status: updated.status,
        },
      });
      return updated;
    });
    return toAuthorityGrantProjection(consumed);
  } catch (error) {
    if (pgCode(error) !== '42501' && pgCode(error) !== '55000') throw error;
    const current = await getAuthorityGrant(input.workspaceId, input.grantId);
    if (current) {
      const currentError = grantStateError(current, now);
      if (currentError) throw currentError;
      if (current.fencingGeneration !== input.fencingGeneration) {
        throw new AuthorityPolicyError('AUTHORITY_GRANT_REPLAYED', current.status, {
          requestId: current.requestId,
          grantId: current.id,
        });
      }
    }
    throw new AuthorityPolicyError('AUTHORITY_GRANT_ALTERED', current?.status ?? 'missing', {
      requestId: current?.requestId,
      grantId: input.grantId,
    });
  }
}

export async function getPolicyExecutionReceipt(
  workspaceId: string,
  receiptId: string,
): Promise<ExecutionReceiptProjection> {
  const receipt = await getExecutionReceipt(workspaceId, receiptId);
  if (!receipt) throw new NotFoundError('Execution receipt', receiptId);
  return toExecutionReceiptProjection(receipt);
}

export async function listPolicyExecutionReceipts(input: {
  workspaceId: string;
  pagination: PaginationParams;
}): Promise<PaginatedResponse<ExecutionReceiptProjection>> {
  const page = await listExecutionReceiptsPage({
    workspaceId: input.workspaceId,
    limit: input.pagination.limit,
    offset: input.pagination.offset,
    cursorId: input.pagination.cursor ? decodeCursor(input.pagination.cursor) : null,
  });
  return {
    items: page.items.map(toExecutionReceiptProjection),
    total: page.total,
    hasMore: page.hasMore,
    ...(page.cursorId ? { cursor: encodeCursor(page.cursorId) } : {}),
  };
}
