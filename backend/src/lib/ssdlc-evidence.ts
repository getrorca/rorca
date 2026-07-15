/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * One thin normalization contract for internal Rorca evidence and authenticated
 * Hermes ingress. This module does not pull external integrations or copy logs.
 */

import { execute, query, queryOne } from '../db/index';
import { paginateQuery, type PaginatedResponse, type PaginationParams } from './paginate';
import { hashCaptureContent, sanitizeCapturePayload } from './context-safety';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { logger } from './logger';

export const LIFECYCLE_EVIDENCE_SCHEMA_VERSION = 'rorca.lifecycle-evidence.v1' as const;
export const HERMES_EVIDENCE_SCHEMA_VERSION = 'hermes.evidence.v1' as const;
export const MAX_EVIDENCE_EXCERPT_BYTES = 8_192;
export const MAX_EVIDENCE_REFERENCE_BYTES = 4_096;
export const MAX_HERMES_ENVELOPE_BYTES = 64 * 1_024;
export const MAX_PROVENANCE_HOPS = 16;

export const EVIDENCE_STATUSES = [
  'passed',
  'story_caused_failure',
  'unrelated_baseline',
  'environment_credential_blocker',
  'skipped_with_rationale',
  'unknown',
] as const;

export const EVIDENCE_TRUST_LEVELS = [
  'host_observed',
  'provider_verified',
  'authenticated_manual',
  'agent_proposed',
] as const;

export const EVIDENCE_SUBJECT_TYPES = [
  'spec_hash',
  'commit_sha',
  'artifact_digest',
  'deployment_id',
] as const;

export const EVIDENCE_SOURCE_TYPES = [
  'story_result',
  'story_commit',
  'wal_validation',
  'github_check',
  'completion_signal',
  'gitreins_judgment',
  'manual_qa',
  'staging_result',
  'deployment_proof',
  'memory_closeout',
] as const;

export const EVIDENCE_CLASSIFICATIONS = [
  'validation',
  'revision',
  'completion',
  'risk_judgment',
  'qa',
  'staging',
  'deployment',
  'memory_closeout',
] as const;

export type EvidenceStatus = typeof EVIDENCE_STATUSES[number];
export type EvidenceTrustLevel = typeof EVIDENCE_TRUST_LEVELS[number];
export type EvidenceSubjectType = typeof EVIDENCE_SUBJECT_TYPES[number];
export type EvidenceSourceType = typeof EVIDENCE_SOURCE_TYPES[number];
export type EvidenceClassification = typeof EVIDENCE_CLASSIFICATIONS[number];
export type HermesEvidenceKind = 'gitreins_judgment' | 'manual_qa' | 'staging_result' | 'deployment_proof' | 'memory_closeout';

export interface EvidenceScope {
  workspaceId: string;
  specSlug: string;
  runId: number | null;
  storyId: string | null;
  phaseId: string | null;
  gateId: string | null;
}

export interface EvidenceSubjectIdentity {
  type: EvidenceSubjectType;
  value: string;
}

export interface EvidenceReleaseIdentity {
  commitSha: string | null;
  artifactDigest: string | null;
  deploymentId: string | null;
}

export interface EvidenceProvenanceHop {
  system: string;
  eventId: string;
  observedAt: string;
  principal?: string;
  verification?: string;
}

export interface CanonicalLifecycleEvidence {
  schemaVersion: typeof LIFECYCLE_EVIDENCE_SCHEMA_VERSION;
  source: {
    type: EvidenceSourceType;
    system: string;
    eventId: string;
  };
  observedAt: string;
  scope: EvidenceScope;
  subject: EvidenceSubjectIdentity;
  phaseSubject: EvidenceSubjectIdentity | null;
  releaseIdentity: EvidenceReleaseIdentity;
  classification: EvidenceClassification;
  status: EvidenceStatus;
  trustLevel: EvidenceTrustLevel;
  confidence: number;
  excerpt: string | null;
  rawReference: string | null;
  provenanceChain: EvidenceProvenanceHop[];
  actor: string | null;
  rationale: string | null;
  details: Record<string, unknown>;
  revisionMismatch: boolean;
  lineageVerified: boolean;
  /** Hash supplied by the source envelope, when available. */
  sourcePayloadHash: string | null;
  /** Hash of the complete redacted canonical record. */
  payloadHash: string;
}

export interface StoredLifecycleEvidence extends CanonicalLifecycleEvidence {
  id: string;
  createdAt: string | Date;
}

export interface EvidencePrincipal {
  id: string;
  displayName: string;
  /** Derived by server-side adapter identity, never from the request body. */
  adapterVerified: boolean;
}

export interface HermesEvidenceEnvelope {
  schemaVersion: typeof HERMES_EVIDENCE_SCHEMA_VERSION;
  kind: HermesEvidenceKind;
  sourceSystem: string;
  sourceEventId: string;
  observedAt: string;
  scope: EvidenceScope;
  subject: EvidenceSubjectIdentity;
  phaseSubject?: EvidenceSubjectIdentity | null;
  releaseIdentity?: Partial<EvidenceReleaseIdentity>;
  status: EvidenceStatus;
  confidence: number;
  payloadHash: string;
  excerpt?: string | null;
  rawReference?: string | null;
  attachmentReference?: string | null;
  provenanceChain: EvidenceProvenanceHop[];
  rationale?: string | null;
  details?: Record<string, unknown>;
  /** Untrusted claims are accepted for compatibility but never used for trust/actor. */
  actor?: string;
  trustLevel?: string;
  sourceLabel?: string;
  automated?: boolean;
}

export interface CreateEvidenceInput {
  sourceType: EvidenceSourceType;
  sourceSystem: string;
  sourceEventId: string;
  observedAt: Date | string;
  scope: EvidenceScope;
  subject: EvidenceSubjectIdentity;
  phaseSubject?: EvidenceSubjectIdentity | null;
  releaseIdentity?: Partial<EvidenceReleaseIdentity>;
  classification: EvidenceClassification;
  status: EvidenceStatus;
  trustLevel: EvidenceTrustLevel;
  confidence: number;
  excerpt?: string | null;
  rawReference?: string | null;
  provenanceChain?: EvidenceProvenanceHop[];
  actor?: string | null;
  rationale?: string | null;
  details?: Record<string, unknown>;
  upstreamPayloadHash?: string;
}

interface EvidenceRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  run_id: number | null;
  story_id: string | null;
  phase_id: string | null;
  gate_id: string | null;
  evidence_type: string;
  subject_type: EvidenceSubjectType;
  subject_value: string;
  source_system: string;
  source_idempotency_key: string;
  payload_hash: string;
  metadata: Record<string, unknown> | string;
  provenance: Record<string, unknown> | string;
  source_ref: string | null;
  observed_at: string | Date;
  created_at: string | Date;
  source_type: EvidenceSourceType;
  classification: EvidenceClassification;
  evidence_status: EvidenceStatus;
  trust_level: EvidenceTrustLevel;
  confidence: number;
  excerpt: string | null;
  release_identity: Partial<EvidenceReleaseIdentity> | string;
  phase_subject_type: EvidenceSubjectType | null;
  phase_subject_value: string | null;
  revision_mismatch: boolean;
  lineage_verified: boolean;
  actor: string | null;
  rationale: string | null;
}

export interface EvidencePersistenceResult {
  evidence: StoredLifecycleEvidence;
  replayed: boolean;
}

interface EvidenceDb {
  query: typeof query;
  queryOne: typeof queryOne;
  execute: typeof execute;
}

const DEFAULT_DB: EvidenceDb = { query, queryOne, execute };
const HERMES_KINDS: readonly HermesEvidenceKind[] = [
  'gitreins_judgment',
  'manual_qa',
  'staging_result',
  'deployment_proof',
  'memory_closeout',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maxBytes = 1_024): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }
  const text = value.trim();
  if (Buffer.byteLength(text) > maxBytes) {
    throw new ValidationError(`${field} exceeds ${maxBytes} bytes`, { field });
  }
  return text;
}

function optionalText(value: unknown, field: string, maxBytes: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maxBytes);
}

function isoTimestamp(value: unknown, field: string): string {
  if (!(typeof value === 'string' || value instanceof Date)) {
    throw new ValidationError(`${field} must be an ISO timestamp`, { field });
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be an ISO timestamp`, { field });
  return date.toISOString();
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ValidationError(`${field} must be one of: ${values.join(', ')}`, { field });
  }
  return value as T;
}

function confidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError('confidence must be a number between 0 and 1', { field: 'confidence' });
  }
  return value;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeCapturePayload(value).payload;
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeText(value: string | null, maxBytes: number): string | null {
  if (value === null) return null;
  const payload = sanitizeCapturePayload({ value }).payload;
  const sanitized = isRecord(payload) && typeof payload.value === 'string' ? payload.value : '';
  if (Buffer.byteLength(sanitized) <= maxBytes) return sanitized;
  let end = maxBytes;
  const source = Buffer.from(sanitized);
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return `${source.subarray(0, end).toString('utf8')}…`;
}

function normalizeScope(value: EvidenceScope | Record<string, unknown>): EvidenceScope {
  const runId = value.runId;
  if (runId !== null && runId !== undefined && (!Number.isSafeInteger(runId) || Number(runId) <= 0)) {
    throw new ValidationError('scope.runId must be a positive integer or null', { field: 'scope.runId' });
  }
  return {
    workspaceId: requiredText(value.workspaceId, 'scope.workspaceId', 256),
    specSlug: requiredText(value.specSlug, 'scope.specSlug', 512),
    runId: runId === undefined || runId === null ? null : Number(runId),
    storyId: optionalText(value.storyId, 'scope.storyId', 256),
    phaseId: optionalText(value.phaseId, 'scope.phaseId', 256),
    gateId: optionalText(value.gateId, 'scope.gateId', 256),
  };
}

function normalizeSubject(value: EvidenceSubjectIdentity | Record<string, unknown>, field: string): EvidenceSubjectIdentity {
  return {
    type: requireEnum(value.type, EVIDENCE_SUBJECT_TYPES, `${field}.type`),
    value: requiredText(value.value, `${field}.value`, 1_024),
  };
}

function normalizeReleaseIdentity(value?: Partial<EvidenceReleaseIdentity>): EvidenceReleaseIdentity {
  return {
    commitSha: optionalText(value?.commitSha, 'releaseIdentity.commitSha', 1_024),
    artifactDigest: optionalText(value?.artifactDigest, 'releaseIdentity.artifactDigest', 1_024),
    deploymentId: optionalText(value?.deploymentId, 'releaseIdentity.deploymentId', 1_024),
  };
}

function comparableIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function releaseBindsSubject(subject: EvidenceSubjectIdentity, release: EvidenceReleaseIdentity): boolean {
  const expected = comparableIdentity(subject.value);
  if (subject.type === 'commit_sha') return comparableIdentity(release.commitSha ?? '') === expected;
  if (subject.type === 'artifact_digest') return comparableIdentity(release.artifactDigest ?? '') === expected;
  if (subject.type === 'deployment_id') return comparableIdentity(release.deploymentId ?? '') === expected;
  return false;
}

function calculateLineageVerified(
  sourceType: EvidenceSourceType,
  subject: EvidenceSubjectIdentity,
  release: EvidenceReleaseIdentity,
): boolean {
  if (sourceType === 'deployment_proof') {
    return subject.type === 'deployment_id'
      && Boolean(release.commitSha && release.artifactDigest && release.deploymentId)
      && releaseBindsSubject(subject, release);
  }
  if (subject.type === 'artifact_digest') {
    return Boolean(release.commitSha && release.artifactDigest) && releaseBindsSubject(subject, release);
  }
  return subject.type === 'commit_sha' || subject.type === 'spec_hash';
}

function phaseBindingMatches(
  subject: EvidenceSubjectIdentity,
  phaseSubject: EvidenceSubjectIdentity,
  release: EvidenceReleaseIdentity,
): boolean {
  if (subject.type === phaseSubject.type) {
    return comparableIdentity(subject.value) === comparableIdentity(phaseSubject.value);
  }
  return releaseBindsSubject(phaseSubject, release);
}

function normalizeProvenance(value: EvidenceProvenanceHop[] | undefined): EvidenceProvenanceHop[] {
  const hops = value ?? [];
  if (!Array.isArray(hops) || hops.length > MAX_PROVENANCE_HOPS) {
    throw new ValidationError(`provenanceChain must contain at most ${MAX_PROVENANCE_HOPS} entries`, { field: 'provenanceChain' });
  }
  return hops.map((hop, index) => {
    if (!isRecord(hop)) throw new ValidationError(`provenanceChain.${index} must be an object`);
    return {
      system: sanitizeText(requiredText(hop.system, `provenanceChain.${index}.system`, 256), 256)!,
      eventId: sanitizeText(requiredText(hop.eventId, `provenanceChain.${index}.eventId`, 512), 512)!,
      observedAt: isoTimestamp(hop.observedAt, `provenanceChain.${index}.observedAt`),
      ...(hop.principal ? { principal: sanitizeText(requiredText(hop.principal, `provenanceChain.${index}.principal`, 512), 512)! } : {}),
      ...(hop.verification ? { verification: sanitizeText(requiredText(hop.verification, `provenanceChain.${index}.verification`, 512), 512)! } : {}),
    };
  });
}

export function createCanonicalEvidence(input: CreateEvidenceInput): CanonicalLifecycleEvidence {
  const sourceType = requireEnum(input.sourceType, EVIDENCE_SOURCE_TYPES, 'sourceType');
  const scope = normalizeScope(input.scope);
  const subject = normalizeSubject(input.subject, 'subject');
  const phaseSubject = input.phaseSubject == null ? null : normalizeSubject(input.phaseSubject, 'phaseSubject');
  const releaseIdentity = normalizeReleaseIdentity(input.releaseIdentity);
  const actor = optionalText(input.actor, 'actor', 512);
  const rationale = sanitizeText(optionalText(input.rationale, 'rationale', 4_096), 4_096);
  const rawReference = sanitizeText(optionalText(input.rawReference, 'rawReference', MAX_EVIDENCE_REFERENCE_BYTES), MAX_EVIDENCE_REFERENCE_BYTES);
  const trustLevel = requireEnum(input.trustLevel, EVIDENCE_TRUST_LEVELS, 'trustLevel');
  const status = requireEnum(input.status, EVIDENCE_STATUSES, 'status');
  if (input.excerpt !== undefined && input.excerpt !== null && typeof input.excerpt !== 'string') {
    throw new ValidationError('excerpt must be a string or null', { field: 'excerpt' });
  }
  // Internal source summaries can be large; sanitize and truncate instead of copying/rejecting the source log.
  const excerpt = sanitizeText(input.excerpt?.trim() || null, MAX_EVIDENCE_EXCERPT_BYTES);
  const details = sanitizeObject(input.details ?? {});

  if (sourceType === 'manual_qa') {
    if (!actor || !rationale || !rawReference) {
      throw new ValidationError('manual_qa evidence requires server-derived actor, rationale, and attachment/reference provenance');
    }
    if (trustLevel !== 'authenticated_manual') {
      throw new ValidationError('manual_qa evidence must use authenticated_manual trust');
    }
  } else if (actor || rationale) {
    throw new ValidationError('actor and rationale are reserved for manual_qa evidence');
  }

  if (status === 'skipped_with_rationale'
    && !rationale
    && !excerpt
    && typeof details.reason !== 'string'
    && typeof details.rationale !== 'string') {
    throw new ValidationError('skipped_with_rationale evidence requires a bounded rationale');
  }

  const base = {
    schemaVersion: LIFECYCLE_EVIDENCE_SCHEMA_VERSION,
    source: {
      type: sourceType,
      system: sanitizeText(requiredText(input.sourceSystem, 'sourceSystem', 256), 256)!,
      eventId: sanitizeText(requiredText(input.sourceEventId, 'sourceEventId', 512), 512)!,
    },
    observedAt: isoTimestamp(input.observedAt, 'observedAt'),
    scope,
    subject,
    phaseSubject,
    releaseIdentity,
    classification: requireEnum(input.classification, EVIDENCE_CLASSIFICATIONS, 'classification'),
    status,
    trustLevel,
    confidence: confidence(input.confidence),
    excerpt,
    rawReference,
    provenanceChain: normalizeProvenance(input.provenanceChain),
    actor,
    rationale,
    details,
    revisionMismatch: phaseSubject ? !phaseBindingMatches(subject, phaseSubject, releaseIdentity) : false,
    lineageVerified: calculateLineageVerified(sourceType, subject, releaseIdentity),
    sourcePayloadHash: input.upstreamPayloadHash
      ? requiredText(input.upstreamPayloadHash, 'upstreamPayloadHash', 256)
      : null,
  };

  return {
    ...base,
    payloadHash: hashCaptureContent(base),
  };
}

function parseHermesHop(value: unknown, index: number): EvidenceProvenanceHop {
  if (!isRecord(value)) throw new ValidationError(`provenanceChain.${index} must be an object`);
  return {
    system: requiredText(value.system, `provenanceChain.${index}.system`, 256),
    eventId: requiredText(value.eventId, `provenanceChain.${index}.eventId`, 512),
    observedAt: isoTimestamp(value.observedAt, `provenanceChain.${index}.observedAt`),
    ...(typeof value.principal === 'string' ? { principal: value.principal } : {}),
    ...(typeof value.verification === 'string' ? { verification: value.verification } : {}),
  };
}

export function parseHermesEvidenceEnvelope(value: unknown): HermesEvidenceEnvelope {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw new ValidationError('Hermes evidence envelope must be valid bounded JSON');
  }
  if (size > MAX_HERMES_ENVELOPE_BYTES) {
    throw new ValidationError(`Hermes evidence envelope exceeds ${MAX_HERMES_ENVELOPE_BYTES} bytes`);
  }
  if (!isRecord(value)) throw new ValidationError('Hermes evidence envelope must be an object');
  if (value.schemaVersion !== HERMES_EVIDENCE_SCHEMA_VERSION) {
    throw new ValidationError(`schemaVersion must be ${HERMES_EVIDENCE_SCHEMA_VERSION}`, { field: 'schemaVersion' });
  }
  if (!isRecord(value.scope)) throw new ValidationError('scope must be an object');
  if (!isRecord(value.subject)) throw new ValidationError('subject must be an object');
  if (!Array.isArray(value.provenanceChain) || value.provenanceChain.length < 1 || value.provenanceChain.length > MAX_PROVENANCE_HOPS) {
    throw new ValidationError(`provenanceChain must contain between 1 and ${MAX_PROVENANCE_HOPS} entries`);
  }
  const payloadHash = requiredText(value.payloadHash, 'payloadHash', 128);
  if (!/^[a-f0-9]{64}$/i.test(payloadHash)) throw new ValidationError('payloadHash must be a SHA-256 hex digest');
  const kind = requireEnum(value.kind, HERMES_KINDS, 'kind');
  const rawRelease = value.releaseIdentity;
  if (rawRelease !== undefined && !isRecord(rawRelease)) throw new ValidationError('releaseIdentity must be an object');
  const rawDetails = value.details;
  if (rawDetails !== undefined && !isRecord(rawDetails)) throw new ValidationError('details must be an object');

  return {
    schemaVersion: HERMES_EVIDENCE_SCHEMA_VERSION,
    kind,
    sourceSystem: requiredText(value.sourceSystem, 'sourceSystem', 256),
    sourceEventId: requiredText(value.sourceEventId, 'sourceEventId', 512),
    observedAt: isoTimestamp(value.observedAt, 'observedAt'),
    scope: normalizeScope(value.scope),
    subject: normalizeSubject(value.subject, 'subject'),
    phaseSubject: value.phaseSubject == null
      ? null
      : normalizeSubject(isRecord(value.phaseSubject) ? value.phaseSubject : {}, 'phaseSubject'),
    releaseIdentity: rawRelease as Partial<EvidenceReleaseIdentity> | undefined,
    status: requireEnum(value.status, EVIDENCE_STATUSES, 'status'),
    confidence: confidence(value.confidence),
    payloadHash,
    excerpt: optionalText(value.excerpt, 'excerpt', MAX_EVIDENCE_EXCERPT_BYTES),
    rawReference: optionalText(value.rawReference, 'rawReference', MAX_EVIDENCE_REFERENCE_BYTES),
    attachmentReference: optionalText(value.attachmentReference, 'attachmentReference', MAX_EVIDENCE_REFERENCE_BYTES),
    provenanceChain: value.provenanceChain.map(parseHermesHop),
    rationale: optionalText(value.rationale, 'rationale', 4_096),
    details: rawDetails as Record<string, unknown> | undefined,
    ...(typeof value.actor === 'string' ? { actor: value.actor } : {}),
    ...(typeof value.trustLevel === 'string' ? { trustLevel: value.trustLevel } : {}),
    ...(typeof value.sourceLabel === 'string' ? { sourceLabel: value.sourceLabel } : {}),
    ...(typeof value.automated === 'boolean' ? { automated: value.automated } : {}),
  };
}

const HERMES_CLASSIFICATION: Record<HermesEvidenceKind, EvidenceClassification> = {
  gitreins_judgment: 'risk_judgment',
  manual_qa: 'qa',
  staging_result: 'staging',
  deployment_proof: 'deployment',
  memory_closeout: 'memory_closeout',
};

export function normalizeHermesEvidence(
  envelopeInput: HermesEvidenceEnvelope | unknown,
  principal: EvidencePrincipal,
): CanonicalLifecycleEvidence {
  const envelope = parseHermesEvidenceEnvelope(envelopeInput);
  const manual = envelope.kind === 'manual_qa';
  const agentProposed = envelope.kind === 'memory_closeout';
  const trustLevel: EvidenceTrustLevel = manual
    ? 'authenticated_manual'
    : agentProposed
      ? 'agent_proposed'
      : principal.adapterVerified
        ? 'provider_verified'
        : 'host_observed';
  const rawReference = manual ? envelope.attachmentReference ?? envelope.rawReference : envelope.rawReference;

  return createCanonicalEvidence({
    sourceType: envelope.kind,
    sourceSystem: `hermes:${envelope.sourceSystem}`,
    sourceEventId: envelope.sourceEventId,
    observedAt: envelope.observedAt,
    scope: envelope.scope,
    subject: envelope.subject,
    phaseSubject: envelope.phaseSubject,
    releaseIdentity: envelope.releaseIdentity,
    classification: HERMES_CLASSIFICATION[envelope.kind],
    status: envelope.status,
    trustLevel,
    confidence: envelope.confidence,
    excerpt: envelope.excerpt,
    rawReference,
    provenanceChain: [
      ...envelope.provenanceChain,
      {
        system: 'rorca-request-identity',
        eventId: principal.id,
        // Keep normalization deterministic so replaying the same envelope is idempotent.
        observedAt: envelope.observedAt,
        principal: principal.displayName,
        verification: principal.adapterVerified ? 'adapter-verified' : 'authenticated-request',
      },
    ],
    actor: manual ? principal.displayName : null,
    rationale: manual ? envelope.rationale : null,
    details: envelope.details,
    upstreamPayloadHash: envelope.payloadHash,
  });
}

function rowToEvidence(row: EvidenceRow): StoredLifecycleEvidence {
  const metadata = parseJsonObject(row.metadata);
  const provenance = parseJsonObject(row.provenance);
  const release = normalizeReleaseIdentity(parseJsonObject(row.release_identity));
  const phaseSubject = row.phase_subject_type && row.phase_subject_value
    ? { type: row.phase_subject_type, value: row.phase_subject_value }
    : null;
  const chain = Array.isArray(provenance.chain) ? provenance.chain as EvidenceProvenanceHop[] : [];
  return {
    id: String(row.id),
    createdAt: row.created_at,
    schemaVersion: LIFECYCLE_EVIDENCE_SCHEMA_VERSION,
    source: {
      type: row.source_type,
      system: row.source_system,
      eventId: row.source_idempotency_key,
    },
    observedAt: isoTimestamp(row.observed_at, 'stored.observedAt'),
    scope: {
      workspaceId: row.workspace_id,
      specSlug: row.spec_slug,
      runId: row.run_id,
      storyId: row.story_id,
      phaseId: row.phase_id,
      gateId: row.gate_id,
    },
    subject: { type: row.subject_type, value: row.subject_value },
    phaseSubject,
    releaseIdentity: release,
    classification: row.classification,
    status: row.evidence_status,
    trustLevel: row.trust_level,
    confidence: Number(row.confidence),
    excerpt: row.excerpt,
    rawReference: row.source_ref,
    provenanceChain: chain,
    actor: row.actor,
    rationale: row.rationale,
    details: parseJsonObject(metadata.details),
    revisionMismatch: row.revision_mismatch,
    lineageVerified: row.lineage_verified,
    sourcePayloadHash: typeof metadata.sourcePayloadHash === 'string' ? metadata.sourcePayloadHash : null,
    payloadHash: row.payload_hash,
  };
}

export function sanitizeEvidenceForRendering<T extends CanonicalLifecycleEvidence | StoredLifecycleEvidence>(evidence: T): T {
  // Typed hashes/digests/IDs are identities, not free text. Re-sanitize only fields
  // that can contain human/provider payload so API rendering cannot reintroduce secrets.
  return {
    ...evidence,
    excerpt: sanitizeText(evidence.excerpt, MAX_EVIDENCE_EXCERPT_BYTES),
    rawReference: sanitizeText(evidence.rawReference, MAX_EVIDENCE_REFERENCE_BYTES),
    actor: sanitizeText(evidence.actor, 512),
    rationale: sanitizeText(evidence.rationale, 4_096),
    details: sanitizeObject(evidence.details),
    provenanceChain: evidence.provenanceChain.map((hop) => ({
      ...hop,
      ...(hop.principal ? { principal: sanitizeText(hop.principal, 512)! } : {}),
      ...(hop.verification ? { verification: sanitizeText(hop.verification, 512)! } : {}),
    })),
  } as T;
}

async function findEvidenceBySource(
  evidence: CanonicalLifecycleEvidence,
  db: EvidenceDb,
): Promise<EvidenceRow | undefined> {
  return await db.queryOne<EvidenceRow>(`
    SELECT * FROM ssdlc_lifecycle_evidence
    WHERE workspace_id = $1 AND source_system = $2 AND source_idempotency_key = $3
  `, [evidence.scope.workspaceId, evidence.source.system, evidence.source.eventId]);
}

async function auditEvidenceConflict(
  existing: EvidenceRow,
  incoming: CanonicalLifecycleEvidence,
  db: EvidenceDb,
): Promise<void> {
  await db.execute(`
    INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
    VALUES ('ssdlc_evidence_source_conflict', $1, $2, $3, 'ssdlc-evidence', $4::jsonb)
  `, [
    existing.workspace_id,
    existing.spec_slug,
    existing.story_id,
    JSON.stringify({
      sourceSystem: existing.source_system,
      sourceEventId: existing.source_idempotency_key,
      evidenceId: existing.id,
      existingPayloadHash: existing.payload_hash,
      incomingPayloadHash: incoming.payloadHash,
      observedAt: new Date().toISOString(),
    }),
  ]);
}

export async function persistCanonicalEvidence(
  evidenceInput: CanonicalLifecycleEvidence,
  db: EvidenceDb = DEFAULT_DB,
): Promise<EvidencePersistenceResult> {
  const evidence = sanitizeEvidenceForRendering(evidenceInput);
  const row = await db.queryOne<EvidenceRow>(`
    INSERT INTO ssdlc_lifecycle_evidence (
      workspace_id, spec_slug, revision, run_id, story_id, phase_id, gate_id,
      evidence_type, subject_type, subject_value, source_system, source_idempotency_key,
      payload_hash, metadata, provenance, source_ref, observed_at,
      source_type, classification, evidence_status, trust_level, confidence, excerpt,
      release_identity, phase_subject_type, phase_subject_value, revision_mismatch,
      lineage_verified, actor, rationale
    )
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21, $22,
           $23, $24::jsonb, $25, $26, $27, $28, $29, $30
    FROM workspaces w
    WHERE w.id = $1
      AND ($4::bigint IS NULL OR EXISTS (
        SELECT 1 FROM pipeline_runs pr WHERE pr.id = $4 AND pr.workspace_id = $1
      ))
    ON CONFLICT (workspace_id, source_system, source_idempotency_key) DO NOTHING
    RETURNING *
  `, [
    evidence.scope.workspaceId,
    evidence.scope.specSlug,
    evidence.releaseIdentity.commitSha,
    evidence.scope.runId,
    evidence.scope.storyId,
    evidence.scope.phaseId,
    evidence.scope.gateId,
    evidence.classification,
    evidence.subject.type,
    evidence.subject.value,
    evidence.source.system,
    evidence.source.eventId,
    evidence.payloadHash,
    JSON.stringify({
      schemaVersion: evidence.schemaVersion,
      details: evidence.details,
      sourcePayloadHash: evidence.sourcePayloadHash,
    }),
    JSON.stringify({ chain: evidence.provenanceChain }),
    evidence.rawReference,
    evidence.observedAt,
    evidence.source.type,
    evidence.classification,
    evidence.status,
    evidence.trustLevel,
    evidence.confidence,
    evidence.excerpt,
    JSON.stringify(evidence.releaseIdentity),
    evidence.phaseSubject?.type ?? null,
    evidence.phaseSubject?.value ?? null,
    evidence.revisionMismatch,
    evidence.lineageVerified,
    evidence.actor,
    evidence.rationale,
  ]);

  if (row) return { evidence: sanitizeEvidenceForRendering(rowToEvidence(row)), replayed: false };

  const existing = await findEvidenceBySource(evidence, db);
  if (existing) {
    if (existing.payload_hash === evidence.payloadHash) {
      return { evidence: sanitizeEvidenceForRendering(rowToEvidence(existing)), replayed: true };
    }
    await auditEvidenceConflict(existing, evidence, db);
    throw new ConflictError('Evidence source event ID has a conflicting immutable payload; conflict was audit-recorded');
  }

  const workspace = await db.queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [evidence.scope.workspaceId]);
  if (!workspace) throw new NotFoundError('Workspace', evidence.scope.workspaceId);
  throw new ValidationError('scope.runId does not belong to the evidence workspace', { runId: evidence.scope.runId });
}

export interface EvidenceGatePolicy {
  gateType: 'code' | 'build' | 'staging' | 'production' | 'general';
  acceptedTrustLevels: EvidenceTrustLevel[];
  acceptedSubjectTypes?: EvidenceSubjectType[];
  phaseSubject?: EvidenceSubjectIdentity | null;
  expectedReleaseIdentity?: Partial<EvidenceReleaseIdentity>;
}

export function canEvidenceSatisfyGate(
  evidence: CanonicalLifecycleEvidence,
  policy: EvidenceGatePolicy,
): boolean {
  // Unknown and every non-passed classification are explicitly ineligible.
  if (evidence.status !== 'passed') return false;
  if (evidence.revisionMismatch) return false;
  if (!policy.acceptedTrustLevels.includes(evidence.trustLevel)) return false;
  if (policy.acceptedSubjectTypes && !policy.acceptedSubjectTypes.includes(evidence.subject.type)) return false;
  if (policy.phaseSubject && !phaseBindingMatches(evidence.subject, policy.phaseSubject, evidence.releaseIdentity)) return false;

  const expected = normalizeReleaseIdentity(policy.expectedReleaseIdentity);
  const releaseMatches = (field: keyof EvidenceReleaseIdentity): boolean => {
    const value = expected[field];
    return !value || comparableIdentity(evidence.releaseIdentity[field] ?? '') === comparableIdentity(value);
  };

  if (policy.gateType === 'code') return evidence.subject.type === 'commit_sha';
  if (policy.gateType === 'build' || policy.gateType === 'staging') {
    return evidence.subject.type === 'artifact_digest'
      && evidence.lineageVerified
      && releaseMatches('commitSha')
      && releaseMatches('artifactDigest');
  }
  if (policy.gateType === 'production') {
    return evidence.source.type === 'deployment_proof'
      && evidence.subject.type === 'deployment_id'
      && evidence.lineageVerified
      && releaseMatches('commitSha')
      && releaseMatches('artifactDigest')
      && releaseMatches('deploymentId');
  }
  return true;
}

export interface InternalAdapterContext {
  scope: EvidenceScope;
  phaseSubject?: EvidenceSubjectIdentity | null;
}

export interface StoryResultEvidenceRow {
  id: number | string;
  story_id: string;
  status: string;
  reason?: string | null;
  log_path?: string | null;
  started_at: Date | string;
  finished_at?: Date | string | null;
  model_used?: string | null;
  retries?: number;
}

function storyResultStatus(row: StoryResultEvidenceRow): EvidenceStatus {
  if (row.status === 'pass') return 'passed';
  if (row.status === 'fail') return 'story_caused_failure';
  if (row.status === 'timeout') return 'environment_credential_blocker';
  if (row.status === 'skip' || row.status === 'excluded') return row.reason ? 'skipped_with_rationale' : 'unknown';
  return 'unknown';
}

export function normalizeStoryResultEvidence(
  row: StoryResultEvidenceRow,
  context: InternalAdapterContext,
): CanonicalLifecycleEvidence {
  const status = storyResultStatus(row);
  return createCanonicalEvidence({
    sourceType: 'story_result',
    sourceSystem: 'rorca:story_results',
    sourceEventId: `story-result:${row.id}`,
    observedAt: row.finished_at ?? row.started_at,
    scope: { ...context.scope, storyId: row.story_id },
    subject: context.phaseSubject ?? { type: 'spec_hash', value: `spec:${context.scope.specSlug}` },
    phaseSubject: context.phaseSubject,
    classification: 'validation',
    status,
    trustLevel: 'host_observed',
    confidence: status === 'unknown' ? 0 : 1,
    excerpt: row.reason ?? null,
    rawReference: row.log_path ?? (context.scope.runId ? `run-output-chunks:${context.scope.runId}` : null),
    provenanceChain: [{
      system: 'rorca:story_results',
      eventId: String(row.id),
      observedAt: isoTimestamp(row.finished_at ?? row.started_at, 'storyResult.observedAt'),
      verification: 'host-database-row',
    }],
    details: { modelUsed: row.model_used ?? null, retries: row.retries ?? 0 },
  });
}

export interface StoryCommitEvidenceRow {
  id: number | string;
  story_id: string;
  commit_sha: string;
  commit_message: string;
  author: string;
  pushed_at: Date | string;
}

export function normalizeStoryCommitEvidence(
  row: StoryCommitEvidenceRow,
  context: InternalAdapterContext,
  providerVerified = false,
): CanonicalLifecycleEvidence {
  return createCanonicalEvidence({
    sourceType: 'story_commit',
    sourceSystem: 'rorca:story_commits',
    sourceEventId: `story-commit:${row.story_id}:${row.commit_sha}`,
    observedAt: row.pushed_at,
    scope: { ...context.scope, storyId: row.story_id },
    subject: { type: 'commit_sha', value: row.commit_sha },
    phaseSubject: context.phaseSubject,
    releaseIdentity: { commitSha: row.commit_sha },
    classification: 'revision',
    status: 'passed',
    trustLevel: providerVerified ? 'provider_verified' : 'host_observed',
    confidence: providerVerified ? 1 : 0.9,
    excerpt: row.commit_message,
    rawReference: `git:commit:${row.commit_sha}`,
    provenanceChain: [{
      system: 'rorca:story_commits',
      eventId: String(row.id),
      observedAt: isoTimestamp(row.pushed_at, 'storyCommit.pushedAt'),
      principal: row.author,
      verification: providerVerified ? 'github-webhook-verified' : 'host-database-row',
    }],
  });
}

export interface WalEvidenceRow {
  id: number | string;
  ts: Date | string;
  event_type: string;
  story_id?: string | null;
  payload: Record<string, unknown> | string | null;
}

function validationStatusFromValue(value: unknown, rationale?: unknown): EvidenceStatus {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.toLowerCase().replace(/[ -]/g, '_');
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'success') return 'passed';
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'story_caused_failure') return 'story_caused_failure';
  if (normalized === 'unrelated_baseline' || normalized === 'baseline_failure') return 'unrelated_baseline';
  if (normalized === 'environment_credential_blocker' || normalized === 'environment_blocker' || normalized === 'credential_blocker') return 'environment_credential_blocker';
  if ((normalized === 'skip' || normalized === 'skipped' || normalized === 'skipped_with_rationale') && rationale) return 'skipped_with_rationale';
  return 'unknown';
}

export function normalizeWalValidationEvidence(
  row: WalEvidenceRow,
  context: InternalAdapterContext,
): CanonicalLifecycleEvidence {
  const payload = parseJsonObject(row.payload);
  const status = validationStatusFromValue(payload.classification ?? payload.status ?? payload.outcome, payload.rationale ?? payload.reason);
  const subject = isRecord(payload.subject)
    ? normalizeSubject(payload.subject, 'wal.subject')
    : context.phaseSubject ?? { type: 'spec_hash', value: `spec:${context.scope.specSlug}` };
  return createCanonicalEvidence({
    sourceType: 'wal_validation',
    sourceSystem: 'rorca:wal_events',
    sourceEventId: `wal:${row.event_type}:${isoTimestamp(row.ts, 'wal.ts')}`,
    observedAt: row.ts,
    scope: { ...context.scope, storyId: row.story_id ?? context.scope.storyId },
    subject,
    phaseSubject: context.phaseSubject,
    classification: 'validation',
    status,
    trustLevel: 'host_observed',
    confidence: status === 'unknown' ? 0 : 1,
    excerpt: typeof payload.summary === 'string' ? payload.summary : typeof payload.reason === 'string' ? payload.reason : null,
    rawReference: `wal-events:${row.id}`,
    provenanceChain: [{
      system: 'rorca:wal_events',
      eventId: String(row.id),
      observedAt: isoTimestamp(row.ts, 'wal.ts'),
      verification: 'host-wal-row',
    }],
    rationale: null,
    details: { eventType: row.event_type },
  });
}

export function normalizeGithubCheckEvidence(
  row: WalEvidenceRow,
  context: InternalAdapterContext,
  providerVerified = true,
): CanonicalLifecycleEvidence {
  const payload = parseJsonObject(row.payload);
  const checkId = requiredText(payload.check_run_id ?? payload.checkRunId, 'githubCheck.checkRunId', 512);
  const sha = requiredText(payload.sha, 'githubCheck.sha', 1_024);
  const status = validationStatusFromValue(payload.conclusion ?? payload.status);
  return createCanonicalEvidence({
    sourceType: 'github_check',
    sourceSystem: 'github:checks',
    sourceEventId: `github-check:${checkId}`,
    observedAt: row.ts,
    scope: context.scope,
    subject: { type: 'commit_sha', value: sha },
    phaseSubject: context.phaseSubject,
    releaseIdentity: { commitSha: sha },
    classification: 'validation',
    status,
    trustLevel: providerVerified ? 'provider_verified' : 'host_observed',
    confidence: providerVerified ? 1 : 0.8,
    excerpt: typeof payload.summary === 'string' ? payload.summary : null,
    rawReference: typeof payload.html_url === 'string' ? payload.html_url : `github-checks:${checkId}`,
    provenanceChain: [{
      system: 'github:checks',
      eventId: checkId,
      observedAt: isoTimestamp(row.ts, 'githubCheck.ts'),
      verification: providerVerified ? 'provider-response-verified' : 'host-observed',
    }],
  });
}

export function normalizeCompletionEvidence(
  row: WalEvidenceRow,
  context: InternalAdapterContext,
): CanonicalLifecycleEvidence {
  const payload = parseJsonObject(row.payload);
  const status = row.event_type === 'story_passed' || (row.event_type === 'run_finished' && payload.status === 'done')
    ? 'passed'
    : row.event_type === 'story_failed' || (row.event_type === 'run_finished' && payload.status === 'failed')
      ? 'story_caused_failure'
      : row.event_type === 'story_skipped' && (payload.reason || payload.rationale)
        ? 'skipped_with_rationale'
        : 'unknown';
  return createCanonicalEvidence({
    sourceType: 'completion_signal',
    sourceSystem: 'rorca:wal_events',
    sourceEventId: `completion:${row.event_type}:${isoTimestamp(row.ts, 'completion.ts')}`,
    observedAt: row.ts,
    scope: { ...context.scope, storyId: row.story_id ?? context.scope.storyId },
    subject: context.phaseSubject ?? { type: 'spec_hash', value: `spec:${context.scope.specSlug}` },
    phaseSubject: context.phaseSubject,
    classification: 'completion',
    status,
    trustLevel: 'host_observed',
    confidence: status === 'unknown' ? 0 : 1,
    excerpt: typeof payload.reason === 'string' ? payload.reason : null,
    rawReference: `wal-events:${row.id}`,
    provenanceChain: [{
      system: 'rorca:wal_events',
      eventId: String(row.id),
      observedAt: isoTimestamp(row.ts, 'completion.ts'),
      verification: 'host-wal-row',
    }],
    details: { eventType: row.event_type },
  });
}

export interface RunOutputReferenceRow {
  first_sequence: number | string | null;
  last_sequence: number | string | null;
  byte_length: number | string | null;
  observed_at?: Date | string | null;
}

export function normalizeRunOutputReferenceEvidence(
  row: RunOutputReferenceRow,
  context: InternalAdapterContext,
  observedAt: Date | string,
): CanonicalLifecycleEvidence {
  if (!context.scope.runId) throw new ValidationError('run output evidence requires scope.runId');
  const first = Number(row.first_sequence ?? 0);
  const last = Number(row.last_sequence ?? 0);
  return createCanonicalEvidence({
    sourceType: 'completion_signal',
    sourceSystem: 'rorca:run_output_chunks',
    sourceEventId: `run-output:${context.scope.runId}:${first}-${last}`,
    observedAt,
    scope: context.scope,
    subject: context.phaseSubject ?? { type: 'spec_hash', value: `spec:${context.scope.specSlug}` },
    phaseSubject: context.phaseSubject,
    classification: 'completion',
    status: 'unknown',
    trustLevel: 'host_observed',
    confidence: 1,
    excerpt: null,
    rawReference: `run-output-chunks:${context.scope.runId}?sequence=${first}-${last}`,
    provenanceChain: [{
      system: 'rorca:run_output_chunks',
      eventId: `${context.scope.runId}:${first}-${last}`,
      observedAt: isoTimestamp(observedAt, 'runOutput.observedAt'),
      verification: 'metadata-only-no-chunk-copy',
    }],
    details: { firstSequence: first, lastSequence: last, byteLength: Number(row.byte_length ?? 0) },
  });
}

export interface AdapterRunResult {
  adapter: string;
  persisted: number;
  replayed: number;
  failed: boolean;
}

async function recordAdapterError(
  adapter: string,
  context: InternalAdapterContext,
  error: unknown,
  db: EvidenceDb,
): Promise<void> {
  try {
    await db.execute(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
      VALUES ('ssdlc_evidence_adapter_error', $1, $2, $3, 'ssdlc-evidence', $4::jsonb)
    `, [
      context.scope.workspaceId,
      context.scope.specSlug,
      context.scope.storyId,
      JSON.stringify({
        adapter,
        runId: context.scope.runId,
        retryable: true,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        observedAt: new Date().toISOString(),
      }),
    ]);
  } catch (auditError) {
    logger.warn({ err: auditError, adapter }, '[ssdlc-evidence] Failed to audit adapter error');
  }
}

async function runAdapter(
  adapter: string,
  context: InternalAdapterContext,
  load: () => Promise<CanonicalLifecycleEvidence[]>,
  db: EvidenceDb,
): Promise<AdapterRunResult> {
  let persisted = 0;
  let replayed = 0;
  let failed = false;
  try {
    const evidence = await load();
    for (const item of evidence) {
      try {
        const result = await persistCanonicalEvidence(item, db);
        result.replayed ? replayed += 1 : persisted += 1;
      } catch (error) {
        if (error instanceof ConflictError) throw error;
        failed = true;
        await recordAdapterError(adapter, context, error, db);
      }
    }
    return { adapter, persisted, replayed, failed };
  } catch (error) {
    await recordAdapterError(adapter, context, error, db);
    return { adapter, persisted, replayed, failed: true };
  }
}

export async function normalizeExistingRunEvidence(
  contextInput: InternalAdapterContext,
  db: EvidenceDb = DEFAULT_DB,
): Promise<AdapterRunResult[]> {
  const context: InternalAdapterContext = {
    scope: normalizeScope(contextInput.scope),
    phaseSubject: contextInput.phaseSubject == null ? null : normalizeSubject(contextInput.phaseSubject, 'phaseSubject'),
  };
  const runId = context.scope.runId;
  if (!runId) throw new ValidationError('Internal run evidence normalization requires scope.runId');
  const runText = String(runId);

  const adapters: Array<Promise<AdapterRunResult>> = [
    runAdapter('story_results', context, async () => {
      const rows = await db.query<StoryResultEvidenceRow>(`
        SELECT sr.* FROM story_results sr
        JOIN pipeline_runs pr ON pr.id = sr.run_id
        WHERE pr.workspace_id = $1 AND sr.run_id = $2
        ORDER BY sr.started_at, sr.id
      `, [context.scope.workspaceId, runId]);
      return rows.map((row) => normalizeStoryResultEvidence(row, context));
    }, db),
    runAdapter('story_commits', context, async () => {
      const rows = await db.query<StoryCommitEvidenceRow>(`
        SELECT id, story_id, commit_sha, commit_message, author, pushed_at
        FROM story_commits
        WHERE workspace_id = $1 AND spec_id = $2
        ORDER BY pushed_at, id
      `, [context.scope.workspaceId, context.scope.specSlug]);
      return rows.map((row) => normalizeStoryCommitEvidence(row, context, true));
    }, db),
    runAdapter('wal_validation', context, async () => {
      const rows = await db.query<WalEvidenceRow>(`
        SELECT id, ts, event_type, story_id, payload FROM wal_events
        WHERE workspace_id = $1
          AND event_type IN ('validation_result', 'validation_completed', 'story_validation')
          AND (payload->>'run_id' = $2 OR payload->>'runId' = $2)
        ORDER BY ts, id
      `, [context.scope.workspaceId, runText]);
      return rows.map((row) => normalizeWalValidationEvidence(row, context));
    }, db),
    runAdapter('github_checks', context, async () => {
      const rows = await db.query<WalEvidenceRow>(`
        SELECT id, ts, event_type, story_id, payload FROM wal_events
        WHERE workspace_id = $1 AND event_type = 'check_run_completed' AND actor = 'github'
          AND (payload->>'run_id' = $2 OR payload->>'runId' = $2)
        ORDER BY ts, id
      `, [context.scope.workspaceId, runText]);
      return rows.map((row) => normalizeGithubCheckEvidence(row, context, true));
    }, db),
    runAdapter('completion_signals', context, async () => {
      const rows = await db.query<WalEvidenceRow>(`
        SELECT id, ts, event_type, story_id, payload FROM wal_events
        WHERE workspace_id = $1
          AND event_type IN ('story_passed', 'story_failed', 'story_skipped', 'run_finished')
          AND (payload->>'run_id' = $2 OR payload->>'runId' = $2)
        ORDER BY ts, id
      `, [context.scope.workspaceId, runText]);
      return rows.map((row) => normalizeCompletionEvidence(row, context));
    }, db),
    runAdapter('run_output_reference', context, async () => {
      const rows = await db.query<RunOutputReferenceRow>(`
        SELECT MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence,
               COALESCE(SUM(octet_length(chunk)), 0) AS byte_length,
               MAX(created_at) AS observed_at
        FROM run_output_chunks WHERE run_id = $1
        HAVING COUNT(*) > 0
      `, [runId]);
      return rows.map((row) => normalizeRunOutputReferenceEvidence(row, context, row.observed_at ?? new Date(0)));
    }, db),
  ];

  return await Promise.all(adapters);
}

export async function paginateNormalizedEvidence(
  workspaceIdInput: string,
  filters: { specSlug?: string; runId?: number; storyId?: string; phaseId?: string; gateId?: string },
  pagination: PaginationParams,
): Promise<PaginatedResponse<StoredLifecycleEvidence>> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId', 256);
  const values: unknown[] = [workspaceId];
  const conditions = ['workspace_id = $1'];
  const add = (column: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    values.push(value);
    conditions.push(`${column} = $${values.length}`);
  };
  add('spec_slug', filters.specSlug);
  add('run_id', filters.runId);
  add('story_id', filters.storyId);
  add('phase_id', filters.phaseId);
  add('gate_id', filters.gateId);
  const where = conditions.join(' AND ');
  const result = await paginateQuery<EvidenceRow>({
    query: `SELECT * FROM ssdlc_lifecycle_evidence WHERE ${where}`,
    countQuery: `SELECT COUNT(*)::int AS total FROM ssdlc_lifecycle_evidence WHERE ${where}`,
    params: values,
    pagination,
    orderBy: 'id DESC',
    cursorColumn: 'id',
    cursorDirection: 'desc',
  });
  return {
    ...result,
    items: result.items.map((row) => sanitizeEvidenceForRendering(rowToEvidence(row))),
  };
}
