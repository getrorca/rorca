/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * LFC-010: deterministic reconciliation of the approved-spec pass projection.
 *
 * `passes` remains a projection in the approved JSON file. Accepted story
 * closeout decisions, their immutable manifests/attempts, scoped results, and
 * story commits remain the evidence. Progress Markdown is reported only as
 * supporting resume context and never grants pass authority.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PoolClient } from 'pg';
import { transaction } from '../db/index';
import { markStoriesPassed, writeApprovedSpecAtomically } from './approved-spec-pass-store';
import { deriveStoryContractRevision } from './story-execution-packet';

export type PassReconciliationStatus =
  | 'consistent-passed'
  | 'consistent-not-passed'
  | 'safely-repairable'
  | 'ambiguous'
  | 'invalid';

export type PassReconciliationReasonCode =
  | 'PASS_EVIDENCE_CONSISTENT'
  | 'NO_PASS_EVIDENCE'
  | 'STALE_FALSE_PROVEN'
  | 'EXCLUDED_STORY'
  | 'MALFORMED_STORY'
  | 'DUPLICATE_STORY_ID'
  | 'DEPENDENCY_NOT_FOUND'
  | 'DEPENDENCY_CYCLE'
  | 'DEPENDENCY_INCONSISTENT'
  | 'MISSING_VALIDATED_PACKET'
  | 'MISSING_MATCHING_PASS_RESULT'
  | 'MISSING_COMMIT_EVIDENCE'
  | 'REVISION_MISMATCH'
  | 'CONTRADICTORY_RESULT'
  | 'STALE_TRUE_UNPROVEN';

export interface ApprovedSpecStory {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  acceptanceCriteria?: unknown;
  dependsOn?: unknown;
  passes?: unknown;
  excluded?: unknown;
  notes?: unknown;
  [key: string]: unknown;
}

export interface ApprovedSpecDocument {
  id?: unknown;
  specName?: unknown;
  userStories?: unknown;
  phases?: unknown;
  [key: string]: unknown;
}

export interface ReconciliationEvidenceRecord {
  storyId: string;
  resultId: number;
  runId: number;
  resultStatus: string;
  resultObservedAt: string;
  manifestHash: string | null;
  specRevision: string | null;
  storyRevision: string | null;
  decisionId: string | null;
  decisionStatus: string | null;
  attemptResultId: string | null;
  completionPacketPresent: boolean;
  completionPacketValidated: boolean;
  noCodeAllowed: boolean;
  commitReferences: string[];
  progressReference: string | null;
}

export interface ReconciliationOperatorAction {
  code:
    | 'FIX_SPEC_STORY'
    | 'FIX_DEPENDENCY_DAG'
    | 'RESTORE_VALIDATED_PACKET'
    | 'RECORD_MATCHING_RESULT'
    | 'RECORD_STORY_COMMIT_OR_NO_CODE_POLICY'
    | 'RECONCILE_STORY_REVISION'
    | 'RESOLVE_CONTRADICTORY_RESULT'
    | 'RESET_UNPROVEN_PASS_FLAG'
    | 'RECONCILE_DEPENDENCY';
  storyId: string;
  instruction: string;
}

export interface StoryPassReconciliation {
  storyId: string;
  status: PassReconciliationStatus;
  passBefore: boolean;
  passAfter: boolean;
  reasonCodes: PassReconciliationReasonCode[];
  evidenceReferences: string[];
  operatorActions: ReconciliationOperatorAction[];
}

export interface PassReconciliationReport {
  workspaceId: string;
  specId: string;
  specPath: string;
  specRevision: string;
  blocking: boolean;
  repairedStoryIds: string[];
  stories: StoryPassReconciliation[];
}

interface ClassificationInput {
  workspaceId: string;
  specId: string;
  specPath: string;
  spec: ApprovedSpecDocument;
  evidence: ReconciliationEvidenceRecord[];
}

interface ReconcilerQueryResult<T> {
  rows: T[];
}

export interface PassReconcilerClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<ReconcilerQueryResult<T>>;
}

export interface PassReconcilerDependencies {
  transaction<T>(fn: (client: PassReconcilerClient) => Promise<T>): Promise<T>;
  readFile(filePath: string): string;
  writeFileAtomically(filePath: string, content: string): void;
  fileExists(filePath: string): boolean;
}

interface EvidenceRow {
  story_id: string;
  result_id: number;
  run_id: number;
  result_status: string;
  result_observed_at: string | Date;
  completion_packet: unknown;
  manifest_hash: string | null;
  spec_revision: string | null;
  story_revision: string | null;
  manifest_payload: Record<string, unknown> | null;
  decision_id: string | null;
  decision_status: string | null;
  attempt_result_id: string | null;
  attempt_payload: Record<string, unknown> | null;
  commit_references: string[] | null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function storyList(spec: ApprovedSpecDocument): ApprovedSpecStory[] {
  if (Array.isArray(spec.userStories)) return spec.userStories as ApprovedSpecStory[];
  if (!Array.isArray(spec.phases)) return [];
  return (spec.phases as Array<{ stories?: unknown }>).flatMap((phase) =>
    Array.isArray(phase.stories) ? phase.stories as ApprovedSpecStory[] : []);
}

function storyId(story: ApprovedSpecStory): string | null {
  return typeof story.id === 'string' && story.id.trim() ? story.id.trim() : null;
}

function dependsOn(story: ApprovedSpecStory): string[] | null {
  if (story.dependsOn === undefined) return [];
  if (!Array.isArray(story.dependsOn) || story.dependsOn.some((item) => typeof item !== 'string' || !item.trim())) return null;
  return uniqueSorted(story.dependsOn.map((item) => String(item).trim()));
}

function isEngineCompletionNote(value: unknown): boolean {
  return value === 'Completed by Rorca engine' || value === 'Completed by Rorca pass reconciler';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePassProjection(spec: ApprovedSpecDocument, storyIds: ReadonlySet<string>): ApprovedSpecDocument {
  const normalized = clone(spec);
  for (const story of storyList(normalized)) {
    const id = storyId(story);
    if (!id || !storyIds.has(id)) continue;
    story.passes = false;
    if (isEngineCompletionNote(story.notes)) delete story.notes;
  }
  return normalized;
}

function normalizeStoryProjection(story: ApprovedSpecStory): ApprovedSpecStory {
  const normalized = clone(story);
  normalized.passes = false;
  if (isEngineCompletionNote(normalized.notes)) delete normalized.notes;
  return normalized;
}

function action(code: ReconciliationOperatorAction['code'], id: string, instruction: string): ReconciliationOperatorAction {
  return { code, storyId: id, instruction };
}

function evidenceRefs(records: readonly ReconciliationEvidenceRecord[]): string[] {
  const refs: string[] = [];
  for (const record of records) {
    refs.push(`story_result:${record.resultId}`);
    if (record.manifestHash) refs.push(`story_manifest:${record.manifestHash}`);
    if (record.attemptResultId) refs.push(`story_attempt_result:${record.attemptResultId}`);
    if (record.decisionId) refs.push(`story_closeout_decision:${record.decisionId}`);
    refs.push(...record.commitReferences);
    if (record.progressReference) refs.push(`progress:${record.progressReference}`);
  }
  return uniqueSorted(refs);
}

function recordMatchesCurrentRevision(
  record: ReconciliationEvidenceRecord,
  story: ApprovedSpecStory,
  spec: ApprovedSpecDocument,
  evidence: readonly ReconciliationEvidenceRecord[],
): boolean {
  if (!record.storyRevision || !record.specRevision) return false;
  const exactStory = deriveStoryContractRevision(story);
  const projectedStory = deriveStoryContractRevision(normalizeStoryProjection(story));
  if (record.storyRevision !== exactStory && record.storyRevision !== projectedStory) return false;

  if (record.specRevision === deriveStoryContractRevision(spec)) return true;
  // Reconstruct only the pass projections produced from the same immutable
  // spec revision. Stories that were already true before that run are not
  // touched unless they also have an accepted closeout for this revision.
  const acceptedIds = new Set<string>();
  for (const candidate of evidence) {
    if (candidate.specRevision === record.specRevision && candidate.decisionStatus === 'accepted') {
      acceptedIds.add(candidate.storyId);
    }
  }
  const currentId = storyId(story);
  if (currentId) acceptedIds.add(currentId);
  return record.specRevision === deriveStoryContractRevision(normalizePassProjection(spec, acceptedIds));
}

function classifyBaseStory(
  story: ApprovedSpecStory,
  spec: ApprovedSpecDocument,
  allEvidence: readonly ReconciliationEvidenceRecord[],
  records: readonly ReconciliationEvidenceRecord[],
): StoryPassReconciliation {
  const id = storyId(story) ?? '<invalid-story>';
  const passBefore = story.passes === true;
  const refs = evidenceRefs(records);
  const result = (
    status: PassReconciliationStatus,
    reasonCodes: PassReconciliationReasonCode[],
    operatorActions: ReconciliationOperatorAction[] = [],
  ): StoryPassReconciliation => ({
    storyId: id,
    status,
    passBefore,
    passAfter: passBefore,
    reasonCodes: uniqueSorted(reasonCodes) as PassReconciliationReasonCode[],
    evidenceReferences: refs,
    operatorActions,
  });

  if (!storyId(story) || dependsOn(story) === null || (story.passes !== undefined && typeof story.passes !== 'boolean')) {
    return result('invalid', ['MALFORMED_STORY'], [
      action('FIX_SPEC_STORY', id, `Give ${id} a unique string id, boolean passes flag, and string-array dependsOn field.`),
    ]);
  }
  if (story.excluded === true) return result('consistent-not-passed', ['EXCLUDED_STORY']);

  const matchingRevision = records.filter((record) => recordMatchesCurrentRevision(record, story, spec, allEvidence));
  const acceptedPasses = matchingRevision.filter((record) =>
    record.resultStatus === 'pass'
    && record.decisionStatus === 'accepted'
    && record.completionPacketPresent
    && record.completionPacketValidated
    && (record.noCodeAllowed || record.commitReferences.length > 0));
  const newestAcceptedAt = acceptedPasses.reduce((latest, record) =>
    Math.max(latest, new Date(record.resultObservedAt).getTime()), -Infinity);
  const contradictory = matchingRevision.some((record) =>
    ['fail', 'skip', 'timeout'].includes(record.resultStatus)
    && new Date(record.resultObservedAt).getTime() >= newestAcceptedAt);

  if (acceptedPasses.length > 0 && !contradictory) {
    return passBefore
      ? result('consistent-passed', ['PASS_EVIDENCE_CONSISTENT'])
      : result('safely-repairable', ['STALE_FALSE_PROVEN']);
  }

  if (records.length === 0) {
    return passBefore
      ? result('ambiguous', ['STALE_TRUE_UNPROVEN', 'MISSING_VALIDATED_PACKET', 'MISSING_MATCHING_PASS_RESULT'], [
          action('RESET_UNPROVEN_PASS_FLAG', id, `Review ${id} and reset passes:false, or restore its version-matched closeout evidence before running.`),
        ])
      : result('consistent-not-passed', ['NO_PASS_EVIDENCE']);
  }

  // A current false flag plus only matching non-pass outcomes is internally
  // consistent. A completion packet is required to prove pass, not to preserve
  // a conservative non-pass projection.
  if (!passBefore
    && matchingRevision.length > 0
    && matchingRevision.every((record) => record.resultStatus !== 'pass')
    && !matchingRevision.some((record) => record.decisionStatus === 'accepted')) {
    return result('consistent-not-passed', ['NO_PASS_EVIDENCE']);
  }

  const reasons: PassReconciliationReasonCode[] = [];
  const actions: ReconciliationOperatorAction[] = [];
  if (matchingRevision.length === 0) {
    reasons.push('REVISION_MISMATCH');
    actions.push(action('RECONCILE_STORY_REVISION', id, `Restore evidence for the current ${id} and approved-spec revisions, or explicitly reset its lifecycle state.`));
  }
  if (!matchingRevision.some((record) => record.completionPacketPresent && record.completionPacketValidated && record.decisionStatus === 'accepted')) {
    reasons.push('MISSING_VALIDATED_PACKET');
    actions.push(action('RESTORE_VALIDATED_PACKET', id, `Run host closeout for ${id} and persist an accepted, revision-matched completion packet.`));
  }
  if (!matchingRevision.some((record) => record.resultStatus === 'pass')) {
    reasons.push('MISSING_MATCHING_PASS_RESULT');
    actions.push(action('RECORD_MATCHING_RESULT', id, `Record a pass result for the same run and immutable manifest as ${id}'s accepted packet.`));
  }
  const proofCandidates = matchingRevision.filter((record) => record.resultStatus === 'pass' && record.decisionStatus === 'accepted');
  if (proofCandidates.length > 0 && proofCandidates.every((record) => !record.noCodeAllowed && record.commitReferences.length === 0)) {
    reasons.push('MISSING_COMMIT_EVIDENCE');
    actions.push(action('RECORD_STORY_COMMIT_OR_NO_CODE_POLICY', id, `Attach a workspace/run/story-scoped commit for ${id}, or use an explicit no-code manifest policy.`));
  }
  if (contradictory) {
    reasons.push('CONTRADICTORY_RESULT');
    actions.push(action('RESOLVE_CONTRADICTORY_RESULT', id, `Resolve the later fail/skip/timeout result that contradicts ${id}'s accepted pass evidence.`));
  }
  if (passBefore) reasons.push('STALE_TRUE_UNPROVEN');
  return result('ambiguous', reasons.length > 0 ? reasons : ['STALE_TRUE_UNPROVEN'], actions);
}

function cycleMembers(stories: readonly ApprovedSpecStory[]): Set<string> {
  const graph = new Map<string, string[]>();
  for (const story of stories) {
    const id = storyId(story);
    const deps = dependsOn(story);
    if (id && deps) graph.set(id, deps);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      stack.slice(start).forEach((member) => cycles.add(member));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) if (graph.has(dependency)) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  graph.forEach((_deps, id) => visit(id));
  return cycles;
}

/** Side-effect-free deterministic classifier used by unit tests and the DB boundary. */
export function classifyPassReconciliation(input: ClassificationInput): PassReconciliationReport {
  const stories = storyList(input.spec);
  if (stories.length === 0) {
    return {
      workspaceId: input.workspaceId,
      specId: input.specId,
      specPath: input.specPath,
      specRevision: deriveStoryContractRevision(input.spec),
      blocking: true,
      repairedStoryIds: [],
      stories: [{
        storyId: '<spec>',
        status: 'invalid',
        passBefore: false,
        passAfter: false,
        reasonCodes: ['MALFORMED_STORY'],
        evidenceReferences: [],
        operatorActions: [action('FIX_SPEC_STORY', '<spec>', 'Add a non-empty userStories array or phase story list before scheduling.')],
      }],
    };
  }
  const ids = stories.map(storyId).filter((id): id is string => Boolean(id));
  const duplicateIds = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
  const existingIds = new Set(ids);
  const cycles = cycleMembers(stories);
  const evidenceByStory = new Map<string, ReconciliationEvidenceRecord[]>();
  for (const record of input.evidence) {
    if (!record.storyId) continue;
    evidenceByStory.set(record.storyId, [...(evidenceByStory.get(record.storyId) ?? []), record]);
  }

  const reports = stories.map((story) => {
    const id = storyId(story) ?? '<invalid-story>';
    let report = classifyBaseStory(story, input.spec, input.evidence, evidenceByStory.get(id) ?? []);
    if (duplicateIds.has(id)) {
      report = {
        ...report,
        status: 'invalid',
        reasonCodes: uniqueSorted([...report.reasonCodes, 'DUPLICATE_STORY_ID']) as PassReconciliationReasonCode[],
        operatorActions: [...report.operatorActions, action('FIX_SPEC_STORY', id, `Remove or rename duplicate story id ${id}.`)],
      };
    }
    const dependencies = dependsOn(story) ?? [];
    const missing = dependencies.filter((dependency) => !existingIds.has(dependency));
    if (missing.length > 0) {
      report = {
        ...report,
        status: 'invalid',
        reasonCodes: uniqueSorted([...report.reasonCodes, 'DEPENDENCY_NOT_FOUND']) as PassReconciliationReasonCode[],
        operatorActions: [...report.operatorActions, action('FIX_DEPENDENCY_DAG', id, `Replace missing dependencies for ${id}: ${missing.join(', ')}.`)],
      };
    }
    if (cycles.has(id)) {
      report = {
        ...report,
        status: 'invalid',
        reasonCodes: uniqueSorted([...report.reasonCodes, 'DEPENDENCY_CYCLE']) as PassReconciliationReasonCode[],
        operatorActions: [...report.operatorActions, action('FIX_DEPENDENCY_DAG', id, `Break the dependency cycle containing ${id}.`)],
      };
    }
    return report;
  });

  const byId = new Map(reports.map((report) => [report.storyId, report]));
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    if (!['consistent-passed', 'safely-repairable'].includes(report.status)) continue;
    const story = stories[index];
    const inconsistent = (dependsOn(story) ?? []).filter((dependency) => {
      const dependencyReport = byId.get(dependency);
      return !dependencyReport || !['consistent-passed', 'safely-repairable'].includes(dependencyReport.status);
    });
    if (inconsistent.length > 0) {
      reports[index] = {
        ...report,
        status: 'ambiguous',
        reasonCodes: uniqueSorted([...report.reasonCodes, 'DEPENDENCY_INCONSISTENT']) as PassReconciliationReasonCode[],
        operatorActions: [...report.operatorActions, action('RECONCILE_DEPENDENCY', report.storyId, `Reconcile dependencies ${inconsistent.join(', ')} before trusting ${report.storyId}.`)],
      };
    }
  }

  return {
    workspaceId: input.workspaceId,
    specId: input.specId,
    specPath: input.specPath,
    specRevision: deriveStoryContractRevision(input.spec),
    blocking: reports.some((report) => report.status === 'ambiguous' || report.status === 'invalid'),
    repairedStoryIds: [],
    stories: reports,
  };
}

function parsePacket(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mapEvidenceRow(row: EvidenceRow, workspacePath: string): ReconciliationEvidenceRecord {
  const manifestPayload = parsePacket(row.manifest_payload);
  const repositoryProfile = parsePacket(manifestPayload?.repositoryProfile);
  const attemptPayload = parsePacket(row.attempt_payload);
  const proposedPacket = parsePacket(attemptPayload?.proposedCompletionPacket);
  const resultPacket = parsePacket(row.completion_packet);
  const progressPath = typeof resultPacket?.progressLogPath === 'string' ? resultPacket.progressLogPath : null;
  const safeProgressPath = progressPath && path.resolve(progressPath).startsWith(`${path.resolve(workspacePath)}${path.sep}`)
    ? progressPath
    : null;
  return {
    storyId: row.story_id,
    resultId: Number(row.result_id),
    runId: Number(row.run_id),
    resultStatus: row.result_status,
    resultObservedAt: new Date(row.result_observed_at).toISOString(),
    manifestHash: row.manifest_hash,
    specRevision: row.spec_revision,
    storyRevision: row.story_revision,
    decisionId: row.decision_id,
    decisionStatus: row.decision_status,
    attemptResultId: row.attempt_result_id,
    completionPacketPresent: Boolean(proposedPacket),
    completionPacketValidated: row.decision_status === 'accepted'
      && (!resultPacket || resultPacket.status === undefined || resultPacket.status === 'validated'),
    noCodeAllowed: repositoryProfile?.changePolicy === 'no_code_allowed',
    commitReferences: (row.commit_references ?? []).map((sha) => `story_commit:${sha}`),
    progressReference: safeProgressPath,
  };
}

const DEFAULT_DEPENDENCIES: PassReconcilerDependencies = {
  transaction: (fn) => transaction((client: PoolClient) => fn(client as unknown as PassReconcilerClient)),
  readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  writeFileAtomically: writeApprovedSpecAtomically,
  fileExists: (filePath) => fs.existsSync(filePath),
};

function assertApprovedSpecPath(workspacePath: string, specPath: string): string {
  const workspaceRoot = path.resolve(workspacePath);
  const absolute = path.resolve(workspaceRoot, specPath);
  if (!absolute.startsWith(`${workspaceRoot}${path.sep}`) || !absolute.includes(`${path.sep}specs${path.sep}approved${path.sep}`)) {
    throw new TypeError('Pass reconciliation requires a workspace-scoped approved spec path');
  }
  return absolute;
}

/**
 * Transactional workspace-scoped reconciliation boundary. Advisory locking and
 * a final raw-content assertion make concurrent calls idempotent. Safe repairs
 * snapshot the approved file before one atomic overwrite and append one WAL row
 * per repaired story in the same transaction.
 */
export async function reconcileApprovedSpecPasses(
  input: { workspaceId: string; workspacePath: string; specPath: string },
  dependencies: PassReconcilerDependencies = DEFAULT_DEPENDENCIES,
): Promise<PassReconciliationReport> {
  if (!input.workspaceId.trim()) throw new TypeError('workspaceId is required');
  const absoluteSpecPath = assertApprovedSpecPath(input.workspacePath, input.specPath);
  if (!dependencies.fileExists(absoluteSpecPath)) throw new TypeError(`Approved spec not found: ${absoluteSpecPath}`);
  const specId = path.basename(input.specPath, '.json');

  return dependencies.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.workspaceId, specId]);
    const rawBefore = dependencies.readFile(absoluteSpecPath);
    const spec = JSON.parse(rawBefore) as ApprovedSpecDocument;

    // Results are read across runs, but only through workspace-scoped pipeline
    // runs and exact workspace/spec manifests. Copied retry rows therefore do
    // not acquire packet authority merely by saying "pass".
    const evidenceResult = await client.query<EvidenceRow>(`
      SELECT sr.story_id, sr.id AS result_id, sr.run_id, sr.status AS result_status,
             COALESCE(sr.created_at, sr.started_at) AS result_observed_at,
             sr.completion_packet,
             sem.manifest_hash, sem.spec_revision, sem.story_revision,
             sem.payload AS manifest_payload,
             scd.decision_id, scd.status AS decision_status,
             sar.attempt_result_id, sar.payload AS attempt_payload,
             COALESCE(commits.commit_references, ARRAY[]::text[]) AS commit_references
      FROM story_results sr
      JOIN pipeline_runs pr ON pr.id = sr.run_id AND pr.workspace_id = $1
      LEFT JOIN LATERAL (
        SELECT manifest_hash, spec_revision, story_revision, payload
        FROM story_execution_manifests
        WHERE workspace_id = $1 AND spec_id = $2
          AND run_id = sr.run_id AND story_id = sr.story_id
        ORDER BY attempt DESC, created_at DESC LIMIT 1
      ) sem ON TRUE
      LEFT JOIN LATERAL (
        SELECT decision_id, status, attempt_result_id
        FROM story_closeout_decisions
        WHERE workspace_id = $1 AND spec_id = $2
          AND run_id = sr.run_id AND story_id = sr.story_id
          AND manifest_hash = sem.manifest_hash
        ORDER BY attempt DESC, created_at DESC LIMIT 1
      ) scd ON TRUE
      LEFT JOIN story_attempt_results sar ON sar.attempt_result_id = scd.attempt_result_id
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(commit_sha ORDER BY pushed_at, id) AS commit_references
        FROM story_commits
        WHERE workspace_id = $1 AND spec_id = $2
          AND run_id = sr.run_id AND story_id = sr.story_id
      ) commits ON TRUE
      WHERE COALESCE(sr.spec_id, sem.payload->'identity'->>'specId') = $2
      ORDER BY COALESCE(sr.created_at, sr.started_at) DESC, sr.id DESC
    `, [input.workspaceId, specId]);
    const evidence = evidenceResult.rows.map((row) => mapEvidenceRow(row, input.workspacePath));
    let report = classifyPassReconciliation({
      workspaceId: input.workspaceId,
      specId,
      specPath: input.specPath,
      spec,
      evidence,
    });

    const repairable = report.stories.filter((story) => story.status === 'safely-repairable');
    if (repairable.length === 0) return report;
    if (dependencies.readFile(absoluteSpecPath) !== rawBefore) {
      throw new TypeError('Approved spec changed during pass reconciliation; retry with the current version');
    }

    const writeResult = await markStoriesPassed({
      client,
      workspaceId: input.workspaceId,
      specId,
      absoluteSpecPath,
      rawBefore,
      specBefore: spec,
      repairs: repairable,
      readCurrentFile: dependencies.readFile,
      writeFileAtomically: dependencies.writeFileAtomically,
    });
    const repairedIds = new Set(repairable.map((story) => story.storyId));
    report = {
      ...report,
      specRevision: deriveStoryContractRevision(writeResult.spec),
      repairedStoryIds: [...repairedIds].sort(),
      stories: report.stories.map((story) => repairedIds.has(story.storyId)
        ? { ...story, passAfter: true }
        : story),
    };
    return report;
  });
}
