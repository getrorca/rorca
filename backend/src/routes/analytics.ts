import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { db } from '../db/index';

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
      spec: "REPLACE(REPLACE(pr.spec_path, 'ralph/specs/approved/', ''), '.json', '')",
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
    console.error('[Analytics] Usage query error:', error);
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
      spec: "REPLACE(REPLACE(pr.spec_path, 'ralph/specs/approved/', ''), '.json', '')",
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
    console.error('[Analytics] Costs query error:', error);
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
    console.error('[Analytics] Pricing list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /api/analytics/pricing/:modelId — Update or create model pricing ────

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
    console.error('[Analytics] Pricing update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/analytics/pricing/:modelId — Remove model pricing ───────────

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
    console.error('[Analytics] Pricing delete error:', error);
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
    console.error('[Analytics] Models comparison error:', error);
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
      conditions.push("REPLACE(REPLACE(pr.spec_path, 'ralph/specs/approved/', ''), '.json', '') = ?");
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
        REPLACE(REPLACE(pr.spec_path, 'ralph/specs/approved/', ''), '.json', '') AS spec_slug
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
        REPLACE(REPLACE(pr.spec_path, 'ralph/specs/approved/', ''), '.json', '') AS spec_slug
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
    console.error('[Analytics] Velocity query error:', error);
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
        const absPath = path.join(row.workspace_path, 'scripts', row.spec_path);
        if (fs.existsSync(absPath)) {
          const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
          const stories: any[] = raw.userStories ?? raw.stories ?? [];

          // Get tags from spec_tags table
          const specId = row.spec_path
            .replace('ralph/specs/approved/', '')
            .replace('ralph/specs/pending/', '')
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
    console.error('[Analytics] Completion rates error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
