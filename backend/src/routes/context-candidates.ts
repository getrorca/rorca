/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { paginateQuery, parsePaginationParams } from '../lib/paginate';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { promoteMemory } from '../lib/memory-promotion';
import { broadcastAll } from '../lib/sse-hub';
import {
  CONTEXT_SAFETY_CONTRACT_VERSION,
  analyzeContextSafety,
  enforceContextSizeLimit,
  hashContextContent,
  loadContextCaptureIgnoreFile,
  redactContextPayload,
  redactContextText,
  safeNormalizeWorkspaceRelativePath,
  shouldCapturePath,
  type ContextIgnoreSettings,
  type ContextSafetyDiagnostics,
} from '../lib/context-safety';
import {
  CONTEXT_EVENT_TYPES,
  CONTEXT_TRUST_TIERS,
  MEMORY_CANDIDATE_CATEGORIES,
  MEMORY_CANDIDATE_CONFIDENCES,
  MEMORY_CANDIDATE_STATUSES,
  buildMemoryCandidateIdempotencyKey,
  normalizeJsonObject,
  normalizeRelatedFiles,
  parseOptionalDate,
  parsePositiveId,
  type ContextEventType,
  type ContextTrustTier,
  type JsonObject,
  type MemoryCandidateCategory,
  type MemoryCandidateConfidence,
  type MemoryCandidateStatus,
} from '../lib/context-capture';

const router = Router();

const CandidateCreateSchema = z.object({
  workspaceId: z.string().trim().min(1),
  contextEventId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  eventType: z.enum(CONTEXT_EVENT_TYPES).optional(),
  sourceSystem: z.string().trim().min(1).optional(),
  sourceRef: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  occurredAt: z.string().trim().min(1).optional(),
  suggestedCategory: z.enum(MEMORY_CANDIDATE_CATEGORIES),
  title: z.string().trim().min(1),
  rule: z.string().trim().min(1),
  context: z.string().default(''),
  relatedFiles: z.unknown().optional(),
  confidence: z.enum(MEMORY_CANDIDATE_CONFIDENCES).default('low'),
  trustTier: z.enum(CONTEXT_TRUST_TIERS).optional(),
  idempotencyKey: z.string().trim().min(1).max(512).optional(),
  provenance: z.unknown().optional(),
  metadata: z.unknown().optional(),
  claim: z.string().optional(),
  policy: z.string().optional(),
  incidentLearning: z.string().optional(),
  securitySensitive: z.boolean().optional(),
  regulatedDomain: z.boolean().optional(),
  requiresReview: z.boolean().optional(),
});

const CandidateEditSchema = z.object({
  suggestedCategory: z.enum(MEMORY_CANDIDATE_CATEGORIES).optional(),
  category: z.enum(MEMORY_CANDIDATE_CATEGORIES).optional(),
  title: z.string().trim().min(1).optional(),
  rule: z.string().trim().min(1).optional(),
  context: z.string().optional(),
  relatedFiles: z.unknown().optional(),
  confidence: z.enum(MEMORY_CANDIDATE_CONFIDENCES).optional(),
  provenance: z.unknown().optional(),
  metadata: z.unknown().optional(),
});

const ApproveBodySchema = CandidateEditSchema.extend({
  workspaceId: z.string().trim().min(1).optional(),
  reviewer: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
  sourceSpecId: z.string().trim().min(1).optional(),
  sourceStoryId: z.string().trim().min(1).optional(),
  sourceRunId: z.union([z.string().trim().min(1), z.number()]).optional(),
  regulatedReviewConfirmed: z.boolean().optional(),
  edits: CandidateEditSchema.optional(),
});

const RejectBodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  reviewer: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1),
  metadata: z.unknown().optional(),
});

const LifecycleBodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  reviewer: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
  duplicateOfCandidateId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  duplicateOfMemoryId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  supersededByCandidateId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  supersededByMemoryId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  conflictingCandidateId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  conflictingMemoryId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  deferUntil: z.string().trim().min(1).optional(),
  metadata: z.unknown().optional(),
});

type CandidateCreateInput = z.infer<typeof CandidateCreateSchema>;
type CandidateEditInput = z.infer<typeof CandidateEditSchema>;
type ApproveBody = z.infer<typeof ApproveBodySchema>;
type RejectBody = z.infer<typeof RejectBodySchema>;
type LifecycleBody = z.infer<typeof LifecycleBodySchema>;

interface WorkspaceRow {
  id: string;
  path: string;
}

interface ContextEventRow {
  id: string;
  workspaceId: string;
  eventType: ContextEventType;
  sourceSystem: string;
  sourceRef: string;
  actor: string | null;
  occurredAt: string;
  relatedFiles: unknown;
  provenance: unknown;
  metadata: unknown;
  trustTier: ContextTrustTier;
}

export interface MemoryCandidateResponse {
  id: string;
  workspaceId: string;
  contextEventId: string | null;
  eventType: ContextEventType | null;
  sourceSystem: string | null;
  sourceRef: string | null;
  actor: string | null;
  occurredAt: string | null;
  suggestedCategory: MemoryCandidateCategory;
  title: string;
  rule: string;
  context: string;
  relatedFiles: string[];
  confidence: MemoryCandidateConfidence;
  trustTier: ContextTrustTier;
  reviewStatus: MemoryCandidateStatus;
  reviewer: string | null;
  reviewedAt: string | null;
  promotedMemoryId: number | null;
  promotedAt: string | null;
  idempotencyKey: string;
  provenance: JsonObject;
  metadata: JsonObject;
  claim: string | null;
  policy: string | null;
  incidentLearning: string | null;
  securitySensitive: boolean;
  regulatedDomain: boolean;
  requiresReview: boolean;
  createdAt: string;
  updatedAt: string;
}

const CANDIDATE_SELECT = `
  SELECT id::text AS id,
         workspace_id AS "workspaceId",
         context_event_id::text AS "contextEventId",
         event_type AS "eventType",
         source_system AS "sourceSystem",
         source_ref AS "sourceRef",
         actor,
         occurred_at AS "occurredAt",
         suggested_category AS "suggestedCategory",
         title,
         rule,
         context,
         related_files AS "relatedFiles",
         confidence,
         trust_tier AS "trustTier",
         review_status AS "reviewStatus",
         reviewer,
         reviewed_at AS "reviewedAt",
         promoted_memory_id AS "promotedMemoryId",
         promoted_at AS "promotedAt",
         idempotency_key AS "idempotencyKey",
         provenance,
         metadata,
         claim,
         policy,
         incident_learning AS "incidentLearning",
         security_sensitive AS "securitySensitive",
         regulated_domain AS "regulatedDomain",
         requires_review AS "requiresReview",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
    FROM memory_candidates`;

const CONTEXT_EVENT_SELECT = `
  SELECT id::text AS id,
         workspace_id AS "workspaceId",
         event_type AS "eventType",
         source_system AS "sourceSystem",
         source_ref AS "sourceRef",
         actor,
         occurred_at AS "occurredAt",
         related_files AS "relatedFiles",
         provenance,
         metadata,
         trust_tier AS "trustTier"
    FROM context_events`;

function parseWithSchema<T extends z.ZodTypeAny>(schema: T, value: unknown, message: string): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ValidationError(message, { issues: result.error.issues });
  }
  return result.data;
}

function normalizeCandidateRow(row: MemoryCandidateResponse): MemoryCandidateResponse {
  return {
    ...row,
    relatedFiles: normalizeRelatedFiles(row.relatedFiles),
    provenance: normalizeJsonObject(row.provenance, 'provenance'),
    metadata: normalizeJsonObject(row.metadata, 'metadata'),
  };
}

async function assertWorkspace(workspaceId: string): Promise<WorkspaceRow> {
  const workspace = await queryOne<WorkspaceRow>('SELECT id, path FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace', workspaceId);
  }
  return workspace;
}

function workspaceIgnoreSettings(workspacePath: string): ContextIgnoreSettings {
  const captureIgnore = loadContextCaptureIgnoreFile(workspacePath);
  return captureIgnore ? { paths: captureIgnore.patterns } : {};
}

function normalizeCaptureRelatedFiles(value: unknown, workspacePath: string): string[] {
  const ignore = workspaceIgnoreSettings(workspacePath);
  return normalizeRelatedFiles(value).map((filePath) => {
    let normalized: string;
    try {
      normalized = safeNormalizeWorkspaceRelativePath(workspacePath, filePath);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : `Invalid related file: ${filePath}`);
    }
    if (!shouldCapturePath(normalized, ignore)) {
      throw new ValidationError(`Related file is ignored by capture safety rules: ${normalized}`);
    }
    return normalized;
  });
}

const CONTEXT_FILE_PREVIEW_MAX_BYTES = 16 * 1024;

async function buildRelatedFilePreview(candidate: MemoryCandidateResponse, workspace: WorkspaceRow, requestedPath: string) {
  const normalizedPath = safeNormalizeWorkspaceRelativePath(workspace.path, requestedPath);
  const ignore = workspaceIgnoreSettings(workspace.path);

  if (!candidate.relatedFiles.includes(normalizedPath)) {
    throw new ValidationError('File preview is limited to files attached to this memory candidate');
  }
  if (!shouldCapturePath(normalizedPath, ignore)) {
    throw new ValidationError(`Related file is ignored by capture safety rules: ${normalizedPath}`);
  }

  const absolutePath = path.join(workspace.path, normalizedPath);

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return {
        path: normalizedPath,
        fileName: path.basename(normalizedPath),
        exists: false,
        text: '',
        truncated: false,
        byteLength: stat.size,
        maxPreviewBytes: CONTEXT_FILE_PREVIEW_MAX_BYTES,
        withinCaptureLimit: false,
        redactionApplied: false,
        sha256: null,
        safety: analyzeContextSafety('', {}),
      };
    }

    const bytesToRead = Math.min(stat.size, CONTEXT_FILE_PREVIEW_MAX_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await fs.open(absolutePath, 'r');
    let bytesRead = 0;
    try {
      const result = await handle.read(buffer, 0, bytesToRead, 0);
      bytesRead = result.bytesRead;
    } finally {
      await handle.close();
    }

    const rawText = buffer.subarray(0, bytesRead).toString('utf8');
    const redactedText = String(redactContextPayload(rawText, {}, { repoPath: workspace.path }));
    const safety = analyzeContextSafety(rawText, {});

    return {
      path: normalizedPath,
      fileName: path.basename(normalizedPath),
      exists: true,
      text: redactedText,
      truncated: stat.size > bytesRead,
      byteLength: stat.size,
      maxPreviewBytes: CONTEXT_FILE_PREVIEW_MAX_BYTES,
      withinCaptureLimit: enforceContextSizeLimit(stat.size, ignore, 'file'),
      redactionApplied: rawText !== redactedText,
      sha256: hashContextContent(redactedText),
      safety,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        path: normalizedPath,
        fileName: path.basename(normalizedPath),
        exists: false,
        text: '',
        truncated: false,
        byteLength: 0,
        maxPreviewBytes: CONTEXT_FILE_PREVIEW_MAX_BYTES,
        withinCaptureLimit: false,
        redactionApplied: false,
        sha256: null,
        safety: analyzeContextSafety('', {}),
      };
    }
    throw error;
  }
}

function redactJsonObject(value: unknown, fieldName: string, workspacePath: string): JsonObject {
  return normalizeJsonObject(
    redactContextPayload(value, {}, { repoPath: workspacePath }),
    fieldName,
  );
}

async function assertMemory(workspaceId: string, memoryId: number): Promise<void> {
  const memory = await queryOne<{ id: number }>(
    'SELECT id FROM memories WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [memoryId, workspaceId],
  );
  if (!memory) {
    throw new NotFoundError('Memory', String(memoryId));
  }
}

async function loadContextEvent(workspaceId: string, contextEventId: number): Promise<ContextEventRow> {
  const event = await queryOne<ContextEventRow>(
    `${CONTEXT_EVENT_SELECT}
      WHERE id = $1
        AND workspace_id = $2`,
    [contextEventId, workspaceId],
  );
  if (!event) {
    throw new NotFoundError('Context event', String(contextEventId));
  }
  return event;
}

async function loadCandidate(id: number, workspaceId?: string): Promise<MemoryCandidateResponse> {
  const params: unknown[] = [id];
  let sql = `${CANDIDATE_SELECT} WHERE id = $1`;
  if (workspaceId) {
    params.push(workspaceId);
    sql += ' AND workspace_id = $2';
  }
  const candidate = await queryOne<MemoryCandidateResponse>(sql, params);
  if (!candidate) {
    throw new NotFoundError('Memory candidate', String(id));
  }
  return normalizeCandidateRow(candidate);
}

async function selectCandidateById(id: number): Promise<MemoryCandidateResponse> {
  return loadCandidate(id);
}

async function emitCandidateAudit(action: string, candidate: MemoryCandidateResponse, details: JsonObject = {}): Promise<void> {
  try {
    const payload = JSON.stringify({
      action,
      candidateId: candidate.id,
      contextEventId: candidate.contextEventId,
      reviewStatus: candidate.reviewStatus,
      promotedMemoryId: candidate.promotedMemoryId,
      relatedFiles: candidate.relatedFiles,
      ...details,
    });
    const walEvent = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id`,
      [`context_candidate_${action}`, candidate.workspaceId, String(details.reviewer ?? candidate.reviewer ?? 'context-capture'), payload],
    );
    if (walEvent) {
      broadcastAll({
        id: walEvent.id,
        event_type: `context_candidate_${action}`,
        workspace_id: candidate.workspaceId,
        spec_id: null,
        story_id: null,
        actor: String(details.reviewer ?? candidate.reviewer ?? 'context-capture'),
        payload,
        ts: new Date().toISOString(),
      } as any);
    }
  } catch {
    // Best-effort audit event. The candidate row retains the authoritative status.
  }
}

function ensureCandidateCanTransition(candidate: MemoryCandidateResponse, action: string): void {
  if (candidate.reviewStatus === 'approved') {
    throw new ConflictError(`Approved candidate ${candidate.id} cannot be ${action}`);
  }
}

function mergedEdits(body: ApproveBody): CandidateEditInput {
  const direct: CandidateEditInput = {
    suggestedCategory: body.suggestedCategory,
    category: body.category,
    title: body.title,
    rule: body.rule,
    context: body.context,
    relatedFiles: body.relatedFiles,
    confidence: body.confidence,
    provenance: body.provenance,
    metadata: body.metadata,
  };
  return { ...(body.edits ?? {}), ...Object.fromEntries(Object.entries(direct).filter(([, value]) => value !== undefined)) };
}

type AppliedCandidateEdits = {
  suggestedCategory: MemoryCandidateCategory;
  title: string;
  rule: string;
  context: string;
  relatedFiles: string[];
  confidence: MemoryCandidateConfidence;
  provenance: JsonObject;
  metadata: JsonObject;
};

function applyEdits(candidate: MemoryCandidateResponse, edits: CandidateEditInput): AppliedCandidateEdits {
  const provenancePatch = edits.provenance === undefined ? {} : normalizeJsonObject(edits.provenance, 'provenance');
  const metadataPatch = edits.metadata === undefined ? {} : normalizeJsonObject(edits.metadata, 'metadata');

  return {
    suggestedCategory: (edits.category ?? edits.suggestedCategory ?? candidate.suggestedCategory) as MemoryCandidateCategory,
    title: edits.title ?? candidate.title,
    rule: edits.rule ?? candidate.rule,
    context: edits.context ?? candidate.context,
    relatedFiles: edits.relatedFiles === undefined ? candidate.relatedFiles : normalizeRelatedFiles(edits.relatedFiles),
    confidence: (edits.confidence ?? candidate.confidence) as MemoryCandidateConfidence,
    provenance: { ...candidate.provenance, ...provenancePatch },
    metadata: { ...candidate.metadata, ...metadataPatch },
  };
}

function sanitizeAppliedEdits(applied: AppliedCandidateEdits, workspacePath: string): AppliedCandidateEdits {
  return {
    ...applied,
    title: redactContextText(applied.title, {}).trim(),
    rule: redactContextText(applied.rule, {}).trim(),
    context: redactContextText(applied.context, {}),
    relatedFiles: normalizeCaptureRelatedFiles(applied.relatedFiles, workspacePath),
    provenance: redactJsonObject(applied.provenance, 'provenance', workspacePath),
    metadata: redactJsonObject(applied.metadata, 'metadata', workspacePath),
  };
}

async function updateCandidateAfterApproval(params: {
  candidateId: number;
  applied: AppliedCandidateEdits;
  reviewer: string;
  promotedMemoryId: string;
  promotionMetadata: JsonObject;
}): Promise<MemoryCandidateResponse> {
  await queryOne<{ id: string }>(
    `UPDATE memory_candidates
        SET suggested_category = $2,
            title = $3,
            rule = $4,
            context = $5,
            related_files = $6::jsonb,
            confidence = $7,
            review_status = 'approved',
            reviewer = $8,
            reviewed_at = NOW(),
            promoted_memory_id = $9,
            promoted_at = NOW(),
            provenance = $10::jsonb,
            metadata = $11::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id::text AS id`,
    [
      params.candidateId,
      params.applied.suggestedCategory,
      params.applied.title,
      params.applied.rule,
      params.applied.context,
      JSON.stringify(params.applied.relatedFiles),
      params.applied.confidence,
      params.reviewer,
      Number(params.promotedMemoryId),
      JSON.stringify(params.applied.provenance),
      JSON.stringify(params.promotionMetadata),
    ],
  );
  return selectCandidateById(params.candidateId);
}

async function markCandidateStatus(params: {
  candidate: MemoryCandidateResponse;
  status: Exclude<MemoryCandidateStatus, 'approved' | 'pending'>;
  reviewer: string;
  metadataPatch: JsonObject;
}): Promise<MemoryCandidateResponse> {
  await queryOne<{ id: string }>(
    `UPDATE memory_candidates
        SET review_status = $2,
            reviewer = $3,
            reviewed_at = NOW(),
            metadata = metadata || $4::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id::text AS id`,
    [Number(params.candidate.id), params.status, params.reviewer, JSON.stringify(params.metadataPatch)],
  );
  return selectCandidateById(Number(params.candidate.id));
}

async function approveFromRequest(req: Request, res: Response, requireEdits: boolean): Promise<void> {
  const candidateId = parsePositiveId(req.params.id, 'candidateId');
  const body = parseWithSchema(ApproveBodySchema, req.body, 'Invalid approve payload') as ApproveBody;
  const candidate = await loadCandidate(candidateId, body.workspaceId);

  if (candidate.reviewStatus === 'approved' && candidate.promotedMemoryId) {
    res.json({ candidate, memory: { id: String(candidate.promotedMemoryId), relatedFiles: candidate.relatedFiles }, approved: true, alreadyApproved: true });
    return;
  }
  if (['rejected', 'duplicate', 'superseded'].includes(candidate.reviewStatus)) {
    throw new ConflictError(`Candidate ${candidate.id} is ${candidate.reviewStatus} and cannot be approved`);
  }
  if (candidate.regulatedDomain && candidate.requiresReview && body.regulatedReviewConfirmed !== true) {
    throw new ConflictError(`Regulated-domain candidate ${candidate.id} requires explicit regulatedReviewConfirmed approval`);
  }

  const edits = mergedEdits(body);
  if (requireEdits && Object.keys(edits).length === 0) {
    throw new ValidationError('edit-and-approve requires at least one editable field');
  }

  const workspace = await assertWorkspace(candidate.workspaceId);
  const reviewer = body.reviewer ?? 'local-user';
  const applied = sanitizeAppliedEdits(applyEdits(candidate, edits), workspace.path);
  const appliedSafety = analyzeContextSafety(applied, {});
  if (appliedSafety.regulatedDomain && body.regulatedReviewConfirmed !== true) {
    throw new ConflictError(`Regulated-domain candidate ${candidate.id} requires explicit regulatedReviewConfirmed approval`);
  }
  const reviewTimestamp = new Date().toISOString();
  const promotionProvenance: JsonObject = {
    ...applied.provenance,
    contextCapture: {
      candidateId: candidate.id,
      contextEventId: candidate.contextEventId,
      eventType: candidate.eventType,
      sourceSystem: candidate.sourceSystem,
      sourceRef: candidate.sourceRef,
      trustTier: candidate.trustTier,
      confidence: applied.confidence,
      reviewer,
      reviewedAt: reviewTimestamp,
      action: requireEdits ? 'edit-and-approve' : 'approve',
      relatedFiles: applied.relatedFiles,
    },
  };

  const promotion = await promoteMemory({
    workspaceId: candidate.workspaceId,
    workspacePath: workspace.path,
    category: applied.suggestedCategory,
    title: applied.title,
    rule: applied.rule,
    context: applied.context,
    source: body.source ?? `context-candidate:${candidate.id}`,
    sourceType: 'auto-extracted',
    sourceSpecId: body.sourceSpecId ?? null,
    sourceStoryId: body.sourceStoryId ?? null,
    sourceRunId: body.sourceRunId ?? null,
    confidence: applied.confidence,
    relatedFiles: applied.relatedFiles,
    provenance: promotionProvenance,
  });

  const promotionMetadata: JsonObject = {
    ...applied.metadata,
    review: {
      action: requireEdits ? 'edit-and-approve' : 'approve',
      reviewer,
      reviewedAt: reviewTimestamp,
    },
    promotion: {
      memoryId: promotion.memoryId,
      contextEventId: candidate.contextEventId,
      candidateId: candidate.id,
      relatedFiles: promotion.relatedFiles,
    },
  };

  const updated = await updateCandidateAfterApproval({
    candidateId,
    applied: { ...applied, provenance: promotionProvenance, metadata: promotionMetadata },
    reviewer,
    promotedMemoryId: promotion.memoryId,
    promotionMetadata,
  });
  await emitCandidateAudit(requireEdits ? 'edit_approved' : 'approved', updated, {
    reviewer,
    promotedMemoryId: promotion.memoryId,
    relatedFiles: promotion.relatedFiles,
  });

  res.json({ candidate: updated, memory: { id: promotion.memoryId, entry: promotion.entry, relatedFiles: promotion.relatedFiles }, approved: true, alreadyApproved: false });
}

async function findCandidateByIdempotencyKey(idempotencyKey: string, workspaceId: string): Promise<MemoryCandidateResponse | undefined> {
  const candidate = await queryOne<MemoryCandidateResponse>(
    `${CANDIDATE_SELECT}
      WHERE idempotency_key = $1
        AND workspace_id = $2`,
    [idempotencyKey, workspaceId],
  );
  return candidate ? normalizeCandidateRow(candidate) : undefined;
}

function buildSafetyMetadata(
  safety: ContextSafetyDiagnostics,
  overrides: { securitySensitive: boolean; regulatedDomain: boolean; requiresReview: boolean },
): JsonObject {
  return {
    contractVersion: CONTEXT_SAFETY_CONTRACT_VERSION,
    redactionApplied: true,
    pathFiltering: 'context-safety',
    securitySensitive: overrides.securitySensitive,
    regulatedDomain: overrides.regulatedDomain,
    requiresReview: overrides.requiresReview,
    findings: safety.findings,
  };
}

function parseStatusFilter(value: unknown): MemoryCandidateStatus[] | 'all' {
  if (value == null || value === '') return ['pending'];
  const rawValues = Array.isArray(value) ? value.flatMap((item) => String(item).split(',')) : String(value).split(',');
  const statuses = rawValues.map((item) => item.trim()).filter(Boolean);
  if (statuses.includes('all')) return 'all';
  if (statuses.length === 0) return ['pending'];
  for (const status of statuses) {
    if (!MEMORY_CANDIDATE_STATUSES.includes(status as MemoryCandidateStatus)) {
      throw new ValidationError(`status must be one of: ${MEMORY_CANDIDATE_STATUSES.join(', ')}, all`);
    }
  }
  return statuses as MemoryCandidateStatus[];
}

function parseBooleanQuery(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(parseBooleanQuery);
  if (typeof value !== 'string') return value === true;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseConfidenceThreshold(value: unknown): MemoryCandidateConfidence {
  const threshold = typeof value === 'string' && value.trim() ? value.trim() : 'medium';
  if (!MEMORY_CANDIDATE_CONFIDENCES.includes(threshold as MemoryCandidateConfidence)) {
    throw new ValidationError(`minConfidence must be one of: ${MEMORY_CANDIDATE_CONFIDENCES.join(', ')}`);
  }
  return threshold as MemoryCandidateConfidence;
}

function confidenceRank(value: MemoryCandidateConfidence): number {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  return 1;
}

/**
 * @swagger
 * /api/context-candidates:
 *   post:
 *     tags: [Context Capture]
 *     summary: Create a memory candidate from a context event or sidecar observation
 *     operationId: createContextCandidate
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Candidate creation stores unapproved review items only; it does not affect default memory retrieval until a user approves the candidate."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, suggestedCategory, title, rule]
 *             properties:
 *               workspaceId: { type: string }
 *               contextEventId: { type: integer }
 *               suggestedCategory: { type: string, enum: [Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha] }
 *               title: { type: string }
 *               rule: { type: string }
 *               context: { type: string }
 *               relatedFiles: { type: array, items: { type: string } }
 *               confidence: { type: string, enum: [high, medium, low] }
 *               trustTier: { type: string, enum: [agent_observation, working_note, engineering_decision, approved_policy, verified_fact] }
 *               idempotencyKey: { type: string }
 *     responses:
 *       201: { description: Created memory candidate }
 *       200: { description: Existing memory candidate returned for an idempotent duplicate submission }
 *       400: { description: Invalid payload }
 *       404: { description: Workspace or context event not found }
 */
router.post('/', createCandidateFromRequest);

export async function createCandidateFromRequest(req: Request, res: Response): Promise<void> {
  const body = parseWithSchema(CandidateCreateSchema, req.body, 'Invalid memory candidate payload') as CandidateCreateInput;
  const workspace = await assertWorkspace(body.workspaceId);

  const contextEventId = body.contextEventId == null ? null : parsePositiveId(body.contextEventId, 'contextEventId');
  const event = contextEventId ? await loadContextEvent(body.workspaceId, contextEventId) : null;
  const eventRelatedFiles = event ? normalizeCaptureRelatedFiles(event.relatedFiles, workspace.path) : [];
  const relatedFiles = body.relatedFiles === undefined
    ? eventRelatedFiles
    : normalizeCaptureRelatedFiles(body.relatedFiles, workspace.path);
  const eventProvenance = event ? redactJsonObject(event.provenance, 'event.provenance', workspace.path) : {};
  const provenance = {
    ...eventProvenance,
    ...redactJsonObject(body.provenance, 'provenance', workspace.path),
    ...(event ? { sourceEventId: event.id } : {}),
  };
  const metadata = redactJsonObject(body.metadata, 'metadata', workspace.path);
  const occurredAt = parseOptionalDate(body.occurredAt, 'occurredAt') ?? event?.occurredAt ?? null;
  const sourceSystem = body.sourceSystem ?? event?.sourceSystem ?? null;
  const redactedSourceSystem = sourceSystem ? redactContextText(sourceSystem, {}) : null;
  const sourceRef = body.sourceRef ?? event?.sourceRef ?? null;
  const redactedSourceRef = sourceRef ? redactContextText(sourceRef, {}) : null;
  const actor = body.actor ?? event?.actor ?? null;
  const redactedActor = actor ? redactContextText(actor, {}) : null;
  const title = redactContextText(body.title, {}).trim();
  const rule = redactContextText(body.rule, {}).trim();
  const context = redactContextText(body.context, {});
  const claim = body.claim == null ? null : redactContextText(body.claim, {});
  const policy = body.policy == null ? null : redactContextText(body.policy, {});
  const incidentLearning = body.incidentLearning == null ? null : redactContextText(body.incidentLearning, {});
  const safety = analyzeContextSafety({
    title: body.title,
    rule: body.rule,
    context: body.context,
    claim: body.claim,
    policy: body.policy,
    incidentLearning: body.incidentLearning,
    provenance: body.provenance,
    metadata: body.metadata,
    sourceRef,
    relatedFiles,
  }, {});
  const securitySensitive = body.securitySensitive === true || safety.securitySensitive;
  const regulatedDomain = body.regulatedDomain === true || safety.regulatedDomain;
  const requiresReview = regulatedDomain ? true : body.requiresReview ?? true;
  const derived = buildMemoryCandidateIdempotencyKey({
    workspaceId: body.workspaceId,
    contextEventId,
    sourceSystem: redactedSourceSystem,
    sourceRef: redactedSourceRef,
    title,
    rule,
    context,
    suggestedCategory: body.suggestedCategory,
    relatedFiles,
  });
  const idempotencyKey = body.idempotencyKey ? redactContextText(body.idempotencyKey, {}) : derived.idempotencyKey;

  const existing = await findCandidateByIdempotencyKey(idempotencyKey, body.workspaceId);
  if (existing) {
    await emitCandidateAudit('created', existing, { reviewer: redactedActor ?? 'context-capture', duplicate: true });
    res.status(200).json({ candidate: existing, created: false, idempotent: true });
    return;
  }

  const candidate = await queryOne<MemoryCandidateResponse>(
    `WITH inserted AS (
       INSERT INTO memory_candidates (
         workspace_id,
         context_event_id,
         event_type,
         source_system,
         source_ref,
         actor,
         occurred_at,
         suggested_category,
         title,
         rule,
         context,
         related_files,
         confidence,
         trust_tier,
         review_status,
         idempotency_key,
         provenance,
         metadata,
         claim,
         policy,
         incident_learning,
         security_sensitive,
         regulated_domain,
         requires_review
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, $11, $12::jsonb,
         $13, $14, 'pending', $15, $16::jsonb, $17::jsonb, $18, $19, $20, $21, $22, $23
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id
     )
     ${CANDIDATE_SELECT}
     WHERE id = (SELECT id FROM inserted)`,
    [
      body.workspaceId,
      contextEventId,
      body.eventType ?? event?.eventType ?? null,
      redactedSourceSystem,
      redactedSourceRef,
      redactedActor,
      occurredAt,
      body.suggestedCategory,
      title,
      rule,
      context,
      JSON.stringify(relatedFiles),
      body.confidence,
      body.trustTier ?? event?.trustTier ?? 'agent_observation',
      idempotencyKey,
      JSON.stringify(provenance),
      JSON.stringify({
        ...metadata,
        contentHash: derived.contentHash,
        safety: buildSafetyMetadata(safety, { securitySensitive, regulatedDomain, requiresReview }),
      }),
      claim,
      policy,
      incidentLearning,
      securitySensitive,
      regulatedDomain,
      requiresReview,
    ],
  );

  if (!candidate) {
    const concurrentExisting = await findCandidateByIdempotencyKey(idempotencyKey, body.workspaceId);
    if (concurrentExisting) {
      await emitCandidateAudit('created', concurrentExisting, { reviewer: redactedActor ?? 'context-capture', duplicate: true });
      res.status(200).json({ candidate: concurrentExisting, created: false, idempotent: true });
      return;
    }
    throw new ConflictError(`Memory candidate with idempotency key '${idempotencyKey}' already exists`);
  }

  const normalized = normalizeCandidateRow(candidate);
  await emitCandidateAudit('created', normalized, { reviewer: redactedActor ?? 'context-capture' });
  res.status(201).json({ candidate: normalized, created: true, idempotent: false });
}

/**
 * @swagger
 * /api/context-candidates:
 *   get:
 *     tags: [Context Capture]
 *     summary: List and filter memory candidates for review
 *     operationId: listContextCandidates
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only candidate review queue listing is safe for local automation and excludes durable memory promotion side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, description: "pending by default; use all or a comma-separated status list to include reviewed candidates" }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *       - in: query
 *         name: confidence
 *         schema: { type: string, enum: [high, medium, low] }
 *       - in: query
 *         name: trustTier
 *         schema: { type: string, enum: [agent_observation, working_note, engineering_decision, approved_policy, verified_fact] }
 *       - in: query
 *         name: eventType
 *         schema: { type: string }
 *       - in: query
 *         name: sourceSystem
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200: { description: Paginated candidate list }
 *       400: { description: Invalid filter }
 *       404: { description: Workspace not found }
 */
router.get('/', async (req: Request, res: Response) => {
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  if (!workspaceId) throw new ValidationError('workspaceId is required');
  await assertWorkspace(workspaceId);

  const conditions = ['workspace_id = $1'];
  const params: unknown[] = [workspaceId];
  let paramIndex = 2;

  const statuses = parseStatusFilter(req.query.status ?? req.query.reviewStatus);
  if (statuses !== 'all') {
    params.push(statuses);
    conditions.push(`review_status = ANY($${paramIndex}::text[])`);
    paramIndex++;
  }

  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  if (category) {
    if (!MEMORY_CANDIDATE_CATEGORIES.includes(category as MemoryCandidateCategory)) {
      throw new ValidationError(`category must be one of: ${MEMORY_CANDIDATE_CATEGORIES.join(', ')}`);
    }
    params.push(category);
    conditions.push(`suggested_category = $${paramIndex}`);
    paramIndex++;
  }

  const confidence = typeof req.query.confidence === 'string' ? req.query.confidence.trim() : '';
  if (confidence) {
    if (!MEMORY_CANDIDATE_CONFIDENCES.includes(confidence as MemoryCandidateConfidence)) {
      throw new ValidationError(`confidence must be one of: ${MEMORY_CANDIDATE_CONFIDENCES.join(', ')}`);
    }
    params.push(confidence);
    conditions.push(`confidence = $${paramIndex}`);
    paramIndex++;
  }

  const eventType = typeof req.query.eventType === 'string' ? req.query.eventType.trim() : '';
  if (eventType) {
    if (!CONTEXT_EVENT_TYPES.includes(eventType as ContextEventType)) {
      throw new ValidationError(`eventType must be one of: ${CONTEXT_EVENT_TYPES.join(', ')}`);
    }
    params.push(eventType);
    conditions.push(`event_type = $${paramIndex}`);
    paramIndex++;
  }

  const sourceSystem = typeof req.query.sourceSystem === 'string' ? req.query.sourceSystem.trim() : '';
  if (sourceSystem) {
    params.push(sourceSystem);
    conditions.push(`source_system = $${paramIndex}`);
    paramIndex++;
  }

  const trustTier = typeof req.query.trustTier === 'string' ? req.query.trustTier.trim() : '';
  if (trustTier) {
    if (!CONTEXT_TRUST_TIERS.includes(trustTier as ContextTrustTier)) {
      throw new ValidationError(`trustTier must be one of: ${CONTEXT_TRUST_TIERS.join(', ')}`);
    }
    params.push(trustTier);
    conditions.push(`trust_tier = $${paramIndex}`);
    paramIndex++;
  }

  const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(title ILIKE $${paramIndex} OR rule ILIKE $${paramIndex} OR context ILIKE $${paramIndex})`);
  }

  const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 250 });
  const page = await paginateQuery<MemoryCandidateResponse>({
    query: `${CANDIDATE_SELECT} WHERE ${conditions.join(' AND ')}`,
    countQuery: `SELECT COUNT(*)::int AS total FROM memory_candidates WHERE ${conditions.join(' AND ')}`,
    params,
    pagination,
    orderBy: 'id DESC',
    cursorColumn: 'id',
    cursorDirection: 'desc',
  });

  res.json({
    ...page,
    items: page.items.map(normalizeCandidateRow),
  });
});

/**
 * @swagger
 * /api/context-candidates/retrieval:
 *   get:
 *     tags: [Context Capture]
 *     summary: Retrieve memory candidates with conservative safety gates by default
 *     operationId: retrieveSafeContextCandidates
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only candidate retrieval defaults to approved/non-sensitive query-level gates; broader review access requires an explicit query flag."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: includeUnsafe
 *         schema: { type: boolean, description: "Opt in to include pending, rejected, low-confidence, or regulated-unapproved candidates." }
 *       - in: query
 *         name: minConfidence
 *         schema: { type: string, enum: [high, medium, low], default: medium }
 *     responses:
 *       200: { description: Paginated retrieval-safe candidates }
 *       400: { description: Invalid filter }
 *       404: { description: Workspace not found }
 */
router.get('/retrieval', async (req: Request, res: Response) => {
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  if (!workspaceId) throw new ValidationError('workspaceId is required');
  await assertWorkspace(workspaceId);

  const conditions = ['workspace_id = $1'];
  const params: unknown[] = [workspaceId];
  let paramIndex = 2;

  if (!parseBooleanQuery(req.query.includeUnsafe)) {
    const minConfidence = parseConfidenceThreshold(req.query.minConfidence);
    params.push(confidenceRank(minConfidence));
    conditions.push("review_status NOT IN ('pending', 'rejected')");
    conditions.push(`(CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) >= $${paramIndex}`);
    conditions.push("(regulated_domain = false OR review_status = 'approved')");
    paramIndex++;
  }

  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  if (category) {
    if (!MEMORY_CANDIDATE_CATEGORIES.includes(category as MemoryCandidateCategory)) {
      throw new ValidationError(`category must be one of: ${MEMORY_CANDIDATE_CATEGORIES.join(', ')}`);
    }
    params.push(category);
    conditions.push(`suggested_category = $${paramIndex}`);
    paramIndex++;
  }

  const pagination = parsePaginationParams(req, { limit: 25, maxLimit: 100 });
  const page = await paginateQuery<MemoryCandidateResponse>({
    query: `${CANDIDATE_SELECT} WHERE ${conditions.join(' AND ')}`,
    countQuery: `SELECT COUNT(*)::int AS total FROM memory_candidates WHERE ${conditions.join(' AND ')}`,
    params,
    pagination,
    orderBy: 'id DESC',
    cursorColumn: 'id',
    cursorDirection: 'desc',
  });

  res.json({
    ...page,
    items: page.items.map(normalizeCandidateRow),
    safety: {
      includeUnsafe: parseBooleanQuery(req.query.includeUnsafe),
      defaultPredicate: "review_status NOT IN ('pending', 'rejected') AND confidence >= minConfidence AND (regulated_domain = false OR review_status = 'approved')",
    },
  });
});

/**
 * @swagger
 * /api/context-candidates/{id}/file-preview:
 *   get:
 *     tags: [Context Capture]
 *     summary: Preview a candidate related file through context-safety redaction
 *     operationId: previewContextCandidateRelatedFile
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only bounded related-file previews are restricted to candidate provenance files and redacted server-side before returning."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *       - in: query
 *         name: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Redacted bounded file preview }
 *       400: { description: Invalid path }
 *       404: { description: Candidate or workspace not found }
 */
router.get('/:id/file-preview', async (req: Request, res: Response) => {
  const candidateId = parsePositiveId(req.params.id, 'candidateId');
  const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
    ? req.query.workspaceId.trim()
    : undefined;
  const requestedPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  if (!requestedPath) throw new ValidationError('path is required');

  const candidate = await loadCandidate(candidateId, workspaceId);
  const workspace = await assertWorkspace(candidate.workspaceId);
  const preview = await buildRelatedFilePreview(candidate, workspace, requestedPath);
  res.json({ candidateId: candidate.id, workspaceId: candidate.workspaceId, preview });
});

/**
 * @swagger
 * /api/context-candidates/{id}:
 *   get:
 *     tags: [Context Capture]
 *     summary: Get one memory candidate for review
 *     operationId: getContextCandidate
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only candidate detail lookup is safe for local review automation and has no memory promotion side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Candidate detail }
 *       400: { description: Invalid id }
 *       404: { description: Candidate not found }
 */
router.get('/:id', async (req: Request, res: Response) => {
  const candidateId = parsePositiveId(req.params.id, 'candidateId');
  const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
    ? req.query.workspaceId.trim()
    : undefined;
  const candidate = await loadCandidate(candidateId, workspaceId);
  res.json({ candidate });
});

/**
 * @swagger
 * /api/context-candidates/{id}/approve:
 *   post:
 *     tags: [Context Capture]
 *     summary: Approve a memory candidate and promote it to durable Rorca memory
 *     operationId: approveContextCandidate
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Approval mutates user-owned durable memory, so it requires authenticated/local-owner intent while remaining MCP-callable."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate approved and memory promoted }
 *       400: { description: Invalid payload }
 *       404: { description: Candidate not found }
 *       409: { description: Candidate cannot be approved }
 */
export async function approveCandidateFromRequest(req: Request, res: Response): Promise<void> {
  await approveFromRequest(req, res, false);
}

router.post('/:id/approve', approveCandidateFromRequest);

/**
 * @swagger
 * /api/context-candidates/{id}/edit-and-approve:
 *   post:
 *     tags: [Context Capture]
 *     summary: Edit a candidate and approve the edited memory in one step
 *     operationId: editAndApproveContextCandidate
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Edit-and-approve mutates user-owned durable memory and records the reviewed edit provenance."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate edited, approved, and promoted }
 *       400: { description: Invalid payload }
 *       404: { description: Candidate not found }
 *       409: { description: Candidate cannot be approved }
 */
router.post('/:id/edit-and-approve', async (req: Request, res: Response) => {
  await approveFromRequest(req, res, true);
});

/**
 * @swagger
 * /api/context-candidates/{id}/reject:
 *   post:
 *     tags: [Context Capture]
 *     summary: Reject a memory candidate without promoting it
 *     operationId: rejectContextCandidate
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Rejection mutates a user-owned review decision while preserving audit metadata for why the candidate was not promoted."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate rejected }
 *       400: { description: Invalid payload }
 *       404: { description: Candidate not found }
 *       409: { description: Approved candidates cannot be rejected }
 */
router.post('/:id/reject', async (req: Request, res: Response) => {
  const candidateId = parsePositiveId(req.params.id, 'candidateId');
  const body = parseWithSchema(RejectBodySchema, req.body, 'Invalid reject payload') as RejectBody;
  const candidate = await loadCandidate(candidateId, body.workspaceId);
  ensureCandidateCanTransition(candidate, 'rejected');

  const reviewer = body.reviewer ?? 'local-user';
  const patchMetadata = normalizeJsonObject(body.metadata, 'metadata');
  const updated = await markCandidateStatus({
    candidate,
    status: 'rejected',
    reviewer,
    metadataPatch: {
      ...patchMetadata,
      review: {
        action: 'reject',
        reason: body.reason,
        reviewer,
        reviewedAt: new Date().toISOString(),
      },
    },
  });
  await emitCandidateAudit('rejected', updated, { reviewer, reason: body.reason });
  res.json({ candidate: updated, rejected: true });
});

/**
 * @swagger
 * /api/context-candidates/{id}/duplicate:
 *   post:
 *     tags: [Context Capture]
 *     summary: Mark a memory candidate as a duplicate
 *     operationId: duplicateContextCandidate
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Duplicate marking changes a user-owned review decision and records the candidate or memory it duplicates."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate marked duplicate }
 *       400: { description: Invalid payload }
 *       404: { description: Candidate or duplicate target not found }
 *       409: { description: Approved candidates cannot be marked duplicate }
 */
router.post('/:id/duplicate', async (req: Request, res: Response) => {
  const candidateId = parsePositiveId(req.params.id, 'candidateId');
  const body = parseWithSchema(LifecycleBodySchema, req.body, 'Invalid duplicate payload') as LifecycleBody;
  const candidate = await loadCandidate(candidateId, body.workspaceId);
  ensureCandidateCanTransition(candidate, 'marked duplicate');

  if (!body.duplicateOfCandidateId && !body.duplicateOfMemoryId) {
    throw new ValidationError('duplicateOfCandidateId or duplicateOfMemoryId is required');
  }
  if (body.duplicateOfCandidateId) {
    await loadCandidate(parsePositiveId(body.duplicateOfCandidateId, 'duplicateOfCandidateId'), candidate.workspaceId);
  }
  if (body.duplicateOfMemoryId) {
    await assertMemory(candidate.workspaceId, parsePositiveId(body.duplicateOfMemoryId, 'duplicateOfMemoryId'));
  }

  const reviewer = body.reviewer ?? 'local-user';
  const updated = await markCandidateStatus({
    candidate,
    status: 'duplicate',
    reviewer,
    metadataPatch: {
      ...normalizeJsonObject(body.metadata, 'metadata'),
      review: {
        action: 'duplicate',
        reason: body.reason ?? null,
        reviewer,
        reviewedAt: new Date().toISOString(),
        duplicateOfCandidateId: body.duplicateOfCandidateId ? String(body.duplicateOfCandidateId) : null,
        duplicateOfMemoryId: body.duplicateOfMemoryId ? String(body.duplicateOfMemoryId) : null,
      },
    },
  });
  await emitCandidateAudit('duplicate', updated, { reviewer, reason: body.reason ?? null });
  res.json({ candidate: updated, status: 'duplicate' });
});

/**
 * @swagger
 * /api/context-candidates/{id}/supersede:
 *   post:
 *     tags: [Context Capture]
 *     summary: Mark a memory candidate as superseded by a newer candidate or memory
 *     operationId: supersedeContextCandidate
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Supersede changes the review lifecycle and preserves the replacement link for auditability."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate marked superseded }
 *       400: { description: Invalid payload }
 *       404: { description: Candidate or superseding target not found }
 *       409: { description: Approved candidates cannot be superseded }
 */
router.post('/:id/supersede', async (req: Request, res: Response) => {
  const candidateId = parsePositiveId(req.params.id, 'candidateId');
  const body = parseWithSchema(LifecycleBodySchema, req.body, 'Invalid supersede payload') as LifecycleBody;
  const candidate = await loadCandidate(candidateId, body.workspaceId);
  ensureCandidateCanTransition(candidate, 'superseded');

  if (!body.supersededByCandidateId && !body.supersededByMemoryId) {
    throw new ValidationError('supersededByCandidateId or supersededByMemoryId is required');
  }
  if (body.supersededByCandidateId) {
    await loadCandidate(parsePositiveId(body.supersededByCandidateId, 'supersededByCandidateId'), candidate.workspaceId);
  }
  if (body.supersededByMemoryId) {
    await assertMemory(candidate.workspaceId, parsePositiveId(body.supersededByMemoryId, 'supersededByMemoryId'));
  }

  const reviewer = body.reviewer ?? 'local-user';
  const updated = await markCandidateStatus({
    candidate,
    status: 'superseded',
    reviewer,
    metadataPatch: {
      ...normalizeJsonObject(body.metadata, 'metadata'),
      review: {
        action: 'supersede',
        reason: body.reason ?? null,
        reviewer,
        reviewedAt: new Date().toISOString(),
        supersededByCandidateId: body.supersededByCandidateId ? String(body.supersededByCandidateId) : null,
        supersededByMemoryId: body.supersededByMemoryId ? String(body.supersededByMemoryId) : null,
      },
    },
  });
  await emitCandidateAudit('superseded', updated, { reviewer, reason: body.reason ?? null });
  res.json({ candidate: updated, status: 'superseded' });
});

/**
 * @swagger
 * /api/context-candidates/{id}/conflict:
 *   post:
 *     tags: [Context Capture]
 *     summary: Mark a memory candidate as conflicting with another candidate or memory
 *     operationId: conflictContextCandidate
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Conflict marking changes a user-owned review lifecycle decision and preserves the conflicting target for auditability."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate marked conflicting }
 *       400: { description: Invalid payload }
 *       404: { description: Candidate or conflicting target not found }
 *       409: { description: Approved candidates cannot be marked conflicting }
 */
router.post('/:id/conflict', async (req: Request, res: Response) => {
  const candidateId = parsePositiveId(req.params.id, 'candidateId');
  const body = parseWithSchema(LifecycleBodySchema, req.body, 'Invalid conflict payload') as LifecycleBody;
  const candidate = await loadCandidate(candidateId, body.workspaceId);
  ensureCandidateCanTransition(candidate, 'marked conflicting');

  if (!body.conflictingCandidateId && !body.conflictingMemoryId) {
    throw new ValidationError('conflictingCandidateId or conflictingMemoryId is required');
  }
  if (body.conflictingCandidateId) {
    await loadCandidate(parsePositiveId(body.conflictingCandidateId, 'conflictingCandidateId'), candidate.workspaceId);
  }
  if (body.conflictingMemoryId) {
    await assertMemory(candidate.workspaceId, parsePositiveId(body.conflictingMemoryId, 'conflictingMemoryId'));
  }

  const reviewer = body.reviewer ?? 'local-user';
  const updated = await markCandidateStatus({
    candidate,
    status: 'conflict',
    reviewer,
    metadataPatch: {
      ...normalizeJsonObject(body.metadata, 'metadata'),
      review: {
        action: 'conflict',
        reason: body.reason ?? null,
        reviewer,
        reviewedAt: new Date().toISOString(),
        conflictingCandidateId: body.conflictingCandidateId ? String(body.conflictingCandidateId) : null,
        conflictingMemoryId: body.conflictingMemoryId ? String(body.conflictingMemoryId) : null,
      },
    },
  });
  await emitCandidateAudit('conflict', updated, { reviewer, reason: body.reason ?? null });
  res.json({ candidate: updated, status: 'conflict' });
});

/**
 * @swagger
 * /api/context-candidates/{id}/defer:
 *   post:
 *     tags: [Context Capture]
 *     summary: Defer a memory candidate for later review
 *     operationId: deferContextCandidate
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Deferral changes a user-owned review decision but does not promote memory or expose pending candidates through retrieval."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Candidate deferred }
 *       400: { description: Invalid payload }
 *       404: { description: Candidate not found }
 *       409: { description: Approved candidates cannot be deferred }
 */
router.post('/:id/defer', async (req: Request, res: Response) => {
  const candidateId = parsePositiveId(req.params.id, 'candidateId');
  const body = parseWithSchema(LifecycleBodySchema, req.body, 'Invalid defer payload') as LifecycleBody;
  const candidate = await loadCandidate(candidateId, body.workspaceId);
  ensureCandidateCanTransition(candidate, 'deferred');
  const deferUntil = parseOptionalDate(body.deferUntil, 'deferUntil');

  const reviewer = body.reviewer ?? 'local-user';
  const updated = await markCandidateStatus({
    candidate,
    status: 'deferred',
    reviewer,
    metadataPatch: {
      ...normalizeJsonObject(body.metadata, 'metadata'),
      review: {
        action: 'defer',
        reason: body.reason ?? null,
        reviewer,
        reviewedAt: new Date().toISOString(),
        deferUntil,
      },
    },
  });
  await emitCandidateAudit('deferred', updated, { reviewer, reason: body.reason ?? null, deferUntil });
  res.json({ candidate: updated, status: 'deferred' });
});

export default router;
