/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { query, queryOne, execute } from '../db/index';
import { withUserClient } from '../db/user-client';
import { NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { checkAge } from '../lib/age-guard';
import {
  rowToBillingProfile,
  type BillingProfile,
  type BillingProfileRow,
  type BillingMode,
} from '../lib/finops-types';
import {
  computeAccounting,
  computeAccountingPerRecord,
  classifyUsage,
  meteredCost,
  type AccountingContext,
  type AccountingResult,
  type PricingRate,
  type UsageRecord,
} from '../lib/finops-accounting';

const router = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface UsageRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_cost_usd: number;
  count: number;
}

interface TimeSeriesRow {
  date: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_cost_usd: number;
}

interface PiProviderRow {
  provider: string;
  total_runs: number;
  total_stories: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  avg_cost_per_story: number;
  last_used: string;
}

const ONTOLOGY_RELATION_LIMIT = 12;
const ONTOLOGY_ACTIVITY_LIMIT = 12;
const ONTOLOGY_ACTIVITY_WINDOW_DAYS = 14;
const ONTOLOGY_HOTSPOT_MEMORY_WINDOW = 400;
const ONTOLOGY_HOTSPOT_RESULT_LIMIT = 6;

type OntologyHotspotScope = 'file' | 'spec';

interface OntologyCountsRow {
  active_conflict_count: number | string;
  superseded_memory_count: number | string;
  active_memory_count: number | string;
}

interface OntologyRelationRow {
  id: number | string;
  relation_type: 'SUPERSEDES' | 'CONFLICTS_WITH';
  status: 'active' | 'superseded' | 'deleted';
  updated_at: string | Date;
  created_at: string | Date;
  source_memory_id: number | string;
  target_memory_id: number | string;
  source_content: string;
  target_content: string;
  source_category: string;
  target_category: string;
  source_spec_id: string | null;
  target_spec_id: string | null;
  source_story_id: string | null;
  target_story_id: string | null;
  source_related_files: string[] | string | null;
  target_related_files: string[] | string | null;
}

interface OntologyHotspotRow {
  key: string;
  memory_count: number | string;
  conflict_count: number | string;
  superseded_count: number | string;
  last_touched_at: string | Date | null;
  sample_memory_ids: number[] | string | null;
}

interface OntologyActivityRow {
  ts: string | Date;
  event_type: string;
  payload: Record<string, unknown> | string | null;
  spec_id: string | null;
  story_id: string | null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function parseNumericArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

async function getAnalyticsWorkspacePath(workspaceId: string): Promise<string | null> {
  const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
  return ws?.path ?? null;
}

async function loadOntologyHotspots(workspaceId: string, scope: OntologyHotspotScope): Promise<OntologyHotspotRow[]> {
  if (scope === 'file') {
    return query<OntologyHotspotRow>(
      `WITH recent_memories AS (
         SELECT id, related_files, updated_at
           FROM memories
          WHERE workspace_id = $1
            AND deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC
          LIMIT $2
       ),
       relation_counts AS (
         SELECT rm.id AS memory_id,
                COUNT(*) FILTER (WHERE mr.relation_type = 'CONFLICTS_WITH' AND mr.status = 'active')::int AS conflict_count,
                COUNT(*) FILTER (WHERE mr.relation_type = 'SUPERSEDES' AND mr.status = 'active')::int AS superseded_count
           FROM recent_memories rm
           LEFT JOIN memory_relations mr
             ON mr.workspace_id = $1
            AND (mr.source_memory_id = rm.id OR mr.target_memory_id = rm.id)
          GROUP BY rm.id
       ),
       file_refs AS (
         SELECT rm.id,
                rm.updated_at,
                jsonb_array_elements_text(rm.related_files) AS file_path
           FROM recent_memories rm
          WHERE jsonb_typeof(rm.related_files) = 'array'
       )
       SELECT fr.file_path AS key,
              COUNT(DISTINCT fr.id)::int AS memory_count,
              COUNT(DISTINCT fr.id) FILTER (WHERE COALESCE(rc.conflict_count, 0) > 0)::int AS conflict_count,
              COUNT(DISTINCT fr.id) FILTER (WHERE COALESCE(rc.superseded_count, 0) > 0)::int AS superseded_count,
              MAX(fr.updated_at) AS last_touched_at,
              ARRAY(
                SELECT DISTINCT fr2.id
                  FROM file_refs fr2
                 WHERE fr2.file_path = fr.file_path
                 ORDER BY fr2.id ASC
                 LIMIT 6
              ) AS sample_memory_ids
         FROM file_refs fr
         LEFT JOIN relation_counts rc ON rc.memory_id = fr.id
        GROUP BY fr.file_path
        ORDER BY memory_count DESC, conflict_count DESC, last_touched_at DESC, key ASC
        LIMIT $3`,
      [workspaceId, ONTOLOGY_HOTSPOT_MEMORY_WINDOW, ONTOLOGY_HOTSPOT_RESULT_LIMIT],
    );
  }

  return query<OntologyHotspotRow>(
    `WITH recent_memories AS (
       SELECT id, source_spec_id, updated_at
         FROM memories
        WHERE workspace_id = $1
          AND deleted_at IS NULL
          AND source_spec_id IS NOT NULL
        ORDER BY updated_at DESC, id DESC
        LIMIT $2
     ),
     relation_counts AS (
       SELECT rm.id AS memory_id,
              COUNT(*) FILTER (WHERE mr.relation_type = 'CONFLICTS_WITH' AND mr.status = 'active')::int AS conflict_count,
              COUNT(*) FILTER (WHERE mr.relation_type = 'SUPERSEDES' AND mr.status = 'active')::int AS superseded_count
         FROM recent_memories rm
         LEFT JOIN memory_relations mr
           ON mr.workspace_id = $1
          AND (mr.source_memory_id = rm.id OR mr.target_memory_id = rm.id)
        GROUP BY rm.id
     )
     SELECT rm.source_spec_id AS key,
            COUNT(DISTINCT rm.id)::int AS memory_count,
            COUNT(DISTINCT rm.id) FILTER (WHERE COALESCE(rc.conflict_count, 0) > 0)::int AS conflict_count,
            COUNT(DISTINCT rm.id) FILTER (WHERE COALESCE(rc.superseded_count, 0) > 0)::int AS superseded_count,
            MAX(rm.updated_at) AS last_touched_at,
            ARRAY(
              SELECT DISTINCT rm2.id
                FROM recent_memories rm2
               WHERE rm2.source_spec_id = rm.source_spec_id
               ORDER BY rm2.id ASC
               LIMIT 6
            ) AS sample_memory_ids
       FROM recent_memories rm
       LEFT JOIN relation_counts rc ON rc.memory_id = rm.id
      GROUP BY rm.source_spec_id
      ORDER BY memory_count DESC, conflict_count DESC, last_touched_at DESC, key ASC
      LIMIT $3`,
    [workspaceId, ONTOLOGY_HOTSPOT_MEMORY_WINDOW, ONTOLOGY_HOTSPOT_RESULT_LIMIT],
  );
}

function normalizeOntologyTimestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapOntologyHotspotItems(rows: OntologyHotspotRow[], scopeType: OntologyHotspotScope) {
  return rows.map((row) => ({
    scopeType,
    key: row.key,
    label: row.key,
    memoryCount: Number(row.memory_count),
    conflictCount: Number(row.conflict_count),
    supersededCount: Number(row.superseded_count),
    lastTouchedAt: normalizeOntologyTimestamp(row.last_touched_at),
    sampleMemoryIds: parseNumericArray(row.sample_memory_ids),
  }));
}

// ─── GET /api/analytics/usage — Aggregated token usage ───────────────────────
// Query params:
//   from    — ISO date string (inclusive), default 30 days ago
//   to      — ISO date string (inclusive), default now
//   group_by — 'spec' | 'story' | 'model' | 'user', default 'model'
//   workspace_id — optional filter

/**
 * @swagger
 * /api/analytics/usage:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Get token usage analytics
 *     operationId: getTokenUsage
 *     description: Returns aggregated token usage data grouped by spec, story, model, or user, with a daily time series and summary totals. Supports date range and workspace filtering.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: group_by
 *         schema: { type: string, enum: [spec, story, model, user] }
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Usage analytics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 grouped: { type: array, items: { type: object } }
 *                 timeSeries: { type: array, items: { type: object } }
 *                 totals: { type: object }
 *                 dateRange: { type: object }
 *                 groupBy: { type: string }
 */
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const groupBy = (req.query.group_by as string) || 'model';
    const workspaceId = req.query.workspace_id as string | undefined;

    // Default date range: last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const validGroupBy = ['spec', 'story', 'model', 'user'];
    if (!validGroupBy.includes(groupBy)) {
      throw new ValidationError(`group_by must be one of: ${validGroupBy.join(', ')}`);
      return;
    }

    // Map group_by to SQL column
    const groupColumn: Record<string, string> = {
      spec: "REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '')",
      story: 'tu.story_id',
      model: 'tu.model',
      user: "COALESCE(tu.user_id, 'system')",
    };

    const groupCol = groupColumn[groupBy];
    const needsJoin = groupBy === 'spec';

    // Pricing-derived total cost so usage totals stay consistent with the FinOps
    // dashboard and /costs endpoint, which always price from model_pricing. The
    // recorded tu.cost_usd is only a fallback for models that have no pricing
    // entry, so unpriced legacy rows still surface their stored cost rather than
    // collapsing to zero. Requires a `LEFT JOIN model_pricing mp` on each query.
    const PRICED_TOTAL_COST_SQL = `
        SUM(
          CASE WHEN mp.model_id IS NOT NULL THEN
            (CASE WHEN mp.input_cost_per_1m IS NOT NULL
              THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
              ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
            END)
            + (CASE WHEN mp.output_cost_per_1m IS NOT NULL
              THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
              ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
            END)
          ELSE COALESCE(tu.cost_usd, 0) END
        )`;

    let paramIdx = 1;
    let sql = `
      SELECT
        ${groupCol} AS group_key,
        SUM(tu.input_tokens) AS total_input_tokens,
        SUM(tu.output_tokens) AS total_output_tokens,
        COALESCE(SUM(tu.reasoning_tokens), 0) AS total_reasoning_tokens,
        ${PRICED_TOTAL_COST_SQL} AS total_cost_usd,
        COUNT(*)::int AS count
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
    `;
    if (needsJoin) {
      sql += ' JOIN pipeline_runs pr ON tu.run_id = pr.id';
    }

    const params: (string | number)[] = [];
    sql += ` WHERE tu.recorded_at >= $${paramIdx++} AND tu.recorded_at <= $${paramIdx++}`;
    params.push(from, to);

    if (workspaceId) {
      sql += ` AND tu.workspace_id = $${paramIdx++}`;
      params.push(workspaceId);
    }

    sql += ` GROUP BY group_key ORDER BY total_cost_usd DESC`;

    const grouped = await query<UsageRow>(sql, params);

    // Time series: daily aggregation
    let tsParamIdx = 1;
    let timeSeriesSql = `
      SELECT
        DATE(tu.recorded_at) AS date,
        SUM(tu.input_tokens) AS total_input_tokens,
        SUM(tu.output_tokens) AS total_output_tokens,
        COALESCE(SUM(tu.reasoning_tokens), 0) AS total_reasoning_tokens,
        ${PRICED_TOTAL_COST_SQL} AS total_cost_usd
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
      WHERE tu.recorded_at >= $${tsParamIdx++} AND tu.recorded_at <= $${tsParamIdx++}
    `;
    const tsParams: (string | number)[] = [from, to];
    if (workspaceId) {
      timeSeriesSql += ` AND tu.workspace_id = $${tsParamIdx++}`;
      tsParams.push(workspaceId);
    }
    timeSeriesSql += ' GROUP BY DATE(tu.recorded_at) ORDER BY date ASC';

    const timeSeries = await query<TimeSeriesRow>(timeSeriesSql, tsParams);

    // Summary totals
    let totParamIdx = 1;
    let totalSql = `
      SELECT
        COALESCE(SUM(tu.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(tu.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(tu.reasoning_tokens), 0) AS total_reasoning_tokens,
        COALESCE(${PRICED_TOTAL_COST_SQL}, 0) AS total_cost_usd,
        COUNT(*)::int AS total_records
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
      WHERE tu.recorded_at >= $${totParamIdx++} AND tu.recorded_at <= $${totParamIdx++}
    `;
    const totParams: (string | number)[] = [from, to];
    if (workspaceId) {
      totalSql += ` AND tu.workspace_id = $${totParamIdx++}`;
      totParams.push(workspaceId);
    }

    const totals = await queryOne<{
      total_input_tokens: number;
      total_output_tokens: number;
      total_reasoning_tokens: number;
      total_cost_usd: number;
      total_records: number;
    }>(totalSql, totParams);

    // Active runs check (for auto-refresh hint)
    const activeRuns = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pipeline_runs WHERE status = 'running'`
    );

    res.json({
      grouped: grouped.map(r => ({
        ...r,
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
        total_reasoning_tokens: Number(r.total_reasoning_tokens),
        total_cost_usd: Number(r.total_cost_usd),
        count: Number(r.count),
      })),
      timeSeries: timeSeries.map(r => ({
        ...r,
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
        total_reasoning_tokens: Number(r.total_reasoning_tokens),
        total_cost_usd: Number(r.total_cost_usd),
      })),
      totals: totals ? {
        total_input_tokens: Number(totals.total_input_tokens),
        total_output_tokens: Number(totals.total_output_tokens),
        total_reasoning_tokens: Number(totals.total_reasoning_tokens),
        total_cost_usd: Number(totals.total_cost_usd),
        total_records: Number(totals.total_records),
      } : totals,
      hasActiveRuns: (activeRuns?.count ?? 0) > 0,
      dateRange: { from, to },
      groupBy,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Usage query');
  }
});

// ─── GET /api/analytics/costs — Cost breakdowns by spec, run, model, time ────
// Query params:
//   from         — ISO date (inclusive), default 30 days ago
//   to           — ISO date (inclusive), default now
//   workspace_id — optional filter
//   group_by     — 'spec' | 'run' | 'model' | 'period', default 'spec'

interface CostRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  story_count: number;
}

interface PeriodCostRow {
  period: string;
  total_input_tokens: number;
  total_output_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  story_count: number;
}

/**
 * @swagger
 * /api/analytics/costs:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Get cost analytics
 *     operationId: getCostAnalytics
 *     description: Returns cost breakdowns grouped by spec, run, model, or time period. Uses model_pricing table for actual provider rates. Supports date range and workspace filtering.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: group_by
 *         schema: { type: string, enum: [spec, run, model, period] }
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cost breakdown
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupBy: { type: string }
 *                 breakdown: { type: array, items: { type: object } }
 *                 totals: { type: object }
 *                 dateRange: { type: object }
 */
router.get('/costs', async (req: Request, res: Response) => {
  try {
    const groupBy = (req.query.group_by as string) || 'spec';
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const validGroupBy = ['spec', 'run', 'model', 'period'];
    if (!validGroupBy.includes(groupBy)) {
      throw new ValidationError(`group_by must be one of: ${validGroupBy.join(', ')}`);
      return;
    }

    // Cost calculation uses model_pricing join for actual provider rates
    // Formula: (input_tokens / 1,000,000) * input_cost_per_1m + (output_tokens / 1,000,000) * output_cost_per_1m

    let wsParamIdx = 3;
    const wsFilter = workspaceId ? `AND tu.workspace_id = $${wsParamIdx++}` : '';
    const wsParams: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

    if (groupBy === 'period') {
      // Group by week — PostgreSQL: to_char for ISO year-week
      const sql = `
        SELECT
          to_char(tu.recorded_at, 'IYYY-"W"IW') AS period,
          SUM(tu.input_tokens) AS total_input_tokens,
          SUM(tu.output_tokens) AS total_output_tokens,
          SUM(CASE WHEN mp.input_cost_per_1m IS NOT NULL
            THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
            ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
          END) AS input_cost_usd,
          SUM(CASE WHEN mp.output_cost_per_1m IS NOT NULL
            THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
            ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
          END) AS output_cost_usd,
          -- Pricing-derived total with a raw-cost fallback for unpriced models.
          SUM(
            CASE WHEN mp.model_id IS NOT NULL THEN
              (CASE WHEN mp.input_cost_per_1m IS NOT NULL
                THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
                ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
              END)
              + (CASE WHEN mp.output_cost_per_1m IS NOT NULL
                THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
                ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
              END)
            ELSE COALESCE(tu.cost_usd, 0) END
          ) AS total_cost_usd,
          COUNT(*)::int AS story_count
        FROM token_usage tu
        LEFT JOIN model_pricing mp ON tu.model = mp.model_id
        WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2
        ${wsFilter}
        GROUP BY period
        ORDER BY period ASC
      `;

      const periods = await query<PeriodCostRow>(sql, wsParams);

      res.json({ groupBy, periods, dateRange: { from, to } });
      return;
    }

    // Non-period groupings (spec, run, model)
    const groupColumn: Record<string, string> = {
      spec: "REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '')",
      run: 'tu.run_id',
      model: 'tu.model',
    };
    const groupCol = groupColumn[groupBy];
    const needsRunJoin = groupBy === 'spec' || groupBy === 'run';

    const sql = `
      SELECT
        ${groupCol} AS group_key,
        SUM(tu.input_tokens) AS total_input_tokens,
        SUM(tu.output_tokens) AS total_output_tokens,
        SUM(CASE WHEN mp.input_cost_per_1m IS NOT NULL
          THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
          ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
        END) AS input_cost_usd,
        SUM(CASE WHEN mp.output_cost_per_1m IS NOT NULL
          THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
          ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
        END) AS output_cost_usd,
        -- total_cost_usd is the pricing-derived cost (input + output) so it stays
        -- consistent with the per-component cost columns and the FinOps dashboard,
        -- which always price from model_pricing. The recorded tu.cost_usd is only a
        -- fallback for rows whose model has no pricing entry, so unpriced legacy
        -- rows still surface their stored cost instead of dropping to zero.
        SUM(
          CASE WHEN mp.model_id IS NOT NULL THEN
            (CASE WHEN mp.input_cost_per_1m IS NOT NULL
              THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
              ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
            END)
            + (CASE WHEN mp.output_cost_per_1m IS NOT NULL
              THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
              ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
            END)
          ELSE COALESCE(tu.cost_usd, 0) END
        ) AS total_cost_usd,
        COUNT(*)::int AS story_count
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
      ${needsRunJoin ? 'JOIN pipeline_runs pr ON tu.run_id = pr.id' : ''}
      WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2
      ${wsFilter}
      GROUP BY group_key
      -- Newest-first by the group's most recent usage, capped at the 20 most
      -- recent groups so the breakdown stays a bounded, recency-ordered view.
      ORDER BY MAX(tu.recorded_at) DESC
      LIMIT 20
    `;

    const rawBreakdown = await query<CostRow>(sql, wsParams);
    // Parse bigint COUNT(*) to numbers
    const breakdown = rawBreakdown.map(r => ({
      ...r,
      story_count: parseInt(String(r.story_count), 10) || 0,
    }));

    // Summary totals
    const totalSql = `
      SELECT
        COALESCE(SUM(tu.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(tu.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(CASE WHEN mp.input_cost_per_1m IS NOT NULL
          THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
          ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
        END), 0) AS total_input_cost_usd,
        COALESCE(SUM(CASE WHEN mp.output_cost_per_1m IS NOT NULL
          THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
          ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
        END), 0) AS total_output_cost_usd,
        -- Pricing-derived total with a raw-cost fallback for unpriced models,
        -- mirroring the per-row breakdown above so totals reconcile with rows.
        COALESCE(SUM(
          CASE WHEN mp.model_id IS NOT NULL THEN
            (CASE WHEN mp.input_cost_per_1m IS NOT NULL
              THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
              ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
            END)
            + (CASE WHEN mp.output_cost_per_1m IS NOT NULL
              THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
              ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
            END)
          ELSE COALESCE(tu.cost_usd, 0) END
        ), 0) AS total_cost_usd,
        COUNT(*)::int AS total_stories
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
      WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2
      ${wsFilter}
    `;

    const rawTotals = await queryOne<{
      total_input_tokens: number;
      total_output_tokens: number;
      total_input_cost_usd: number;
      total_output_cost_usd: number;
      total_cost_usd: number;
      total_stories: number;
    }>(totalSql, wsParams);
    const totals = rawTotals ? {
      ...rawTotals,
      total_stories: parseInt(String(rawTotals.total_stories), 10) || 0,
    } : rawTotals;

    res.json({ groupBy, breakdown, totals, dateRange: { from, to } });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Costs query');
  }
});

// ─── GET /api/analytics/pricing — List all model pricing entries ─────────────

interface ModelPricingFullRow {
  model_id: string;
  provider: string;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  effective_date: string;
  updated_at: string;
}

/**
 * @swagger
 * /api/analytics/pricing:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: List all model pricing entries
 *     operationId: listModelPricing
 *     description: Returns all model pricing entries from the model_pricing table, normalized to per-1M token costs for display. Used by the FinOps dashboard and cost calculator.
 *     responses:
 *       200:
 *         description: List of model pricing entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pricing:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       model_id: { type: string }
 *                       provider: { type: string }
 *                       input_cost_per_1m_tokens: { type: number }
 *                       output_cost_per_1m_tokens: { type: number }
 *                       effective_date: { type: string }
 *                       updated_at: { type: string }
 *       500:
 *         description: Internal server error
 */
router.get('/pricing', async (_req: Request, res: Response) => {
  try {
    const rows = await query<ModelPricingFullRow>(
      'SELECT * FROM model_pricing ORDER BY model_id'
    );

    // Normalize to per-1M for display (use per-1M if available, else compute from per-1k)
    const pricing = rows.map(r => ({
      model_id: r.model_id,
      provider: r.provider || 'anthropic',
      input_cost_per_1m_tokens: r.input_cost_per_1m ?? r.input_cost_per_1k * 1000,
      output_cost_per_1m_tokens: r.output_cost_per_1m ?? r.output_cost_per_1k * 1000,
      effective_date: r.effective_date || r.updated_at,
      updated_at: r.updated_at,
    }));

    res.json({ pricing });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Pricing list');
  }
});

// ─── PUT /api/analytics/pricing/:modelId — Update or create model pricing ────

/**
 * @swagger
 * /api/analytics/pricing/{modelId}:
 *   put:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Update or create model pricing
 *     operationId: upsertModelPricing
 *     description: Creates or updates pricing for a specific model. Accepts per-1M token costs and automatically converts to per-1K for backward compatibility with the cost estimator. If the model already exists, it is updated; otherwise a new entry is created.
 *     parameters:
 *       - in: path
 *         name: modelId
 *         required: true
 *         schema: { type: string }
 *         description: The model identifier (e.g. claude-sonnet-4-5-20250929)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [input_cost_per_1m_tokens, output_cost_per_1m_tokens]
 *             properties:
 *               provider: { type: string, description: "Provider name (default: anthropic)" }
 *               input_cost_per_1m_tokens: { type: number, description: "Cost per 1M input tokens in USD" }
 *               output_cost_per_1m_tokens: { type: number, description: "Cost per 1M output tokens in USD" }
 *               effective_date: { type: string, format: date-time, description: "Effective date (default: now)" }
 *     responses:
 *       200:
 *         description: Model pricing created or updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 model_id: { type: string }
 *                 provider: { type: string }
 *                 input_cost_per_1m_tokens: { type: number }
 *                 output_cost_per_1m_tokens: { type: number }
 *                 effective_date: { type: string }
 *       400:
 *         description: Missing required fields or negative cost values
 *       500:
 *         description: Internal server error
 */
router.put('/pricing/:modelId', async (req: Request, res: Response) => {
  try {
    const modelId = req.params.modelId;
    const {
      provider,
      input_cost_per_1m_tokens,
      output_cost_per_1m_tokens,
      effective_date,
    } = req.body as {
      provider?: string;
      input_cost_per_1m_tokens: number;
      output_cost_per_1m_tokens: number;
      effective_date?: string;
    };

    if (input_cost_per_1m_tokens == null || output_cost_per_1m_tokens == null) {
      throw new ValidationError('input_cost_per_1m_tokens and output_cost_per_1m_tokens are required');
      return;
    }

    if (input_cost_per_1m_tokens < 0 || output_cost_per_1m_tokens < 0) {
      throw new ValidationError('Costs cannot be negative');
      return;
    }

    // Convert per-1M to per-1K for backward compat with existing cost-estimator
    const inputPer1k = input_cost_per_1m_tokens / 1000;
    const outputPer1k = output_cost_per_1m_tokens / 1000;
    const effDate = effective_date || new Date().toISOString();
    const prov = provider || 'anthropic';

    const existing = await queryOne<{ model_id: string }>(
      'SELECT model_id FROM model_pricing WHERE model_id = $1',
      [modelId]
    );

    if (existing) {
      await execute(`
        UPDATE model_pricing
        SET provider = $1,
            input_cost_per_1k = $2,
            output_cost_per_1k = $3,
            input_cost_per_1m = $4,
            output_cost_per_1m = $5,
            effective_date = $6,
            updated_at = NOW()
        WHERE model_id = $7
      `, [prov, inputPer1k, outputPer1k, input_cost_per_1m_tokens, output_cost_per_1m_tokens, effDate, modelId]);
    } else {
      await execute(`
        INSERT INTO model_pricing (model_id, provider, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m, effective_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [modelId, prov, inputPer1k, outputPer1k, input_cost_per_1m_tokens, output_cost_per_1m_tokens, effDate]);
    }

    res.json({
      model_id: modelId,
      provider: prov,
      input_cost_per_1m_tokens,
      output_cost_per_1m_tokens,
      effective_date: effDate,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Pricing update');
  }
});

// ─── DELETE /api/analytics/pricing/:modelId — Remove model pricing ───────────

/**
 * @swagger
 * /api/analytics/pricing/{modelId}:
 *   delete:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Remove model pricing entry
 *     operationId: deleteModelPricing
 *     description: Deletes the pricing entry for the specified model. Returns 404 if the model pricing does not exist.
 *     parameters:
 *       - in: path
 *         name: modelId
 *         required: true
 *         schema: { type: string }
 *         description: The model identifier to delete pricing for
 *     responses:
 *       200:
 *         description: Model pricing deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: string }
 *       404:
 *         description: Model pricing not found
 *       500:
 *         description: Internal server error
 */
router.delete('/pricing/:modelId', async (req: Request, res: Response) => {
  try {
    const modelId = req.params.modelId;
    const result = await execute('DELETE FROM model_pricing WHERE model_id = $1', [modelId]);

    if (result.rowCount === 0) {
      throw new NotFoundError('Model pricing not found');
      return;
    }

    res.json({ deleted: modelId });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Pricing delete');
  }
});

// ─── GET /api/analytics/models — Model comparison metrics ─────────────────────
// Aggregates cost, speed, quality, and usage metrics per model from historical data.
// Query params:
//   workspace_id — optional filter
//   from         — ISO date (inclusive), default 30 days ago
//   to           — ISO date (inclusive), default now

interface ModelComparisonRow {
  model: string;
  total_stories: number;
  passed_stories: number;
  failed_stories: number;
  avg_cost_usd: number;
  total_cost_usd: number;
  avg_elapsed_seconds: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
}

/**
 * @swagger
 * /api/analytics/models:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Model comparison metrics
 *     operationId: getModelComparison
 *     description: Aggregates cost, speed, quality, and usage metrics per model from historical token_usage and story_results data. Includes pass rate, average cost, average elapsed time, and an insufficient-data flag for models with fewer than 5 stories.
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *         description: Optional workspace filter
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Start date (inclusive), default 30 days ago
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *         description: End date (inclusive), default now
 *     responses:
 *       200:
 *         description: Model comparison data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 models:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       model: { type: string }
 *                       totalStories: { type: integer }
 *                       passedStories: { type: integer }
 *                       failedStories: { type: integer }
 *                       passRate: { type: number }
 *                       avgCostUsd: { type: number }
 *                       totalCostUsd: { type: number }
 *                       avgElapsedSeconds: { type: number }
 *                       avgInputTokens: { type: integer }
 *                       avgOutputTokens: { type: integer }
 *                       insufficientData: { type: boolean }
 *                 dateRange: { type: object }
 *       500:
 *         description: Internal server error
 */
router.get('/models', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    let paramIdx = 3;
    const wsFilter = workspaceId ? `AND tu.workspace_id = $${paramIdx++}` : '';
    const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

    // Join token_usage with story_results to get pass/fail + elapsed_seconds per story
    // token_usage has model, cost; story_results has status, elapsed_seconds
    const sql = `
      SELECT
        tu.model,
        COUNT(*)::int AS total_stories,
        SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END)::int AS passed_stories,
        SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END)::int AS failed_stories,
        AVG(tu.cost_usd) AS avg_cost_usd,
        SUM(tu.cost_usd) AS total_cost_usd,
        AVG(sr.elapsed_seconds) AS avg_elapsed_seconds,
        AVG(tu.input_tokens) AS avg_input_tokens,
        AVG(tu.output_tokens) AS avg_output_tokens
      FROM token_usage tu
      JOIN story_results sr ON tu.run_id = sr.run_id AND tu.story_id = sr.story_id
      WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2
      ${wsFilter}
      AND sr.status IN ('pass', 'fail')
      GROUP BY tu.model
      ORDER BY total_stories DESC
    `;

    const rows = await query<ModelComparisonRow>(sql, params);

    // Enrich with pass rate and insufficient data flag
    const models = rows.map(r => {
      const totalStories = parseInt(String(r.total_stories), 10) || 0;
      const passedStories = parseInt(String(r.passed_stories), 10) || 0;
      const failedStories = parseInt(String(r.failed_stories), 10) || 0;
      return {
        model: r.model,
        totalStories,
        passedStories,
        failedStories,
        passRate: totalStories > 0 ? passedStories / totalStories : 0,
        avgCostUsd: parseFloat(String(r.avg_cost_usd ?? 0)) || 0,
        totalCostUsd: parseFloat(String(r.total_cost_usd ?? 0)) || 0,
        avgElapsedSeconds: parseFloat(String(r.avg_elapsed_seconds ?? 0)) || 0,
        avgInputTokens: Math.round(parseFloat(String(r.avg_input_tokens ?? 0)) || 0),
        avgOutputTokens: Math.round(parseFloat(String(r.avg_output_tokens ?? 0)) || 0),
        insufficientData: totalStories < 5,
      };
    });

    res.json({ models, dateRange: { from, to } });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Models comparison');
  }
});

// ─── GET /api/analytics/velocity — Weekly story completion velocity ──────────
// Query params:
//   from         — ISO date (inclusive), default 12 weeks ago
//   to           — ISO date (inclusive), default now
//   workspace_id — optional filter
//   spec_id      — optional filter (spec slug)

interface VelocityWeek {
  week: string;        // ISO week label e.g. "2026-W08"
  week_start: string;  // Monday date e.g. "2026-02-16"
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  specs: string[];     // spec slugs completed that week
}

/**
 * @swagger
 * /api/analytics/velocity:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Weekly story completion velocity
 *     operationId: getVelocity
 *     description: Returns weekly story completion counts grouped by status (passed, failed, skipped) with a rolling 4-week average. Includes notable spec slugs per week and a list of available specs for filter dropdowns. Default range is 12 weeks.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Start date (inclusive), default 12 weeks ago
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *         description: End date (inclusive), default now
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *         description: Optional workspace filter
 *       - in: query
 *         name: spec_id
 *         schema: { type: string }
 *         description: Optional spec slug filter
 *     responses:
 *       200:
 *         description: Velocity data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 velocity:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       week: { type: string }
 *                       week_start: { type: string }
 *                       passed: { type: integer }
 *                       failed: { type: integer }
 *                       skipped: { type: integer }
 *                       total: { type: integer }
 *                       specs: { type: array, items: { type: string } }
 *                       rollingAvg: { type: number }
 *                 availableSpecs: { type: array, items: { type: string } }
 *                 dateRange: { type: object }
 *       500:
 *         description: Internal server error
 */
router.get('/velocity', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;
    const specId = req.query.spec_id as string | undefined;

    const now = new Date();
    const twelveWeeksAgo = new Date(now.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || twelveWeeksAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    // Build dynamic WHERE clauses
    let paramIdx = 1;
    const conditions: string[] = [`sr.finished_at >= $${paramIdx++}`, `sr.finished_at <= $${paramIdx++}`];
    const params: (string | number)[] = [from, to];

    if (workspaceId) {
      conditions.push(`pr.workspace_id = $${paramIdx++}`);
      params.push(workspaceId);
    }

    if (specId) {
      conditions.push(`REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') = $${paramIdx++}`);
      params.push(specId);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Weekly story counts grouped by status
    // PostgreSQL: to_char for ISO year-week, date_trunc('week', ...) for week start (Monday)
    const sql = `
      SELECT
        to_char(sr.finished_at, 'IYYY-"W"IW') AS week,
        date_trunc('week', sr.finished_at)::date AS week_start,
        SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN sr.status = 'skip' THEN 1 ELSE 0 END) AS skipped,
        COUNT(*)::int AS total
      FROM story_results sr
      JOIN pipeline_runs pr ON sr.run_id = pr.id
      ${whereClause}
      GROUP BY week, week_start
      ORDER BY week ASC
    `;

    const weeks = await query<VelocityWeek>(sql, params);

    // Fetch notable specs per week (distinct spec slugs that had stories finish)
    const specsSql = `
      SELECT
        to_char(sr.finished_at, 'IYYY-"W"IW') AS week,
        REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug
      FROM story_results sr
      JOIN pipeline_runs pr ON sr.run_id = pr.id
      ${whereClause}
      GROUP BY week, spec_slug
      ORDER BY week ASC
    `;

    const specRows = await query<{ week: string; spec_slug: string }>(specsSql, params);

    // Build a map of week → spec slugs
    const specsByWeek = new Map<string, string[]>();
    for (const row of specRows) {
      const arr = specsByWeek.get(row.week) || [];
      arr.push(row.spec_slug);
      specsByWeek.set(row.week, arr);
    }

    // Parse bigint/numeric DB values to numbers
    const parsedWeeks = weeks.map(w => ({
      ...w,
      passed: parseInt(String(w.passed), 10) || 0,
      failed: parseInt(String(w.failed), 10) || 0,
      skipped: parseInt(String(w.skipped), 10) || 0,
      total: parseInt(String(w.total), 10) || 0,
    }));

    // Attach specs to each week + compute rolling 4-week average
    const velocityData = parsedWeeks.map((w, i) => {
      // Rolling 4-week average of total stories
      const windowStart = Math.max(0, i - 3);
      const window = parsedWeeks.slice(windowStart, i + 1);
      const rollingAvg = window.reduce((sum, wk) => sum + wk.total, 0) / window.length;

      return {
        ...w,
        specs: specsByWeek.get(w.week) || [],
        rollingAvg: Math.round(rollingAvg * 10) / 10,
      };
    });

    // Available specs for the filter dropdown
    let specListParamIdx = 1;
    let specListSql = `
      SELECT DISTINCT
        REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug
      FROM pipeline_runs pr
      WHERE pr.spec_path IS NOT NULL
    `;
    const specListParams: string[] = [];
    if (workspaceId) {
      specListSql += ` AND pr.workspace_id = $${specListParamIdx++}`;
      specListParams.push(workspaceId);
    }
    specListSql += ' ORDER BY spec_slug ASC';

    const availableSpecs = await query<{ spec_slug: string }>(specListSql, specListParams);

    res.json({
      velocity: velocityData,
      availableSpecs: availableSpecs.map(s => s.spec_slug),
      dateRange: { from, to },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Velocity query');
  }
});

// ─── GET /api/analytics/completion-rates — Pass/fail/skip by complexity & tag ─
// Query params:
//   from         — ISO date (inclusive), default 30 days ago
//   to           — ISO date (inclusive), default now
//   workspace_id — optional filter

interface StoryResultRow {
  story_id: string;
  status: string;
  spec_path: string;
  workspace_id: string;
  workspace_path: string;
}

interface CompletionGroup {
  label: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  passRate: number;
}

/**
 * @swagger
 * /api/analytics/completion-rates:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Pass/fail/skip rates by complexity and tag
 *     operationId: getCompletionRates
 *     description: Returns story completion rates grouped by complexity level (1-5 plus unrated) and by spec tags. Reads spec JSON files from the filesystem to extract per-story complexity values. Lowest pass-rate tags are sorted first to highlight improvement opportunities.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Start date (inclusive), default 30 days ago
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *         description: End date (inclusive), default now
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *         description: Optional workspace filter
 *     responses:
 *       200:
 *         description: Completion rate data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 byComplexity:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       label: { type: string }
 *                       passed: { type: integer }
 *                       failed: { type: integer }
 *                       skipped: { type: integer }
 *                       total: { type: integer }
 *                       passRate: { type: number }
 *                 byTag:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       label: { type: string }
 *                       passed: { type: integer }
 *                       failed: { type: integer }
 *                       skipped: { type: integer }
 *                       total: { type: integer }
 *                       passRate: { type: number }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     passed: { type: integer }
 *                     failed: { type: integer }
 *                     skipped: { type: integer }
 *                     overallPassRate: { type: number }
 *                 dateRange: { type: object }
 *       500:
 *         description: Internal server error
 */
router.get('/completion-rates', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    // Fetch all story results in range joined with pipeline_runs for spec_path + workspace
    let paramIdx = 3;
    const wsFilter = workspaceId ? `AND pr.workspace_id = $${paramIdx++}` : '';
    const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

    const sql = `
      SELECT
        sr.story_id,
        sr.status,
        pr.spec_path,
        pr.workspace_id,
        w.path AS workspace_path
      FROM story_results sr
      JOIN pipeline_runs pr ON sr.run_id = pr.id
      JOIN workspaces w ON pr.workspace_id = w.id
      WHERE sr.finished_at >= $1 AND sr.finished_at <= $2
      ${wsFilter}
      AND sr.status IN ('pass', 'fail', 'skip')
    `;

    const rows = await query<StoryResultRow>(sql, params);

    // Build a cache of spec JSON files: specPath → parsed stories
    const specCache = new Map<string, { stories: any[]; tags: string[] }>();

    for (const row of rows) {
      if (specCache.has(row.spec_path)) continue;

      try {
        const absPath = path.join(row.workspace_path, row.spec_path);
        if (fs.existsSync(absPath)) {
          const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
          const stories: any[] = raw.userStories ?? raw.stories ?? [];

          // Get tags from spec_tags table
          const specId = row.spec_path
            .replace('forge/specs/approved/', '')
            .replace('forge/specs/pending/', '')
            .replace('.json', '');
          const tagRows = await query<{ tag_name: string }>(
            'SELECT tag_name FROM spec_tags WHERE spec_id = $1 AND workspace_id = $2 ORDER BY tag_name',
            [specId, row.workspace_id]
          );

          specCache.set(row.spec_path, {
            stories,
            tags: tagRows.map(t => t.tag_name),
          });
        } else {
          specCache.set(row.spec_path, { stories: [], tags: [] });
        }
      } catch {
        specCache.set(row.spec_path, { stories: [], tags: [] });
      }
    }

    // Group by complexity (1-5, plus "unrated" for stories without complexity)
    const complexityBuckets: Record<string, { passed: number; failed: number; skipped: number }> = {};
    // Group by tag
    const tagBuckets: Record<string, { passed: number; failed: number; skipped: number }> = {};

    for (const row of rows) {
      const spec = specCache.get(row.spec_path);
      const story = spec?.stories.find((s: any) => s.id === row.story_id);
      const complexity = story?.complexity;
      const complexityKey = complexity && complexity >= 1 && complexity <= 5
        ? String(complexity)
        : 'unrated';

      if (!complexityBuckets[complexityKey]) {
        complexityBuckets[complexityKey] = { passed: 0, failed: 0, skipped: 0 };
      }

      const bucket = complexityBuckets[complexityKey];
      if (row.status === 'pass') bucket.passed++;
      else if (row.status === 'fail') bucket.failed++;
      else if (row.status === 'skip') bucket.skipped++;

      // Tag buckets: each story contributes to ALL tags of its parent spec
      const tags = spec?.tags ?? [];
      for (const tag of tags) {
        if (!tagBuckets[tag]) {
          tagBuckets[tag] = { passed: 0, failed: 0, skipped: 0 };
        }
        const tb = tagBuckets[tag];
        if (row.status === 'pass') tb.passed++;
        else if (row.status === 'fail') tb.failed++;
        else if (row.status === 'skip') tb.skipped++;
      }
    }

    // Convert to sorted arrays
    const complexityLabels: Record<string, string> = {
      '1': '1 - Trivial',
      '2': '2 - Simple',
      '3': '3 - Moderate',
      '4': '4 - Complex',
      '5': '5 - Epic',
      'unrated': 'Unrated',
    };

    const byComplexity: CompletionGroup[] = ['1', '2', '3', '4', '5', 'unrated']
      .filter(k => complexityBuckets[k])
      .map(k => {
        const b = complexityBuckets[k];
        const total = b.passed + b.failed + b.skipped;
        return {
          label: complexityLabels[k] || k,
          passed: b.passed,
          failed: b.failed,
          skipped: b.skipped,
          total,
          passRate: total > 0 ? Math.round((b.passed / total) * 1000) / 10 : 0,
        };
      });

    const byTag: CompletionGroup[] = Object.entries(tagBuckets)
      .map(([tag, b]) => {
        const total = b.passed + b.failed + b.skipped;
        return {
          label: tag,
          passed: b.passed,
          failed: b.failed,
          skipped: b.skipped,
          total,
          passRate: total > 0 ? Math.round((b.passed / total) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => a.passRate - b.passRate); // lowest pass rate first (improvement opportunities at top)

    // Overall summary
    const totalPassed = rows.filter(r => r.status === 'pass').length;
    const totalFailed = rows.filter(r => r.status === 'fail').length;
    const totalSkipped = rows.filter(r => r.status === 'skip').length;
    const totalStories = rows.length;

    res.json({
      byComplexity,
      byTag,
      summary: {
        total: totalStories,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        overallPassRate: totalStories > 0
          ? Math.round((totalPassed / totalStories) * 1000) / 10
          : 0,
      },
      dateRange: { from, to },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Completion rates');
  }
});

// ─── GET /api/analytics/export — Export analytics data as CSV or JSON ────────
// Query params:
//   format     — 'csv' | 'json', required
//   data_type  — 'usage' | 'costs' | 'velocity' | 'completion', required
//   from       — ISO date (inclusive), default 30 days ago
//   to         — ISO date (inclusive), default now
//   workspace_id — optional filter
//   page       — page number (1-based), default 1
//   limit      — rows per page, max 10000, default 10000

const EXPORT_MAX_ROWS = 10000;

/**
 * Escape a field value for RFC 4180 CSV.
 * Fields containing commas, double-quotes, or newlines are quoted.
 * Embedded double-quotes are doubled.
 */
function csvField(value: unknown): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCsvRows(headers: string[], rows: Record<string, unknown>[]): string {
  const headerLine = headers.map(h => csvField(h)).join(',');
  const dataLines = rows.map(row =>
    headers.map(h => csvField(row[h])).join(',')
  );
  return headerLine + '\r\n' + dataLines.join('\r\n') + '\r\n';
}

interface ExportRow { [key: string]: unknown }

async function buildUsageExport(from: string, to: string, workspaceId?: string, limit?: number, offset?: number): Promise<{ rows: ExportRow[]; headers: string[]; total: number }> {
  let paramIdx = 1;
  const baseParams: (string | number)[] = [from, to];
  const wsFilter = workspaceId ? `AND tu.workspace_id = $${paramIdx + 2}` : '';
  if (workspaceId) baseParams.push(workspaceId);

  // Count total rows
  const countSql = `
    SELECT COUNT(*)::int AS total FROM token_usage tu
    WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2 ${wsFilter}
  `;
  const countResult = await queryOne<{ total: number }>(countSql, baseParams);
  const total = countResult?.total ?? 0;

  const limitIdx = baseParams.length + 1;
  const offsetIdx = baseParams.length + 2;
  const sql = `
    SELECT
      tu.model,
      tu.story_id,
      tu.input_tokens,
      tu.output_tokens,
      tu.cost_usd,
      tu.recorded_at,
      tu.workspace_id,
      COALESCE(tu.user_id, 'system') AS user_id
    FROM token_usage tu
    WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2 ${wsFilter}
    ORDER BY tu.recorded_at ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const rows = await query<ExportRow>(sql, [...baseParams, limit ?? EXPORT_MAX_ROWS, offset ?? 0]);
  const headers = ['model', 'story_id', 'input_tokens', 'output_tokens', 'cost_usd', 'recorded_at', 'workspace_id', 'user_id'];
  return { rows, headers, total };
}

async function buildCostsExport(from: string, to: string, workspaceId?: string, limit?: number, offset?: number): Promise<{ rows: ExportRow[]; headers: string[]; total: number }> {
  const baseParams: (string | number)[] = [from, to];
  const wsFilter = workspaceId ? `AND tu.workspace_id = $${baseParams.length + 1}` : '';
  if (workspaceId) baseParams.push(workspaceId);

  const countSql = `
    SELECT COUNT(*)::int AS total FROM token_usage tu
    LEFT JOIN model_pricing mp ON tu.model = mp.model_id
    JOIN pipeline_runs pr ON tu.run_id = pr.id
    WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2 ${wsFilter}
  `;
  const countResult = await queryOne<{ total: number }>(countSql, baseParams);
  const total = countResult?.total ?? 0;

  const limitIdx = baseParams.length + 1;
  const offsetIdx = baseParams.length + 2;
  const sql = `
    SELECT
      tu.model,
      REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug,
      tu.story_id,
      tu.input_tokens,
      tu.output_tokens,
      CASE WHEN mp.input_cost_per_1m IS NOT NULL
        THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
        ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
      END AS input_cost_usd,
      CASE WHEN mp.output_cost_per_1m IS NOT NULL
        THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
        ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
      END AS output_cost_usd,
      tu.cost_usd AS total_cost_usd,
      tu.recorded_at,
      tu.workspace_id
    FROM token_usage tu
    LEFT JOIN model_pricing mp ON tu.model = mp.model_id
    JOIN pipeline_runs pr ON tu.run_id = pr.id
    WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2 ${wsFilter}
    ORDER BY tu.recorded_at ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const rows = await query<ExportRow>(sql, [...baseParams, limit ?? EXPORT_MAX_ROWS, offset ?? 0]);
  const headers = ['model', 'spec_slug', 'story_id', 'input_tokens', 'output_tokens', 'input_cost_usd', 'output_cost_usd', 'total_cost_usd', 'recorded_at', 'workspace_id'];
  return { rows, headers, total };
}

async function buildVelocityExport(from: string, to: string, workspaceId?: string, limit?: number, offset?: number): Promise<{ rows: ExportRow[]; headers: string[]; total: number }> {
  let paramIdx = 1;
  const conditions: string[] = [`sr.finished_at >= $${paramIdx++}`, `sr.finished_at <= $${paramIdx++}`];
  const params: (string | number)[] = [from, to];

  if (workspaceId) {
    conditions.push(`pr.workspace_id = $${paramIdx++}`);
    params.push(workspaceId);
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    ${whereClause}
  `;
  const countResult = await queryOne<{ total: number }>(countSql, params);
  const total = countResult?.total ?? 0;

  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  const sql = `
    SELECT
      sr.story_id,
      sr.status,
      sr.finished_at,
      sr.elapsed_seconds,
      REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug,
      to_char(sr.finished_at, 'IYYY-"W"IW') AS week,
      pr.workspace_id
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    ${whereClause}
    ORDER BY sr.finished_at ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const rows = await query<ExportRow>(sql, [...params, limit ?? EXPORT_MAX_ROWS, offset ?? 0]);
  const headers = ['story_id', 'status', 'finished_at', 'elapsed_seconds', 'spec_slug', 'week', 'workspace_id'];
  return { rows, headers, total };
}

async function buildCompletionExport(from: string, to: string, workspaceId?: string, limit?: number, offset?: number): Promise<{ rows: ExportRow[]; headers: string[]; total: number }> {
  let paramIdx = 3;
  const wsFilter = workspaceId ? `AND pr.workspace_id = $${paramIdx++}` : '';
  const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    WHERE sr.finished_at >= $1 AND sr.finished_at <= $2 ${wsFilter}
    AND sr.status IN ('pass', 'fail', 'skip')
  `;
  const countResult = await queryOne<{ total: number }>(countSql, params);
  const total = countResult?.total ?? 0;

  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  const sql = `
    SELECT
      sr.story_id,
      sr.status,
      sr.finished_at,
      sr.elapsed_seconds,
      sr.input_tokens,
      sr.output_tokens,
      REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug,
      pr.workspace_id
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    WHERE sr.finished_at >= $1 AND sr.finished_at <= $2 ${wsFilter}
    AND sr.status IN ('pass', 'fail', 'skip')
    ORDER BY sr.finished_at ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const rows = await query<ExportRow>(sql, [...params, limit ?? EXPORT_MAX_ROWS, offset ?? 0]);
  const headers = ['story_id', 'status', 'finished_at', 'elapsed_seconds', 'input_tokens', 'output_tokens', 'spec_slug', 'workspace_id'];
  return { rows, headers, total };
}

/**
 * @swagger
 * /api/analytics/export:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Export analytics data (CSV or JSON)
 *     operationId: exportAnalyticsData
 *     description: Exports usage, costs, velocity, or completion data in CSV or JSON format. Supports pagination via page/limit params and returns X-Total-Count header and Link header for next page when results are truncated.
 *     parameters:
 *       - in: query
 *         name: format
 *         required: true
 *         schema: { type: string, enum: [csv, json] }
 *       - in: query
 *         name: data_type
 *         required: true
 *         schema: { type: string, enum: [usage, costs, velocity, completion] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Exported data
 *         content:
 *           text/csv:
 *             schema: { type: string }
 *           application/json:
 *             schema: { type: object }
 */
router.get('/export', async (req: Request, res: Response) => {
  try {
    const format = req.query.format as string;
    const dataType = req.query.data_type as string;
    const workspaceId = req.query.workspace_id as string | undefined;

    if (!format || !['csv', 'json'].includes(format)) {
      throw new ValidationError('format must be "csv" or "json"');
      return;
    }

    const validDataTypes = ['usage', 'costs', 'velocity', 'completion'];
    if (!dataType || !validDataTypes.includes(dataType)) {
      throw new ValidationError(`data_type must be one of: ${validDataTypes.join(', ')}`);
      return;
    }

    // Date range defaults
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    // Pagination
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(EXPORT_MAX_ROWS, Math.max(1, parseInt(req.query.limit as string, 10) || EXPORT_MAX_ROWS));
    const offset = (page - 1) * limit;

    // Fetch data
    let result: { rows: ExportRow[]; headers: string[]; total: number };

    switch (dataType) {
      case 'usage':
        result = await buildUsageExport(from, to, workspaceId, limit, offset);
        break;
      case 'costs':
        result = await buildCostsExport(from, to, workspaceId, limit, offset);
        break;
      case 'velocity':
        result = await buildVelocityExport(from, to, workspaceId, limit, offset);
        break;
      case 'completion':
        result = await buildCompletionExport(from, to, workspaceId, limit, offset);
        break;
      default:
        throw new ValidationError('Invalid data_type');
        return;
    }

    const { rows, headers, total } = result;

    // Timestamp for filename
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `rorca-${dataType}-${ts}`;

    // Link header for pagination when truncated
    const totalPages = Math.ceil(total / limit);
    if (page < totalPages) {
      const nextParams = new URLSearchParams({
        format,
        data_type: dataType,
        from,
        to,
        page: String(page + 1),
        limit: String(limit),
      });
      if (workspaceId) nextParams.set('workspace_id', workspaceId);
      res.setHeader('Link', `</api/analytics/export?${nextParams.toString()}>; rel="next"`);
    }

    // Set total count header for clients
    res.setHeader('X-Total-Count', String(total));

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(toCsvRows(headers, rows));
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      res.json({
        data: rows,
        meta: {
          total,
          page,
          limit,
          totalPages,
          dateRange: { from, to },
          dataType,
        },
      });
    }
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Export');
  }
});

// ─── GET /api/analytics/roi — ROI calculator ─────────────────────────────────
// Estimates developer hours saved based on passed stories, configurable rates,
// and actual LLM cost data. Deduplicates retried stories to avoid double-counting.
// Query params:
//   workspace_id — required
//   from         — ISO date (inclusive), default 30 days ago
//   to           — ISO date (inclusive), default now

interface WorkspaceROIConfig {
  id: string;
  roi_hours_per_story: number;
  roi_hourly_rate: number;
}

interface ROITimeSeriesRow {
  date: string;
  stories_passed: number;
  hours_saved: number;
  llm_cost: number;
  net_savings: number;
}

/**
 * @swagger
 * /api/analytics/roi:
 *   get:
 *     tags: [Analytics]
 *     summary: ROI calculator — estimated developer hours saved
 *     operationId: getRoiMetrics
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "ROI analytics are part of the commercial FinOps surface and should not be exposed through the free CLI contract."
 *     description: Calculates estimated developer hours saved based on passed stories, configurable hourly rate and hours-per-story values. Deduplicates retried stories and includes a daily time series for trend charts. Requires workspace_id.
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: ROI metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total_stories_passed: { type: integer }
 *                 estimated_hours_saved: { type: number }
 *                 total_llm_cost: { type: number }
 *                 net_savings: { type: number }
 *                 roi_multiplier: { type: number }
 *                 config: { type: object }
 *                 timeSeries: { type: array }
 *       400: { description: "Missing workspace_id" }
 *       404: { description: "Workspace not found" }
 */
router.get('/roi', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspace_id');
      return;
    }

    // Fetch workspace ROI config
    const workspace = await queryOne<WorkspaceROIConfig>(
      'SELECT id, roi_hours_per_story, roi_hourly_rate FROM workspaces WHERE id = $1',
      [workspaceId]
    );

    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const hoursPerStory = workspace.roi_hours_per_story ?? 4.0;
    const hourlyRate = workspace.roi_hourly_rate ?? 75.0;

    // Date range
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    // Count unique passed stories, deduplicating retries.
    // For each (run, story_id), take only the LATEST result (highest id).
    // Then only count stories whose latest status is 'pass'.
    // Also exclude retry runs' copied passes by grouping across all runs.
    const passedResult = await queryOne<{ total_stories_passed: number }>(`
      SELECT COUNT(*)::int AS total_stories_passed
      FROM (
        SELECT DISTINCT ON (pr.id, sr.story_id) sr.story_id, sr.status
        FROM story_results sr
        JOIN pipeline_runs pr ON sr.run_id = pr.id
        WHERE pr.workspace_id = $1
          AND sr.finished_at >= $2 AND sr.finished_at <= $3
          AND sr.status IN ('pass', 'fail', 'skip', 'retry', 'timeout')
        ORDER BY pr.id, sr.story_id, sr.id DESC
      ) latest
      WHERE latest.status = 'pass'
    `, [workspaceId, from, to]);

    const totalStoriesPassed = parseInt(String(passedResult?.total_stories_passed ?? 0), 10) || 0;

    // Get total LLM cost from token_usage for this workspace + date range
    const costResult = await queryOne<{ total_llm_cost: number }>(`
      SELECT COALESCE(SUM(tu.cost_usd), 0) AS total_llm_cost
      FROM token_usage tu
      WHERE tu.workspace_id = $1
        AND tu.recorded_at >= $2 AND tu.recorded_at <= $3
    `, [workspaceId, from, to]);

    const totalLlmCost = costResult?.total_llm_cost ?? 0;

    // Calculate ROI metrics
    const estimatedHoursSaved = totalStoriesPassed * hoursPerStory;
    const savingsValue = estimatedHoursSaved * hourlyRate;
    const netSavings = savingsValue - totalLlmCost;
    const roiMultiplier = totalLlmCost > 0
      ? Math.round((savingsValue / totalLlmCost) * 10) / 10
      : totalStoriesPassed > 0 ? Infinity : 0;

    // Time series: daily breakdown for trend chart
    const timeSeries = await query<{ date: string; stories_passed: number }>(`
      SELECT
        DATE(sr.finished_at) AS date,
        COUNT(DISTINCT sr.story_id || '-' || sr.run_id) AS stories_passed
      FROM story_results sr
      JOIN pipeline_runs pr ON sr.run_id = pr.id
      WHERE pr.workspace_id = $1
        AND sr.finished_at >= $2 AND sr.finished_at <= $3
        AND sr.status = 'pass'
      GROUP BY DATE(sr.finished_at)
      ORDER BY date ASC
    `, [workspaceId, from, to]);

    // Get daily LLM cost
    const dailyCosts = await query<{ date: string; llm_cost: number }>(`
      SELECT
        DATE(tu.recorded_at) AS date,
        COALESCE(SUM(tu.cost_usd), 0) AS llm_cost
      FROM token_usage tu
      WHERE tu.workspace_id = $1
        AND tu.recorded_at >= $2 AND tu.recorded_at <= $3
      GROUP BY DATE(tu.recorded_at)
      ORDER BY date ASC
    `, [workspaceId, from, to]);

    // Merge daily stories + costs into unified time series
    const costByDate = new Map(dailyCosts.map(r => [r.date, r.llm_cost]));
    const allDates = new Set([
      ...timeSeries.map(r => r.date),
      ...dailyCosts.map(r => r.date),
    ]);
    const sortedDates = Array.from(allDates).sort();

    let cumulativeHours = 0;
    let cumulativeCost = 0;
    const mergedTimeSeries: ROITimeSeriesRow[] = sortedDates.map(date => {
      const dayStories = timeSeries.find(r => r.date === date)?.stories_passed ?? 0;
      const dayCost = costByDate.get(date) ?? 0;
      const dayHours = dayStories * hoursPerStory;
      cumulativeHours += dayHours;
      cumulativeCost += dayCost;

      return {
        date,
        stories_passed: dayStories,
        hours_saved: Math.round(dayHours * 10) / 10,
        llm_cost: Math.round(dayCost * 100) / 100,
        net_savings: Math.round((cumulativeHours * hourlyRate - cumulativeCost) * 100) / 100,
      };
    });

    res.json({
      total_stories_passed: totalStoriesPassed,
      estimated_hours_saved: Math.round(estimatedHoursSaved * 10) / 10,
      total_llm_cost: Math.round(totalLlmCost * 100) / 100,
      savings_value: Math.round(savingsValue * 100) / 100,
      net_savings: Math.round(netSavings * 100) / 100,
      roi_multiplier: roiMultiplier === Infinity ? null : roiMultiplier,
      config: {
        hours_per_story: hoursPerStory,
        hourly_rate: hourlyRate,
      },
      timeSeries: mergedTimeSeries,
      dateRange: { from, to },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] ROI query');
  }
});

// ─── PUT /api/analytics/roi/config — Update ROI config for a workspace ───────

/**
 * @swagger
 * /api/analytics/roi/config:
 *   put:
 *     tags: [Analytics]
 *     summary: Update ROI calculator configuration
 *     operationId: updateRoiConfig
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "ROI configuration is part of the commercial FinOps feature set and belongs behind the paid plan boundary."
 *     description: Updates the ROI calculator configuration (hours_per_story and hourly_rate) for a specific workspace. These values are used by the ROI metrics endpoint to estimate developer hours saved and net savings.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspace_id]
 *             properties:
 *               workspace_id: { type: string }
 *               hours_per_story: { type: number }
 *               hourly_rate: { type: number }
 *     responses:
 *       200: { description: "Config updated" }
 *       400: { description: "Invalid input" }
 *       404: { description: "Workspace not found" }
 */
router.put('/roi/config', async (req: Request, res: Response) => {
  try {
    const { workspace_id, hours_per_story, hourly_rate } = req.body as {
      workspace_id: string;
      hours_per_story?: number;
      hourly_rate?: number;
    };

    if (!workspace_id) {
      throw new ValidationError('workspace_id is required');
      return;
    }

    const workspace = await queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = $1',
      [workspace_id]
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    if (hours_per_story != null) {
      if (hours_per_story < 0 || hours_per_story > 100) {
        throw new ValidationError('hours_per_story must be between 0 and 100');
        return;
      }
      await execute(
        'UPDATE workspaces SET roi_hours_per_story = $1 WHERE id = $2',
        [hours_per_story, workspace_id]
      );
    }

    if (hourly_rate != null) {
      if (hourly_rate < 0 || hourly_rate > 1000) {
        throw new ValidationError('hourly_rate must be between 0 and 1000');
        return;
      }
      await execute(
        'UPDATE workspaces SET roi_hourly_rate = $1 WHERE id = $2',
        [hourly_rate, workspace_id]
      );
    }

    const updated = await queryOne<{ roi_hours_per_story: number; roi_hourly_rate: number }>(
      'SELECT roi_hours_per_story, roi_hourly_rate FROM workspaces WHERE id = $1',
      [workspace_id]
    );

    res.json({
      workspace_id,
      hours_per_story: updated?.roi_hours_per_story,
      hourly_rate: updated?.roi_hourly_rate,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] ROI config update');
  }
});

// ─── GET /api/analytics/finops/run/:runId — Per-run FinOps dashboard data ───
// Returns: run summary table, savings vs all-opus, per-story cost breakdown,
// escalation log, and subscription detection.

interface FinOpsStoryRow {
  story_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface StoryResultUsageRow {
  story_id: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

interface TokenWalRow {
  story_id: string;
  payload: string | Record<string, unknown> | null;
  ts: string;
}

interface EscalationWalRow {
  story_id: string;
  payload: string;
  ts: string;
}

// Default Opus pricing (per 1M tokens) — used for baseline comparison
const OPUS_INPUT_PER_1M = 15.0;
const OPUS_OUTPUT_PER_1M = 75.0;

function normalizeFinOpsModel(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === 'unknown' || lower === 'null' || lower === 'undefined' || lower === '?') return null;

  return trimmed;
}

function finOpsModelPriority(model: string | null | undefined, fallbackModel: string, agentType: string): number {
  const normalized = normalizeFinOpsModel(model);
  if (!normalized) return 0;

  const lower = normalized.toLowerCase();
  if (lower === agentType.toLowerCase()) return 1;
  if (lower === fallbackModel.toLowerCase()) return 2;
  return 3;
}

function choosePreferredFinOpsModel(
  current: string | null | undefined,
  incoming: string | null | undefined,
  fallbackModel: string,
  agentType: string,
): string | null {
  const currentNormalized = normalizeFinOpsModel(current);
  const incomingNormalized = normalizeFinOpsModel(incoming);

  if (!currentNormalized) return incomingNormalized;
  if (!incomingNormalized) return currentNormalized;

  return finOpsModelPriority(incomingNormalized, fallbackModel, agentType) > finOpsModelPriority(currentNormalized, fallbackModel, agentType)
    ? incomingNormalized
    : currentNormalized;
}

function finalizeFinOpsModel(model: string | null | undefined, fallbackModel: string, agentType: string): string {
  return choosePreferredFinOpsModel(null, model, fallbackModel, agentType) ?? fallbackModel;
}

function tierFromModel(model: string): string {
  const normalized = normalizeFinOpsModel(model);
  if (!normalized) return 'unknown';

  const lower = normalized.toLowerCase();
  if (lower.includes('haiku') || lower.includes('mini') || lower.includes('flash')) return 'haiku';
  if (lower.includes('opus') || lower.includes('o3') || lower.includes('pro')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return 'unknown';
}

function parseWalPayload(payload: string | Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload === 'string') {
    try { return JSON.parse(payload) as Record<string, unknown>; } catch { return {}; }
  }
  return payload;
}

function pricingCandidates(model: string): string[] {
  const normalized = normalizeFinOpsModel(model);
  if (!normalized) return [];

  const parts = normalized.split('/').filter(Boolean);
  return Array.from(new Set([
    normalized,
    parts.length > 1 ? parts.slice(1).join('/') : normalized,
    parts.length > 2 ? parts.slice(2).join('/') : normalized,
    parts.at(-1) ?? normalized,
  ]));
}

function resolvePricing(pricingMap: Map<string, { input: number; output: number }>, model: string): { input: number; output: number } | undefined {
  for (const candidate of pricingCandidates(model)) {
    const pricing = pricingMap.get(candidate);
    if (pricing) return pricing;
  }
  return undefined;
}

/**
 * @swagger
 * /api/analytics/finops/run/{runId}:
 *   get:
 *     tags: [Analytics]
 *     summary: Per-run FinOps dashboard data
 *     operationId: getFinOpsRun
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "Per-run FinOps analytics are commercial cost visibility features and must stay outside the free CLI/MCP surface."
 *     description: >-
 *       Returns accounting-mode-aware FinOps data for a specific pipeline run. Instead
 *       of one ambiguous cost field, the response separates marginal metered API spend
 *       (accounting.meteredCostUsd), allocated subscription cost
 *       (accounting.allocatedSubscriptionCostUsd), and blended effective cost
 *       (accounting.blendedEffectiveCostUsd), classified via the shared FinOps
 *       accounting engine against the active billing profiles. Live runs surface
 *       provider/model rows immediately and update usage as story_token_update WAL
 *       events arrive. Subscription-only runs report truthful subscription usage volume
 *       with isSubscription=true, no fabricated per-run spend, and a null savings field.
 *       Mixed-provider runs aggregate across token_usage, story_results, and WAL updates.
 *       Per-story rows carry billingMode and metered cost; provenance carries billing
 *       mode, pricing coverage, and allocation modes.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *         description: The pipeline run ID
 *     responses:
 *       200:
 *         description: FinOps run data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runId: { type: integer }
 *                 agentType: { type: string }
 *                 isSubscription: { type: boolean }
 *                 billingMode: { type: string }
 *                 accounting: { type: object, description: "metered/allocated/blended totals, subscription usage, byMode, coverage" }
 *                 provenance: { type: object, description: "billing mode + pricing coverage + allocation provenance labels" }
 *                 runSummary: { type: array, items: { type: object } }
 *                 savings: { type: object, nullable: true }
 *                 totals: { type: object }
 *                 modelDistribution: { type: array, items: { type: object } }
 *                 perStory: { type: array, items: { type: object } }
 *                 escalationLog: { type: array, items: { type: object } }
 *       400:
 *         description: Invalid runId
 *       404:
 *         description: Run not found
 *       500:
 *         description: Internal server error
 */
router.get('/finops/run/:runId', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(req.params.runId as string, 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    // Check run exists and get agent info
    const run = await queryOne<{ id: number; agent: string | null; agent_type: string | null; agent_model: string | null; workspace_id: string; spec_path: string; status: string; started_at: string | null; finished_at: string | null }>(
      'SELECT id, agent, agent_type, agent_model, workspace_id, spec_path, status, started_at::text AS started_at, finished_at::text AS finished_at FROM pipeline_runs WHERE id = $1',
      [runId]
    );

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    const agentType = run.agent_type || run.agent || 'claude';
    const fallbackModel = run.agent_model || agentType;

    // Per-story token usage from all available sources. token_usage is the canonical analytics table,
    // story_results is a completion-time fallback, and story_token_update WAL events provide live data
    // while a run is still executing.
    const tokenUsageRows = await query<FinOpsStoryRow>(`
      SELECT story_id, model, input_tokens, output_tokens, cost_usd
      FROM token_usage
      WHERE run_id = $1
      ORDER BY recorded_at ASC
    `, [runId]);

    const storyResultRows = await query<StoryResultUsageRow>(`
      SELECT story_id, model_used AS model, input_tokens, output_tokens, cost_usd
      FROM story_results
      WHERE run_id = $1
        AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cost_usd IS NOT NULL)
      ORDER BY id ASC
    `, [runId]);

    const tokenWalRows = await query<TokenWalRow>(`
      SELECT story_id, payload, ts
      FROM wal_events
      WHERE event_type = 'story_token_update'
        AND (payload->>'run_id')::bigint = $1
      ORDER BY ts ASC
    `, [runId]);

    const stories: FinOpsStoryRow[] = tokenUsageRows.map((row) => ({
      story_id: row.story_id,
      model: finalizeFinOpsModel(row.model, fallbackModel, agentType),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      cost_usd: Number(row.cost_usd ?? 0),
    }));
    const coveredStoryIds = new Set(stories.map((story) => story.story_id));
    const storyIndexes = new Map<string, number[]>();
    for (const [index, story] of stories.entries()) {
      const existing = storyIndexes.get(story.story_id) ?? [];
      existing.push(index);
      storyIndexes.set(story.story_id, existing);
    }

    for (const row of storyResultRows) {
      const matchingIndexes = storyIndexes.get(row.story_id);
      if (matchingIndexes && matchingIndexes.length > 0) {
        for (const index of matchingIndexes) {
          stories[index].model = finalizeFinOpsModel(
            choosePreferredFinOpsModel(stories[index].model, row.model, fallbackModel, agentType),
            fallbackModel,
            agentType,
          );
        }
        coveredStoryIds.add(row.story_id);
        continue;
      }

      stories.push({
        story_id: row.story_id,
        model: finalizeFinOpsModel(row.model, fallbackModel, agentType),
        input_tokens: Number(row.input_tokens ?? 0),
        output_tokens: Number(row.output_tokens ?? 0),
        cost_usd: Number(row.cost_usd ?? 0),
      });
      coveredStoryIds.add(row.story_id);
    }

    const liveByStory = new Map<string, FinOpsStoryRow>();
    for (const row of tokenWalRows) {
      if (coveredStoryIds.has(row.story_id)) continue;
      const payload = parseWalPayload(row.payload);
      const previous = liveByStory.get(row.story_id) ?? {
        story_id: row.story_id,
        model: fallbackModel,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      };
      const cumulativeInput = payload.cumulative_input ?? payload.cumulative_input_tokens;
      const cumulativeOutput = payload.cumulative_output ?? payload.cumulative_output_tokens;
      const cumulativeCost = payload.cumulative_cost_usd;
      const hasCumulative = cumulativeInput != null || cumulativeOutput != null;
      liveByStory.set(row.story_id, {
        story_id: row.story_id,
        model: finalizeFinOpsModel(
          choosePreferredFinOpsModel(previous.model, payload.model as string | null | undefined, fallbackModel, agentType),
          fallbackModel,
          agentType,
        ),
        input_tokens: hasCumulative ? Number(cumulativeInput ?? previous.input_tokens ?? 0) : previous.input_tokens + Number(payload.input_tokens ?? 0),
        output_tokens: hasCumulative ? Number(cumulativeOutput ?? previous.output_tokens ?? 0) : previous.output_tokens + Number(payload.output_tokens ?? 0),
        cost_usd: cumulativeCost != null
          ? Number(cumulativeCost)
          : previous.cost_usd + Number(payload.cost_usd ?? 0),
      });
    }
    stories.push(...liveByStory.values());

    let usageAvailable = stories.some((story) => story.input_tokens > 0 || story.output_tokens > 0 || story.cost_usd > 0);

    if (stories.length === 0) {
      const workspace = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]);
      if (workspace) {
        try {
          const absSpecPath = path.join(workspace.path, run.spec_path);
          const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
          const specStories = Array.isArray(specJson.userStories) ? specJson.userStories : [];
          for (const story of specStories) {
            if (!story?.id) continue;
            stories.push({ story_id: story.id, model: fallbackModel, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
          }
        } catch { /* spec fallback is best-effort */ }
      }
    }

    usageAvailable = usageAvailable || stories.some((story) => story.input_tokens > 0 || story.output_tokens > 0 || story.cost_usd > 0);

    // Get model pricing for calculating costs from tokens
    const pricingRows = await query<{ model_id: string; input_cost_per_1m: number | null; output_cost_per_1m: number | null; input_cost_per_1k: number; output_cost_per_1k: number }>(
      'SELECT model_id, input_cost_per_1m, output_cost_per_1m, input_cost_per_1k, output_cost_per_1k FROM model_pricing'
    );

    const pricingMap = new Map<string, { input: number; output: number }>();
    for (const p of pricingRows) {
      pricingMap.set(p.model_id, {
        input: p.input_cost_per_1m ?? p.input_cost_per_1k * 1000,
        output: p.output_cost_per_1m ?? p.output_cost_per_1k * 1000,
      });
    }

    // FIN-004: classify this run's usage with the shared FIN-002 accounting engine
    // against the active FIN-001 billing profiles instead of assuming everything is
    // metered. Profiles are loaded for the run's lifetime window (started→finished),
    // falling back to a wide window for live runs that have not finished yet so an
    // in-flight subscription run is still classified truthfully.
    const profileFrom = run.started_at ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const profileTo = run.finished_at ?? new Date().toISOString();
    const profiles = await loadActiveBillingProfiles(profileFrom, profileTo, run.workspace_id);
    const accountingCtx = buildAccountingContext(pricingMap, profiles);

    // Project each accumulated story onto an accounting usage row. runId drives
    // by_runs allocation; story_id drives by_stories. reasoning_tokens is unknown
    // at this granularity, so it is zero (output already includes it upstream).
    const usageRows: HistoricalUsageRow[] = stories.map((s) => ({
      model: s.model,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      reasoning_tokens: 0,
      cost_usd: s.cost_usd,
      run_id: runId,
      story_id: s.story_id,
      recorded_at: run.started_at ?? null,
    }));
    const accounting = summarizeUsage(usageRows, accountingCtx);

    // The run's headline billing mode is the dominant mode across its rows. A run
    // is subscription-backed when no row is metered_api and at least one is a
    // subscription — these runs must NOT imply invoice-backed per-run spend.
    const billingMode: BillingMode = providerBillingMode(accounting);
    const meteredRecordCount = accounting.byMode.find((m) => m.mode === 'metered_api')?.recordCount ?? 0;
    const isSubscription = accounting.subscriptionUsage.recordCount > 0 && meteredRecordCount === 0;

    // Build per-story breakdown. `actualCost` is the marginal metered cost for the
    // story (zero for subscription/unpriced rows — never a fabricated number), while
    // `meteredCost` exposes the same value explicitly alongside the billing mode.
    const perStory = stories.map(s => {
      const record = toUsageRecord({
        model: s.model,
        input_tokens: s.input_tokens,
        output_tokens: s.output_tokens,
        reasoning_tokens: 0,
        cost_usd: s.cost_usd,
        run_id: runId,
        story_id: s.story_id,
        recorded_at: run.started_at ?? null,
      });
      const cls = classifyUsage(record, accountingCtx);
      const rate = accountingCtx.pricingFor(record);
      const metered = cls.mode === 'metered_api' ? (meteredCost(record, rate) ?? 0) : 0;
      const opusBaseline = (s.input_tokens / 1_000_000) * OPUS_INPUT_PER_1M + (s.output_tokens / 1_000_000) * OPUS_OUTPUT_PER_1M;
      return {
        storyId: s.story_id,
        model: s.model,
        tier: tierFromModel(s.model),
        billingMode: cls.mode,
        inputTokens: s.input_tokens,
        outputTokens: s.output_tokens,
        meteredCost: Math.round(metered * 10000) / 10000,
        actualCost: Math.round(metered * 10000) / 10000,
        opusBaseline: Math.round(opusBaseline * 10000) / 10000,
      };
    });

    // Run summary: aggregate by model
    const modelSummary = new Map<string, { stories: number; inputTokens: number; outputTokens: number; cost: number }>();
    for (const s of perStory) {
      const existing = modelSummary.get(s.model) || { stories: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      existing.stories++;
      existing.inputTokens += s.inputTokens;
      existing.outputTokens += s.outputTokens;
      existing.cost += s.meteredCost;
      modelSummary.set(s.model, existing);
    }

    const runSummary = Array.from(modelSummary.entries()).map(([model, data]) => ({
      model,
      tier: tierFromModel(model),
      stories: data.stories,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cost: Math.round(data.cost * 10000) / 10000,
    }));

    // Totals — savings compares marginal metered spend against an all-Opus metered
    // baseline, so subscription/unpriced rows contribute zero metered cost (and are
    // excluded from a misleading savings number for subscription-only runs below).
    const totalMetered = accounting.meteredCostUsd;
    const totalOpusBaseline = perStory.reduce((sum, s) => sum + s.opusBaseline, 0);
    const totalSaved = totalOpusBaseline - totalMetered;
    const savingsPct = totalOpusBaseline > 0 ? (totalSaved / totalOpusBaseline) * 100 : 0;

    // Model distribution (for pie chart)
    const tierCounts: Record<string, number> = { haiku: 0, sonnet: 0, opus: 0 };
    for (const s of perStory) {
      const tier = s.tier;
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    }
    const totalStories = perStory.length;
    const modelDistribution = Object.entries(tierCounts)
      .filter(([, count]) => count > 0)
      .map(([tier, count]) => ({
        tier,
        count,
        percentage: totalStories > 0 ? Math.round((count / totalStories) * 1000) / 10 : 0,
      }));

    // Escalation log from WAL events
    // Use parameterized query with text search pattern
    const escalationEvents = await query<EscalationWalRow>(`
      SELECT story_id, payload, ts
      FROM wal_events
      WHERE event_type = 'story_escalated'
        AND payload::text LIKE '%"run_id":' || $1::text || '%'
      ORDER BY ts ASC
    `, [runId]);

    const escalationLog = escalationEvents.map(e => {
      const payload = JSON.parse(e.payload || '{}');
      return {
        storyId: e.story_id,
        fromTier: payload.fromTier || '?',
        toTier: payload.toTier || '?',
        attemptNumber: payload.attemptNumber ?? 0,
        errorCategory: payload.error_category || null,
        errorMessage: payload.error_message || null,
        ts: e.ts,
        additionalCost: 0, // will be computed below
      };
    });

    // Compute additional cost per escalation (cost of subsequent attempts)
    for (const esc of escalationLog) {
      const storyRows = perStory.filter(s => s.storyId === esc.storyId);
      if (storyRows.length > 1) {
        // The additional cost is the sum of all rows after the first for this story
        esc.additionalCost = Math.round(storyRows.slice(1).reduce((sum, s) => sum + s.actualCost, 0) * 10000) / 10000;
      }
    }

    res.json({
      runId,
      agentType,
      agentModel: fallbackModel,
      usageAvailable,
      isSubscription,
      billingMode,
      // FIN-004: accounting-mode-aware cost surface — metered marginal spend,
      // allocated subscription cost, and blended effective cost are reported
      // separately rather than collapsed into one ambiguous `cost` field. This is
      // the canonical per-run accounting block, mirroring the historical view.
      accounting: {
        meteredCostUsd: accounting.meteredCostUsd,
        allocatedSubscriptionCostUsd: accounting.allocatedSubscriptionCostUsd,
        blendedEffectiveCostUsd: accounting.blendedEffectiveCostUsd,
        subscriptionUsage: accounting.subscriptionUsage,
        byMode: accounting.byMode,
        coverage: accounting.coverage,
      },
      // Provenance labels so the dashboard can tell a truthful story: whether the
      // numbers are metered, allocated, or blended, and how much usage was priced.
      provenance: {
        billingMode,
        isSubscription,
        hasMeteredSpend: accounting.meteredCostUsd > 0,
        hasAllocatedCost: accounting.coverage.hasAllocatedCost,
        hasBlendedCost: accounting.coverage.hasBlendedCost,
        pricingCoverage: accounting.coverage.pricingCoverage,
        unpricedRecords: accounting.coverage.unpricedRecords,
        profileClassifiedRecords: accounting.coverage.profileClassifiedRecords,
        allocationModes: accounting.coverage.allocationModes,
      },
      runSummary,
      // Savings is a metered-vs-Opus comparison; it is null for subscription-only
      // runs so we never imply invoice-backed marginal savings where none exist.
      savings: isSubscription ? null : {
        opusBaseline: Math.round(totalOpusBaseline * 100) / 100,
        actual: Math.round(totalMetered * 100) / 100,
        saved: Math.round(totalSaved * 100) / 100,
        percentage: Math.round(savingsPct * 10) / 10,
      },
      totals: {
        stories: totalStories,
        inputTokens: perStory.reduce((sum, s) => sum + s.inputTokens, 0),
        outputTokens: perStory.reduce((sum, s) => sum + s.outputTokens, 0),
        // `cost` stays for backward compatibility, now the blended effective cost.
        cost: Math.round(accounting.blendedEffectiveCostUsd * 100) / 100,
        meteredCostUsd: accounting.meteredCostUsd,
        allocatedSubscriptionCostUsd: accounting.allocatedSubscriptionCostUsd,
        blendedEffectiveCostUsd: accounting.blendedEffectiveCostUsd,
      },
      modelDistribution,
      perStory,
      escalationLog,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] FinOps run query');
  }
});

// ─── Historical FinOps accounting helpers (FIN-003) ──────────────────────────
// The historical FinOps view must stop reporting a single ambiguous "total cost".
// It classifies every token_usage row via the shared FIN-002 accounting engine
// against the active FIN-001 billing profiles, then reports metered API spend,
// allocated subscription cost, blended effective cost, subscription usage volume,
// and coverage/provenance — separately and consistently across every aggregation.

/** A raw token_usage row projected for accounting. Shared across aggregations. */
interface HistoricalUsageRow {
  model: string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  reasoning_tokens: number | string | null;
  cost_usd: number | string | null;
  run_id: number | string | null;
  story_id: string | null;
  recorded_at: string | null;
  /** Joined workspace id (present in the historical aggregation query). */
  workspace_id?: string | null;
  /** Joined workspace label, falling back to the workspace id. */
  workspace_label?: string | null;
  /** Spec slug derived from the joined pipeline_runs.spec_path. */
  spec_slug?: string | null;
}

/**
 * Derive the billing provider for a model id, mirroring the pi-providers SQL:
 *   pi/openai/gpt-4.1   → openai   (pi wrapper: provider is the 2nd segment)
 *   openrouter/google/… → openrouter (other slash form: 1st segment)
 *   openai/gpt-4o        → openai
 *   claude-sonnet-4-5    → anthropic (un-prefixed Anthropic model)
 *   gpt-4o               → openai    (un-prefixed OpenAI model)
 * Falls back to the leading segment, then the whole string, lower-cased.
 */
function providerFromModel(model: string): string {
  const normalized = (normalizeFinOpsModel(model) ?? '').toLowerCase();
  if (!normalized) return 'unknown';

  if (normalized.startsWith('pi/')) {
    const seg = normalized.split('/')[1];
    if (seg) return seg;
  }
  const slash = normalized.indexOf('/');
  if (slash > 0) return normalized.slice(0, slash);

  // Un-prefixed model names — infer provider family from well-known prefixes.
  if (normalized.startsWith('claude')) return 'anthropic';
  if (normalized.startsWith('gpt') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('codex')) return 'openai';
  if (normalized.startsWith('gemini')) return 'google';
  return normalized;
}

/** Project a raw token_usage row onto the engine's provider-agnostic UsageRecord. */
function toUsageRecord(row: HistoricalUsageRow): UsageRecord {
  return {
    provider: providerFromModel(row.model),
    model: row.model,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    reasoningTokens: Number(row.reasoning_tokens ?? 0),
    runId: row.run_id == null ? null : String(row.run_id),
    storyId: row.story_id,
    day: row.recorded_at,
  };
}

/**
 * Load the active billing profiles that apply to the requested window + workspace.
 *
 * Order matters for the engine (first match wins), so the most specific profiles
 * are returned first: workspace-scoped before global, and within each scope the
 * most recently effective profile first. Only enabled profiles whose effective
 * window overlaps [from, to] are returned — date filtering happens in SQL so an
 * expired or not-yet-effective subscription never silently allocates cost.
 */
async function loadActiveBillingProfiles(
  from: string,
  to: string,
  workspaceId: string | undefined,
): Promise<BillingProfile[]> {
  const params: (string | null)[] = [from, to];
  let wsClause = 'AND (workspace_id IS NULL)';
  if (workspaceId) {
    params.push(workspaceId);
    wsClause = `AND (workspace_id IS NULL OR workspace_id = $${params.length})`;
  }

  const rows = await query<BillingProfileRow>(
    `SELECT * FROM billing_profiles
       WHERE enabled = TRUE
         AND effective_from <= $2
         AND (effective_to IS NULL OR effective_to >= $1)
         ${wsClause}
       ORDER BY (workspace_id IS NOT NULL) DESC,
                (model_pattern IS NOT NULL) DESC,
                effective_from DESC`,
    params,
  );
  return rows.map(rowToBillingProfile);
}

/**
 * Build the accounting context: a per-token pricing resolver (converting the
 * per-1M model_pricing rates to per-token) plus the active billing profiles.
 */
function buildAccountingContext(
  pricingMap: Map<string, { input: number; output: number }>,
  profiles: readonly BillingProfile[],
): AccountingContext {
  return {
    profiles,
    pricingFor: (record): PricingRate | null => {
      const per1m = resolvePricing(pricingMap, record.model);
      if (!per1m) return null;
      // pricingMap holds USD per 1,000,000 tokens; the engine bills per token.
      return { input: per1m.input / 1_000_000, output: per1m.output / 1_000_000 };
    },
  };
}

/** Round a USD value to cents. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round a coverage fraction to 3 decimals, preserving null (no metered rows). */
function roundCoverage(value: number | null): number | null {
  return value == null ? null : Math.round(value * 1000) / 1000;
}

/**
 * The accounting-mode-aware cost shape attached to every historical aggregation
 * (overall, per provider/workspace/spec/month). This replaces the old single
 * ambiguous `totalCost`/`total_cost` number.
 */
interface AccountingSummary {
  meteredCostUsd: number;
  allocatedSubscriptionCostUsd: number;
  blendedEffectiveCostUsd: number;
  /** Token volume that ran under a subscription billing mode (no marginal cost). */
  subscriptionUsage: { inputTokens: number; outputTokens: number; reasoningTokens: number; recordCount: number };
  /** Per-billing-mode rollup so the dashboard can show the accounting breakdown. */
  byMode: Array<{
    mode: BillingMode;
    recordCount: number;
    meteredCostUsd: number;
    allocatedCostUsd: number;
    blendedCostUsd: number;
  }>;
  coverage: {
    totalRecords: number;
    profileClassifiedRecords: number;
    pricedRecords: number;
    unpricedRecords: number;
    pricingCoverage: number | null;
    allocationModes: string[];
    hasAllocatedCost: boolean;
    hasBlendedCost: boolean;
  };
}

/** Run the engine over a set of usage rows and serialize an AccountingSummary. */
function summarizeUsage(rows: HistoricalUsageRow[], ctx: AccountingContext): AccountingSummary {
  const result: AccountingResult = computeAccounting(rows.map(toUsageRecord), ctx);
  const subscription = result.byMode.find((m) => m.mode === 'subscription');
  return {
    meteredCostUsd: round2(result.meteredCostUsd),
    allocatedSubscriptionCostUsd: round2(result.allocatedSubscriptionCostUsd),
    blendedEffectiveCostUsd: round2(result.blendedEffectiveCostUsd),
    subscriptionUsage: {
      inputTokens: subscription?.inputTokens ?? 0,
      outputTokens: subscription?.outputTokens ?? 0,
      reasoningTokens: subscription?.reasoningTokens ?? 0,
      recordCount: subscription?.recordCount ?? 0,
    },
    byMode: result.byMode.map((m) => ({
      mode: m.mode,
      recordCount: m.recordCount,
      meteredCostUsd: round2(m.meteredCostUsd),
      allocatedCostUsd: round2(m.allocatedCostUsd),
      blendedCostUsd: round2(m.blendedCostUsd),
    })),
    coverage: {
      totalRecords: result.coverage.totalRecords,
      profileClassifiedRecords: result.coverage.profileClassifiedRecords,
      pricedRecords: result.coverage.pricedRecords,
      unpricedRecords: result.coverage.unpricedRecords,
      pricingCoverage: roundCoverage(result.coverage.pricingCoverage),
      allocationModes: result.coverage.allocationModes.slice(),
      hasAllocatedCost: result.coverage.hasAllocatedCost,
      hasBlendedCost: result.coverage.hasBlendedCost,
    },
  };
}

/** Reduce a recorded_at timestamp to its UTC calendar day (`YYYY-MM-DD`). */
function calendarDayKey(value: string | null): string {
  if (!value) return 'unknown';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (m) return m[1];
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 10);
}

/** Pick the dominant (most rows) billing mode from an accounting summary. */
function providerBillingMode(acct: AccountingSummary): BillingMode {
  const dominant = acct.byMode.reduce<{ mode: BillingMode; recordCount: number } | null>(
    (best, m) => (best == null || m.recordCount > best.recordCount ? { mode: m.mode, recordCount: m.recordCount } : best),
    null,
  );
  return dominant?.mode ?? 'unknown';
}

/** Group raw usage rows by a key extractor, preserving first-seen order. */
function groupRows<K>(rows: HistoricalUsageRow[], keyOf: (row: HistoricalUsageRow) => K): Map<K, HistoricalUsageRow[]> {
  const out = new Map<K, HistoricalUsageRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const arr = out.get(key);
    if (arr) arr.push(row);
    else out.set(key, [row]);
  }
  return out;
}

// ─── GET /api/analytics/finops/historical — Historical FinOps data ───────────
// Cumulative cost by workspace, spec, month; trend chart; projections.
// Query params:
//   workspace_id — optional filter
//   from         — ISO date (inclusive), default 90 days ago
//   to           — ISO date (inclusive), default now

/**
 * @swagger
 * /api/analytics/finops/historical:
 *   get:
 *     tags: [Analytics]
 *     summary: Historical FinOps data
 *     operationId: getFinOpsHistorical
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "Historical FinOps reporting is a commercial analytics feature and should not be part of the free contract."
 *     description: >-
 *       Returns accounting-mode-aware historical FinOps data. Instead of a single
 *       ambiguous total cost, every aggregation separates metered API spend
 *       (meteredCostUsd), allocated subscription cost (allocatedSubscriptionCostUsd),
 *       blended effective cost (blendedEffectiveCostUsd), subscription token usage,
 *       per-billing-mode rollups, and coverage/provenance (priced vs unpriced rows,
 *       allocation modes applied, profile-classified counts). Runs are classified
 *       via the shared FinOps accounting engine against the active billing profiles.
 *       Daily/workspace/spec/month/provider aggregations carry billing mode and
 *       coverage semantics consistently. Run and story counts are derived from
 *       execution rows so they stay populated where token history is incomplete.
 *       Default range is 90 days. The savings field compares metered marginal spend
 *       to an all-Opus baseline and is null when the window is subscription-only.
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *         description: Optional workspace filter
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Start date (inclusive), default 90 days ago
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *         description: End date (inclusive), default now
 *     responses:
 *       200:
 *         description: Historical FinOps data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accounting: { type: object, description: "Window-wide metered/allocated/blended totals, subscription usage, byMode, coverage" }
 *                 dailyTrend: { type: array, items: { type: object } }
 *                 byWorkspace: { type: array, items: { type: object } }
 *                 bySpec: { type: array, items: { type: object } }
 *                 byMonth: { type: array, items: { type: object } }
 *                 byProvider: { type: array, items: { type: object } }
 *                 modelDistribution: { type: array, items: { type: object } }
 *                 projectedMonthlyCost: { type: number }
 *                 savings: { type: object, nullable: true }
 *                 allSubscription: { type: boolean }
 *                 coverage: { type: object }
 *                 dateRange: { type: object }
 *       500:
 *         description: Internal server error
 */
router.get('/finops/historical', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || ninetyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const wsFilter = workspaceId ? `AND tu.workspace_id = $3` : '';
    const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

    // FIN-003: Pull the raw usage rows for the whole window ONCE, joined to the
    // workspace label and spec slug, then classify + account for them in JS via
    // the shared FIN-002 engine. Doing every aggregation off the same classified
    // row set guarantees provider/workspace/spec/month numbers agree, and lets us
    // separate metered API spend from allocated subscription cost everywhere.
    //
    // Run/story COUNTS continue to be derived from execution rows (recorded_at)
    // even when token columns are zero/incomplete, so date-range run and story
    // counts stay populated where token history is sparse — only the cost/token
    // provenance is gated on pricing + billing-mode classification.
    const rowsSql = `
      SELECT
        tu.model,
        COALESCE(tu.input_tokens, 0) AS input_tokens,
        COALESCE(tu.output_tokens, 0) AS output_tokens,
        COALESCE(tu.reasoning_tokens, 0) AS reasoning_tokens,
        COALESCE(tu.cost_usd, 0) AS cost_usd,
        tu.run_id,
        tu.story_id,
        tu.recorded_at::text AS recorded_at,
        tu.workspace_id,
        COALESCE(w.label, tu.workspace_id) AS workspace_label,
        REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug
      FROM token_usage tu
      LEFT JOIN workspaces w ON tu.workspace_id = w.id
      LEFT JOIN pipeline_runs pr ON tu.run_id = pr.id
      WHERE tu.recorded_at >= $1 AND tu.recorded_at <= $2 ${wsFilter}
      ORDER BY tu.recorded_at ASC
    `;
    const rawRows = await query<HistoricalUsageRow & {
      workspace_id: string | null; workspace_label: string | null; spec_slug: string | null;
    }>(rowsSql, params);

    // Build the accounting context: active billing profiles + per-token pricing.
    const pricingRows = await query<{
      model_id: string; input_cost_per_1m: number | null; output_cost_per_1m: number | null;
      input_cost_per_1k: number; output_cost_per_1k: number;
    }>('SELECT model_id, input_cost_per_1m, output_cost_per_1m, input_cost_per_1k, output_cost_per_1k FROM model_pricing');
    const pricingMap = new Map<string, { input: number; output: number }>();
    for (const p of pricingRows) {
      pricingMap.set(p.model_id, {
        input: p.input_cost_per_1m ?? p.input_cost_per_1k * 1000,
        output: p.output_cost_per_1m ?? p.output_cost_per_1k * 1000,
      });
    }
    const profiles = await loadActiveBillingProfiles(from, to, workspaceId);
    const ctx = buildAccountingContext(pricingMap, profiles);

    // Distinct run / story counts off execution rows, independent of token volume.
    const distinctRuns = (rows: HistoricalUsageRow[]): number =>
      new Set(rows.filter((r) => r.run_id != null).map((r) => String(r.run_id))).size;
    const distinctStories = (rows: HistoricalUsageRow[]): number =>
      new Set(rows.filter((r) => r.story_id != null).map((r) => `${r.story_id}-${r.run_id}`)).size;

    // Overall accounting across the whole window.
    const overall = summarizeUsage(rawRows, ctx);

    // ── Daily trend (chart) ───────────────────────────────────────────────────
    const byDay = groupRows(rawRows, (r) => calendarDayKey(r.recorded_at));
    const dailyTrend = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rows]) => {
        const acct = summarizeUsage(rows, ctx);
        return {
          date,
          // `cost` stays as the headline number for existing charts, now blended.
          cost: acct.blendedEffectiveCostUsd,
          meteredCostUsd: acct.meteredCostUsd,
          allocatedSubscriptionCostUsd: acct.allocatedSubscriptionCostUsd,
          blendedEffectiveCostUsd: acct.blendedEffectiveCostUsd,
          inputTokens: rows.reduce((s, r) => s + Number(r.input_tokens ?? 0), 0),
          outputTokens: rows.reduce((s, r) => s + Number(r.output_tokens ?? 0), 0),
          reasoningTokens: rows.reduce((s, r) => s + Number(r.reasoning_tokens ?? 0), 0),
          storyCount: distinctStories(rows),
          coverage: acct.coverage,
        };
      });

    // ── By workspace ──────────────────────────────────────────────────────────
    const byWorkspaceGroups = groupRows(rawRows, (r) => r.workspace_id ?? 'unknown');
    const byWorkspace = Array.from(byWorkspaceGroups.entries())
      .map(([wsId, rows]) => {
        const acct = summarizeUsage(rows, ctx);
        return {
          workspaceId: wsId,
          label: rows[0]?.workspace_label ?? wsId,
          totalCost: acct.blendedEffectiveCostUsd,
          meteredCostUsd: acct.meteredCostUsd,
          allocatedSubscriptionCostUsd: acct.allocatedSubscriptionCostUsd,
          blendedEffectiveCostUsd: acct.blendedEffectiveCostUsd,
          subscriptionUsage: acct.subscriptionUsage,
          inputTokens: rows.reduce((s, r) => s + Number(r.input_tokens ?? 0), 0),
          outputTokens: rows.reduce((s, r) => s + Number(r.output_tokens ?? 0), 0),
          runCount: distinctRuns(rows),
          byMode: acct.byMode,
          coverage: acct.coverage,
        };
      })
      .sort((a, b) => b.blendedEffectiveCostUsd - a.blendedEffectiveCostUsd);

    // ── By spec ───────────────────────────────────────────────────────────────
    const bySpecGroups = groupRows(rawRows.filter((r) => r.spec_slug != null), (r) => r.spec_slug as string);
    const bySpec = Array.from(bySpecGroups.entries())
      .map(([specSlug, rows]) => {
        const acct = summarizeUsage(rows, ctx);
        return {
          specSlug,
          totalCost: acct.blendedEffectiveCostUsd,
          meteredCostUsd: acct.meteredCostUsd,
          allocatedSubscriptionCostUsd: acct.allocatedSubscriptionCostUsd,
          blendedEffectiveCostUsd: acct.blendedEffectiveCostUsd,
          subscriptionUsage: acct.subscriptionUsage,
          inputTokens: rows.reduce((s, r) => s + Number(r.input_tokens ?? 0), 0),
          outputTokens: rows.reduce((s, r) => s + Number(r.output_tokens ?? 0), 0),
          runCount: distinctRuns(rows),
          byMode: acct.byMode,
          coverage: acct.coverage,
        };
      })
      .sort((a, b) => b.blendedEffectiveCostUsd - a.blendedEffectiveCostUsd)
      .slice(0, 20);

    // ── By month ──────────────────────────────────────────────────────────────
    const byMonthGroups = groupRows(rawRows, (r) => calendarDayKey(r.recorded_at).slice(0, 7));
    const byMonth = Array.from(byMonthGroups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, rows]) => {
        const acct = summarizeUsage(rows, ctx);
        return {
          month,
          totalCost: acct.blendedEffectiveCostUsd,
          meteredCostUsd: acct.meteredCostUsd,
          allocatedSubscriptionCostUsd: acct.allocatedSubscriptionCostUsd,
          blendedEffectiveCostUsd: acct.blendedEffectiveCostUsd,
          subscriptionUsage: acct.subscriptionUsage,
          inputTokens: rows.reduce((s, r) => s + Number(r.input_tokens ?? 0), 0),
          outputTokens: rows.reduce((s, r) => s + Number(r.output_tokens ?? 0), 0),
          reasoningTokens: rows.reduce((s, r) => s + Number(r.reasoning_tokens ?? 0), 0),
          runCount: distinctRuns(rows),
          storyCount: distinctStories(rows),
          byMode: acct.byMode,
          coverage: acct.coverage,
        };
      });

    // ── By provider (accounting-mode aware) ───────────────────────────────────
    const byProviderGroups = groupRows(rawRows, (r) => providerFromModel(r.model));
    const byProvider = Array.from(byProviderGroups.entries())
      .map(([provider, rows]) => {
        const acct = summarizeUsage(rows, ctx);
        // A provider's headline billing mode is the one carrying the most rows,
        // so the dashboard can label it (metered vs subscription) consistently.
        const dominant = acct.byMode.reduce<{ mode: BillingMode; recordCount: number } | null>(
          (best, m) => (best == null || m.recordCount > best.recordCount ? { mode: m.mode, recordCount: m.recordCount } : best),
          null,
        );
        return {
          provider,
          billingMode: dominant?.mode ?? 'unknown',
          meteredCostUsd: acct.meteredCostUsd,
          allocatedSubscriptionCostUsd: acct.allocatedSubscriptionCostUsd,
          blendedEffectiveCostUsd: acct.blendedEffectiveCostUsd,
          subscriptionUsage: acct.subscriptionUsage,
          inputTokens: rows.reduce((s, r) => s + Number(r.input_tokens ?? 0), 0),
          outputTokens: rows.reduce((s, r) => s + Number(r.output_tokens ?? 0), 0),
          runCount: distinctRuns(rows),
          storyCount: distinctStories(rows),
          byMode: acct.byMode,
          coverage: acct.coverage,
        };
      })
      .sort((a, b) => b.blendedEffectiveCostUsd - a.blendedEffectiveCostUsd);

    // ── Model distribution ────────────────────────────────────────────────────
    const byModelGroups = groupRows(rawRows, (r) => r.model);
    const modelDistEntries = Array.from(byModelGroups.entries()).map(([model, rows]) => {
      const acct = summarizeUsage(rows, ctx);
      return {
        model,
        tier: tierFromModel(model),
        billingMode: providerBillingMode(acct),
        storyCount: distinctStories(rows),
        meteredCostUsd: acct.meteredCostUsd,
        allocatedSubscriptionCostUsd: acct.allocatedSubscriptionCostUsd,
        blendedEffectiveCostUsd: acct.blendedEffectiveCostUsd,
        // `totalCost` kept for backward compatibility — now blended effective.
        totalCost: acct.blendedEffectiveCostUsd,
        coverage: acct.coverage,
      };
    });
    const totalStories = modelDistEntries.reduce((sum, m) => sum + m.storyCount, 0);
    const modelDistribution = modelDistEntries
      .sort((a, b) => b.storyCount - a.storyCount)
      .map((m) => ({
        ...m,
        percentage: totalStories > 0 ? Math.round((m.storyCount / totalStories) * 1000) / 10 : 0,
      }));

    // ── Projection: avg daily blended cost * 30 ───────────────────────────────
    const totalBlendedInRange = dailyTrend.reduce((sum, d) => sum + d.blendedEffectiveCostUsd, 0);
    const daysWithData = dailyTrend.length;
    const avgDailyCost = daysWithData > 0 ? totalBlendedInRange / daysWithData : 0;
    const projectedMonthlyCost = round2(avgDailyCost * 30);

    // ── Savings vs all-Opus baseline (metered comparison only) ─────────────────
    // Savings compares metered marginal spend to an all-Opus metered baseline, so
    // allocated subscription cost is intentionally excluded from this comparison.
    let opusBaseline = 0;
    for (const r of rawRows) {
      opusBaseline += (Number(r.input_tokens ?? 0) / 1_000_000) * OPUS_INPUT_PER_1M
        + (Number(r.output_tokens ?? 0) / 1_000_000) * OPUS_OUTPUT_PER_1M;
    }
    const actualMeteredCost = overall.meteredCostUsd;

    // Whether the entire window ran under subscription billing (no metered spend).
    const allSubscription = overall.coverage.totalRecords > 0
      && overall.meteredCostUsd === 0
      && overall.allocatedSubscriptionCostUsd >= 0
      && (overall.byMode.find((m) => m.mode === 'metered_api')?.recordCount ?? 0) === 0
      && (overall.subscriptionUsage.recordCount > 0);

    res.json({
      // Accounting-mode-aware top-level totals — the canonical FIN-003 surface.
      accounting: {
        meteredCostUsd: overall.meteredCostUsd,
        allocatedSubscriptionCostUsd: overall.allocatedSubscriptionCostUsd,
        blendedEffectiveCostUsd: overall.blendedEffectiveCostUsd,
        subscriptionUsage: overall.subscriptionUsage,
        byMode: overall.byMode,
        coverage: overall.coverage,
      },
      dailyTrend,
      byWorkspace,
      bySpec,
      byMonth,
      byProvider,
      modelDistribution,
      projectedMonthlyCost,
      savings: allSubscription ? null : {
        opusBaseline: round2(opusBaseline),
        actual: round2(actualMeteredCost),
        saved: round2(opusBaseline - actualMeteredCost),
        percentage: opusBaseline > 0 ? Math.round(((opusBaseline - actualMeteredCost) / opusBaseline) * 1000) / 10 : 0,
      },
      allSubscription,
      coverage: overall.coverage,
      dateRange: { from, to },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] FinOps historical query');
  }
});

// ─── GET /api/analytics/ontology-health — Bounded ontology health summary ───

/**
 * @swagger
 * /api/analytics/ontology-health:
 *   get:
 *     tags: [Analytics]
 *     summary: Get bounded ontology health analytics
 *     operationId: getOntologyHealthAnalytics
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Workspace ontology health is read-only operational context that helps local users understand conflict, supersession, and curation pressure without mutating data."
 *     x-rorca-public-api: true
 *     description: Returns bounded ontology health summary metrics and drill-down payloads for active conflicts, superseded memories, hotspot density, and recent curation activity. Falls back to SQL-only mode when Apache AGE is unavailable.
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         required: true
 *         schema: { type: string }
 *         description: Workspace slug/id to inspect.
 *     responses:
 *       200:
 *         description: Ontology health analytics
 *       400:
 *         description: Missing workspace_id
 *       404:
 *         description: Workspace not found
 */
router.get('/ontology-health', async (req: Request, res: Response) => {
  try {
    const workspaceId = typeof req.query.workspace_id === 'string' ? req.query.workspace_id.trim() : '';
    if (!workspaceId) {
      throw new ValidationError('workspace_id is required');
    }

    const wsPath = await getAnalyticsWorkspacePath(workspaceId);
    if (!wsPath) {
      throw new NotFoundError('Workspace not found');
    }

    const ageAvailable = await checkAge();
    const [counts, conflictRows, supersededRows, fileHotspotRows, specHotspotRows, reviewActivityRows, relationActivityRows] = await Promise.all([
      queryOne<OntologyCountsRow>(
        `SELECT
           COUNT(*) FILTER (WHERE relation_type = 'CONFLICTS_WITH' AND status = 'active')::int AS active_conflict_count,
           COUNT(DISTINCT target_memory_id) FILTER (WHERE relation_type = 'SUPERSEDES' AND status = 'active')::int AS superseded_memory_count,
           (SELECT COUNT(*)::int FROM memories WHERE workspace_id = $1 AND deleted_at IS NULL) AS active_memory_count
         FROM memory_relations
         WHERE workspace_id = $1`,
        [workspaceId],
      ),
      query<OntologyRelationRow>(
        `SELECT
           mr.id,
           mr.relation_type,
           mr.status,
           mr.updated_at,
           mr.created_at,
           mr.source_memory_id,
           mr.target_memory_id,
           sm.content AS source_content,
           tm.content AS target_content,
           sm.category AS source_category,
           tm.category AS target_category,
           sm.source_spec_id AS source_spec_id,
           tm.source_spec_id AS target_spec_id,
           sm.source_story_id AS source_story_id,
           tm.source_story_id AS target_story_id,
           sm.related_files AS source_related_files,
           tm.related_files AS target_related_files
         FROM memory_relations mr
         JOIN memories sm ON sm.id = mr.source_memory_id
         JOIN memories tm ON tm.id = mr.target_memory_id
         WHERE mr.workspace_id = $1
           AND mr.status = 'active'
           AND mr.relation_type = 'CONFLICTS_WITH'
         ORDER BY mr.updated_at DESC, mr.id DESC
         LIMIT $2`,
        [workspaceId, ONTOLOGY_RELATION_LIMIT],
      ),
      query<OntologyRelationRow>(
        `SELECT
           mr.id,
           mr.relation_type,
           mr.status,
           mr.updated_at,
           mr.created_at,
           mr.source_memory_id,
           mr.target_memory_id,
           sm.content AS source_content,
           tm.content AS target_content,
           sm.category AS source_category,
           tm.category AS target_category,
           sm.source_spec_id AS source_spec_id,
           tm.source_spec_id AS target_spec_id,
           sm.source_story_id AS source_story_id,
           tm.source_story_id AS target_story_id,
           sm.related_files AS source_related_files,
           tm.related_files AS target_related_files
         FROM memory_relations mr
         JOIN memories sm ON sm.id = mr.target_memory_id
         JOIN memories tm ON tm.id = mr.source_memory_id
         WHERE mr.workspace_id = $1
           AND mr.status = 'active'
           AND mr.relation_type = 'SUPERSEDES'
         ORDER BY mr.updated_at DESC, mr.id DESC
         LIMIT $2`,
        [workspaceId, ONTOLOGY_RELATION_LIMIT],
      ),
      loadOntologyHotspots(workspaceId, 'file'),
      loadOntologyHotspots(workspaceId, 'spec'),
      query<OntologyActivityRow>(
        `SELECT ts, event_type, payload, spec_id, story_id
           FROM wal_events
          WHERE workspace_id = $1
            AND event_type = 'memory_reviewed'
            AND ts >= NOW() - ($2 || ' days')::interval
          ORDER BY ts DESC
          LIMIT $3`,
        [workspaceId, ONTOLOGY_ACTIVITY_WINDOW_DAYS, ONTOLOGY_ACTIVITY_LIMIT],
      ),
      query<OntologyRelationRow>(
        `SELECT
           mr.id,
           mr.relation_type,
           mr.status,
           mr.updated_at,
           mr.created_at,
           mr.source_memory_id,
           mr.target_memory_id,
           sm.content AS source_content,
           tm.content AS target_content,
           sm.category AS source_category,
           tm.category AS target_category,
           sm.source_spec_id AS source_spec_id,
           tm.source_spec_id AS target_spec_id,
           sm.source_story_id AS source_story_id,
           tm.source_story_id AS target_story_id,
           sm.related_files AS source_related_files,
           tm.related_files AS target_related_files
         FROM memory_relations mr
         JOIN memories sm ON sm.id = mr.source_memory_id
         JOIN memories tm ON tm.id = mr.target_memory_id
         WHERE mr.workspace_id = $1
           AND mr.updated_at >= NOW() - ($2 || ' days')::interval
         ORDER BY mr.updated_at DESC, mr.id DESC
         LIMIT $3`,
        [workspaceId, ONTOLOGY_ACTIVITY_WINDOW_DAYS, ONTOLOGY_ACTIVITY_LIMIT],
      ),
    ]);

    const fileHotspots = mapOntologyHotspotItems(fileHotspotRows, 'file');
    const specHotspots = mapOntologyHotspotItems(specHotspotRows, 'spec');
    const hotspotItems = [...fileHotspots, ...specHotspots]
      .sort((left, right) => right.memoryCount - left.memoryCount || right.conflictCount - left.conflictCount || (right.lastTouchedAt ?? '').localeCompare(left.lastTouchedAt ?? '') || left.key.localeCompare(right.key));
    const densestHotspot = hotspotItems[0] ?? null;
    const activeMemoryCount = Number(counts?.active_memory_count ?? 0);
    const hotspotDensityPct = densestHotspot && activeMemoryCount > 0
      ? Math.round((densestHotspot.memoryCount / Math.min(activeMemoryCount, ONTOLOGY_HOTSPOT_MEMORY_WINDOW)) * 1000) / 10
      : 0;

    const conflictItems = conflictRows.map((row) => ({
      relationId: Number(row.id),
      relationType: row.relation_type,
      status: row.status,
      updatedAt: normalizeOntologyTimestamp(row.updated_at),
      sourceMemoryId: Number(row.source_memory_id),
      targetMemoryId: Number(row.target_memory_id),
      sourceCategory: row.source_category,
      targetCategory: row.target_category,
      sourceContent: row.source_content,
      targetContent: row.target_content,
      sourceSpecId: row.source_spec_id,
      targetSpecId: row.target_spec_id,
      sourceStoryId: row.source_story_id,
      targetStoryId: row.target_story_id,
      sourceFiles: parseStringArray(row.source_related_files),
      targetFiles: parseStringArray(row.target_related_files),
      memoryIds: uniqueNumbers([Number(row.source_memory_id), Number(row.target_memory_id)]),
      specIds: uniqueStrings([row.source_spec_id, row.target_spec_id]),
      filePaths: uniqueStrings([...parseStringArray(row.source_related_files), ...parseStringArray(row.target_related_files)]),
    }));

    const supersededItems = supersededRows.map((row) => ({
      relationId: Number(row.id),
      relationType: row.relation_type,
      status: row.status,
      updatedAt: normalizeOntologyTimestamp(row.updated_at),
      memoryId: Number(row.target_memory_id),
      supersededByMemoryId: Number(row.source_memory_id),
      category: row.source_category,
      content: row.source_content,
      supersedingCategory: row.target_category,
      supersedingContent: row.target_content,
      sourceSpecId: row.source_spec_id,
      supersedingSpecId: row.target_spec_id,
      sourceStoryId: row.source_story_id,
      supersedingStoryId: row.target_story_id,
      relatedFiles: parseStringArray(row.source_related_files),
      supersedingFiles: parseStringArray(row.target_related_files),
      memoryIds: uniqueNumbers([Number(row.source_memory_id), Number(row.target_memory_id)]),
      specIds: uniqueStrings([row.source_spec_id, row.target_spec_id]),
      filePaths: uniqueStrings([...parseStringArray(row.source_related_files), ...parseStringArray(row.target_related_files)]),
    }));

    const reviewActivities = reviewActivityRows.map((row) => {
      const payload = typeof row.payload === 'string'
        ? JSON.parse(row.payload)
        : (row.payload ?? {});
      const rawRelatedFiles = Array.isArray((payload as Record<string, unknown>).relatedFiles)
        ? (payload as Record<string, unknown>).relatedFiles as unknown[]
        : Array.isArray(((payload as Record<string, unknown>).provenance as Record<string, unknown> | undefined)?.relatedFiles)
          ? (((payload as Record<string, unknown>).provenance as Record<string, unknown>).relatedFiles as unknown[])
          : [];
      const relatedFiles = rawRelatedFiles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      const memoryId = Number((payload as Record<string, unknown>).memoryId);
      const action = typeof (payload as Record<string, unknown>).action === 'string'
        ? (payload as Record<string, unknown>).action
        : 'review';
      const sourceSpecId = typeof ((payload as Record<string, unknown>).provenance as Record<string, unknown> | undefined)?.sourceSpecId === 'string'
        ? (((payload as Record<string, unknown>).provenance as Record<string, unknown>).sourceSpecId as string)
        : row.spec_id;
      return {
        kind: 'review' as const,
        at: normalizeOntologyTimestamp(row.ts) ?? '',
        action,
        summary: `Review action: ${action}`,
        memoryIds: Number.isInteger(memoryId) && memoryId > 0 ? [memoryId] : [],
        specIds: uniqueStrings([sourceSpecId]),
        filePaths: uniqueStrings(relatedFiles),
      };
    });

    const relationActivities = relationActivityRows.map((row) => ({
      kind: 'relation' as const,
      at: normalizeOntologyTimestamp(row.updated_at) ?? '',
      action: row.status === 'deleted'
        ? 'remove'
        : normalizeOntologyTimestamp(row.created_at) === normalizeOntologyTimestamp(row.updated_at) ? 'create' : 'update',
      relationType: row.relation_type,
      summary: row.relation_type === 'CONFLICTS_WITH'
        ? `Conflict pair updated (#${row.source_memory_id} ↔ #${row.target_memory_id})`
        : `Supersession updated (#${row.source_memory_id} → #${row.target_memory_id})`,
      memoryIds: uniqueNumbers([Number(row.source_memory_id), Number(row.target_memory_id)]),
      specIds: uniqueStrings([row.source_spec_id, row.target_spec_id]),
      filePaths: uniqueStrings([...parseStringArray(row.source_related_files), ...parseStringArray(row.target_related_files)]),
      status: row.status,
    }));

    const recentCurationItems = [...reviewActivities, ...relationActivities]
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, ONTOLOGY_ACTIVITY_LIMIT);
    const recentCurationCount = recentCurationItems.length;
    const dataAvailable = activeMemoryCount > 0 || conflictItems.length > 0 || supersededItems.length > 0 || hotspotItems.length > 0 || recentCurationCount > 0;
    const fallbackReason = ageAvailable
      ? null
      : 'Apache AGE extension is unavailable. Ontology health is using bounded SQL summaries and direct provenance drill-downs only.';

    res.json({
      available: true,
      dataAvailable,
      workspaceId,
      ageAvailable,
      mode: ageAvailable ? 'bounded-sql' : 'bounded-sql-fallback',
      reason: fallbackReason,
      emptyReason: dataAvailable ? null : 'No ontology memories or relations recorded yet for this workspace.',
      bounds: {
        relationLimit: ONTOLOGY_RELATION_LIMIT,
        hotspotMemoryWindow: ONTOLOGY_HOTSPOT_MEMORY_WINDOW,
        hotspotResultLimit: ONTOLOGY_HOTSPOT_RESULT_LIMIT,
        activityLimit: ONTOLOGY_ACTIVITY_LIMIT,
        activityWindowDays: ONTOLOGY_ACTIVITY_WINDOW_DAYS,
      },
      summary: {
        activeConflictCount: Number(counts?.active_conflict_count ?? 0),
        supersededMemoryCount: Number(counts?.superseded_memory_count ?? 0),
        hotspotDensityPct,
        hotspotCount: hotspotItems.length,
        densestHotspot: densestHotspot,
        recentCurationCount,
      },
      drilldowns: {
        conflicts: {
          total: Number(counts?.active_conflict_count ?? 0),
          truncated: Number(counts?.active_conflict_count ?? 0) > conflictItems.length,
          items: conflictItems,
        },
        superseded: {
          total: Number(counts?.superseded_memory_count ?? 0),
          truncated: Number(counts?.superseded_memory_count ?? 0) > supersededItems.length,
          items: supersededItems,
        },
        hotspots: {
          total: hotspotItems.length,
          truncated: fileHotspots.length >= ONTOLOGY_HOTSPOT_RESULT_LIMIT || specHotspots.length >= ONTOLOGY_HOTSPOT_RESULT_LIMIT,
          items: hotspotItems,
          files: fileHotspots,
          specs: specHotspots,
        },
        recentCuration: {
          total: recentCurationCount,
          truncated: reviewActivities.length >= ONTOLOGY_ACTIVITY_LIMIT || relationActivities.length >= ONTOLOGY_ACTIVITY_LIMIT,
          items: recentCurationItems,
        },
      },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Ontology health query');
  }
});

// ─── GET /api/analytics/pi-providers — Provider FinOps aggregation (compat path) ───────

/**
 * @swagger
 * /api/analytics/pi-providers:
 *   get:
 *     tags: [Analytics]
 *     summary: Get provider usage aggregates
 *     operationId: getPiProviderAnalytics
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "Provider cost analytics are part of the paid FinOps surface and should not be reachable from the free CLI contract."
 *     description: Compatibility path that returns FinOps aggregates for all execution providers. Data is derived from token_usage joined with pipeline_runs. Provider names are parsed from model identifiers such as pi/openai/gpt-4.1, openrouter/google/gemini, openai/gpt-4o, or fallback agent type for un-prefixed models.
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *         description: Optional workspace filter. When omitted, returns all Pi provider aggregates visible to the authenticated user under workspace RLS.
 *     responses:
 *       200:
 *         description: Pi provider aggregates
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 required: [provider, totalRuns, totalStories, totalInputTokens, totalOutputTokens, totalCost, avgCostPerStory, lastUsed]
 *                 properties:
 *                   provider: { type: string }
 *                   totalRuns: { type: integer }
 *                   totalStories: { type: integer }
 *                   totalInputTokens: { type: integer }
 *                   totalOutputTokens: { type: integer }
 *                   totalCost: { type: number }
 *                   avgCostPerStory: { type: number }
 *                   lastUsed: { type: string, format: date-time }
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
router.get('/pi-providers', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;

    const providers = await withUserClient(req, async (client) => {
      const params: string[] = [];
      let workspaceFilter = '';

      if (workspaceId) {
        params.push(workspaceId);
        workspaceFilter = ` AND tu.workspace_id = $${params.length}`;
      }

      const sql = `
        SELECT
          CASE
            WHEN tu.model LIKE 'pi/%' THEN split_part(tu.model, '/', 2)
            WHEN position('/' in tu.model) > 0 THEN split_part(tu.model, '/', 1)
            ELSE COALESCE(pr.agent_type, pr.agent, 'unknown')
          END AS provider,
          COUNT(DISTINCT tu.run_id)::int AS total_runs,
          COUNT(DISTINCT (tu.run_id, tu.story_id))::int AS total_stories,
          COALESCE(SUM(tu.input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(tu.output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(tu.cost_usd), 0) AS total_cost,
          COALESCE(SUM(tu.cost_usd) / NULLIF(COUNT(DISTINCT (tu.run_id, tu.story_id)), 0), 0) AS avg_cost_per_story,
          MAX(tu.recorded_at)::text AS last_used
        FROM token_usage tu
        JOIN pipeline_runs pr ON pr.id = tu.run_id
        WHERE 1 = 1
          ${workspaceFilter}
        GROUP BY provider
        ORDER BY MAX(tu.recorded_at) DESC, provider ASC
      `;

      const result = await client.query<PiProviderRow>(sql, params);
      return result.rows;
    });

    res.json(providers.map((row) => ({
      provider: row.provider,
      totalRuns: Number(row.total_runs),
      totalStories: Number(row.total_stories),
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      totalCost: Number(row.total_cost),
      avgCostPerStory: Number(row.avg_cost_per_story),
      lastUsed: row.last_used,
    })));
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Provider query');
  }
});

// ─── GET /api/analytics/finops/export — CSV export of per-story cost data ────

/** Raw token_usage row joined to its run, projected for the FinOps CSV export. */
interface FinOpsExportRow {
  run_id: number | string | null;
  story_id: string | null;
  model: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  reasoning_tokens: number | string | null;
  cost_usd: number | string | null;
  recorded_at: string | null;
  workspace_id: string | null;
  spec_slug: string | null;
  agent_type: string | null;
}

/**
 * @swagger
 * /api/analytics/finops/export:
 *   get:
 *     tags: [Analytics]
 *     summary: CSV export of per-story cost data
 *     operationId: exportFinOpsCsv
 *     x-rorca-tier: paid
 *     x-rorca-capability: finops
 *     x-rorca-rationale: "FinOps export is a commercial reporting feature and should remain behind the paid plan boundary."
 *     description: >-
 *       Exports per-story token usage and accounting-mode-aware cost data as a CSV
 *       file, preserving the same billing semantics as the FinOps dashboard and
 *       per-run views (FIN-009). Each row is classified against the active billing
 *       profiles, so the CSV separates metered marginal spend (metered_cost_usd)
 *       from allocated subscription cost (allocated_subscription_cost_usd) and
 *       blended effective cost (blended_effective_cost_usd) instead of leaking only
 *       the ambiguous raw cost_usd. Columns: run_id, story_id, spec_slug, provider,
 *       model, tier, agent_type, billing_mode, billing_profile_id, classified_by,
 *       allocation_basis, input_tokens, output_tokens, reasoning_tokens, cost_usd,
 *       metered_cost_usd, allocated_subscription_cost_usd, blended_effective_cost_usd,
 *       priced, opus_baseline_usd, savings_usd, recorded_at, workspace_id. Can be
 *       filtered by run_id, workspace_id, and date range.
 *     parameters:
 *       - in: query
 *         name: run_id
 *         schema: { type: integer }
 *         description: Optional filter by specific pipeline run ID
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *         description: Optional workspace filter
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Start date (inclusive), default 30 days ago
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *         description: End date (inclusive), default now
 *     responses:
 *       200:
 *         description: CSV file download
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *       500:
 *         description: Internal server error
 */
router.get('/finops/export', async (req: Request, res: Response) => {
  try {
    const runId = req.query.run_id ? parseInt(req.query.run_id as string, 10) : undefined;
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    let paramIdx = 1;
    const conditions: string[] = [`tu.recorded_at >= $${paramIdx++}`, `tu.recorded_at <= $${paramIdx++}`];
    const sqlParams: (string | number)[] = [from, to];

    if (runId) {
      conditions.push(`tu.run_id = $${paramIdx++}`);
      sqlParams.push(runId);
    }
    if (workspaceId) {
      conditions.push(`tu.workspace_id = $${paramIdx++}`);
      sqlParams.push(workspaceId);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const sql = `
      SELECT
        tu.run_id,
        tu.story_id,
        tu.model,
        tu.input_tokens,
        tu.output_tokens,
        tu.reasoning_tokens,
        tu.cost_usd,
        tu.recorded_at::text AS recorded_at,
        tu.workspace_id,
        REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug,
        pr.agent AS agent_type
      FROM token_usage tu
      JOIN pipeline_runs pr ON tu.run_id = pr.id
      ${whereClause}
      ORDER BY tu.run_id ASC, tu.recorded_at ASC
    `;

    const rows = await query<FinOpsExportRow>(sql, sqlParams);

    // FIN-009: classify and account for the exported rows with the SAME shared
    // accounting engine the dashboard and per-run views use, so the CSV preserves
    // billing mode, metered vs allocated vs blended cost, allocation basis, and
    // coverage/provenance instead of leaking only the ambiguous raw `cost_usd`.
    // Profiles are loaded for the export window so subscription rows allocate
    // truthfully rather than masquerading as metered spend.
    const pricingRows = await query<{ model_id: string; input_cost_per_1m: number | null; output_cost_per_1m: number | null; input_cost_per_1k: number; output_cost_per_1k: number }>(
      'SELECT model_id, input_cost_per_1m, output_cost_per_1m, input_cost_per_1k, output_cost_per_1k FROM model_pricing'
    );
    const pricingMap = new Map<string, { input: number; output: number }>();
    for (const p of pricingRows) {
      pricingMap.set(p.model_id, {
        input: p.input_cost_per_1m ?? p.input_cost_per_1k * 1000,
        output: p.output_cost_per_1m ?? p.output_cost_per_1k * 1000,
      });
    }
    const profiles = await loadActiveBillingProfiles(from, to, workspaceId);
    const accountingCtx = buildAccountingContext(pricingMap, profiles);

    const usageRecords: UsageRecord[] = rows.map((row) => toUsageRecord({
      model: String(row.model || ''),
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      reasoning_tokens: row.reasoning_tokens,
      cost_usd: row.cost_usd,
      run_id: row.run_id,
      story_id: row.story_id,
      recorded_at: row.recorded_at,
    }));
    const { perRecord } = computeAccountingPerRecord(usageRecords, accountingCtx);

    // Round a USD value to 4 decimals for CSV stability (matches per-run view).
    const usd4 = (value: number): number => Math.round(value * 10000) / 10000;

    // Build one fully-attributed row per usage record. Every accounting column is
    // present so a downstream auditor can reconstruct exactly how each cost was
    // derived: the provider + model + billing profile that classified it, the
    // metered marginal cost, the allocated subscription share and its basis, the
    // blended effective cost, and whether the row was priced/profile-classified.
    const enrichedRows = rows.map((row, i) => {
      const model = String(row.model || '');
      const inputTokens = Number(row.input_tokens || 0);
      const outputTokens = Number(row.output_tokens || 0);
      const acct = perRecord[i];
      const opusBaseline = (inputTokens / 1_000_000) * OPUS_INPUT_PER_1M + (outputTokens / 1_000_000) * OPUS_OUTPUT_PER_1M;
      return {
        run_id: row.run_id,
        story_id: row.story_id,
        spec_slug: row.spec_slug,
        provider: providerFromModel(model),
        model,
        tier: tierFromModel(model),
        agent_type: row.agent_type,
        billing_mode: acct.mode,
        billing_profile_id: acct.profileId ?? '',
        classified_by: acct.fromProfile ? 'profile' : 'heuristic',
        allocation_basis: acct.allocationMethod ?? '',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        reasoning_tokens: Number(row.reasoning_tokens || 0),
        cost_usd: usd4(Number(row.cost_usd || 0)),
        metered_cost_usd: usd4(acct.meteredCostUsd),
        allocated_subscription_cost_usd: usd4(acct.allocatedSubscriptionCostUsd),
        blended_effective_cost_usd: usd4(acct.blendedEffectiveCostUsd),
        priced: acct.unpriced ? 'false' : 'true',
        opus_baseline_usd: usd4(opusBaseline),
        // Savings is a metered-vs-Opus comparison; subscription/unpriced rows have
        // zero metered cost so their "savings" reflects only the metered baseline.
        savings_usd: usd4(opusBaseline - acct.meteredCostUsd),
        recorded_at: row.recorded_at,
        workspace_id: row.workspace_id,
      };
    });

    const headers = [
      'run_id', 'story_id', 'spec_slug', 'provider', 'model', 'tier', 'agent_type',
      'billing_mode', 'billing_profile_id', 'classified_by', 'allocation_basis',
      'input_tokens', 'output_tokens', 'reasoning_tokens',
      'cost_usd', 'metered_cost_usd', 'allocated_subscription_cost_usd', 'blended_effective_cost_usd',
      'priced', 'opus_baseline_usd', 'savings_usd',
      'recorded_at', 'workspace_id',
    ];

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = runId ? `rorca-finops-run-${runId}-${ts}` : `rorca-finops-${ts}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.send(toCsvRows(headers, enrichedRows));
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] FinOps export');
  }
});

// ─── GET /api/analytics/skills/effectiveness — Skill effectiveness across runs ─

interface SkillEffectivenessRow {
  skill_name: string;
  status: string;
  elapsed_seconds: number | null;
  run_id: number;
}

interface SkillEffectivenessResult {
  name: string;
  totalUses: number;
  passCount: number;
  failCount: number;
  passRate: number;
  avgElapsedSeconds: number | null;
  runsUsedIn: number;
}

/**
 * @swagger
 * /api/analytics/skills/effectiveness:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Skill effectiveness analytics
 *     operationId: getSkillEffectiveness
 *     description: Aggregates which skills correlate most with story success across pipeline runs for a workspace within a time range.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID to filter runs
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: ISO date string, defaults to 30 days ago
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 50 }
 *         description: Max skills to return (default 20, max 50)
 *     responses:
 *       200:
 *         description: Skill effectiveness data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 skills:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       totalUses: { type: integer }
 *                       passCount: { type: integer }
 *                       failCount: { type: integer }
 *                       passRate: { type: number }
 *                       avgElapsedSeconds: { type: number, nullable: true }
 *                       runsUsedIn: { type: integer }
 *                 period:
 *                   type: object
 *                   properties:
 *                     since: { type: string }
 *                     until: { type: string }
 *                 totalRuns: { type: integer }
 *                 totalStories: { type: integer }
 *       400:
 *         description: Missing workspaceId parameter
 */
router.get('/skills/effectiveness', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      throw new ValidationError('workspaceId query parameter is required');
    }

    const now = new Date();
    const since = (req.query.since as string) || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const until = now.toISOString();
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);

    // Total runs in window
    const totalRunsRow = await queryOne<{ cnt: number }>(
      `SELECT COUNT(DISTINCT id)::int AS cnt FROM pipeline_runs WHERE workspace_id = $1 AND started_at >= $2`,
      [workspaceId, since]
    );
    const totalRuns = totalRunsRow?.cnt ?? 0;

    // Total stories in window
    const totalStoriesRow = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM story_results sr
       JOIN pipeline_runs pr ON sr.run_id = pr.id
       WHERE pr.workspace_id = $1 AND sr.started_at >= $2`,
      [workspaceId, since]
    );
    const totalStories = totalStoriesRow?.cnt ?? 0;

    // Use jsonb_array_elements_text() for PostgreSQL (replaces SQLite json_each())
    let rows: SkillEffectivenessRow[];
    try {
      rows = await query<SkillEffectivenessRow>(
        `SELECT je.value AS skill_name, sr.status, sr.elapsed_seconds, sr.run_id
         FROM story_results sr
         CROSS JOIN LATERAL jsonb_array_elements_text(sr.active_skills::jsonb) AS je(value)
         JOIN pipeline_runs pr ON sr.run_id = pr.id
         WHERE pr.workspace_id = $1 AND sr.started_at >= $2 AND sr.active_skills IS NOT NULL`,
        [workspaceId, since]
      );
    } catch {
      // Fallback: JS-side JSON parsing
      const rawRows = await query<{ story_id: string; status: string; active_skills: string; elapsed_seconds: number | null; run_id: number }>(
        `SELECT sr.story_id, sr.status, sr.active_skills, sr.elapsed_seconds, sr.run_id
         FROM story_results sr
         JOIN pipeline_runs pr ON sr.run_id = pr.id
         WHERE pr.workspace_id = $1 AND sr.started_at >= $2 AND sr.active_skills IS NOT NULL`,
        [workspaceId, since]
      );

      rows = [];
      for (const row of rawRows) {
        try {
          const skills: string[] = JSON.parse(row.active_skills);
          for (const skill_name of skills) {
            rows.push({ skill_name, status: row.status, elapsed_seconds: row.elapsed_seconds, run_id: row.run_id });
          }
        } catch {
          // skip malformed JSON
        }
      }
    }

    // Aggregate per skill
    const skillMap = new Map<string, { totalUses: number; passCount: number; failCount: number; passElapsedSum: number; passElapsedCount: number; runs: Set<number> }>();

    for (const row of rows) {
      let entry = skillMap.get(row.skill_name);
      if (!entry) {
        entry = { totalUses: 0, passCount: 0, failCount: 0, passElapsedSum: 0, passElapsedCount: 0, runs: new Set() };
        skillMap.set(row.skill_name, entry);
      }
      entry.totalUses++;
      entry.runs.add(row.run_id);
      if (row.status === 'pass') {
        entry.passCount++;
        if (row.elapsed_seconds != null) {
          entry.passElapsedSum += row.elapsed_seconds;
          entry.passElapsedCount++;
        }
      } else if (row.status === 'fail') {
        entry.failCount++;
      }
    }

    const skills: SkillEffectivenessResult[] = Array.from(skillMap.entries())
      .map(([name, e]) => ({
        name,
        totalUses: e.totalUses,
        passCount: e.passCount,
        failCount: e.failCount,
        passRate: e.totalUses > 0 ? Math.round((e.passCount / e.totalUses) * 10000) / 10000 : 0,
        avgElapsedSeconds: e.passElapsedCount > 0 ? Math.round(e.passElapsedSum / e.passElapsedCount) : null,
        runsUsedIn: e.runs.size,
      }))
      .sort((a, b) => b.totalUses - a.totalUses)
      .slice(0, limit);

    res.json({
      skills,
      period: { since, until },
      totalRuns,
      totalStories,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Analytics] Skill effectiveness');
  }
});

export default router;
