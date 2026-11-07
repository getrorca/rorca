/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Worktree provenance for this regression contract:
 * - hermes-closed-loop/PR#7 informed the HRC fields represented in these fixtures:
 *   route decision, shared context refs, selected skills/principles, validation gate,
 *   evidence ids, branch/PR-only policy, and source Rorca spec/run/story refs.
 * - rorca-exec-env-toggle informed optional executionEnvironment/executionEnvironmentId fields;
 *   Rorca main must gracefully no-op when that support is absent.
 *
 * The tests below intentionally mock the DB, pg-boss, auth/provider checks, hooks, and git worktree
 * creation. They do not require a live Rorca API, Hermes checkout, GitHub/Linear/Slack credentials,
 * PostgreSQL, pg-boss, or provider CLIs.
 */

import express from 'express';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { safeParseTaskManifest, TASK_MANIFEST_LIMITS } from '../../lib/task-manifest';
import { createStoryExecutionManifest } from '../../lib/story-execution-packet';
import { createStoryAttemptResult, evaluateStoryCloseout } from '../../lib/story-closeout';
import { storyLifecycleFixture } from '../../lib/__tests__/fixtures/story-execution-manifest.fixture';
import {
  HERMES_FIXTURE_PROVENANCE,
  hermesHrcTaskManifestWithExecutionEnvironment,
  hermesHrcTaskManifestWithoutExecutionEnvironment,
  legacyHermesRepairTriggerMetadata,
} from '../__fixtures__/hermes-manifests';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockExecute = jest.fn();
const mockTransaction = jest.fn();
const mockBoss = {
  createQueue: jest.fn(),
  send: jest.fn(),
  work: jest.fn(),
  stop: jest.fn(),
};
const mockSimpleGitRaw = jest.fn();
const mockSimpleGitBranchLocal = jest.fn();
const mockAssertExecutionEnvironmentReadyForRun = jest.fn();

jest.mock('../../db/index', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  closePool: jest.fn().mockResolvedValue(undefined),
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../../db/user-client', () => ({
  withUserClient: jest.fn(async (_user: unknown, callback: (client: unknown) => unknown) => callback({ query: jest.fn() })),
}));

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  getModelInfo: jest.fn().mockReturnValue(undefined),
}));

jest.mock('../../lib/claude-auth', () => ({
  getClaudeAuthState: jest.fn().mockReturnValue({ connected: true, cliInstalled: true }),
}));

jest.mock('../../lib/codex-auth', () => ({
  getCodexAuthState: jest.fn().mockReturnValue({ connected: true, cliInstalled: true }),
}));

jest.mock('../../lib/opencode-detector', () => ({
  detectOpenCode: jest.fn().mockReturnValue({ opencodeInstalled: true }),
}));

jest.mock('../../lib/pi-detector', () => ({
  detectPi: jest.fn().mockReturnValue({ piInstalled: true, piVersion: '0.67.2', piBinPath: process.execPath }),
  inspectPi: jest.fn().mockReturnValue({ status: { piInstalled: true, piVersion: '0.67.2', piBinPath: process.execPath } }),
  listPiModels: jest.fn().mockReturnValue([
    { provider: 'openai-codex', model: 'gpt-5.4', contextTokens: 272000, maxOutTokens: 128000, thinking: true, images: true },
  ]),
}));

jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn(() => mockBoss),
  getPgBossSchemaSql: jest.fn(() => '"pgboss"'),
}));

// The orchestrator's fail-closed behavior is covered independently. Hermes
// bridge cases start after an exact-revision lifecycle preflight has succeeded.
jest.mock('../../lib/ssdlc-lifecycle-orchestrator', () => ({
  ...jest.requireActual('../../lib/ssdlc-lifecycle-orchestrator'),
  assertLifecycleDispatchReady: jest.fn().mockImplementation(async (input: {
    workspaceId: string;
    specId: string;
    canonicalSpec: unknown;
  }) => {
    if (!input.canonicalSpec || typeof input.canonicalSpec !== 'object') {
      throw new Error('Lifecycle fixture requires exact canonical spec bytes');
    }
    const canonicalSpec = input.canonicalSpec as { userStories?: Array<{ id?: string }> };
    const storyIds = canonicalSpec.userStories?.map((story) => story.id).filter((id): id is string => typeof id === 'string') ?? [];
    const storyId = storyIds[0];
    if (!storyId) throw new Error('Lifecycle fixture requires a canonical story identity');
    return {
      workspaceId: input.workspaceId,
      specId: input.specId,
      specHash: `sha256:${'b'.repeat(64)}`,
      compiledPlanId: '102',
      plan: storyLifecycleFixture(input.workspaceId, input.specId, storyId, storyIds).plan,
      phases: [],
      policy: { advanced: [], awaitingHuman: [] },
    };
  }),
}));

jest.mock('../../lib/execution-authority-rollout', () => ({
  ...jest.requireActual('../../lib/execution-authority-rollout'),
  prepareWorkspaceExecutionAuthorityPreflight: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../lib/lifecycle-dispatch-claim', () => ({
  claimLifecycleDispatch: jest.fn().mockImplementation(async (input: Record<string, string>) => ({
    schemaVersion: 'lifecycle-dispatch-claim.v1',
    claimId: '22222222-2222-4222-8222-222222222222',
    ...input,
  })),
  parseLifecycleDispatchClaim: jest.fn().mockImplementation((value: unknown) => value),
  assertLifecycleDispatchClaim: jest.fn().mockResolvedValue(undefined),
  withLifecycleDispatchClaimLock: jest.fn().mockImplementation(
    async (_claim: unknown, action: () => unknown) => action(),
  ),
}));

jest.mock('../../lib/pty-manager', () => ({
  PTY_AVAILABLE: true,
  PTY_UNAVAILABLE_HINT: 'node-pty mocked',
}));

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../lib/config', () => ({
  activeAgent: 'claude',
  activeModel: null,
  setActiveAgentConfig: jest.fn(),
}));

jest.mock('../../lib/workflow-config-resolver', () => ({
  resolveWorkflowConfig: jest.fn().mockResolvedValue({
    runtime: 'claude',
    runtimeSource: 'default',
    model: null,
    provider: 'anthropic',
    apiKey: null,
    baseUrl: null,
  }),
}));

jest.mock('../../lib/get-user', () => ({
  getEffectiveUser: jest.fn().mockResolvedValue({ id: 'test-user' }),
}));

jest.mock('../budget', () => ({
  checkBudgetThresholds: jest.fn().mockResolvedValue({ capExceeded: false }),
}));

jest.mock('../env-vars', () => ({
  getWorkspaceEnvVars: jest.fn().mockReturnValue({}),
}));

jest.mock('../vault', () => ({
  getVaultKey: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../lib/cost-estimator', () => ({
  estimateDryRunCost: jest.fn().mockResolvedValue({ totalCostUsd: 0, inputTokens: 0, outputTokens: 0 }),
}));

jest.mock('../../lib/hook-runner', () => ({
  runHooks: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../lib/sse-hub', () => ({
  broadcastAll: jest.fn(),
  attachSSE: jest.fn(),
}));

jest.mock('../../lib/spec-readiness', () => ({
  getSpecReadiness: jest.fn().mockResolvedValue({ executionGate: { status: 'ready' } }),
  assertSpecReadinessAllowsMutation: jest.fn(),
  recordSpecReadinessOverride: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/execution-engine', () => ({
  scanRequiredEngines: jest.fn().mockReturnValue(new Set()),
  countStoriesByEngine: jest.fn().mockReturnValue(new Map()),
  resolveStoryAgent: jest.fn((_story: unknown, defaultAgent: string) => defaultAgent),
  storyAllowsNoCodeChanges: jest.fn().mockReturnValue(false),
  reroutedStories: jest.fn().mockReturnValue([]),
}));

jest.mock('../../lib/tool-capability-checker', () => ({
  checkSpec: jest.fn().mockReturnValue({ compatible: true, stories: [] }),
}));

jest.mock('../../lib/complexity-scorer', () => ({
  loadOrchestrationConfig: jest.fn().mockReturnValue({ capabilityMismatch: 'warn' }),
}));

jest.mock('../../lib/workspace-context-routing', () => ({
  buildQuickRunContextBlocks: jest.fn().mockReturnValue([]),
  readContractMemory: jest.fn().mockReturnValue(''),
  routeWorkspaceContext: jest.fn().mockReturnValue({ richnessScore: 0, contract: { satisfied: true } }),
  validateRoutingContract: jest.fn().mockReturnValue({ satisfied: true }),
}));

jest.mock('../../lib/drift-detector', () => ({
  detectDrift: jest.fn(),
  isDriftCheckEnabled: jest.fn().mockReturnValue(false),
  hasBlockingViolations: jest.fn().mockReturnValue(false),
}));

jest.mock('../../lib/worktree-runtime', () => ({
  ensureWorktreeRuntimeSupport: jest.fn().mockReturnValue({ linkedDirs: [], copiedEnvFiles: [] }),
}));

jest.mock('../../lib/story-closeout', () => ({
  ...jest.requireActual('../../lib/story-closeout'),
  persistStoryExecutionManifest: jest.fn().mockResolvedValue('inserted'),
}));

jest.mock('../../lib/worktree-freshness', () => ({
  validateReusableBranch: jest.fn().mockReturnValue({ ok: true }),
  validateReusableWorktree: jest.fn().mockReturnValue({ ok: true }),
}));

jest.mock('../../lib/execution-environment-registry', () => ({
  assertExecutionEnvironmentReadyForRun: (...args: unknown[]) => mockAssertExecutionEnvironmentReadyForRun(...args),
}));

jest.mock('../../lib/run-queue', () => ({
  advanceQueue: jest.fn(),
}));

jest.mock('../../lib/worker-heartbeat', () => ({
  getLatestWorkerHeartbeat: jest.fn().mockResolvedValue(null),
  isWorkerHeartbeatStale: jest.fn().mockReturnValue(true),
}));

jest.mock('../../lib/run-pty-store', () => ({
  getRunPtySessionHealth: jest.fn().mockResolvedValue(null),
  getRunPtySessionStatus: jest.fn().mockResolvedValue(null),
  getRunPtyOutputLimits: jest.fn().mockReturnValue({ replayBatchChunks: 256 }),
  listRecentRunPtyChunks: jest.fn().mockResolvedValue([]),
  listRunPtyChunks: jest.fn().mockResolvedValue([]),
  requestRunPtyInput: jest.fn().mockResolvedValue(undefined),
  requestRunPtyResize: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/opencode-server', () => ({
  OpenCodeServer: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

jest.mock('../../lib/auth-utils', () => ({
  authRequired: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWorkspaceAdmin: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../worker', () => ({
  sweepOrphanProcesses: jest.fn().mockResolvedValue({ swept: 0 }),
}));

jest.mock('simple-git', () => jest.fn(() => ({
  branchLocal: mockSimpleGitBranchLocal,
  raw: mockSimpleGitRaw,
})));

const pipelineRouter = require('../pipeline').default;

type JsonRecord = Record<string, unknown>;

let tmpDir = '';
let wsDir = '';
let nextRunId = 9000;
let taskManifestReservations: JsonRecord[] = [];
let taskManifestLineages: JsonRecord[] = [];
let pipelineRunInserts: JsonRecord[] = [];
let taskManifestPublications: JsonRecord[] = [];
let taskManifestTransactionQueries: Array<{ text: string; params: unknown[] }> = [];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sqlText(sql: unknown): string {
  return String(sql).replace(/\s+/g, ' ');
}

function jsonParam(value: unknown): JsonRecord | null {
  if (typeof value !== 'string') return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
  return JSON.parse(value) as JsonRecord;
}

function makeWalEvent(type = 'test_event'): JsonRecord {
  return {
    id: nextRunId++,
    ts: new Date('2026-03-16T00:08:00.000Z').toISOString(),
    event_type: type,
    workspace_id: 'ws-hermes',
    spec_id: null,
    story_id: null,
    actor: 'test',
    payload: '{}',
  };
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req: any, _res, next) => {
    req.user = { id: 'test-user', email: 'test@example.com' };
    next();
  });
  app.use('/api/pipeline', pipelineRouter);
  return app;
}

function seedNormalSpec(slug = 'hermes-normal-spec'): string {
  const relPath = `forge/specs/approved/${slug}.json`;
  const absPath = path.join(wsDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify({
    id: slug,
    title: 'Hermes normal spec',
    agentOverride: 'claude',
    model: 'claude-sonnet-4-5-20250929',
    userStories: [
      {
        id: 'US-001',
        title: 'Normal story',
        description: 'Exercise normal Rorca full-spec trigger behavior.',
        acceptanceCriteria: ['queued through pg-boss'],
        dependsOn: [],
        passes: false,
      },
    ],
  }, null, 2));
  return relPath;
}

function transactionQuery(sql: unknown, params: unknown[] = []) {
  const text = sqlText(sql);
  taskManifestTransactionQueries.push({ text, params });
  if (text.includes('FROM users actor') && text.includes('JOIN workspace_members member')) {
    return Promise.resolve({ rows: params[0] === 'test-user' && params[1] === 'ws-hermes'
      ? [{ auth_id: '00000000-0000-4000-8000-000000000777' }]
      : [] });
  }
  if (text.includes('set_config(')) {
    return Promise.resolve({ rows: [] });
  }
  if (text.startsWith('SET TRANSACTION')) {
    return Promise.resolve({ rows: [] });
  }
  if (text.includes('FROM pipeline_runs') && text.includes('idempotency_key') && text.includes('FOR UPDATE')) {
    const run = taskManifestReservations.find((row) => row.workspaceId === params[0] && row.idempotencyKey === params[1]);
    return Promise.resolve({ rows: run ? [{
      id: run.id, spec_path: run.specPath, status: 'queued', queue_position: run.queuePosition,
      triggered_via: run.triggeredVia, branch_name: run.branchName ?? null,
      execution_worktree_path: run.executionWorktreePath ?? null,
      idempotency_key: run.idempotencyKey, task_manifest_id: run.manifestId,
      task_manifest_artifacts: run.artifacts, trigger_options: run.triggerOptions,
      effective_options: run.effectiveOptions, task_manifest_authority_version: 1,
    }] : [] });
  }
  if (text.includes('SELECT COUNT(*) as count FROM pipeline_runs')) {
    return Promise.resolve({ rows: [{ count: '0' }] });
  }
  if (text.includes('SELECT workspace_id, status, dispatch_request_hash') && text.includes('FROM pipeline_runs')) {
    const run = [...taskManifestReservations, ...pipelineRunInserts].find((row) => row.id === params[0]);
    return Promise.resolve({ rows: run ? [{ workspace_id: run.workspaceId, status: 'queued', dispatch_request_hash: run.dispatchRequestHash ?? null }] : [] });
  }
  if (text.includes('FROM pipeline_run_cancellation_requests')) {
    return Promise.resolve({ rows: [] });
  }
  if (text.includes('FROM pipeline_dispatch_publications') && text.includes('FOR UPDATE')) {
    return Promise.resolve({ rows: taskManifestPublications.filter((row) => row.run_id === params[0]) });
  }
  if (text.includes('UPDATE pipeline_dispatch_publications') && text.includes("state = 'preparing'")) {
    const publication = taskManifestPublications.find((row) => row.run_id === params[0]);
    if (publication) {
      publication.state = 'preparing';
      publication.lease_owner = params[1];
      publication.lease_expires_at = '2099-01-01T00:00:00.000Z';
      publication.request_hash = publication.request_hash ?? params[2];
    }
    return Promise.resolve({ rows: [] });
  }
  if (text.includes('INSERT INTO task_manifest_run_lineage')) {
    const row = {
      run_id: params[0], workspace_id: params[1], root_run_id: params[2], parent_run_id: params[3],
      lineage_depth: params[4], schema_version: params[5], manifest_id: params[6],
      source_idempotency_key: params[7], manifest_hash: params[8], synthetic_spec_hash: params[9],
      manifest_path: params[10], synthetic_spec_path: params[11], lineage_identity_hash: params[12],
      provider_human_receipt_id: params[13] ?? null,
    };
    taskManifestLineages.push(row);
    return Promise.resolve({ rows: [row] });
  }
  if (text.includes('INSERT INTO pipeline_runs') && text.includes('RETURNING id')) {
    const row = {
      id: nextRunId++,
      specPath: params[0],
      workspaceId: params[1],
      queuePosition: params[2],
      triggeredVia: params[3],
      autoWorktree: params[4],
      mergeStrategy: params[5],
      terminalMode: params[6],
      includeGraph: params[7],
      agentType: params[9],
      agentModel: params[10],
      idempotencyKey: params[11],
      manifestId: params[12],
      artifacts: jsonParam(params[13]),
      triggerOptions: jsonParam(params[14]),
      effectiveOptions: jsonParam(params[15]),
      dispatchRequestHash: params[16],
      taskManifestAuthorityVersion: 1,
    };
    taskManifestReservations.push(row);
    taskManifestPublications.push({
      run_id: row.id,
      workspace_id: row.workspaceId,
      boss_job_id: `00000000-0000-5000-a000-${String(row.id).padStart(12, '0')}`,
      state: 'reserved',
      request_hash: row.dispatchRequestHash,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: '2000-01-01T00:00:00.000Z',
    });
    return Promise.resolve({ rows: [{ id: row.id, queue_position: row.queuePosition }] });
  }
  return Promise.resolve({ rows: [] });
}

beforeEach(() => {
  process.env.PI_BIN = process.execPath;
  jest.clearAllMocks();
  nextRunId = 9000;
  taskManifestReservations = [];
  taskManifestLineages = [];
  pipelineRunInserts = [];
  taskManifestPublications = [];
  taskManifestTransactionQueries = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hermes-bridge-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@rorca.local'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Rorca Test'], { cwd: wsDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: wsDir, stdio: 'ignore' });

  mockBoss.createQueue.mockResolvedValue(undefined);
  mockBoss.send.mockImplementation(async (_name: string, _payload: unknown, options?: { id?: string }) => options?.id ?? 'mock-job-id');
  mockSimpleGitBranchLocal.mockResolvedValue({ all: [] });
  mockSimpleGitRaw.mockImplementation(async (args: string[]) => (
    execFileSync('git', args, { cwd: wsDir, encoding: 'utf8' })
  ));
  mockExecute.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    const text = sqlText(sql);
    if (text.includes("UPDATE pipeline_runs SET status = 'queued'") && text.includes('worktree_path')) {
      const run = taskManifestReservations.find((row) => row.id === params[10]);
      if (run) {
        run.branchName = params[4];
        run.worktreePath = params[5];
        run.executionWorktreePath = params[5];
        run.autoWorktree = params[8];
        run.mergeStrategy = params[11];
        run.terminalMode = params[12];
      }
    }
    return { rowCount: 1 };
  });
  mockAssertExecutionEnvironmentReadyForRun.mockResolvedValue({
    id: 'remote-rorca',
    label: 'Remote Rorca worker',
    kind: 'remote-rorca',
    enabled: true,
    ready: true,
    networkMode: 'local',
    lastHeartbeatAt: null,
    supportedAgents: ['claude', 'codex', 'opencode', 'pi'],
    secretProfileId: null,
    agents: {},
  });
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = sqlText(sql);
    if (text.includes("FROM worker_settings WHERE key = 'run_now_max_concurrent'")) {
      return [];
    }
    return [];
  });
  mockQueryOne.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    const text = sqlText(sql);
    if (text.includes('FROM task_manifest_run_lineage WHERE run_id')) {
      return taskManifestLineages.find((row) => row.run_id === params[0]);
    }
    if (text.includes('SELECT workspace_id, spec_path, status, effective_options') && text.includes('FROM pipeline_runs WHERE id = $1')) {
      const run = taskManifestReservations.find((row) => row.id === params[0]);
      return run ? {
        workspace_id: run.workspaceId,
        spec_path: run.specPath,
        status: 'queued',
        effective_options: run.effectiveOptions,
      } : undefined;
    }
    if (text.includes('SELECT run.trigger_options, publication.queue_name')) {
      const run = taskManifestReservations.find((row) => row.id === params[0]);
      const publication = taskManifestPublications.find((row) => row.run_id === params[0]);
      return run && publication ? {
        trigger_options: run.triggerOptions,
        queue_name: publication.queue_name,
      } : undefined;
    }
    if (text.includes('SELECT trigger_options') && text.includes('FROM pipeline_runs') && text.includes('workspace_id = $2')) {
      const run = taskManifestReservations.find((row) => row.id === params[0] && row.workspaceId === params[1]);
      return run ? { trigger_options: run.triggerOptions } : undefined;
    }
    if (text.includes('SELECT trigger_options FROM pipeline_runs WHERE id = $1')) {
      const run = taskManifestReservations.find((row) => row.id === params[0]);
      return run ? { trigger_options: run.triggerOptions } : undefined;
    }
    if (text.includes('SELECT effective_options FROM pipeline_runs')) {
      const run = taskManifestReservations.find((row) => row.id === params[0]);
      return run ? { effective_options: run.effectiveOptions } : undefined;
    }
    if (text.includes('UPDATE pipeline_dispatch_publications') && text.includes('payload_hash = COALESCE')) {
      const publication = taskManifestPublications.find((row) => row.run_id === params[0] && row.lease_owner === params[1]);
      if (!publication) return undefined;
      publication.request_hash = publication.request_hash ?? params[2];
      publication.effective_options_hash = publication.effective_options_hash ?? params[3];
      publication.payload_hash = publication.payload_hash ?? params[4];
      publication.payload = publication.payload ?? jsonParam(params[5]);
      publication.queue_name = publication.queue_name ?? params[6];
      return { boss_job_id: publication.boss_job_id, queue_name: publication.queue_name };
    }
    if (text.includes('SELECT id::text FROM') && text.includes('.job WHERE id = $1')) {
      return undefined;
    }
    if (text.includes('UPDATE pipeline_dispatch_publications') && text.includes("state = 'published'")) {
      const publication = taskManifestPublications.find((row) => row.run_id === params[0]);
      if (!publication) return undefined;
      publication.state = 'published';
      publication.lease_owner = null;
      publication.lease_expires_at = null;
      publication.updated_at = new Date().toISOString();
      return { run_id: publication.run_id };
    }
    if (text.includes('FROM task_manifest_run_lineage lineage')) {
      const lineage = taskManifestLineages.find((row) => row.run_id === params[0]);
      const run = taskManifestReservations.find((row) => row.id === params[0]);
      return lineage && run ? {
        ...lineage,
        task_manifest_id: run.manifestId,
        task_manifest_artifacts: run.artifacts,
        trigger_options: run.triggerOptions,
      } : undefined;
    }
    if (text.includes('SELECT * FROM workspaces WHERE id = $1')) {
      return { id: params[0] ?? 'ws-hermes', label: 'Hermes Test Workspace', path: wsDir, domain: 'test' };
    }
    if (text.includes('COUNT(*) as count') && text.includes('worktree_path IS NOT NULL')) {
      return { count: '0' };
    }
    if (text.includes("SELECT * FROM pipeline_runs WHERE workspace_id = $1 AND status IN")) {
      return undefined;
    }
    if (text.includes('SELECT id FROM pipeline_runs') && text.includes("status IN ('running', 'paused', 'pi_native')")) {
      return undefined;
    }
    if (text.includes('SELECT COUNT(*) as count FROM pipeline_runs') && text.includes("status = 'queued'")) {
      return { count: '0' };
    }
    if (text.includes('SELECT id FROM pipeline_runs') && text.includes("status = 'queued'") && text.includes('spec_path')) {
      return undefined;
    }
    if (text.includes('FROM pipeline_runs') && text.includes('idempotency_key = $2')) {
      const run = taskManifestReservations.find((row) => row.workspaceId === params[0] && row.idempotencyKey === params[1]);
      return run ? {
        id: run.id, spec_path: run.specPath, status: 'queued', queue_position: run.queuePosition,
        triggered_via: run.triggeredVia, branch_name: run.branchName ?? null,
        execution_worktree_path: run.executionWorktreePath ?? null,
        idempotency_key: run.idempotencyKey, task_manifest_id: run.manifestId,
        task_manifest_artifacts: run.artifacts, trigger_options: run.triggerOptions,
        effective_options: run.effectiveOptions, task_manifest_authority_version: 1,
      } : undefined;
    }
    if (text.includes('SELECT pipeline_config FROM workspaces')) {
      return { pipeline_config: '{}' };
    }
    if (text.includes('SELECT * FROM agent_profiles')) {
      return undefined;
    }
    if (text.includes('INSERT INTO pipeline_runs') && text.includes('RETURNING id')) {
      const row = {
        id: nextRunId++,
        specPath: params[0],
        workspaceId: params[1],
        triggerType: params[2],
        parallelism: params[3],
        agent: params[4],
        agentType: params[5],
        agentModel: params[6],
        branchName: params[7],
        worktreePath: params[8],
        autoMerge: params[9],
        triggeredVia: params[10],
        autoWorktree: params[11],
        includeGraph: params[12],
        mergeStrategy: params[13],
        terminalMode: params[14],
        executionEnvironment: params[15],
        idempotencyKey: params[16],
        manifestId: params[17],
        artifacts: params[18] ? jsonParam(params[18]) : null,
        triggerOptions: params[19] ? jsonParam(params[19]) : null,
        dispatchRequestHash: params[20] ?? null,
      };
      pipelineRunInserts.push(row);
      taskManifestPublications.push({
        run_id: row.id,
        workspace_id: row.workspaceId,
        boss_job_id: `00000000-0000-5000-a000-${String(row.id).padStart(12, '0')}`,
        state: 'reserved',
        request_hash: row.dispatchRequestHash,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: '2000-01-01T00:00:00.000Z',
      });
      return { id: row.id };
    }
    if (text.includes('INSERT INTO wal_events')) {
      return makeWalEvent();
    }
    if (text.includes('COUNT(*) as count') && text.includes('id <')) {
      return { count: '0' };
    }
    return undefined;
  });
  mockTransaction.mockImplementation(async (callback: (client: { query: (sql: unknown, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => unknown) => (
    callback({ query: transactionQuery })
  ));
});

afterEach(() => {
  delete process.env.PI_BIN;
  delete process.env.RORCA_TASK_MANIFEST_FAILPOINT;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Hermes HRC task-manifest bridge fixtures', () => {
  test('fixture contract documents active worktree provenance and HRC concepts without live dependencies', () => {
    expect(HERMES_FIXTURE_PROVENANCE).toEqual(['hermes-closed-loop/PR#7', 'rorca-exec-env-toggle']);

    const parsed = safeParseTaskManifest(clone(hermesHrcTaskManifestWithExecutionEnvironment));

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.routeDecision.route).toBe('hermes.hrc.task-manifest');
    expect(parsed.data.context.contextRefs.map((ref) => ref.ref)).toEqual(expect.arrayContaining([
      'hrc-shared-context:bundle-20260315T220000Z',
      'selected-skill:rorca-autonomous-runner',
      'selected-principle:branch-pr-only',
      'validation-gate:gate-hrc-008',
    ]));
    expect(parsed.data.validation.successCriteria.join('\n')).toContain('evidenceIds ev-route-decision-001');
    expect(parsed.data.evidence.map((item) => item.ref)).toEqual(expect.arrayContaining([
      'evidence:ev-route-decision-001',
      'evidence:ev-validation-gate-002',
      'evidence:ev-branch-policy-003',
    ]));
    expect(parsed.data.policy).toMatchObject({ branchPrOnly: true, autoMerge: false, deploysAllowed: false });
    expect(parsed.data.source.rorca).toEqual(expect.objectContaining({
      specId: 'rorca-task-manifest-execution-bridge-for-hermes',
      runId: '20260316000440',
      storyId: 'TMB-008',
    }));
    expect(parsed.data.execution).toEqual(expect.objectContaining({
      executionEnvironment: 'local-worktree',
      executionEnvironmentId: 'hrc-local-worktree',
    }));
  });
});

describe('POST /api/pipeline/task-manifests/trigger Hermes compatibility', () => {
  test('queues a Hermes HRC manifest and preserves bridge metadata while normalizing unsupported execution-environment labels', async () => {
    const app = makeApp();
    const manifest = clone(hermesHrcTaskManifestWithExecutionEnvironment) as JsonRecord;

    const response = await request(app)
      .post('/api/pipeline/task-manifests/trigger')
      .send({
        workspaceId: 'ws-hermes',
        idempotencyKey: manifest.idempotencyKey,
        manifest,
        queue: true,
        autoWorktree: true,
        mergeStrategy: 'draft-pr',
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      queued: true,
      manifestId: manifest.manifestId,
      idempotencyKey: manifest.idempotencyKey,
      manifestHash: expect.stringMatching(/^sha256:/),
      manifestSource: expect.objectContaining({
        routeDecision: expect.objectContaining({ route: 'hermes.hrc.task-manifest' }),
      }),
    }));
    expect(response.body.executionEnvironment).toBeUndefined();
    expect(response.body.executionEnvironmentId).toBeUndefined();
    expect(taskManifestReservations).toHaveLength(1);
    const isolationIndex = taskManifestTransactionQueries.findIndex(({ text }) => text.startsWith('SET TRANSACTION'));
    const actorIndex = taskManifestTransactionQueries.findIndex(({ text }) => text.includes('FROM users actor'));
    const claimsIndex = taskManifestTransactionQueries.findIndex(({ text }) => text.includes('set_config('));
    const protectedRunIndex = taskManifestTransactionQueries.findIndex(({ text }) => text.includes('FROM pipeline_runs'));
    expect([isolationIndex, actorIndex, claimsIndex, protectedRunIndex]).toEqual([0, 1, 2, 3]);
    expect(taskManifestTransactionQueries[actorIndex].params).toEqual(['test-user', 'ws-hermes']);
    expect(taskManifestTransactionQueries[claimsIndex].params).toEqual([
      'request.jwt.claim.sub',
      '00000000-0000-4000-8000-000000000777',
      'request.jwt.claims',
      JSON.stringify({
        sub: '00000000-0000-4000-8000-000000000777',
        role: 'authenticated',
        aud: 'authenticated',
      }),
    ]);
    expect(taskManifestReservations[0]).toEqual(expect.objectContaining({
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      idempotencyKey: manifest.idempotencyKey,
      manifestId: manifest.manifestId,
      taskManifestAuthorityVersion: 1,
      effectiveOptions: expect.objectContaining({
        worktree: expect.objectContaining({
          enabled: true,
          path: expect.any(String),
          branch: expect.stringMatching(/^feat\//),
        }),
        runtime: {
          piExecutable: {
            piBinPath: process.execPath,
            piRealPath: fs.realpathSync(process.execPath),
          },
        },
        safety: expect.objectContaining({
          deploy: false,
          externalSend: true,
          policyLocked: true,
          ordinaryLocalPi: process.platform === 'darwin',
        }),
        merge: expect.objectContaining({ strategy: 'draft-pr', autoMerge: false }),
      }),
    }));
    expect(taskManifestReservations[0].triggerOptions).toEqual(expect.objectContaining({
      source: 'task-manifest',
      routeDecision: expect.objectContaining({ route: 'hermes.hrc.task-manifest' }),
      sourceRefs: expect.objectContaining({
        rorca: expect.objectContaining({ storyId: 'TMB-008', runId: '20260316000440' }),
      }),
      policySummary: expect.objectContaining({ branchPrOnly: true, autoMerge: false }),
      validationPlanSummary: expect.objectContaining({
        requiredCommands: expect.arrayContaining(['cd backend && npx tsc --noEmit']),
      }),
      execution: expect.objectContaining({
        mergeStrategy: 'draft-pr',
        executionEnvironmentSupported: false,
        executionEnvironment: 'remote-rorca',
        executionEnvironmentId: 'hrc-local-worktree',
      }),
    }));
    expect(taskManifestReservations[0].triggerOptions).not.toHaveProperty('readinessOverride');
    expect(mockBoss.send).not.toHaveBeenCalled();
  });

  test('queued idempotent replay rejects Pi executable substitution without mutating or publishing reservation authority', async () => {
    const app = makeApp();
    const manifest = clone(hermesHrcTaskManifestWithExecutionEnvironment) as JsonRecord;
    const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-replay-pi-'));
    const launcher = path.join(launcherRoot, 'pi');
    fs.symlinkSync(process.execPath, launcher);
    process.env.PI_BIN = launcher;
    try {
      const body = {
        workspaceId: 'ws-hermes', idempotencyKey: manifest.idempotencyKey, manifest,
        queue: true, autoWorktree: true, mergeStrategy: 'draft-pr',
      };
      const first = await request(app).post('/api/pipeline/task-manifests/trigger').send(body);
      expect(first.status).toBe(202);
      const reservedBefore = clone(taskManifestReservations[0].effectiveOptions) as JsonRecord;
      expect((reservedBefore.runtime as JsonRecord).piExecutable).toEqual({
        piBinPath: launcher,
        piRealPath: fs.realpathSync(process.execPath),
      });

      fs.unlinkSync(launcher);
      fs.symlinkSync('/bin/sh', launcher);
      const replay = await request(app).post('/api/pipeline/task-manifests/trigger').send(body);

      expect(replay.status).toBe(409);
      expect(replay.body.error).toContain('immutable reserved execution authority');
      expect(taskManifestReservations).toHaveLength(1);
      expect(taskManifestReservations[0].effectiveOptions).toEqual(reservedBefore);
      expect(taskManifestPublications[0].state).toBe('reserved');
      expect(mockBoss.send).not.toHaveBeenCalled();
      expect(mockTransaction.mock.calls.some(([callback]) => typeof callback === 'function')).toBe(true);
    } finally {
      process.env.PI_BIN = process.execPath;
      fs.rmSync(launcherRoot, { recursive: true, force: true });
    }
  });

  test('direct reservation replay rejects Pi executable substitution before publication or spawn', async () => {
    const app = makeApp();
    const manifest = clone(hermesHrcTaskManifestWithExecutionEnvironment) as JsonRecord;
    const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-direct-replay-pi-'));
    const launcher = path.join(launcherRoot, 'pi');
    fs.symlinkSync(process.execPath, launcher);
    process.env.PI_BIN = launcher;
    process.env.RORCA_TASK_MANIFEST_FAILPOINT = 'after_reservation_before_preparation';
    try {
      const body = {
        workspaceId: 'ws-hermes', idempotencyKey: manifest.idempotencyKey, manifest,
        queue: false, autoWorktree: true, mergeStrategy: 'draft-pr',
      };
      const interrupted = await request(app).post('/api/pipeline/task-manifests/trigger').send(body);
      expect(interrupted.status).toBeGreaterThanOrEqual(500);
      expect(taskManifestReservations).toHaveLength(1);
      const reservedBefore = clone(taskManifestReservations[0].effectiveOptions) as JsonRecord;
      delete process.env.RORCA_TASK_MANIFEST_FAILPOINT;
      fs.unlinkSync(launcher);
      fs.symlinkSync('/bin/sh', launcher);

      const replay = await request(app).post('/api/pipeline/task-manifests/trigger').send(body);
      expect(replay.status).toBe(409);
      expect(replay.body.error).toContain('immutable reserved execution authority');
      expect(taskManifestReservations[0].effectiveOptions).toEqual(reservedBefore);
      expect(taskManifestPublications[0].state).toBe('reserved');
      expect(mockBoss.send).not.toHaveBeenCalled();
    } finally {
      delete process.env.RORCA_TASK_MANIFEST_FAILPOINT;
      process.env.PI_BIN = process.execPath;
      fs.rmSync(launcherRoot, { recursive: true, force: true });
    }
  });

  test('dispatches a non-dry-run synthetic manifest without applying approved-spec pass authority', async () => {
    const app = makeApp();
    const manifest = clone(hermesHrcTaskManifestWithoutExecutionEnvironment) as JsonRecord;
    (manifest.policy as JsonRecord).dryRun = false;

    const response = await request(app)
      .post('/api/pipeline/task-manifests/trigger')
      .send({
        workspaceId: 'ws-hermes',
        idempotencyKey: manifest.idempotencyKey,
        manifest,
        queue: false,
        autoWorktree: true,
        mergeStrategy: 'draft-pr',
        agentOverride: 'claude',
      });

    expect({ status: response.status, body: response.body }).toEqual({ status: 201, body: expect.objectContaining({
      ok: true,
      queued: true,
      manifestId: manifest.manifestId,
      idempotencyKey: manifest.idempotencyKey,
      runId: expect.any(Number),
    }) });
    expect(taskManifestReservations).toHaveLength(1);
    expect(mockBoss.send).toHaveBeenCalledTimes(1);
    expect((taskManifestReservations[0].triggerOptions as JsonRecord).lifecycleDispatchClaim).toEqual(expect.objectContaining({
      schemaVersion: 'lifecycle-dispatch-claim.v1',
      claimId: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'ws-hermes',
      specId: path.basename(String(taskManifestReservations[0].specPath), '.json'),
      specHash: `sha256:${'b'.repeat(64)}`,
      compiledPlanId: '102',
      requestIdentity: `pipeline:${String(manifest.idempotencyKey)}`,
      requestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }));
  });

  test('replays prepared-before-send loss to one run and one pg-boss publication', async () => {
    const app = makeApp();
    const manifest = clone(hermesHrcTaskManifestWithoutExecutionEnvironment) as JsonRecord;
    (manifest.policy as JsonRecord).dryRun = false;
    const body = { workspaceId: 'ws-hermes', idempotencyKey: manifest.idempotencyKey, manifest, queue: false, autoWorktree: true, mergeStrategy: 'draft-pr', agentOverride: 'claude' };
    process.env.RORCA_TASK_MANIFEST_FAILPOINT = 'after_preparation_before_send';
    const lost = await request(app).post('/api/pipeline/task-manifests/trigger').send(body);
    delete process.env.RORCA_TASK_MANIFEST_FAILPOINT;
    expect(lost.status).toBeGreaterThanOrEqual(500);
    expect(taskManifestReservations).toHaveLength(1);
    expect(mockBoss.send).not.toHaveBeenCalled();
    taskManifestPublications[0].lease_expires_at = '2000-01-01T00:00:00.000Z';

    const replay = await request(app).post('/api/pipeline/task-manifests/trigger').send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.runId).toBe(taskManifestReservations[0].id);
    expect(mockBoss.send).toHaveBeenCalledTimes(1);
    expect(taskManifestPublications[0].state).toBe('published');

    const responseLostReplay = await request(app).post('/api/pipeline/task-manifests/trigger').send(body);
    expect(responseLostReplay.status).toBe(200);
    expect(responseLostReplay.body.runId).toBe(replay.body.runId);
    expect(mockBoss.send).toHaveBeenCalledTimes(1);
  });

  test('rejects explicit local-user before workspace, reservation, artifact, or queue mutation', async () => {
    const app = makeApp();
    const manifest = clone(hermesHrcTaskManifestWithoutExecutionEnvironment) as JsonRecord;
    const execution = manifest.execution as JsonRecord;
    execution.executionEnvironment = 'local-user';
    execution.executionEnvironmentId = 'missing-local-bridge';
    mockQuery.mockClear();
    mockQueryOne.mockClear();
    mockExecute.mockClear();
    mockBoss.send.mockClear();

    const response = await request(app).post('/api/pipeline/task-manifests/trigger').send({
      workspaceId: 'ws-hermes', idempotencyKey: manifest.idempotencyKey, manifest,
      executionEnvironment: 'local-user', executionEnvironmentId: 'missing-local-bridge',
      autoWorktree: true, mergeStrategy: 'draft-pr',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockAssertExecutionEnvironmentReadyForRun).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(taskManifestReservations).toHaveLength(0);
    expect(pipelineRunInserts).toHaveLength(0);
    expect(mockBoss.send).not.toHaveBeenCalled();
  });

  test('accepts a Hermes manifest without optional executionEnvironment fields', async () => {
    const app = makeApp();
    const manifest = clone(hermesHrcTaskManifestWithoutExecutionEnvironment) as JsonRecord;

    const response = await request(app)
      .post('/api/pipeline/task-manifests/trigger')
      .send({
        workspaceId: 'ws-hermes',
        idempotencyKey: manifest.idempotencyKey,
        manifest,
        dryRun: true,
        autoWorktree: true,
        mergeStrategy: 'draft-pr',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      dryRun: true,
      queued: false,
      manifestId: manifest.manifestId,
      idempotencyKey: manifest.idempotencyKey,
      estimatedExecutionPlan: expect.objectContaining({
        mergeStrategy: 'draft-pr',
        executionEnvironmentSupported: true,
        executionEnvironmentId: null,
      }),
    }));
    expect(mockBoss.send).not.toHaveBeenCalled();
  });

  test.each([
    ['missing idempotencyKey', (body: JsonRecord) => { delete body.idempotencyKey; }, 400, 'TASK_MANIFEST_IDEMPOTENCY_KEY_REQUIRED'],
    ['autoMerge=true', (body: JsonRecord) => { body.autoMerge = true; }, 422, 'TASK_MANIFEST_AUTO_MERGE_REJECTED'],
    ['mergeStrategy=direct', (body: JsonRecord) => { body.mergeStrategy = 'direct'; }, 422, 'TASK_MANIFEST_MERGE_STRATEGY_MISMATCH'],
    ['autoMerge=true plus mergeStrategy=direct', (body: JsonRecord) => { body.autoMerge = true; body.mergeStrategy = 'direct'; }, 422, 'TASK_MANIFEST_MERGE_STRATEGY_MISMATCH'],
    ['high-risk direct-repair route', (body: JsonRecord) => { (body.manifest as JsonRecord).routeDecision = { route: 'hermes.direct-repair', reason: 'Bypass route' }; }, 400, 'TASK_MANIFEST_HIGH_RISK_ROUTE'],
    ['unsafe artifact path', (body: JsonRecord) => { ((body.manifest as JsonRecord).evidence as JsonRecord[])[0].path = '../dirty-artifacts/outside.patch'; }, 400, 'TASK_MANIFEST_UNSAFE_ARTIFACT_PATH'],
    ['oversized context', (body: JsonRecord) => {
      const manifest = body.manifest as JsonRecord;
      const context = manifest.context as JsonRecord;
      const refs = context.contextRefs as JsonRecord[];
      context.contextRefs = Array.from({ length: TASK_MANIFEST_LIMITS.maxContextRefCount + 1 }, () => ({ ...refs[0] }));
    }, 400, 'TASK_MANIFEST_CONTEXT_TOO_LARGE'],
  ])('rejects %s with an actionable error code', async (_caseName, mutate, expectedStatus, expectedCode) => {
    const app = makeApp();
    const manifest = clone(hermesHrcTaskManifestWithExecutionEnvironment) as JsonRecord;
    const body: JsonRecord = {
      workspaceId: 'ws-hermes',
      idempotencyKey: manifest.idempotencyKey,
      manifest,
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    };
    mutate(body);

    const response = await request(app)
      .post('/api/pipeline/task-manifests/trigger')
      .send(body);

    expect(response.status).toBe(expectedStatus);
    expect(response.body.error).toEqual(expect.any(String));
    expect([response.body.code, response.body.details?.code]).toContain(expectedCode);
    expect(taskManifestReservations).toHaveLength(0);
    expect(mockBoss.send).not.toHaveBeenCalled();
  });
});

describe('GET /api/pipeline/runs/:runId campaign authority projection', () => {
  test('returns exact manifest, host attempt, accepted closeout, and non-Pi validated completion', async () => {
    const app = makeApp();
    const baseSha = 'a'.repeat(40);
    const commitSha = 'b'.repeat(40);
    const manifest = createStoryExecutionManifest({
      identity: { workspaceId: 'ws-hermes', specId: 'campaign-spec', storyId: 'ROR-29', runId: 42, attempt: 1 },
      revisions: { specRevision: 'campaign-spec-v1', storyRevision: `sha256:${'c'.repeat(64)}` },
      executionMode: 'impl',
      lifecycle: storyLifecycleFixture('ws-hermes', 'campaign-spec', 'ROR-29'),
      execution: {
        agent: 'codex', model: 'gpt-5', effort: null, terminal: 'ansi-html',
        worktree: { enabled: true, path: '/worktree/run-42', branch: 'feat/campaign-spec', baseRevision: baseSha },
        merge: { enabled: false, strategy: 'branch-only', targetBranch: null },
      },
      validationPlan: [], evidenceExpectations: [],
      repositoryProfile: { profileId: 'code-v1', changePolicy: 'code_required', noCodeReason: null, runtimeMetadataPaths: [] },
      commandSafety: { profileId: 'safe-v1', guardVersion: '1', guardedWorkingDirectory: '/worktree/run-42', allowedWorkingDirectories: ['/worktree/run-42'], blockedCommandPatterns: [], redactedEnvironmentKeys: [], allowBackendJest: true, baselineFailurePolicy: 'block' },
    });
    const attempt = createStoryAttemptResult({
      identity: { ...manifest.identity }, revisions: { ...manifest.revisions }, manifestHash: manifest.manifestHash,
      agentProcess: { agent: 'codex', model: 'gpt-5', effort: null, processId: 123, sessionId: 'codex-session' },
      startedAt: '2026-07-27T00:00:00.000Z', finishedAt: '2026-07-27T00:01:00.000Z',
      termination: { kind: 'exited', exitCode: 0 }, outputReferences: [],
      proposedCompletionPacket: { manifestHash: manifest.manifestHash, identity: { ...manifest.identity }, revisions: { ...manifest.revisions }, proposal: 'complete', summary: 'Codex proposed completion.', criterionEvidence: [] },
      observedFiles: [{ path: 'src/change.ts', changeType: 'modified', runtimeMetadata: false, observer: 'host' }],
      observedCommits: [], hostValidationObservations: [], knownIssues: [],
    });
    const scoped = { workspaceId: 'ws-hermes', specId: 'campaign-spec', runId: 42, storyId: 'ROR-29', manifestHash: manifest.manifestHash, specRevision: manifest.revisions.specRevision, storyRevision: manifest.revisions.storyRevision };
    const closeout = evaluateStoryCloseout({ manifest, attempt, host: {
      identity: { ...manifest.identity },
      activeSubjectRevision: { commitSha, worktreePath: '/worktree/run-42', branch: 'feat/campaign-spec' },
      repository: { worktreeClean: true, changedFiles: ['src/change.ts'], runtimeMetadataFiles: [], headBeforeValidation: commitSha, headAfterValidation: commitSha },
      validations: [], criterionEvidence: [],
      storyCommits: [{ workspaceId: 'ws-hermes', specId: 'campaign-spec', runId: 42, storyId: 'ROR-29', sha: commitSha, branch: 'feat/campaign-spec', message: 'campaign change', author: 'rorca-execution-engine', committedAt: '2026-07-27T00:01:00.000Z', observedBy: 'worktree_branch' }],
      progress: { ...scoped, reportsComplete: true }, storyResult: { ...scoped, status: 'pass' },
    } });
    expect(closeout.status).toBe('accepted');

    const run = {
      id: 42, workspace_id: 'ws-hermes', spec_path: 'forge/specs/approved/campaign-spec.json', status: 'done',
      idempotency_key: 'campaign:key', dispatch_request_hash: `sha256:${'d'.repeat(64)}`,
      agent: 'codex', agent_type: 'codex', agent_model: 'gpt-5', terminal_mode: 'ansi-html',
      queued_at: '2026-07-27T00:00:00.000Z', finished_at: '2026-07-27T00:01:00.000Z',
      worktree_path: '/worktree/run-42', branch_name: 'feat/campaign-spec', include_graph: false,
      campaign_dispatch_authorization_hash: null,
    };
    const story = {
      id: 7, run_id: 42, story_id: 'ROR-29', status: 'pass', retries: 0,
      started_at: '2026-07-27T00:00:00.000Z', finished_at: '2026-07-27T00:01:00.000Z',
      input_tokens: 1, output_tokens: 1, model_used: 'gpt-5', cost_usd: 0,
      spec_id: 'campaign-spec', spec_revision: manifest.revisions.specRevision,
      story_revision: manifest.revisions.storyRevision, manifest_hash: manifest.manifestHash,
      closeout_decision_id: closeout.decisionId, result_provenance: 'host',
      result_source: 'execution-engine', integrated: true, commit_sha: commitSha,
      commit_author: 'rorca-execution-engine', commit_observed_source: 'worktree_branch', completion_packet: null,
    };
    mockQueryOne.mockImplementation(async (sql: unknown) => {
      const text = sqlText(sql);
      if (text.includes('SELECT * FROM pipeline_runs WHERE id')) return run;
      if (text.includes('SELECT path FROM workspaces')) return { path: wsDir };
      if (text.includes('SUM(input_tokens)')) return { total_input: 1, total_output: 1, total_cost: 0 };
      return undefined;
    });
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = sqlText(sql);
      if (text.includes('SELECT * FROM story_results')) return [story];
      if (text.includes('SELECT payload FROM story_execution_manifests')) return [{ payload: manifest }];
      if (text.includes('FROM story_closeout_decisions decision')) return [{ story_id: 'ROR-29', spec_id: 'campaign-spec', decision_id: closeout.decisionId, manifest_hash: manifest.manifestHash, attempt: 1, closeout_payload: closeout, attempt_result_id: attempt.attemptResultId, attempt_payload: attempt }];
      return [];
    });

    const response = await request(app).get('/api/pipeline/runs/42?includeExecutionManifests=true&includeCloseoutDecisions=true');
    expect(response.status).toBe(200);
    expect(response.body.executionManifests).toEqual([expect.objectContaining({ manifestHash: manifest.manifestHash, execution: expect.objectContaining({ agent: 'codex', worktree: expect.objectContaining({ baseRevision: baseSha }) }) })]);
    expect(response.body.stories).toEqual([expect.objectContaining({
      completion_packet: null,
      attempt_result: expect.objectContaining({ attemptResultId: attempt.attemptResultId }),
      closeout_decision: expect.objectContaining({ decisionId: closeout.decisionId, status: 'accepted' }),
      evidence_snapshot_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      completion_validation: expect.objectContaining({ status: 'validated', agent: 'codex', baseRevision: baseSha }),
    })]);
  });
});

describe('POST /api/pipeline/trigger legacy Hermes compatibility guard', () => {
  test('rejects raw legacy Hermes repair metadata instead of silently treating it as a normal spec run', async () => {
    const app = makeApp();

    const response = await request(app)
      .post('/api/pipeline/trigger')
      .send(clone(legacyHermesRepairTriggerMetadata));

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        code: 'HERMES_REPAIR_METADATA_REQUIRES_TASK_MANIFEST',
        endpoint: '/api/pipeline/task-manifests/trigger',
        fields: expect.arrayContaining(['repairPlanId', 'evidenceIds', 'validationGate', 'principleSelection', 'branchStrategy', 'worktreePath']),
      }),
    }));
    expect(response.body.error).toContain('/api/pipeline/task-manifests/trigger');
    expect(pipelineRunInserts).toHaveLength(0);
    expect(mockBoss.send).not.toHaveBeenCalled();
  });

  test('normal full-spec route rejects manifestless execution before worktree or dispatch', async () => {
    const app = makeApp();
    const specPath = seedNormalSpec('hermes-normal-spec');

    const response = await request(app)
      .post('/api/pipeline/trigger')
      .set('Idempotency-Key', 'hermes-normal-spec-manifestless')
      .send({
        specPath,
        workspaceId: 'ws-hermes',
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'pr',
        agentOverride: 'opencode',
        modelOverride: 'openrouter/z-ai/glm-5',
        terminal_mode: 'ansi-html',
      });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED',
      details: {
        profileId: 'release-1-supervised-core',
        capabilityId: 'bounded_task_manifest',
        endpoint: '/api/pipeline/task-manifests/trigger',
      },
    });
    expect(pipelineRunInserts).toHaveLength(0);
    expect(taskManifestReservations).toHaveLength(0);
    expect(mockSimpleGitRaw).not.toHaveBeenCalled();
    expect(mockBoss.createQueue).not.toHaveBeenCalled();
    expect(mockBoss.send).not.toHaveBeenCalled();
  });
});
