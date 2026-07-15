/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * UCC-008: Autonomous context-event to memory-candidate distillation.
 *
 * Captured events are durable raw context. This module conservatively extracts
 * reviewable memory candidates from those events while preserving provenance and
 * keeping unapproved candidates out of default retrieval (they live in
 * memory_candidates, not memories, unless explicitly approved/guarded auto-approved).
 */

import PgBoss from 'pg-boss';
import { execute, query, queryOne } from '../db/index';
import { hashCaptureContent, sanitizeCapturePayload } from './context-safety';
import { embedText, prepareText } from './embedding-pipeline';
import { logger } from './logger';
import { chatComplete, type ChatMessage } from './llm-client';
import { ContextCaptureEventJobPayload, type ContextCaptureEventJobPayloadType, type UnifiedContextEventPayloadType } from './pg-boss-schemas';
import { resolveWorkflowConfig } from './workflow-config-resolver';

export const CONTEXT_DISTILL_QUEUE = 'context:distill';

export type MemoryDistillationMode = 'off' | 'explicit-only' | 'conservative-auto-candidates' | 'trusted-auto-approve';
export type MemoryCandidateStatus = 'pending' | 'review_required' | 'approved' | 'rejected' | 'auto_approved';
export type MemoryCandidateCategory = 'Architecture' | 'Convention' | 'Bug Fix' | 'Decision' | 'Pattern' | 'Gotcha';

export interface MemoryDistillationSettings {
  mode: MemoryDistillationMode;
  operatorAutoApprove: boolean;
  llmSummarization: boolean;
  maxEventsPerJob: number;
}

export interface DistillationEvidenceSnippet {
  text: string;
  sourceField: string;
  redacted: boolean;
}

export interface MemoryCandidateDraft {
  workspaceId: string;
  category: MemoryCandidateCategory;
  content: string;
  confidence: 'high' | 'medium' | 'low';
  status: Extract<MemoryCandidateStatus, 'pending' | 'review_required'>;
  reviewReason: string | null;
  securitySensitive: boolean;
  defaultRetrievalEligible: false;
  relatedFiles: string[];
  evidenceSnippets: DistillationEvidenceSnippet[];
  provenance: {
    sourceContextEventId: number | null;
    sourceEventType: string;
    sourceEventId: string | null;
    sourceTool: string;
    sourceSystem: string;
    sourceSessionId: string | null;
    sourceContentHash: string;
    sourceIdempotencyKey: string;
    occurredAt: string | null;
    gitBranch: string | null;
    gitSha: string | null;
  };
  candidateHash: string;
  dedupeKey: string;
}

interface ContextEventRow {
  id: number;
  occurred_at: Date | string | null;
  workspace_id: string;
  event_type: string;
  payload_schema_version: string | null;
  source_system: string | null;
  tool_name: string | null;
  host_application: string | null;
  session_id: string | null;
  repo_path_hash: string | null;
  git_branch: string | null;
  git_sha: string | null;
  related_files: unknown;
  capture_policy: unknown;
  trust_tier: string | null;
  idempotency_key: string | null;
  provenance: unknown;
  payload: unknown;
}

interface PersistedContextEvent {
  id: number;
  workspaceId: string;
  idempotencyKey: string;
  contentHash: string;
  sessionId: string | null;
}

const DEFAULT_SETTINGS: MemoryDistillationSettings = {
  mode: 'conservative-auto-candidates',
  operatorAutoApprove: false,
  llmSummarization: false,
  maxEventsPerJob: 25,
};

const MAX_EVENTS_PER_JOB = 100;
const MAX_CANDIDATE_CHARS = 700;
const MAX_EVIDENCE_CHARS = 360;

const DURABLE_SIGNAL_RE = /\b(must|never|always|prefer|use\s+[^.]{1,80}\s+instead|requires?|required|gotcha|decision|decided|convention|architecture|architectural|root cause|fix(?:ed|es)?|bug|workaround|regression|security|secret|token|password|redact|pg-boss|queue|migration|schema|foreign key|idempotent|idempotency|dedup(?:e|lication)?)\b/i;
const NOISE_COMMAND_RE = /^\s*(pwd|ls(?:\s|$)|clear|git\s+status\b|git\s+diff\b|git\s+log\b|npm\s+run\s+lint\b|npm\s+test\b|npx\s+tsc\s+--noEmit\b)\s*$/i;
const SECURITY_RE = /\b(secret|token|password|api[_-]?key|credential|bearer|private key|ssn|credit card|hipaa|phi|pci|patient|medical record)\b/i;
const REGULATED_SIGNAL_RE = /\b(hipaa|phi|pci|cardholder|ssn|patient|medical record|credit card)\b/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function normalizeSettings(row?: { mode: string; operator_auto_approve: boolean; llm_summarization: boolean; max_events_per_job: number } | null): MemoryDistillationSettings {
  const mode = row?.mode === 'off' || row?.mode === 'explicit-only' || row?.mode === 'trusted-auto-approve' || row?.mode === 'conservative-auto-candidates'
    ? row.mode
    : DEFAULT_SETTINGS.mode;
  const maxEventsPerJob = Math.min(Math.max(Number(row?.max_events_per_job ?? DEFAULT_SETTINGS.maxEventsPerJob), 1), MAX_EVENTS_PER_JOB);
  return {
    mode,
    operatorAutoApprove: Boolean(row?.operator_auto_approve),
    llmSummarization: Boolean(row?.llm_summarization),
    maxEventsPerJob,
  };
}

export async function getMemoryDistillationSettings(workspaceId: string): Promise<MemoryDistillationSettings> {
  const row = await queryOne<{ mode: string; operator_auto_approve: boolean; llm_summarization: boolean; max_events_per_job: number }>(
    `SELECT mode, operator_auto_approve, llm_summarization, max_events_per_job
       FROM memory_distillation_settings
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  return normalizeSettings(row);
}

export async function upsertMemoryDistillationSettings(workspaceId: string, patch: Partial<MemoryDistillationSettings>): Promise<MemoryDistillationSettings> {
  const current = await getMemoryDistillationSettings(workspaceId);
  const next: MemoryDistillationSettings = {
    ...current,
    ...patch,
    maxEventsPerJob: Math.min(Math.max(Number(patch.maxEventsPerJob ?? current.maxEventsPerJob), 1), MAX_EVENTS_PER_JOB),
  };
  await execute(
    `INSERT INTO memory_distillation_settings (workspace_id, mode, operator_auto_approve, llm_summarization, max_events_per_job, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (workspace_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       operator_auto_approve = EXCLUDED.operator_auto_approve,
       llm_summarization = EXCLUDED.llm_summarization,
       max_events_per_job = EXCLUDED.max_events_per_job,
       updated_at = NOW()`,
    [workspaceId, next.mode, next.operatorAutoApprove, next.llmSummarization, next.maxEventsPerJob],
  );
  return next;
}

export function isCandidateVisibleInDefaultRetrieval(status: MemoryCandidateStatus): boolean {
  return status === 'approved' || status === 'auto_approved';
}

function sanitizeText(input: string): { text: string; redacted: boolean } {
  const sanitized = sanitizeCapturePayload({ value: input });
  const text = stringValue((sanitized.payload as Record<string, unknown>).value) ?? '';
  return { text, redacted: sanitized.safety.redactionCount > 0 };
}

function boundedText(input: string, max = MAX_CANDIDATE_CHARS): string {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function extractRelatedFiles(payload: UnifiedContextEventPayloadType): string[] {
  const direct = Array.isArray(payload.related_files) ? payload.related_files.map((f) => f.path) : [];
  const changed = payload.eventType === 'git_commit' && Array.isArray(payload.changed_files) ? payload.changed_files.map((f) => f.path) : [];
  return [...new Set([...direct, ...changed].filter((file): file is string => typeof file === 'string' && file.trim().length > 0))];
}

function selectCategory(text: string, eventType: string): MemoryCandidateCategory {
  const lower = text.toLowerCase();
  if (/(architecture|architectural|schema|foreign key|provider broker|queue|pg-boss)/i.test(text)) return 'Architecture';
  if (/(convention|always|never|must|prefer|required|requires)/i.test(text)) return 'Convention';
  if (/(fix|bug|regression|root cause|failed|error)/i.test(text)) return 'Bug Fix';
  if (/(decision|decided|choose|chosen)/i.test(text)) return 'Decision';
  if (/(gotcha|workaround|careful|avoid)/i.test(text)) return 'Gotcha';
  if (eventType === 'explicit_memory' && lower.includes('decision')) return 'Decision';
  return 'Pattern';
}

function sourceTextForEvent(payload: UnifiedContextEventPayloadType): { text: string | null; sourceField: string } {
  if (payload.eventType === 'explicit_memory') return { text: payload.memory_summary, sourceField: 'memory_summary' };
  if (payload.eventType === 'agent_cli_session' || payload.eventType === 'shell_command') return { text: payload.command_summary, sourceField: 'command_summary' };
  if (payload.eventType === 'editor_activity') return { text: payload.summary, sourceField: 'summary' };
  if (payload.eventType === 'git_commit') return { text: payload.commit_subject, sourceField: 'commit_subject' };
  if (payload.eventType === 'ci_pr') return { text: `${payload.provider} PR ${payload.pr_number} ${payload.status} ${payload.head_sha}`, sourceField: 'status' };
  return { text: null, sourceField: 'payload' };
}

function hasRegulatedSignals(payload: UnifiedContextEventPayloadType, text: string): boolean {
  const signals = (payload.eventType === 'agent_cli_session' || payload.eventType === 'shell_command') ? payload.regulated_signals : [];
  return signals.length > 0 || REGULATED_SIGNAL_RE.test(text);
}

function shouldSkipAsNoise(payload: UnifiedContextEventPayloadType, text: string | null, mode: MemoryDistillationMode): string | null {
  if (mode === 'off') return 'distillation_off';
  if (payload.eventType !== 'explicit_memory' && mode === 'explicit-only') return 'explicit_only_mode';
  if (payload.eventType === 'ide_session') return 'ide_session_lifecycle_noise';
  if (!text) return 'no_distillable_text';
  if ((payload.eventType === 'agent_cli_session' || payload.eventType === 'shell_command') && payload.phase === 'start') return 'command_start_noise';
  if ((payload.eventType === 'agent_cli_session' || payload.eventType === 'shell_command') && NOISE_COMMAND_RE.test(text)) return 'routine_command_noise';
  if (payload.eventType !== 'explicit_memory' && !DURABLE_SIGNAL_RE.test(text)) return 'no_durable_signal';
  return null;
}

export function distillContextEventToCandidate(input: {
  eventId?: number | null;
  occurredAt?: string | null;
  payload: UnifiedContextEventPayloadType;
  safetyContentHash: string;
  mode?: MemoryDistillationMode;
}): MemoryCandidateDraft | null {
  const mode = input.mode ?? DEFAULT_SETTINGS.mode;
  const { payload } = input;
  const { text: rawText, sourceField } = sourceTextForEvent(payload);
  const skipReason = shouldSkipAsNoise(payload, rawText, mode);
  if (skipReason) return null;

  const raw = rawText ?? '';
  const sanitized = sanitizeText(raw);
  const contentBase = boundedText(sanitized.text);
  if (!contentBase) return null;

  const securitySensitive = sanitized.redacted || SECURITY_RE.test(raw) || hasRegulatedSignals(payload, raw);
  const status: MemoryCandidateDraft['status'] = securitySensitive ? 'review_required' : 'pending';
  const reviewReason = securitySensitive ? 'security_or_regulated_signal_requires_explicit_review' : null;
  const category = payload.eventType === 'explicit_memory' && payload.category
    ? selectCategory(payload.category, payload.eventType)
    : selectCategory(contentBase, payload.eventType);
  const sourceContentHash = input.safetyContentHash || hashCaptureContent(payload);
  const evidenceText = boundedText(sanitized.text, MAX_EVIDENCE_CHARS);
  const relatedFiles = extractRelatedFiles(payload);
  const sourceEventId = payload.provenance.source_event_id ?? null;
  const sourceSessionId = payload.session_id ?? payload.source_identity.session_id ?? null;
  const candidateHash = `sha256:${hashCaptureContent({ category, content: contentBase, relatedFiles })}`;
  const dedupeKey = `sha256:${hashCaptureContent({
    workspaceId: payload.workspace_id,
    eventId: input.eventId ?? null,
    contentHash: sourceContentHash,
    sourceSessionId,
    candidateHash,
  })}`;

  return {
    workspaceId: payload.workspace_id,
    category,
    content: contentBase,
    confidence: payload.eventType === 'explicit_memory' ? 'high' : 'medium',
    status,
    reviewReason,
    securitySensitive,
    defaultRetrievalEligible: false,
    relatedFiles,
    evidenceSnippets: [{ text: evidenceText, sourceField, redacted: sanitized.redacted }],
    provenance: {
      sourceContextEventId: input.eventId ?? null,
      sourceEventType: payload.eventType,
      sourceEventId,
      sourceTool: payload.tool_name,
      sourceSystem: payload.source_system,
      sourceSessionId,
      sourceContentHash,
      sourceIdempotencyKey: payload.idempotency_key,
      occurredAt: input.occurredAt ?? null,
      gitBranch: payload.git_branch,
      gitSha: payload.git_sha,
    },
    candidateHash,
    dedupeKey,
  };
}

async function maybeSummarizeCandidateWithLlm(candidate: MemoryCandidateDraft, settings: MemoryDistillationSettings): Promise<MemoryCandidateDraft> {
  if (!settings.llmSummarization) return candidate;
  try {
    const wfConfig = await resolveWorkflowConfig('memory_consolidation');
    const prompt = `Summarize this memory candidate as one durable, actionable rule. Preserve meaning. Return plain text only.\n\n${candidate.content}`;
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const result = await chatComplete(messages, {
      model: wfConfig.model ?? undefined,
      provider: wfConfig.provider,
      apiKey: wfConfig.apiKey ?? undefined,
      baseUrl: wfConfig.baseUrl ?? undefined,
      maxTokens: 512,
    });
    const summarized = boundedText(result.text.trim());
    if (!summarized) return candidate;
    return {
      ...candidate,
      content: summarized,
      candidateHash: `sha256:${hashCaptureContent({ category: candidate.category, content: summarized, relatedFiles: candidate.relatedFiles })}`,
    };
  } catch (err) {
    logger.warn({ err }, '[context-distillation] optional LLM summarization failed; using deterministic candidate');
    return candidate;
  }
}

async function autoApproveCandidateIfAllowed(candidate: MemoryCandidateDraft, settings: MemoryDistillationSettings): Promise<{ status: MemoryCandidateStatus; memoryId: number | null }> {
  if (settings.mode !== 'trusted-auto-approve' || !settings.operatorAutoApprove || candidate.securitySensitive) {
    return { status: candidate.status, memoryId: null };
  }

  let embedding: number[] | null = null;
  try {
    embedding = await embedText(prepareText('memory', candidate.content));
  } catch (err) {
    logger.warn({ err }, '[context-distillation] embedding failed for auto-approved candidate; saving memory without vector');
  }

  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO memories (workspace_id, category, content, confidence, related_files, embedding, source_type, source)
     VALUES ($1, $2, $3, $4, $5, $6::vector, 'auto-extracted', 'context-distillation')
     RETURNING id`,
    [
      candidate.workspaceId,
      candidate.category,
      candidate.content,
      candidate.confidence,
      JSON.stringify(candidate.relatedFiles),
      embedding ? `[${embedding.join(',')}]` : null,
    ],
  );
  return { status: 'auto_approved', memoryId: inserted?.id ?? null };
}

async function insertMemoryCandidate(candidate: MemoryCandidateDraft, settings: MemoryDistillationSettings): Promise<{ candidateId: number | null; status: MemoryCandidateStatus; memoryId: number | null; inserted: boolean }> {
  const initialStatus = candidate.status;
  const payload = {
    category: candidate.category,
    content: candidate.content,
    confidence: candidate.confidence,
    provenance: candidate.provenance,
    relatedFiles: candidate.relatedFiles,
    evidenceSnippets: candidate.evidenceSnippets,
    defaultRetrievalEligible: false,
  };
  const candidateTitle = `${candidate.category}: ${candidate.content}`.slice(0, 240).trim();
  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO memory_candidates (
       context_event_id, workspace_id, event_type, payload_schema_version, source_system, tool_name,
       host_application, session_id, repo_path_hash, git_branch, git_sha, related_files,
       capture_policy, trust_tier, idempotency_key, provenance, payload, title, rule, status, category,
       content, confidence, candidate_hash, source_content_hash, source_event_id, source_session_id,
       evidence_snippets, review_reason, security_sensitive, default_retrieval_eligible, dedupe_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12::jsonb,
       $13::jsonb, $14, $15, $16::jsonb, $17::jsonb, $18, $19, $20, $21,
       $22, $23, $24, $25, $26, $27,
       $28::jsonb, $29, $30, $31, $32
     )
     ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      candidate.provenance.sourceContextEventId,
      candidate.workspaceId,
      candidate.provenance.sourceEventType,
      '2026-07-ucc-007.v1',
      candidate.provenance.sourceSystem,
      candidate.provenance.sourceTool,
      null,
      candidate.provenance.sourceSessionId,
      null,
      candidate.provenance.gitBranch,
      candidate.provenance.gitSha,
      JSON.stringify(candidate.relatedFiles.map((file) => ({ path: file, role: 'mentioned', hash: null }))),
      JSON.stringify({ distilled_by: 'context-distillation', version: '2026-07-ucc-008.v1' }),
      candidate.securitySensitive ? 'untrusted' : 'local',
      candidate.provenance.sourceIdempotencyKey,
      JSON.stringify(candidate.provenance),
      JSON.stringify(payload),
      candidateTitle || 'Captured context candidate',
      candidate.content,
      initialStatus,
      candidate.category,
      candidate.content,
      candidate.confidence,
      candidate.candidateHash,
      candidate.provenance.sourceContentHash,
      candidate.provenance.sourceEventId,
      candidate.provenance.sourceSessionId,
      JSON.stringify(candidate.evidenceSnippets),
      candidate.reviewReason,
      candidate.securitySensitive,
      false,
      candidate.dedupeKey,
    ],
  );

  if (!inserted) {
    return { candidateId: null, status: initialStatus, memoryId: null, inserted: false };
  }

  const approved = await autoApproveCandidateIfAllowed(candidate, settings);
  if (approved.status === 'auto_approved') {
    await execute(
      `UPDATE memory_candidates
          SET status = 'auto_approved', review_status = 'approved', approved_memory_id = $2,
              resolved_at = NOW(), default_retrieval_eligible = true, updated_at = NOW()
        WHERE id = $1`,
      [inserted.id, approved.memoryId],
    );
  }

  return { candidateId: inserted.id, status: approved.status, memoryId: approved.memoryId, inserted: true };
}

export async function persistCapturedContextEvent(jobData: ContextCaptureEventJobPayloadType): Promise<PersistedContextEvent> {
  const payload = jobData.payload;
  const row = await queryOne<{ id: number }>(
    `INSERT INTO context_events (
       occurred_at, workspace_id, event_type, payload, payload_schema_version, source_system,
       tool_name, host_application, session_id, repo_path_hash, git_branch, git_sha, related_files,
       capture_policy, trust_tier, idempotency_key, provenance
     ) VALUES (
       $1, $2, $3, $4::jsonb, $5, $6,
       $7, $8, $9, $10, $11, $12, $13::jsonb,
       $14::jsonb, $15, $16, $17::jsonb
     )
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
       payload = EXCLUDED.payload,
       related_files = EXCLUDED.related_files,
       capture_policy = EXCLUDED.capture_policy,
       provenance = EXCLUDED.provenance
     RETURNING id`,
    [
      jobData.occurredAt,
      jobData.workspaceId,
      payload.eventType,
      JSON.stringify(payload),
      payload.payload_schema_version,
      payload.source_system,
      payload.tool_name,
      payload.host_application,
      payload.session_id,
      payload.repo_path_hash,
      payload.git_branch,
      payload.git_sha,
      JSON.stringify(payload.related_files),
      JSON.stringify(payload.capture_policy),
      payload.trust_tier,
      payload.idempotency_key,
      JSON.stringify(payload.provenance),
    ],
  );
  if (!row) throw new Error('context_event_insert_failed');
  return {
    id: row.id,
    workspaceId: jobData.workspaceId,
    idempotencyKey: payload.idempotency_key,
    contentHash: jobData.safety.contentHash,
    sessionId: payload.session_id,
  };
}

function toPayload(row: ContextEventRow): UnifiedContextEventPayloadType | null {
  const parsed = ContextCaptureEventJobPayload.shape.payload.safeParse(parseJsonish(row.payload));
  if (!parsed.success) {
    logger.warn({ eventId: row.id, issues: parsed.error.issues }, '[context-distillation] stored context event payload failed schema validation');
    return null;
  }
  return parsed.data;
}

async function loadEligibleEvents(workspaceId: string, limit: number, eventId?: number): Promise<ContextEventRow[]> {
  if (eventId) {
    return query<ContextEventRow>(
      `SELECT * FROM context_events WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [eventId, workspaceId],
    );
  }
  return query<ContextEventRow>(
    `SELECT * FROM context_events
      WHERE workspace_id = $1
        AND distillation_status IS NULL
        AND event_type IN ('agent_cli_session', 'shell_command', 'editor_activity', 'explicit_memory', 'git_commit', 'ci_pr')
      ORDER BY id ASC
      LIMIT $2`,
    [workspaceId, limit],
  );
}

export async function runContextDistillationJob(input: { workspaceId: string; eventId?: number; limit?: number }): Promise<{ processed: number; candidates: number; skipped: number; autoApproved: number }> {
  const settings = await getMemoryDistillationSettings(input.workspaceId);
  const limit = Math.min(Math.max(input.limit ?? settings.maxEventsPerJob, 1), MAX_EVENTS_PER_JOB);
  const events = await loadEligibleEvents(input.workspaceId, limit, input.eventId);
  let processed = 0;
  let candidates = 0;
  let skipped = 0;
  let autoApproved = 0;

  for (const event of events) {
    processed += 1;
    try {
      const payload = toPayload(event);
      if (!payload) {
        skipped += 1;
        await execute(
          `UPDATE context_events SET distillation_status = 'skipped', distillation_attempted_at = NOW(), distillation_error = $2 WHERE id = $1`,
          [event.id, 'invalid_payload'],
        );
        continue;
      }
      const occurredAt = event.occurred_at instanceof Date ? event.occurred_at.toISOString() : stringValue(event.occurred_at);
      const contentHash = hashCaptureContent({ payload, eventId: event.id, idempotencyKey: event.idempotency_key });
      const deterministic = distillContextEventToCandidate({ eventId: event.id, occurredAt, payload, safetyContentHash: contentHash, mode: settings.mode });
      if (!deterministic) {
        skipped += 1;
        await execute(
          `UPDATE context_events SET distillation_status = 'skipped', distillation_attempted_at = NOW(), distilled_at = NOW(), distillation_error = NULL WHERE id = $1`,
          [event.id],
        );
        continue;
      }
      const candidate = await maybeSummarizeCandidateWithLlm(deterministic, settings);
      const saved = await insertMemoryCandidate(candidate, settings);
      if (saved.status === 'auto_approved') autoApproved += 1;
      if (saved.inserted) candidates += 1;
      await execute(
        `UPDATE context_events SET distillation_status = $2, distillation_attempted_at = NOW(), distilled_at = NOW(), distillation_error = NULL WHERE id = $1`,
        [event.id, saved.status === 'auto_approved' ? 'auto_approved' : 'candidate'],
      );
    } catch (err) {
      await execute(
        `UPDATE context_events SET distillation_status = 'error', distillation_attempted_at = NOW(), distillation_error = $2 WHERE id = $1`,
        [event.id, err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)],
      );
      logger.warn({ err, eventId: event.id }, '[context-distillation] failed to distill context event');
    }
  }

  return { processed, candidates, skipped, autoApproved };
}

export async function handleContextCaptureJobs(jobs: PgBoss.Job<unknown>[], boss: PgBoss): Promise<void> {
  for (const job of jobs) {
    const parsed = ContextCaptureEventJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.warn({ jobId: job.id, issues: parsed.error.issues }, '[context-capture] invalid context:capture job payload');
      throw new Error(`Invalid context:capture payload: ${parsed.error.message}`);
    }
    const persisted = await persistCapturedContextEvent(parsed.data);
    await boss.send(CONTEXT_DISTILL_QUEUE, {
      workspaceId: persisted.workspaceId,
      eventId: persisted.id,
      idempotencyKey: persisted.idempotencyKey,
      contentHash: persisted.contentHash,
      sourceSessionId: persisted.sessionId,
    }, { retryLimit: 3 });
  }
}

export async function handleContextDistillationJobs(jobs: PgBoss.Job<unknown>[]): Promise<void> {
  for (const job of jobs) {
    const data = asRecord(job.data);
    const workspaceId = stringValue(data.workspaceId);
    if (!workspaceId) throw new Error('context:distill job requires workspaceId');
    const eventId = typeof data.eventId === 'number' && Number.isInteger(data.eventId) ? data.eventId : undefined;
    await runContextDistillationJob({ workspaceId, eventId });
  }
}

export async function registerContextCaptureHandlers(boss: PgBoss): Promise<void> {
  await boss.work('context:capture', { batchSize: 10 }, (jobs) => handleContextCaptureJobs(jobs, boss));
  await boss.work(CONTEXT_DISTILL_QUEUE, { batchSize: 4 }, handleContextDistillationJobs);
  logger.info('[context-distillation] registered context:capture and context:distill handlers');
}

export async function getMemoryCandidateCounts(workspaceId: string): Promise<Record<MemoryCandidateStatus, number>> {
  const rows = await query<{ status: MemoryCandidateStatus; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM memory_candidates WHERE workspace_id = $1 GROUP BY status`,
    [workspaceId],
  );
  const counts: Record<MemoryCandidateStatus, number> = { pending: 0, review_required: 0, approved: 0, rejected: 0, auto_approved: 0 };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

export async function listMemoryCandidates(input: {
  workspaceId: string;
  status?: MemoryCandidateStatus | 'all';
  limit?: number;
  sourceSystem?: string;
  toolName?: string;
  hostApp?: string;
  eventType?: string;
  trustTier?: string;
  confidence?: string;
  regulatedFlag?: boolean;
}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const clauses = ['workspace_id = $1'];
  const params: unknown[] = [input.workspaceId];
  const addEquals = (column: string, value: unknown) => {
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };
  if (input.status && input.status !== 'all') addEquals('status', input.status);
  if (input.sourceSystem) addEquals('source_system', input.sourceSystem);
  if (input.toolName) addEquals('tool_name', input.toolName);
  if (input.hostApp) addEquals('host_application', input.hostApp);
  if (input.eventType) addEquals('event_type', input.eventType);
  if (input.trustTier) addEquals('trust_tier', input.trustTier);
  if (input.confidence) addEquals('confidence', input.confidence);
  if (typeof input.regulatedFlag === 'boolean') addEquals('security_sensitive', input.regulatedFlag);
  params.push(limit);
  return query(
    `SELECT id, created_at, status, category, content, confidence, provenance, related_files,
            evidence_snippets, review_reason, security_sensitive, default_retrieval_eligible,
            approved_memory_id, context_event_id, event_type, source_system, tool_name,
            host_application, session_id, git_branch, git_sha, capture_policy, trust_tier,
            source_event_id, source_session_id
       FROM memory_candidates
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

function relatedFilesFromCandidate(value: unknown): string[] {
  const parsed = parseJsonish(value);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.flatMap((item) => {
    if (typeof item === 'string') return [item];
    const path = stringValue(asRecord(item).path);
    return path ? [path] : [];
  }))];
}

export async function approveMemoryCandidate(workspaceId: string, candidateId: number): Promise<{ candidateId: number; memoryId: number; alreadyApproved: boolean } | null> {
  const candidate = await queryOne<{
    id: number;
    status: MemoryCandidateStatus;
    category: string | null;
    content: string | null;
    confidence: string | null;
    related_files: unknown;
    approved_memory_id: number | null;
  }>(
    `SELECT id, status, category, content, confidence, related_files, approved_memory_id
       FROM memory_candidates
      WHERE id = $1 AND workspace_id = $2`,
    [candidateId, workspaceId],
  );
  if (!candidate) return null;
  if ((candidate.status === 'approved' || candidate.status === 'auto_approved') && candidate.approved_memory_id) {
    return { candidateId, memoryId: candidate.approved_memory_id, alreadyApproved: true };
  }
  if (candidate.status === 'rejected' || !candidate.content) return null;

  const relatedFiles = relatedFilesFromCandidate(candidate.related_files);
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(prepareText('memory', candidate.content));
  } catch (err) {
    logger.warn({ err, candidateId }, '[context-distillation] embedding failed while approving candidate; saving without vector');
  }

  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO memories (workspace_id, category, content, confidence, related_files, embedding, source_type, source)
     VALUES ($1, $2, $3, $4, $5, $6::vector, 'auto-extracted', 'context-distillation')
     RETURNING id`,
    [
      workspaceId,
      candidate.category ?? 'Pattern',
      candidate.content,
      candidate.confidence ?? 'medium',
      JSON.stringify(relatedFiles),
      embedding ? `[${embedding.join(',')}]` : null,
    ],
  );
  if (!inserted) return null;
  await execute(
    `UPDATE memory_candidates
        SET status = 'approved', review_status = 'approved', approved_memory_id = $2,
            resolved_at = NOW(), default_retrieval_eligible = true, updated_at = NOW()
      WHERE id = $1`,
    [candidateId, inserted.id],
  );
  return { candidateId, memoryId: inserted.id, alreadyApproved: false };
}

export async function rejectMemoryCandidate(workspaceId: string, candidateId: number): Promise<boolean> {
  const result = await execute(
    `UPDATE memory_candidates
        SET status = 'rejected', review_status = 'rejected', resolved_at = NOW(),
            default_retrieval_eligible = false, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND status IN ('pending', 'review_required')`,
    [candidateId, workspaceId],
  );
  return result.rowCount > 0;
}

export type MemoryCandidateReviewAction = 'edit' | 'duplicate' | 'supersede' | 'conflict' | 'defer';

export async function applyMemoryCandidateReviewAction(input: {
  workspaceId: string;
  candidateId: number;
  action: MemoryCandidateReviewAction;
  content?: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
  note?: string;
  targetCandidateId?: number;
}): Promise<Record<string, unknown> | null> {
  const candidate = await queryOne<Record<string, unknown>>(
    `SELECT * FROM memory_candidates WHERE id = $1 AND workspace_id = $2`,
    [input.candidateId, input.workspaceId],
  );
  if (!candidate) return null;

  if (input.action === 'edit') {
    const content = stringValue(input.content) ?? stringValue(candidate.content);
    if (!content) return null;
    const category = stringValue(input.category) ?? stringValue(candidate.category) ?? 'Pattern';
    const confidence = input.confidence ?? (stringValue(candidate.confidence) as 'high' | 'medium' | 'low' | null) ?? 'medium';
    await execute(
      `UPDATE memory_candidates
          SET content = $3, rule = $3, category = $4, confidence = $5,
              payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('content', $3, 'category', $4, 'confidence', $5),
              review_reason = NULL, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2`,
      [input.candidateId, input.workspaceId, content, category, confidence],
    );
    return { candidateId: input.candidateId, action: input.action, status: candidate.status };
  }

  if (input.action === 'defer') {
    await execute(
      `UPDATE memory_candidates
          SET status = 'review_required', review_status = 'deferred', review_reason = $3,
              resolved_at = NULL, default_retrieval_eligible = false, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2`,
      [input.candidateId, input.workspaceId, input.note ? `deferred: ${input.note}` : 'deferred_for_later_review'],
    );
    return { candidateId: input.candidateId, action: input.action, status: 'review_required' };
  }

  if (input.action === 'duplicate') {
    await execute(
      `UPDATE memory_candidates
          SET status = 'rejected', review_status = 'duplicate', resolved_at = NOW(), default_retrieval_eligible = false,
              review_reason = $3, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2`,
      [input.candidateId, input.workspaceId, input.note ? `duplicate: ${input.note}` : 'duplicate_candidate_rejected'],
    );
    return { candidateId: input.candidateId, action: input.action, status: 'rejected' };
  }

  const relationLabel = input.action === 'supersede' ? 'superseded_by_candidate' : 'conflicts_with_candidate';
  const reviewStatus = input.action === 'supersede' ? 'superseded' : 'conflict';
  const relationNote = input.targetCandidateId ? `${relationLabel}:${input.targetCandidateId}` : relationLabel;
  await execute(
    `UPDATE memory_candidates
        SET status = 'rejected', review_status = $4, resolved_at = NOW(), default_retrieval_eligible = false,
            review_reason = $3, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2`,
    [input.candidateId, input.workspaceId, input.note ? `${relationNote} ${input.note}` : relationNote, reviewStatus],
  );
  return { candidateId: input.candidateId, action: input.action, status: 'rejected', targetCandidateId: input.targetCandidateId ?? null };
}

// Imported by tests to assert no accidental transaction dependency in pure logic.
export const __contextDistillationInternals = { normalizeSettings, shouldSkipAsNoise };
