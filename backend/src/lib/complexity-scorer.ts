/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * complexity-scorer.ts — Story Complexity Scorer for Effort Assignment.
 *
 * Effort-only routing: Rorca no longer routes stories to per-tier models
 * (the Claude haiku | sonnet | opus taxonomy was removed). Stories execute on
 * the operator's configured model; a story's declared complexity now maps to a
 * reasoning effort level (low | medium | high) per story.
 *
 * - effortForComplexity() derives the runtime effort from the story's declared
 *   complexity field (1-5): 1-2 → low, 3 → medium, 4-5 → high. Missing
 *   complexity falls back to medium. The derived effort never emits max/xhigh —
 *   those remain available only as explicit operator overrides (run flags).
 * - score() still computes a numeric complexity signal (dependency depth,
 *   acceptance criteria count, path patterns, story tag, keywords) for
 *   diagnostics/display, and reports the derived effort alongside it.
 *
 * Runs synchronously. Must add <10ms overhead per story.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Reasoning effort levels the effort-scorer may emit. */
export type EffortLevel = 'low' | 'medium' | 'high';

export interface ScoringResult {
  /** Reasoning effort derived from the story's declared complexity. */
  effort: EffortLevel;
  /** Numeric complexity signal (diagnostics/display only). */
  score: number;
  /** Human-readable breakdown of the scoring signals. */
  signals: string[];
}

export interface ScorerStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  /** Declared 1-5 complexity from the spec. Drives effort routing. */
  complexity?: number;
}

export type CapabilityMismatchMode = 'warn' | 'reroute' | 'block';

export interface OrchestrationConfig {
  tokenBudgetPerStory: number;
  /** Secondary engine for rate limit overflow rerouting. null = disabled. */
  fallbackEngine: 'claude' | 'opencode' | 'codex' | 'pi' | 'omp' | null;
  /** How to handle stories requiring tools the engine doesn't support. */
  capabilityMismatch: CapabilityMismatchMode;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_BUDGET_PER_STORY = 50000;

// ─── Effort Derivation ──────────────────────────────────────────────────────

/**
 * Map a story's declared complexity (1-5) to a reasoning effort level.
 *
 *   1-2 → low, 3 → medium, 4-5 → high.
 *
 * Missing/invalid complexity defaults to medium (neutral). The scorer never
 * emits max/xhigh: per-story effort is capped at high by policy; stronger
 * effort is only available as an explicit operator override.
 */
export function effortForComplexity(complexity?: number): EffortLevel {
  if (typeof complexity !== 'number' || !Number.isFinite(complexity)) return 'medium';
  if (complexity <= 2) return 'low';
  if (complexity <= 3) return 'medium';
  return 'high';
}

// ─── Keyword Detection ──────────────────────────────────────────────────────

const HAIKU_KEYWORDS = [
  'rename', 'update import', 'fix typo', 'typo', 'update copy',
  'bump version', 'add comment', 'update readme', 'fix lint',
  'remove unused', 'update config',
];

const SONNET_KEYWORDS = [
  'refactor', 'migrate', 'add test', 'write test', 'integration test',
  'add endpoint', 'add route', 'add validation', 'update schema',
];

const OPUS_KEYWORDS = [
  'design', 'architect', 'implement from scratch', 'security',
  'authentication', 'authorization', 'payment', 'encryption',
  'database migration', 'new system', 'core engine',
];

// ─── File Path Patterns ─────────────────────────────────────────────────────

interface PathScoreRule {
  pattern: RegExp;
  delta: number;
  label: string;
}

const PATH_SCORE_RULES: PathScoreRule[] = [
  { pattern: /\bdocs?\b/i, delta: -20, label: 'docs path (-20)' },
  { pattern: /\breadme\b/i, delta: -20, label: 'readme path (-20)' },
  { pattern: /\bchangelog\b/i, delta: -15, label: 'changelog path (-15)' },
  { pattern: /\bconfig\b/i, delta: -10, label: 'config path (-10)' },
  { pattern: /\bsrc\/core\b/i, delta: 20, label: 'src/core path (+20)' },
  { pattern: /\bsrc\/lib\b/i, delta: 15, label: 'src/lib path (+15)' },
  { pattern: /\bsrc\/db\b/i, delta: 15, label: 'src/db path (+15)' },
  { pattern: /\bsecurity\b/i, delta: 20, label: 'security path (+20)' },
  { pattern: /\bauth\b/i, delta: 15, label: 'auth path (+15)' },
];

// ─── Story Type Tag Detection ───────────────────────────────────────────────

type StoryTag = 'docs' | 'test' | 'feat' | 'architecture' | 'unknown';

function detectStoryTag(story: ScorerStory): StoryTag {
  const lower = (story.title + ' ' + story.description).toLowerCase();

  if (/\b(architect|architecture|system design|design system|core engine)\b/.test(lower)) {
    return 'architecture';
  }
  if (/\b(document|documentation|readme|changelog|jsdoc|update docs)\b/.test(lower)) {
    return 'docs';
  }
  if (/\b(test|testing|spec|e2e|unit test|integration test|playwright)\b/.test(lower)) {
    return 'test';
  }
  return 'feat';
}

const TAG_SCORE_MAP: Record<StoryTag, { delta: number; label: string }> = {
  docs: { delta: -25, label: 'tag:docs (-25)' },
  test: { delta: 5, label: 'tag:test (+5)' },
  feat: { delta: 10, label: 'tag:feat (+10)' },
  architecture: { delta: 30, label: 'tag:architecture (+30)' },
  unknown: { delta: 0, label: 'tag:unknown (+0)' },
};

// ─── Config Loader ──────────────────────────────────────────────────────────

let cachedConfig: OrchestrationConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Load orchestration config from .rorca/config.json.
 * Falls back to defaults if file doesn't exist or is malformed.
 * Caches per cwd path.
 */
export function loadOrchestrationConfig(cwd?: string): OrchestrationConfig {
  const configPath = cwd
    ? path.join(cwd, '.rorca', 'config.json')
    : null;

  if (configPath && configPath === cachedConfigPath && cachedConfig) {
    return cachedConfig;
  }

  const defaults: OrchestrationConfig = {
    tokenBudgetPerStory: DEFAULT_TOKEN_BUDGET_PER_STORY,
    fallbackEngine: null,
    capabilityMismatch: 'warn',
  };

  if (!configPath) return defaults;

  try {
    if (!fs.existsSync(configPath)) return defaults;

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const orch = raw?.orchestration;
    if (!orch) return defaults;

    // Parse fallbackEngine
    const VALID_ENGINES = ['claude', 'opencode', 'codex', 'pi', 'omp'] as const;
    const parsedFallback = typeof orch.fallbackEngine === 'string' && (VALID_ENGINES as readonly string[]).includes(orch.fallbackEngine)
      ? orch.fallbackEngine as 'claude' | 'opencode' | 'codex' | 'pi' | 'omp'
      : null;

    // Parse capabilityMismatch
    const VALID_MISMATCH_MODES: CapabilityMismatchMode[] = ['warn', 'reroute', 'block'];
    const parsedMismatch: CapabilityMismatchMode =
      typeof orch.capabilityMismatch === 'string' && (VALID_MISMATCH_MODES as string[]).includes(orch.capabilityMismatch)
        ? orch.capabilityMismatch as CapabilityMismatchMode
        : 'warn';

    const config: OrchestrationConfig = {
      tokenBudgetPerStory: typeof orch.tokenBudgetPerStory === 'number' && orch.tokenBudgetPerStory > 0
        ? orch.tokenBudgetPerStory
        : DEFAULT_TOKEN_BUDGET_PER_STORY,
      fallbackEngine: parsedFallback,
      capabilityMismatch: parsedMismatch,
    };

    cachedConfig = config;
    cachedConfigPath = configPath;
    return config;
  } catch {
    return defaults;
  }
}

/** Clear cached config (useful for tests). */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
}

// ─── Dependency Depth Calculator ────────────────────────────────────────────

/**
 * Calculate the maximum dependency depth for a story.
 * depth 0 = no dependencies, depth 1 = depends on stories with no deps, etc.
 */
function computeDependencyDepth(
  storyId: string,
  allStories: ScorerStory[],
  visited: Set<string> = new Set(),
): number {
  if (visited.has(storyId)) return 0; // cycle guard
  visited.add(storyId);

  const story = allStories.find(s => s.id === storyId);
  if (!story || !story.dependsOn?.length) return 0;

  let maxDepth = 0;
  for (const depId of story.dependsOn) {
    const depth = computeDependencyDepth(depId, allStories, new Set(visited));
    if (depth + 1 > maxDepth) maxDepth = depth + 1;
  }
  return maxDepth;
}

// ─── Core Scorer ────────────────────────────────────────────────────────────

/**
 * Score a story's complexity and derive its reasoning effort.
 *
 * Effort comes from the story's declared complexity field via
 * effortForComplexity(). The numeric score is a diagnostics signal only:
 * - dependsOn depth: +10 per level
 * - acceptanceCriteria count: +5 each
 * - File path patterns in description: docs/**→-20, src/core/**→+20
 * - Story type tag: docs→-25, test→+5, feat→+10, architecture→+30
 * - Keyword detection in description
 *
 * @param story - The story to score
 * @param allStories - All stories in the spec (for dependency depth calculation)
 * @returns ScoringResult with effort, numeric score, and signal descriptions
 */
export function score(
  story: ScorerStory,
  allStories: ScorerStory[] = [],
): ScoringResult {
  const signals: string[] = [];
  let totalScore = 0;

  // 1. Dependency depth: +10 per level
  const depthStories = allStories.length > 0 ? allStories : [story];
  const depth = computeDependencyDepth(story.id, depthStories);
  if (depth > 0) {
    const delta = depth * 10;
    totalScore += delta;
    signals.push(`dependsOn depth ${depth} (+${delta})`);
  }

  // 2. Acceptance criteria count: +5 each
  const acCount = story.acceptanceCriteria?.length ?? 0;
  if (acCount > 0) {
    const delta = acCount * 5;
    totalScore += delta;
    signals.push(`acceptanceCriteria ×${acCount} (+${delta})`);
  }

  // 3. File path patterns in description
  const text = story.title + ' ' + story.description;
  for (const rule of PATH_SCORE_RULES) {
    if (rule.pattern.test(text)) {
      totalScore += rule.delta;
      signals.push(rule.label);
    }
  }

  // 4. Story type tag
  const tag = detectStoryTag(story);
  const tagScore = TAG_SCORE_MAP[tag];
  if (tagScore.delta !== 0) {
    totalScore += tagScore.delta;
    signals.push(tagScore.label);
  }

  // 5. Keyword detection in description
  const lowerDesc = (story.description + ' ' + story.title).toLowerCase();

  let keywordApplied = false;
  for (const kw of OPUS_KEYWORDS) {
    if (lowerDesc.includes(kw)) {
      totalScore += 25;
      signals.push(`keyword:"${kw}" (+25)`);
      keywordApplied = true;
      break; // only one keyword bonus
    }
  }
  if (!keywordApplied) {
    for (const kw of SONNET_KEYWORDS) {
      if (lowerDesc.includes(kw)) {
        totalScore += 10;
        signals.push(`keyword:"${kw}" (+10)`);
        keywordApplied = true;
        break;
      }
    }
  }
  if (!keywordApplied) {
    for (const kw of HAIKU_KEYWORDS) {
      if (lowerDesc.includes(kw)) {
        totalScore -= 10;
        signals.push(`keyword:"${kw}" (-10)`);
        break;
      }
    }
  }

  // Floor at 0
  totalScore = Math.max(0, totalScore);

  return { effort: effortForComplexity(story.complexity), score: totalScore, signals };
}
