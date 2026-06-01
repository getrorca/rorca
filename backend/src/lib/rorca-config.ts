/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * rorca-config.ts — Typed config loader for .rorca/config.json.
 *
 * CIE-003: Canonical config with zod validation. Loads, validates, and caches
 * the .rorca/config.json from any workspace path. Falls back to defaults if
 * the file is missing or malformed.
 *
 * This is the single source of truth for .rorca/config.json types and loading.
 * complexity-scorer.ts's loadOrchestrationConfig delegates here for the
 * orchestration section; context-router.ts (CIE-004) will consume routing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { logger } from './logger';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const RoutingScopeSchema = z.object({
  path: z.string(),
  inject: z.array(z.string()),
  priority: z.number().int().min(0).max(100).default(50),
  managed: z.enum(['rorca', 'manual', 'hybrid']).default('rorca'),
});

const RoutingTagSchema = z.object({
  tag: z.string(),
  inject: z.array(z.string()),
});

const RoutingSchema = z.object({
  global: z.array(z.string()).default(['CLAUDE.md', 'AGENTS.md']),
  scopes: z.array(RoutingScopeSchema).default([]),
  tags: z.array(RoutingTagSchema).default([]),
  tokenBudget: z.number().int().min(1000).max(200000).default(32000),
});

const FileRegistryEntrySchema = z.object({
  path: z.string(),
  role: z.enum(['context', 'skill', 'memory', 'template', 'governance']),
  managed: z.enum(['rorca', 'manual', 'hybrid']).default('rorca'),
});

const MemoryConfigSchema = z.object({
  ledgerPath: z.string().default('.rorca/memory/MEMORY.md'),
  maxEntries: z.number().int().min(10).default(500),
  autoCapture: z.boolean().default(true),
});

const RetrievalConfigSchema = z.object({
  graphScoreWeight: z.number().min(0).max(1).default(0),
});

const ContextSchema = z.object({
  fileRegistry: z.array(FileRegistryEntrySchema).default([]),
  memory: MemoryConfigSchema.default(() => MemoryConfigSchema.parse({})),
  retrieval: RetrievalConfigSchema.default(() => RetrievalConfigSchema.parse({})),
});

const DirectionLayer = z.enum(['L1', 'L2', 'L3', 'L4', 'L5']);

const TeleologySchema = z.object({
  specDir: z.string().default('forge/specs'),
  directionStackLayers: z.array(DirectionLayer).default(['L1', 'L2', 'L3', 'L4', 'L5']),
  defaultModel: z.string().optional(),
});

const ThresholdValue = z.union([
  z.number().min(0).max(100),
  z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]),
]);

const ModelTierEnum = z.enum(['haiku', 'sonnet', 'opus']);

const CascadeModelIdsSchema = z.object({
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
});

const ThresholdsSchema = z.object({
  haiku: ThresholdValue.default([0, 30] as [number, number]),
  sonnet: ThresholdValue.default([31, 65] as [number, number]),
  opus: ThresholdValue.default([66, 100] as [number, number]),
});

const EscalationSchema = z.object({
  enabled: z.boolean().default(true),
  maxRetriesOnTier: z.number().int().min(0).default(2),
  chain: z.array(ModelTierEnum).default(['haiku', 'sonnet', 'opus']),
  escalateTo: z.record(z.string(), z.union([ModelTierEnum, z.null()])).optional(),
});

const TaskCascadesSchema = z.object({
  echolocation: z.string().optional(),
  planning: z.string().optional(),
  coding: z.string().optional(),
  lintFix: z.string().optional(),
  testing: z.string().optional(),
  documentation: z.string().optional(),
});

const OrchestrationSchema = z.object({
  router: z.enum(['auto', 'fixed', 'manual']).default('auto'),
  thresholds: ThresholdsSchema.default(() => ThresholdsSchema.parse({})),
  cascades: z.record(z.string(), CascadeModelIdsSchema).optional(),
  taskCascades: TaskCascadesSchema.optional(),
  escalation: EscalationSchema.default(() => EscalationSchema.parse({})),
  tokenBudgetPerStory: z.number().min(1000).default(50000),
  fallbackEngine: z.enum(['claude', 'opencode', 'codex', 'pi']).nullable().default(null),
  capabilityMismatch: z.enum(['warn', 'reroute', 'block']).default('warn'),
});

const AdversarialReviewSchema = z.object({
  enabled: z.boolean().default(false),
  reviewTimeoutMin: z.number().int().min(1).max(30).default(5),
});

const GatesSchema = z.object({
  typecheck: z.boolean().default(true),
  e2e: z.boolean().default(true),
  /** 'blocking' = gate failure fails the story (old behaviour). 'warning' = log and continue. */
  mode: z.enum(['blocking', 'warning']).default('warning'),
});

const ExecutionSchema = z.object({
  waveParallelism: z.boolean().default(false),
  storyTimeoutMin: z.number().int().min(1).default(45),
  maxRetries: z.number().int().min(0).default(3),
  autoCommit: z.boolean().default(true),
  adversarialReview: AdversarialReviewSchema.default(() => AdversarialReviewSchema.parse({})),
  gates: GatesSchema.default(() => GatesSchema.parse({})),
});

const PersonasConfigSchema = z.object({
  /** Persona names that are disabled (not injected by buildPrompt / PersonaRegistry). */
  disabled: z.array(z.string()).default([]),
});

const EmbeddingSchema = z.object({
  provider: z.enum(['auto', 'openai', 'openai-large', 'openrouter', 'voyage', 'google', 'local']).default('auto'),
  model: z.string().optional(),
});

const GithubConfigSchema = z.object({
  prTemplate: z.string().optional(),
});

export const RorcaConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.number().int().min(1).default(1),
  routing: RoutingSchema.default(() => RoutingSchema.parse({})),
  context: ContextSchema.default(() => ContextSchema.parse({})),
  teleology: TeleologySchema.default(() => TeleologySchema.parse({})),
  orchestration: OrchestrationSchema.default(() => OrchestrationSchema.parse({})),
  execution: ExecutionSchema.default(() => ExecutionSchema.parse({})),
  personas: PersonasConfigSchema.default(() => PersonasConfigSchema.parse({})),
  embedding: EmbeddingSchema.default(() => EmbeddingSchema.parse({})),
  github: GithubConfigSchema.default(() => GithubConfigSchema.parse({})),
});

// ─── Exported Types ──────────────────────────────────────────────────────────

export type RorcaConfig = z.infer<typeof RorcaConfigSchema>;
export type RoutingConfig = z.infer<typeof RoutingSchema>;
export type RoutingScope = z.infer<typeof RoutingScopeSchema>;
export type RoutingTag = z.infer<typeof RoutingTagSchema>;
export type ContextConfig = z.infer<typeof ContextSchema>;
export type FileRegistryEntry = z.infer<typeof FileRegistryEntrySchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;
export type TeleologyConfig = z.infer<typeof TeleologySchema>;
export type OrchestrationConfig = z.infer<typeof OrchestrationSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionSchema>;
export type GatesConfig = z.infer<typeof GatesSchema>;
export type AdversarialReviewConfig = z.infer<typeof AdversarialReviewSchema>;
export type PersonasConfig = z.infer<typeof PersonasConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingSchema>;
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

// ─── Config Loading ──────────────────────────────────────────────────────────

/** Cache by workspace path to avoid repeated disk reads + parse. */
let cachedConfig: RorcaConfig | null = null;
let cachedConfigPath: string | null = null;
let cachedMtime: number = 0;

/**
 * Resolve the .rorca/config.json path for a workspace.
 */
export function configPath(workspacePath: string): string {
  return path.join(workspacePath, '.rorca', 'config.json');
}

/**
 * Load and validate .rorca/config.json from a workspace directory.
 *
 * - Returns typed, validated config with defaults filled in.
 * - Falls back to full defaults if file is missing.
 * - Throws on invalid JSON syntax (parse error).
 * - Logs warnings on schema violations but returns defaults for invalid sections.
 * - Caches by path + mtime — re-reads only if file changed.
 */
export function loadRorcaConfig(workspacePath: string): RorcaConfig {
  const cfgPath = configPath(workspacePath);

  // Check cache validity
  if (cachedConfig && cachedConfigPath === cfgPath) {
    try {
      const stat = fs.statSync(cfgPath);
      if (stat.mtimeMs === cachedMtime) {
        return cachedConfig;
      }
    } catch {
      // File was deleted — return defaults
    }
  }

  // No file → full defaults
  if (!fs.existsSync(cfgPath)) {
    const defaults = RorcaConfigSchema.parse({});
    // Don't cache missing file — it may appear later
    return defaults;
  }

  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const result = RorcaConfigSchema.parse(parsed);

    // Cache
    cachedConfig = result;
    cachedConfigPath = cfgPath;
    try {
      cachedMtime = fs.statSync(cfgPath).mtimeMs;
    } catch {
      cachedMtime = 0;
    }

    return result;
  } catch (err) {
    if (err instanceof SyntaxError) {
      logger.error(`[rorca-config] Invalid JSON in ${cfgPath}: ${err.message}`);
      throw err; // Don't silently swallow parse errors
    }
    if (err instanceof z.ZodError) {
      logger.warn(`[rorca-config] Schema validation warnings for ${cfgPath}:`);
      for (const issue of err.issues) {
        logger.warn(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
    }
    // Return defaults on validation errors
    return RorcaConfigSchema.parse({});
  }
}

/**
 * Invalidate cached config (e.g. after writing a new config file).
 */
export function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
  cachedMtime = 0;
}

/**
 * Check if a .rorca/ directory exists for a workspace.
 */
export function hasRorcaDir(workspacePath: string): boolean {
  return fs.existsSync(path.join(workspacePath, '.rorca'));
}

/**
 * Ensure the full .rorca/ directory structure exists.
 * Creates missing subdirectories (skills/, memory/, templates/).
 */
export function ensureRorcaDirStructure(workspacePath: string): void {
  const dirs = [
    path.join(workspacePath, '.rorca'),
    path.join(workspacePath, '.rorca', 'skills'),
    path.join(workspacePath, '.rorca', 'memory'),
    path.join(workspacePath, '.rorca', 'templates'),
    path.join(workspacePath, '.rorca', 'packs'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Write a RorcaConfig to .rorca/config.json. Creates .rorca/ dir if needed.
 * Invalidates cache after write.
 */
export function writeRorcaConfig(workspacePath: string, config: RorcaConfig): void {
  ensureRorcaDirStructure(workspacePath);
  const cfgPath = configPath(workspacePath);
  const content = JSON.stringify(
    { $schema: './config.schema.json', ...config },
    null,
    2,
  );
  fs.writeFileSync(cfgPath, content, 'utf-8');
  invalidateConfigCache();
}

/**
 * Generate a default RorcaConfig (all defaults filled by zod).
 */
export function defaultRorcaConfig(): RorcaConfig {
  return RorcaConfigSchema.parse({});
}
