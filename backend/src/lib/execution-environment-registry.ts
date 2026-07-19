/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, queryOne, execute } from '../db/index';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from './errors';
import { evaluateSecretProfileReadiness, getAgentCredentialChecks, hasAgentCredentials, type SecretProfileReadiness, type SecretProvider } from './secret-resolver';
import type { AgentType } from './config';
import type { ExecutionEnvironment } from './execution-environment';

export type ExecutionEnvironmentKind = 'remote-rorca' | 'local-runner' | 'ci-runner';
export type NetworkMode = 'local' | 'tailscale' | 'ssh-tunnel' | 'public-https';

export interface ExecutionEnvironmentRow {
  id: string;
  label: string;
  kind: ExecutionEnvironmentKind;
  network_mode: NetworkMode;
  enabled: boolean;
  supported_agents: string[];
  allowed_workspace_ids: string[];
  secret_profile_id: string | null;
  max_concurrency: number;
  runner_token_hash: string | null;
  last_heartbeat_at: Date | string | null;
  metadata: Record<string, unknown> | string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

export interface AgentReadiness {
  agent: string;
  installed: boolean;
  credentialsReady: boolean;
  ready: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  version?: string;
}

export interface EnvironmentReadiness {
  id: string;
  label: string;
  kind: ExecutionEnvironmentKind;
  enabled: boolean;
  ready: boolean;
  reason?: string;
  networkMode: NetworkMode;
  lastHeartbeatAt: string | null;
  agents: Record<string, AgentReadiness>;
  supportedAgents: string[];
  secretProfileId: string | null;
  secretProfile?: SecretProfileReadiness | null;
}

const RUNNER_HEARTBEAT_STALE_MS = Number(process.env.RORCA_RUNNER_HEARTBEAT_STALE_MS ?? 120_000);

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function hashRunnerToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function commandVersion(command: string): { installed: boolean } {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, process.platform === 'win32' ? `${command}.cmd` : command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { installed: true };
    } catch { /* continue */ }
  }
  return { installed: false };
}

export async function listExecutionEnvironments(): Promise<ExecutionEnvironmentRow[]> {
  return query<ExecutionEnvironmentRow>(`SELECT * FROM execution_environments ORDER BY id ASC`);
}

export async function getExecutionEnvironmentById(id: string): Promise<ExecutionEnvironmentRow> {
  const env = await queryOne<ExecutionEnvironmentRow>(`SELECT * FROM execution_environments WHERE id = $1`, [id]);
  if (!env) throw new NotFoundError('Execution environment', id);
  return env;
}

async function getSecretProfileReadiness(profileId: string | null): Promise<SecretProfileReadiness | null> {
  if (!profileId) return null;
  const row = await queryOne<{ id: string; label: string; provider: SecretProvider; config: Record<string, unknown> | string }>(
    `SELECT id, label, provider, config FROM execution_secret_profiles WHERE id = $1`,
    [profileId],
  );
  if (!row) return null;
  return evaluateSecretProfileReadiness({
    id: row.id,
    label: row.label,
    provider: row.provider,
    config: parseJsonObject(row.config),
  });
}

export async function upsertExecutionEnvironment(input: {
  id: string;
  label: string;
  kind: ExecutionEnvironmentKind;
  networkMode?: NetworkMode;
  enabled?: boolean;
  supportedAgents?: string[];
  allowedWorkspaceIds?: string[];
  secretProfileId?: string | null;
  maxConcurrency?: number;
  metadata?: Record<string, unknown>;
}): Promise<ExecutionEnvironmentRow> {
  if (!/^[a-zA-Z0-9._:-]+$/.test(input.id)) {
    throw new ValidationError('Invalid execution environment id');
  }

  const row = await queryOne<ExecutionEnvironmentRow>(
    `INSERT INTO execution_environments
       (id, label, kind, network_mode, enabled, supported_agents, allowed_workspace_ids, secret_profile_id, max_concurrency, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label,
       kind = EXCLUDED.kind,
       network_mode = EXCLUDED.network_mode,
       enabled = EXCLUDED.enabled,
       supported_agents = EXCLUDED.supported_agents,
       allowed_workspace_ids = EXCLUDED.allowed_workspace_ids,
       secret_profile_id = EXCLUDED.secret_profile_id,
       max_concurrency = EXCLUDED.max_concurrency,
       metadata = execution_environments.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      input.id,
      input.label,
      input.kind,
      input.networkMode ?? 'local',
      input.enabled ?? true,
      input.supportedAgents ?? ['claude', 'codex', 'opencode', 'pi'],
      input.allowedWorkspaceIds ?? [],
      input.secretProfileId ?? null,
      input.maxConcurrency ?? 1,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return row!;
}

export async function setRunnerToken(environmentId: string, token: string): Promise<void> {
  await execute(`UPDATE execution_environments SET runner_token_hash = $1, updated_at = NOW() WHERE id = $2`, [hashRunnerToken(token), environmentId]);
}

export async function authenticateRunner(environmentId: string, token: string): Promise<ExecutionEnvironmentRow> {
  const env = await getExecutionEnvironmentById(environmentId);
  if (!env.enabled) throw new ServiceUnavailableError('execution_environment_disabled');
  if (!env.runner_token_hash) throw new ServiceUnavailableError('execution_runner_token_not_configured');
  const provided = hashRunnerToken(token);
  const expected = env.runner_token_hash;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    throw new ValidationError('Invalid runner token');
  }
  return env;
}

export async function recordRunnerHeartbeat(environmentId: string, metadata: Record<string, unknown>): Promise<void> {
  await execute(
    `UPDATE execution_environments
        SET last_heartbeat_at = NOW(), metadata = metadata || $2::jsonb, updated_at = NOW()
      WHERE id = $1`,
    [environmentId, JSON.stringify({ runner: metadata })],
  );
}

function remoteAgentReadiness(agent: string): AgentReadiness {
  const binary = commandVersion(agent);
  const credentialChecks = getAgentCredentialChecks(agent);
  const credentialsReady = hasAgentCredentials(agent);
  return {
    agent,
    installed: binary.installed,
    credentialsReady,
    ready: binary.installed && credentialsReady,
    checks: [
      { name: `${agent}.binary`, ok: binary.installed, detail: `${agent} on PATH` },
      ...credentialChecks,
    ],
  };
}

function localRunnerAgentReadiness(env: ExecutionEnvironmentRow, agent: string): AgentReadiness {
  const metadata = parseJsonObject(env.metadata);
  const runner = parseJsonObject(metadata.runner);
  const agents = parseJsonObject(runner.agents);
  const agentMeta = parseJsonObject(agents[agent]);
  const installed = agentMeta.installed === true;
  const credentialsReady = agentMeta.credentialsReady === true;
  return {
    agent,
    installed,
    credentialsReady,
    ready: installed && credentialsReady,
    checks: [
      { name: `${agent}.runnerInstalled`, ok: installed, detail: 'reported by runner heartbeat' },
      { name: `${agent}.runnerCredentials`, ok: credentialsReady, detail: 'reported by runner heartbeat' },
    ],
    ...(typeof agentMeta.version === 'string' ? { version: agentMeta.version } : {}),
  };
}

function heartbeatFresh(lastHeartbeatAt: Date | string | null): boolean {
  if (!lastHeartbeatAt) return false;
  const ts = new Date(lastHeartbeatAt).getTime();
  return Number.isFinite(ts) && Date.now() - ts <= RUNNER_HEARTBEAT_STALE_MS;
}

export async function getExecutionEnvironmentReadiness(id: string): Promise<EnvironmentReadiness> {
  const env = await getExecutionEnvironmentById(id);
  const supportedAgents = env.supported_agents ?? [];
  const agents: Record<string, AgentReadiness> = {};

  for (const agent of supportedAgents) {
    agents[agent] = env.kind === 'remote-rorca'
      ? remoteAgentReadiness(agent)
      : localRunnerAgentReadiness(env, agent);
  }

  let ready = env.enabled;
  let reason: string | undefined;
  if (!env.enabled) {
    ready = false;
    reason = 'execution_environment_disabled';
  } else if (env.kind !== 'remote-rorca' && !heartbeatFresh(env.last_heartbeat_at)) {
    ready = false;
    reason = 'execution_runner_not_connected';
  }

  const secretProfile = await getSecretProfileReadiness(env.secret_profile_id);

  return {
    id: env.id,
    label: env.label,
    kind: env.kind,
    enabled: env.enabled,
    ready,
    ...(reason ? { reason } : {}),
    networkMode: env.network_mode,
    lastHeartbeatAt: env.last_heartbeat_at ? new Date(env.last_heartbeat_at).toISOString() : null,
    agents,
    supportedAgents,
    secretProfileId: env.secret_profile_id,
    secretProfile,
  };
}

export async function assertExecutionEnvironmentReadyForRun(input: {
  environmentId: ExecutionEnvironment;
  workspaceId: string;
  agent: AgentType;
}): Promise<EnvironmentReadiness> {
  const env = await getExecutionEnvironmentById(input.environmentId);
  if (env.allowed_workspace_ids.length > 0 && !env.allowed_workspace_ids.includes(input.workspaceId)) {
    throw new ConflictError('execution_environment_workspace_not_allowed');
  }
  if (!env.supported_agents.includes(input.agent)) {
    throw new ConflictError(`execution_environment_agent_not_supported:${input.agent}`);
  }
  const readiness = await getExecutionEnvironmentReadiness(input.environmentId);
  if (!readiness.ready) {
    throw new ServiceUnavailableError(readiness.reason ?? 'execution_environment_not_ready');
  }
  const agentReadiness = readiness.agents[input.agent];
  if (!agentReadiness?.ready) {
    const reason = !agentReadiness?.installed
      ? `execution_agent_binary_missing:${input.agent}`
      : `execution_agent_credentials_missing:${input.agent}`;
    throw new ServiceUnavailableError(reason);
  }
  return readiness;
}
