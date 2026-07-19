#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Minimal outbound Rorca local runner.
 *
 * Usage:
 *   RORCA_API_URL=http://localhost:3030/api \
 *   RORCA_RUNNER_TOKEN=... \
 *   RORCA_RUNNER_ENVIRONMENT_ID=local-user \
 *   RORCA_RUNNER_WORKSPACE_PATH=/path/to/workspace \
 *   npx tsx src/runner/local-runner.ts
 *
 * The execution engine currently posts callbacks to http://localhost:<port>.
 * For remote Rorca over Tailscale, expose the Rorca API locally via SSH tunnel
 * or equivalent, then set RORCA_ENGINE_API_PORT to that local port.
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasAgentCredentials } from '../lib/secret-resolver';
import { assertWavePolicyEnvelopeIntegrity, type WavePolicyEnvelope } from '../lib/wave-production-policy';

const apiUrl = (process.env.RORCA_API_URL ?? 'http://localhost:3030/api').replace(/\/$/, '');
const environmentId = process.env.RORCA_RUNNER_ENVIRONMENT_ID ?? 'local-user';
const token = process.env.RORCA_RUNNER_TOKEN ?? '';
const runnerId = process.env.RORCA_RUNNER_ID ?? `${os.hostname()}-${process.pid}`;
const pollIntervalMs = Number(process.env.RORCA_RUNNER_POLL_INTERVAL_MS ?? 3000);
const apiUrlObj = new URL(apiUrl);
const apiPort = apiUrlObj.port || (apiUrlObj.protocol === 'https:' ? '443' : '80');
const engineApiPort = Number(process.env.RORCA_ENGINE_API_PORT ?? apiPort);
const engineApiBaseUrl = (process.env.RORCA_ENGINE_API_BASE_URL ?? `${apiUrlObj.protocol}//${apiUrlObj.host}`).replace(/\/+$/, '');
const workspacePathOverride = process.env.RORCA_RUNNER_WORKSPACE_PATH;
let shuttingDown = false;

if (!token) {
  console.error('RORCA_RUNNER_TOKEN is required');
  process.exit(1);
}

process.on('SIGINT', () => { shuttingDown = true; });
process.on('SIGTERM', () => { shuttingDown = true; });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api<T>(pathSuffix: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiUrl}${pathSuffix}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(parsed.error || `HTTP ${response.status}`);
  }
  return parsed as T;
}

function commandStatus(command: string): { installed: boolean; version?: string } {
  try {
    const version = execSync(`${command} --version`, { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
    return { installed: true, ...(version ? { version } : {}) };
  } catch {
    try {
      execSync(`command -v ${command}`, { encoding: 'utf8', timeout: 5000, shell: '/bin/sh' });
      return { installed: true };
    } catch {
      return { installed: false };
    }
  }
}

function localAgentReport() {
  const agents: Record<string, { installed: boolean; credentialsReady: boolean; version?: string }> = {};
  for (const agent of ['claude', 'codex', 'opencode', 'pi']) {
    const status = commandStatus(agent);
    agents[agent] = {
      installed: status.installed,
      credentialsReady: hasAgentCredentials(agent),
      ...(status.version ? { version: status.version } : {}),
    };
  }
  return agents;
}


async function preflightEngineApi(): Promise<void> {
  const healthUrl = `${engineApiBaseUrl.replace(/\/api$/, '')}/api/health`;
  const response = await fetch(healthUrl);
  if (!response.ok) {
    throw new Error(`Rorca engine callback API unhealthy at ${healthUrl}: HTTP ${response.status}`);
  }
}

async function heartbeat(): Promise<void> {
  await api(`/execution-environments/${environmentId}/runner/heartbeat`, {
    runnerId,
    workspacePath: workspacePathOverride,
    agents: localAgentReport(),
    metadata: { pid: process.pid, hostname: os.hostname() },
  });
}

function resolveEnginePath(): string {
  const candidates = [
    path.join(__dirname, '..', 'lib', 'execution-engine.ts'),
    path.join(__dirname, '..', 'lib', 'execution-engine.js'),
    path.join(process.cwd(), 'src', 'lib', 'execution-engine.ts'),
    path.join(process.cwd(), 'dist', 'lib', 'execution-engine.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`execution-engine not found. Tried: ${candidates.join(', ')}`);
  return found;
}

async function runJob(job: any): Promise<void> {
  const payload = job.payload ?? {};

  const workspacePath = workspacePathOverride || payload.worktreePath || payload.workspacePath;
  if (!workspacePath || typeof workspacePath !== 'string') {
    throw new Error('Runner workspace path missing. Set RORCA_RUNNER_WORKSPACE_PATH or include workspacePath in job payload.');
  }
  const specPath = String(payload.specPath);
  const jsonPath = path.join(workspacePath, specPath);
  const enginePath = resolveEnginePath();
  const command = enginePath.endsWith('.ts') ? 'npx' : 'node';
  const args = enginePath.endsWith('.ts') ? ['tsx', enginePath] : [enginePath];

  args.push('--json', jsonPath);
  args.push('--cwd', workspacePath);
  args.push('--run-id', String(payload.runId));
  if (payload.wavePolicy?.workspaceId) args.push('--workspace-id', String(payload.wavePolicy.workspaceId));
  args.push('--port', String(engineApiPort));
  args.push('--parallelism', String(payload.parallelism ?? 1));
  args.push('--agent', String(payload.agent ?? 'claude'));
  if (payload.model) args.push('--model', String(payload.model));
  if (payload.specificStory) args.push('--story', String(payload.specificStory));
  if (payload.startFromStoryId) args.push('--start-from', String(payload.startFromStoryId));
  if (payload.includeGraph) args.push('--include-graph');
  if (payload.terminalMode) args.push('--terminal-mode', String(payload.terminalMode));
  if (payload.branchName) args.push('--branch-name', String(payload.branchName));
  if (payload.thinkingEnabled) args.push('--thinking-enabled', String(payload.thinkingEnabled));
  if (payload.thinkingBudget) args.push('--thinking-budget', String(payload.thinkingBudget));
  if (payload.effortLevel) args.push('--effort-level', String(payload.effortLevel));
  if (payload.reasoningEffort) args.push('--reasoning-effort', String(payload.reasoningEffort));

  const embeddedPolicy = payload.wavePolicy as WavePolicyEnvelope | undefined;
  if (Number(payload.parallelism ?? 1) > 1 && !embeddedPolicy) {
    throw new Error('wave_parallel_denied:local_runner_missing_policy');
  }
  if (embeddedPolicy) assertWavePolicyEnvelopeIntegrity(embeddedPolicy);
  const currentPolicy = await api<{
    allowed: boolean;
    effective: { orchestrationMode: 'sequential' | 'wave-parallel'; parallelism: number };
    fence: string;
  }>(`/execution-environments/${environmentId}/runner/jobs/${job.id}/revalidate`, { runnerId });
  if ((embeddedPolicy && currentPolicy.fence !== embeddedPolicy.fence)
    || currentPolicy.effective.parallelism !== Number(payload.parallelism ?? 1)
    || currentPolicy.effective.orchestrationMode !== (Number(payload.parallelism ?? 1) > 1 ? 'wave-parallel' : 'sequential')) {
    throw new Error('wave_parallel_denied:local_runner_policy_drift');
  }
  await api(`/execution-environments/${environmentId}/runner/jobs/${job.id}/running`, { runnerId });

  const {
    RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON: _qualificationTrust,
    RORCA_WAVE_PRODUCTION_ACTIVATION_KEY: _activationKey,
    ...inheritedEnv
  } = process.env;
  const child = spawn(command, args, {
    cwd: workspacePath,
    stdio: 'inherit',
    env: {
      ...inheritedEnv,
      RORCA_ENGINE_API_BASE_URL: engineApiBaseUrl,
      ...(payload.envOverrides ?? {}),
      ...(embeddedPolicy ? { RORCA_GOVERNED_WAVE_POLICY: JSON.stringify(embeddedPolicy) } : {}),
    },
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });

  await api(`/execution-environments/${environmentId}/runner/jobs/${job.id}/complete`, {
    runnerId,
    status: exitCode === 0 ? 'succeeded' : 'failed',
    result: { exitCode },
    ...(exitCode === 0 ? {} : { error: `execution_engine_exit_${exitCode}` }),
  });
}

async function main(): Promise<void> {
  await preflightEngineApi();
  console.log(`[rorca-runner] starting runnerId=${runnerId} environment=${environmentId} api=${apiUrl} engineApiBase=${engineApiBaseUrl}`);
  while (!shuttingDown) {
    try {
      await heartbeat();
      const result = await api<{ job: any | null }>(`/execution-environments/${environmentId}/runner/poll`, { runnerId });
      if (result.job) {
        console.log(`[rorca-runner] claimed job=${result.job.id} run=${result.job.runId}`);
        await runJob(result.job);
      } else {
        await sleep(pollIntervalMs);
      }
    } catch (err) {
      console.error('[rorca-runner] loop error:', err instanceof Error ? err.message : err);
      await sleep(Math.max(pollIntervalMs, 5000));
    }
  }
  console.log('[rorca-runner] stopped');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
