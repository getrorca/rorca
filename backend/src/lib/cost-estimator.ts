/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne } from '../db/index';
import { synthesize } from './direction-stack';
import { detectCapability } from './reasoning-detector';

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
  /**
   * Cost multiplier applied when reasoning is enabled at the requested effort level.
   * undefined when reasoning was not requested or no multiplier data is available.
   */
  reasoningCostMultiplier?: number;
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
async function getHistoricalOutputEstimate(workspaceId: string): Promise<number> {
  const DEFAULT_OUTPUT_TOKENS = 4000;

  // Get average elapsed_seconds from completed stories in this workspace
  const avg = await queryOne<{ avg_elapsed: number | null }>(`
    SELECT AVG(sr.elapsed_seconds) as avg_elapsed
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    WHERE pr.workspace_id = $1
      AND sr.status = 'pass'
      AND sr.elapsed_seconds IS NOT NULL
  `, [workspaceId]);

  if (!avg?.avg_elapsed) return DEFAULT_OUTPUT_TOKENS;

  // Rough heuristic: ~20 tokens/second of Claude output time
  // This accounts for thinking + output generation
  return Math.ceil(avg.avg_elapsed * 20);
}

// ─── Main Estimator ──────────────────────────────────────────────────────────

export async function estimateDryRunCost(
  specJson: { userStories: UserStory[]; model?: string },
  workspaceId: string,
  model: string,
  reasoningOptions?: { enabled: boolean; effort?: string },
): Promise<DryRunEstimate> {
  // 1. Fetch model pricing
  const pricing = await queryOne<ModelPricingRow>(
    'SELECT * FROM model_pricing WHERE model_id = $1',
    [model]
  );

  if (!pricing) {
    // Unknown model — return a zero-cost estimate rather than crashing the trigger
    return {
      model,
      stories: specJson.userStories.map(s => ({
        storyId: s.id,
        title: s.title,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
      })),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUsd: 0,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
    };
  }

  // 2. Build direction stack context to estimate base input size
  const workspace = await queryOne<{ id: string; path: string; domain?: string }>(
    'SELECT * FROM workspaces WHERE id = $1',
    [workspaceId]
  );

  const domain = (workspace as any)?.domain || '';

  const l1Row = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
  );

  const l2Row = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND COALESCE(workspace_id, '') = ''`,
    [domain]
  );

  const l3Row = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
    [workspaceId]
  );

  const ctx = await queryOne<{ schema_snapshot: string | null }>(
    `SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1`,
    [workspaceId]
  );

  // Synthesize a minimal direction stack (using empty spec brief as placeholder)
  const directionContext = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    schemaSnapshot: ctx?.schema_snapshot || undefined,
    specBrief: '',
  });

  const directionTokens = estimateTokens(directionContext);

  // 3. Get historical output estimate
  const avgOutputTokens = await getHistoricalOutputEstimate(workspaceId);

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

  // Compute reasoning cost multiplier for the requested effort level (if any)
  let reasoningCostMultiplier: number | undefined;
  if (reasoningOptions?.enabled) {
    const capability = detectCapability(model);
    if (capability.costMultiplier) {
      const effort = reasoningOptions.effort ?? capability.defaultEffort ?? 'default';
      reasoningCostMultiplier = capability.costMultiplier[effort] ?? capability.costMultiplier['default'];
    }
  }

  return {
    model,
    stories,
    totalInputTokens,
    totalOutputTokens,
    totalEstimatedCostUsd: Math.round(totalEstimatedCostUsd * 1_000_000) / 1_000_000,
    inputCostPer1k: pricing.input_cost_per_1k,
    outputCostPer1k: pricing.output_cost_per_1k,
    reasoningCostMultiplier,
  };
}
