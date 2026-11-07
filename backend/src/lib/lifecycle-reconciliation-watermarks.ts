/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Transaction-bound identities for every mutable reconciliation input. */
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { ConflictError } from './errors';
import { stableWalJson } from './trusted-wal';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const LIFECYCLE_RECONCILIATION_WATERMARK_KEYS = [
  'compiledPlan',
  'evidence',
  'decisions',
  'runs',
  'mutationState',
] as const;

export interface LifecycleReconciliationWatermarks {
  compiledPlan: `sha256:${string}`;
  evidence: `sha256:${string}`;
  decisions: `sha256:${string}`;
  runs: `sha256:${string}`;
  mutationState: `sha256:${string}`;
}

export interface LifecycleReconciliationFreshnessIdentity {
  compiledPlanId: string | null;
  watermarks: LifecycleReconciliationWatermarks;
}

interface ReconciliationWatermarkRow {
  spec_slug: string;
  compiled_plan_state: unknown;
  evidence_state: unknown;
  decision_state: unknown;
  run_state: unknown;
  mutation_state: unknown;
}

export function digestLifecycleReconciliationState(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(stableWalJson(value)).digest('hex')}`;
}

function isWatermarks(value: unknown): value is LifecycleReconciliationWatermarks {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === LIFECYCLE_RECONCILIATION_WATERMARK_KEYS.length
    && LIFECYCLE_RECONCILIATION_WATERMARK_KEYS.every((key) =>
      typeof row[key] === 'string' && SHA256.test(row[key]));
}

/** Exact equality is deliberate: every source is security-relevant and fail-closed. */
export function lifecycleReconciliationIdentityMatches(
  receipt: { compiledPlanId: string | null; watermarks: unknown },
  current: LifecycleReconciliationFreshnessIdentity | null | undefined,
): boolean {
  if (!current || receipt.compiledPlanId !== current.compiledPlanId) return false;
  const receiptWatermarks = receipt.watermarks;
  const currentWatermarks: unknown = current.watermarks;
  if (!isWatermarks(receiptWatermarks) || !isWatermarks(currentWatermarks)) return false;
  return LIFECYCLE_RECONCILIATION_WATERMARK_KEYS.every((key) =>
    receiptWatermarks[key] === currentWatermarks[key]);
}

/**
 * Read every authoritative database source in the caller's transaction. The
 * singleton apply path and bounded portfolio reader intentionally share this
 * query so they cannot acquire divergent freshness conventions.
 */
export async function loadLifecycleReconciliationIdentities(
  client: Pick<PoolClient, 'query'>,
  workspaceId: string,
  specIds: readonly string[],
): Promise<Map<string, LifecycleReconciliationFreshnessIdentity>> {
  const uniqueSpecIds = [...new Set(specIds)];
  if (uniqueSpecIds.length === 0) return new Map();
  const result = await client.query<ReconciliationWatermarkRow>(`
    WITH requested AS (
      SELECT DISTINCT unnest($2::text[]) AS spec_slug
    ), ranked_runs AS (
      SELECT requested.spec_slug AS scope_spec_slug,
             run.id, run.status, run.branch_name, run.merge_status, run.merge_commit_sha,
             run.terminal_checkout_sha, run.expected_story_ids, run.canonical_spec_revision,
             run.run_spec_path, run.run_spec_bytes_hash, run.execution_worktree_path,
             run.pid, run.started_at, run.finished_at, run.queue_position,
             run.trigger_type, run.agent_type, run.learn_closeout_status, run.learn_closeout_blocker,
             run.learn_closeout_attempted_at, run.learn_candidate_count, run.learn_candidate_ids,
             run.learn_source_evidence_count,
             ROW_NUMBER() OVER (PARTITION BY requested.spec_slug ORDER BY run.id DESC) AS bounded_rank
      FROM requested
      JOIN pipeline_runs run
        ON run.workspace_id = $1
       AND (
         run.spec_path = 'forge/specs/approved/' || requested.spec_slug || '.json'
         OR regexp_replace(run.spec_path, '^.*/|\\.json$', '', 'g') = requested.spec_slug
       )
    ), scoped_runs AS (
      SELECT * FROM ranked_runs WHERE bounded_rank <= 50
    ), ranked_decisions AS (
      SELECT requested.spec_slug AS scope_spec_slug,
             decision.id, decision.run_id, decision.story_id, decision.phase_id, decision.gate_id,
             decision.decision_type, decision.rationale, decision.evidence_gap,
             decision.subject_type, decision.subject_value, decision.policy_version,
             decision.principal_type, decision.principal_id, decision.principal_display_label,
             decision.created_at, decision.expires_at, decision.revoked_at,
             ROW_NUMBER() OVER (
               PARTITION BY requested.spec_slug
               ORDER BY decision.created_at DESC, decision.id DESC
             ) AS bounded_rank
      FROM requested
      JOIN ssdlc_decisions decision
        ON decision.workspace_id = $1 AND decision.spec_slug = requested.spec_slug
    ), scoped_decisions AS (
      SELECT * FROM ranked_decisions WHERE bounded_rank <= 200
    ), effective_results AS (
      SELECT DISTINCT ON (run.scope_spec_slug, result.run_id, result.story_id)
             run.scope_spec_slug, result.run_id, result.story_id, result.id, result.status
      FROM story_results result
      JOIN scoped_runs run ON run.id = result.run_id
      WHERE result.story_id = ANY(COALESCE(run.expected_story_ids, '{}'::text[]))
      ORDER BY run.scope_spec_slug, result.run_id, result.story_id, result.id DESC
    )
    SELECT requested.spec_slug,
      COALESCE((
        SELECT jsonb_build_object(
          'id', plan.id::text,
          'specVersion', plan.spec_version,
          'compilerVersion', plan.compiler_version,
          'inputHash', plan.normalized_input_hash,
          'planHash', encode(digest(convert_to(plan.plan_json::text, 'UTF8'), 'sha256'), 'hex'),
          'provenanceHash', encode(digest(convert_to(plan.provenance_json::text, 'UTF8'), 'sha256'), 'hex'),
          'isCurrent', plan.is_current,
          'updatedAt', plan.updated_at
        )
        FROM ssdlc_compiled_plans plan
        WHERE plan.workspace_id = $1 AND plan.spec_slug = requested.spec_slug
        ORDER BY plan.is_current DESC, plan.created_at DESC, plan.id DESC
        LIMIT 1
      ), '{}'::jsonb) AS compiled_plan_state,
      COALESCE((
        SELECT jsonb_build_object('maximumId', MAX(evidence.id)::text, 'rowCount', COUNT(*)::text)
        FROM ssdlc_lifecycle_evidence evidence
        WHERE evidence.workspace_id = $1 AND evidence.spec_slug = requested.spec_slug
      ), '{}'::jsonb) AS evidence_state,
      COALESCE((
        SELECT jsonb_agg(
          to_jsonb(decision) - 'scope_spec_slug' - 'bounded_rank'
          ORDER BY decision.created_at DESC, decision.id DESC
        )
        FROM scoped_decisions decision
        WHERE decision.scope_spec_slug = requested.spec_slug
      ), '[]'::jsonb) AS decision_state,
      COALESCE((
        SELECT jsonb_agg(
          to_jsonb(run) - 'scope_spec_slug' - 'bounded_rank'
          ORDER BY run.id DESC
        )
        FROM scoped_runs run
        WHERE run.scope_spec_slug = requested.spec_slug
      ), '[]'::jsonb) AS run_state,
      jsonb_build_object(
        'planMutations', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_array(plan.id::text, plan.is_current, plan.updated_at)
            ORDER BY plan.id DESC
          )
          FROM (
            SELECT id, is_current, updated_at
            FROM ssdlc_compiled_plans
            WHERE workspace_id = $1 AND spec_slug = requested.spec_slug
            ORDER BY is_current DESC, created_at DESC, id DESC
            LIMIT 100
          ) plan
        ), '[]'::jsonb),
        'decisionRevocations', COALESCE((
          SELECT jsonb_agg(jsonb_build_array(decision.id::text, decision.revoked_at) ORDER BY decision.id DESC)
          FROM scoped_decisions decision
          WHERE decision.scope_spec_slug = requested.spec_slug AND decision.revoked_at IS NOT NULL
        ), '[]'::jsonb),
        'effectiveStoryResults', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_array(result.run_id::text, result.story_id, result.id::text, result.status)
            ORDER BY result.run_id DESC, result.story_id
          )
          FROM effective_results result
          WHERE result.scope_spec_slug = requested.spec_slug
        ), '[]'::jsonb),
        'specVersions', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_array(
              version.id::text,
              version.version,
              encode(digest(convert_to(version.content_json::text, 'UTF8'), 'sha256'), 'hex')
            )
            ORDER BY version.version DESC, version.id DESC
          )
          FROM (
            SELECT id, version, content_json
            FROM spec_versions
            WHERE workspace_id = $1 AND spec_slug = requested.spec_slug
            ORDER BY version DESC, id DESC
            LIMIT 100
          ) version
        ), '[]'::jsonb),
        'specTags', COALESCE((
          SELECT jsonb_agg(tag.tag_name ORDER BY tag.tag_name)
          FROM spec_tags tag
          WHERE tag.workspace_id = $1 AND tag.spec_id = requested.spec_slug
        ), '[]'::jsonb),
        'planReadinessReasons', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_array(
              reason.id::text,
              reason.reason_code,
              reason.retryable,
              reason.resolved_at,
              encode(digest(convert_to(reason.details::text, 'UTF8'), 'sha256'), 'hex')
            )
            ORDER BY reason.created_at DESC, reason.id DESC
          )
          FROM (
            SELECT id, reason_code, retryable, details, created_at, resolved_at
            FROM ssdlc_plan_readiness_reasons
            WHERE workspace_id = $1 AND spec_slug = requested.spec_slug
            ORDER BY created_at DESC, id DESC
            LIMIT 100
          ) reason
        ), '[]'::jsonb),
        'memoryCandidates', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_array(
              candidate.id::text,
              candidate.status,
              candidate.category,
              candidate.confidence,
              candidate.security_sensitive,
              candidate.default_retrieval_eligible,
              encode(digest(convert_to(candidate.provenance::text, 'UTF8'), 'sha256'), 'hex')
            )
            ORDER BY candidate.created_at DESC, candidate.id DESC
          )
          FROM (
            SELECT id, status, category, confidence, security_sensitive,
                   default_retrieval_eligible, provenance, created_at
            FROM memory_candidates
            WHERE workspace_id = $1
              AND provenance->>'kind' = 'lifecycle_closeout'
              AND provenance->>'specId' = requested.spec_slug
            ORDER BY created_at DESC, id DESC
            LIMIT 200
          ) candidate
        ), '[]'::jsonb),
        'passEvidenceHeads', jsonb_build_object(
          'storyResults', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_array(
                result.id::text,
                result.status,
                result.reason,
                encode(digest(convert_to(COALESCE(result.completion_packet, '{}'::jsonb)::text, 'UTF8'), 'sha256'), 'hex')
              )
              ORDER BY result.observed_at DESC, result.id DESC
            )
            FROM (
              SELECT story.id, story.status, story.reason, story.completion_packet,
                     COALESCE(story.created_at, story.started_at) AS observed_at
              FROM story_results story
              LEFT JOIN story_execution_manifests manifest
                ON manifest.run_id = story.run_id AND manifest.story_id = story.story_id
               AND manifest.workspace_id = $1 AND manifest.spec_id = requested.spec_slug
              WHERE story.spec_id = requested.spec_slug OR manifest.manifest_hash IS NOT NULL
              ORDER BY COALESCE(story.created_at, story.started_at) DESC, story.id DESC
              LIMIT 500
            ) result
          ), '[]'::jsonb),
          'manifests', (
            SELECT jsonb_build_array(COUNT(*)::text, MAX(manifest.manifest_hash))
            FROM story_execution_manifests manifest
            WHERE manifest.workspace_id = $1 AND manifest.spec_id = requested.spec_slug
          ),
          'attemptResults', (
            SELECT jsonb_build_array(COUNT(*)::text, MAX(attempt.attempt_result_id))
            FROM story_attempt_results attempt
            WHERE attempt.workspace_id = $1 AND attempt.spec_id = requested.spec_slug
          ),
          'closeoutDecisions', (
            SELECT jsonb_build_array(COUNT(*)::text, MAX(closeout.decision_id))
            FROM story_closeout_decisions closeout
            WHERE closeout.workspace_id = $1 AND closeout.spec_id = requested.spec_slug
          ),
          'commits', (
            SELECT jsonb_build_array(COUNT(*)::text, MAX(story_commit.id)::text)
            FROM story_commits story_commit
            WHERE story_commit.workspace_id = $1 AND story_commit.spec_id = requested.spec_slug
          )
        )
      ) AS mutation_state
    FROM requested
    ORDER BY requested.spec_slug
  `, [workspaceId, uniqueSpecIds]);

  return new Map(result.rows.map((row): [string, LifecycleReconciliationFreshnessIdentity] => {
    const compiledPlanState = row.compiled_plan_state && typeof row.compiled_plan_state === 'object'
      ? row.compiled_plan_state as Record<string, unknown>
      : {};
    return [row.spec_slug, {
      compiledPlanId: typeof compiledPlanState.id === 'string' ? compiledPlanState.id : null,
      watermarks: {
        compiledPlan: digestLifecycleReconciliationState(row.compiled_plan_state),
        evidence: digestLifecycleReconciliationState(row.evidence_state),
        decisions: digestLifecycleReconciliationState(row.decision_state),
        runs: digestLifecycleReconciliationState(row.run_state),
        mutationState: digestLifecycleReconciliationState(row.mutation_state),
      },
    }];
  }));
}

export async function loadLifecycleReconciliationWatermarks(
  client: Pick<PoolClient, 'query'>,
  workspaceId: string,
  specId: string,
): Promise<LifecycleReconciliationWatermarks> {
  const identity = (await loadLifecycleReconciliationIdentities(client, workspaceId, [specId])).get(specId);
  if (!identity) throw new ConflictError('Lifecycle reconciliation state could not be observed');
  return identity.watermarks;
}
