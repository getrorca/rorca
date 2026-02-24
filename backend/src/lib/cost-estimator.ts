import { db } from '../db/index';
import { synthesize } from './direction-stack';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StoryCostEstimate {
  storyId: string;
  title: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}

export interface DryRunEstimate {
  model: string;
  stories: StoryCostEstimate[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
}

interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn?: string[];
  excluded?: boolean;
}

interface ModelPricingRow {
  model_id: string;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
}

// ─── Token Heuristic ─────────────────────────────────────────────────────────

/** Estimate token count from character count (chars / 4 approximation) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Historical Output Estimate ──────────────────────────────────────────────

/**
 * Get average output tokens from historical story_results.
 * Uses elapsed_seconds as a complexity proxy — stories with similar
 * elapsed time likely produce similar output volumes.
 * Falls back to a default estimate if no history exists.
 */
function getHistoricalOutputEstimate(workspaceId: string): number {
  const DEFAULT_OUTPUT_TOKENS = 4000;

  // Get average elapsed_seconds from completed stories in this workspace
  const avg = db.prepare(`
    SELECT AVG(sr.elapsed_seconds) as avg_elapsed
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    WHERE pr.workspace_id = ?
      AND sr.status = 'pass'
      AND sr.elapsed_seconds IS NOT NULL
  `).get(workspaceId) as { avg_elapsed: number | null } | undefined;

  if (!avg?.avg_elapsed) return DEFAULT_OUTPUT_TOKENS;

  // Rough heuristic: ~20 tokens/second of Claude output time
  // This accounts for thinking + output generation
  return Math.ceil(avg.avg_elapsed * 20);
}

// ─── Main Estimator ──────────────────────────────────────────────────────────

export function estimateDryRunCost(
  specJson: { userStories: UserStory[]; model?: string },
  workspaceId: string,
  model: string,
): DryRunEstimate {
  // 1. Fetch model pricing
  const pricing = db.prepare(
    'SELECT * FROM model_pricing WHERE model_id = ?'
  ).get(model) as ModelPricingRow | undefined;

  if (!pricing) {
    throw new Error(`No pricing data for model: ${model}. Add it to model_pricing table.`);
  }

  // 2. Build direction stack context to estimate base input size
  const workspace = db.prepare(
    'SELECT * FROM workspaces WHERE id = ?'
  ).get(workspaceId) as { id: string; path: string; domain?: string } | undefined;

  const domain = (workspace as any)?.domain || '';

  const l1Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
  ).get() as { content_yaml: string } | undefined;

  const l2Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = ? AND COALESCE(workspace_id, '') = ''`
  ).get(domain) as { content_yaml: string } | undefined;

  const l3Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
  ).get(workspaceId) as { content_yaml: string } | undefined;

  const ctx = db.prepare(
    `SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = ?`
  ).get(workspaceId) as { schema_snapshot: string | null; git_memory: string | null } | undefined;

  // Synthesize a minimal direction stack (using empty spec brief as placeholder)
  const directionContext = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    schemaSnapshot: ctx?.schema_snapshot || undefined,
    gitMemory: ctx?.git_memory || undefined,
    specBrief: '',
  });

  const directionTokens = estimateTokens(directionContext);

  // 3. Get historical output estimate
  const avgOutputTokens = getHistoricalOutputEstimate(workspaceId);

  // 4. Estimate per-story costs (skip excluded stories)
  const activeStories = specJson.userStories.filter((s) => s.excluded !== true);
  const stories: StoryCostEstimate[] = activeStories.map((story) => {
    // Each story prompt includes: direction context + story-specific content
    const storyPrompt = [
      story.title,
      story.description,
      ...(story.acceptanceCriteria || []),
    ].join('\n');

    const storyInputTokens = directionTokens + estimateTokens(storyPrompt);
    const storyOutputTokens = avgOutputTokens;

    const inputCost = (storyInputTokens / 1000) * pricing.input_cost_per_1k;
    const outputCost = (storyOutputTokens / 1000) * pricing.output_cost_per_1k;

    return {
      storyId: story.id,
      title: story.title,
      estimatedInputTokens: storyInputTokens,
      estimatedOutputTokens: storyOutputTokens,
      estimatedCostUsd: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    };
  });

  const totalInputTokens = stories.reduce((sum, s) => sum + s.estimatedInputTokens, 0);
  const totalOutputTokens = stories.reduce((sum, s) => sum + s.estimatedOutputTokens, 0);
  const totalEstimatedCostUsd = stories.reduce((sum, s) => sum + s.estimatedCostUsd, 0);

  return {
    model,
    stories,
    totalInputTokens,
    totalOutputTokens,
    totalEstimatedCostUsd: Math.round(totalEstimatedCostUsd * 1_000_000) / 1_000_000,
    inputCostPer1k: pricing.input_cost_per_1k,
    outputCostPer1k: pricing.output_cost_per_1k,
  };
}
