/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query } from '../db/index';
import { logger } from './logger';

export interface RetrievalFeedbackRow {
  workspace_id: string;
  candidate_key: string;
  candidate_kind: string;
  skill_name: string | null;
  success_count: number;
  failure_count: number;
  observation_count: number;
  usefulness_score: number;
  last_seen_at: string;
  updated_at: string;
}

export interface RetrievalHistoricalUsefulnessRow {
  candidate_key: string;
  usefulness_score: number;
}

export interface RetrievalOutcome {
  workspaceId: string;
  candidateKey: string;
  candidateKind: string;
  skillName?: string;
  success: boolean;
}

export interface RetrievalFeedbackListOptions {
  workspaceId?: string;
  limit?: number;
}

export interface RetrievalFeedbackSummary {
  totalCandidates: number;
  avgUsefulnessScore: number;
  avgObservationCount: number;
  topPerformers: RetrievalFeedbackRow[];
  weakestCandidates: RetrievalFeedbackRow[];
  mostObservedCandidates: RetrievalFeedbackRow[];
}

interface RetrievalFeedbackSummaryRow {
  total_candidates: number;
  avg_usefulness_score: number;
  avg_observation_count: number;
}

function withSkillName(skillName?: string): string {
  return (skillName || '').trim();
}

function usefulness(successCount: number, failureCount: number): number {
  return (successCount + 1) / (successCount + failureCount + 2);
}

function normalizeFeedbackRows(rows: RetrievalFeedbackRow[]): RetrievalFeedbackRow[] {
  return rows.map((row) => ({
    ...row,
    skill_name: row.skill_name || null,
    success_count: Number(row.success_count) || 0,
    failure_count: Number(row.failure_count) || 0,
    observation_count: Number(row.observation_count) || 0,
    usefulness_score: Number(row.usefulness_score) || 0,
  }));
}

export async function getHistoricalUsefulnessMap(
  workspaceId: string,
  candidateKeys: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (candidateKeys.length === 0) return result;

  try {
    const rows = await query<RetrievalHistoricalUsefulnessRow>(
      `SELECT candidate_key, MAX(usefulness_score) AS usefulness_score
       FROM retrieval_feedback
       WHERE workspace_id = $1 AND candidate_key = ANY($2::text[])
       GROUP BY candidate_key`,
      [workspaceId, candidateKeys],
    );

    for (const row of rows) {
      result.set(row.candidate_key, Number(row.usefulness_score));
    }
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-feedback] historical usefulness lookup failed');
    }
  }

  return result;
}

export async function listRetrievalFeedback(
  options: RetrievalFeedbackListOptions = {},
): Promise<RetrievalFeedbackRow[]> {
  const limit = Math.max(0, options.limit ?? 20);

  try {
    const rows = await query<RetrievalFeedbackRow>(
      `SELECT
         workspace_id,
         candidate_key,
         candidate_kind,
         NULLIF(skill_name, '') AS skill_name,
         success_count,
         failure_count,
         observation_count,
         usefulness_score,
         last_seen_at,
         updated_at
       FROM retrieval_feedback
       WHERE ($1::text IS NULL OR workspace_id = $1)
       ORDER BY updated_at DESC
       LIMIT $2`,
      [options.workspaceId ?? null, limit],
    );

    return normalizeFeedbackRows(rows);
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-feedback] list failed');
    }
    return [];
  }
}

export async function summarizeRetrievalFeedback(
  options: RetrievalFeedbackListOptions = {},
): Promise<RetrievalFeedbackSummary> {
  const empty: RetrievalFeedbackSummary = {
    totalCandidates: 0,
    avgUsefulnessScore: 0,
    avgObservationCount: 0,
    topPerformers: [],
    weakestCandidates: [],
    mostObservedCandidates: [],
  };

  try {
    const [summaryRows, topPerformers, weakestCandidates, mostObservedCandidates] = await Promise.all([
      query<RetrievalFeedbackSummaryRow>(
        `SELECT
           COUNT(*)::int AS total_candidates,
           COALESCE(AVG(usefulness_score), 0)::double precision AS avg_usefulness_score,
           COALESCE(AVG(observation_count), 0)::double precision AS avg_observation_count
         FROM retrieval_feedback
         WHERE ($1::text IS NULL OR workspace_id = $1)`,
        [options.workspaceId ?? null],
      ),
      query<RetrievalFeedbackRow>(
        `SELECT
           workspace_id,
           candidate_key,
           candidate_kind,
           NULLIF(skill_name, '') AS skill_name,
           success_count,
           failure_count,
           observation_count,
           usefulness_score,
           last_seen_at,
           updated_at
         FROM retrieval_feedback
         WHERE ($1::text IS NULL OR workspace_id = $1)
         ORDER BY usefulness_score DESC, observation_count DESC, updated_at DESC
         LIMIT 5`,
        [options.workspaceId ?? null],
      ),
      query<RetrievalFeedbackRow>(
        `SELECT
           workspace_id,
           candidate_key,
           candidate_kind,
           NULLIF(skill_name, '') AS skill_name,
           success_count,
           failure_count,
           observation_count,
           usefulness_score,
           last_seen_at,
           updated_at
         FROM retrieval_feedback
         WHERE ($1::text IS NULL OR workspace_id = $1)
         ORDER BY usefulness_score ASC, failure_count DESC, updated_at DESC
         LIMIT 5`,
        [options.workspaceId ?? null],
      ),
      query<RetrievalFeedbackRow>(
        `SELECT
           workspace_id,
           candidate_key,
           candidate_kind,
           NULLIF(skill_name, '') AS skill_name,
           success_count,
           failure_count,
           observation_count,
           usefulness_score,
           last_seen_at,
           updated_at
         FROM retrieval_feedback
         WHERE ($1::text IS NULL OR workspace_id = $1)
         ORDER BY observation_count DESC, updated_at DESC
         LIMIT 5`,
        [options.workspaceId ?? null],
      ),
    ]);

    const summary = summaryRows[0];
    if (!summary) return empty;

    return {
      totalCandidates: Number(summary.total_candidates) || 0,
      avgUsefulnessScore: Number(summary.avg_usefulness_score) || 0,
      avgObservationCount: Number(summary.avg_observation_count) || 0,
      topPerformers: normalizeFeedbackRows(topPerformers),
      weakestCandidates: normalizeFeedbackRows(weakestCandidates),
      mostObservedCandidates: normalizeFeedbackRows(mostObservedCandidates),
    };
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-feedback] summary failed');
    }
    return empty;
  }
}

export async function recordRetrievalSelection(
  workspaceId: string,
  selections: Array<{ candidateKey: string; candidateKind: string; skillName?: string }>,
): Promise<void> {
  if (selections.length === 0) return;

  try {
    for (const selection of selections) {
      await execute(
        `INSERT INTO retrieval_feedback (
           workspace_id,
           candidate_key,
           candidate_kind,
           skill_name,
           observation_count,
           usefulness_score,
           last_seen_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 1, 0.5, NOW(), NOW())
         ON CONFLICT (workspace_id, candidate_key, candidate_kind, skill_name)
         DO UPDATE SET
           observation_count = retrieval_feedback.observation_count + 1,
           last_seen_at = NOW(),
           updated_at = NOW()`,
        [workspaceId, selection.candidateKey, selection.candidateKind, withSkillName(selection.skillName)],
      );
    }
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-feedback] selection recording failed');
    }
  }
}

export async function recordRetrievalOutcome(outcome: RetrievalOutcome): Promise<void> {
  try {
    const skillName = withSkillName(outcome.skillName);
    await execute(
      `INSERT INTO retrieval_feedback (
         workspace_id,
         candidate_key,
         candidate_kind,
         skill_name,
         success_count,
         failure_count,
         observation_count,
         usefulness_score,
         last_seen_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, NOW(), NOW())
       ON CONFLICT (workspace_id, candidate_key, candidate_kind, skill_name)
       DO UPDATE SET
         success_count = retrieval_feedback.success_count + EXCLUDED.success_count,
         failure_count = retrieval_feedback.failure_count + EXCLUDED.failure_count,
         observation_count = retrieval_feedback.observation_count + 1,
         usefulness_score = (
           (retrieval_feedback.success_count + EXCLUDED.success_count + 1)::double precision /
           (retrieval_feedback.success_count + EXCLUDED.success_count + retrieval_feedback.failure_count + EXCLUDED.failure_count + 2)
         ),
         last_seen_at = NOW(),
         updated_at = NOW()`,
      [
        outcome.workspaceId,
        outcome.candidateKey,
        outcome.candidateKind,
        skillName,
        outcome.success ? 1 : 0,
        outcome.success ? 0 : 1,
        usefulness(outcome.success ? 1 : 0, outcome.success ? 0 : 1),
      ],
    );
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-feedback] outcome recording failed');
    }
  }
}
