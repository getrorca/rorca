/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { transaction } from '../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';

export const BOUNTY_LESSON_SANITIZATION_POLICY = 'bounty.lesson-sanitization.v1' as const;
export const BOUNTY_REFLECTION_KINDS = ['false-positive', 'rejection', 'duplicate', 'dead-gadget', 'disclosure'] as const;
export type BountyReflectionKind = typeof BOUNTY_REFLECTION_KINDS[number];
export type BountyReflectionBoundary = 'route' | 'candidate-admission';
export type BountyReflectionReasonCode =
  | 'REFLECTION_ROUTE_CLEAR' | 'REFLECTION_CANDIDATE_CLEAR'
  | 'REFLECTION_FALSE_POSITIVE' | 'REFLECTION_REJECTED' | 'REFLECTION_DUPLICATE'
  | 'REFLECTION_DEAD_GADGET' | 'REFLECTION_ALREADY_DISCLOSED';

export interface GeneralizedLessonDraft {
  category: 'Architecture' | 'Convention' | 'Bug Fix' | 'Decision' | 'Pattern' | 'Gotcha';
  title: string;
  rule: string;
  context: string;
}
export interface LessonRedaction {
  field: keyof GeneralizedLessonDraft;
  reasonCode: 'EXCLUDED_CREDENTIAL' | 'EXCLUDED_TARGET_CONTENT' | 'EXCLUDED_SENSITIVE_EVIDENCE' | 'EXCLUDED_IDENTIFIER';
  replacements: number;
}
export interface LessonRedactionManifest {
  policyVersion: typeof BOUNTY_LESSON_SANITIZATION_POLICY;
  defaultExclusions: ['credential', 'target-content', 'sensitive-evidence', 'identifier'];
  redactions: LessonRedaction[];
}
export interface SanitizedLessonCandidate {
  bytes: Buffer;
  hash: string;
  value: GeneralizedLessonDraft;
  redactionManifest: LessonRedactionManifest;
  redactionManifestHash: string;
}
export interface BountyReflectionCheck {
  checkId: string;
  boundary: BountyReflectionBoundary;
  decision: 'allow' | 'block';
  reasonCodes: BountyReflectionReasonCode[];
  matchedReflectionIds: string[];
}
interface ReflectionMatch { id: string; reflection_kind: BountyReflectionKind }

const HASH = /^sha256:[0-9a-f]{64}$/;
const reasonForKind: Record<BountyReflectionKind, BountyReflectionReasonCode> = {
  'false-positive': 'REFLECTION_FALSE_POSITIVE',
  rejection: 'REFLECTION_REJECTED',
  duplicate: 'REFLECTION_DUPLICATE',
  'dead-gadget': 'REFLECTION_DEAD_GADGET',
  disclosure: 'REFLECTION_ALREADY_DISCLOSED',
};
const patterns: Array<{ reasonCode: LessonRedaction['reasonCode']; expression: RegExp; replacement: string }> = [
  {
    reasonCode: 'EXCLUDED_CREDENTIAL',
    expression: /(?:authorization\s*:\s*bearer\s+[^\s,;]+|(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*[^\s,;]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/gi,
    replacement: '[REDACTED_CREDENTIAL]',
  },
  {
    reasonCode: 'EXCLUDED_TARGET_CONTENT',
    expression: /(?:https?:\/\/[^\s,;]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|test|local)\b|\b(?:\d{1,3}\.){3}\d{1,3}\b)/gi,
    replacement: '[REDACTED_TARGET]',
  },
  {
    reasonCode: 'EXCLUDED_SENSITIVE_EVIDENCE',
    expression: /\b(?:request|response|evidence|proof)[-_ ]?(?:body|content|payload|id)\s*[:=]\s*[^\n,;]+/gi,
    replacement: '[REDACTED_EVIDENCE]',
  },
  {
    reasonCode: 'EXCLUDED_IDENTIFIER',
    expression: /(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:account|user|mission|program|finding|target)[-_ ]?id\s*[:=]\s*[A-Za-z0-9._:/-]+)/gi,
    replacement: '[REDACTED_IDENTIFIER]',
  },
];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
function exactHash(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function required(value: string, name: string, max = 10_000): string {
  const clean = value.trim();
  if (!clean || clean.length > max) throw new ValidationError(`${name} is required and must be at most ${max} characters`);
  return clean;
}
function hashes(values: readonly string[]): string[] {
  const result = [...new Set(values)].sort();
  if (!result.length || result.some((value) => !HASH.test(value))) throw new ValidationError('Reflection fingerprints must be non-empty sha256 hashes');
  return result;
}

/** Candidate bytes are canonical sanitized fields only; raw closeout text never enters them. */
export function sanitizeBountyLessonDraft(draft: GeneralizedLessonDraft): SanitizedLessonCandidate {
  const value: GeneralizedLessonDraft = {
    category: draft.category,
    title: required(draft.title, 'title', 240),
    rule: required(draft.rule, 'rule', 4_000),
    context: required(draft.context, 'context', 8_000),
  };
  const redactions: LessonRedaction[] = [];
  for (const field of ['title', 'rule', 'context'] as const) {
    for (const pattern of patterns) {
      let replacements = 0;
      value[field] = value[field].replace(pattern.expression, () => {
        replacements += 1;
        return pattern.replacement;
      });
      if (replacements) redactions.push({ field, reasonCode: pattern.reasonCode, replacements });
    }
  }
  const redactionManifest: LessonRedactionManifest = {
    policyVersion: BOUNTY_LESSON_SANITIZATION_POLICY,
    defaultExclusions: ['credential', 'target-content', 'sensitive-evidence', 'identifier'],
    redactions,
  };
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  return { bytes, hash: exactHash(bytes), value, redactionManifest, redactionManifestHash: exactHash(canonicalJson(redactionManifest)) };
}

/** Bounty observations may only enter the pending-candidate review path. */
export function assertBountyDirectAutoMemoryForbidden(identity: { workspaceId: string; programId?: string; missionId?: string; findingId?: string }): never {
  if (!identity.workspaceId || !identity.programId && !identity.missionId && !identity.findingId) throw new ValidationError('A bounty identity is required');
  throw new ForbiddenError('Direct auto-memory is forbidden for bounty identities', { reasonCodes: ['BOUNTY_DIRECT_AUTO_MEMORY_FORBIDDEN'] });
}

export function evaluateBountyReflectionMatches(boundary: BountyReflectionBoundary, matches: readonly ReflectionMatch[]): Omit<BountyReflectionCheck, 'checkId'> {
  const reasonCodes = [...new Set(matches.map((match) => reasonForKind[match.reflection_kind]))].sort() as BountyReflectionReasonCode[];
  return {
    boundary,
    decision: matches.length ? 'block' : 'allow',
    reasonCodes: matches.length ? reasonCodes : [boundary === 'route' ? 'REFLECTION_ROUTE_CLEAR' : 'REFLECTION_CANDIDATE_CLEAR'],
    matchedReflectionIds: [...new Set(matches.map((match) => match.id))].sort(),
  };
}

async function checkReflection(
  client: PoolClient,
  input: { workspaceId: string; programId: string; missionId: string; boundary: BountyReflectionBoundary; fingerprints: string[] },
): Promise<BountyReflectionCheck> {
  const checked = hashes(input.fingerprints);
  const authority = await client.query(
    `SELECT 1 FROM bounty_programs p JOIN bounty_missions m
       ON m.workspace_id=p.workspace_id AND m.program_id=p.id
     WHERE p.workspace_id=$1 AND p.id=$2 AND m.id=$3 FOR UPDATE OF p`,
    [input.workspaceId, input.programId, input.missionId],
  );
  if (!authority.rowCount) throw new NotFoundError('Bounty program mission');
  const matches = await client.query<ReflectionMatch>(
    `SELECT id,reflection_kind FROM bounty_program_reflections
     WHERE workspace_id=$1 AND program_id=$2 AND subject_fingerprint=ANY($3::text[])
     ORDER BY reflection_kind,id`,
    [input.workspaceId, input.programId, checked],
  );
  const decision = evaluateBountyReflectionMatches(input.boundary, matches.rows);
  const checkId = randomUUID();
  const subjectHash = exactHash(canonicalJson({ boundary: input.boundary, fingerprints: checked }));
  await client.query(
    `INSERT INTO bounty_reflection_checks
     (id,workspace_id,program_id,mission_id,boundary,subject_hash,checked_fingerprints,matched_reflection_ids,decision,reason_codes)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [checkId, input.workspaceId, input.programId, input.missionId, input.boundary, subjectHash, checked, decision.matchedReflectionIds, decision.decision, decision.reasonCodes],
  );
  return { checkId, ...decision };
}

/** Durable reflection gate called before deterministic work-package routing. */
export async function checkBountyReflectionBeforeRoute(input: {
  workspaceId: string; missionId: string; fingerprints: string[];
}): Promise<BountyReflectionCheck> {
  return transaction(async (client) => {
    const mission = await client.query<{ program_id: string }>(
      'SELECT program_id FROM bounty_missions WHERE workspace_id=$1 AND id=$2',
      [input.workspaceId, input.missionId],
    );
    if (!mission.rows[0]) throw new NotFoundError('Bounty mission');
    return checkReflection(client, { ...input, programId: mission.rows[0].program_id, boundary: 'route' });
  });
}

export async function recordBountyProgramReflection(input: {
  workspaceId: string; programId: string; sourceMissionId: string; kind: BountyReflectionKind;
  subjectFingerprint: string; observation: string; actor: string;
}): Promise<{ id: string; observationHash: string; reasonCode: BountyReflectionReasonCode; replayed: boolean }> {
  required(input.workspaceId, 'workspaceId', 128); required(input.programId, 'programId', 128);
  required(input.sourceMissionId, 'sourceMissionId', 128); required(input.actor, 'actor', 256);
  const observation = Buffer.from(required(input.observation, 'observation', 1_000_000), 'utf8');
  const fingerprint = hashes([input.subjectFingerprint])[0];
  const observationHash = exactHash(observation);
  const reasonCode = reasonForKind[input.kind];
  return transaction(async (client) => {
    const authority = await client.query(
      `SELECT 1 FROM bounty_programs p JOIN bounty_missions m
         ON m.workspace_id=p.workspace_id AND m.program_id=p.id
       WHERE p.workspace_id=$1 AND p.id=$2 AND m.id=$3 FOR UPDATE OF p`,
      [input.workspaceId, input.programId, input.sourceMissionId],
    );
    if (!authority.rowCount) throw new NotFoundError('Bounty program mission');
    const existing = await client.query<{ id: string; observation_hash: string }>(
      `SELECT id,observation_hash FROM bounty_program_reflections
       WHERE workspace_id=$1 AND program_id=$2 AND reflection_kind=$3 AND subject_fingerprint=$4`,
      [input.workspaceId, input.programId, input.kind, fingerprint],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].observation_hash !== observationHash) throw new ConflictError('Reflection fingerprint replay changed observation bytes');
      return { id: existing.rows[0].id, observationHash, reasonCode, replayed: true };
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO bounty_program_reflections
       (id,workspace_id,program_id,source_mission_id,reflection_kind,subject_fingerprint,observation_bytes,observation_hash,reason_code,recorded_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, input.workspaceId, input.programId, input.sourceMissionId, input.kind, fingerprint, observation, observationHash, reasonCode, input.actor],
    );
    return { id, observationHash, reasonCode, replayed: false };
  });
}

export async function recordBountyMissionCloseout(input: {
  workspaceId: string; programId: string; missionId: string; closeout: unknown; actor: string;
}): Promise<{ id: string; closeoutHash: string; replayed: boolean }> {
  required(input.actor, 'actor', 256);
  const bytes = Buffer.from(canonicalJson(input.closeout), 'utf8');
  if (bytes.length < 1 || bytes.length > 1_000_000) throw new ValidationError('closeout must contain at most 1000000 bytes');
  const closeoutHash = exactHash(bytes);
  return transaction(async (client) => {
    const mission = await client.query('SELECT 1 FROM bounty_missions WHERE workspace_id=$1 AND program_id=$2 AND id=$3', [input.workspaceId, input.programId, input.missionId]);
    if (!mission.rowCount) throw new NotFoundError('Bounty program mission');
    const existing = await client.query<{ id: string }>('SELECT id FROM bounty_mission_closeouts WHERE workspace_id=$1 AND mission_id=$2 AND closeout_hash=$3', [input.workspaceId, input.missionId, closeoutHash]);
    if (existing.rows[0]) return { id: existing.rows[0].id, closeoutHash, replayed: true };
    const id = randomUUID();
    await client.query(
      `INSERT INTO bounty_mission_closeouts(id,workspace_id,program_id,mission_id,closeout_bytes,closeout_hash,closed_by)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.workspaceId, input.programId, input.missionId, bytes, closeoutHash, input.actor],
    );
    return { id, closeoutHash, replayed: false };
  });
}

interface CandidateRevisionRow {
  id: string; lineage_id: string; program_id: string; source_mission_id: string; source_closeout_id: string;
  closeout_hash: string; revision: string; candidate_hash: string; redaction_manifest_hash: string;
  candidate_bytes: Buffer; redaction_manifest: LessonRedactionManifest;
}
async function loadCandidateRevision(client: PoolClient, workspaceId: string, lineageId: string, revision?: number): Promise<CandidateRevisionRow> {
  const result = await client.query<CandidateRevisionRow>(
    `SELECT r.id,r.lineage_id,r.program_id,l.source_mission_id,l.source_closeout_id,c.closeout_hash,
            r.revision,r.candidate_hash,r.redaction_manifest_hash,r.candidate_bytes,r.redaction_manifest
     FROM bounty_lesson_candidate_revisions r
     JOIN bounty_lesson_candidate_lineages l ON l.workspace_id=r.workspace_id AND l.id=r.lineage_id
     JOIN bounty_mission_closeouts c ON c.workspace_id=l.workspace_id AND c.id=l.source_closeout_id
     WHERE r.workspace_id=$1 AND r.lineage_id=$2 AND ($3::bigint IS NULL OR r.revision=$3)
     ORDER BY r.revision DESC LIMIT 1`,
    [workspaceId, lineageId, revision ?? null],
  );
  if (!result.rows[0]) throw new NotFoundError('Bounty lesson candidate');
  return result.rows[0];
}

export async function createBountyLessonCandidate(input: {
  workspaceId: string; sourceCloseoutId: string; draft: GeneralizedLessonDraft;
  subjectFingerprints: string[]; actor: string;
}): Promise<{ lineageId: string; revisionId: string; revision: number; candidateHash: string; redactionManifest: LessonRedactionManifest; redactionManifestHash: string; sourceCloseoutHash: string; reflectionCheck: BountyReflectionCheck; replayed: boolean }> {
  required(input.actor, 'actor', 256);
  const candidate = sanitizeBountyLessonDraft(input.draft);
  const outcome = await transaction(async (client): Promise<
    | { blocked: BountyReflectionCheck }
    | { created: { lineageId: string; revisionId: string; revision: number; candidateHash: string; redactionManifest: LessonRedactionManifest; redactionManifestHash: string; sourceCloseoutHash: string; reflectionCheck: BountyReflectionCheck; replayed: boolean } }
  > => {
    const closeout = await client.query<{ program_id: string; mission_id: string; closeout_hash: string }>(
      'SELECT program_id,mission_id,closeout_hash FROM bounty_mission_closeouts WHERE workspace_id=$1 AND id=$2',
      [input.workspaceId, input.sourceCloseoutId],
    );
    if (!closeout.rows[0]) throw new NotFoundError('Bounty mission closeout');
    const source = closeout.rows[0];
    const reflectionCheck = await checkReflection(client, {
      workspaceId: input.workspaceId, programId: source.program_id, missionId: source.mission_id,
      boundary: 'candidate-admission', fingerprints: [...input.subjectFingerprints, candidate.hash],
    });
    if (reflectionCheck.decision === 'block') return { blocked: reflectionCheck };
    const duplicate = await client.query<{ id: string; lineage_id: string; revision: string }>(
      `SELECT id,lineage_id,revision FROM bounty_lesson_candidate_revisions
       WHERE workspace_id=$1 AND program_id=$2 AND candidate_hash=$3`,
      [input.workspaceId, source.program_id, candidate.hash],
    );
    if (duplicate.rows[0]) return { created: {
      lineageId: duplicate.rows[0].lineage_id, revisionId: duplicate.rows[0].id, revision: Number(duplicate.rows[0].revision),
      candidateHash: candidate.hash, redactionManifest: candidate.redactionManifest, redactionManifestHash: candidate.redactionManifestHash,
      sourceCloseoutHash: source.closeout_hash, reflectionCheck, replayed: true,
    } };
    const lineageId = randomUUID(); const revisionId = randomUUID();
    await client.query(
      `INSERT INTO bounty_lesson_candidate_lineages(id,workspace_id,program_id,source_mission_id,source_closeout_id,created_by)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [lineageId, input.workspaceId, source.program_id, source.mission_id, input.sourceCloseoutId, input.actor],
    );
    await client.query(
      `INSERT INTO bounty_lesson_candidate_revisions
       (id,workspace_id,program_id,lineage_id,revision,candidate_bytes,candidate_hash,redaction_manifest,redaction_manifest_hash,edit_reason,created_by)
       VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'initial sanitized closeout candidate',$9)`,
      [revisionId, input.workspaceId, source.program_id, lineageId, candidate.bytes, candidate.hash, candidate.redactionManifest, candidate.redactionManifestHash, input.actor],
    );
    return { created: { lineageId, revisionId, revision: 1, candidateHash: candidate.hash, redactionManifest: candidate.redactionManifest,
      redactionManifestHash: candidate.redactionManifestHash, sourceCloseoutHash: source.closeout_hash, reflectionCheck, replayed: false } };
  });
  if ('blocked' in outcome) throw new ForbiddenError('Program reflection blocked lesson candidate admission', { reflectionCheck: outcome.blocked });
  return outcome.created;
}

/** Any edit, including a rejected-candidate revisit, creates immutable new bytes. */
export async function reviseBountyLessonCandidate(input: {
  workspaceId: string; lineageId: string; draft: GeneralizedLessonDraft; editReason: string; actor: string;
}): Promise<{ revisionId: string; revision: number; candidateHash: string; redactionManifest: LessonRedactionManifest; redactionManifestHash: string; sourceCloseoutHash: string; reflectionCheck: BountyReflectionCheck; replayed: boolean }> {
  required(input.editReason, 'editReason', 1_000); required(input.actor, 'actor', 256);
  const candidate = sanitizeBountyLessonDraft(input.draft);
  const outcome = await transaction(async (client): Promise<
    | { blocked: BountyReflectionCheck }
    | { revised: { revisionId: string; revision: number; candidateHash: string; redactionManifest: LessonRedactionManifest; redactionManifestHash: string; sourceCloseoutHash: string; reflectionCheck: BountyReflectionCheck; replayed: boolean } }
  > => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-lesson-revision:${input.workspaceId}:${input.lineageId}`]);
    const current = await loadCandidateRevision(client, input.workspaceId, input.lineageId);
    const reflectionCheck = await checkReflection(client, {
      workspaceId: input.workspaceId, programId: current.program_id, missionId: current.source_mission_id,
      boundary: 'candidate-admission', fingerprints: [candidate.hash],
    });
    if (reflectionCheck.decision === 'block') return { blocked: reflectionCheck };
    const duplicate = await client.query<{ id: string; revision: string }>(
      'SELECT id,revision FROM bounty_lesson_candidate_revisions WHERE workspace_id=$1 AND program_id=$2 AND candidate_hash=$3',
      [input.workspaceId, current.program_id, candidate.hash],
    );
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].id !== current.id) throw new ConflictError('Edited candidate duplicates an existing program candidate');
      return { revised: { revisionId: current.id, revision: Number(current.revision), candidateHash: candidate.hash, redactionManifest: candidate.redactionManifest,
        redactionManifestHash: candidate.redactionManifestHash, sourceCloseoutHash: current.closeout_hash, reflectionCheck, replayed: true } };
    }
    const revision = Number(current.revision) + 1; const revisionId = randomUUID();
    await client.query(
      `INSERT INTO bounty_lesson_candidate_revisions
       (id,workspace_id,program_id,lineage_id,revision,candidate_bytes,candidate_hash,redaction_manifest,redaction_manifest_hash,edit_reason,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [revisionId, input.workspaceId, current.program_id, input.lineageId, revision, candidate.bytes, candidate.hash,
        candidate.redactionManifest, candidate.redactionManifestHash, input.editReason, input.actor],
    );
    return { revised: { revisionId, revision, candidateHash: candidate.hash, redactionManifest: candidate.redactionManifest,
      redactionManifestHash: candidate.redactionManifestHash, sourceCloseoutHash: current.closeout_hash, reflectionCheck, replayed: false } };
  });
  if ('blocked' in outcome) throw new ForbiddenError('Program reflection blocked lesson candidate revision admission', { reflectionCheck: outcome.blocked });
  return outcome.revised;
}

/** Explicit operator review surface; this is not memory or mission retrieval. */
export async function getBountyLessonCandidateForReview(input: { workspaceId: string; lineageId: string; revision?: number }): Promise<{
  lineageId: string; revisionId: string; revision: number; candidateBytes: string; candidateHash: string;
  redactionManifest: LessonRedactionManifest; redactionManifestHash: string; sourceCloseoutHash: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
}> {
  return transaction(async (client) => {
    const candidate = await loadCandidateRevision(client, input.workspaceId, input.lineageId, input.revision);
    const review = await client.query<{ decision: 'approved' | 'rejected' }>(
      'SELECT decision FROM bounty_lesson_candidate_reviews WHERE workspace_id=$1 AND candidate_revision_id=$2',
      [input.workspaceId, candidate.id],
    );
    return {
      lineageId: candidate.lineage_id, revisionId: candidate.id, revision: Number(candidate.revision),
      candidateBytes: candidate.candidate_bytes.toString('utf8'), candidateHash: candidate.candidate_hash,
      redactionManifest: candidate.redaction_manifest, redactionManifestHash: candidate.redaction_manifest_hash,
      sourceCloseoutHash: candidate.closeout_hash, reviewStatus: review.rows[0]?.decision ?? 'pending',
    };
  });
}

export async function reviewBountyLessonCandidate(input: {
  workspaceId: string; lineageId: string; revision: number; expectedCandidateHash: string;
  expectedRedactionManifestHash: string; expectedSourceCloseoutHash: string;
  reviewer: string; decision: 'approved' | 'rejected'; reason: string;
}): Promise<{ reviewId: string; exactReviewHash: string; decision: 'approved' | 'rejected'; lessonHash?: string; replayed: boolean }> {
  required(input.reviewer, 'reviewer', 256); required(input.reason, 'reason', 2_000);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || ![input.expectedCandidateHash, input.expectedRedactionManifestHash, input.expectedSourceCloseoutHash].every((value) => HASH.test(value))) throw new ValidationError('Exact candidate review hashes or revision are invalid');
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-lesson-review:${input.workspaceId}:${input.lineageId}:${input.revision}`]);
    const candidate = await loadCandidateRevision(client, input.workspaceId, input.lineageId, input.revision);
    if (candidate.candidate_hash !== input.expectedCandidateHash || candidate.redaction_manifest_hash !== input.expectedRedactionManifestHash || candidate.closeout_hash !== input.expectedSourceCloseoutHash) {
      throw new ConflictError('Exact review does not bind current candidate bytes, redaction manifest, and source closeout');
    }
    const exactReviewHash = exactHash(canonicalJson({
      candidateHash: candidate.candidate_hash, redactionManifestHash: candidate.redaction_manifest_hash,
      sourceCloseoutHash: candidate.closeout_hash, reviewer: input.reviewer, decision: input.decision, reason: input.reason,
    }));
    const existing = await client.query<{ id: string; exact_review_hash: string; decision: 'approved' | 'rejected' }>(
      'SELECT id,exact_review_hash,decision FROM bounty_lesson_candidate_reviews WHERE workspace_id=$1 AND candidate_revision_id=$2',
      [input.workspaceId, candidate.id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].exact_review_hash !== exactReviewHash) throw new ConflictError('Candidate revision already has a different exact review');
      const lesson = await client.query<{ lesson_hash: string }>('SELECT lesson_hash FROM bounty_generalized_lessons WHERE workspace_id=$1 AND candidate_revision_id=$2', [input.workspaceId, candidate.id]);
      return { reviewId: existing.rows[0].id, exactReviewHash, decision: existing.rows[0].decision, lessonHash: lesson.rows[0]?.lesson_hash, replayed: true };
    }
    const reviewId = randomUUID();
    await client.query(
      `INSERT INTO bounty_lesson_candidate_reviews
       (id,workspace_id,candidate_revision_id,candidate_hash,redaction_manifest_hash,source_closeout_hash,reviewer,decision,review_reason,exact_review_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [reviewId, input.workspaceId, candidate.id, candidate.candidate_hash, candidate.redaction_manifest_hash, candidate.closeout_hash, input.reviewer, input.decision, input.reason, exactReviewHash],
    );
    if (input.decision === 'rejected') return { reviewId, exactReviewHash, decision: input.decision, replayed: false };
    const lessonId = randomUUID();
    await client.query(
      `INSERT INTO bounty_generalized_lessons
       (id,workspace_id,source_program_id,source_mission_id,candidate_revision_id,lesson_bytes,lesson_hash,exact_review_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [lessonId, input.workspaceId, candidate.program_id, candidate.source_mission_id, candidate.id, candidate.candidate_bytes, candidate.candidate_hash, exactReviewHash],
    );
    return { reviewId, exactReviewHash, decision: input.decision, lessonHash: candidate.candidate_hash, replayed: false };
  });
}

export async function pinBountyLessonsForMission(input: {
  workspaceId: string; missionId: string; lessonHashes: string[]; actor: string;
}): Promise<{ missionId: string; lessonHashes: string[] }> {
  required(input.actor, 'actor', 256);
  const requested = hashes(input.lessonHashes);
  return transaction(async (client) => {
    const target = await client.query<{ created_at: Date; state: string }>('SELECT created_at,state FROM bounty_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [input.workspaceId, input.missionId]);
    if (!target.rows[0]) throw new NotFoundError('Bounty mission');
    const lessons = await client.query<{ id: string; lesson_hash: string; source_mission_id: string; source_created_at: Date }>(
      `SELECT l.id,l.lesson_hash,l.source_mission_id,m.created_at AS source_created_at
       FROM bounty_generalized_lessons l JOIN bounty_missions m ON m.workspace_id=l.workspace_id AND m.id=l.source_mission_id
       WHERE l.workspace_id=$1 AND l.lesson_hash=ANY($2::text[]) ORDER BY l.lesson_hash`,
      [input.workspaceId, requested],
    );
    if (lessons.rows.length !== requested.length) throw new NotFoundError('One or more exact generalized lesson hashes');
    for (const lesson of lessons.rows) {
      if (lesson.source_mission_id === input.missionId || target.rows[0].created_at <= lesson.source_created_at || target.rows[0].state !== 'draft') throw new ForbiddenError('Same-mission hot loading is forbidden; only later draft missions may pin lessons', { reasonCodes: ['LESSON_SAME_MISSION_HOT_LOAD_FORBIDDEN'] });
      await client.query(
        `INSERT INTO bounty_mission_lesson_pins(id,workspace_id,mission_id,lesson_id,lesson_hash,pinned_by)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,mission_id,lesson_hash) DO NOTHING`,
        [randomUUID(), input.workspaceId, input.missionId, lesson.id, lesson.lesson_hash, input.actor],
      );
    }
    return { missionId: input.missionId, lessonHashes: requested };
  });
}

/** Retrieval surface: pending/rejected candidates are structurally absent. */
export async function loadPinnedBountyLessons(input: { workspaceId: string; missionId: string }): Promise<Array<{ lessonHash: string; lesson: GeneralizedLessonDraft; sourceProgramId: string; exactReviewHash: string }>> {
  return transaction(async (client) => {
    const rows = await client.query<{ lesson_hash: string; lesson_bytes: Buffer; source_program_id: string; source_mission_id: string; exact_review_hash: string }>(
      `SELECT lesson_hash,lesson_bytes,source_program_id,source_mission_id,exact_review_hash
       FROM bounty_pinned_generalized_lessons WHERE workspace_id=$1 AND mission_id=$2 ORDER BY lesson_hash`,
      [input.workspaceId, input.missionId],
    );
    if (rows.rows.some((row) => row.source_mission_id === input.missionId)) throw new ForbiddenError('Same-mission hot loading is forbidden');
    return rows.rows.map((row) => ({ lessonHash: row.lesson_hash, lesson: JSON.parse(row.lesson_bytes.toString('utf8')) as GeneralizedLessonDraft, sourceProgramId: row.source_program_id, exactReviewHash: row.exact_review_hash }));
  });
}
