/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * LFC-027: evidence-driven Learn closeout.
 *
 * This adapter deliberately does not read completion_packet, run output, logs,
 * or agent session prose. It stages reviewable candidates in the existing
 * memory_candidates queue from accepted host closeouts and normalized evidence.
 */

import crypto from 'node:crypto';
import { execute, query, queryOne } from '../db/index';
import { hashCaptureContent, sanitizeCapturePayload } from './context-safety';
import {
  stageGovernedMemoryCandidate,
  type MemoryCandidateCategory,
  type MemoryCandidateDraft,
} from './context-distillation';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { logger } from './logger';
import { chatComplete, type ChatMessage } from './llm-client';
import { createCanonicalEvidence, persistCanonicalEvidence } from './ssdlc-evidence';
import { resolveWorkflowConfig } from './workflow-config-resolver';

export const LEARN_CLOSEOUT_VERSION = 'rorca.learn-closeout.v1' as const;
export const MAX_LEARN_CANDIDATES = 24;
export const MAX_LEARN_SOURCE_EVIDENCE_IDS = 16;
export const MAX_LEARN_CONTENT_CHARS = 700;

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'partial_failure', 'cancelled']);
const AUTHORITATIVE_TRUST = new Set(['host_observed', 'provider_verified', 'authenticated_manual']);
const SENSITIVE_RE = /\b(security|production|credential|secret|token|password|private communication|private slack|destructive migration|drop table|truncate table|force push)\b/i;
const PRIVATE_CONTEXT_REDACTIONS: Array<[RegExp, string]> = [
  [/https?:\/\/[\w.-]*slack\.com\/[^\s)]+/gi, '[REDACTED_PRIVATE_SLACK]'],
  [/\b(?:private[-_ ]?slack|slack[-_ ]?(?:channel|thread|message))\s*[:=]\s*[^,;.\n]+/gi, 'private communication=[REDACTED]'],
  [/\b(?:customer|tenant)(?:[-_ ]?(?:id|name|slug))?\s*[:=]\s*[A-Za-z0-9_.@/-]+/gi, 'customer/tenant=[REDACTED]'],
  [/\bRORCA_(?:SECRET_)?CANARY[A-Za-z0-9_-]*\b/gi, '[REDACTED_CANARY]'],
  [/\bcanary[-_:][A-Za-z0-9_-]{6,}\b/gi, '[REDACTED_CANARY]'],
];

export type LearnFactType =
  | 'accepted_decision'
  | 'governed_decision'
  | 'defect_fix'
  | 'validation_classification'
  | 'retry_cause'
  | 'operational_blocker'
  | 'release_outcome'
  | 'conflicting_evidence';

export interface LearnReleaseSubject {
  type: 'spec_hash' | 'commit_sha' | 'artifact_digest' | 'deployment_id';
  value: string;
}

export interface LearnEvidenceFact {
  id: string;
  storyId: string | null;
  classification: string;
  status: string;
  trustLevel: string;
  sourceType: string;
  sourceSystem: string;
  subject: LearnReleaseSubject;
  revisionMismatch: boolean;
}

export interface LearnDecisionFact {
  id: string;
  storyId: string | null;
  decisionType: string;
  status: 'accepted' | 'active';
  rationale: string | null;
  sourceEvidenceIds: string[];
}

export interface LearnCloseoutFacts {
  workspaceId: string;
  specId: string;
  runId: number;
  runStatus: string;
  retriedFromRunId: number | null;
  retryReasonCodes: string[];
  retrySourceId: string | null;
  releaseSubject: LearnReleaseSubject;
  commitSha: string | null;
  closedAt: string;
  mergeStatus: string | null;
  prNumber: number | null;
  acceptedCloseoutCount: number;
  evidence: LearnEvidenceFact[];
  decisions: LearnDecisionFact[];
}

export interface LearnCandidateInput {
  factType: LearnFactType;
  category: MemoryCandidateCategory;
  content: string;
  confidence: 'high' | 'medium' | 'low';
  storyId: string | null;
  sourceEvidenceIds: string[];
  sourceDecisionIds: string[];
  releaseSubject: LearnReleaseSubject;
  commitSha: string | null;
  securitySensitive: boolean;
  reviewReason: string;
  normalizedFact: string;
  dedupeKey: string;
}

export interface LearnCloseoutResult {
  status: 'generated' | 'not_started' | 'blocked';
  workspaceId: string;
  specId: string;
  runId: number;
  candidateIds: number[];
  candidateCount: number;
  deduplicatedCount: number;
  sourceEvidenceCount: number;
  modelSummary: {
    requested: boolean;
    applied: number;
    blocker: { code: 'model_unavailable'; retryable: true; message: string } | null;
  };
  blocker: { code: string; retryable: boolean; message: string } | null;
}

interface RunRow {
  id: number;
  workspace_id: string;
  spec_path: string;
  status: string;
  retried_from_run_id: number | null;
  merge_status: string | null;
  merge_commit_sha: string | null;
  pr_number: number | null;
  finished_at: Date | string | null;
}

interface EvidenceRow {
  id: string;
  story_id: string | null;
  classification: string;
  evidence_status: string;
  trust_level: string;
  source_type: string;
  source_system: string;
  subject_type: LearnReleaseSubject['type'];
  subject_value: string;
  phase_subject_type: LearnReleaseSubject['type'] | null;
  phase_subject_value: string | null;
  release_identity: Record<string, unknown> | null;
  payload_hash: string;
  revision_mismatch: boolean;
}

interface CloseoutRow {
  decision_id: string;
  story_id: string;
  status: 'accepted' | 'blocked';
  payload: Record<string, unknown> | string;
}

interface GovernedDecisionRow {
  id: string;
  story_id: string | null;
  decision_type: string;
  rationale: string;
  subject_type: LearnReleaseSubject['type'] | null;
  subject_value: string | null;
}

function stableHash(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function bounded(input: string): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_LEARN_CONTENT_CHARS ? normalized : `${normalized.slice(0, MAX_LEARN_CONTENT_CHARS - 1)}…`;
}

/** Strict Learn redaction runs before persistence and before optional model use. */
export function redactLearnContent(input: string): { content: string; redacted: boolean } {
  const sanitized = sanitizeCapturePayload({ value: input });
  let content = typeof record(sanitized.payload).value === 'string' ? String(record(sanitized.payload).value) : '';
  let redacted = sanitized.safety.redactionCount > 0;
  for (const [pattern, replacement] of PRIVATE_CONTEXT_REDACTIONS) {
    const next = content.replace(pattern, replacement);
    if (next !== content) redacted = true;
    content = next;
  }
  return { content: bounded(content), redacted };
}

function normalizeFact(input: string): string {
  return input.toLowerCase().replace(/\[[^\]]*redacted[^\]]*\]/gi, '[redacted]').replace(/[^a-z0-9[\] ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sourceIds(evidence: LearnEvidenceFact[], storyId?: string | null): string[] {
  return [...new Set(evidence.filter((item) => !storyId || item.storyId === storyId).map((item) => item.id))]
    .sort((a, b) => a.localeCompare(b)).slice(0, MAX_LEARN_SOURCE_EVIDENCE_IDS);
}

function candidate(input: Omit<LearnCandidateInput, 'normalizedFact' | 'dedupeKey' | 'securitySensitive' | 'reviewReason'> & {
  workspaceId: string;
  securitySensitive?: boolean;
  reviewReason?: string;
}): LearnCandidateInput | null {
  const redacted = redactLearnContent(input.content);
  if (!redacted.content) return null;
  const normalizedFact = normalizeFact(redacted.content);
  const releaseSubject = safeReleaseSubject(input.releaseSubject);
  const commitSha = !input.commitSha || /^[a-f0-9]{7,64}$/i.test(input.commitSha)
    ? input.commitSha
    : `redacted:${hashCaptureContent(input.commitSha)}`;
  const securitySensitive = Boolean(input.securitySensitive || input.releaseSubject.type === 'deployment_id' || redacted.redacted || SENSITIVE_RE.test(redacted.content));
  return {
    factType: input.factType,
    category: input.category,
    content: redacted.content,
    confidence: input.confidence,
    storyId: input.storyId,
    sourceEvidenceIds: [...new Set(input.sourceEvidenceIds)].sort().slice(0, MAX_LEARN_SOURCE_EVIDENCE_IDS),
    sourceDecisionIds: [...new Set(input.sourceDecisionIds)].sort().slice(0, MAX_LEARN_SOURCE_EVIDENCE_IDS),
    releaseSubject,
    commitSha,
    securitySensitive,
    reviewReason: input.reviewReason ?? (securitySensitive
      ? 'sensitive_delivery_fact_requires_human_review'
      : 'verified_delivery_fact_requires_human_review'),
    normalizedFact,
    dedupeKey: stableHash({
      workspaceId: input.workspaceId,
      normalizedFact,
      releaseSubject,
    }),
  };
}

/** Deterministic extraction orders authoritative facts and never consumes agent prose. */
export function extractLearnCandidateInputs(facts: LearnCloseoutFacts): LearnCandidateInput[] {
  if (!TERMINAL_RUN_STATUSES.has(facts.runStatus) || facts.acceptedCloseoutCount === 0) return [];
  const authoritative = facts.evidence.filter((item) => AUTHORITATIVE_TRUST.has(item.trustLevel) && !item.revisionMismatch);
  if (authoritative.length === 0) return [];
  const drafts: Array<LearnCandidateInput | null> = [];

  for (const decision of facts.decisions.filter((item) => item.status === 'accepted')) {
    drafts.push(candidate({
      workspaceId: facts.workspaceId,
      factType: 'accepted_decision',
      category: 'Decision',
      content: `Host closeout accepted ${decision.storyId ? `story ${decision.storyId}` : 'delivery work'} for ${facts.releaseSubject.type} ${facts.releaseSubject.value}.`,
      confidence: 'high',
      storyId: decision.storyId,
      sourceEvidenceIds: decision.sourceEvidenceIds.length > 0 ? decision.sourceEvidenceIds : sourceIds(authoritative, decision.storyId),
      sourceDecisionIds: [decision.id],
      releaseSubject: facts.releaseSubject,
      commitSha: facts.commitSha,
    }));
  }

  for (const decision of facts.decisions.filter((item) => item.status === 'active')) {
    const rationale = decision.rationale ? `: ${decision.rationale}` : '';
    drafts.push(candidate({
      workspaceId: facts.workspaceId,
      factType: 'governed_decision',
      category: 'Decision',
      content: `Governed ${decision.decisionType} decision applied${decision.storyId ? ` to story ${decision.storyId}` : ''}${rationale}.`,
      confidence: 'high',
      storyId: decision.storyId,
      sourceEvidenceIds: sourceIds(authoritative, decision.storyId),
      sourceDecisionIds: [decision.id],
      releaseSubject: facts.releaseSubject,
      commitSha: facts.commitSha,
      securitySensitive: /production|security|credential/i.test(decision.decisionType),
    }));
  }

  const byStory = new Map<string, LearnEvidenceFact[]>();
  for (const item of authoritative) {
    const key = item.storyId ?? 'run';
    byStory.set(key, [...(byStory.get(key) ?? []), item]);
  }
  for (const [storyKey, items] of byStory) {
    const statuses = new Set(items.map((item) => item.status));
    const ids = sourceIds(items);
    const storyId = storyKey === 'run' ? null : storyKey;
    if (statuses.has('story_caused_failure') && statuses.has('passed')) {
      drafts.push(candidate({
        workspaceId: facts.workspaceId,
        factType: 'defect_fix',
        category: 'Bug Fix',
        content: `Host validation recorded a story-caused failure and a later passing outcome${storyId ? ` for story ${storyId}` : ''} on ${facts.releaseSubject.type} ${facts.releaseSubject.value}.`,
        confidence: 'high', storyId, sourceEvidenceIds: ids, sourceDecisionIds: [], releaseSubject: facts.releaseSubject, commitSha: facts.commitSha,
      }));
    }
    if (statuses.has('passed') && statuses.size > 1) {
      drafts.push(candidate({
        workspaceId: facts.workspaceId,
        factType: 'conflicting_evidence',
        category: 'Gotcha',
        content: `Conflicting host validation classifications remain reviewable${storyId ? ` for story ${storyId}` : ''}: ${[...statuses].sort().join(', ')}.`,
        confidence: 'medium', storyId, sourceEvidenceIds: ids, sourceDecisionIds: [], releaseSubject: facts.releaseSubject, commitSha: facts.commitSha,
        reviewReason: 'conflicting_authoritative_evidence_requires_human_review',
      }));
    } else {
      for (const status of [...statuses].sort()) {
        const category: MemoryCandidateCategory = status === 'story_caused_failure' ? 'Bug Fix'
          : status === 'environment_credential_blocker' ? 'Follow-up'
            : status === 'unrelated_baseline' ? 'Gotcha' : 'Pattern';
        drafts.push(candidate({
          workspaceId: facts.workspaceId,
          factType: status === 'environment_credential_blocker' ? 'operational_blocker' : 'validation_classification',
          category,
          content: `Host validation classified${storyId ? ` story ${storyId}` : ' the run'} as ${status.replace(/_/g, ' ')} for ${facts.releaseSubject.type} ${facts.releaseSubject.value}.`,
          confidence: status === 'unknown' ? 'low' : 'high', storyId,
          sourceEvidenceIds: ids, sourceDecisionIds: [], releaseSubject: facts.releaseSubject, commitSha: facts.commitSha,
          securitySensitive: status === 'environment_credential_blocker',
        }));
      }
    }
  }

  if (facts.retriedFromRunId) {
    drafts.push(candidate({
      workspaceId: facts.workspaceId,
      factType: 'retry_cause',
      category: 'Follow-up',
      content: `A governed retry was required for authoritative delivery work on ${facts.releaseSubject.type} ${facts.releaseSubject.value}${facts.retryReasonCodes.length > 0 ? ` because ${facts.retryReasonCodes.join(', ')}` : ''}.`,
      confidence: 'high', storyId: null, sourceEvidenceIds: sourceIds(authoritative), sourceDecisionIds: facts.retrySourceId ? [facts.retrySourceId] : [], releaseSubject: facts.releaseSubject, commitSha: facts.commitSha,
    }));
  }

  drafts.push(candidate({
    workspaceId: facts.workspaceId,
    factType: 'release_outcome',
    category: facts.runStatus === 'done' ? 'Pattern' : 'Gotcha',
    content: `Release closeout for ${facts.releaseSubject.type} ${facts.releaseSubject.value} finished with run status ${facts.runStatus}, merge status ${facts.mergeStatus ?? 'not attempted'}, and PR ${facts.prNumber ?? 'not created'}.`,
    confidence: 'high', storyId: null, sourceEvidenceIds: sourceIds(authoritative), sourceDecisionIds: [], releaseSubject: facts.releaseSubject, commitSha: facts.commitSha,
    securitySensitive: facts.releaseSubject.type === 'deployment_id',
  }));

  const unique = new Map<string, LearnCandidateInput>();
  for (const draft of drafts) if (draft && !unique.has(draft.dedupeKey)) unique.set(draft.dedupeKey, draft);
  const ordered = [...unique.values()].sort((a, b) => a.factType.localeCompare(b.factType) || (a.storyId ?? '').localeCompare(b.storyId ?? '') || a.dedupeKey.localeCompare(b.dedupeKey));
  // Reserve one slot for every present fact class before filling the remaining
  // bound. A large spec therefore cannot crowd release/retry/blocker learning
  // out with one accepted-closeout candidate per story.
  const selected: LearnCandidateInput[] = [];
  const selectedKeys = new Set<string>();
  for (const factType of [
    'accepted_decision', 'governed_decision', 'defect_fix', 'retry_cause',
    'validation_classification', 'operational_blocker', 'release_outcome', 'conflicting_evidence',
  ] as const) {
    const item = ordered.find((candidate) => candidate.factType === factType);
    if (item) {
      selected.push(item);
      selectedKeys.add(item.dedupeKey);
    }
  }
  for (const item of ordered) {
    if (selected.length >= MAX_LEARN_CANDIDATES) break;
    if (!selectedKeys.has(item.dedupeKey)) selected.push(item);
  }
  return selected;
}

function summarySupportedByFacts(summary: string, deterministic: string): boolean {
  const summaryWords = normalizeFact(summary).split(' ').filter(Boolean);
  const factWords = new Set(normalizeFact(deterministic).split(' ').filter(Boolean));
  return summaryWords.length > 0 && summaryWords.every((word) => factWords.has(word));
}

export async function summarizeLearnCandidates(candidates: LearnCandidateInput[], enabled: boolean): Promise<{
  candidates: LearnCandidateInput[];
  applied: number;
  blocker: LearnCloseoutResult['modelSummary']['blocker'];
}> {
  if (!enabled || candidates.length === 0) return { candidates, applied: 0, blocker: null };
  try {
    const config = await resolveWorkflowConfig('memory_consolidation');
    const output: LearnCandidateInput[] = [];
    let applied = 0;
    for (const item of candidates) {
      const messages: ChatMessage[] = [{ role: 'user', content: `Shorten this already-redacted verified fact by deleting words only. Do not add claims, identifiers, or provenance. Return plain text.\n\n${item.content}` }];
      const result = await chatComplete(messages, {
        model: config.model ?? undefined,
        provider: config.provider,
        apiKey: config.apiKey ?? undefined,
        baseUrl: config.baseUrl ?? undefined,
        maxTokens: 256,
      });
      const redacted = redactLearnContent(result.text);
      if (summarySupportedByFacts(redacted.content, item.content)) {
        output.push({ ...item, content: redacted.content });
        applied += 1;
      } else output.push(item);
    }
    return { candidates: output, applied, blocker: null };
  } catch (error) {
    logger.warn({ error }, '[learn-closeout] optional model unavailable; deterministic candidates retained');
    return {
      candidates,
      applied: 0,
      blocker: { code: 'model_unavailable', retryable: true, message: 'Optional summarization is unavailable; deterministic verified facts were retained.' },
    };
  }
}

function safeReleaseSubject(subject: LearnReleaseSubject): LearnReleaseSubject {
  if (subject.type === 'commit_sha' && /^[a-f0-9]{7,64}$/i.test(subject.value)) return subject;
  if ((subject.type === 'spec_hash' || subject.type === 'artifact_digest') && /^sha256:[a-f0-9]{64}$/i.test(subject.value)) return subject;
  const sanitized = redactLearnContent(subject.value);
  return sanitized.redacted
    ? { ...subject, value: `redacted:${hashCaptureContent(subject.value)}` }
    : { ...subject, value: sanitized.content };
}

function releaseSubject(run: RunRow, evidence: EvidenceRow[], plan: Record<string, unknown>): LearnReleaseSubject {
  const currentEvidence = evidence.filter((item) => !item.revision_mismatch && AUTHORITATIVE_TRUST.has(item.trust_level));
  for (const type of ['deployment_id', 'artifact_digest', 'commit_sha'] as const) {
    const match = currentEvidence.find((item) => item.phase_subject_type === type && item.phase_subject_value)
      ?? currentEvidence.find((item) => item.subject_type === type && item.subject_value);
    if (match) return safeReleaseSubject({ type, value: match.phase_subject_type === type ? match.phase_subject_value! : match.subject_value });
  }
  if (run.merge_commit_sha) return safeReleaseSubject({ type: 'commit_sha', value: run.merge_commit_sha });
  const inputHash = typeof plan.inputHash === 'string' ? plan.inputHash : stableHash({ specPath: run.spec_path });
  return safeReleaseSubject({ type: 'spec_hash', value: inputHash });
}

async function loadFacts(workspaceId: string, runId: number, expectedSpecId?: string): Promise<{ facts: LearnCloseoutFacts; learnGateId: string | null }> {
  const run = await queryOne<RunRow>(
    `SELECT id, workspace_id, spec_path, status, retried_from_run_id, merge_status, merge_commit_sha, pr_number, finished_at
       FROM pipeline_runs WHERE id = $1 AND workspace_id = $2`,
    [runId, workspaceId],
  );
  if (!run) throw new NotFoundError('Pipeline run', String(runId));
  if (!TERMINAL_RUN_STATUSES.has(run.status) || !run.finished_at) throw new ConflictError('Learn closeout requires a terminal run', { runId, status: run.status });
  const specId = run.spec_path.replace(/^.*\//, '').replace(/\.json$/, '');
  if (expectedSpecId && expectedSpecId !== specId) throw new NotFoundError('Pipeline run', String(runId));

  const [evidence, closeouts, governed, planRow, retryPreview] = await Promise.all([
    query<EvidenceRow>(
      `SELECT id::text, story_id, classification, evidence_status, trust_level, source_type, source_system,
              subject_type, subject_value, phase_subject_type, phase_subject_value, release_identity, payload_hash, revision_mismatch
         FROM ssdlc_lifecycle_evidence
        WHERE workspace_id = $1 AND spec_slug = $2 AND run_id = $3 AND source_type <> 'memory_closeout'
        ORDER BY id`,
      [workspaceId, specId, runId],
    ),
    query<CloseoutRow>(
      `SELECT decision_id, story_id, status, payload FROM story_closeout_decisions
        WHERE workspace_id = $1 AND spec_id = $2 AND run_id = $3 ORDER BY story_id, attempt`,
      [workspaceId, specId, runId],
    ),
    query<GovernedDecisionRow>(
      `SELECT id::text, story_id, decision_type, rationale, subject_type, subject_value FROM ssdlc_decisions
        WHERE workspace_id = $1 AND spec_slug = $2 AND (run_id = $3 OR run_id IS NULL)
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY id`,
      [workspaceId, specId, runId],
    ),
    queryOne<{ plan_json: Record<string, unknown> }>(
      `SELECT plan_json FROM ssdlc_compiled_plans WHERE workspace_id = $1 AND spec_slug = $2 AND is_current = TRUE AND validation_status = 'validated'`,
      [workspaceId, specId],
    ),
    queryOne<{ preview_hash: string; packet: Record<string, unknown> | string }>(
      `SELECT preview_hash, packet FROM pipeline_retry_previews
        WHERE workspace_id = $1 AND retry_run_id = $2 AND status = 'dispatched'
        ORDER BY dispatched_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [workspaceId, runId],
    ),
  ]);
  const plan = record(planRow?.plan_json);
  const release = releaseSubject(run, evidence, plan);
  const mappedEvidence: LearnEvidenceFact[] = evidence.map((item) => ({
    id: item.id,
    storyId: item.story_id,
    classification: item.classification,
    status: item.evidence_status,
    trustLevel: item.trust_level,
    sourceType: item.source_type,
    sourceSystem: item.source_system,
    subject: item.phase_subject_type && item.phase_subject_value
      ? { type: item.phase_subject_type, value: item.phase_subject_value }
      : { type: item.subject_type, value: item.subject_value },
    revisionMismatch: item.revision_mismatch,
  }));
  const canonicalEvidenceIds = new Map(evidence.map((item) => [`EVD-sha256:${item.payload_hash}`, item.id]));
  const decisions: LearnDecisionFact[] = closeouts.filter((item) => item.status === 'accepted').map((item) => {
    const payload = record(item.payload);
    const mappedIds = stringArray(payload.normalizedEvidenceReferences).flatMap((reference) => {
      const id = canonicalEvidenceIds.get(reference);
      return id ? [id] : [];
    });
    return {
      id: item.decision_id,
      storyId: item.story_id,
      decisionType: 'story_closeout',
      status: 'accepted' as const,
      rationale: null,
      sourceEvidenceIds: mappedIds.length > 0 ? [...new Set(mappedIds)].sort() : sourceIds(mappedEvidence, item.story_id),
    };
  });
  decisions.push(...governed.filter((item) => !item.subject_type || (
    item.subject_type === release.type && item.subject_value === release.value
  )).map((item) => ({
    id: item.id,
    storyId: item.story_id,
    decisionType: item.decision_type,
    status: 'active' as const,
    rationale: item.rationale,
    sourceEvidenceIds: [],
  })));
  const gates = Array.isArray(plan.gates) ? plan.gates.map(record) : [];
  const learnGate = gates.find((gate) => gate.phaseId === 'learn');
  const retryScope = record(record(retryPreview?.packet).scope);
  const retryReasonCodes = [...new Set(Object.values(retryScope).flatMap((items) => Array.isArray(items)
    ? items.map(record).flatMap((item) => typeof item.reasonCode === 'string' ? [item.reasonCode] : [])
    : []))].sort();
  return {
    facts: {
      workspaceId,
      specId,
      runId,
      runStatus: run.status,
      retriedFromRunId: run.retried_from_run_id,
      retryReasonCodes,
      retrySourceId: retryPreview ? `retry-preview:${retryPreview.preview_hash}` : null,
      releaseSubject: release,
      commitSha: release.type === 'commit_sha' && !release.value.startsWith('redacted:') ? release.value : run.merge_commit_sha,
      closedAt: new Date(run.finished_at!).toISOString(),
      mergeStatus: run.merge_status,
      prNumber: run.pr_number,
      acceptedCloseoutCount: closeouts.filter((item) => item.status === 'accepted').length,
      evidence: mappedEvidence,
      decisions,
    },
    learnGateId: typeof learnGate?.gateId === 'string' ? learnGate.gateId : null,
  };
}

export function toMemoryDraft(facts: LearnCloseoutFacts, input: LearnCandidateInput): MemoryCandidateDraft {
  const sourceContentHash = hashCaptureContent({ normalizedFact: input.normalizedFact, releaseSubject: input.releaseSubject });
  const sourceEventId = input.sourceDecisionIds[0] ?? input.sourceEvidenceIds[0] ?? `run:${facts.runId}`;
  const provenance = {
    sourceContextEventId: null,
    sourceEventType: 'explicit_memory',
    sourceEventId,
    sourceTool: 'learn-closeout',
    sourceSystem: 'rorca:lifecycle-closeout',
    sourceSessionId: `run:${facts.runId}`,
    sourceContentHash,
    sourceIdempotencyKey: input.dedupeKey,
    occurredAt: null,
    gitBranch: null,
    gitSha: input.commitSha,
    kind: 'lifecycle_closeout',
    schemaVersion: LEARN_CLOSEOUT_VERSION,
    workspaceId: facts.workspaceId,
    specId: facts.specId,
    runId: facts.runId,
    storyId: input.storyId,
    commitSha: input.commitSha,
    releaseSubject: input.releaseSubject,
    sourceEvidenceIds: input.sourceEvidenceIds,
    sourceDecisionIds: input.sourceDecisionIds,
    candidateCategory: input.category,
    confidence: input.confidence,
    factType: input.factType,
    normalizedFact: input.normalizedFact,
    deduplicationKey: input.dedupeKey,
  };
  return {
    workspaceId: facts.workspaceId,
    category: input.category,
    content: input.content,
    confidence: input.confidence,
    status: 'review_required',
    reviewReason: input.reviewReason,
    securitySensitive: input.securitySensitive,
    defaultRetrievalEligible: false,
    relatedFiles: [],
    evidenceSnippets: input.sourceEvidenceIds.map((id) => ({ text: `Verified lifecycle evidence ${id}`, sourceField: 'sourceEvidenceIds', redacted: false })),
    provenance,
    candidateHash: stableHash({ category: input.category, normalizedFact: input.normalizedFact }),
    dedupeKey: input.dedupeKey,
  };
}

async function updateRunCloseout(runId: number, status: 'generated' | 'not_started' | 'blocked', blocker: LearnCloseoutResult['blocker'], counts: { candidateIds: number[]; evidence: number }): Promise<void> {
  const candidateIds = [...new Set(counts.candidateIds)].sort((a, b) => a - b).slice(0, MAX_LEARN_CANDIDATES);
  await execute(
    `UPDATE pipeline_runs SET learn_closeout_status = $2, learn_closeout_blocker = $3,
            learn_closeout_attempted_at = NOW(), learn_candidate_count = $4,
            learn_candidate_ids = $5::jsonb, learn_source_evidence_count = $6
      WHERE id = $1`,
    [runId, status, blocker ? JSON.stringify(blocker) : null, candidateIds.length, JSON.stringify(candidateIds), counts.evidence],
  );
}

export async function generateLearnCloseoutCandidates(input: {
  workspaceId: string;
  runId: number;
  specId?: string;
  modelSummarization?: boolean;
}): Promise<LearnCloseoutResult> {
  if (!input.workspaceId.trim()) throw new ValidationError('workspaceId is required', { field: 'workspaceId' });
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw new ValidationError('runId must be a positive integer', { field: 'runId' });
  const { facts, learnGateId } = await loadFacts(input.workspaceId, input.runId, input.specId);
  const deterministic = extractLearnCandidateInputs(facts);
  const authoritativeEvidence = facts.evidence.filter((item) => AUTHORITATIVE_TRUST.has(item.trustLevel) && !item.revisionMismatch);
  if (facts.acceptedCloseoutCount === 0 || deterministic.length === 0) {
    const blocker = {
      code: facts.acceptedCloseoutCount === 0 ? 'no_validated_completion_packets' : 'no_durable_learning_evidence',
      retryable: true,
      message: facts.acceptedCloseoutCount === 0
        ? 'No accepted host-validated story completion packet is available.'
        : 'Accepted closeout exists, but no authoritative durable learning evidence is available.',
    };
    await updateRunCloseout(input.runId, 'not_started', blocker, { candidateIds: [], evidence: authoritativeEvidence.length });
    return {
      status: 'not_started', workspaceId: facts.workspaceId, specId: facts.specId, runId: facts.runId,
      candidateIds: [], candidateCount: 0, deduplicatedCount: 0, sourceEvidenceCount: authoritativeEvidence.length,
      modelSummary: { requested: Boolean(input.modelSummarization), applied: 0, blocker: null }, blocker,
    };
  }

  const summarized = await summarizeLearnCandidates(deterministic, Boolean(input.modelSummarization));
  const candidateIds: number[] = [];
  let inserted = 0;
  for (const item of summarized.candidates) {
    const saved = await stageGovernedMemoryCandidate(toMemoryDraft(facts, item));
    candidateIds.push(saved.candidateId);
    if (saved.inserted) inserted += 1;
  }
  const uniqueIds = [...new Set(candidateIds)].sort((a, b) => a - b);
  const closeoutEvidence = createCanonicalEvidence({
    sourceType: 'memory_closeout',
    sourceSystem: 'rorca:learn-closeout',
    sourceEventId: `learn-closeout:${facts.specId}:run:${facts.runId}:${facts.releaseSubject.type}:${stableHash(facts.releaseSubject).slice(7)}`,
    observedAt: facts.closedAt,
    scope: { workspaceId: facts.workspaceId, specSlug: facts.specId, runId: facts.runId, storyId: null, phaseId: 'learn', gateId: learnGateId },
    subject: facts.releaseSubject,
    phaseSubject: facts.releaseSubject,
    releaseIdentity: {
      commitSha: facts.commitSha,
      artifactDigest: facts.releaseSubject.type === 'artifact_digest' ? facts.releaseSubject.value : null,
      deploymentId: facts.releaseSubject.type === 'deployment_id' ? facts.releaseSubject.value : null,
    },
    classification: 'memory_closeout',
    status: 'passed',
    trustLevel: 'host_observed',
    confidence: 1,
    excerpt: `${uniqueIds.length} reviewable Learn candidates staged from ${authoritativeEvidence.length} verified evidence records.`,
    rawReference: null,
    provenanceChain: [{
      system: 'rorca:learn-closeout',
      eventId: `run:${facts.runId}`,
      observedAt: facts.closedAt,
      verification: LEARN_CLOSEOUT_VERSION,
    }],
    details: {
      candidateIds: uniqueIds,
      sourceEvidenceIds: sourceIds(authoritativeEvidence),
      acceptedCloseoutCount: facts.acceptedCloseoutCount,
      defaultRetrievalEligible: false,
    },
  });
  await persistCanonicalEvidence(closeoutEvidence);
  await updateRunCloseout(input.runId, 'generated', null, { candidateIds: uniqueIds, evidence: authoritativeEvidence.length });
  return {
    status: 'generated', workspaceId: facts.workspaceId, specId: facts.specId, runId: facts.runId,
    candidateIds: uniqueIds, candidateCount: uniqueIds.length, deduplicatedCount: summarized.candidates.length - inserted,
    sourceEvidenceCount: authoritativeEvidence.length,
    modelSummary: { requested: Boolean(input.modelSummarization), applied: summarized.applied, blocker: summarized.blocker },
    blocker: null,
  };
}

/** Worker seam: learning failure never rewrites the already-terminal delivery outcome. */
export async function tryGenerateLearnCloseoutCandidates(input: { workspaceId: string; runId: number; specId?: string }): Promise<LearnCloseoutResult | null> {
  try {
    return await generateLearnCloseoutCandidates(input);
  } catch (error) {
    const blocker = {
      code: 'retryable_generation_failure',
      retryable: true,
      message: error instanceof Error ? error.message.slice(0, 500) : 'Learn closeout generation failed.',
    };
    try { await updateRunCloseout(input.runId, 'blocked', blocker, { candidateIds: [], evidence: 0 }); } catch { /* preserve terminal run outcome */ }
    logger.warn({ error, ...input }, '[learn-closeout] generation blocked; terminal run outcome is unchanged');
    return null;
  }
}
