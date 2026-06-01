/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Workflow Config Resolver (WR-002) ──────────────────────────────────────
// Resolves the effective runtime/provider/model/apiKey for a given workflow.
// Resolution chain: DB workflow_configs → agent_config (pipeline_execution only)
//   → env vars (RORCA_AGENT / RORCA_MODEL / SPEC_PROVIDER) → hardcoded defaults.

import { queryOne } from '../db/index';
import { getVaultKey } from '../routes/vault';
import type { ProviderType } from './llm-client';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export type WorkflowRuntime = 'native' | 'claude' | 'opencode' | 'codex' | 'pi';

export type WorkflowId = 'spec_generation' | 'pipeline_execution' | 'memory_consolidation';

export interface ResolvedWorkflowConfig {
  workflowId: string;
  runtime: WorkflowRuntime;
  provider: ProviderType;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
}

interface WorkflowConfigRow {
  workflow_id: string;
  runtime: string;
  provider: string;
  model: string | null;
}

interface AgentConfigRow {
  agent_type: string;
  agent_model: string | null;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const RUNTIME_DEFAULTS: Record<WorkflowId, WorkflowRuntime> = {
  spec_generation: 'native',
  pipeline_execution: 'claude',
  memory_consolidation: 'native',
};

const DEFAULT_PROVIDER: ProviderType = 'claude-cli';

// Map RORCA_AGENT values to runtimes
const AGENT_TO_RUNTIME: Record<string, WorkflowRuntime> = {
  claude: 'claude',
  opencode: 'opencode',
  codex: 'codex',
  pi: 'pi',
};

// Map provider names to env var keys for API key fallback
const PROVIDER_ENV_KEY: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'openai-compat': 'OPENAI_API_KEY',
};

// ─── Resolver ───────────────────────────────────────────────────────────────

export async function resolveWorkflowConfig(
  workflowId: string,
  userId?: string,
): Promise<ResolvedWorkflowConfig> {
  let runtime: WorkflowRuntime | null = null;
  let provider: ProviderType | null = null;
  let model: string | null = null;

  // ── Layer 1: DB workflow_configs ──────────────────────────────────────────
  try {
    const row = await queryOne<WorkflowConfigRow>(
      'SELECT workflow_id, runtime, provider, model FROM workflow_configs WHERE workflow_id = $1',
      [workflowId],
    );
    if (row) {
      runtime = row.runtime as WorkflowRuntime;
      provider = row.provider as ProviderType;
      model = row.model;
    }
  } catch {
    // Table may not exist yet — fall through
  }

  // ── Layer 2: agent_config fallback (pipeline_execution only) ─────────────
  if (workflowId === 'pipeline_execution' && !runtime) {
    try {
      const agentRow = await queryOne<AgentConfigRow>(
        'SELECT agent_type, agent_model FROM agent_config WHERE id = $1',
        ['default'],
      );
      if (agentRow) {
        runtime = AGENT_TO_RUNTIME[agentRow.agent_type] ?? null;
        model = model ?? agentRow.agent_model;
      }
    } catch {
      // Table may not exist yet — fall through
    }
  }

  // ── Layer 3: env vars ────────────────────────────────────────────────────
  if (!runtime) {
    const envAgent = process.env.RORCA_AGENT?.toLowerCase().trim();
    if (envAgent && AGENT_TO_RUNTIME[envAgent]) {
      runtime = AGENT_TO_RUNTIME[envAgent];
    }
  }
  if (!model) {
    model = process.env.RORCA_MODEL?.trim() || null;
  }
  if (!provider) {
    const specProvider = process.env.SPEC_PROVIDER?.toLowerCase().trim();
    if (specProvider === 'anthropic' || specProvider === 'openrouter' || specProvider === 'openai-compat') {
      provider = specProvider;
    } else if (specProvider === 'claude') {
      provider = 'claude-cli';
    }
  }

  // ── Layer 4: hardcoded defaults ──────────────────────────────────────────
  const wfId = workflowId as WorkflowId;
  runtime = runtime ?? RUNTIME_DEFAULTS[wfId] ?? 'native';
  provider = provider ?? DEFAULT_PROVIDER;

  // ── API key resolution ───────────────────────────────────────────────────
  const { apiKey, baseUrl } = await resolveApiKey(userId ?? null, provider, runtime);

  return { workflowId, runtime, provider, model, apiKey, baseUrl };
}

// ─── API Key Helper ─────────────────────────────────────────────────────────

async function resolveApiKey(
  userId: string | null,
  provider: ProviderType,
  runtime: WorkflowRuntime,
): Promise<{ apiKey: string | null; baseUrl: string | null }> {
  // claude-cli runtime uses subscription auth — no API key needed
  if ((runtime === 'claude' || runtime === 'pi') && provider === 'claude-cli') {
    return { apiKey: null, baseUrl: null };
  }

  // Try vault key first
  if (userId) {
    try {
      const vaultResult = await getVaultKey(userId, provider);
      if (vaultResult) {
        return { apiKey: vaultResult.key, baseUrl: vaultResult.baseUrl };
      }
    } catch (err) {
      logger.warn('Vault key lookup failed for provider=%s: %s', provider, (err as Error).message);
    }
  }

  // Fall back to env var
  const envKey = PROVIDER_ENV_KEY[provider];
  if (envKey) {
    const val = process.env[envKey]?.trim();
    if (val) {
      return { apiKey: val, baseUrl: null };
    }
  }

  return { apiKey: null, baseUrl: null };
}
