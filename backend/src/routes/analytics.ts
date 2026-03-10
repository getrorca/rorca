import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { db } from '../db/index';
import { logger } from '../lib/logger';

const router = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface UsageRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  count: number;
}

interface TimeSeriesRow {
  date: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
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
router.get('/usage', (req: Request, res: Response) => {
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
      res.status(400).json({ error: `group_by must be one of: ${validGroupBy.join(', ')}` });
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

    let sql = `
      SELECT
        ${groupCol} AS group_key,
        SUM(tu.input_tokens) AS total_input_tokens,
        SUM(tu.output_tokens) AS total_output_tokens,
        SUM(tu.cost_usd) AS total_cost_usd,
        COUNT(*) AS count
      FROM token_usage tu
    `;
    if (needsJoin) {
      sql += ' JOIN pipeline_runs pr ON tu.run_id = pr.id';
    }

    const params: (string | number)[] = [];
    sql += ' WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?';
    params.push(from, to);

    if (workspaceId) {
      sql += ' AND tu.workspace_id = ?';
      params.push(workspaceId);
    }

    sql += ` GROUP BY group_key ORDER BY total_cost_usd DESC`;

    const grouped = db.prepare(sql).all(...params) as UsageRow[];

    // Time series: daily aggregation
    let timeSeriesSql = `
      SELECT
        DATE(tu.recorded_at) AS date,
        SUM(tu.input_tokens) AS total_input_tokens,
        SUM(tu.output_tokens) AS total_output_tokens,
        SUM(tu.cost_usd) AS total_cost_usd
      FROM token_usage tu
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
    `;
    const tsParams: (string | number)[] = [from, to];
    if (workspaceId) {
      timeSeriesSql += ' AND tu.workspace_id = ?';
      tsParams.push(workspaceId);
    }
    timeSeriesSql += ' GROUP BY DATE(tu.recorded_at) ORDER BY date ASC';

    const timeSeries = db.prepare(timeSeriesSql).all(...tsParams) as TimeSeriesRow[];

    // Summary totals
    let totalSql = `
      SELECT
        COALESCE(SUM(tu.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(tu.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(tu.cost_usd), 0) AS total_cost_usd,
        COUNT(*) AS total_records
      FROM token_usage tu
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
    `;
    const totParams: (string | number)[] = [from, to];
    if (workspaceId) {
      totalSql += ' AND tu.workspace_id = ?';
      totParams.push(workspaceId);
    }

    const totals = db.prepare(totalSql).get(...totParams) as {
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
      total_records: number;
    };

    // Active runs check (for auto-refresh hint)
    const activeRuns = db.prepare(
      `SELECT COUNT(*) AS count FROM pipeline_runs WHERE status = 'running'`
    ).get() as { count: number };

    res.json({
      grouped,
      timeSeries,
      totals,
      hasActiveRuns: activeRuns.count > 0,
      dateRange: { from, to },
      groupBy,
    });
  } catch (error: any) {
    logger.error('[Analytics] Usage query error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/costs', (req: Request, res: Response) => {
  try {
    const groupBy = (req.query.group_by as string) || 'spec';
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const validGroupBy = ['spec', 'run', 'model', 'period'];
    if (!validGroupBy.includes(groupBy)) {
      res.status(400).json({ error: `group_by must be one of: ${validGroupBy.join(', ')}` });
      return;
    }

    // Cost calculation uses model_pricing join for actual provider rates
    // Formula: (input_tokens / 1,000,000) * input_cost_per_1m + (output_tokens / 1,000,000) * output_cost_per_1m

    const wsFilter = workspaceId ? 'AND tu.workspace_id = ?' : '';
    const wsParams: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

    if (groupBy === 'period') {
      // Group by week
      const sql = `
        SELECT
          strftime('%Y-W%W', tu.recorded_at) AS period,
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
          SUM(tu.cost_usd) AS total_cost_usd,
          COUNT(*) AS story_count
        FROM token_usage tu
        LEFT JOIN model_pricing mp ON tu.model = mp.model_id
        WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
        ${wsFilter}
        GROUP BY period
        ORDER BY period ASC
      `;

      const periods = db.prepare(sql).all(...wsParams) as PeriodCostRow[];

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
        SUM(tu.cost_usd) AS total_cost_usd,
        COUNT(*) AS story_count
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
      ${needsRunJoin ? 'JOIN pipeline_runs pr ON tu.run_id = pr.id' : ''}
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
      ${wsFilter}
      GROUP BY group_key
      ORDER BY total_cost_usd DESC
    `;

    const breakdown = db.prepare(sql).all(...wsParams) as CostRow[];

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
        COALESCE(SUM(tu.cost_usd), 0) AS total_cost_usd,
        COUNT(*) AS total_stories
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
      ${wsFilter}
    `;

    const totals = db.prepare(totalSql).get(...wsParams) as {
      total_input_tokens: number;
      total_output_tokens: number;
      total_input_cost_usd: number;
      total_output_cost_usd: number;
      total_cost_usd: number;
      total_stories: number;
    };

    res.json({ groupBy, breakdown, totals, dateRange: { from, to } });
  } catch (error: any) {
    logger.error('[Analytics] Costs query error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/pricing', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM model_pricing ORDER BY model_id'
    ).all() as ModelPricingFullRow[];

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
    logger.error('[Analytics] Pricing list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /api/analytics/pricing/:modelId — Update or create model pricing ────

/**
 * @swagger
 * /api/analytics/pricing/{modelId}:
 *   put:
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
router.put('/pricing/:modelId', (req: Request, res: Response) => {
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
      res.status(400).json({ error: 'input_cost_per_1m_tokens and output_cost_per_1m_tokens are required' });
      return;
    }

    if (input_cost_per_1m_tokens < 0 || output_cost_per_1m_tokens < 0) {
      res.status(400).json({ error: 'Costs cannot be negative' });
      return;
    }

    // Convert per-1M to per-1K for backward compat with existing cost-estimator
    const inputPer1k = input_cost_per_1m_tokens / 1000;
    const outputPer1k = output_cost_per_1m_tokens / 1000;
    const effDate = effective_date || new Date().toISOString();
    const prov = provider || 'anthropic';

    const existing = db.prepare(
      'SELECT model_id FROM model_pricing WHERE model_id = ?'
    ).get(modelId);

    if (existing) {
      db.prepare(`
        UPDATE model_pricing
        SET provider = ?,
            input_cost_per_1k = ?,
            output_cost_per_1k = ?,
            input_cost_per_1m = ?,
            output_cost_per_1m = ?,
            effective_date = ?,
            updated_at = datetime('now')
        WHERE model_id = ?
      `).run(prov, inputPer1k, outputPer1k, input_cost_per_1m_tokens, output_cost_per_1m_tokens, effDate, modelId);
    } else {
      db.prepare(`
        INSERT INTO model_pricing (model_id, provider, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m, effective_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(modelId, prov, inputPer1k, outputPer1k, input_cost_per_1m_tokens, output_cost_per_1m_tokens, effDate);
    }

    res.json({
      model_id: modelId,
      provider: prov,
      input_cost_per_1m_tokens,
      output_cost_per_1m_tokens,
      effective_date: effDate,
    });
  } catch (error: any) {
    logger.error('[Analytics] Pricing update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/analytics/pricing/:modelId — Remove model pricing ───────────

/**
 * @swagger
 * /api/analytics/pricing/{modelId}:
 *   delete:
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
router.delete('/pricing/:modelId', (req: Request, res: Response) => {
  try {
    const modelId = req.params.modelId;
    const result = db.prepare('DELETE FROM model_pricing WHERE model_id = ?').run(modelId);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Model pricing not found' });
      return;
    }

    res.json({ deleted: modelId });
  } catch (error: any) {
    logger.error('[Analytics] Pricing delete error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/models', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const wsFilter = workspaceId ? 'AND tu.workspace_id = ?' : '';
    const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

    // Join token_usage with story_results to get pass/fail + elapsed_seconds per story
    // token_usage has model, cost; story_results has status, elapsed_seconds
    const sql = `
      SELECT
        tu.model,
        COUNT(*) AS total_stories,
        SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END) AS passed_stories,
        SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END) AS failed_stories,
        AVG(tu.cost_usd) AS avg_cost_usd,
        SUM(tu.cost_usd) AS total_cost_usd,
        AVG(sr.elapsed_seconds) AS avg_elapsed_seconds,
        AVG(tu.input_tokens) AS avg_input_tokens,
        AVG(tu.output_tokens) AS avg_output_tokens
      FROM token_usage tu
      JOIN story_results sr ON tu.run_id = sr.run_id AND tu.story_id = sr.story_id
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
      ${wsFilter}
      AND sr.status IN ('pass', 'fail')
      GROUP BY tu.model
      ORDER BY total_stories DESC
    `;

    const rows = db.prepare(sql).all(...params) as ModelComparisonRow[];

    // Enrich with pass rate and insufficient data flag
    const models = rows.map(r => ({
      model: r.model,
      totalStories: r.total_stories,
      passedStories: r.passed_stories,
      failedStories: r.failed_stories,
      passRate: r.total_stories > 0 ? r.passed_stories / r.total_stories : 0,
      avgCostUsd: r.avg_cost_usd ?? 0,
      totalCostUsd: r.total_cost_usd ?? 0,
      avgElapsedSeconds: r.avg_elapsed_seconds ?? 0,
      avgInputTokens: Math.round(r.avg_input_tokens ?? 0),
      avgOutputTokens: Math.round(r.avg_output_tokens ?? 0),
      insufficientData: r.total_stories < 5,
    }));

    res.json({ models, dateRange: { from, to } });
  } catch (error: any) {
    logger.error('[Analytics] Models comparison error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/velocity', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;
    const specId = req.query.spec_id as string | undefined;

    const now = new Date();
    const twelveWeeksAgo = new Date(now.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || twelveWeeksAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    // Build dynamic WHERE clauses
    const conditions: string[] = ['sr.finished_at >= ?', 'sr.finished_at <= ?'];
    const params: (string | number)[] = [from, to];

    if (workspaceId) {
      conditions.push('pr.workspace_id = ?');
      params.push(workspaceId);
    }

    if (specId) {
      conditions.push("REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') = ?");
      params.push(specId);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Weekly story counts grouped by status
    const sql = `
      SELECT
        strftime('%Y-W%W', sr.finished_at) AS week,
        DATE(sr.finished_at, 'weekday 1', '-7 days') AS week_start,
        SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN sr.status = 'skip' THEN 1 ELSE 0 END) AS skipped,
        COUNT(*) AS total
      FROM story_results sr
      JOIN pipeline_runs pr ON sr.run_id = pr.id
      ${whereClause}
      GROUP BY week
      ORDER BY week ASC
    `;

    const weeks = db.prepare(sql).all(...params) as VelocityWeek[];

    // Fetch notable specs per week (distinct spec slugs that had stories finish)
    const specsSql = `
      SELECT
        strftime('%Y-W%W', sr.finished_at) AS week,
        REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug
      FROM story_results sr
      JOIN pipeline_runs pr ON sr.run_id = pr.id
      ${whereClause}
      GROUP BY week, spec_slug
      ORDER BY week ASC
    `;

    const specRows = db.prepare(specsSql).all(...params) as { week: string; spec_slug: string }[];

    // Build a map of week → spec slugs
    const specsByWeek = new Map<string, string[]>();
    for (const row of specRows) {
      const arr = specsByWeek.get(row.week) || [];
      arr.push(row.spec_slug);
      specsByWeek.set(row.week, arr);
    }

    // Attach specs to each week + compute rolling 4-week average
    const velocityData = weeks.map((w, i) => {
      // Rolling 4-week average of total stories
      const windowStart = Math.max(0, i - 3);
      const window = weeks.slice(windowStart, i + 1);
      const rollingAvg = window.reduce((sum, wk) => sum + wk.total, 0) / window.length;

      return {
        ...w,
        specs: specsByWeek.get(w.week) || [],
        rollingAvg: Math.round(rollingAvg * 10) / 10,
      };
    });

    // Available specs for the filter dropdown
    const specListSql = `
      SELECT DISTINCT
        REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug
      FROM pipeline_runs pr
      WHERE pr.spec_path IS NOT NULL
      ${workspaceId ? 'AND pr.workspace_id = ?' : ''}
      ORDER BY spec_slug ASC
    `;
    const specListParams: string[] = workspaceId ? [workspaceId] : [];
    const availableSpecs = db.prepare(specListSql).all(...specListParams) as { spec_slug: string }[];

    res.json({
      velocity: velocityData,
      availableSpecs: availableSpecs.map(s => s.spec_slug),
      dateRange: { from, to },
    });
  } catch (error: any) {
    logger.error('[Analytics] Velocity query error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/completion-rates', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    // Fetch all story results in range joined with pipeline_runs for spec_path + workspace
    const wsFilter = workspaceId ? 'AND pr.workspace_id = ?' : '';
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
      WHERE sr.finished_at >= ? AND sr.finished_at <= ?
      ${wsFilter}
      AND sr.status IN ('pass', 'fail', 'skip')
    `;

    const rows = db.prepare(sql).all(...params) as StoryResultRow[];

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
          const tagRows = db.prepare(
            'SELECT tag_name FROM spec_tags WHERE spec_id = ? AND workspace_id = ? ORDER BY tag_name'
          ).all(specId, row.workspace_id) as { tag_name: string }[];

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
    logger.error('[Analytics] Completion rates error:', error);
    res.status(500).json({ error: error.message });
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

function buildUsageExport(from: string, to: string, workspaceId?: string, limit?: number, offset?: number): { rows: ExportRow[]; headers: string[]; total: number } {
  const wsFilter = workspaceId ? 'AND tu.workspace_id = ?' : '';
  const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

  // Count total rows
  const countSql = `
    SELECT COUNT(*) AS total FROM token_usage tu
    WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
  `;
  const { total } = db.prepare(countSql).get(...params) as { total: number };

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
    WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
    ORDER BY tu.recorded_at ASC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...params, limit ?? EXPORT_MAX_ROWS, offset ?? 0) as ExportRow[];
  const headers = ['model', 'story_id', 'input_tokens', 'output_tokens', 'cost_usd', 'recorded_at', 'workspace_id', 'user_id'];
  return { rows, headers, total };
}

function buildCostsExport(from: string, to: string, workspaceId?: string, limit?: number, offset?: number): { rows: ExportRow[]; headers: string[]; total: number } {
  const wsFilter = workspaceId ? 'AND tu.workspace_id = ?' : '';
  const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

  const countSql = `
    SELECT COUNT(*) AS total FROM token_usage tu
    LEFT JOIN model_pricing mp ON tu.model = mp.model_id
    JOIN pipeline_runs pr ON tu.run_id = pr.id
    WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
  `;
  const { total } = db.prepare(countSql).get(...params) as { total: number };

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
    WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
    ORDER BY tu.recorded_at ASC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...params, limit ?? EXPORT_MAX_ROWS, offset ?? 0) as ExportRow[];
  const headers = ['model', 'spec_slug', 'story_id', 'input_tokens', 'output_tokens', 'input_cost_usd', 'output_cost_usd', 'total_cost_usd', 'recorded_at', 'workspace_id'];
  return { rows, headers, total };
}

function buildVelocityExport(from: string, to: string, workspaceId?: string, limit?: number, offset?: number): { rows: ExportRow[]; headers: string[]; total: number } {
  const conditions: string[] = ['sr.finished_at >= ?', 'sr.finished_at <= ?'];
  const params: (string | number)[] = [from, to];

  if (workspaceId) {
    conditions.push('pr.workspace_id = ?');
    params.push(workspaceId);
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const countSql = `
    SELECT COUNT(*) AS total
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    ${whereClause}
  `;
  const { total } = db.prepare(countSql).get(...params) as { total: number };

  const sql = `
    SELECT
      sr.story_id,
      sr.status,
      sr.finished_at,
      sr.elapsed_seconds,
      REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug,
      strftime('%Y-W%W', sr.finished_at) AS week,
      pr.workspace_id
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    ${whereClause}
    ORDER BY sr.finished_at ASC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...params, limit ?? EXPORT_MAX_ROWS, offset ?? 0) as ExportRow[];
  const headers = ['story_id', 'status', 'finished_at', 'elapsed_seconds', 'spec_slug', 'week', 'workspace_id'];
  return { rows, headers, total };
}

function buildCompletionExport(from: string, to: string, workspaceId?: string, limit?: number, offset?: number): { rows: ExportRow[]; headers: string[]; total: number } {
  const wsFilter = workspaceId ? 'AND pr.workspace_id = ?' : '';
  const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

  const countSql = `
    SELECT COUNT(*) AS total
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    WHERE sr.finished_at >= ? AND sr.finished_at <= ? ${wsFilter}
    AND sr.status IN ('pass', 'fail', 'skip')
  `;
  const { total } = db.prepare(countSql).get(...params) as { total: number };

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
    WHERE sr.finished_at >= ? AND sr.finished_at <= ? ${wsFilter}
    AND sr.status IN ('pass', 'fail', 'skip')
    ORDER BY sr.finished_at ASC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...params, limit ?? EXPORT_MAX_ROWS, offset ?? 0) as ExportRow[];
  const headers = ['story_id', 'status', 'finished_at', 'elapsed_seconds', 'input_tokens', 'output_tokens', 'spec_slug', 'workspace_id'];
  return { rows, headers, total };
}

/**
 * @swagger
 * /api/analytics/export:
 *   get:
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
router.get('/export', (req: Request, res: Response) => {
  try {
    const format = req.query.format as string;
    const dataType = req.query.data_type as string;
    const workspaceId = req.query.workspace_id as string | undefined;

    if (!format || !['csv', 'json'].includes(format)) {
      res.status(400).json({ error: 'format must be "csv" or "json"' });
      return;
    }

    const validDataTypes = ['usage', 'costs', 'velocity', 'completion'];
    if (!dataType || !validDataTypes.includes(dataType)) {
      res.status(400).json({ error: `data_type must be one of: ${validDataTypes.join(', ')}` });
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
        result = buildUsageExport(from, to, workspaceId, limit, offset);
        break;
      case 'costs':
        result = buildCostsExport(from, to, workspaceId, limit, offset);
        break;
      case 'velocity':
        result = buildVelocityExport(from, to, workspaceId, limit, offset);
        break;
      case 'completion':
        result = buildCompletionExport(from, to, workspaceId, limit, offset);
        break;
      default:
        res.status(400).json({ error: 'Invalid data_type' });
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
    logger.error('[Analytics] Export error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/roi', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string;
    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspace_id' });
      return;
    }

    // Fetch workspace ROI config
    const workspace = db.prepare(
      'SELECT id, roi_hours_per_story, roi_hourly_rate FROM workspaces WHERE id = ?'
    ).get(workspaceId) as WorkspaceROIConfig | undefined;

    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
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
    const passedResult = db.prepare(`
      SELECT COUNT(*) AS total_stories_passed
      FROM (
        SELECT sr.story_id, sr.status
        FROM story_results sr
        JOIN pipeline_runs pr ON sr.run_id = pr.id
        WHERE pr.workspace_id = ?
          AND sr.finished_at >= ? AND sr.finished_at <= ?
          AND sr.status IN ('pass', 'fail', 'skip', 'retry', 'timeout')
        GROUP BY pr.id, sr.story_id
        HAVING sr.id = MAX(sr.id)
      ) latest
      WHERE latest.status = 'pass'
    `).get(workspaceId, from, to) as { total_stories_passed: number };

    const totalStoriesPassed = passedResult.total_stories_passed;

    // Get total LLM cost from token_usage for this workspace + date range
    const costResult = db.prepare(`
      SELECT COALESCE(SUM(tu.cost_usd), 0) AS total_llm_cost
      FROM token_usage tu
      WHERE tu.workspace_id = ?
        AND tu.recorded_at >= ? AND tu.recorded_at <= ?
    `).get(workspaceId, from, to) as { total_llm_cost: number };

    const totalLlmCost = costResult.total_llm_cost;

    // Calculate ROI metrics
    const estimatedHoursSaved = totalStoriesPassed * hoursPerStory;
    const savingsValue = estimatedHoursSaved * hourlyRate;
    const netSavings = savingsValue - totalLlmCost;
    const roiMultiplier = totalLlmCost > 0
      ? Math.round((savingsValue / totalLlmCost) * 10) / 10
      : totalStoriesPassed > 0 ? Infinity : 0;

    // Time series: daily breakdown for trend chart
    const timeSeries = db.prepare(`
      SELECT
        DATE(sr.finished_at) AS date,
        COUNT(DISTINCT sr.story_id || '-' || sr.run_id) AS stories_passed
      FROM story_results sr
      JOIN pipeline_runs pr ON sr.run_id = pr.id
      WHERE pr.workspace_id = ?
        AND sr.finished_at >= ? AND sr.finished_at <= ?
        AND sr.status = 'pass'
      GROUP BY DATE(sr.finished_at)
      ORDER BY date ASC
    `).all(workspaceId, from, to) as { date: string; stories_passed: number }[];

    // Get daily LLM cost
    const dailyCosts = db.prepare(`
      SELECT
        DATE(tu.recorded_at) AS date,
        COALESCE(SUM(tu.cost_usd), 0) AS llm_cost
      FROM token_usage tu
      WHERE tu.workspace_id = ?
        AND tu.recorded_at >= ? AND tu.recorded_at <= ?
      GROUP BY DATE(tu.recorded_at)
      ORDER BY date ASC
    `).all(workspaceId, from, to) as { date: string; llm_cost: number }[];

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
    logger.error('[Analytics] ROI query error:', error);
    res.status(500).json({ error: error.message });
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
router.put('/roi/config', (req: Request, res: Response) => {
  try {
    const { workspace_id, hours_per_story, hourly_rate } = req.body as {
      workspace_id: string;
      hours_per_story?: number;
      hourly_rate?: number;
    };

    if (!workspace_id) {
      res.status(400).json({ error: 'workspace_id is required' });
      return;
    }

    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspace_id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    if (hours_per_story != null) {
      if (hours_per_story < 0 || hours_per_story > 100) {
        res.status(400).json({ error: 'hours_per_story must be between 0 and 100' });
        return;
      }
      db.prepare('UPDATE workspaces SET roi_hours_per_story = ? WHERE id = ?')
        .run(hours_per_story, workspace_id);
    }

    if (hourly_rate != null) {
      if (hourly_rate < 0 || hourly_rate > 1000) {
        res.status(400).json({ error: 'hourly_rate must be between 0 and 1000' });
        return;
      }
      db.prepare('UPDATE workspaces SET roi_hourly_rate = ? WHERE id = ?')
        .run(hourly_rate, workspace_id);
    }

    const updated = db.prepare(
      'SELECT roi_hours_per_story, roi_hourly_rate FROM workspaces WHERE id = ?'
    ).get(workspace_id) as { roi_hours_per_story: number; roi_hourly_rate: number };

    res.json({
      workspace_id,
      hours_per_story: updated.roi_hours_per_story,
      hourly_rate: updated.roi_hourly_rate,
    });
  } catch (error: any) {
    logger.error('[Analytics] ROI config update error:', error);
    res.status(500).json({ error: error.message });
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

interface EscalationWalRow {
  story_id: string;
  payload: string;
  ts: string;
}

// Default Opus pricing (per 1M tokens) — used for baseline comparison
const OPUS_INPUT_PER_1M = 15.0;
const OPUS_OUTPUT_PER_1M = 75.0;

function tierFromModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('haiku') || lower.includes('mini') || lower.includes('flash')) return 'haiku';
  if (lower.includes('opus') || lower.includes('o3') || lower.includes('pro')) return 'opus';
  return 'sonnet';
}

/**
 * @swagger
 * /api/analytics/finops/run/{runId}:
 *   get:
 *     tags: [Analytics]
 *     summary: Per-run FinOps dashboard data
 *     operationId: getFinOpsRun
 *     description: Returns detailed FinOps data for a specific pipeline run, including per-story cost breakdown with model tier classification, run summary aggregated by model, savings vs all-Opus baseline, model distribution for pie charts, and escalation log from WAL events. For subscription-based agents (claude, codex), savings and cost fields are null.
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
router.get('/finops/run/:runId', (req: Request, res: Response) => {
  try {
    const runId = parseInt(req.params.runId as string, 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: 'Invalid runId' });
      return;
    }

    // Check run exists and get agent info
    const run = db.prepare(
      'SELECT id, agent, agent_model, workspace_id, spec_path FROM pipeline_runs WHERE id = ?'
    ).get(runId) as { id: number; agent: string | null; agent_model: string | null; workspace_id: string; spec_path: string } | undefined;

    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const agentType = run.agent || 'claude';
    const isSubscription = agentType === 'claude' || agentType === 'codex';

    // Per-story token usage
    const stories = db.prepare(`
      SELECT story_id, model, input_tokens, output_tokens, cost_usd
      FROM token_usage
      WHERE run_id = ?
      ORDER BY recorded_at ASC
    `).all(runId) as FinOpsStoryRow[];

    // Get model pricing for calculating costs from tokens
    const pricingRows = db.prepare(
      'SELECT model_id, input_cost_per_1m, output_cost_per_1m, input_cost_per_1k, output_cost_per_1k FROM model_pricing'
    ).all() as { model_id: string; input_cost_per_1m: number | null; output_cost_per_1m: number | null; input_cost_per_1k: number; output_cost_per_1k: number }[];

    const pricingMap = new Map<string, { input: number; output: number }>();
    for (const p of pricingRows) {
      pricingMap.set(p.model_id, {
        input: p.input_cost_per_1m ?? p.input_cost_per_1k * 1000,
        output: p.output_cost_per_1m ?? p.output_cost_per_1k * 1000,
      });
    }

    // Build per-story breakdown
    const perStory = stories.map(s => {
      const pricing = pricingMap.get(s.model);
      const actualCost = pricing
        ? (s.input_tokens / 1_000_000) * pricing.input + (s.output_tokens / 1_000_000) * pricing.output
        : s.cost_usd;
      const opusBaseline = (s.input_tokens / 1_000_000) * OPUS_INPUT_PER_1M + (s.output_tokens / 1_000_000) * OPUS_OUTPUT_PER_1M;
      return {
        storyId: s.story_id,
        model: s.model,
        tier: tierFromModel(s.model),
        inputTokens: s.input_tokens,
        outputTokens: s.output_tokens,
        actualCost: Math.round(actualCost * 10000) / 10000,
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
      existing.cost += s.actualCost;
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

    // Totals
    const totalActual = perStory.reduce((sum, s) => sum + s.actualCost, 0);
    const totalOpusBaseline = perStory.reduce((sum, s) => sum + s.opusBaseline, 0);
    const totalSaved = totalOpusBaseline - totalActual;
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
    const escalationEvents = db.prepare(`
      SELECT story_id, payload, ts
      FROM wal_events
      WHERE event_type = 'story_escalated'
        AND payload LIKE '%"run_id":${runId}%'
      ORDER BY ts ASC
    `).all() as EscalationWalRow[];

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
      isSubscription,
      runSummary,
      savings: isSubscription ? null : {
        opusBaseline: Math.round(totalOpusBaseline * 100) / 100,
        actual: Math.round(totalActual * 100) / 100,
        saved: Math.round(totalSaved * 100) / 100,
        percentage: Math.round(savingsPct * 10) / 10,
      },
      totals: {
        stories: totalStories,
        inputTokens: perStory.reduce((sum, s) => sum + s.inputTokens, 0),
        outputTokens: perStory.reduce((sum, s) => sum + s.outputTokens, 0),
        cost: isSubscription ? null : Math.round(totalActual * 100) / 100,
      },
      modelDistribution,
      perStory,
      escalationLog,
    });
  } catch (error: any) {
    logger.error('[Analytics] FinOps run query error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
 *     description: Returns cumulative cost data broken down by workspace, spec, and month, along with a daily cost trend for charts, model distribution, projected monthly cost, and savings vs all-Opus baseline. Default range is 90 days. For subscription-only runs, the savings field is null.
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
 *                 dailyTrend: { type: array, items: { type: object } }
 *                 byWorkspace: { type: array, items: { type: object } }
 *                 bySpec: { type: array, items: { type: object } }
 *                 byMonth: { type: array, items: { type: object } }
 *                 modelDistribution: { type: array, items: { type: object } }
 *                 projectedMonthlyCost: { type: number }
 *                 savings: { type: object, nullable: true }
 *                 allSubscription: { type: boolean }
 *                 dateRange: { type: object }
 *       500:
 *         description: Internal server error
 */
router.get('/finops/historical', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string | undefined;
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || ninetyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const wsFilter = workspaceId ? 'AND tu.workspace_id = ?' : '';
    const params: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

    // Daily cost trend (last 30 days for chart)
    const dailySql = `
      SELECT
        DATE(tu.recorded_at) AS date,
        SUM(tu.input_tokens) AS input_tokens,
        SUM(tu.output_tokens) AS output_tokens,
        SUM(tu.cost_usd) AS cost_usd,
        COUNT(DISTINCT tu.story_id || '-' || tu.run_id) AS story_count
      FROM token_usage tu
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
      GROUP BY DATE(tu.recorded_at)
      ORDER BY date ASC
    `;
    const dailyTrend = db.prepare(dailySql).all(...params) as {
      date: string; input_tokens: number; output_tokens: number; cost_usd: number; story_count: number;
    }[];

    // By workspace
    const byWorkspaceSql = `
      SELECT
        tu.workspace_id,
        COALESCE(w.label, tu.workspace_id) AS workspace_label,
        SUM(tu.cost_usd) AS total_cost,
        SUM(tu.input_tokens) AS input_tokens,
        SUM(tu.output_tokens) AS output_tokens,
        COUNT(DISTINCT tu.run_id) AS run_count
      FROM token_usage tu
      LEFT JOIN workspaces w ON tu.workspace_id = w.id
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
      GROUP BY tu.workspace_id
      ORDER BY total_cost DESC
    `;
    const byWorkspace = db.prepare(byWorkspaceSql).all(...params) as {
      workspace_id: string; workspace_label: string; total_cost: number;
      input_tokens: number; output_tokens: number; run_count: number;
    }[];

    // By spec
    const bySpecSql = `
      SELECT
        REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug,
        SUM(tu.cost_usd) AS total_cost,
        SUM(tu.input_tokens) AS input_tokens,
        SUM(tu.output_tokens) AS output_tokens,
        COUNT(DISTINCT tu.run_id) AS run_count
      FROM token_usage tu
      JOIN pipeline_runs pr ON tu.run_id = pr.id
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
      GROUP BY spec_slug
      ORDER BY total_cost DESC
      LIMIT 20
    `;
    const bySpec = db.prepare(bySpecSql).all(...params) as {
      spec_slug: string; total_cost: number; input_tokens: number;
      output_tokens: number; run_count: number;
    }[];

    // By month
    const byMonthSql = `
      SELECT
        strftime('%Y-%m', tu.recorded_at) AS month,
        SUM(tu.cost_usd) AS total_cost,
        SUM(tu.input_tokens) AS input_tokens,
        SUM(tu.output_tokens) AS output_tokens,
        COUNT(DISTINCT tu.run_id) AS run_count,
        COUNT(DISTINCT tu.story_id || '-' || tu.run_id) AS story_count
      FROM token_usage tu
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
      GROUP BY month
      ORDER BY month ASC
    `;
    const byMonth = db.prepare(byMonthSql).all(...params) as {
      month: string; total_cost: number; input_tokens: number;
      output_tokens: number; run_count: number; story_count: number;
    }[];

    // Model distribution across all runs
    const modelDistSql = `
      SELECT
        tu.model,
        COUNT(DISTINCT tu.story_id || '-' || tu.run_id) AS story_count,
        SUM(tu.cost_usd) AS total_cost
      FROM token_usage tu
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
      GROUP BY tu.model
      ORDER BY story_count DESC
    `;
    const modelDist = db.prepare(modelDistSql).all(...params) as {
      model: string; story_count: number; total_cost: number;
    }[];

    const totalStories = modelDist.reduce((sum, m) => sum + m.story_count, 0);
    const modelDistribution = modelDist.map(m => ({
      model: m.model,
      tier: tierFromModel(m.model),
      storyCount: m.story_count,
      totalCost: Math.round(m.total_cost * 100) / 100,
      percentage: totalStories > 0 ? Math.round((m.story_count / totalStories) * 1000) / 10 : 0,
    }));

    // Projected monthly cost: avg daily cost * 30
    const totalCostInRange = dailyTrend.reduce((sum, d) => sum + d.cost_usd, 0);
    const daysWithData = dailyTrend.length;
    const avgDailyCost = daysWithData > 0 ? totalCostInRange / daysWithData : 0;
    const projectedMonthlyCost = Math.round(avgDailyCost * 30 * 100) / 100;

    // Total savings vs all-opus baseline
    const opusBaselineSql = `
      SELECT
        SUM((tu.input_tokens * 1.0 / 1000000) * ${OPUS_INPUT_PER_1M} + (tu.output_tokens * 1.0 / 1000000) * ${OPUS_OUTPUT_PER_1M}) AS opus_baseline,
        SUM(tu.cost_usd) AS actual_cost
      FROM token_usage tu
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
    `;
    const baselineResult = db.prepare(opusBaselineSql).get(...params) as {
      opus_baseline: number | null; actual_cost: number | null;
    };

    const opusBaseline = baselineResult.opus_baseline || 0;
    const actualCost = baselineResult.actual_cost || 0;

    // Detect if all runs are subscription (claude)
    const agentCheckSql = `
      SELECT DISTINCT pr.agent
      FROM pipeline_runs pr
      JOIN token_usage tu ON tu.run_id = pr.id
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ? ${wsFilter}
    `;
    const agents = db.prepare(agentCheckSql).all(...params) as { agent: string | null }[];
    const allSubscription = agents.length > 0 && agents.every(a => !a.agent || a.agent === 'claude' || a.agent === 'codex');

    res.json({
      dailyTrend: dailyTrend.map(d => ({
        date: d.date,
        cost: Math.round(d.cost_usd * 100) / 100,
        inputTokens: d.input_tokens,
        outputTokens: d.output_tokens,
        storyCount: d.story_count,
      })),
      byWorkspace: byWorkspace.map(w => ({
        workspaceId: w.workspace_id,
        label: w.workspace_label,
        totalCost: Math.round(w.total_cost * 100) / 100,
        inputTokens: w.input_tokens,
        outputTokens: w.output_tokens,
        runCount: w.run_count,
      })),
      bySpec: bySpec.map(s => ({
        specSlug: s.spec_slug,
        totalCost: Math.round(s.total_cost * 100) / 100,
        inputTokens: s.input_tokens,
        outputTokens: s.output_tokens,
        runCount: s.run_count,
      })),
      byMonth: byMonth.map(m => ({
        month: m.month,
        totalCost: Math.round(m.total_cost * 100) / 100,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        runCount: m.run_count,
        storyCount: m.story_count,
      })),
      modelDistribution,
      projectedMonthlyCost,
      savings: allSubscription ? null : {
        opusBaseline: Math.round(opusBaseline * 100) / 100,
        actual: Math.round(actualCost * 100) / 100,
        saved: Math.round((opusBaseline - actualCost) * 100) / 100,
        percentage: opusBaseline > 0 ? Math.round(((opusBaseline - actualCost) / opusBaseline) * 1000) / 10 : 0,
      },
      allSubscription,
      dateRange: { from, to },
    });
  } catch (error: any) {
    logger.error('[Analytics] FinOps historical query error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/analytics/finops/export — CSV export of per-story cost data ────

/**
 * @swagger
 * /api/analytics/finops/export:
 *   get:
 *     tags: [Analytics]
 *     summary: CSV export of per-story cost data
 *     operationId: exportFinOpsCsv
 *     description: Exports per-story token usage and cost data as a CSV file. Includes computed columns for model tier, Opus baseline cost, and savings vs Opus. Can be filtered by run_id, workspace_id, and date range. The CSV includes headers for run_id, story_id, spec_slug, model, tier, agent_type, input_tokens, output_tokens, cost_usd, opus_baseline_usd, savings_usd, recorded_at, and workspace_id.
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
router.get('/finops/export', (req: Request, res: Response) => {
  try {
    const runId = req.query.run_id ? parseInt(req.query.run_id as string, 10) : undefined;
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const conditions: string[] = ['tu.recorded_at >= ?', 'tu.recorded_at <= ?'];
    const sqlParams: (string | number)[] = [from, to];

    if (runId) {
      conditions.push('tu.run_id = ?');
      sqlParams.push(runId);
    }
    if (workspaceId) {
      conditions.push('tu.workspace_id = ?');
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
        tu.cost_usd,
        tu.recorded_at,
        tu.workspace_id,
        REPLACE(REPLACE(pr.spec_path, 'forge/specs/approved/', ''), '.json', '') AS spec_slug,
        pr.agent AS agent_type
      FROM token_usage tu
      JOIN pipeline_runs pr ON tu.run_id = pr.id
      ${whereClause}
      ORDER BY tu.run_id ASC, tu.recorded_at ASC
    `;

    const rows = db.prepare(sql).all(...sqlParams) as ExportRow[];

    // Add computed columns
    const enrichedRows = rows.map(row => {
      const model = String(row.model || '');
      const inputTokens = Number(row.input_tokens || 0);
      const outputTokens = Number(row.output_tokens || 0);
      const opusBaseline = (inputTokens / 1_000_000) * OPUS_INPUT_PER_1M + (outputTokens / 1_000_000) * OPUS_OUTPUT_PER_1M;
      return {
        ...row,
        tier: tierFromModel(model),
        opus_baseline_usd: Math.round(opusBaseline * 10000) / 10000,
        savings_usd: Math.round((opusBaseline - Number(row.cost_usd || 0)) * 10000) / 10000,
      };
    });

    const headers = [
      'run_id', 'story_id', 'spec_slug', 'model', 'tier', 'agent_type',
      'input_tokens', 'output_tokens', 'cost_usd', 'opus_baseline_usd', 'savings_usd',
      'recorded_at', 'workspace_id',
    ];

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = runId ? `rorca-finops-run-${runId}-${ts}` : `rorca-finops-${ts}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.send(toCsvRows(headers, enrichedRows));
  } catch (error: any) {
    logger.error('[Analytics] FinOps export error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/skills/effectiveness', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId query parameter is required' });
    }

    const now = new Date();
    const since = (req.query.since as string) || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const until = now.toISOString();
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);

    // Total runs in window
    const totalRunsRow = db.prepare(
      `SELECT COUNT(DISTINCT id) AS cnt FROM pipeline_runs WHERE workspace_id = ? AND started_at >= ?`
    ).get(workspaceId, since) as { cnt: number } | undefined;
    const totalRuns = totalRunsRow?.cnt ?? 0;

    // Total stories in window
    const totalStoriesRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM story_results sr
       JOIN pipeline_runs pr ON sr.run_id = pr.id
       WHERE pr.workspace_id = ? AND sr.started_at >= ?`
    ).get(workspaceId, since) as { cnt: number } | undefined;
    const totalStories = totalStoriesRow?.cnt ?? 0;

    // Try json_each() approach first (SQLite 3.38+, bundled with better-sqlite3)
    let rows: SkillEffectivenessRow[];
    try {
      rows = db.prepare(
        `SELECT je.value AS skill_name, sr.status, sr.elapsed_seconds, sr.run_id
         FROM story_results sr, json_each(sr.active_skills) je
         JOIN pipeline_runs pr ON sr.run_id = pr.id
         WHERE pr.workspace_id = ? AND sr.started_at >= ? AND sr.active_skills IS NOT NULL`
      ).all(workspaceId, since) as SkillEffectivenessRow[];
    } catch {
      // Fallback: JS-side JSON parsing
      const rawRows = db.prepare(
        `SELECT sr.story_id, sr.status, sr.active_skills, sr.elapsed_seconds, sr.run_id
         FROM story_results sr
         JOIN pipeline_runs pr ON sr.run_id = pr.id
         WHERE pr.workspace_id = ? AND sr.started_at >= ? AND sr.active_skills IS NOT NULL`
      ).all(workspaceId, since) as Array<{ story_id: string; status: string; active_skills: string; elapsed_seconds: number | null; run_id: number }>;

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
    logger.error('[Analytics] Skill effectiveness error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
