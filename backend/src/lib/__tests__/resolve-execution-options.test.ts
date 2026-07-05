/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { AgentType } from '../config';
import type { ResolvedWorkflowConfig, WorkflowConfigSource, WorkflowRuntime } from '../workflow-config-resolver';
import {
  EXECUTION_AGENT_PRECEDENCE,
  EXECUTION_MODEL_PRECEDENCE,
  resolveExecutionOptions,
} from '../resolve-execution-options';

function workflowConfig(
  runtime: WorkflowRuntime = 'claude',
  model: string | null = null,
  runtimeSource: WorkflowConfigSource = 'env',
): ResolvedWorkflowConfig {
  const config: ResolvedWorkflowConfig = {
    workflowId: 'pipeline_execution',
    runtime,
    provider: 'claude-cli',
    model,
    apiKey: null,
    baseUrl: null,
  };
  Object.defineProperty(config, 'runtimeSource', { value: runtimeSource, enumerable: false });
  return config;
}

function resolve(overrides: Partial<Parameters<typeof resolveExecutionOptions>[0]> = {}) {
  return resolveExecutionOptions({
    workflowConfig: workflowConfig('claude', null, 'default'),
    activeAgentFallback: 'claude',
    activeModelFallback: null,
    resolvePiModel: false,
    ...overrides,
  });
}

describe('resolveExecutionOptions', () => {
  test('documents shared agent and model precedence', () => {
    const result = resolve();
    expect(result.precedence).toEqual({
      agent: EXECUTION_AGENT_PRECEDENCE,
      model: EXECUTION_MODEL_PRECEDENCE,
    });
    expect(EXECUTION_AGENT_PRECEDENCE).toContain('request.agentOverride > manifest.execution.agentOverride > synthetic envelope/spec-level agentOverride');
    expect(EXECUTION_MODEL_PRECEDENCE).toContain('request.modelOverride > manifest.execution.modelOverride > synthetic envelope/spec-level model');
  });

  test.each<AgentType>(['pi', 'codex'])('request agentOverride=%s wins over manifest and spec agent metadata', (agent) => {
    const result = resolve({
      requestAgentOverride: agent,
      manifestAgentOverride: 'opencode',
      specAgentOverride: 'claude',
    });

    expect(result.resolvedAgentType).toBe(agent);
    expect(result.agentSource).toBe('request.agentOverride');
  });

  test('manifest execution agent beats synthetic envelope/spec-level agent when request omits agentOverride', () => {
    const result = resolve({
      manifestAgentOverride: 'codex',
      specAgentOverride: 'opencode',
    });

    expect(result.resolvedAgentType).toBe('codex');
    expect(result.agentSource).toBe('manifest.execution.agentOverride');
  });

  test('request modelOverride beats manifest execution and synthetic envelope/spec-level models', () => {
    const result = resolve({
      requestModelOverride: 'openai/gpt-5.4',
      manifestModelOverride: 'openrouter/z-ai/glm-5',
      specModel: 'claude-sonnet-4-5-20250929',
    });

    expect(result.modelSource).toBe('request.modelOverride');
    expect(result.resolvedAgentType).toBe('opencode');
    expect(result.finalAgentModel).toBe('openai/gpt-5.4');
  });

  test('manifest execution model beats synthetic envelope/spec-level model when request omits modelOverride', () => {
    const result = resolve({
      manifestModelOverride: 'openrouter/z-ai/glm-5',
      specModel: 'claude-sonnet-4-5-20250929',
    });

    expect(result.modelSource).toBe('manifest.execution.modelOverride');
    expect(result.resolvedAgentType).toBe('opencode');
    expect(result.finalAgentModel).toBe('openrouter/z-ai/glm-5');
  });

  test('synthetic envelope/spec-level model is used when request and manifest omit modelOverride', () => {
    const result = resolve({
      specModel: 'claude-sonnet-4-5-20250929',
    });

    expect(result.modelSource).toBe('spec.model');
    expect(result.resolvedAgentType).toBe('claude');
    expect(result.finalAgentModel).toBe('claude-sonnet-4-5-20250929');
  });

  test('opencode with an openrouter model passes the model through unchanged', () => {
    const result = resolve({
      requestAgentOverride: 'opencode',
      requestModelOverride: 'openrouter/z-ai/glm-5',
    });

    expect(result.resolvedAgentType).toBe('opencode');
    expect(result.finalAgentModel).toBe('openrouter/z-ai/glm-5');
  });

  test('provider-prefixed openrouter model auto-switches default Claude runtime to opencode', () => {
    const result = resolve({ requestModelOverride: 'openrouter/z-ai/glm-5' });

    expect(result.resolvedAgentType).toBe('opencode');
    expect(result.agentSource).toBe('provider-model-auto-switch');
    expect(result.autoSwitchedToOpenCode).toBe(true);
    expect(result.finalAgentModel).toBe('openrouter/z-ai/glm-5');
  });

  test('bare OpenRouter catalog z-ai model auto-switches and is translated for OpenCode', () => {
    const result = resolve({ requestModelOverride: 'z-ai/glm-5' });

    expect(result.resolvedAgentType).toBe('opencode');
    expect(result.finalAgentModel).toBe('openrouter/z-ai/glm-5');
  });

  test('Claude model IDs are translated when OpenCode is explicitly selected', () => {
    const result = resolve({
      requestAgentOverride: 'opencode',
      requestModelOverride: 'claude-sonnet-4-6',
    });

    expect(result.resolvedAgentType).toBe('opencode');
    expect(result.finalAgentModel).toBe('openrouter/anthropic/claude-sonnet-4.6');
  });

  test('default-agent behavior falls back to active agent when workflow runtime is only the hardcoded default', () => {
    const result = resolve({
      workflowConfig: workflowConfig('claude', null, 'default'),
      activeAgentFallback: 'pi',
    });

    expect(result.resolvedAgentType).toBe('pi');
    expect(result.agentSource).toBe('activeAgent');
  });

  test('workflow router runtime and model are used before active fallbacks when explicitly resolved', () => {
    const result = resolve({
      workflowConfig: workflowConfig('opencode', 'openrouter/z-ai/glm-5', 'env'),
      activeAgentFallback: 'claude',
      activeModelFallback: 'claude-sonnet-4-5-20250929',
    });

    expect(result.resolvedAgentType).toBe('opencode');
    expect(result.agentSource).toBe('workflow.runtime');
    expect(result.modelSource).toBe('workflow.model');
    expect(result.finalAgentModel).toBe('openrouter/z-ai/glm-5');
  });
});
