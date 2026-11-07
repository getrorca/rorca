/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { AgentType } from './config';
import type { ResolvedWorkflowConfig, WorkflowRuntime } from './workflow-config-resolver';
import * as piDetector from './pi-detector';
import { logger as defaultLogger } from './logger';
import { isOmpSandboxQualified, qualifiedDefaultExecutor } from './omp-executor-selection';
import { ValidationError } from './errors';

export const EXECUTION_AGENT_PRECEDENCE =
  'request.agentOverride > manifest.execution.agentOverride > synthetic envelope/spec-level agentOverride > provider/model auto-switch > qualified OMP default > fallback-posture default > workflow router runtime > active agent fallback';

export const EXECUTION_MODEL_PRECEDENCE =
  'request.modelOverride > manifest.execution.modelOverride > synthetic envelope/spec-level model > workflow router model > active model fallback';

const VALID_AGENT_TYPES = ['claude', 'opencode', 'codex', 'pi', 'omp'] as const satisfies readonly AgentType[];
const VALID_AGENT_TYPE_SET = new Set<string>(VALID_AGENT_TYPES);

const DEFAULT_PI_MODEL = process.env.RORCA_PI_DEFAULT_MODEL?.trim() || 'openai-codex/gpt-5.4';

// OpenCode runtime provider prefixes. Anthropic is intentionally excluded:
// anthropic/claude-* is an OpenRouter catalog id for Claude, not an OpenCode provider prefix.
export const OPENCODE_PROVIDER_PREFIXES = [
  'openrouter/',
  'openai/',
  'google/',
  'ollama/',
  'github/',
  'bedrock/',
  'vertex/',
] as const;

export type ExecutionOptionSource =
  | 'request.agentOverride'
  | 'manifest.execution.agentOverride'
  | 'spec.agentOverride'
  | 'provider-model-auto-switch'
  | 'platform-auto-switch'
  | 'qualified-omp-default'
  | 'fallback-posture-default'
  | 'workflow.runtime'
  | 'activeAgent'
  | 'request.modelOverride'
  | 'manifest.execution.modelOverride'
  | 'spec.model'
  | 'workflow.model'
  | 'activeModel'
  | 'none';

export interface ResolveExecutionOptionsInput {
  requestAgentOverride?: AgentType | string | null;
  manifestAgentOverride?: AgentType | string | null;
  specAgentOverride?: AgentType | string | null;
  requestModelOverride?: string | null;
  manifestModelOverride?: string | null;
  specModel?: string | null;
  workflowConfig?: Pick<ResolvedWorkflowConfig, 'runtime' | 'model'> | null;
  activeAgentFallback: AgentType;
  activeModelFallback?: string | null;
  resolvePiModel?: boolean;
  /** Test seam; production derives this from MIG-001's deployment qualification marker. */
  ompSandboxQualified?: boolean;
  log?: { info: (...args: unknown[]) => void };
}

export interface ResolvedExecutionOptions {
  resolvedAgentType: AgentType;
  resolvedAgentModel: string | null;
  finalAgentModel: string | null;
  agentSource: ExecutionOptionSource;
  modelSource: ExecutionOptionSource;
  autoSwitchedToOpenCode: boolean;
  autoSwitchedToPi: boolean;
  modelNeedsOpenCode: boolean;
  modelIsNonClaudeProviderModel: boolean;
  precedence: {
    agent: typeof EXECUTION_AGENT_PRECEDENCE;
    model: typeof EXECUTION_MODEL_PRECEDENCE;
  };
}

function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && VALID_AGENT_TYPE_SET.has(value);
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstAgentCandidate(candidates: Array<{ value: unknown; source: ExecutionOptionSource }>): { value: AgentType; source: ExecutionOptionSource } | null {
  for (const candidate of candidates) {
    if (isAgentType(candidate.value)) {
      return { value: candidate.value, source: candidate.source };
    }
  }
  return null;
}

function firstModelCandidate(candidates: Array<{ value: unknown; source: ExecutionOptionSource }>): { value: string; source: ExecutionOptionSource } | null {
  for (const candidate of candidates) {
    const value = normalizedString(candidate.value);
    if (value) {
      return { value, source: candidate.source };
    }
  }
  return null;
}

function normalizePiModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function resolvePreferredPiModel(requestedModel: string | null, models: piDetector.PiModel[]): string | null {
  if (models.length === 0) {
    if (requestedModel?.startsWith('openai-codex/')) return requestedModel;
    return DEFAULT_PI_MODEL;
  }

  const normalized = new Map<string, string>();
  for (const model of models) {
    const id = normalizePiModelId(model.provider, model.model);
    normalized.set(id, id);
    normalized.set(model.model, id);
  }

  if (requestedModel) {
    const exact = normalized.get(requestedModel);
    if (exact) return exact;
  }

  const preferredIds = [
    'openai-codex/gpt-5.4',
    'openai-codex/gpt-5.4-mini',
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.2',
  ];
  for (const id of preferredIds) {
    if (normalized.has(id)) return normalized.get(id)!;
  }

  const firstCodex = models.find((model) => model.provider === 'openai-codex');
  if (firstCodex) return normalizePiModelId(firstCodex.provider, firstCodex.model);

  const first = models[0];
  return normalizePiModelId(first.provider, first.model);
}

function workflowRuntimeToAgent(
  workflowConfig: ResolveExecutionOptionsInput['workflowConfig'],
  activeAgentFallback: AgentType,
): { value: AgentType; source: ExecutionOptionSource } {
  const runtime = workflowConfig?.runtime as WorkflowRuntime | undefined;
  const runtimeSource = (workflowConfig as { runtimeSource?: string } | null | undefined)?.runtimeSource;

  if (isAgentType(runtime) && runtimeSource !== 'default') {
    return { value: runtime, source: 'workflow.runtime' };
  }

  return { value: activeAgentFallback, source: 'activeAgent' };
}

function modelNeedsOpenCodeRuntime(model: string | null): boolean {
  return model != null && OPENCODE_PROVIDER_PREFIXES.some((prefix) => model.startsWith(prefix));
}

function isNonClaudeProviderModel(model: string | null): boolean {
  return model != null
    && model.includes('/')
    && !model.startsWith('claude-')
    && !model.startsWith('anthropic/claude-');
}

function translateModelForAgent(input: {
  agent: AgentType;
  model: string | null;
  modelNeedsOpenCode: boolean;
  modelIsNonClaudeProviderModel: boolean;
}): string | null {
  let finalAgentModel = input.model;

  if (finalAgentModel && input.agent === 'opencode') {
    // Already has a known provider prefix: openrouter/z-ai/glm-5, openai/gpt-4o, etc.
    if (input.modelNeedsOpenCode) {
      return finalAgentModel;
    }

    // Claude SDK model IDs → OpenRouter format for OpenCode.
    if (/^claude-/.test(finalAgentModel) && !finalAgentModel.includes('/')) {
      const openRouterId = finalAgentModel
        .replace(/-(\d+)-(\d+)(?:-\d{8})?$/, '-$1.$2')
        .replace(/-(\d{8})$/, '');
      return `openrouter/anthropic/${openRouterId}`;
    }

    // Bare OpenRouter catalog org/model IDs, e.g. z-ai/glm-5.
    if (input.modelIsNonClaudeProviderModel) {
      return `openrouter/${finalAgentModel}`;
    }
  }

  // Claude CLI only accepts bare claude-* model IDs. Clear provider-prefixed ids so
  // Claude uses its own default instead of receiving an invalid model flag.
  if (input.agent === 'claude' && finalAgentModel) {
    const isClaudeModel = /^claude-/.test(finalAgentModel) && !finalAgentModel.includes('/');
    if (!isClaudeModel) {
      finalAgentModel = null;
    }
  }

  return finalAgentModel;
}

function resolvePiModelIfAvailable(model: string | null, log: ResolveExecutionOptionsInput['log']): string | null {
  const piStatus = piDetector.detectPi();
  if (!piStatus.piInstalled || !piStatus.piBinPath) {
    return model;
  }

  const availablePiModels = piDetector.listPiModels(piStatus.piBinPath);
  const preferredPiModel = resolvePreferredPiModel(model, availablePiModels);
  if (preferredPiModel !== model) {
    (log ?? defaultLogger).info(
      { requestedModel: model, preferredPiModel },
      '[Pipeline] Adjusted Pi model to an available local Pi model',
    );
  }
  return preferredPiModel;
}

/**
 * Resolve runtime agent/model intent for both normal pipeline runs and Hermes task-manifest runs.
 *
 * Precedence is intentionally shared:
 * - Agent: request.agentOverride > manifest.execution.agentOverride > spec/envelope agentOverride
 *   > provider/model auto-switch > workflow router runtime > active agent fallback.
 * - Model: request.modelOverride > manifest.execution.modelOverride > spec/envelope model
 *   > workflow router model > active model fallback.
 */
export function resolveExecutionOptions(input: ResolveExecutionOptionsInput): ResolvedExecutionOptions {
  const explicitAgent = firstAgentCandidate([
    { value: input.requestAgentOverride, source: 'request.agentOverride' },
    { value: input.manifestAgentOverride, source: 'manifest.execution.agentOverride' },
    { value: input.specAgentOverride, source: 'spec.agentOverride' },
  ]);

  const ompQualified = input.ompSandboxQualified ?? isOmpSandboxQualified();
  if (explicitAgent?.value === 'omp' && !ompQualified) {
    throw new ValidationError('omp_sandbox_not_qualified: complete MIG-001 qualification and enable RORCA_OMP_SANDBOX_QUALIFIED before OMP dispatch');
  }

  const modelCandidate = firstModelCandidate([
    { value: input.requestModelOverride, source: 'request.modelOverride' },
    { value: input.manifestModelOverride, source: 'manifest.execution.modelOverride' },
    { value: input.specModel, source: 'spec.model' },
    { value: input.workflowConfig?.model, source: 'workflow.model' },
    { value: input.activeModelFallback, source: 'activeModel' },
  ]);
  const resolvedAgentModel = modelCandidate?.value ?? null;
  const modelSource = modelCandidate?.source ?? 'none';
  const modelNeedsOpenCode = modelNeedsOpenCodeRuntime(resolvedAgentModel);
  const modelIsNonClaudeProviderModel = isNonClaudeProviderModel(resolvedAgentModel);
  const workflowAgent = workflowRuntimeToAgent(input.workflowConfig, input.activeAgentFallback);
  if (workflowAgent.value === 'omp' && !ompQualified) {
    throw new ValidationError('omp_sandbox_not_qualified: configured OMP runtime requires MIG-001 qualification');
  }
  // MIG-006: Pi is a fallback-only executor. It may be selected by an explicit
  // request/manifest/spec declaration above, never by host platform, workflow
  // defaults, or the active-agent fallback. This keeps the residual Pi path
  // available without allowing it to silently regain primary-executor status.
  const fallbackPostureApplied = !explicitAgent && workflowAgent.value === 'pi';
  const postureDefaultAgent: AgentType = fallbackPostureApplied ? 'claude' : workflowAgent.value;
  const qualifiedDefault = !explicitAgent && (
    (input.workflowConfig as { runtimeSource?: string } | null | undefined)?.runtimeSource === 'default'
    || fallbackPostureApplied
  )
    ? qualifiedDefaultExecutor(postureDefaultAgent, ompQualified)
    : postureDefaultAgent;
  const defaultedToOmp = !explicitAgent && qualifiedDefault === 'omp';
  const autoSwitchedToPi = false;

  const autoSwitchedToOpenCode = !explicitAgent
    && !defaultedToOmp
    && (modelNeedsOpenCode || modelIsNonClaudeProviderModel)
    && postureDefaultAgent === 'claude';

  const resolvedAgentType = explicitAgent?.value
    ?? (defaultedToOmp ? 'omp' : autoSwitchedToOpenCode ? 'opencode' : postureDefaultAgent);
  const agentSource = explicitAgent?.source
    ?? (defaultedToOmp
      ? 'qualified-omp-default'
      : autoSwitchedToOpenCode
        ? 'provider-model-auto-switch'
        : fallbackPostureApplied
          ? 'fallback-posture-default'
          : workflowAgent.source);

  let finalAgentModel = translateModelForAgent({
    agent: resolvedAgentType,
    model: resolvedAgentModel,
    modelNeedsOpenCode,
    modelIsNonClaudeProviderModel,
  });

  if (resolvedAgentType === 'pi' && input.resolvePiModel !== false) {
    finalAgentModel = resolvePiModelIfAvailable(finalAgentModel, input.log);
  }

  return {
    resolvedAgentType,
    resolvedAgentModel,
    finalAgentModel,
    agentSource,
    modelSource,
    autoSwitchedToOpenCode,
    autoSwitchedToPi,
    modelNeedsOpenCode,
    modelIsNonClaudeProviderModel,
    precedence: {
      agent: EXECUTION_AGENT_PRECEDENCE,
      model: EXECUTION_MODEL_PRECEDENCE,
    },
  };
}
