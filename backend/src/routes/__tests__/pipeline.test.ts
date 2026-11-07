/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import crypto from 'node:crypto';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type * as AuthHelperModule from './helpers/auth-helper';
import type * as DatabaseModule from '../../db/index';
import type * as TrustedWalModule from '../../lib/trusted-wal';
import type { getBoss as GetPipelineBoss } from '../../lib/pg-boss';
import { Pool } from 'pg';
import request from 'supertest';
import { gzipSync } from 'zlib';
import { computeTaskManifestHash } from '../../lib/task-manifest-artifacts';
import { safeParseTaskManifest } from '../../lib/task-manifest';
import { storyLifecycleFixture } from '../../lib/__tests__/fixtures/story-execution-manifest.fixture';
import { publishSpecExportKit, sealSpecExportKit } from '../../lib/spec-export-kit';

// Server initialization + migrations can take > 30s on first run
jest.setTimeout(90_000);

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

// Lifecycle dispatch behavior is certified by the orchestrator suite. These
// route contracts exercise behavior after exact-revision lifecycle preflight.
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
      specHash: `sha256:${'a'.repeat(64)}`,
      compiledPlanId: '101',
      plan: storyLifecycleFixture(input.workspaceId, input.specId, storyId, storyIds).plan,
      phases: [],
      policy: { advanced: [], awaitingHuman: [] },
    };
  }),
}));

jest.mock('../../lib/lifecycle-dispatch-claim', () => ({
  claimLifecycleDispatch: jest.fn().mockImplementation(async (input: Record<string, string>) => ({
    schemaVersion: 'lifecycle-dispatch-claim.v1',
    claimId: '11111111-1111-4111-8111-111111111111',
    ...input,
  })),
  parseLifecycleDispatchClaim: jest.fn().mockImplementation((value: unknown) => value),
  assertLifecycleDispatchClaim: jest.fn().mockResolvedValue(undefined),
  withLifecycleDispatchClaimLock: jest.fn().mockImplementation(
    async (_claim: unknown, action: () => unknown) => action(),
  ),
}));

jest.mock('../../lib/claude-auth', () => ({
  getClaudeAuthState: jest.fn().mockReturnValue({ connected: true, email: 'test@example.com', tier: 'max', cliInstalled: true }),
  triggerClaudeLogin: jest.fn().mockReturnValue({ started: true }),
  triggerClaudeLogout: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../lib/codex-auth', () => ({
  getCodexAuthState: jest.fn().mockReturnValue({ connected: true, username: 'test@example.com', plan: 'pro', cliInstalled: true }),
  triggerCodexLogin: jest.fn().mockReturnValue({ started: true }),
  triggerCodexLogout: jest.fn().mockResolvedValue({ ok: true }),
}));

// Mock pg-boss so pipeline trigger doesn't fail with "getBoss() called before initBoss()"
// In test mode server.ts never calls initBoss(), so we stub the whole module.
jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getPgBossSchemaSql: jest.fn(() => '"pgboss"'),
  getBoss: jest.fn().mockReturnValue({
    createQueue: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockImplementation(async (_name: string, _data: unknown, options?: { id?: string }) => options?.id ?? '00000000-0000-4000-8000-000000000001'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../lib/pty-manager', () => ({
  PTY_AVAILABLE: true,
  PTY_UNAVAILABLE_HINT: 'Run: cd backend && npm rebuild node-pty',
}));

const PIPE_WORKSPACE_ID = 'ws-pipe';
const PIPE_OTHER_WORKSPACE_ID = 'ws-pipe-other';
const LIST_WORKSPACE_ID = PIPE_WORKSPACE_ID;
const PRIMARY_USER_ID = crypto.randomUUID();
const PRIMARY_AUTH_ID = crypto.randomUUID();
const PRIMARY_USER_EMAIL = `pipeline-suite-${process.pid}@rorca.internal`;
const SERVICE_USER_ID = crypto.randomUUID();
const SERVICE_AUTH_ID = crypto.randomUUID();
const SERVICE_USER_EMAIL = `hermes-pipeline-suite-${process.pid}@rorca.internal`;
const SECONDARY_USER_ID = crypto.randomUUID();
const SECONDARY_AUTH_ID = crypto.randomUUID();
const SECONDARY_USER_EMAIL = `pipeline-secondary-${process.pid}@example.com`;
const ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'RORCA_TEST_DATABASE_WORKSPACE_SCOPE',
  'RORCA_EXPERIMENTAL_WAVE_PARALLEL',
  'RORCA_ENABLE_LEGACY_STORY_RESULT_INGRESS',
  'PI_BIN',
  'RORCA_PROVIDER_HUMAN_ISSUERS_JSON',
  'RORCA_AGENT',
  'RORCA_MODEL',
] as const;
type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number];
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<EnvironmentKey, string | undefined>;

// The application pool captures this value when db/index is first required.
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = PIPE_WORKSPACE_ID;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${PIPE_WORKSPACE_ID}`,
});

let app: Express;
let testServer: Server;
let tmpDir: string;
let wsDir: string;
let authToken: string;
let secondaryAuthToken: string;
let serviceAuthToken: string;
let getAuthToken: typeof AuthHelperModule.getAuthToken;
let query: typeof DatabaseModule.query;
let queryOne: typeof DatabaseModule.queryOne;
let stableWalJson: typeof TrustedWalModule.stableWalJson;
let originalLocalAdmin: { email: string; plan: string } | undefined;
let createdModelPricing = false;

function restoreEnvironment(): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function ownerExecute(sql: string, params: unknown[] = []): Promise<void> {
  await ownerPool.query(sql, params);
}

async function ownerQueryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await ownerPool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function cleanupMutableFixtures(): Promise<void> {
  const workspaceIds = [PIPE_WORKSPACE_ID, PIPE_OTHER_WORKSPACE_ID];
  await ownerExecute(
    `DELETE FROM spec_post_save_stage_dependencies dependency
      USING spec_post_save_workflow_runs run
      WHERE dependency.run_id = run.id AND run.workspace_id = ANY($1::text[])`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM spec_post_save_workflow_stages stage
      USING spec_post_save_workflow_runs run
      WHERE stage.run_id = run.id AND run.workspace_id = ANY($1::text[])`,
    [workspaceIds],
  );
  await ownerExecute(
    'DELETE FROM spec_post_save_workflow_runs WHERE workspace_id = ANY($1::text[])',
    [workspaceIds],
  );
  await ownerExecute('DELETE FROM spec_jobs WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await ownerExecute(
    `DELETE FROM spec_generation_logs
      WHERE context_summary_json->>'workspaceId' = ANY($1::text[])`,
    [workspaceIds],
  );
  // Preserve immutable TaskManifest lineage while releasing this suite's exact
  // active queue slots before the next case.
  await ownerExecute(
    `UPDATE pipeline_runs
        SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW())
      WHERE workspace_id = ANY($1::text[])
        AND task_manifest_id IS NOT NULL
        AND status NOT IN ('done', 'failed', 'cancelled', 'partial_failure')`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM token_usage usage USING pipeline_runs run
      WHERE usage.run_id = run.id AND run.workspace_id = ANY($1::text[])`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM story_results result USING pipeline_runs run
      WHERE result.run_id = run.id AND run.workspace_id = ANY($1::text[])`,
    [workspaceIds],
  );
  await ownerExecute('DELETE FROM wal_events WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await ownerExecute(
    `DELETE FROM retrieval_telemetry_events WHERE workspace_id = ANY($1::text[])`,
    [workspaceIds],
  );
  // TaskManifest lineage/publication is intentionally append-only. Only remove
  // disposable route and fixture runs that have no canonical lineage.
  await ownerExecute(
    `DELETE FROM pipeline_runs run
      WHERE run.workspace_id = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM task_manifest_run_lineage lineage WHERE lineage.run_id = run.id)
        AND NOT EXISTS (SELECT 1 FROM task_manifest_dispatch_publications publication WHERE publication.run_id = run.id)`,
    [workspaceIds],
  );
  await ownerExecute(
    'DELETE FROM workspaces WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM pipeline_runs WHERE workspace_id = $1)',
    [PIPE_OTHER_WORKSPACE_ID],
  );
}

// Load one workspace-bound runtime pool and one server for this suite.
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = PIPE_WORKSPACE_ID;
  ({ getAuthToken } = require('./helpers/auth-helper') as typeof AuthHelperModule);
  ({ query, queryOne } = require('../../db/index') as typeof DatabaseModule);
  ({ stableWalJson } = require('../../lib/trusted-wal') as typeof TrustedWalModule);

  originalLocalAdmin = await ownerQueryOne<{ email: string; plan: string }>(
    `SELECT email, plan FROM users WHERE id = 'local-admin'`,
  );
  createdModelPricing = !(await ownerQueryOne<{ model_id: string }>(
    `SELECT model_id FROM model_pricing WHERE model_id = 'claude-sonnet-4-5-20250929'`,
  ));
  await ownerExecute(
    `INSERT INTO users (id, email, display_name, password_hash, auth_id, role, plan)
     VALUES
       ($1, $2, 'Pipeline Suite User', 'x', $3::uuid, 'admin', 'pro'),
       ($4, $5, 'Hermes Pipeline Test Service', 'x', $6::uuid, 'admin', 'pro'),
       ($7, $8, 'Pipeline Secondary Human', 'x', $9::uuid, 'user', 'pro')
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email, auth_id = EXCLUDED.auth_id, role = EXCLUDED.role, plan = EXCLUDED.plan`,
    [
      PRIMARY_USER_ID, PRIMARY_USER_EMAIL, PRIMARY_AUTH_ID,
      SERVICE_USER_ID, SERVICE_USER_EMAIL, SERVICE_AUTH_ID,
      SECONDARY_USER_ID, SECONDARY_USER_EMAIL, SECONDARY_AUTH_ID,
    ],
  );
  await ownerExecute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro'`,
  );
  await ownerExecute(
    `INSERT INTO model_pricing
       (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
     VALUES ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0)
     ON CONFLICT (model_id) DO NOTHING`,
  );

  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  const listening = Promise.withResolvers<Server>();
  const listener = expressApp.listen(0, '127.0.0.1', () => {
    listener.off('error', listening.reject);
    listening.resolve(listener);
  });
  listener.once('error', listening.reject);
  testServer = await listening.promise;
  app = testServer as unknown as Express;
  authToken = await getAuthToken(expressApp, {
    email: PRIMARY_USER_EMAIL,
    authId: PRIMARY_AUTH_ID,
    role: 'admin',
    displayName: 'Pipeline Suite User',
  });
  serviceAuthToken = await getAuthToken(expressApp, {
    email: SERVICE_USER_EMAIL,
    authId: SERVICE_AUTH_ID,
    role: 'admin',
    displayName: 'Hermes Pipeline Test Service',
  });
  secondaryAuthToken = await getAuthToken(expressApp, {
    email: SECONDARY_USER_EMAIL,
    authId: SECONDARY_AUTH_ID,
    role: 'user',
    displayName: 'Pipeline Secondary Human',
  });
});

beforeEach(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = PIPE_WORKSPACE_ID;
  delete process.env.RORCA_EXPERIMENTAL_WAVE_PARALLEL;
  jest.clearAllMocks();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pipeline-test-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });

  execSync('git init -b main', { cwd: wsDir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: wsDir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: wsDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# test workspace\n', 'utf8');
  execSync('git add README.md', { cwd: wsDir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: wsDir, stdio: 'pipe' });

  await cleanupMutableFixtures();
  await ownerExecute(`UPDATE users SET plan = 'pro' WHERE id IN ($1, $2, 'local-admin')`, [
    PRIMARY_USER_ID,
    SERVICE_USER_ID,
  ]);
  await ownerExecute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'Pipeline WS', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [PIPE_WORKSPACE_ID, wsDir],
  );
  await ownerExecute(
    `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
     VALUES ($1, $2::uuid, 'owner')
     ON CONFLICT (workspace_id, user_auth_id) DO UPDATE SET role = 'owner'`,
    [PIPE_WORKSPACE_ID, PRIMARY_AUTH_ID],
  );
});

afterEach(async () => {
  try {
    const immediate = Promise.withResolvers<void>();
    setImmediate(immediate.resolve);
    await immediate.promise;
    // Route dispatch is deliberately fire-and-forget; wait for its documented
    // durable side effects before fixture-owner cleanup closes over the rows.
    const dispatchDrain = Promise.withResolvers<void>();
    setTimeout(dispatchDrain.resolve, 300);
    await dispatchDrain.promise;
    await cleanupMutableFixtures();
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnvironment();
  }
});

afterAll(async () => {
  try {
    if (testServer) {
      testServer.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      testServer.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
    await ownerExecute('DELETE FROM workspace_members WHERE workspace_id = $1', [PIPE_WORKSPACE_ID]);
    await ownerExecute(
      'DELETE FROM workspaces WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM pipeline_runs WHERE workspace_id = $1)',
      [PIPE_WORKSPACE_ID],
    );
    await ownerExecute('DELETE FROM users WHERE id = ANY($1::text[])', [[PRIMARY_USER_ID, SERVICE_USER_ID, SECONDARY_USER_ID]]);
    if (originalLocalAdmin) {
      await ownerExecute(`UPDATE users SET email = $1, plan = $2 WHERE id = 'local-admin'`, [
        originalLocalAdmin.email,
        originalLocalAdmin.plan,
      ]);
    } else {
      await ownerExecute(`DELETE FROM users WHERE id = 'local-admin'`);
    }
    if (createdModelPricing) {
      await ownerExecute(
        `DELETE FROM model_pricing WHERE model_id = 'claude-sonnet-4-5-20250929'`,
      );
    }
  } finally {
    await ownerPool.end();
    restoreEnvironment();
  }
});

/** Seed a spec JSON file in the workspace */
function seedSpec(status: 'pending' | 'approved', slug: string) {
  const dir = path.join(wsDir, 'forge', 'specs', status);
  const unboundSpec = {
    id: slug,
    title: slug.replace(/-/g, ' '),
    userStories: [
      { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
      { id: 'US-002', title: 'Story two', description: 'Desc 2', acceptanceCriteria: ['AC2'], dependsOn: [], passes: false },
    ],
    generatedAt: '2026-02-20T12:00:00.000Z',
  };
  const exportKitIdentity = publishSpecExportKit(wsDir, unboundSpec);
  const spec = { ...unboundSpec, exportKitIdentity };
  sealSpecExportKit(wsDir, spec, {
    actorId: 'pipeline-test-approver',
    approvalReceiptId: `pipeline-test:${slug}`,
  });
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

async function seedSpecReadinessLog(specSlug: string, workspaceId = 'ws-pipe'): Promise<void> {
  await ownerExecute(`INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, enriched, retrieval_method, context_summary_json, status, save_generation)
   VALUES ($1, 'claude-sonnet-4-5-20250929', 'api', 0, 'test', false, 'none', $2, 'persisted', 1)`,
  [
    specSlug,
    JSON.stringify({
      workspaceId,
      contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context' },
      postSaveStages: {
        enrich: { requested: true, status: 'completed', reason: 'job_completed' },
        matchSkills: { requested: true, status: 'completed', reason: 'job_completed' },
      },
    }),
  ],);
}

async function seedRunnableSpec(slug: string, status: 'pending' | 'approved' = 'approved') {
  const spec = seedSpec(status, slug);
  await seedSpecReadinessLog(slug);
  return spec;
}

function createDeterministicSpecWorktree(specSlug: string): { branchName: string; worktreePath: string } {
  const branchName = `feat/${specSlug}`;
  const branchSlug = branchName.replace(/\//g, '-');
  const repoName = path.basename(wsDir);
  const worktreePath = path.resolve(wsDir, '..', `${repoName}-${branchSlug}`);
  execSync(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, { cwd: wsDir, stdio: 'pipe' });
  return { branchName, worktreePath };
}

function advanceWorkspaceMain(marker: string): void {
  fs.writeFileSync(path.join(wsDir, 'README.md'), `${marker}\n`, 'utf8');
  execSync('git add README.md', { cwd: wsDir, stdio: 'pipe' });
  execSync(`git commit -m "${marker}"`, { cwd: wsDir, stdio: 'pipe' });
}

/** Create a run-loop.sh stub that exits immediately */
function createRunLoopStub(exitCode = 0) {
  const scriptPath = path.join(wsDir, 'forge', 'run-loop.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash\nexit ${exitCode}\n`, { mode: 0o755 });
}

/** Seed a pipeline run directly in the DB */
async function seedRun(overrides: Partial<{ status: string; workspace_id: string; spec_path: string; pid: number | null }> = {}) {
  const result = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, pid)
     VALUES ($1, $2, $3, $4) RETURNING id`, [overrides.spec_path ?? 'forge/specs/approved/test-spec.json',
    overrides.workspace_id ?? 'ws-pipe',
    overrides.status ?? 'running',
    overrides.pid ?? null,]);
  return result!.id;
}

function cloneTaskManifestFixture(): Record<string, any> {
  const fixturePath = path.join(__dirname, '..', '..', 'lib', '__tests__', 'fixtures', 'hermes-task-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, any>;
  manifest.manifestId = crypto.randomUUID();
  manifest.idempotencyKey = crypto.randomUUID();
  manifest.workspaceId = 'ws-pipe';
  manifest.source.rorca.specPath = 'forge/specs/approved/source-spec.json';
  manifest.boundedScope.allowedPaths.push('forge/specs/approved/source-spec.json');
  manifest.execution.agentOverride = 'pi';
  manifest.execution.modelOverride = 'gpt-5.4';
  manifest.execution.terminalMode = 'ansi-html';
  return manifest;
}

function taskManifestTriggerBody(overrides: Record<string, any> = {}): Record<string, any> {
  const manifest = cloneTaskManifestFixture();
  return {
    workspaceId: 'ws-pipe',
    idempotencyKey: manifest.idempotencyKey,
    manifest,
    ...overrides,
  };
}

interface TaskManifestApproval {
  event: Record<string, unknown>;
  issuerConfig: string;
}

function signedTaskManifestApproval(
  manifest: Record<string, any>,
  actorId = PRIMARY_USER_ID,
): TaskManifestApproval {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const parsedManifest = safeParseTaskManifest(manifest);
  if (!parsedManifest.success) throw new Error('TaskManifest test fixture is invalid');
  const normalizedCommandHash = computeTaskManifestHash(parsedManifest.data);
  const commandIdentity = normalizedCommandHash.replace(/^sha256:/, '').slice(0, 16);
  const unsigned = {
    schemaVersion: 'provider-human-event.v1' as const,
    issuerId: 'hermes-pipeline-test',
    keyId: 'ed25519-test-1',
    provider: 'slack',
    providerTenantId: manifest.source.slack.teamId,
    actorId,
    conversationId: 'C-PIPELINE',
    threadId: 'THREAD-PIPELINE',
    messageId: `approval-${manifest.manifestId}-${commandIdentity}`,
    occurredAt: new Date().toISOString(),
    normalizedCommandHash,
    ingressIdempotencyKey: `ingress-${manifest.manifestId}-${commandIdentity}`,
  };
  return {
    event: {
      ...unsigned,
      signature: crypto.sign(null, Buffer.from(stableWalJson(unsigned), 'utf8'), privateKey).toString('base64url'),
    },
    issuerConfig: JSON.stringify([{
      issuerId: unsigned.issuerId,
      keyId: unsigned.keyId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      provider: unsigned.provider,
      providerTenantId: unsigned.providerTenantId,
      workspaceId: manifest.workspaceId,
    }]),
  };
}

const taskManifestApprovalCache = new Map<string, TaskManifestApproval>();

async function postApprovedTaskManifest(
  body: Record<string, any>,
  actorId = PRIMARY_USER_ID,
) {
  const parsedManifest = safeParseTaskManifest(body.manifest);
  if (!parsedManifest.success) throw new Error('TaskManifest test fixture is invalid');
  if (body.dryRun !== true && body.manifest.policy.dryRun !== true) {
    await seedSpecReadinessLog(`hermes-task-manifest-${body.manifest.manifestId}`);
  }
  const manifestHash = computeTaskManifestHash(parsedManifest.data);
  const cacheKey = `${actorId}:${manifestHash}`;
  let approval = taskManifestApprovalCache.get(cacheKey);
  if (!approval) {
    approval = signedTaskManifestApproval(body.manifest, actorId);
    taskManifestApprovalCache.set(cacheKey, approval);
  }
  const originalIssuerConfig = process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON;
  process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON = approval.issuerConfig;
  try {
    return await request(app)
      .post('/api/pipeline/task-manifests/trigger')
      .set('Authorization', `Bearer ${serviceAuthToken}`)
      .send({ ...body, humanApproval: approval.event });
  } finally {
    if (originalIssuerConfig === undefined) delete process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON;
    else process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON = originalIssuerConfig;
  }
}

function stablePipelineTriggerKey(scope: string, body: Record<string, unknown>): string {
  const digest = crypto.createHash('sha256')
    .update(scope)
    .update('\0')
    .update(JSON.stringify(body))
    .digest('hex');
  return `pipeline-test:${digest}`;
}

function postPipelineTrigger(
  body: Record<string, unknown>,
  scope: string,
  options: {
    authenticate?: boolean;
    endpoint?: '/api/pipeline/trigger' | '/api/pipeline/queue';
    idempotencyKey?: string;
  } = {},
) {
  const idempotencyKey = options.idempotencyKey ?? stablePipelineTriggerKey(scope, body);
  let pending = request(app)
    .post(options.endpoint ?? '/api/pipeline/trigger')
    .set('Idempotency-Key', idempotencyKey);
  if (options.authenticate !== false) {
    pending = pending.set('Authorization', `Bearer ${authToken}`);
  }
  return pending.send({ ...body, idempotencyKey });
}

function hasExecutionEnvironmentSupportInTest(): boolean {
  return [
    path.join(__dirname, '..', '..', 'lib', 'execution-environment.ts'),
    path.join(__dirname, '..', '..', 'lib', 'execution-environment.js'),
  ].some((candidate) => fs.existsSync(candidate));
}

async function expectReleaseOneManifestlessDenial(
  body: Record<string, unknown>,
  options: {
    endpoint?: '/api/pipeline/trigger' | '/api/pipeline/queue';
    code?: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED' | 'RELEASE_ONE_CAPABILITY_DISABLED';
  } = {},
) {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : 'ws-pipe';
  const before = await queryOne<{ total: number }>(
    'SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = $1',
    [workspaceId],
  );
  const pgBossMock = jest.requireMock('../../lib/pg-boss');
  const mockSend = pgBossMock.getBoss().send as jest.Mock;
  mockSend.mockClear();

  const response = await postPipelineTrigger(
    body,
    `release-one:${options.endpoint ?? '/api/pipeline/trigger'}:${options.code ?? 'default'}`,
    { endpoint: options.endpoint },
  );

  expect(response.status).toBe(422);
  expect(response.body.code).toMatch(/^RELEASE_ONE_/);
  if (options.code) expect(response.body.code).toBe(options.code);
  expect(response.body.details).toMatchObject({ profileId: 'release-1-supervised-core' });
  expect(response.body.runId).toBeUndefined();
  const after = await queryOne<{ total: number }>(
    'SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = $1',
    [workspaceId],
  );
  expect(after?.total).toBe(before?.total);
  expect(mockSend).not.toHaveBeenCalled();
  return response;
}

async function preflightBoundTrigger(
  specSlug: string,
  idempotencyKey: string,
  options: Record<string, unknown> = {},
) {
  const requestBody = {
    specPath: `forge/specs/approved/${specSlug}.json`,
    workspaceId: PIPE_WORKSPACE_ID,
    ...options,
  };
  const preflightRequestBody = { ...requestBody };
  delete (preflightRequestBody as Record<string, unknown>).rerunFromScratch;
  const preflight = await request(app)
    .post('/api/pipeline/preflight')
    .set('Authorization', `Bearer ${authToken}`)
    .send(preflightRequestBody);
  expect(preflight.status).toBe(200);
  expect(preflight.body.preview).toMatchObject({
    schemaVersion: 'rorca.execution-preview.v1',
    previewHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    specHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
  });
  return {
    preflight,
    trigger: () => request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        ...requestBody,
        idempotencyKey,
        previewHash: preflight.body.preview.previewHash,
        previewExpiresAt: preflight.body.preview.expiresAt,
      }),
  };
}

describe('POST /api/pipeline/preflight', () => {
  test('returns the canonical nested binding to an admin without creating dispatch or approval state', async () => {
    const slug = 'mcp-visible-preflight';
    seedSpec('approved', slug);
    const specPath = `forge/specs/approved/${slug}.json`;
    const specBytesBefore = fs.readFileSync(path.join(wsDir, specPath), 'utf8');
    const runCountBefore = await queryOne<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = $1',
      [PIPE_WORKSPACE_ID],
    );
    const jobCountBefore = await queryOne<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM spec_jobs WHERE workspace_id = $1',
      [PIPE_WORKSPACE_ID],
    );
    const publicationCountBefore = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM pipeline_dispatch_publications publication
         JOIN pipeline_runs run ON run.id = publication.run_id
        WHERE run.workspace_id = $1`,
      [PIPE_WORKSPACE_ID],
    );
    const mockSend = jest.requireMock('../../lib/pg-boss').getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/preflight')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath,
        workspaceId: PIPE_WORKSPACE_ID,
        queue: true,
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'branch-only',
        orchestrationMode: 'sequential',
        parallelism: 1,
        forceSequential: true,
        storyId: 'US-002',
        includeGraph: true,
        agentOverride: 'pi',
        modelOverride: 'anthropic/claude-sonnet-4-5',
        effortLevel: 'high',
        reasoning: { enabled: true, effort: 'high' },
        terminal_mode: 'ansi-html',
        executionEnvironment: 'remote-rorca',
      });

    expect(res.status).toBe(200);
    expect(res.body.preview).toMatchObject({
      schemaVersion: 'rorca.execution-preview.v1',
      previewHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      expiresAt: expect.any(String),
      workspaceId: PIPE_WORKSPACE_ID,
      spec: {
        kind: 'spec',
        id: slug,
      },
      specHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      effectiveOptions: {
        agent: 'pi',
        model: 'anthropic/claude-sonnet-4-5',
        effort: 'high',
        mode: 'sequential',
        parallelism: 1,
        storyIds: ['US-002'],
        worktree: { enabled: true },
        merge: { strategy: 'branch-only', autoMerge: false },
      },
      scheduling: 'queue',
    });
    expect(await queryOne<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = $1',
      [PIPE_WORKSPACE_ID],
    )).toEqual(runCountBefore);
    expect(await queryOne<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM spec_jobs WHERE workspace_id = $1',
      [PIPE_WORKSPACE_ID],
    )).toEqual(jobCountBefore);
    expect(await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM pipeline_dispatch_publications publication
         JOIN pipeline_runs run ON run.id = publication.run_id
        WHERE run.workspace_id = $1`,
      [PIPE_WORKSPACE_ID],
    )).toEqual(publicationCountBefore);
    expect(mockSend).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(wsDir, specPath), 'utf8')).toBe(specBytesBefore);
  });

  test('returns a preview to an authenticated non-admin workspace member', async () => {
    const slug = 'member-visible-preflight';
    seedSpec('approved', slug);
    await ownerExecute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES ($1, $2::uuid, 'member')
       ON CONFLICT (workspace_id, user_auth_id) DO UPDATE SET role = 'member'`,
      [PIPE_WORKSPACE_ID, SECONDARY_AUTH_ID],
    );

    try {
      const res = await request(app)
        .post('/api/pipeline/preflight')
        .set('Authorization', `Bearer ${secondaryAuthToken}`)
        .send({
          workspaceId: PIPE_WORKSPACE_ID,
          specPath: `forge/specs/approved/${slug}.json`,
          autoWorktree: true,
          autoMerge: false,
          mergeStrategy: 'branch-only',
        });

      expect(res.status).toBe(200);
      expect(res.body.preview).toMatchObject({
        workspaceId: PIPE_WORKSPACE_ID,
        spec: { id: slug },
        previewHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
    } finally {
      await ownerExecute(
        'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2::uuid',
        [PIPE_WORKSPACE_ID, SECONDARY_AUTH_ID],
      );
    }
  });

  test('rejects a non-member before probing the requested spec path', async () => {
    const res = await request(app)
      .post('/api/pipeline/preflight')
      .set('Authorization', `Bearer ${secondaryAuthToken}`)
      .send({
        workspaceId: PIPE_WORKSPACE_ID,
        specPath: 'forge/specs/approved/not-readable.json',
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'FORBIDDEN',
      error: expect.stringContaining('accessible workspace'),
    });
  });
});

// ─── POST /api/pipeline/trigger ──────────────────────────────────────────────

describe('POST /api/pipeline/trigger', () => {
  test('returns 422 when specPath is missing', async () => {
    const res = await postPipelineTrigger(
      { workspaceId: 'ws-pipe' },
      'missing-spec-path',
    );

    expect(res.status).toBe(422);
  });

  test('returns 422 when workspaceId is missing', async () => {
    const res = await postPipelineTrigger(
      { specPath: 'forge/specs/approved/test.json' },
      'missing-workspace-id',
    );

    expect(res.status).toBe(422);
  });

  test('returns 400 when Idempotency-Key is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/test.json',
        workspaceId: 'ws-pipe',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header/i);
  });

  test('returns 400 when Idempotency-Key is invalid', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', 'bad key')
      .send({
        specPath: 'forge/specs/approved/test.json',
        workspaceId: 'ws-pipe',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key header/i);
  });

  test('Release-1 rejects every disabled execution shape before run, Git, or queue mutation', async () => {
    const before = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = 'ws-pipe'`,
    );
    const base = {
      specPath: 'forge/specs/approved/not-read-before-release-gate.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    };
    const cases = [
      { body: { ...base, triggerType: 'scheduled' }, capabilityId: 'scheduled_autonomy' },
      { body: { ...base, orchestrationMode: 'wave-parallel', parallelism: 2 }, capabilityId: 'high_risk_parallel_autonomy' },
      { body: { ...base, autoMerge: true }, capabilityId: 'auto_merge' },
      { body: { ...base, autoWorktree: false }, capabilityId: 'protected_branch_direct_update' },
      { body: { ...base, mergeStrategy: 'direct' }, capabilityId: 'protected_branch_direct_update' },
      { body: { ...base, executionEnvironment: 'local-user' }, capabilityId: 'local_user_execution_bridge' },
    ];

    for (const entry of cases) {
      const res = await postPipelineTrigger(
        entry.body,
        `disabled-capability:${entry.capabilityId}`,
      );
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: 'RELEASE_ONE_CAPABILITY_DISABLED',
        details: {
          profileId: 'release-1-supervised-core',
          capabilityId: entry.capabilityId,
        },
      });
    }
    const manifestless = await postPipelineTrigger(base, 'disabled-capability:manifestless');
    expect(manifestless.status).toBe(422);
    expect(manifestless.body).toMatchObject({
      code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED',
      details: {
        profileId: 'release-1-supervised-core',
        capabilityId: 'bounded_task_manifest',
        endpoint: '/api/pipeline/task-manifests/trigger',
      },
    });

    const after = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = 'ws-pipe'`,
    );
    expect(after?.total).toBe(before?.total);
  });

  test('returns 404 for nonexistent workspace during a Release-1 dry-run preview', async () => {
    const res = await postPipelineTrigger(
      {
        specPath: 'forge/specs/approved/test.json',
        workspaceId: 'nonexistent',
        dryRun: true,
      },
      'nonexistent-workspace-dry-run',
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Workspace not found');
  });

  test('Release-1 denies manifestless execution before blocked-spec readiness inspection', async () => {
    seedSpec('approved', 'blocked-readiness');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/blocked-readiness.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
  });

  test('readinessOverride is rejected before any Release-1 pipeline side effect', async () => {
    seedSpec('approved', 'blocked-override');
    const before = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = 'ws-pipe'`,
    );
    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const response = await postPipelineTrigger(
      {
        specPath: 'forge/specs/approved/blocked-override.json',
        workspaceId: 'ws-pipe',
        autoWorktree: true,
        mergeStrategy: 'draft-pr',
        readinessOverride: true,
      },
      'readiness-override',
    );

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'REQUEST_SCHEMA_INVALID',
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'unrecognized_keys', keys: ['readinessOverride'] }),
        ]),
      },
    });
    const after = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = 'ws-pipe'`,
    );
    expect(after?.total).toBe(before?.total);
    expect(await queryOne(
      `SELECT id FROM wal_events WHERE event_type = 'spec_readiness_override_used' AND spec_id = 'blocked-override'`,
    )).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('Release-1 denial occurs before run-loop fallback selection', async () => {
    await seedRunnableSpec('ts-fallback');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/ts-fallback.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
  });

  test('ordinary trigger defaults create an isolated local-only sequential run', async () => {
    await seedRunnableSpec('safe-local-default');
    const binding = await preflightBoundTrigger(
      'safe-local-default',
      'mission-trigger:ws-pipe:safe-local-default',
    );
    const res = await binding.trigger();

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      queued: true,
      specId: 'safe-local-default',
      receipt: {
        schemaVersion: 'rorca.execution-receipt.v1',
        workspaceId: PIPE_WORKSPACE_ID,
        scheduling: 'run',
        idempotencyKey: 'mission-trigger:ws-pipe:safe-local-default',
        returnedEntity: { kind: 'run' },
      },
      terminal_mode: 'ansi-html',
      effectiveOptions: {
        worktree: { enabled: true },
        merge: { strategy: 'branch-only', autoMerge: false },
        terminal: 'ansi-html',
        safety: { deploy: false, externalSend: false },
      },
    });
    expect(res.body.runId).toEqual(expect.any(Number));
    expect(res.body.worktreePath).toEqual(expect.any(String));
    const row = await queryOne<{
      auto_worktree: boolean; auto_merge: boolean; merge_strategy: string; terminal_mode: string;
    }>('SELECT auto_worktree, auto_merge, merge_strategy, terminal_mode FROM pipeline_runs WHERE id = $1', [res.body.runId]);
    expect(row).toEqual({
      auto_worktree: true,
      auto_merge: false,
      merge_strategy: 'branch-only',
      terminal_mode: 'ansi-html',
    });

    expect(res.body.receipt.returnedEntity.id).toBe(String(res.body.runId));
    expect(res.body.receipt.spec).toMatchObject({
      kind: 'spec',
      id: 'safe-local-default',
      revision: { kind: 'spec_version' },
    });
    expect(res.body.receipt.specHash).toBe(binding.preflight.body.preview.specHash);
    expect(res.body.receipt.previewHash).toBe(binding.preflight.body.preview.previewHash);
    expect(res.body.receipt.effectiveOptions).toEqual(binding.preflight.body.preview.effectiveOptions);
  });

  test('ExecutionReceiptV1 preflight hash is stable for an unchanged revision and effective options', async () => {
    await seedRunnableSpec('receipt-stable-preview');
    const first = await preflightBoundTrigger(
      'receipt-stable-preview',
      'mission-trigger:ws-pipe:receipt-stable-preview:first',
      { queue: true, storyId: 'US-001' },
    );
    const second = await preflightBoundTrigger(
      'receipt-stable-preview',
      'mission-trigger:ws-pipe:receipt-stable-preview:second',
      { queue: true, storyId: 'US-001' },
    );
    expect(second.preflight.body.preview).toEqual(first.preflight.body.preview);
  });

  test('ExecutionReceiptV1 same-key replay returns the identical receipt without a duplicate immediate run', async () => {
    await seedRunnableSpec('receipt-replay');
    const key = 'mission-trigger:ws-pipe:receipt-replay';
    const binding = await preflightBoundTrigger('receipt-replay', key);
    const first = await binding.trigger();
    const replay = await binding.trigger();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.receipt).toEqual(first.body.receipt);
    expect(replay.body.runId).toBe(first.body.runId);
    const count = await queryOne<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2',
      [PIPE_WORKSPACE_ID, key],
    );
    expect(count?.count).toBe(1);
  });

  test('ExecutionReceiptV1 rejects same-key reuse with a different effective story scope', async () => {
    await seedRunnableSpec('receipt-key-conflict');
    const key = 'mission-trigger:ws-pipe:receipt-key-conflict';
    const firstBinding = await preflightBoundTrigger('receipt-key-conflict', key, { queue: true });
    const first = await firstBinding.trigger();
    expect(first.status).toBe(202);

    const changedBinding = await preflightBoundTrigger('receipt-key-conflict', key, {
      queue: true,
      storyId: 'US-002',
    });
    const conflict = await changedBinding.trigger();
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/idempotency key was reused/i);
    const count = await queryOne<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2',
      [PIPE_WORKSPACE_ID, key],
    );
    expect(count?.count).toBe(1);
  });

  test('ExecutionReceiptV1 rejects a stale spec-bound preview before creating a run', async () => {
    const slug = 'receipt-stale-preview';
    const spec = await seedRunnableSpec(slug);
    const key = 'mission-trigger:ws-pipe:receipt-stale-preview';
    const binding = await preflightBoundTrigger(slug, key, { queue: true });
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
      JSON.stringify({ ...spec, specName: 'Mutated after preview' }, null, 2),
      'utf8',
    );

    const stale = await binding.trigger();
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/preview no longer matches/i);
    const count = await queryOne<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2',
      [PIPE_WORKSPACE_ID, key],
    );
    expect(count?.count).toBe(0);
  });

  test('ExecutionReceiptV1 queued dispatch returns the exact queued run identity, revision, and options', async () => {
    await seedRunnableSpec('receipt-queued');
    const key = 'mission-trigger:ws-pipe:receipt-queued';
    const binding = await preflightBoundTrigger('receipt-queued', key, {
      queue: true,
      storyId: 'US-002',
      effortLevel: 'high',
    });
    const queued = await binding.trigger();

    expect(queued.status).toBe(202);
    expect(queued.body.receipt).toMatchObject({
      schemaVersion: 'rorca.execution-receipt.v1',
      workspaceId: PIPE_WORKSPACE_ID,
      scheduling: 'queue',
      previewHash: binding.preflight.body.preview.previewHash,
      idempotencyKey: key,
      returnedEntity: {
        kind: 'run',
        id: String(queued.body.runId),
        label: `Queued run #${queued.body.runId}`,
      },
      effectiveOptions: {
        effort: 'high',
        storyIds: ['US-002'],
        mode: 'sequential',
        parallelism: 1,
        worktree: { enabled: true },
        merge: { strategy: 'branch-only', autoMerge: false },
      },
    });
    expect(queued.body.receipt.spec).toEqual(binding.preflight.body.preview.spec);
    expect(queued.body.receipt.specHash).toBe(binding.preflight.body.preview.specHash);
    const replay = await binding.trigger();
    expect(replay.status).toBe(200);
    expect(replay.body.runId).toBe(queued.body.runId);
    expect(replay.body.receipt).toEqual(queued.body.receipt);
  });


  test('explicit story continuation preserves its frozen scope despite unrelated ambiguous pass evidence', async () => {
    const slug = 'explicit-story-ambiguous-global';
    const spec = await seedRunnableSpec(slug);
    spec.userStories[0].passes = true;
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
      JSON.stringify(spec, null, 2),
      'utf8',
    );

    const binding = await preflightBoundTrigger(
      slug,
      'pipeline-test:explicit-story-ambiguous-global',
      { storyId: 'US-002' },
    );
    const res = await binding.trigger();

    expect(res.status).toBe(201);
    expect(res.body.passReconciliation).toMatchObject({
      blocking: true,
      stories: expect.arrayContaining([
        expect.objectContaining({ storyId: 'US-001', status: 'ambiguous' }),
      ]),
    });
    const run = await queryOne<{ expected_story_ids: string[] }>(
      'SELECT expected_story_ids FROM pipeline_runs WHERE id = $1',
      [res.body.runId],
    );
    expect(run?.expected_story_ids).toEqual(['US-002']);

    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    expect(pgBossMock.getBoss().send).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({
        specificStory: 'US-002',
        worktreePath: expect.any(String),
      }),
      expect.any(Object),
    );
    const storedSpec = JSON.parse(fs.readFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
      'utf8',
    ));
    expect(storedSpec.userStories.map((story: { passes: boolean }) => story.passes)).toEqual([true, false]);
  });

  test('automatic full scope remains blocked by ambiguous approved-spec pass evidence', async () => {
    const slug = 'automatic-ambiguous-global';
    const spec = await seedRunnableSpec(slug);
    spec.userStories[0].passes = true;
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
      JSON.stringify(spec, null, 2),
      'utf8',
    );

    const binding = await preflightBoundTrigger(
      slug,
      'pipeline-test:automatic-ambiguous-global',
    );
    const res = await binding.trigger();

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'PASS_RECONCILIATION_REQUIRED',
      details: { reconciliation: { blocking: true } },
    });
    expect(await queryOne(
      'SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND spec_path = $2',
      ['ws-pipe', `forge/specs/approved/${slug}.json`],
    )).toBeUndefined();
  });

  test('rejects a nonexistent or excluded explicit story before any run is created', async () => {
    const missingSlug = 'explicit-story-not-found';
    await seedRunnableSpec(missingSlug);
    const missingBinding = await preflightBoundTrigger(
      missingSlug,
      'pipeline-test:explicit-story-not-found',
      { storyId: 'US-404' },
    );
    const missing = await missingBinding.trigger();
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'VALIDATION_ERROR', details: { storyId: 'US-404' } });

    const excludedSlug = 'explicit-story-excluded';
    const excludedSpec = await seedRunnableSpec(excludedSlug);
    (excludedSpec.userStories[1] as { excluded?: boolean }).excluded = true;
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', `${excludedSlug}.json`),
      JSON.stringify(excludedSpec, null, 2),
      'utf8',
    );
    const excludedBinding = await preflightBoundTrigger(
      excludedSlug,
      'pipeline-test:explicit-story-excluded',
      { storyId: 'US-002' },
    );
    const excluded = await excludedBinding.trigger();
    expect(excluded.status).toBe(400);
    expect(excluded.body).toMatchObject({ code: 'VALIDATION_ERROR', details: { storyId: 'US-002' } });

    expect(await queryOne(
      'SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND spec_path IN ($2, $3)',
      ['ws-pipe', `forge/specs/approved/${missingSlug}.json`, `forge/specs/approved/${excludedSlug}.json`],
    )).toBeUndefined();
  });

  test('explicit clean-slate request retains existing reset semantics rather than continuation semantics', async () => {
    const slug = 'explicit-clean-slate-full-run';
    const spec = await seedRunnableSpec(slug);
    spec.userStories[0].passes = true;
    spec.userStories[1].passes = true;
    const specPath = path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    const binding = await preflightBoundTrigger(
      slug,
      'pipeline-test:explicit-clean-slate-full-run',
      { storyId: 'US-002', rerunFromScratch: true },
    );
    const res = await binding.trigger();

    expect(res.status).toBe(201);
    const run = await queryOne<{ expected_story_ids: string[]; run_spec_path: string }>(
      'SELECT expected_story_ids, run_spec_path FROM pipeline_runs WHERE id = $1',
      [res.body.runId],
    );
    expect(run?.expected_story_ids).toEqual(['US-002']);
    expect(res.body.passReconciliation).toMatchObject({ blocking: true });
    const canonicalSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    expect(canonicalSpec.userStories.map((story: { passes: boolean }) => story.passes)).toEqual([true, true]);
    const runOwnedSpec = JSON.parse(fs.readFileSync(run!.run_spec_path, 'utf8'));
    expect(runOwnedSpec.userStories.map((story: { passes: boolean }) => story.passes)).toEqual([true, false]);
  });

  test('ordinary macOS Pi branch-only preflight uses the explicit local profile and freezes no-send authority', async () => {
    await seedRunnableSpec('safe-local-pi');
    const fakePi = path.join(tmpDir, 'explicit-pi');
    fs.writeFileSync(fakePi, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const piDetector = require('../../lib/pi-detector') as typeof import('../../lib/pi-detector');
    const localProfile = require('../../lib/ordinary-local-pi-profile') as typeof import('../../lib/ordinary-local-pi-profile');
    const profileSpy = jest.spyOn(localProfile, 'resolveRorcaExecutionSandboxProfile').mockReturnValue({
      mode: 'darwin-local-pi',
      piBinPath: fakePi,
      piRealPath: fs.realpathSync(fakePi),
      posture: 'ordinary-local-branch',
    });
    const inspectionSpy = jest.spyOn(piDetector, 'inspectPi').mockReturnValue({
      status: { piInstalled: true, piVersion: '0.80.6', piBinPath: fakePi },
    });
    const catalogSpy = jest.spyOn(piDetector, 'listPiModels').mockReturnValue([{
      provider: 'openai-codex', model: 'gpt-5.4', contextTokens: 272000,
      maxOutTokens: 128000, thinking: true, images: true,
    }]);

    try {
      const binding = await preflightBoundTrigger(
        'safe-local-pi',
        'pipeline-test:safe-local-pi',
        {
          agentOverride: 'pi',
          modelOverride: 'openai-codex/gpt-5.4',
          autoWorktree: true,
          autoMerge: false,
          mergeStrategy: 'branch-only',
          terminal_mode: 'ansi-html',
          forceSequential: true,
        },
      );
      const res = await binding.trigger();

      expect(res.status).toBe(201);
      expect(res.body.effectiveOptions).toMatchObject({
        runtime: {
          piExecutable: {
            piBinPath: fakePi,
            piRealPath: fs.realpathSync(fakePi),
          },
        },
        safety: {
          deploy: false,
          externalSend: false,
          ordinaryLocalPi: true,
        },
      });
      expect(profileSpy).toHaveBeenCalledWith(expect.objectContaining({
        agent: 'pi',
        allRequiredAgentsOrdinaryLocal: true,
        allRequiredAgentsOmp: false,
        allStoriesSelected: true,
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'branch-only',
        deploy: false,
        externalSend: false,
        parallelism: 1,
        orchestrationMode: 'sequential',
        terminalMode: 'ansi-html',
        readinessOverride: false,
      }));
      expect(inspectionSpy).toHaveBeenCalledWith({ sandboxMode: 'darwin-local-pi', piBinPath: fakePi });
      expect(catalogSpy).toHaveBeenCalledWith(fakePi, { sandboxMode: 'darwin-local-pi' });
    } finally {
      profileSpy.mockRestore();
      inspectionSpy.mockRestore();
      catalogSpy.mockRestore();
    }
  });

  test('unsafe local Pi shapes return the typed Linux-bwrap requirement before any run mutation', async () => {
    await seedRunnableSpec('unsafe-local-pi');
    const localProfile = require('../../lib/ordinary-local-pi-profile') as typeof import('../../lib/ordinary-local-pi-profile');
    const profileSpy = jest.spyOn(localProfile, 'resolveRorcaExecutionSandboxProfile').mockImplementation(() => {
      throw new localProfile.RorcaExecutionSandboxError(
        'linux_bwrap_required_for_requested_mode',
        'linux_bwrap_required_for_requested_mode: branch-only is required',
      );
    });
    const before = await queryOne<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = $1', ['ws-pipe'],
    );

    try {
      const res = await postPipelineTrigger(
        {
          specPath: 'forge/specs/approved/unsafe-local-pi.json',
          workspaceId: 'ws-pipe',
          agentOverride: 'pi',
          autoWorktree: true,
          autoMerge: false,
          mergeStrategy: 'branch-only',
          terminal_mode: 'ansi-html',
          forceSequential: true,
        },
        'unsafe-local-pi',
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('pi_preflight:linux_bwrap_required_for_requested_mode');
      expect(res.body.error).not.toContain('pi_not_installed');
      const after = await queryOne<{ total: number }>(
        'SELECT COUNT(*)::int AS total FROM pipeline_runs WHERE workspace_id = $1', ['ws-pipe'],
      );
      expect(after?.total).toBe(before?.total);
    } finally {
      profileSpy.mockRestore();
    }
  });

  test('sequential defaults do not grant manifestless publication authority', async () => {
    await seedRunnableSpec('safe-sequential-default');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/safe-sequential-default.json',
      workspaceId: 'ws-pipe',
      orchestrationMode: 'sequential',
      parallelism: 1,
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    }, { code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED' });
  });

  test('Release-1 rejects explicit wave-parallel execution before experimental policy evaluation', async () => {
    await seedRunnableSpec('parallel-refused');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/parallel-refused.json',
      workspaceId: 'ws-pipe',
      orchestrationMode: 'wave-parallel',
      parallelism: 2,
    }, { code: 'RELEASE_ONE_CAPABILITY_DISABLED' });
  });

  test('the experimental wave flag cannot bypass Release-1 capability policy', async () => {
    process.env.RORCA_EXPERIMENTAL_WAVE_PARALLEL = 'true';
    await seedRunnableSpec('parallel-experiment');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/parallel-experiment.json',
      workspaceId: 'ws-pipe',
      orchestrationMode: 'wave-parallel',
      parallelism: 2,
    }, { code: 'RELEASE_ONE_CAPABILITY_DISABLED' });
  });

  test('production auth mode refuses test-only bearer credentials before wave mutation', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RORCA_EXPERIMENTAL_WAVE_PARALLEL = 'true';
    await seedRunnableSpec('parallel-production-refused');
    const res = await postPipelineTrigger(
      {
        specPath: 'forge/specs/approved/parallel-production-refused.json',
        workspaceId: 'ws-pipe',
        orchestrationMode: 'wave-parallel',
        parallelism: 2,
      },
      'parallel-production-refused',
    );

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized', code: 'AUTH_ERROR' });
    expect(await queryOne('SELECT id FROM pipeline_runs WHERE spec_path = $1', ['forge/specs/approved/parallel-production-refused.json'])).toBeUndefined();
  });

  test('Release-1 denies manifestless execution before active-run conflict inspection', async () => {
    await seedRunnableSpec('test-spec');
    await seedRun({ status: 'running', spec_path: 'forge/specs/approved/test-spec.json' });
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/test-spec.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
  });

  test('Release-1 denial precedes reusable-worktree Git inspection or queueing', async () => {
    await seedRunnableSpec('stale-worktree-trigger');
    const { worktreePath } = createDeterministicSpecWorktree('stale-worktree-trigger');
    advanceWorkspaceMain('advance-main-after-worktree');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/stale-worktree-trigger.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    }, { code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED' });
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  test('Release-1 denial precedes reusable-branch inspection or recreation', async () => {
    await seedRunnableSpec('stale-branch-trigger');
    const { worktreePath } = createDeterministicSpecWorktree('stale-branch-trigger');
    execSync(`git worktree remove --force "${worktreePath}"`, { cwd: wsDir, stdio: 'pipe' });
    advanceWorkspaceMain('advance-main-after-worktree-removal');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/stale-branch-trigger.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    }, { code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED' });
    expect(execSync('git branch --list feat/stale-branch-trigger', { cwd: wsDir, encoding: 'utf8' })).toContain('feat/stale-branch-trigger');
  });

  test('manifestless trigger cannot spawn run-loop.sh or allocate a runId', async () => {
    createRunLoopStub();
    await seedRunnableSpec('trigger-spec');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/trigger-spec.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
  });

  test('manifestless trigger emits no run lifecycle WAL evidence', async () => {
    createRunLoopStub();
    await seedRunnableSpec('wal-trigger');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/wal-trigger.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
    expect(await query(
      `SELECT id FROM wal_events WHERE workspace_id = 'ws-pipe' AND event_type IN ('run_started', 'run_finished')`,
    )).toHaveLength(0);
  });

  test('dry-run returns cost estimate without spawning process', async () => {
    seedSpec('approved', 'dry-run-spec');

    const res = await postPipelineTrigger(
      {
        specPath: 'forge/specs/approved/dry-run-spec.json',
        workspaceId: 'ws-pipe',
        dryRun: true,
      },
      'dry-run-spec',
    );

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.estimate).toBeDefined();

    // No pipeline run should be created for the dry-run request. Canonical runs
    // from earlier tests remain append-only and are intentionally retained.
    const runs = await query(
      `SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pipe' AND spec_path = $1`,
      ['forge/specs/approved/dry-run-spec.json'],
    );
    expect(runs).toHaveLength(0);
  });

  test('dry-run returns 422 when spec file does not exist', async () => {
    const res = await postPipelineTrigger(
      {
        specPath: 'forge/specs/approved/nonexistent.json',
        workspaceId: 'ws-pipe',
        dryRun: true,
      },
      'dry-run-nonexistent',
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Spec file not found');
  });

  test('manifestless denial records no excluded-story execution evidence', async () => {
    const spec = seedSpec('approved', 'excl-trigger') as any;
    spec.userStories[1].excluded = true;
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', 'excl-trigger.json'),
      JSON.stringify(spec, null, 2),
      'utf8',
    );
    await seedSpecReadinessLog('excl-trigger');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/excl-trigger.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
    expect(await queryOne(
      `SELECT id FROM wal_events WHERE workspace_id = 'ws-pipe' AND story_id = 'US-002'`,
    )).toBeUndefined();
  });

  test('unauthenticated request is handled (auth bypass active in local mode)', async () => {
    // In local single-user mode (AUTH_REQUIRED not set), auth is intentionally bypassed.
    // The synthetic local-admin user is injected. Request proceeds past auth middleware.
    const res = await postPipelineTrigger(
      { specPath: 'test.json', workspaceId: 'ws-pipe' },
      'unauthenticated-local-mode',
      { authenticate: false },
    );

    // Auth bypass: in local mode the request proceeds past auth middleware.
    // May get 201 (trigger succeeds), 422 (validation), or 404 (workspace).
    expect([200, 201, 400, 404, 422]).toContain(res.status);
  });

  test('RE-007: spec reasoning defaults cannot bypass TaskManifest authority', async () => {
    const spec = seedSpec('approved', 'reasoning-spec') as any;
    spec.model = 'claude-sonnet-4-5-20250929';
    spec.reasoning = { enabled: true, effort: 'high' };
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', 'reasoning-spec.json'),
      JSON.stringify(spec, null, 2),
      'utf8',
    );
    await seedSpecReadinessLog('reasoning-spec');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/reasoning-spec.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
  });

  test('RE-007: explicit reasoning overrides cannot bypass TaskManifest authority', async () => {
    const spec = seedSpec('approved', 'reasoning-override-spec') as any;
    spec.model = 'claude-sonnet-4-5-20250929';
    spec.reasoning = { enabled: true, effort: 'low' };
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', 'reasoning-override-spec.json'),
      JSON.stringify(spec, null, 2),
      'utf8',
    );
    await seedSpecReadinessLog('reasoning-override-spec');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/reasoning-override-spec.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      thinkingEnabled: false,
      reasoningEffort: 'medium',
    });
  });
});

// ─── GET /api/pipeline/runs (list) ──────────────────────────────────────────

describe('GET /api/pipeline/runs', () => {
  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('workspaceId');
  });

  test('returns empty list for workspace with no runs', async () => {
    const res = await request(app)
      .get(`/api/pipeline/runs?workspaceId=${LIST_WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test('returns runs for a given workspace, newest first', async () => {
    const runId1 = await seedRun({ workspace_id: LIST_WORKSPACE_ID, status: 'done' });
    const runId2 = await seedRun({ workspace_id: LIST_WORKSPACE_ID, status: 'running' });

    const res = await request(app)
      .get(`/api/pipeline/runs?workspaceId=${LIST_WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Newest first (DESC by id)
    expect(res.body.items[0].id).toBe(runId2);
    expect(res.body.items[1].id).toBe(runId1);
  });

  test('returns the canonical cursor page shape documented by OpenAPI', async () => {
    const runId1 = await seedRun({ workspace_id: LIST_WORKSPACE_ID, status: 'done' });
    const runId2 = await seedRun({ workspace_id: LIST_WORKSPACE_ID, status: 'done' });
    const runId3 = await seedRun({ workspace_id: LIST_WORKSPACE_ID, status: 'running' });

    const firstPage = await request(app)
      .get('/api/pipeline/runs')
      .query({ workspaceId: LIST_WORKSPACE_ID, limit: 2 })
      .set('Authorization', `Bearer ${authToken}`);

    expect(firstPage.status).toBe(200);
    expect(Object.keys(firstPage.body).sort()).toEqual(['cursor', 'hasMore', 'items', 'total']);
    expect(firstPage.body).toMatchObject({
      total: 3,
      hasMore: true,
    });
    expect(firstPage.body.items.map((run: { id: number }) => run.id)).toEqual([runId3, runId2]);
    expect(typeof firstPage.body.cursor).toBe('string');

    const secondPage = await request(app)
      .get('/api/pipeline/runs')
      .query({ workspaceId: LIST_WORKSPACE_ID, limit: 2, cursor: firstPage.body.cursor })
      .set('Authorization', `Bearer ${authToken}`);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body).toMatchObject({
      total: 3,
      hasMore: false,
    });
    expect(secondPage.body.items.map((run: { id: number }) => run.id)).toEqual([runId1]);

    const docs = await request(app)
      .get('/api/docs/openapi.json')
      .set('Authorization', `Bearer ${authToken}`);
    expect(docs.status).toBe(200);
    const documentedProperties = docs.body.paths['/api/pipeline/runs'].get
      .responses['200'].content['application/json'].schema.properties;
    expect(Object.keys(documentedProperties).sort()).toEqual(['cursor', 'hasMore', 'items', 'total']);
    expect(documentedProperties.items.items.$ref).toBe('#/components/schemas/PipelineRun');
    expect(documentedProperties.hasMore.type).toBe('boolean');
    expect(documentedProperties.cursor.type).toBe('string');
    expect(documentedProperties.runs).toBeUndefined();
  });

  test('does not return runs from other workspaces', async () => {
    await ownerExecute(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, 'Pipeline Other Workspace', $2)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
      [PIPE_OTHER_WORKSPACE_ID, wsDir],
    );
    await seedRun({ workspace_id: LIST_WORKSPACE_ID });
    const otherRunId = await seedRun({ workspace_id: PIPE_OTHER_WORKSPACE_ID });
    expect(await queryOne(
      'SELECT id FROM pipeline_runs WHERE id = $1 AND workspace_id = $2',
      [otherRunId, PIPE_WORKSPACE_ID],
    )).toBeUndefined();

    const res = await request(app)
      .get(`/api/pipeline/runs?workspaceId=${LIST_WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].workspace_id).toBe(LIST_WORKSPACE_ID);
  });

  test('unauthenticated request is handled (auth bypass active in local mode)', async () => {
    // Auth is bypassed in local mode — returns 200 (list) not 401
    const res = await request(app).get(`/api/pipeline/runs?workspaceId=${LIST_WORKSPACE_ID}`);
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/pipeline/runs/:runId (detail) ─────────────────────────────────

describe('GET /api/pipeline/runs/:runId', () => {
  test('returns run details with story results', async () => {
    const runId = await seedRun({ status: 'done' });

    // Add story results
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, 'US-001', 'pass', NOW())`, [runId]);
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, 'US-002', 'fail', NOW())`, [runId]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.run).toBeDefined();
    expect(res.body.run.id).toBe(runId);
    expect(res.body.run.status).toBe('done');
    expect(res.body.stories).toHaveLength(2);
    expect(res.body.stories[0].story_id).toBe('US-001');
    expect(res.body.stories[0].status).toBe('pass');
    expect(res.body.stories[1].story_id).toBe('US-002');
    expect(res.body.stories[1].status).toBe('fail');
  });

  test('returns actual story context files from WAL even when no context preview exists', async () => {
    const runId = await seedRun({ status: 'done' });

    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens, finished_at)
     VALUES ($1, 'US-001', 'pass', 1200, 300, NOW())`,
    [runId]);
    await ownerExecute(`INSERT INTO wal_events (workspace_id, spec_id, story_id, event_type, actor, payload)
     VALUES ('ws-pipe', 'test-spec', 'US-001', 'story_started', 'ralph', $1::jsonb)`,
    [JSON.stringify({ run_id: runId, story_id: 'US-001', context_files: ['AGENTS.md', 'src/App.tsx'] })]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.run.context_preview).toBeNull();
    expect(res.body.contextComparison).toEqual({
      predicted: {},
      actual: {
        'US-001': { contextFiles: ['AGENTS.md', 'src/App.tsx'] },
      },
    });
  });

  test('returns 404 for nonexistent run', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/99999')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
  });

  test('returns 400 for invalid runId', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/abc')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid runId');
  });

  test('rejects every non-canonical run ID class without aliasing an existing run', async () => {
    const runId = await seedRun({ status: 'done' });
    const malformedIds = [
      `${runId}abc`,
      ` ${runId} `,
      `+${runId}`,
      `-${runId}`,
      `${runId}.0`,
      `0${runId}`,
      '0',
      '9007199254740992',
      '1e309',
      '9'.repeat(400),
    ];

    for (const malformedId of malformedIds) {
      const res = await request(app)
        .get(`/api/pipeline/runs/${encodeURIComponent(malformedId)}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid runId');
    }
  });

  test('returns empty stories array when run has no story results', async () => {
    const runId = await seedRun();

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.stories).toEqual([]);
  });

  test('unauthenticated request is handled (auth bypass active in local mode)', async () => {
    const runId = await seedRun();
    const res = await request(app).get(`/api/pipeline/runs/${runId}`);
    // Auth is bypassed in local mode — returns 200 not 401
    expect(res.status).toBe(200);
  });
});

// ─── US-009: GET /api/pipeline/runs/:runId/findings ─────────────────────────

describe('GET /api/pipeline/runs/:runId/findings', () => {
  test('returns findings persisted with the run as capture candidates', async () => {
    const runId = await seedRun({ status: 'done' });
    await ownerExecute(
      `INSERT INTO run_findings (run_id, workspace_id, finding_key, kind, title, detail, evidence)
       VALUES ($1, 'ws-pipe', 'deviation:story:US-001', 'deviation', 'Story US-001 deviated from spec (fail)', 'detail', '[]'::jsonb)`,
      [runId],
    );

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/findings`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe('rorca.run-findings.v1');
    expect(res.body.runId).toBe(Number(runId));
    expect(res.body.workspaceId).toBe('ws-pipe');
    expect(res.body.findings).toHaveLength(1);
    expect(res.body.findings[0]).toMatchObject({
      findingKey: 'deviation:story:US-001',
      kind: 'deviation',
      status: 'capture_candidate',
    });
    // Findings are capture candidates only — the read surface must not promote.
    expect(res.body.findings[0].capturedAt).toBeNull();
  });

  test('returns an empty findings array when the run has none', async () => {
    const runId = await seedRun({ status: 'done' });
    const res = await request(app).get(`/api/pipeline/runs/${runId}/findings`);
    expect(res.status).toBe(200);
    expect(res.body.findings).toEqual([]);
  });

  test('rejects a mismatched workspace as not found', async () => {
    const runId = await seedRun({ status: 'done' });
    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/findings?workspaceId=ws-other`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
  });

  test('returns 404 for a nonexistent run and 400 for an invalid runId', async () => {
    const res = await request(app).get('/api/pipeline/runs/99999/findings');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');

    const bad = await request(app).get('/api/pipeline/runs/abc/findings');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Invalid runId');
  });
});

// ─── GET /api/pipeline/runs/:runId/skills ───────────────────────────────────

describe('GET /api/pipeline/runs/:runId/skills', () => {
  test('shows matched spec skills for in-flight runs before story_results exist', async () => {
    const specPath = path.join(wsDir, 'forge', 'specs', 'approved', 'skills-run.json');
    fs.writeFileSync(specPath, JSON.stringify({
      title: 'Skills Run',
      userStories: [
        {
          id: 'US-001',
          title: 'Build API',
          description: 'Desc',
          acceptanceCriteria: ['AC1'],
          suggestedSkills: [
            { name: 'api-documentation', relevance: 9, reason: 'New API endpoint' },
            { name: 'data-validation', relevance: 7, reason: 'Route validation' },
          ],
        },
        {
          id: 'US-002',
          title: 'Build UI',
          description: 'Desc',
          acceptanceCriteria: ['AC1'],
          suggestedSkills: [
            { name: 'react-review', relevance: 8, reason: 'React UI work' },
          ],
        },
      ],
    }), 'utf8');

    const runId = await seedRun({ status: 'running', spec_path: 'forge/specs/approved/skills-run.json' });

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/skills`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.perStory).toHaveLength(2);
    expect(res.body.perStory[0]).toMatchObject({ storyId: 'US-001', storyStatus: 'pending' });
    expect(res.body.perStory[0].skills.map((skill: any) => skill.name)).toEqual(['api-documentation', 'data-validation']);
    expect(res.body.summary.totalSkillInjections).toBe(3);
    expect(res.body.summary.storiesWithSkills).toBe(2);
  });
});

// ─── POST /api/pipeline/runs/:runId/pause ───────────────────────────────────

describe('POST /api/pipeline/runs/:runId/pause', () => {
  test('returns 404 for nonexistent run', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/99999/pause')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
  });

  test('returns 409 when run is not in running state', async () => {
    const runId = await seedRun({ status: 'done' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/pause`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot pause run with status 'done'");
  });

  test('returns 409 when process is not alive (no pid)', async () => {
    const runId = await seedRun({ status: 'running', pid: null });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/pause`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Process is not alive');
  });

  test('returns 400 for invalid runId', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/abc/pause')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid runId');
  });
});

// ─── POST /api/pipeline/runs/:runId/resume ──────────────────────────────────

describe('POST /api/pipeline/runs/:runId/resume', () => {
  test('returns 404 for nonexistent run', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/99999/resume')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
  });

  test('returns 409 when run is not in paused state', async () => {
    const runId = await seedRun({ status: 'running' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/resume`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot resume run with status 'running'");
  });

  test('returns 409 when process is not alive (no pid)', async () => {
    const runId = await seedRun({ status: 'paused', pid: null });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/resume`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Process is not alive');
  });
});

// ─── POST /api/pipeline/runs (create run record) ───────────────────────────

describe('POST /api/pipeline/runs', () => {
  test('returns 400 when specPath is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'test.json' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  test('creates run and returns 201 with run object', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/test.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);
    expect(res.body.run).toBeDefined();
    expect(res.body.run.spec_path).toBe('forge/specs/approved/test.json');
    expect(res.body.run.workspace_id).toBe('ws-pipe');
    expect(res.body.run.status).toBe('running');
    expect(res.body.run.agentType).toBe('unknown');
    expect(res.body.agentType).toBe('unknown');
    expect(res.body.lifecyclePhase).toBe('running');
    expect(res.body.run.id).toBeDefined();
  });

  test('emits run_started WAL event', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/test.json', workspaceId: 'ws-pipe' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'run_started'`) as any;

    expect(event).toBeDefined();
    expect(event.workspace_id).toBe('ws-pipe');
    // PostgreSQL JSONB columns are returned as JS objects by the pg driver, not strings
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    expect(Number(payload.run_id)).toBe(Number(res.body.run.id));
    expect(payload.spec_path).toBe('forge/specs/approved/test.json');
  });

  test('stores run in database with correct fields', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/test.json', workspaceId: 'ws-pipe' });

    const run = await queryOne(`SELECT * FROM pipeline_runs WHERE id = $1`, [res.body.run.id]) as any;
    expect(run).toBeDefined();
    expect(run.spec_path).toBe('forge/specs/approved/test.json');
    expect(run.workspace_id).toBe('ws-pipe');
    expect(run.status).toBe('running');
    expect(run.started_at).toBeDefined();
  });
});

// ─── GET /api/pipeline/runs/:runId/log ─────────────────────────────────────

describe('GET /api/pipeline/runs/:runId/log', () => {
  test('returns 400 for invalid runId', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/abc/log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid runId');
  });

  test('returns 404 when no log file exists', async () => {
    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ($1, $2, $3) RETURNING id`,
    ['forge/specs/approved/no-log-file.json', 'ws-pipe', 'done'],);
    const runId = run!.id;

    // Ensure no legacy log file exists
    const legacyPath = path.join(os.tmpdir(), `rorca-run-${runId}.log`);
    try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Log file not found');
  });

  test('returns log content when log file exists', async () => {
    const runId = await seedRun();

    // Create a log file and reference it in the DB
    const logPath = path.join(tmpDir, `run-${runId}.log`);
    fs.writeFileSync(logPath, 'hello from run-loop\nstory US-001 passed\n');
    await ownerExecute(`UPDATE pipeline_runs SET log_path = $1 WHERE id = $2`, [logPath, runId]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toContain(`run-${runId}.log`);
    expect(res.text).toContain('hello from run-loop');
    expect(res.text).toContain('story US-001 passed');
  });
});

// ─── POST /api/pipeline/runs/:runId/stories/:storyId/tokens ────────────────

describe('POST /api/pipeline/runs/:runId/stories/:storyId/tokens', () => {
  test('records token usage for a story', async () => {
    const runId = await seedRun({ status: 'running' });

    // Add a story result
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status) VALUES ($1, 'US-001', 'pass')`, [runId]);

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-001/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ inputTokens: 5000, outputTokens: 1000, model: 'claude-sonnet-4-5-20250929' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify story_results was updated
    const story = await queryOne(`SELECT input_tokens, output_tokens FROM story_results WHERE run_id = $1 AND story_id = 'US-001'`, [runId]) as any;
    expect(story.input_tokens).toBe(5000);
    expect(story.output_tokens).toBe(1000);
  });

  test('returns 400 when no token fields provided', async () => {
    const runId = await seedRun();

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-001/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('At least one accounting value is required');
  });

  test('returns 404 when story result does not exist', async () => {
    const runId = await seedRun();

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-999/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ inputTokens: 100 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Story result not found');
  });

  test('preserves explicit zero cost for pi token updates', async () => {
    const runId = await seedRun({ status: 'running' });

    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status) VALUES ($1, 'US-PI-001', 'pass')`, [runId]);

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-PI-001/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ inputTokens: 400, outputTokens: 100, model: 'pi/omlx/local', costUsd: 0 });

    expect(res.status).toBe(200);

    const story = await queryOne(
      `SELECT input_tokens, output_tokens, cost_usd FROM story_results WHERE run_id = $1 AND story_id = 'US-PI-001'`,
      [runId],
    ) as any;
    expect(story.input_tokens).toBe(400);
    expect(story.output_tokens).toBe(100);
    expect(story.cost_usd).toBe(0);

    const usage = await queryOne(
      `SELECT model, input_tokens, output_tokens, cost_usd
       FROM token_usage
       WHERE run_id = $1 AND story_id = 'US-PI-001'
       ORDER BY id DESC
       LIMIT 1`,
      [runId],
    ) as any;
    expect(usage.model).toBe('pi/omlx/local');
    expect(usage.input_tokens).toBe(400);
    expect(usage.output_tokens).toBe(100);
    expect(usage.cost_usd).toBe(0);
  });
});

// ─── POST /api/pipeline/story-result ────────────────────────────────────────

describe('POST /api/pipeline/story-result', () => {
  beforeEach(() => {
    process.env.RORCA_ENABLE_LEGACY_STORY_RESULT_INGRESS = '1';
  });

  afterEach(() => {
    delete process.env.RORCA_ENABLE_LEGACY_STORY_RESULT_INGRESS;
  });

  test('records an explicit non-governing pi compatibility cost into story_results and token_usage', async () => {
    const runId = await seedRun({ status: 'running' });

    const res = await request(app)
      .post('/api/pipeline/story-result')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        runId,
        storyId: 'US-PI-002',
        status: 'pass',
        inputTokens: 1200,
        outputTokens: 300,
        modelUsed: 'pi/openai/gpt-4.1',
        costUsd: 0.01875,
        idempotencyKey: `story-result-${runId}-US-PI-002`,
      });

    expect({ status: res.status, body: res.body }).toMatchObject({
      status: 201,
      body: { ok: true, governing: false, outcome: 'compatibility_proposal_recorded' },
    });

    const story = await queryOne(
      `SELECT input_tokens, output_tokens, model_used, cost_usd
       FROM story_results
       WHERE run_id = $1 AND story_id = 'US-PI-002'
       ORDER BY id DESC
       LIMIT 1`,
      [runId],
    ) as any;
    expect(story.input_tokens).toBe(1200);
    expect(story.output_tokens).toBe(300);
    expect(story.model_used).toBe('pi/openai/gpt-4.1');
    expect(story.cost_usd).toBe(0.01875);

    const usage = await queryOne(
      `SELECT model, input_tokens, output_tokens, cost_usd
       FROM token_usage
       WHERE run_id = $1 AND story_id = 'US-PI-002'
       ORDER BY id DESC
       LIMIT 1`,
      [runId],
    ) as any;
    expect(usage.model).toBe('pi/openai/gpt-4.1');
    expect(usage.input_tokens).toBe(1200);
    expect(usage.output_tokens).toBe(300);
    expect(usage.cost_usd).toBe(0.01875);
  });

  test('deduplicates story result and token accounting retries by ingest key', async () => {
    const runId = await seedRun({ status: 'running' });
    const body = {
      runId,
      storyId: 'US-IDEMPOTENT-001',
      status: 'pass',
      inputTokens: 100,
      outputTokens: 25,
      modelUsed: 'pi/test/model',
      idempotencyKey: `story-result-${runId}-US-IDEMPOTENT-001`,
    };

    const first = await request(app).post('/api/pipeline/story-result').send(body);
    const retry = await request(app).post('/api/pipeline/story-result').send(body);
    const storyCount = await queryOne<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM story_results WHERE ingest_key = $1',
      [body.idempotencyKey],
    );
    const usageCount = await queryOne<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM token_usage WHERE run_id = $1 AND story_id = $2',
      [runId, body.storyId],
    );
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(storyCount?.count).toBe(1);
    expect(usageCount?.count).toBe(1);
  });
});

// ─── GET /api/pipeline/runs/compare ─────────────────────────────────────────

describe('GET /api/pipeline/runs/compare', () => {
  test('returns 400 when run params are missing', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/compare')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('run1/run2');
  });

  test('returns 400 when comparing a run with itself', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/compare?run1=1&run2=1')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('itself');
  });

  test('rejects a numeric-prefix run query instead of comparing the aliased run', async () => {
    const runId1 = await seedRun();
    const runId2 = await seedRun();

    const res = await request(app)
      .get('/api/pipeline/runs/compare')
      .query({ run1: `${runId1}abc`, run2: runId2 })
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid run1/run2 query params');
  });

  test('returns 404 when run does not exist', async () => {
    const runId = await seedRun();

    const res = await request(app)
      .get(`/api/pipeline/runs/compare?run1=${runId}&run2=99999`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  test('compares two runs and returns story-level diff with summary', async () => {
    const runId1 = await seedRun({ status: 'done' });
    const runId2 = await seedRun({ status: 'done' });

    // Run 1: US-001 pass, US-002 fail
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-001', 'pass', 60)`, [runId1]);
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-002', 'fail', 120)`, [runId1]);

    // Run 2: US-001 pass, US-002 pass (improved), US-003 pass (new)
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-001', 'pass', 55)`, [runId2]);
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-002', 'pass', 90)`, [runId2]);
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-003', 'pass', 30)`, [runId2]);

    const res = await request(app)
      .get(`/api/pipeline/runs/compare?run1=${runId1}&run2=${runId2}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.run1).toBeDefined();
    expect(res.body.run2).toBeDefined();
    expect(res.body.stories).toHaveLength(3);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.improved).toBe(1); // US-002 fail→pass
    expect(res.body.summary.newStories).toBe(1); // US-003
    expect(res.body.summary.regressed).toBe(0);
    expect(res.body.summary.run2PassRate).toBe(100);
  });
});

// ─── OC-006: Agent type detection, OpenCode server lifecycle, execution-engine ─

describe('OC-006: Pipeline trigger agent integration', () => {
  test('manifestless default-agent selection creates no pipeline run', async () => {
    await seedRunnableSpec('agent-record');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/agent-record.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
  });

  test('agentOverride=pi cannot bypass TaskManifest authority', async () => {
    await seedRunnableSpec('pi-agent-record');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/pi-agent-record.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      agentOverride: 'pi',
    });
  });

  test('TaskManifest authority is checked before Pi model availability', async () => {
    const spec = await seedRunnableSpec('pi-model-fallback') as any;
    spec.model = 'claude-sonnet-4-6';
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', 'pi-model-fallback.json'),
      JSON.stringify(spec, null, 2),
      'utf8',
    );
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/pi-model-fallback.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      agentOverride: 'pi',
    });
  });

  test('unsafe Pi gpt-5.6-sol/xhigh options are rejected before effective-option persistence', async () => {
    const spec = await seedRunnableSpec('rorca-evidence-driven-ssdlc') as any;
    spec.model = 'openai-codex/gpt-5.6-sol';
    spec.agentOverride = 'pi';
    spec.effortLevel = 'xhigh';
    fs.writeFileSync(
      path.join(wsDir, 'forge', 'specs', 'approved', 'rorca-evidence-driven-ssdlc.json'),
      JSON.stringify(spec, null, 2),
      'utf8',
    );
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/rorca-evidence-driven-ssdlc.json',
      workspaceId: 'ws-pipe',
      autoWorktree: false,
      autoMerge: true,
      mergeStrategy: 'direct',
    }, { code: 'RELEASE_ONE_CAPABILITY_DISABLED' });
  });

  test('queue=true and agentOverride=pi still require a TaskManifest', async () => {
    await seedRunnableSpec('pi-queued');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/pi-queued.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      agentOverride: 'pi',
      queue: true,
    });
  });

  test('storyId scoping does not grant manifestless publication authority', async () => {
    await seedRunnableSpec('specific-story');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/specific-story.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      agentOverride: 'pi',
      storyId: 'US-001',
    });
  });

  test('forceRerun cannot bypass TaskManifest or mutate pass state', async () => {
    const spec = await seedRunnableSpec('force-rerun-continuation');
    spec.userStories[0].passes = true;
    const specFile = path.join(wsDir, 'forge', 'specs', 'approved', 'force-rerun-continuation.json');
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/force-rerun-continuation.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      forceRerun: true,
    });
    const persisted = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    expect(persisted.userStories.map((story: any) => story.passes)).toEqual([true, false]);
  });

  test('GET /runs/:runId returns agentType and agentModel fields', async () => {
    // Seed a run with explicit agent info
    const insertResult = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, agent_model)
       VALUES ('forge/specs/approved/test.json', 'ws-pipe', 'done', 'opencode', 'opencode', 'openai/gpt-4o') RETURNING id`);
    const runId = insertResult!.id;

    // Add a story result so the query doesn't fail
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, 'US-001', 'pass', NOW())`, [runId]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agentType).toBe('opencode');
    expect(res.body.agentModel).toBe('openai/gpt-4o');
    expect(res.body.run.agent).toBe('opencode');
    expect(res.body.run.agent_model).toBe('openai/gpt-4o');
  });

  test('GET /runs/:runId publishes Unknown rather than fabricating Claude for absent historical metadata', async () => {
    // Old runs may not have persisted agent/model columns.
    const insertResult2 = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type)
       VALUES ('forge/specs/approved/old.json', 'ws-pipe', 'done', NULL, NULL) RETURNING id`);
    const runId = insertResult2!.id;

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agentType).toBe('unknown');
    expect(res.body.agentModel).toBeNull();
    expect(res.body.terminalMode).toBe('ansi-html');
    expect(res.body.lifecyclePhase).toBe('finished');
    expect(res.body.lifecycleStatus).toBe('finished');
    expect(res.body.run.agentType).toBe('unknown');
    expect(res.body.run.terminalMode).toBe('ansi-html');
  });

  test('GET /runs/:runId retains reported telemetry but represents absent telemetry as null', async () => {
    const insertResult = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent_type)
       VALUES ('forge/specs/approved/telemetry.json', 'ws-pipe', 'done', 'pi') RETURNING id`);
    const runId = insertResult!.id;

    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, finished_at, input_tokens, output_tokens, cost_usd)
      VALUES ($1, 'US-001', 'pass', NOW(), 123, 45, 0.42),
             ($1, 'US-002', 'pass', NOW(), NULL, NULL, NULL)`, [runId]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.tokenSummary).toEqual({ inputTokens: 123, outputTokens: 45, totalCostUsd: 0.42 });
    expect(res.body.storyTokenBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ storyId: 'US-001', inputTokens: 123, outputTokens: 45, costUsd: 0.42 }),
      expect.objectContaining({ storyId: 'US-002', inputTokens: null, outputTokens: null, costUsd: null }),
    ]));
  });

  test('pipeline_runs table has agent_type and agent_model columns', async () => {
    const cols = await query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'pipeline_runs'`);
    const colNames = cols.map(c => c.column_name);
    expect(colNames).toContain('agent_type');
    expect(colNames).toContain('agent_model');
    expect(colNames).toContain('agent');
    expect(colNames).toContain('opencode_server_pid');
    expect(colNames).toContain('terminal_mode');
  });

  test('manifestless denial exposes no fabricated agent response fields', async () => {
    await seedRunnableSpec('agent-response');
    const res = await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/agent-response.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
    });
    expect(res.body.agentType).toBeUndefined();
    expect(res.body.agentModel).toBeUndefined();
  });

  test('terminal_mode=pty cannot bypass TaskManifest publication authority', async () => {
    await seedRunnableSpec('terminal-mode-pty');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/terminal-mode-pty.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      terminal_mode: 'pty',
    });
  });

  test('TaskManifest authority is checked before manifestless terminal-mode validation', async () => {
    seedSpec('approved', 'terminal-mode-invalid');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/terminal-mode-invalid.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      terminal_mode: 'bogus',
    });
  });
});

// ─── GET /api/pipeline/runs/:runId/output ───────────────────────────────────

describe('GET /api/pipeline/runs/:runId/output', () => {
  test('emits run_meta with normalized terminal_mode for replay clients', async () => {
    const inserted = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/output-meta.json', 'ws-pipe', 'done')
     RETURNING id`,);
    const runId = inserted!.id;

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/output`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((stream, cb) => {
        let data = '';
        stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        stream.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('event: run_meta');
    expect(String(res.body)).toContain('"terminal_mode":"ansi-html"');
    expect(String(res.body)).toContain('"isPty":false');
  });

  test('replays transcript chunks and semantic_step events for non-PTY runs', async () => {
    const inserted = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/output-replay.json', 'ws-pipe', 'done')
     RETURNING id`,);
    const runId = inserted!.id;

    const chunkOne = Buffer.from('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/foo.ts"}}]}}\n', 'utf8');
    const chunkTwo = Buffer.from('plain transcript line\n', 'utf8');

    await ownerExecute(`INSERT INTO run_output_chunks (run_id, chunk, sequence)
     VALUES ($1, $2, 0), ($1, $3, 1)`,
    [runId, chunkOne, chunkTwo],);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/output`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((stream, cb) => {
        let data = '';
        stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        stream.on('end', () => cb(null, data));
      });

    const body = String(res.body);
    expect(res.status).toBe(200);
    expect(body).toContain('event: run_meta');
    expect(body).toContain('"terminal_mode":"ansi-html"');
    expect(body).toContain('"isPty":false');
    expect(body).toContain(`event: chunk\ndata: ${chunkOne.toString('base64')}`);
    expect(body).toContain(`event: chunk\ndata: ${chunkTwo.toString('base64')}`);
    expect(body).toContain('event: semantic_step');
    expect(body).toContain('"type":"read"');
    expect(body).toContain('"label":"Read src/foo.ts"');
    expect(body).toContain('event: done');
  });

  test('demotes requested PTY output to ANSI replay metadata when no PTY session exists', async () => {
    const inserted = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, terminal_mode, agent, agent_type)
     VALUES ('forge/specs/approved/output-pty-fallback.json', 'ws-pipe', 'done', 'pty', 'claude', 'claude')
     RETURNING id`,);
    const runId = inserted!.id;
    const chunk = Buffer.from('fallback ansi transcript\n', 'utf8');

    await ownerExecute(`INSERT INTO run_output_chunks (run_id, chunk, sequence)
     VALUES ($1, $2, 0)`,
    [runId, chunk],);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/output`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((stream, cb) => {
        let data = '';
        stream.on('data', (part: Buffer) => { data += part.toString(); });
        stream.on('end', () => cb(null, data));
      });

    const body = String(res.body);
    expect(res.status).toBe(200);
    expect(body).toContain('event: run_meta');
    expect(body).toContain('"terminal_mode":"ansi-html"');
    expect(body).toContain('"requestedTerminalMode":"pty"');
    expect(body).toContain('"isPty":false');
    expect(body).toContain('"ptyFallbackActive":true');
    expect(body).toContain('"ptyUnavailableHint":');
    expect(body).toContain(`event: chunk\ndata: ${chunk.toString('base64')}`);
    expect(body).toContain('event: done');
  });

  test('replays gzip-compressed PTY chunks from the dedicated capture store from byte 0', async () => {
    const inserted = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, terminal_mode, agent, agent_type)
     VALUES ('forge/specs/approved/output-pty.json', 'ws-pipe', 'done', 'pty', 'claude', 'claude')
     RETURNING id`,);
    const runId = inserted!.id;

    const chunk = Buffer.from('\u001b[32mpty hello\u001b[0m\r\n', 'utf8');
    const compressedChunk = gzipSync(chunk);

    await ownerExecute(`INSERT INTO run_pty_sessions (run_id, workspace_id, cwd, agent_type, status, total_output_bytes, total_stored_bytes)
     VALUES ($1, 'ws-pipe', '/tmp/workspace', 'claude', 'exited', $2, $3)`,
    [runId, chunk.length, compressedChunk.length],);
    await ownerExecute(`INSERT INTO run_pty_output_chunks (run_id, sequence, chunk, compression, byte_length, stored_byte_length)
     VALUES ($1, 1, $2, 'gzip', $3, $4)`,
    [runId, compressedChunk, chunk.length, compressedChunk.length],);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/output`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((stream, cb) => {
        let data = '';
        stream.on('data', (part: Buffer) => { data += part.toString(); });
        stream.on('end', () => cb(null, data));
      });

    const body = String(res.body);
    expect(res.status).toBe(200);
    expect(body).toContain('event: run_meta');
    expect(body).toContain('"terminal_mode":"pty"');
    expect(body).toContain('"isPty":true');
    expect(body).toContain(`event: chunk\ndata: ${chunk.toString('base64')}`);
    expect(body).not.toContain('event: semantic_step');
    expect(body).toContain('event: done');
  });
});

// ─── POST /api/pipeline/runs/:runId/retry ───────────────────────────────────

describe('POST /api/pipeline/runs/:runId/retry', () => {
  test('rejects forceSequential dispatch when the legacy run lacks canonical closeout authority', async () => {
    seedSpec('approved', 'retry-sequential');

    const originalRun = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, parallelism)
     VALUES ('forge/specs/approved/retry-sequential.json', 'ws-pipe', 'failed', 4)
     RETURNING id`);
    expect(originalRun?.id).toBeDefined();

    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, retries)
     VALUES ($1, 'US-001', 'fail', 0)`,
    [originalRun!.id],);

    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post(`/api/pipeline/runs/${originalRun!.id}/retry`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ forceSequential: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Canonical host closeout is unavailable for the retry target');
    expect(await query(`SELECT id FROM pipeline_runs WHERE retried_from_run_id = $1`, [originalRun!.id])).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('does not replay legacy agent/model/terminal options without canonical closeout authority', async () => {
    seedSpec('approved', 'retry-preserve-options');

    const originalRun = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs
       (spec_path, workspace_id, status, parallelism, agent, agent_type, agent_model,
        auto_worktree, auto_merge, include_graph, merge_strategy, terminal_mode, trigger_options)
     VALUES ('forge/specs/approved/retry-preserve-options.json', 'ws-pipe', 'failed', 4,
        'claude', 'claude', NULL, false, false, true, 'direct', 'pty',
        $1::jsonb)
     RETURNING id`,
    [JSON.stringify({ thinkingEnabled: true, thinkingBudget: 4096, effortLevel: 'xhigh', reasoningEffort: 'xhigh' })],);
    expect(originalRun?.id).toBeDefined();

    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, retries)
     VALUES ($1, 'US-001', 'fail', 0)`,
    [originalRun!.id],);

    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post(`/api/pipeline/runs/${originalRun!.id}/retry`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ forceSequential: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Canonical host closeout is unavailable for the retry target');
    expect(await query(`SELECT id FROM pipeline_runs WHERE retried_from_run_id = $1`, [originalRun!.id])).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('rejects an unauthoritative legacy retry before evaluating reusable worktree state', async () => {
    seedSpec('approved', 'retry-stale-worktree');
    const { branchName, worktreePath } = createDeterministicSpecWorktree('retry-stale-worktree');
    advanceWorkspaceMain('advance-main-before-retry');

    const originalRun = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, parallelism, branch_name, worktree_path)
     VALUES ('forge/specs/approved/retry-stale-worktree.json', 'ws-pipe', 'failed', 1, $1, $2)
     RETURNING id`,
    [branchName, worktreePath],);
    expect(originalRun?.id).toBeDefined();

    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, retries)
     VALUES ($1, 'US-001', 'fail', 0)`,
    [originalRun!.id],);

    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post(`/api/pipeline/runs/${originalRun!.id}/retry`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Canonical host closeout is unavailable for the retry target');
    expect(mockSend).not.toHaveBeenCalled();

    const retryRuns = await query(
      `SELECT id FROM pipeline_runs WHERE retried_from_run_id = $1`,
      [originalRun!.id],
    );
    expect(retryRuns).toHaveLength(0);
  });
});

// ─── POST /api/pipeline/queue — smart run trigger ────────────────────────────

describe('POST /api/pipeline/queue', () => {

  test('retired queue route denies manifestless immediate execution with no effects', async () => {
    seedSpec('approved', 'queue-no-active');
    await expectReleaseOneManifestlessDenial(
      { workspaceId: 'ws-pipe', specId: 'queue-no-active' },
      { endpoint: '/api/pipeline/queue', code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED' },
    );
  });

  test('retired queue route denies manifestless queueing even with an active run', async () => {
    seedSpec('approved', 'queue-with-active');
    await seedRun({ status: 'running' });
    await expectReleaseOneManifestlessDenial(
      { workspaceId: 'ws-pipe', specId: 'queue-with-active' },
      { endpoint: '/api/pipeline/queue', code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED' },
    );
  });

  test('POST /api/pipeline/queue returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specId: 'some-spec' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('workspaceId');
  });

  test('POST /api/pipeline/queue returns 400 when specId is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('specId');
  });

  test('retired queue route denies before nonexistent-workspace lookup', async () => {
    await expectReleaseOneManifestlessDenial(
      { workspaceId: 'nonexistent-ws', specId: 'some-spec' },
      { endpoint: '/api/pipeline/queue', code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED' },
    );
  });

  test('retired queue route denies before missing-spec filesystem lookup', async () => {
    await expectReleaseOneManifestlessDenial(
      { workspaceId: 'ws-pipe', specId: 'no-such-spec' },
      { endpoint: '/api/pipeline/queue', code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED' },
    );
  });
});

// ─── Auto-merge functionality tests ────────────────────────────────

describe('auto_merge column in pipeline_runs', () => {
  test('pipeline run persistence retains an explicit safe auto_merge=false value', async () => {
    const inserted = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, auto_merge)
     VALUES ('forge/specs/approved/auto-merge-default.json', 'ws-pipe', 'queued', false)
     RETURNING id`,);
    const run = await queryOne<{ auto_merge: boolean }>(
      'SELECT auto_merge FROM pipeline_runs WHERE id = $1',
      [inserted!.id],
    );
    expect(run?.auto_merge).toBe(false);
  });

  test('Release-1 rejects autoWorktree=false before auto_merge persistence', async () => {
    await seedRunnableSpec('auto-merge-no-worktree');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/auto-merge-no-worktree.json',
      workspaceId: 'ws-pipe',
      autoWorktree: false,
    }, { code: 'RELEASE_ONE_CAPABILITY_DISABLED' });
  });

  test('worker payload schema preserves explicit autoMerge=false', () => {
    const { PipelineRunJobPayload } = require('../../lib/pg-boss-schemas');
    const parsed = PipelineRunJobPayload.safeParse({
      runId: 1,
      workspaceId: 'ws-pipe',
      specPath: 'forge/specs/approved/auto-merge-explicit-false.json',
      runSpecPath: '/tmp/run-spec.json',
      workspacePath: '/tmp/workspace',
      agent: 'pi',
      model: 'openai-codex/gpt-5.6-sol',
      worktreePath: '/tmp/worktree',
      branchName: 'feat/auto-merge-explicit-false',
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'draft-pr',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.autoMerge).toBe(false);
  });

  test('Release-1 rejects autoMerge=true before pg-boss publication', async () => {
    await seedRunnableSpec('auto-merge-payload');
    await expectReleaseOneManifestlessDenial({
      specPath: 'forge/specs/approved/auto-merge-payload.json',
      workspaceId: 'ws-pipe',
      autoWorktree: true,
      autoMerge: true,
    }, { code: 'RELEASE_ONE_CAPABILITY_DISABLED' });
  });

  test('GET /api/pipeline/runs/:id includes persisted auto_merge field', async () => {
    const inserted = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, auto_merge)
     VALUES ('forge/specs/approved/auto-merge-response.json', 'ws-pipe', 'done', true)
     RETURNING id`,);
    const getRes = await request(app)
      .get(`/api/pipeline/runs/${inserted!.id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.run).toMatchObject({ auto_merge: true });
  });
});

// ─── POST /api/pipeline/orphan-sweep ────────────────────────────────────────

describe('POST /api/pipeline/orphan-sweep', () => {
  async function drainPriorOrphans(): Promise<void> {
    const baseline = await request(app)
      .post('/api/pipeline/orphan-sweep')
      .set('Authorization', `Bearer ${authToken}`);
    expect(baseline.status).toBe(200);
  }

  test('returns an empty swept array after the orphan sweep is drained', async () => {
    await drainPriorOrphans();
    const res = await request(app)
      .post('/api/pipeline/orphan-sweep')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('swept');
    expect(res.body).toHaveProperty('count');
    expect(Array.isArray(res.body.swept)).toBe(true);
    expect(res.body.count).toBe(0);
  });

  test('returns 200 with swept runs when orphan processes exist', async () => {
    await drainPriorOrphans();
    // Create orphan runs with status='running' and no worker_id
    // (simulates runs from a crashed worker)
    const runId1 = await seedRun({ status: 'running', pid: 999999 });
    const runId2 = await seedRun({ status: 'running', pid: null });

    // Mark them as orphaned (worker_id NULL or different from current worker)
    await ownerExecute(`UPDATE pipeline_runs SET worker_id = NULL WHERE id = $1`, [runId1]);
    await ownerExecute(`UPDATE pipeline_runs SET worker_id = NULL WHERE id = $1`, [runId2]);

    const res = await request(app)
      .post('/api/pipeline/orphan-sweep')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('swept');
    expect(res.body).toHaveProperty('count');
    expect(Array.isArray(res.body.swept)).toBe(true);
    expect(res.body.count).toBe(2);

    // Verify swept results
    expect(res.body.swept[0]).toHaveProperty('runId');
    expect(res.body.swept[0]).toHaveProperty('pid');
    expect(res.body.swept[0]).toHaveProperty('killed');

    // Verify runs are now marked as failed
    const failedRuns = await query<{ id: number; status: string }>(
      `SELECT id, status FROM pipeline_runs WHERE id IN ($1, $2) ORDER BY id`,
      [runId1, runId2]
    );

    expect(failedRuns).toHaveLength(2);
    expect(failedRuns[0].status).toBe('failed');
    expect(failedRuns[1].status).toBe('failed');

    // Verify WAL events were emitted
    const walEvents = await query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM wal_events
       WHERE workspace_id = 'ws-pipe' AND event_type IN ('run_finished', 'story_failed')
       ORDER BY ts DESC LIMIT 10`,
    );

    expect(walEvents.length).toBeGreaterThan(0);
    const runFinishedEvents = walEvents.filter(e => e.event_type === 'run_finished');
    expect(runFinishedEvents.length).toBeGreaterThanOrEqual(1);
    expect(runFinishedEvents[0].payload.reason).toBe('orphan_sweep');
  });

  test('returns 500 when sweepOrphanProcesses throws', async () => {
    // Mock sweepOrphanProcesses to throw
    jest.spyOn(require('../../worker'), 'sweepOrphanProcesses').mockRejectedValueOnce(
      new Error('Test sweep error')
    );

    const res = await request(app)
      .post('/api/pipeline/orphan-sweep')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('Test sweep error');
  });
});

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/log — backward compat ──

describe('GET /api/pipeline/runs/:runId/stories/:storyId/log (backward compat)', () => {
  test('endpoint exists and returns SSE headers with text/event-stream content type', async () => {
    const runId = await seedRun({ status: 'running' });

    // Create a log file so the tailing loop has something to read
    const logDir = path.join(wsDir, 'forge', 'specs', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `US-001_${Date.now()}.log`);
    fs.writeFileSync(logPath, 'test log content\n');

    // Insert story_started WAL event with log_file path so the endpoint finds it
    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({ run_id: runId, story_id: 'US-001', log_file: logPath })]);

    // Insert story_passed WAL event so the tailing loop terminates
    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_passed', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({ run_id: runId, story_id: 'US-001' })]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/stories/US-001/log`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    // Should contain the SSE connection comment
    expect(res.body).toContain(': connected');
  });
});

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/stream — DB-backed SSE ──

describe('GET /api/pipeline/runs/:runId/stories/:storyId/stream', () => {

  /** Parse raw SSE text into an array of { event, data } objects. */
  function parseSSE(raw: string): Array<{ event: string; data: string }> {
    const events: Array<{ event: string; data: string }> = [];
    const blocks = raw.split('\n\n').filter(Boolean);
    for (const block of blocks) {
      // Skip comments (: connected, : hb)
      if (block.startsWith(':')) continue;
      const lines = block.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event: ')) event = line.slice(7);
        if (line.startsWith('data: ')) data = line.slice(6);
        if (line === 'data: ') data = '';
      }
      events.push({ event, data });
    }
    return events;
  }

  test('replays 3 existing chunks in sequence order and closes after story_passed WAL event', async () => {
    const runId = await seedRun({ status: 'running' });

    // Insert 3 story_output_chunks rows
    const chunks = ['First chunk of prose output', 'Second chunk continues', 'Third and final chunk'];
    for (let i = 0; i < chunks.length; i++) {
      await ownerExecute(`INSERT INTO story_output_chunks (run_id, story_id, chunk, sequence)
       VALUES ($1, 'US-001', $2, $3)`,
      [runId, chunks[i], i + 1]);
    }

    // Insert story_passed WAL event so isStoryDone() returns true after replay
    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_passed', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({ run_id: runId, story_id: 'US-001' })]);

    // Connect to the /stream endpoint — since story is already done, it will replay + close
    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/stories/US-001/stream`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');

    const events = parseSSE(res.body as string);

    // Should have exactly 3 output events + 1 done event
    const outputEvents = events.filter(e => e.event === 'output');
    const doneEvents = events.filter(e => e.event === 'done');

    expect(outputEvents).toHaveLength(3);
    expect(doneEvents).toHaveLength(1);

    // Verify base64 content matches inserted chunks in sequence order
    for (let i = 0; i < chunks.length; i++) {
      const decoded = Buffer.from(outputEvents[i].data, 'base64').toString('utf8');
      expect(decoded).toBe(chunks[i]);
    }
  });

  test('closes SSE connection within 1s after story_passed WAL event is emitted mid-stream', async () => {
    const runId = await seedRun({ status: 'running' });

    // Insert 3 story_output_chunks rows but NO WAL event yet — the endpoint
    // will replay chunks, find story NOT done, and enter the 200ms poll loop.
    const chunks = ['Alpha prose', 'Beta prose', 'Gamma prose'];
    for (let i = 0; i < chunks.length; i++) {
      await ownerExecute(`INSERT INTO story_output_chunks (run_id, story_id, chunk, sequence)
       VALUES ($1, 'US-002', $2, $3)`,
      [runId, chunks[i], i + 1]);
    }

    const startTime = Date.now();

    // We need to insert the WAL event AFTER the endpoint enters the poll loop.
    // Schedule the insert after 300ms (enough for replay + one poll tick).
    const walInsertPromise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
         VALUES ('story_passed', 'ws-pipe', 'US-002', $1)`,
        [JSON.stringify({ run_id: runId, story_id: 'US-002' })]);
        resolve();
      }, 300);
    });

    // Connect to the stream — it will replay chunks, then poll until WAL event appears
    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/stories/US-002/stream`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => cb(null, data));
      });

    await walInsertPromise;

    const elapsed = Date.now() - startTime;
    expect(res.status).toBe(200);

    const events = parseSSE(res.body as string);
    const outputEvents = events.filter(e => e.event === 'output');
    const doneEvents = events.filter(e => e.event === 'done');

    // Should still have 3 output events from replay
    expect(outputEvents).toHaveLength(3);
    // Must have received the done event
    expect(doneEvents).toHaveLength(1);

    // Connection should close within 1 second of the WAL event (300ms delay + ≤200ms poll + margin)
    // Total elapsed should be well under 2 seconds
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ─── GET /api/pipeline/runs/:runId/retrieval-telemetry/:telemetryId ──────────

describe('GET /api/pipeline/runs/:runId/retrieval-telemetry/:telemetryId', () => {
  test('returns normalized candidate details for valid telemetry ID', async () => {
    seedSpec('approved', 'retrieval-test');

    // Create run
    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/retrieval-test.json', 'ws-pipe', 'running')
     RETURNING id`);
    expect(run?.id).toBeDefined();
    const runId = Number(run!.id);

    // Insert retrieval telemetry event
    const telemetryId = `rt-${Date.now()}-test123`;
    const candidatesPayload = [
      {
        key: 'memory:m-001',
        origin: 'memory',
        sourceType: 'decision',
        title: 'Test Memory Entry',
        snippet: 'This is a test memory snippet',
        category: 'Architecture',
        finalScore: 0.92,
        semanticRankScore: 0.88,
        graphScore: 0.15,
        freshnessScore: 0.10,
        decision: 'keep',
        reasons: ['High semantic match', 'Recent entry'],
        scoring: {
          keywordScore: 0.75,
          skillScore: 0.05,
        },
        matchedSkills: ['typescript', 'backend'],
      },
      {
        key: 'context:c-002',
        origin: 'context',
        sourceType: 'convention',
        title: 'Dropped Convention',
        snippet: 'This convention was dropped',
        category: 'Convention',
        finalScore: 0.42,
        semanticRankScore: 0.40,
        decision: 'drop',
        reasons: ['Low relevance', 'Contradicts higher-scored entry'],
      },
    ];

    await ownerExecute(`INSERT INTO retrieval_telemetry_events (
       id, workspace_id, query_preview, matched_skills,
       selected_candidate_keys, dropped_candidate_keys,
       needs_more_evidence, candidate_count, selected_count,
       token_budget, contradiction_count, contradiction_pairs,
       retrieval_tier, latency_ms, payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      telemetryId,
      'ws-pipe',
      'test query for retrieval',
      JSON.stringify(['typescript', 'backend']),
      JSON.stringify(['memory:m-001']),
      JSON.stringify(['context:c-002']),
      false,
      2,
      1,
      8000,
      0,
      JSON.stringify([]),
      'hybrid',
      125,
      JSON.stringify({ candidates: candidatesPayload }),
    ]);

    // Insert story_started WAL event that references this telemetry
    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({
      run_id: runId,
      story_id: 'US-001',
      retrieval_telemetry_id: telemetryId,
      retrieval_selected_count: 1,
    })]);

    // Fetch telemetry details
    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/retrieval-telemetry/${telemetryId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      telemetryId,
      runId,
      storyId: 'US-001',
      query: 'test query for retrieval',
      candidateCount: 2,
      selectedCount: 1,
      matchedSkills: ['typescript', 'backend'],
      retrievalTier: 'hybrid',
      latencyMs: 125,
      needsMoreEvidence: false,
      tokenBudget: 8000,
      contradictions: [],
      rawSummary: expect.stringContaining('1/2 candidates selected'),
    });

    // Verify selected candidates
    expect(res.body.selectedCandidates).toHaveLength(1);
    expect(res.body.selectedCandidates[0]).toMatchObject({
      key: 'memory:m-001',
      origin: 'memory',
      sourceType: 'decision',
      title: 'Test Memory Entry',
      snippet: 'This is a test memory snippet',
      category: 'Architecture',
      selected: true,
      enteredPrompt: true,
      relevanceScore: 0.92,
      scoreBreakdown: {
        semantic: 0.88,
        keyword: 0.75,
        graph: 0.15,
        recency: 0.10,
        skill: 0.05,
      },
      matchedSkills: ['typescript', 'backend'],
      keptOrDroppedReason: 'High semantic match; Recent entry',
    });

    // Verify dropped candidates
    expect(res.body.droppedCandidates).toHaveLength(1);
    expect(res.body.droppedCandidates[0]).toMatchObject({
      key: 'context:c-002',
      origin: 'context',
      selected: false,
      enteredPrompt: false,
      relevanceScore: 0.42,
      keptOrDroppedReason: 'Low relevance; Contradicts higher-scored entry',
    });
  });

  test('returns 404 when run does not exist', async () => {
    const maxRun = await queryOne<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM pipeline_runs');
    const missingRunId = Number(maxRun?.id ?? 0) + 1_000_000;
    const res = await request(app)
      .get(`/api/pipeline/runs/${missingRunId}/retrieval-telemetry/rt-nonexistent`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Run not found');
  });

  test('returns 404 when telemetry event does not exist', async () => {
    seedSpec('approved', 'retrieval-missing');

    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/retrieval-missing.json', 'ws-pipe', 'running')
     RETURNING id`);
    expect(run?.id).toBeDefined();

    const res = await request(app)
      .get(`/api/pipeline/runs/${run!.id}/retrieval-telemetry/rt-nonexistent`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Retrieval telemetry event not found');
  });

  test('returns 404 when telemetry event does not belong to run', async () => {
    seedSpec('approved', 'retrieval-wrong-run');

    // Create two runs
    const run1 = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/retrieval-wrong-run.json', 'ws-pipe', 'running')
     RETURNING id`);
    const run2 = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/retrieval-wrong-run.json', 'ws-pipe', 'running')
     RETURNING id`);
    expect(run1?.id).toBeDefined();
    expect(run2?.id).toBeDefined();

    // Insert telemetry event
    const telemetryId = `rt-${Date.now()}-wrongrun`;
    await ownerExecute(`INSERT INTO retrieval_telemetry_events (
       id, workspace_id, query_preview, matched_skills,
       selected_candidate_keys, dropped_candidate_keys,
       needs_more_evidence, candidate_count, selected_count,
       token_budget, contradiction_count, contradiction_pairs,
       payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      telemetryId,
      'ws-pipe',
      'test query',
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      false,
      0,
      0,
      5000,
      0,
      JSON.stringify([]),
      JSON.stringify({ candidates: [] }),
    ]);

    // Link telemetry to run2 via story_started
    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({
      run_id: run2!.id,
      story_id: 'US-001',
      retrieval_telemetry_id: telemetryId,
    })]);

    // Try to fetch telemetry with run1 (wrong run)
    const res = await request(app)
      .get(`/api/pipeline/runs/${run1!.id}/retrieval-telemetry/${telemetryId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('does not belong to this run');
  });

  test('returns 400 for invalid runId', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/not-a-number/retrieval-telemetry/rt-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid runId');
  });

  test('returns 400 for empty telemetryId', async () => {
    seedSpec('approved', 'retrieval-empty-id');

    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/retrieval-empty-id.json', 'ws-pipe', 'running')
     RETURNING id`);

    const res = await request(app)
      .get(`/api/pipeline/runs/${run!.id}/retrieval-telemetry/ `)
      .set('Authorization', `Bearer ${authToken}`);

    // Express may route this differently, but we expect either 400 or 404
    expect([400, 404]).toContain(res.status);
  });

  test('handles telemetry with no candidates gracefully', async () => {
    seedSpec('approved', 'retrieval-no-candidates');

    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/retrieval-no-candidates.json', 'ws-pipe', 'running')
     RETURNING id`);
    const runId = run!.id;

    const telemetryId = `rt-${Date.now()}-nocand`;
    await ownerExecute(`INSERT INTO retrieval_telemetry_events (
       id, workspace_id, query_preview, matched_skills,
       selected_candidate_keys, dropped_candidate_keys,
       needs_more_evidence, candidate_count, selected_count,
       token_budget, contradiction_count, contradiction_pairs,
       payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      telemetryId,
      'ws-pipe',
      'query with no candidates',
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      true,
      0,
      0,
      5000,
      0,
      JSON.stringify([]),
      JSON.stringify({}),
    ]);

    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({
      run_id: runId,
      story_id: 'US-001',
      retrieval_telemetry_id: telemetryId,
    })]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/retrieval-telemetry/${telemetryId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.selectedCandidates).toEqual([]);
    expect(res.body.droppedCandidates).toEqual([]);
    expect(res.body.candidateCount).toBe(0);
    expect(res.body.selectedCount).toBe(0);
    expect(res.body.needsMoreEvidence).toBe(true);
    expect(res.body.tokenBudget).toBe(5000);
    expect(res.body.contradictions).toEqual([]);
    expect(res.body.rawSummary).toContain('0/0 candidates selected');
    expect(res.body.rawSummary).toContain('needs more evidence');
  });

  test('returns contradiction pairs when present', async () => {
    seedSpec('approved', 'retrieval-contradictions');

    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/retrieval-contradictions.json', 'ws-pipe', 'running')
     RETURNING id`);
    const runId = run!.id;

    const telemetryId = `rt-${Date.now()}-contrad`;
    await ownerExecute(`INSERT INTO retrieval_telemetry_events (
       id, workspace_id, query_preview, matched_skills,
       selected_candidate_keys, dropped_candidate_keys,
       needs_more_evidence, candidate_count, selected_count,
       token_budget, contradiction_count, contradiction_pairs,
       retrieval_tier, latency_ms, payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      telemetryId,
      'ws-pipe',
      'query with contradictions',
      JSON.stringify([]),
      JSON.stringify(['memory:m-001']),
      JSON.stringify(['memory:m-002']),
      false,
      2,
      1,
      6000,
      1,
      JSON.stringify([['memory:m-001', 'memory:m-002']]),
      'search',
      200,
      JSON.stringify({ candidates: [] }),
    ]);

    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({
      run_id: runId,
      story_id: 'US-001',
      retrieval_telemetry_id: telemetryId,
    })]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/retrieval-telemetry/${telemetryId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.contradictions).toEqual([['memory:m-001', 'memory:m-002']]);
    expect(res.body.tokenBudget).toBe(6000);
    expect(res.body.retrievalTier).toBe('search');
    expect(res.body.rawSummary).toContain('1/2 candidates selected');
    expect(res.body.rawSummary).toContain('tier: search');
    expect(res.body.rawSummary).toContain('latency: 200ms');
  });
});

describe('GET /api/pipeline/runs/:runId/context-inspector-events — retrievalTelemetryId', () => {
  test('returns structured retrievalTelemetryId for story_started WAL payloads containing retrieval_telemetry_id', async () => {
    seedSpec('approved', 'ctx-telemetry-test');

    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/ctx-telemetry-test.json', 'ws-pipe', 'done')
     RETURNING id`);
    const runId = Number(run!.id);

    const telemetryId = `rt-ctx-${Date.now()}`;

    // Insert story_started WAL event with retrieval_telemetry_id.
    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({
      run_id: runId,
      story_id: 'US-001',
      retrieval_telemetry_id: telemetryId,
      retrieval_selected_count: 3,
      retrieval_needs_more_evidence: false,
      retrieval_matched_skills: ['typescript'],
    })]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/context-inspector-events`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.reconstructed).toBe(true);

    // Find the memory/retrieval event among reconstructed events.
    const memoryEvent = res.body.events.find(
      (e: any) => e.phase === 'memory' && e.label?.startsWith('retrieval:'),
    );
    expect(memoryEvent).toBeDefined();
    expect(memoryEvent.retrievalTelemetryId).toBe(telemetryId);
    expect(memoryEvent.synthetic).toBe(true);
    // The details array should still contain the telemetry ID for backward compat.
    expect(memoryEvent.details).toContain(`telemetry: ${telemetryId}`);
  });

  test('retroactively backfills retrievalTelemetryId onto persisted context_trace memory rows when raw artifact is gone', async () => {
    seedSpec('approved', 'ctx-telemetry-context-trace-test');

    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/ctx-telemetry-context-trace-test.json', 'ws-pipe', 'done')
     RETURNING id`);
    const runId = Number(run!.id);
    const telemetryId = `rt-ctx-trace-${Date.now()}`;

    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({
      run_id: runId,
      story_id: 'US-001',
      retrieval_telemetry_id: telemetryId,
    })]);

    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('context_trace', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({
      traceId: `trace:${runId}:memory`,
      runId,
      run_id: runId,
      storyId: 'US-001',
      seq: 0,
      rawRef: `r${runId}:0`,
      phase: 'memory',
      status: 'ok',
      ts: new Date().toISOString(),
      label: 'retrieval:US-001',
    })]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/context-inspector-events`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.reconstructed).toBe(false);
    const memoryEvent = res.body.events.find(
      (e: any) => e.phase === 'memory' && e.label === 'retrieval:US-001',
    );
    expect(memoryEvent).toBeDefined();
    expect(memoryEvent.retrievalTelemetryId).toBe(telemetryId);
    expect(memoryEvent.details ?? []).toContain(`telemetry: ${telemetryId}`);
  });

  test('does not include retrievalTelemetryId when story_started payload lacks retrieval_telemetry_id', async () => {
    seedSpec('approved', 'ctx-no-telemetry-test');

    const run = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/ctx-no-telemetry-test.json', 'ws-pipe', 'done')
     RETURNING id`);
    const runId = Number(run!.id);

    // Insert story_started WAL event WITHOUT retrieval_telemetry_id.
    await ownerExecute(`INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
     VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
    [JSON.stringify({
      run_id: runId,
      story_id: 'US-001',
      context_files: ['src/main.ts'],
    })]);

    // Insert token row so we get at least a prompt event.
    await ownerExecute(`INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens)
     VALUES ($1, 'US-001', 'pass', 1000, 500)`,
    [runId]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/context-inspector-events`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);

    // No memory event should exist (no retrieval fields).
    const memoryEvents = res.body.events.filter(
      (e: any) => e.phase === 'memory',
    );
    expect(memoryEvents.length).toBe(0);

    // Context and prompt events should exist but without retrievalTelemetryId.
    for (const event of res.body.events) {
      expect(event.retrievalTelemetryId).toBeUndefined();
    }
  });
});

// ─── POST /api/pipeline/task-manifests/trigger ───────────────────────────────

describe('POST /api/pipeline/task-manifests/trigger', () => {
  beforeEach(() => {
    process.env.PI_BIN = process.execPath;
    const piDetector = require('../../lib/pi-detector') as typeof import('../../lib/pi-detector');
    jest.spyOn(piDetector, 'detectPi').mockReturnValue({ piInstalled: true, piVersion: '0.67.2', piBinPath: process.execPath });
    jest.spyOn(piDetector, 'inspectPi').mockReturnValue({
      status: { piInstalled: true, piVersion: '0.67.2', piBinPath: process.execPath },
    });
    jest.spyOn(piDetector, 'listPiModels').mockReturnValue([
      { provider: 'openai-codex', model: 'gpt-5.4', contextTokens: 272000, maxOutTokens: 128000, thinking: true, images: true },
    ]);
    const openCodeDetector = require('../../lib/opencode-detector') as typeof import('../../lib/opencode-detector');
    jest.spyOn(openCodeDetector, 'detectOpenCode').mockReturnValue({ opencodeInstalled: true, opencodeVersion: '1.2.3', opencodeBinPath: '/usr/bin/true' });
    const environmentRegistry = require('../../lib/execution-environment-registry') as typeof import('../../lib/execution-environment-registry');
    jest.spyOn(environmentRegistry, 'assertExecutionEnvironmentReadyForRun').mockResolvedValue({
      id: 'remote-rorca', label: 'Remote Rorca worker', kind: 'remote-rorca', enabled: true,
      ready: true, networkMode: 'local', lastHeartbeatAt: null,
      supportedAgents: ['claude', 'codex', 'opencode', 'pi'], secretProfileId: null,
      agents: {},
    });
  });

  afterEach(() => {
    delete process.env.PI_BIN;
    taskManifestApprovalCache.clear();
  });

  test('internal service token cannot replace the exact provider-human TaskManifest command', async () => {
    const body = taskManifestTriggerBody({ dryRun: false, mergeStrategy: 'draft-pr' });
    const artifactDir = path.join(wsDir, 'forge', 'task-manifests', body.manifest.manifestId);

    const res = await request(app)
      .post('/api/pipeline/task-manifests/trigger')
      .set('Authorization', `Bearer ${serviceAuthToken}`)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('exact signed provider-human TaskManifest approval command');
    expect(fs.existsSync(artifactDir)).toBe(false);
    const run = await queryOne<{ id: number }>(
      `SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pipe' AND idempotency_key = $1`,
      [body.idempotencyKey],
    );
    expect(run).toBeUndefined();
  });
  test('unknown provider-human actor fails closed before TaskManifest run insertion', async () => {
    const { getBoss } = require('../../lib/pg-boss') as { getBoss: typeof GetPipelineBoss };
    const body = taskManifestTriggerBody({ dryRun: false, queue: false, mergeStrategy: 'draft-pr' });

    const res = await postApprovedTaskManifest(body, `unknown-human-${crypto.randomUUID()}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'FORBIDDEN',
      error: expect.stringContaining('not a member of the requested workspace'),
    }));
    expect(getBoss().send).not.toHaveBeenCalled();
    expect(await queryOne(
      'SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2',
      [PIPE_WORKSPACE_ID, body.idempotencyKey],
    )).toBeUndefined();
  });

  test('cross-workspace provider-human actor rollback leaves the next authorized reservation isolated', async () => {
    const { getBoss } = require('../../lib/pg-boss') as { getBoss: typeof GetPipelineBoss };
    await ownerExecute(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, 'Pipeline Other WS', $2)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
      [PIPE_OTHER_WORKSPACE_ID, wsDir],
    );
    await ownerExecute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES ($1, $2::uuid, 'owner')
       ON CONFLICT (workspace_id, user_auth_id) DO UPDATE SET role = 'owner'`,
      [PIPE_OTHER_WORKSPACE_ID, SECONDARY_AUTH_ID],
    );
    const deniedBody = taskManifestTriggerBody({ dryRun: false, queue: false, mergeStrategy: 'draft-pr' });

    const denied = await postApprovedTaskManifest(deniedBody, SECONDARY_USER_ID);

    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain('not a member of the requested workspace');
    expect(getBoss().send).not.toHaveBeenCalled();
    expect(await queryOne(
      'SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2',
      [PIPE_WORKSPACE_ID, deniedBody.idempotencyKey],
    )).toBeUndefined();

    const authorizedBody = taskManifestTriggerBody({ dryRun: false, queue: false, mergeStrategy: 'draft-pr' });
    const authorized = await postApprovedTaskManifest(authorizedBody);

    expect(authorized.status).toBe(201);
    expect(authorized.body).toEqual(expect.objectContaining({
      ok: true,
      runId: expect.any(Number),
      idempotencyKey: authorizedBody.idempotencyKey,
    }));
    expect(getBoss().send).toHaveBeenCalledTimes(1);
    const reserved = await queryOne<{ id: string }>(
      'SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2',
      [PIPE_WORKSPACE_ID, authorizedBody.idempotencyKey],
    );
    expect(Number(reserved?.id)).toBe(authorized.body.runId);
  });

  test('service-relayed signed command binds one provider-human receipt to immutable TaskManifest lineage', async () => {
    const body = taskManifestTriggerBody({ dryRun: false, queue: true, mergeStrategy: 'draft-pr' });
    const approval = signedTaskManifestApproval(body.manifest);
    process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON = approval.issuerConfig;
    try {
      const res = await request(app)
        .post('/api/pipeline/task-manifests/trigger')
        .set('Authorization', `Bearer ${serviceAuthToken}`)
        .send({ ...body, humanApproval: approval.event });

      expect(res.body).not.toHaveProperty('error');
      expect(res.status).toBe(202);
      expect(res.body.responseIdentity).toEqual(expect.objectContaining({
        manifestHash: approval.event.normalizedCommandHash,
        providerHumanReceiptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }));
      const replay = await request(app)
        .post('/api/pipeline/task-manifests/trigger')
        .set('Authorization', `Bearer ${serviceAuthToken}`)
        .send({ ...body, humanApproval: approval.event });
      expect(replay.status).toBe(202);
      expect(replay.body.runId).toBe(res.body.runId);
      expect(replay.body.responseIdentity.providerHumanReceiptId).toBe(res.body.responseIdentity.providerHumanReceiptId);

      const binding = await queryOne<{
        provider_human_receipt_id: string;
        purpose: string;
        target_hash: string;
        manifest_hash: string;
        actor_id: string;
        receipt_count: string;
      }>(
        `SELECT lineage.provider_human_receipt_id, receipt.purpose, receipt.target_hash,
                receipt.actor_id, lineage.manifest_hash,
                (SELECT COUNT(*) FROM provider_human_authority_receipts candidate
                  WHERE candidate.workspace_id = lineage.workspace_id
                    AND candidate.purpose = receipt.purpose
                    AND candidate.target_hash = receipt.target_hash)::text AS receipt_count
           FROM task_manifest_run_lineage lineage
           JOIN provider_human_authority_receipts receipt ON receipt.id = lineage.provider_human_receipt_id
          WHERE lineage.run_id = $1`,
        [res.body.runId],
      );
      expect(binding).toEqual({
        provider_human_receipt_id: res.body.responseIdentity.providerHumanReceiptId,
        purpose: 'task_manifest_dispatch',
        target_hash: approval.event.normalizedCommandHash,
        actor_id: PRIMARY_USER_ID,
        manifest_hash: approval.event.normalizedCommandHash,
        receipt_count: '1',
      });
    } finally {
      delete process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON;
    }
  });

  test('dry-run validates, writes artifacts, returns estimated plan, and does not enqueue', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({
      dryRun: true,
      agentOverride: 'pi',
      modelOverride: 'claude-sonnet-4-5-20250929',
      effortLevel: 'high',
      mergeStrategy: 'draft-pr',
      terminalMode: 'ansi-html',
    });

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      dryRun: true,
      queued: false,
      manifestId: body.manifest.manifestId,
      idempotencyKey: body.idempotencyKey,
    });
    expect(res.body.artifacts).toEqual(expect.objectContaining({
      manifestPath: expect.stringContaining('manifest.json'),
      tasksMdPath: expect.stringContaining('tasks.md'),
      specPath: expect.stringContaining(`hermes-task-manifest-${body.manifest.manifestId}.json`),
      manifestHash: expect.stringMatching(/^sha256:/),
    }));
    expect(res.body.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'manifest-json', path: res.body.artifacts.manifestPath }),
      expect.objectContaining({ role: 'synthetic-spec', path: res.body.artifacts.specPath }),
    ]));
    expect(res.body.estimatedExecutionPlan).toMatchObject({
      willQueue: false,
      willSpawnSubprocess: false,
      autoMerge: false,
      mergeStrategy: 'draft-pr',
      agentOverride: 'pi',
      modelOverride: 'claude-sonnet-4-5-20250929',
      terminalMode: 'ansi-html',
      resolvedAgentType: 'pi',
      agentSource: 'request.agentOverride',
      modelSource: 'request.modelOverride',
      executionOptionPrecedence: {
        agent: expect.stringContaining('request.agentOverride > manifest.execution.agentOverride'),
        model: expect.stringContaining('request.modelOverride > manifest.execution.modelOverride'),
      },
    });
    expect(fs.existsSync(path.join(wsDir, res.body.artifacts.manifestPath))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, res.body.artifacts.tasksMdPath))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, res.body.artifacts.specPath))).toBe(true);

    const runCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pipeline_runs WHERE workspace_id = 'ws-pipe' AND task_manifest_id = $1`,
      [body.manifest.manifestId],
    );
    expect(Number(runCount?.count ?? '0')).toBe(0);
    expect(getBoss().send).not.toHaveBeenCalled();
  });

  test('queues through pipeline broker with manifest correlation metadata and option pass-through', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      agentOverride: 'pi',
      modelOverride: 'gpt-5.4',
      effortLevel: 'high',
      terminal_mode: 'ansi-html',
      executionEnvironment: 'local-worktree',
      executionEnvironmentId: 'tm-test-env',
    });

    body.manifest.policy.commandDenylist = ['git commit'];
    const executionEnvironmentSupported = hasExecutionEnvironmentSupportInTest();

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      queued: true,
      manifestId: body.manifest.manifestId,
      idempotencyKey: body.idempotencyKey,
      artifacts: expect.objectContaining({ specPath: expect.stringContaining('hermes-task-manifest') }),
    }));
    expect(executionEnvironmentSupported).toBe(true);
    expect(res.body.executionEnvironment).toBe('remote-rorca');
    expect(res.body.executionEnvironmentId).toBeUndefined();

    const run = await queryOne<{
      idempotency_key: string | null;
      task_manifest_id: string | null;
      task_manifest_artifacts: any;
      trigger_options: any;
      merge_strategy: string | null;
      auto_merge: boolean;
      auto_worktree: boolean;
      terminal_mode: string | null;
      agent_type: string | null;
      effective_options: any;
    }>(`SELECT idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options, merge_strategy, auto_merge, auto_worktree, terminal_mode, agent_type, effective_options FROM pipeline_runs WHERE id = $1`, [res.body.runId]);

    expect(run).toMatchObject({
      idempotency_key: body.idempotencyKey,
      task_manifest_id: body.manifest.manifestId,
      merge_strategy: 'draft-pr',
      auto_merge: false,
      auto_worktree: true,
      terminal_mode: 'ansi-html',
      agent_type: 'pi',
      effective_options: expect.objectContaining({
        worktree: expect.objectContaining({ enabled: true, path: expect.any(String), branch: expect.stringMatching(/^feat\//) }),
        merge: { strategy: 'draft-pr', autoMerge: false },
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
      }),
    });
    expect(run?.trigger_options).not.toHaveProperty('readinessOverride');
    expect(run?.task_manifest_artifacts).toEqual(expect.objectContaining({
      manifestPath: res.body.artifacts.manifestPath,
      specPath: res.body.artifacts.specPath,
      manifestHash: res.body.artifacts.manifestHash,
    }));
    expect(run?.trigger_options).toEqual(expect.objectContaining({
      manifestId: body.manifest.manifestId,
      idempotencyKey: body.idempotencyKey,
      manifestHash: res.body.artifacts.manifestHash,
      sourceRefs: expect.objectContaining({
        rorca: expect.objectContaining({ specPath: 'forge/specs/approved/source-spec.json' }),
      }),
      artifactPaths: expect.objectContaining({ specPath: res.body.artifacts.specPath }),
      routeDecision: expect.objectContaining({ route: body.manifest.routeDecision.route }),
      routeDecisionSummary: expect.stringContaining(body.manifest.routeDecision.route),
    }));

    expect(getBoss().createQueue).toHaveBeenCalledWith('pipeline:run');
    expect(getBoss().send).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({
        runId: res.body.runId,
        manifestId: body.manifest.manifestId,
        idempotencyKey: body.idempotencyKey,
        taskManifestArtifacts: expect.objectContaining({ specPath: res.body.artifacts.specPath }),
        agent: 'pi',
        effortLevel: 'high',
        terminalMode: 'ansi-html',
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'draft-pr',
        commandDenylist: expect.arrayContaining(['git commit', 'git push --force']),
      }),
      expect.objectContaining({ retryLimit: 0 }),
    );
    const [, jobPayload] = (getBoss().send as jest.Mock).mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(jobPayload.executionEnvironment).toBe('remote-rorca');
    expect(jobPayload.executionEnvironmentId).toBeUndefined();
  });

  test('request agentOverride=codex beats manifest agentOverride=pi for queued execution', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({
      autoWorktree: true,
      agentOverride: 'codex',
      terminal_mode: 'ansi-html',
    });
    body.manifest.execution.agentOverride = 'pi';

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(201);
    expect(res.body.agentType).toBe('codex');

    const run = await queryOne<{ agent_type: string | null }>(
      `SELECT agent_type FROM pipeline_runs WHERE id = $1`,
      [res.body.runId],
    );
    expect(run?.agent_type).toBe('codex');

    const [, jobPayload] = (getBoss().send as jest.Mock).mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(jobPayload).toEqual(expect.objectContaining({
      runId: res.body.runId,
      agent: 'codex',
      agentOverride: 'codex',
    }));
  });

  test('request agentOverride=opencode with openrouter model passes model through unchanged', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({
      autoWorktree: true,
      agentOverride: 'opencode',
      modelOverride: 'openrouter/z-ai/glm-5',
      terminal_mode: 'ansi-html',
    });
    body.manifest.execution.agentOverride = 'pi';
    body.manifest.execution.modelOverride = 'claude-sonnet-4-5-20250929';

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      agentType: 'opencode',
      agentModel: 'openrouter/z-ai/glm-5',
    }));

    const run = await queryOne<{ agent_type: string | null; agent_model: string | null }>(
      `SELECT agent_type, agent_model FROM pipeline_runs WHERE id = $1`,
      [res.body.runId],
    );
    expect(run).toEqual(expect.objectContaining({
      agent_type: 'opencode',
      agent_model: 'openrouter/z-ai/glm-5',
    }));

    const [, jobPayload] = (getBoss().send as jest.Mock).mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(jobPayload).toEqual(expect.objectContaining({
      agent: 'opencode',
      model: 'openrouter/z-ai/glm-5',
    }));
  });

  test('manifest opencode with Claude model uses shared Claude-to-OpenRouter translation', async () => {
    const body = taskManifestTriggerBody({
      autoWorktree: true,
      terminal_mode: 'ansi-html',
    });
    body.manifest.execution.agentOverride = 'opencode';
    body.manifest.execution.modelOverride = 'claude-sonnet-4-6';

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      agentType: 'opencode',
      agentModel: 'openrouter/anthropic/claude-sonnet-4.6',
    }));

    const run = await queryOne<{ agent_type: string | null; agent_model: string | null }>(
      `SELECT agent_type, agent_model FROM pipeline_runs WHERE id = $1`,
      [res.body.runId],
    );
    expect(run).toEqual(expect.objectContaining({
      agent_type: 'opencode',
      agent_model: 'openrouter/anthropic/claude-sonnet-4.6',
    }));
  });

  test('task manifest without request or manifest overrides uses the default pipeline agent behavior', async () => {
    const { setActiveAgentConfig } = require('../../lib/config') as typeof import('../../lib/config');
    setActiveAgentConfig({ agent: 'claude', model: null });
    delete process.env.RORCA_AGENT;
    delete process.env.RORCA_MODEL;

    const body = taskManifestTriggerBody({
      autoWorktree: true,
      terminal_mode: 'ansi-html',
    });
    delete body.agentOverride;
    delete body.modelOverride;
    delete body.manifest.execution.agentOverride;
    delete body.manifest.execution.modelOverride;

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      agentType: 'claude',
      agentModel: null,
    }));

    const run = await queryOne<{ agent_type: string | null; agent_model: string | null }>(
      `SELECT agent_type, agent_model FROM pipeline_runs WHERE id = $1`,
      [res.body.runId],
    );
    expect(run).toEqual(expect.objectContaining({
      agent_type: 'claude',
      agent_model: null,
    }));
  });

  test('isolated task-manifest run remains worktree-contained when another run is active', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({ autoWorktree: true });
    const activeRun = await ownerQueryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ('forge/specs/approved/existing.json', 'ws-pipe', 'running')
     RETURNING id`,);

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      queued: true,
      manifestId: body.manifest.manifestId,
      idempotencyKey: body.idempotencyKey,
      worktreePath: expect.any(String),
      branchName: expect.any(String),
      responseIdentity: expect.objectContaining({ manifestHash: expect.stringMatching(/^sha256:/) }),
    }));
    expect(res.body.runId).not.toBe(Number(activeRun!.id));
    expect(path.resolve(res.body.worktreePath)).not.toBe(path.resolve(wsDir));
    expect(getBoss().send).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(wsDir, 'forge', 'task-manifests', body.manifest.manifestId, 'manifest.json'))).toBe(true);
  });

  test('duplicate identical request returns the existing manifest run without a second enqueue', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      terminal_mode: 'ansi-html',
    });

    const first = await postApprovedTaskManifest(body);

    expect(first.status).toBe(201);
    const sendCallsAfterFirst = (getBoss().send as jest.Mock).mock.calls.length;

    const second = await postApprovedTaskManifest(body);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(expect.objectContaining({
      ok: true,
      idempotent: true,
      reused: true,
      runId: first.body.runId,
      manifestId: body.manifest.manifestId,
      idempotencyKey: body.idempotencyKey,
      manifestHash: first.body.artifacts.manifestHash,
      artifacts: expect.objectContaining({ specPath: first.body.artifacts.specPath }),
    }));
    expect((getBoss().send as jest.Mock).mock.calls.length).toBe(sendCallsAfterFirst);

    const runCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pipeline_runs WHERE idempotency_key = $1`,
      [body.idempotencyKey],
    );
    expect(Number(runCount?.count ?? '0')).toBe(1);
  });

  test('duplicate same idempotencyKey with different manifest hash returns ConflictError without artifacts or enqueue', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      terminal_mode: 'ansi-html',
    });

    const first = await postApprovedTaskManifest(body);

    expect(first.status).toBe(201);
    const sendCallsAfterFirst = (getBoss().send as jest.Mock).mock.calls.length;
    const manifestPath = path.join(wsDir, first.body.artifacts.manifestPath);
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');

    const conflictingBody = JSON.parse(JSON.stringify(body));
    conflictingBody.manifest.objective = `${conflictingBody.manifest.objective} Conflicting duplicate.`;

    const conflict = await postApprovedTaskManifest(conflictingBody);

    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual(expect.objectContaining({
      code: 'CONFLICT',
      details: expect.objectContaining({
        runId: first.body.runId,
        idempotencyKey: body.idempotencyKey,
        existingManifestHash: first.body.artifacts.manifestHash,
        requestedManifestHash: expect.stringMatching(/^sha256:/),
      }),
    }));
    expect(conflict.body.details.requestedManifestHash).not.toBe(first.body.artifacts.manifestHash);
    expect((getBoss().send as jest.Mock).mock.calls.length).toBe(sendCallsAfterFirst);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);

    const runCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pipeline_runs WHERE idempotency_key = $1`,
      [body.idempotencyKey],
    );
    expect(Number(runCount?.count ?? '0')).toBe(1);
  });

  test('queue=true persists manifest metadata without enqueuing pg-boss immediately', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({
      queue: true,
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      terminal_mode: 'ansi-html',
    });

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      queued: true,
      runId: expect.any(Number),
      queuePosition: 1,
      manifestId: body.manifest.manifestId,
      idempotencyKey: body.idempotencyKey,
      manifestHash: expect.stringMatching(/^sha256:/),
      manifestSource: expect.objectContaining({
        manifestId: body.manifest.manifestId,
        idempotencyKey: body.idempotencyKey,
      }),
    }));
    expect(getBoss().send).not.toHaveBeenCalled();

    const run = await queryOne<{
      status: string;
      triggered_via: string | null;
      idempotency_key: string | null;
      task_manifest_id: string | null;
      task_manifest_artifacts: any;
      trigger_options: any;
    }>(`SELECT status, triggered_via, idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options FROM pipeline_runs WHERE id = $1`, [res.body.runId]);

    expect(run).toEqual(expect.objectContaining({
      status: 'queued',
      triggered_via: 'queue',
      idempotency_key: body.idempotencyKey,
      task_manifest_id: body.manifest.manifestId,
    }));
    expect(run?.task_manifest_artifacts).toEqual(expect.objectContaining({
      manifestHash: res.body.manifestHash,
      manifestPath: res.body.artifacts.manifestPath,
      specPath: res.body.artifacts.specPath,
    }));
    expect(run?.trigger_options).toEqual(expect.objectContaining({
      manifestId: body.manifest.manifestId,
      idempotencyKey: body.idempotencyKey,
      manifestHash: res.body.manifestHash,
      sourceRefs: expect.objectContaining({
        rorca: expect.objectContaining({ specPath: 'forge/specs/approved/source-spec.json' }),
      }),
      artifactPaths: expect.objectContaining({ specPath: res.body.artifacts.specPath }),
      routeDecision: expect.objectContaining({ route: body.manifest.routeDecision.route }),
    }));
  });

  test('queue=true TaskManifest promotion acquires one shared publication and publishes once', async () => {
    const { getBoss } = require('../../lib/pg-boss') as typeof import('../../lib/pg-boss');
    const body = taskManifestTriggerBody({
      queue: true,
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      terminal_mode: 'ansi-html',
    });
    const queued = await postApprovedTaskManifest(body);
    expect(queued.status).toBe(202);

    let promotionBody: Record<string, unknown> | null = null;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      promotionBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const promoted = await request(app)
        .post('/api/pipeline/trigger')
        .set('Authorization', `Bearer ${authToken}`)
        .set('Idempotency-Key', new Headers(init?.headers).get('Idempotency-Key') ?? '')
        .send(promotionBody);
      return new Response(JSON.stringify(promoted.body), {
        status: promoted.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue('ws-pipe');
    const promotionDeadline = Date.now() + 3_000;
    while ((getBoss().send as jest.Mock).mock.calls.length === 0 && Date.now() < promotionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(promotionBody).toEqual(expect.objectContaining({
      taskManifestPromotion: true,
      manifestId: body.manifest.manifestId,
    }));
    expect(promotionBody).not.toHaveProperty('readinessOverride');
    expect(promotionBody).not.toHaveProperty('runAnywayOverride');
    expect(promotionBody).not.toHaveProperty('overrideReadinessGate');
    expect(getBoss().send).toHaveBeenCalledTimes(1);
    const publication = await queryOne<{ state: string; payload_hash: string | null }>(
      'SELECT state, payload_hash FROM pipeline_dispatch_publications WHERE run_id = $1',
      [queued.body.runId],
    );
    expect(publication).toEqual({ state: 'published', payload_hash: expect.stringMatching(/^sha256:/) });
    fetchSpy.mockRestore();
  });

  test('run detail retrieval exposes persisted manifest source metadata after queue restart', async () => {
    const body = taskManifestTriggerBody({
      queue: true,
      autoWorktree: true,
      mergeStrategy: 'draft-pr',
      terminal_mode: 'ansi-html',
    });

    const queued = await postApprovedTaskManifest(body);

    expect(queued.status).toBe(202);

    const detail = await request(app)
      .get(`/api/pipeline/runs/${queued.body.runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(detail.status).toBe(200);
    expect(detail.body.manifestSource).toEqual(expect.objectContaining({
      manifestId: body.manifest.manifestId,
      idempotencyKey: body.idempotencyKey,
      manifestHash: queued.body.manifestHash,
      sourceRefs: expect.objectContaining({
        rorca: expect.objectContaining({
          specPath: 'forge/specs/approved/source-spec.json',
        }),
      }),
      artifactPaths: expect.objectContaining({
        manifestPath: queued.body.artifacts.manifestPath,
        specPath: queued.body.artifacts.specPath,
      }),
      routeDecision: expect.objectContaining({ route: body.manifest.routeDecision.route }),
    }));
    expect(detail.body.run.trigger_options).toEqual(expect.objectContaining({
      manifestHash: queued.body.manifestHash,
    }));
  });

  test.each([
    ['missing workspaceId', (body: Record<string, any>) => { delete body.workspaceId; }, 400],
    ['missing idempotencyKey', (body: Record<string, any>) => { delete body.idempotencyKey; }, 400],
    ['autoMerge=true', (body: Record<string, any>) => { body.autoMerge = true; }, 422],
    ['autoWorktree=false', (body: Record<string, any>) => { body.autoWorktree = false; }, 422],
    ['mergeStrategy=direct', (body: Record<string, any>) => { body.mergeStrategy = 'direct'; }, 422],
    ['mergeStrategy=branch-only', (body: Record<string, any>) => { body.mergeStrategy = 'branch-only'; body.manifest.execution.mergeStrategy = 'branch-only'; }, 422],
    ['outer mergeStrategy differs from manifest', (body: Record<string, any>) => { body.mergeStrategy = 'pr'; body.manifest.execution.mergeStrategy = 'draft-pr'; }, 422],
    ['invalid source authority', (body: Record<string, any>) => { body.workspaceId = 'other-workspace'; }, 400],
    ['direct-repair-ineligible route decision', (body: Record<string, any>) => { body.manifest.routeDecision = { route: 'rorca.spec.run', reason: 'Route through normal spec run.' }; }, 400],
  ])('rejects %s', async (_caseName, mutate, expectedStatus) => {
    const body = taskManifestTriggerBody();
    mutate(body);

    const res = await postApprovedTaskManifest(body);

    expect(res.status).toBe(expectedStatus);
  });

  test('openapi and MCP catalog expose the stable public task-manifest trigger schema', async () => {
    const docsRes = await request(app)
      .get('/api/docs/openapi.json')
      .set('Authorization', `Bearer ${authToken}`);

    expect(docsRes.status).toBe(200);
    const operation = docsRes.body.paths?.['/api/pipeline/task-manifests/trigger']?.post;
    expect(operation).toEqual(expect.objectContaining({
      operationId: 'triggerTaskManifestPipelineRun',
      'x-rorca-tier': 'public',
      'x-rorca-public-api': true,
    }));
    expect(operation['x-rorca-rationale']).toContain('requires a host-created isolated worktree');
    expect(operation.requestBody.content['application/json'].schema.properties.mergeStrategy.enum).toEqual(['pr', 'draft-pr']);
    expect(operation.requestBody.content['application/json'].schema.required).toEqual(expect.arrayContaining(['workspaceId', 'manifest', 'idempotencyKey']));

    const toolsRes = await request(app)
      .get('/api/mcp/tools')
      .set('Authorization', `Bearer ${authToken}`);

    expect(toolsRes.status).toBe(200);
    const names = toolsRes.body.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('rorca_pipeline_task_manifests_trigger');
    expect(names).toContain('rorca_trigger_task_manifest');
    const tool = toolsRes.body.tools.find((item: { name: string }) => item.name === 'rorca_pipeline_task_manifests_trigger');
    expect(tool.requiredParams).toEqual(expect.arrayContaining(['workspaceId', 'manifest', 'idempotencyKey']));
    expect(tool.inputSchema).toEqual(expect.objectContaining({
      workspaceId: expect.any(Object),
      manifest: expect.any(Object),
      idempotencyKey: expect.any(Object),
      mergeStrategy: expect.any(Object),
      terminal_mode: expect.any(Object),
    }));
  });
});
