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
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalPiBin = process.env.PI_BIN;

  beforeEach(() => {
    // Pin a deterministic non-Darwin host without Pi so agent resolution is
    // platform-independent here; the Darwin describe manages its own host.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete process.env.PI_BIN;
  });

  afterEach(() => {
    if (originalPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = originalPiBin;
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  test('documents shared agent and model precedence', () => {
    const result = resolve();
    expect(result.precedence).toEqual({
      agent: EXECUTION_AGENT_PRECEDENCE,
      model: EXECUTION_MODEL_PRECEDENCE,
    });
    expect(EXECUTION_AGENT_PRECEDENCE).toContain('request.agentOverride > manifest.execution.agentOverride > synthetic envelope/spec-level agentOverride');
    expect(EXECUTION_MODEL_PRECEDENCE).toContain('request.modelOverride > manifest.execution.modelOverride > synthetic envelope/spec-level model');
  });

  test.each<AgentType>(['pi', 'codex', 'omp'])('request agentOverride=%s wins over manifest and spec agent metadata', (agent) => {
    const result = resolve({
      requestAgentOverride: agent,
      ompSandboxQualified: agent === 'omp',
      manifestAgentOverride: 'opencode',
      specAgentOverride: 'claude',
    });

    expect(result.resolvedAgentType).toBe(agent);
    expect(result.agentSource).toBe('request.agentOverride');
  });

  test('rejects explicit OMP dispatch before MIG-001 qualification', () => {
    expect(() => resolve({ requestAgentOverride: 'omp', ompSandboxQualified: false }))
      .toThrow(/omp_sandbox_not_qualified/);
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

  test('qualified MIG-001 sandbox makes OMP the default when no override is present', () => {
    const result = resolve({ ompSandboxQualified: true });

    expect(result.resolvedAgentType).toBe('omp');
    expect(result.agentSource).toBe('qualified-omp-default');
  });

  test('unqualified sandbox falls back to Claude rather than implicitly selecting Pi', () => {
    const result = resolve({
      ompSandboxQualified: false,
      workflowConfig: workflowConfig('claude', null, 'default'),
      activeAgentFallback: 'pi',
    });

    expect(result.resolvedAgentType).toBe('claude');
    expect(result.agentSource).toBe('fallback-posture-default');
  });

  test('spec pi override preserves existing Pi-driven runs after OMP qualification', () => {
    const result = resolve({ ompSandboxQualified: true, specAgentOverride: 'pi' });

    expect(result.resolvedAgentType).toBe('pi');
    expect(result.agentSource).toBe('spec.agentOverride');
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

  describe('MIG-006 fallback-only posture', () => {
    test('never auto-selects Pi from host platform or active fallback', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.PI_BIN = process.execPath;

      const result = resolve({ activeAgentFallback: 'pi', ompSandboxQualified: false });

      expect(result.resolvedAgentType).toBe('claude');
      expect(result.agentSource).toBe('fallback-posture-default');
      expect(result.autoSwitchedToPi).toBe(false);
    });

    test('explicit request Pi fallback remains available on Darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.PI_BIN = process.execPath;

      const result = resolve({ requestAgentOverride: 'pi' });

      expect(result.resolvedAgentType).toBe('pi');
      expect(result.agentSource).toBe('request.agentOverride');
      expect(result.autoSwitchedToPi).toBe(false);
    });
  });
});
