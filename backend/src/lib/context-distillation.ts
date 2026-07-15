/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Always-on context-event to canonical CCS memory-candidate distillation.
 *
 * Raw UCC source envelopes are retained in context_events.payload. Database
 * lifecycle/category/trust fields use the canonical mainline vocabularies; this
 * module intentionally does not recreate UCC's former parallel candidate state.
 */

import PgBoss from 'pg-boss';
import { execute, query, queryOne } from '../db/index';
import {
  ContextCaptureEventJobPayload,
  type ContextCaptureEventJobPayloadType,
  type UnifiedContextEventPayloadType,
} from './context-capture-contracts';
import { getContextCaptureControlState } from './context-capture-controls';
import { hashCaptureContent, sanitizeCapturePayload } from './context-safety';
import { logger } from './logger';
import { chatComplete, type ChatMessage } from './llm-client';
import { promoteMemory } from './memory-promotion';
import { resolveWorkflowConfig } from './workflow-config-resolver';

export const CONTEXT_CAPTURE_QUEUE = 'context:capture';
export const CONTEXT_DISTILL_QUEUE = 'context:distill';

export type MemoryDistillationMode = 'off' | 'explicit-only' | 'conservative-auto-candidates' | 'trusted-auto-approve';
export type MemoryCandidateCategory = 'Architecture' | 'Convention' | 'Bug Fix' | 'Decision' | 'Pattern' | 'Gotcha';

export interface MemoryDistillationSettings {
  mode: MemoryDistillationMode;
  operatorAutoApprove: boolean;
  llmSummarization: boolean;
  maxEventsPerJob: number;
}

export interface MemoryCandidateDraft {
  workspaceId: string;
  category: MemoryCandidateCategory;
  content: string;
  confidence: 'high' | 'medium' | 'low';
  securitySensitive: boolean;
  regulatedDomain: boolean;
  relatedFiles: string[];
  evidenceSnippets: Array<{ text: string; sourceField: string; redacted: boolean }>;
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
  idempotency_key: string;
  payload: unknown;
  distillation_status: string | null;
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
const DURABLE_SIGNAL_RE = /\b(must|never|always|prefer|requires?|required|gotcha|decision|decided|convention|architecture|root cause|fix(?:ed|es)?|bug|workaround|regression|security|secret|token|password|redact|pg-boss|queue|migration|schema|foreign key|idempotent|idempotency|dedup(?:e|lication)?)\b/i;
const NOISE_COMMAND_RE = /^\s*(pwd|ls(?:\s|$)|clear|git\s+status\b|git\s+diff\b|git\s+log\b|npm\s+run\s+lint\b|npm\s+test\b|npx\s+tsc\s+--noEmit\b)\s*$/i;
const SECURITY_RE = /\b(secret|token|password|api[_-]?key|credential|bearer|private key|ssn|credit card|hipaa|phi|pci|patient|medical record)\b/i;
const REGULATED_RE = /\b(hipaa|phi|pci|cardholder|ssn|patient|medical record|credit card)\b/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSettings(row?: { mode: string; operator_auto_approve: boolean; llm_summarization: boolean; max_events_per_job: number } | null): MemoryDistillationSettings {
  const mode = row?.mode === 'off' || row?.mode === 'explicit-only' || row?.mode === 'trusted-auto-approve' || row?.mode === 'conservative-auto-candidates'
    ? row.mode
    : DEFAULT_SETTINGS.mode;
  return {
    mode,
    operatorAutoApprove: Boolean(row?.operator_auto_approve),
    llmSummarization: Boolean(row?.llm_summarization),
    maxEventsPerJob: Math.min(Math.max(Number(row?.max_events_per_job ?? DEFAULT_SETTINGS.maxEventsPerJob), 1), MAX_EVENTS_PER_JOB),
  };
}

export async function getMemoryDistillationSettings(workspaceId: string): Promise<MemoryDistillationSettings> {
  const row = await queryOne<{ mode: string; operator_auto_approve: boolean; llm_summarization: boolean; max_events_per_job: number }>(
    `SELECT mode, operator_auto_approve, llm_summarization, max_events_per_job
       FROM memory_distillation_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  return normalizeSettings(row);
}

export async function upsertMemoryDistillationSettings(workspaceId: string, patch: Partial<MemoryDistillationSettings>): Promise<MemoryDistillationSettings> {
  const current = await getMemoryDistillationSettings(workspaceId);
  const next = normalizeSettings({
    mode: patch.mode ?? current.mode,
    operator_auto_approve: patch.operatorAutoApprove ?? current.operatorAutoApprove,
    llm_summarization: patch.llmSummarization ?? current.llmSummarization,
    max_events_per_job: patch.maxEventsPerJob ?? current.maxEventsPerJob,
  });
  await execute(
    `INSERT INTO memory_distillation_settings
       (workspace_id, mode, operator_auto_approve, llm_summarization, max_events_per_job, updated_at)
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

function boundedText(input: string, max = MAX_CANDIDATE_CHARS): string {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function sourceText(payload: UnifiedContextEventPayloadType): { text: string | null; field: string } {
  if (payload.eventType === 'explicit_memory') return { text: payload.memory_summary, field: 'memory_summary' };
  if (payload.eventType === 'agent_cli_session' || payload.eventType === 'shell_command') return { text: payload.command_summary, field: 'command_summary' };
  if (payload.eventType === 'editor_activity') return { text: payload.summary, field: 'summary' };
  if (payload.eventType === 'git_commit') return { text: payload.commit_subject, field: 'commit_subject' };
  if (payload.eventType === 'ci_pr') return { text: `${payload.provider} PR ${payload.pr_number} ${payload.status} ${payload.head_sha}`, field: 'status' };
  return { text: null, field: 'payload' };
}

function selectCategory(text: string): MemoryCandidateCategory {
  if (/(architecture|architectural|schema|foreign key|provider broker|queue|pg-boss)/i.test(text)) return 'Architecture';
  if (/(convention|always|never|must|prefer|required|requires)/i.test(text)) return 'Convention';
  if (/(fix|bug|regression|root cause|failed|error)/i.test(text)) return 'Bug Fix';
  if (/(decision|decided|choose|chosen)/i.test(text)) return 'Decision';
  if (/(gotcha|workaround|careful|avoid)/i.test(text)) return 'Gotcha';
  return 'Pattern';
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
  const selected = sourceText(payload);
  if (mode === 'off') return null;
  if (mode === 'explicit-only' && payload.eventType !== 'explicit_memory') return null;
  if (payload.eventType === 'ide_session') return null;
  if (!selected.text) return null;
  if ((payload.eventType === 'agent_cli_session' || payload.eventType === 'shell_command') && payload.phase === 'start') return null;
  if ((payload.eventType === 'agent_cli_session' || payload.eventType === 'shell_command') && NOISE_COMMAND_RE.test(selected.text)) return null;
  if (payload.eventType !== 'explicit_memory' && !DURABLE_SIGNAL_RE.test(selected.text)) return null;

  const sanitized = sanitizeCapturePayload({ value: selected.text }, { ...DEFAULT_SETTINGS_POLICY, rawContentDefault: 'explicit' });
  const content = boundedText(stringValue(asRecord(sanitized.payload).value) ?? '');
  if (!content) return null;
  const regulatedDomain = payload.eventType === 'agent_cli_session' || payload.eventType === 'shell_command'
    ? payload.regulated_signals.length > 0 || REGULATED_RE.test(selected.text)
    : REGULATED_RE.test(selected.text);
  const securitySensitive = sanitized.safety.redactionCount > 0 || SECURITY_RE.test(selected.text) || regulatedDomain;
  const relatedFiles = [...new Set([
    ...payload.related_files.map((file) => file.path),
    ...(payload.eventType === 'git_commit' ? payload.changed_files.map((file) => file.path) : []),
  ])];
  const category = selectCategory(content);
  const sourceContentHash = input.safetyContentHash || hashCaptureContent(payload);
  const candidateHash = `sha256:${hashCaptureContent({ category, content, relatedFiles })}`;
  const dedupeKey = `sha256:${hashCaptureContent({ workspaceId: payload.workspace_id, eventId: input.eventId ?? null, sourceContentHash, candidateHash })}`;

  return {
    workspaceId: payload.workspace_id,
    category,
    content,
    confidence: payload.eventType === 'explicit_memory' ? 'high' : 'medium',
    securitySensitive,
    regulatedDomain,
    relatedFiles,
    evidenceSnippets: [{ text: boundedText(content, MAX_EVIDENCE_CHARS), sourceField: selected.field, redacted: sanitized.safety.redactionCount > 0 }],
    provenance: {
      sourceContextEventId: input.eventId ?? null,
      sourceEventType: payload.eventType,
      sourceEventId: payload.provenance.source_event_id,
      sourceTool: payload.tool_name,
      sourceSystem: payload.source_system,
      sourceSessionId: payload.session_id ?? payload.source_identity.session_id,
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

const DEFAULT_SETTINGS_POLICY = {
  version: '2026-07-ucc-007',
  maxStringBytes: 16_384,
  maxPayloadBytes: 128_000,
  rawContentDefault: 'metadata+hash' as const,
  hashAlgorithm: 'sha256' as const,
};

function canonicalEventType(eventType: UnifiedContextEventPayloadType['eventType']): string {
  if (eventType === 'git_commit') return 'git_commit';
  if (eventType === 'ci_pr') return 'pr_merge';
  return 'manual_note';
}

function canonicalTrustTier(trust: UnifiedContextEventPayloadType['trust_tier']): string {
  if (trust === 'privileged') return 'approved_policy';
  if (trust === 'verified') return 'verified_fact';
  if (trust === 'local') return 'working_note';
  return 'agent_observation';
}

export async function persistCapturedContextEvent(jobData: ContextCaptureEventJobPayloadType): Promise<{ id: number; workspaceId: string; idempotencyKey: string; contentHash: string; sessionId: string | null }> {
  const payload = jobData.payload;
  const sourceRef = payload.git_sha ?? payload.provenance.source_event_id ?? payload.idempotency_key;
  const relatedFiles = [...new Set([
    ...payload.related_files.map((file) => file.path),
    ...(payload.eventType === 'git_commit' ? payload.changed_files.map((file) => file.path) : []),
  ])];
  const summary = sourceText(payload).text ?? `${payload.eventType} capture event`;
  const metadata = {
    captureSource: jobData.source,
    uccEventType: payload.eventType,
    safety: jobData.safety,
  };
  const row = await queryOne<{ id: number }>(
    `WITH inserted AS (
       INSERT INTO context_events (
         workspace_id, event_type, source_system, source_ref, occurred_at, summary,
         payload, provenance, related_files, metadata, trust_tier, idempotency_key,
         payload_schema_version, tool_name, host_application, session_id,
         repo_path_hash, git_branch, git_sha, capture_policy
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM context_events WHERE idempotency_key = $12 AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [
      jobData.workspaceId,
      canonicalEventType(payload.eventType),
      payload.source_system,
      sourceRef,
      jobData.occurredAt,
      summary,
      JSON.stringify(payload),
      JSON.stringify(payload.provenance),
      JSON.stringify(relatedFiles),
      JSON.stringify(metadata),
      canonicalTrustTier(payload.trust_tier),
      payload.idempotency_key,
      payload.payload_schema_version,
      payload.tool_name,
      payload.host_application,
      payload.session_id,
      payload.repo_path_hash,
      payload.git_branch,
      payload.git_sha,
      JSON.stringify(payload.capture_policy),
    ],
  );
  if (!row) throw new Error('context_event_insert_failed');
  return { id: row.id, workspaceId: jobData.workspaceId, idempotencyKey: payload.idempotency_key, contentHash: jobData.safety.contentHash, sessionId: payload.session_id };
}

async function maybeSummarize(candidate: MemoryCandidateDraft, settings: MemoryDistillationSettings): Promise<MemoryCandidateDraft> {
  if (!settings.llmSummarization) return candidate;
  try {
    const config = await resolveWorkflowConfig('memory_consolidation');
    const messages: ChatMessage[] = [{ role: 'user', content: `Summarize this as one durable actionable rule. Return plain text only.\n\n${candidate.content}` }];
    const result = await chatComplete(messages, {
      model: config.model ?? undefined,
      provider: config.provider,
      apiKey: config.apiKey ?? undefined,
      baseUrl: config.baseUrl ?? undefined,
      maxTokens: 512,
    });
    const content = boundedText(result.text.trim());
    return content ? { ...candidate, content, candidateHash: `sha256:${hashCaptureContent({ category: candidate.category, content, relatedFiles: candidate.relatedFiles })}` } : candidate;
  } catch (error) {
    logger.warn({ error }, '[context-distillation] optional LLM summarization failed');
    return candidate;
  }
}

async function insertCandidate(candidate: MemoryCandidateDraft, settings: MemoryDistillationSettings): Promise<{ inserted: boolean; autoApproved: boolean }> {
  const idempotencyKey = `context-distillation:${candidate.dedupeKey}`;
  const title = `${candidate.category}: ${candidate.content}`.slice(0, 240).trim() || 'Captured context candidate';
  const metadata = {
    distillation: { version: '2026-07-ucc-008.v1', evidenceSnippets: candidate.evidenceSnippets },
    sourceContentHash: candidate.provenance.sourceContentHash,
  };
  const row = await queryOne<{ id: number }>(
    `INSERT INTO memory_candidates (
       workspace_id, context_event_id, event_type, source_system, source_ref,
       occurred_at, suggested_category, title, rule, context, related_files,
       confidence, trust_tier, review_status, idempotency_key, provenance,
       metadata, security_sensitive, regulated_domain, requires_review,
       payload_schema_version, tool_name, session_id, git_branch, git_sha,
       capture_policy, candidate_hash, source_content_hash, source_event_id,
       source_session_id, evidence_snippets, review_reason,
       default_retrieval_eligible, dedupe_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
       $12, $13, 'pending', $14, $15::jsonb, $16::jsonb, $17, $18, TRUE,
       '2026-07-ucc-007.v1', $19, $20, $21, $22, $23::jsonb, $24, $25,
       $26, $27, $28::jsonb, $29, FALSE, $30
     )
     ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      candidate.workspaceId,
      candidate.provenance.sourceContextEventId,
      canonicalEventType(candidate.provenance.sourceEventType as UnifiedContextEventPayloadType['eventType']),
      candidate.provenance.sourceSystem,
      candidate.provenance.sourceEventId ?? candidate.provenance.sourceIdempotencyKey,
      candidate.provenance.occurredAt,
      candidate.category,
      title,
      candidate.content,
      'Distilled from an always-on context event; review before promotion.',
      JSON.stringify(candidate.relatedFiles),
      candidate.confidence,
      candidate.securitySensitive ? 'agent_observation' : 'working_note',
      idempotencyKey,
      JSON.stringify(candidate.provenance),
      JSON.stringify(metadata),
      candidate.securitySensitive,
      candidate.regulatedDomain,
      candidate.provenance.sourceTool,
      candidate.provenance.sourceSessionId,
      candidate.provenance.gitBranch,
      candidate.provenance.gitSha,
      JSON.stringify({ distilledBy: 'context-distillation' }),
      candidate.candidateHash,
      candidate.provenance.sourceContentHash,
      candidate.provenance.sourceEventId,
      candidate.provenance.sourceSessionId,
      JSON.stringify(candidate.evidenceSnippets),
      candidate.securitySensitive ? 'security_or_regulated_signal_requires_explicit_review' : null,
      candidate.dedupeKey,
    ],
  );
  if (!row) return { inserted: false, autoApproved: false };

  const mayAutoApprove = settings.mode === 'trusted-auto-approve' && settings.operatorAutoApprove && !candidate.securitySensitive && !candidate.regulatedDomain;
  if (!mayAutoApprove) return { inserted: true, autoApproved: false };

  const workspace = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [candidate.workspaceId]);
  if (!workspace) return { inserted: true, autoApproved: false };
  const promotion = await promoteMemory({
    workspaceId: candidate.workspaceId,
    workspacePath: workspace.path,
    category: candidate.category,
    title,
    rule: candidate.content,
    context: 'Auto-approved by explicit trusted-auto-approve operator policy.',
    source: `context-candidate:${row.id}`,
    sourceType: 'auto-extracted',
    confidence: candidate.confidence,
    relatedFiles: candidate.relatedFiles,
    provenance: { contextCapture: candidate.provenance },
  });
  await execute(
    `UPDATE memory_candidates
        SET review_status = 'approved', reviewer = 'context-distillation-policy',
            reviewed_at = NOW(), promoted_memory_id = $2, promoted_at = NOW(),
            default_retrieval_eligible = TRUE, updated_at = NOW()
      WHERE id = $1`,
    [row.id, Number(promotion.memoryId)],
  );
  return { inserted: true, autoApproved: true };
}

function parseStoredPayload(value: unknown): UnifiedContextEventPayloadType | null {
  const parsed = ContextCaptureEventJobPayload.shape.payload.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export async function runContextDistillationJob(input: { workspaceId: string; eventId?: number; limit?: number }): Promise<{ processed: number; candidates: number; skipped: number; autoApproved: number }> {
  const settings = await getMemoryDistillationSettings(input.workspaceId);
  const limit = Math.min(Math.max(input.limit ?? settings.maxEventsPerJob, 1), MAX_EVENTS_PER_JOB);
  const rows = input.eventId
    ? await query<ContextEventRow>('SELECT id, occurred_at, workspace_id, event_type, idempotency_key, payload, distillation_status FROM context_events WHERE id = $1 AND workspace_id = $2 LIMIT 1', [input.eventId, input.workspaceId])
    : await query<ContextEventRow>('SELECT id, occurred_at, workspace_id, event_type, idempotency_key, payload, distillation_status FROM context_events WHERE workspace_id = $1 AND distillation_status IS NULL ORDER BY id ASC LIMIT $2', [input.workspaceId, limit]);
  let candidates = 0;
  let skipped = 0;
  let autoApproved = 0;

  for (const event of rows) {
    try {
      const payload = parseStoredPayload(event.payload);
      if (!payload) {
        skipped += 1;
        await execute("UPDATE context_events SET distillation_status = 'skipped', distillation_attempted_at = NOW(), distillation_error = 'not_ucc_envelope' WHERE id = $1", [event.id]);
        continue;
      }
      const occurredAt = event.occurred_at instanceof Date ? event.occurred_at.toISOString() : stringValue(event.occurred_at);
      const draft = distillContextEventToCandidate({ eventId: event.id, occurredAt, payload, safetyContentHash: hashCaptureContent(payload), mode: settings.mode });
      if (!draft) {
        skipped += 1;
        await execute("UPDATE context_events SET distillation_status = 'skipped', distillation_attempted_at = NOW(), distilled_at = NOW(), distillation_error = NULL WHERE id = $1", [event.id]);
        continue;
      }
      const saved = await insertCandidate(await maybeSummarize(draft, settings), settings);
      if (saved.inserted) candidates += 1;
      if (saved.autoApproved) autoApproved += 1;
      await execute("UPDATE context_events SET distillation_status = $2, distillation_attempted_at = NOW(), distilled_at = NOW(), distillation_error = NULL WHERE id = $1", [event.id, saved.autoApproved ? 'auto_approved' : 'candidate']);
    } catch (error) {
      await execute("UPDATE context_events SET distillation_status = 'error', distillation_attempted_at = NOW(), distillation_error = $2 WHERE id = $1", [event.id, (error instanceof Error ? error.message : String(error)).slice(0, 500)]);
      logger.warn({ error, eventId: event.id }, '[context-distillation] event failed');
    }
  }
  return { processed: rows.length, candidates, skipped, autoApproved };
}

export async function enqueueContextDistillation(boss: PgBoss, workspaceId: string, eventId: number): Promise<string | null> {
  await boss.createQueue(CONTEXT_DISTILL_QUEUE);
  return boss.send(CONTEXT_DISTILL_QUEUE, { workspaceId, eventId }, { retryLimit: 3 });
}

export async function handleContextCaptureJobs(jobs: PgBoss.Job<unknown>[], boss: PgBoss): Promise<void> {
  for (const job of jobs) {
    const parsed = ContextCaptureEventJobPayload.safeParse(job.data);
    if (!parsed.success) throw new Error(`Invalid context:capture payload: ${parsed.error.message}`);
    const control = await getContextCaptureControlState(parsed.data.workspaceId);
    if (control.paused || control.policyMode === 'off') continue;
    const persisted = await persistCapturedContextEvent(parsed.data);
    const jobId = await enqueueContextDistillation(boss, persisted.workspaceId, persisted.id);
    if (!jobId) throw new Error('context:distill queue rejected job');
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
  await boss.createQueue(CONTEXT_CAPTURE_QUEUE);
  await boss.createQueue(CONTEXT_DISTILL_QUEUE);
  await boss.work(CONTEXT_CAPTURE_QUEUE, { batchSize: 10 }, (jobs) => handleContextCaptureJobs(jobs, boss));
  await boss.work(CONTEXT_DISTILL_QUEUE, { batchSize: 4 }, handleContextDistillationJobs);
  logger.info('[context-distillation] registered context:capture and context:distill handlers');
}

export async function getMemoryCandidateCounts(workspaceId: string): Promise<Record<string, number>> {
  const rows = await query<{ review_status: string; count: string }>('SELECT review_status, COUNT(*)::text AS count FROM memory_candidates WHERE workspace_id = $1 GROUP BY review_status', [workspaceId]);
  return Object.fromEntries(rows.map((row) => [row.review_status, Number(row.count)]));
}

export const __contextDistillationInternals = { normalizeSettings, canonicalEventType, canonicalTrustTier };
