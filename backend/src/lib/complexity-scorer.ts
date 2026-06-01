/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * complexity-scorer.ts — Story Complexity Scorer for Model Tier Assignment.
 *
 * OC-019: Analyzes each story before subprocess spawn and assigns a ModelTier
 * (haiku | sonnet | opus) based on complexity signals. Eliminates blind Opus
 * usage — routes cheap work to cheap models.
 *
 * Runs synchronously. Must add <10ms overhead per story.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface ScoringResult {
  tier: ModelTier;
  score: number;
  signals: string[];
}

export interface ScorerStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
}

export interface ScoringThresholds {
  haiku: number;   // score 0..haiku → haiku
  sonnet: number;  // score haiku+1..sonnet → sonnet
  // score sonnet+1..∞ → opus
}

export type RouterMode = 'auto' | 'fixed' | 'manual';

export type TaskType = 'echolocation' | 'planning' | 'coding' | 'lintFix' | 'testing' | 'documentation';

export const VALID_ROUTER_MODES: RouterMode[] = ['auto', 'fixed', 'manual'];
export const VALID_TASK_TYPES: TaskType[] = ['echolocation', 'planning', 'coding', 'lintFix', 'testing', 'documentation'];

export interface ThresholdRange {
  min: number;
  max: number;
}

export type CapabilityMismatchMode = 'warn' | 'reroute' | 'block';

export interface OrchestrationConfig {
  router: RouterMode;
  thresholds: ScoringThresholds;
  taskCascades: Record<TaskType, string>;
  tokenBudgetPerStory: number;
  /** Secondary engine for rate limit overflow rerouting. null = disabled. */
  fallbackEngine: 'claude' | 'opencode' | 'codex' | 'pi' | null;
  /** How to handle stories requiring tools the engine doesn't support. */
  capabilityMismatch: CapabilityMismatchMode;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: ScoringThresholds = {
  haiku: 30,
  sonnet: 65,
};

const DEFAULT_TASK_CASCADES: Record<TaskType, string> = {
  echolocation: 'claude-haiku-4-5-20251001',
  planning: 'claude-sonnet-4-6',
  coding: 'claude-sonnet-4-6',
  lintFix: 'claude-haiku-4-5-20251001',
  testing: 'claude-sonnet-4-6',
  documentation: 'claude-haiku-4-5-20251001',
};

const DEFAULT_TOKEN_BUDGET_PER_STORY = 50000;

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
    router: 'auto',
    thresholds: { ...DEFAULT_THRESHOLDS },
    taskCascades: { ...DEFAULT_TASK_CASCADES },
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

    // Parse router mode
    const router: RouterMode = typeof orch.router === 'string' && (VALID_ROUTER_MODES as string[]).includes(orch.router)
      ? orch.router as RouterMode
      : 'auto';

    // Parse thresholds — support both { haiku: 30 } (legacy) and { haiku: [0, 30] } (range) formats
    const parseThreshold = (val: unknown, fallback: number): number => {
      if (typeof val === 'number') return val;
      if (Array.isArray(val) && val.length === 2 && typeof val[1] === 'number') return val[1];
      return fallback;
    };

    // Parse fallbackEngine
    const VALID_ENGINES = ['claude', 'opencode', 'codex'] as const;
    const parsedFallback = typeof orch.fallbackEngine === 'string' && (VALID_ENGINES as readonly string[]).includes(orch.fallbackEngine)
      ? orch.fallbackEngine as 'claude' | 'opencode' | 'codex'
      : null;

    // Parse capabilityMismatch
    const VALID_MISMATCH_MODES: CapabilityMismatchMode[] = ['warn', 'reroute', 'block'];
    const parsedMismatch: CapabilityMismatchMode =
      typeof orch.capabilityMismatch === 'string' && (VALID_MISMATCH_MODES as string[]).includes(orch.capabilityMismatch)
        ? orch.capabilityMismatch as CapabilityMismatchMode
        : 'warn';

    const config: OrchestrationConfig = {
      router,
      thresholds: {
        haiku: parseThreshold(orch.thresholds?.haiku, DEFAULT_THRESHOLDS.haiku),
        sonnet: parseThreshold(orch.thresholds?.sonnet, DEFAULT_THRESHOLDS.sonnet),
      },
      taskCascades: { ...DEFAULT_TASK_CASCADES },
      tokenBudgetPerStory: typeof orch.tokenBudgetPerStory === 'number' && orch.tokenBudgetPerStory > 0
        ? orch.tokenBudgetPerStory
        : DEFAULT_TOKEN_BUDGET_PER_STORY,
      fallbackEngine: parsedFallback,
      capabilityMismatch: parsedMismatch,
    };

    // Merge user-provided task cascade overrides (taskType → model ID)
    if (orch.taskCascades && typeof orch.taskCascades === 'object') {
      for (const taskType of VALID_TASK_TYPES) {
        if (typeof orch.taskCascades[taskType] === 'string') {
          config.taskCascades[taskType] = orch.taskCascades[taskType];
        }
      }
    }

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
 * Score a story's complexity and assign a ModelTier.
 *
 * Scoring signals:
 * - dependsOn depth: +10 per level
 * - acceptanceCriteria count: +5 each
 * - File path patterns in description: docs/**→-20, src/core/**→+20
 * - Story type tag: docs→haiku, test→sonnet, feat→sonnet/opus, architecture→opus
 * - Keyword detection in description
 *
 * @param story - The story to score
 * @param allStories - All stories in the spec (for dependency depth calculation)
 * @param cwd - Workspace root (for loading .rorca/config.json)
 * @returns ScoringResult with tier, numeric score, and signal descriptions
 */
export function score(
  story: ScorerStory,
  allStories: ScorerStory[] = [],
  cwd?: string,
): ScoringResult {
  const config = loadOrchestrationConfig(cwd);

  // router='fixed' → always return sonnet (spec model used directly by execution-engine)
  if (config.router === 'fixed') {
    return { tier: 'sonnet', score: 50, signals: ['router:fixed'] };
  }

  // router='manual' → check story-level modelTier override
  if (config.router === 'manual') {
    const storyAny = story as ScorerStory & { modelTier?: string };
    if (storyAny.modelTier && ['haiku', 'sonnet', 'opus'].includes(storyAny.modelTier)) {
      return { tier: storyAny.modelTier as ModelTier, score: 50, signals: [`router:manual(${storyAny.modelTier})`] };
    }
    // Fall through to auto scoring if no per-story override
  }

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
      break; // only one keyword bonus per tier
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

  // Assign tier based on thresholds
  let tier: ModelTier;
  if (totalScore <= config.thresholds.haiku) {
    tier = 'haiku';
  } else if (totalScore <= config.thresholds.sonnet) {
    tier = 'sonnet';
  } else {
    tier = 'opus';
  }

  return { tier, score: totalScore, signals };
}
