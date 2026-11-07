/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentType } from '../config';
import { preserveDeclaredExecutorAcrossRetry } from '../omp-executor-selection';
import { resolveExecutionOptions } from '../resolve-execution-options';
import type { ResolvedWorkflowConfig } from '../workflow-config-resolver';

function defaultWorkflow(runtime: AgentType = 'pi', runtimeSource = 'default'): ResolvedWorkflowConfig {
  const config = {
    workflowId: 'pipeline_execution',
    runtime,
    provider: 'test',
    model: null,
    apiKey: null,
    baseUrl: null,
  } as ResolvedWorkflowConfig;
  Object.defineProperty(config, 'runtimeSource', { value: runtimeSource, enumerable: false });
  return config;
}

function dispatch(input: Partial<Parameters<typeof resolveExecutionOptions>[0]> = {}) {
  return resolveExecutionOptions({
    workflowConfig: defaultWorkflow(),
    activeAgentFallback: 'pi',
    activeModelFallback: null,
    resolvePiModel: false,
    ompSandboxQualified: true,
    ...input,
  });
}

test('eligible new runs default to OMP and never inherit Pi implicitly', () => {
  const result = dispatch();
  assert.equal(result.resolvedAgentType, 'omp');
  assert.equal(result.agentSource, 'qualified-omp-default');
  assert.equal(result.autoSwitchedToPi, false);

  const configuredPi = dispatch({ workflowConfig: defaultWorkflow('pi', 'env') });
  assert.equal(configuredPi.resolvedAgentType, 'omp');
  assert.equal(configuredPi.agentSource, 'qualified-omp-default');

  const unqualified = dispatch({ ompSandboxQualified: false });
  assert.equal(unqualified.resolvedAgentType, 'claude');
  assert.equal(unqualified.agentSource, 'fallback-posture-default');
});

test('Pi remains available only through an explicit per-run, manifest, or spec declaration', () => {
  for (const [override, source] of [
    [{ requestAgentOverride: 'pi' }, 'request.agentOverride'],
    [{ manifestAgentOverride: 'pi' }, 'manifest.execution.agentOverride'],
    [{ specAgentOverride: 'pi' }, 'spec.agentOverride'],
  ] as const) {
    const result = dispatch(override);
    assert.equal(result.resolvedAgentType, 'pi');
    assert.equal(result.agentSource, source);
  }
});

test('an explicit Pi fallback preserves its declared executor across retry', () => {
  const initial = dispatch({ requestAgentOverride: 'pi' });
  const retryExecutor = preserveDeclaredExecutorAcrossRetry(initial.resolvedAgentType);

  assert.equal(initial.agentSource, 'request.agentOverride');
  assert.equal(retryExecutor, 'pi');
  assert.notEqual(retryExecutor, dispatch().resolvedAgentType);
});

test('Claude compatibility remains a deliberate per-story override', () => {
  const result = dispatch({ specAgentOverride: 'claude' });
  assert.equal(result.resolvedAgentType, 'claude');
  assert.equal(result.agentSource, 'spec.agentOverride');
});
