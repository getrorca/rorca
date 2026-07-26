/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import type PgBoss from 'pg-boss';

jest.unmock('pg-boss');
jest.mock('../../lib/autonomous-sandbox', () => {
  const actual = jest.requireActual('../../lib/autonomous-sandbox');
  return { ...actual, assertAutonomousExecutionBoundary: jest.fn() };
});
jest.mock('../../lib/autonomous-model-egress', () => {
  const actual = jest.requireActual('../../lib/autonomous-model-egress');
  return { ...actual, ensureAutonomousModelEgress: jest.fn().mockResolvedValue(null) };
});

const describeLive = process.env.RORCA_RUN_LIVE_CROSS_CERT === '1' ? describe : describe.skip;
const connectionString = process.env.RORCA_TEST_DATABASE_URL || process.env.DATABASE_URL || '';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function stableProviderEventJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableProviderEventJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableProviderEventJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

const nativeImport = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<Record<string, any>>;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describeLive('live Hermes -> Rorca HTTP -> PostgreSQL -> pg-boss -> worker -> child certification [skip: requires RORCA_RUN_LIVE_CROSS_CERT=1 and exact built Hermes artifacts; separately certified by live-built-pair gate]', () => {
  const workspaceId = `live-hermes-${crypto.randomUUID()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-live-hermes-'));
  const repository = path.join(root, 'repository');
  const fakeEngine = path.join(root, 'fake-engine.js');
  const pool = new Pool({ connectionString, max: 3 });
  const serviceToken = crypto.randomBytes(48).toString('base64url');
  const providerKeyPair = crypto.generateKeyPairSync('ed25519');
  const providerTenantId = 'T-LIVE-CERT';
  const signedApproval = (targetHash: string, messageId: string) => {
    const unsigned = {
      schemaVersion: 'provider-human-event.v1' as const,
      issuerId: 'hermes-live-cert', keyId: 'live-cert-ed25519-1', provider: 'slack' as const,
      providerTenantId, actorId: 'U-LIVE-CERT-HUMAN', conversationId: 'C-LIVE-CERT',
      threadId: 'THREAD-LIVE-CERT', messageId, occurredAt: new Date().toISOString(),
      normalizedCommandHash: targetHash, ingressIdempotencyKey: `ingress-${messageId}`,
    };
    return {
      ...unsigned,
      signature: crypto.sign(null, Buffer.from(stableProviderEventJson(unsigned), 'utf8'), providerKeyPair.privateKey).toString('base64url'),
    };
  };
  let server: Server;
  let boss: PgBoss;
  let runId = 0;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    const hermesClientPath = process.env.HERMES_CERT_CLIENT_PATH;
    const hermesManifestPath = process.env.HERMES_CERT_MANIFEST_PATH;
    if (!hermesClientPath || !hermesManifestPath) throw new Error('Exact built Hermes client/manifest paths are required');
    if (!connectionString) throw new Error('Dedicated certification DATABASE_URL is required');

    fs.mkdirSync(repository, { recursive: true });
    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', 'user.email', 'cert@example.test']);
    git(repository, ['config', 'user.name', 'Rorca Certification']);
    fs.writeFileSync(path.join(repository, 'README.md'), 'live cross-service fixture\n');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'fixture base']);
    fs.writeFileSync(fakeEngine, `
const timeout = setTimeout(() => process.exit(98), 10000);
process.on('message', (message) => {
  if (!message || message.type !== 'launch_start' || !message.token) return;
  clearTimeout(timeout);
  if (process.send) process.send({ type: 'pid', pid: process.pid });
  process.stderr.write('exact fake engine child exit 17\\n');
  setTimeout(() => process.exit(17), 25);
});
`, { mode: 0o700 });
    process.env.RORCA_INTERNAL_SERVICE_TOKEN = serviceToken;
    process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON = JSON.stringify([{
      issuerId: 'hermes-live-cert', keyId: 'live-cert-ed25519-1',
      publicKeyPem: providerKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      provider: 'slack', providerTenantId, workspaceId,
    }]);
    process.env.RORCA_TEST_EXECUTION_ENGINE_ENTRYPOINT = fakeEngine;
    process.env.RORCA_PGBOSS_SCHEMA = 'pgboss_live_cross_cert';
    process.env.RORCA_DISABLE_BACKGROUND_RUNTIME = 'true';
    process.env.RORCA_SERVE_STATIC = '0';
    process.env.MCP_HTTP_ENABLED = 'false';

    await pool.query(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Live Hermes certification', $2)`,
      [workspaceId, repository],
    );
    await pool.query(
      `INSERT INTO execution_environments (id, label, kind, enabled, supported_agents)
       VALUES ('remote-rorca', 'Remote Rorca certification runtime', 'remote-rorca', TRUE,
               ARRAY['claude','codex','opencode','pi']::text[])
       ON CONFLICT (id) DO NOTHING`,
    );

    const appDb = await import('../../db/index');
    const applicationIdentity = await appDb.queryOne<{ user_name: string; database_name: string; schema_name: string }>(
      'SELECT current_user AS user_name, current_database() AS database_name, current_schema() AS schema_name',
    );
    const visibleWorkspace = await appDb.queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
    if (!visibleWorkspace || applicationIdentity?.user_name !== 'rorca_test_runner'
      || applicationIdentity.database_name !== 'rorca_cert_test' || applicationIdentity.schema_name !== 'rorca') {
      throw new Error(`Live certification DB identity mismatch: ${JSON.stringify({ applicationIdentity, visibleWorkspace })}`);
    }

    const { initBoss, getBoss } = await import('../../lib/pg-boss');
    const { handlePipelineRun } = await import('../../worker');
    await initBoss();
    boss = getBoss();
    await boss.work('pipeline:run', { batchSize: 1 }, handlePipelineRun);

    const app = (await import('../../server')).default;
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Live test server has no TCP address');
    process.env.PORT = String(address.port);
  }, 60_000);

  beforeEach(async () => {
    // Global Jest isolation intentionally truncates application tables after
    // this suite's beforeAll. Re-seed only application-owned fixture rows here;
    // pg-boss remains solely responsible for its configured transport schema.
    await pool.query(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Live Hermes certification', $2)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
      [workspaceId, repository],
    );
    await pool.query(
      `INSERT INTO execution_environments (id, label, kind, enabled, supported_agents)
       VALUES ('remote-rorca', 'Remote Rorca certification runtime', 'remote-rorca', TRUE,
               ARRAY['claude','codex','opencode','pi']::text[])
       ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch ?? globalThis.fetch;
    if (boss) {
      const offWork = (boss as unknown as { offWork?: (name: string) => Promise<void> }).offWork;
      if (typeof offWork === 'function') await offWork.call(boss, 'pipeline:run').catch(() => undefined);
      await boss.stop({ timeout: 5_000 }).catch(() => undefined);
    }
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // TaskManifest lineage and trusted closeout evidence are append-only by
    // design. Certification fixtures remain in the dedicated test database and
    // are scoped by this unique workspace/idempotency identity.
    await pool.end();
    delete process.env.RORCA_INTERNAL_SERVICE_TOKEN;
    delete process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON;
    delete process.env.RORCA_TEST_EXECUTION_ENGINE_ENTRYPOINT;
    delete process.env.RORCA_PGBOSS_SCHEMA;
    delete process.env.RORCA_TASK_MANIFEST_FAILPOINT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reconciles response loss to one no-deploy lineage and a trusted nonzero-child closeout', async () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Live server is unavailable');
    const apiUrl = `http://127.0.0.1:${address.port}/api`;
    const hermesClientPath = process.env.HERMES_CERT_CLIENT_PATH!;
    const hermesManifestPath = process.env.HERMES_CERT_MANIFEST_PATH!;
    const { RorcaClient } = await nativeImport(pathToFileURL(path.resolve(hermesClientPath)).href);
    const { compileTaskManifestIntent, taskManifestApprovalTargetHash } = await nativeImport(pathToFileURL(path.resolve(hermesManifestPath)).href);
    const compiled = compileTaskManifestIntent({
      workspaceId,
      task: 'Add one bounded documentation note in the named README component and validate it in a branch',
      rawText: 'bounded README documentation note in a branch',
      normalizedText: 'bounded README documentation note in a branch',
      target: 'README.md',
      bounded: true,
      branchMode: 'branch-required',
      sourceRefs: {
        provider: 'certification', source: 'exact-live-e2e', channelId: 'cert-channel',
        threadTs: '1710547480.000100', messageTs: '1710547480.000101',
        messageId: `cert-${crypto.randomUUID()}`, userId: 'cert-operator',
      },
      validationCommands: ['git diff --check'],
      executionHints: { agentOverride: 'claude', terminalMode: 'ansi-html', mergeStrategy: 'draft-pr' },
    });
    expect(compiled.status).toBe('ok');
    const manifest = compiled.manifest;
    const manifestApproval = signedApproval(taskManifestApprovalTargetHash(manifest), `approval-${manifest.manifestId}`);
    const client = new RorcaClient({
      RORCA_API_URL: apiUrl,
      RORCA_API_TOKEN: serviceToken,
      RORCA_DEFAULT_WORKSPACE_ID: workspaceId,
    });

    originalFetch = globalThis.fetch;
    let lost = false;
    let acceptedHttp: { status: number; body: string } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const url = String(input);
      if (!lost && init?.method === 'POST' && url.endsWith('/pipeline/task-manifests/trigger')) {
        lost = true;
        acceptedHttp = { status: response.status, body: await response.clone().text() };
        throw new Error('simulated response loss after canonical HTTP acceptance');
      }
      return response;
    }) as typeof fetch;
    const ambiguous = await client.triggerTaskManifestExecution({
      workspaceId,
      manifest,
      idempotencyKey: manifest.idempotencyKey,
      humanApproval: manifestApproval,
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'draft-pr',
      terminalMode: 'ansi-html',
    });
    expect(ambiguous).toMatchObject({ ok: false, status: 'feature-unavailable', httpStatus: 0 });
    if (acceptedHttp?.status !== 201) {
      throw new Error(`live TaskManifest acceptance failed: ${JSON.stringify(acceptedHttp)}`);
    }
    globalThis.fetch = originalFetch;

    const replay = await client.triggerTaskManifestExecution({
      workspaceId,
      manifest,
      idempotencyKey: manifest.idempotencyKey,
      humanApproval: manifestApproval,
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'draft-pr',
      terminalMode: 'ansi-html',
    });
    runId = Number(replay.runId ?? replay.dispatchOutcome?.runId ?? (replay.data as { runId?: number } | undefined)?.runId);
    expect(runId).toBeGreaterThan(0);
    expect(['queued', 'already_queued', 'running', 'terminal_failure']).toContain(replay.dispatchOutcome?.disposition);
    expect(await waitFor(async () => {
      const row = await pool.query<{ status: string }>('SELECT status FROM pipeline_runs WHERE id = $1', [runId]);
      return ['failed', 'partial_failure'].includes(row.rows[0]?.status);
    })).toBe(true);
    expect(await waitFor(async () => {
      const row = await pool.query(
        `SELECT 1 FROM wal_events WHERE canonical_run_id = $1
          AND event_type = 'run_closeout' AND trust_provenance = 'host'
          AND trusted_source = 'worker'`,
        [runId],
      );
      return row.rowCount === 1;
    })).toBe(true);

    const authority = await pool.query<{
      run_count: string; lineage_count: string; job_count: string; safety_deploy: boolean;
      merge_strategy: string; auto_merge: boolean; authority_version: number;
      closeout_count: string; child_exit: number | null; provider_receipt_count: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2)::text AS run_count,
         (SELECT COUNT(*) FROM task_manifest_run_lineage WHERE run_id = $3)::text AS lineage_count,
         (SELECT COUNT(*) FROM task_manifest_run_lineage lineage
           JOIN provider_human_authority_receipts receipt ON receipt.id = lineage.provider_human_receipt_id
          WHERE lineage.run_id = $3 AND receipt.purpose = 'task_manifest_dispatch'
            AND receipt.target_hash = lineage.manifest_hash)::text AS provider_receipt_count,
         (SELECT COUNT(*) FROM pgboss_live_cross_cert.job
           WHERE name = 'pipeline:run' AND data->>'runId' = $3::text)::text AS job_count,
         (SELECT (effective_options->'safety'->>'deploy')::boolean FROM pipeline_runs WHERE id = $3) AS safety_deploy,
         (SELECT merge_strategy FROM pipeline_runs WHERE id = $3) AS merge_strategy,
         (SELECT auto_merge FROM pipeline_runs WHERE id = $3) AS auto_merge,
         (SELECT task_manifest_authority_version FROM pipeline_runs WHERE id = $3) AS authority_version,
         (SELECT COUNT(*) FROM wal_events WHERE canonical_run_id = $3
           AND event_type = 'run_closeout' AND trust_provenance = 'host'
           AND trusted_source = 'worker')::text AS closeout_count,
         (SELECT (payload->>'exit_code')::integer FROM wal_events
           WHERE workspace_id = $1 AND payload->>'run_id' = $3::text
             AND event_type = 'run_process_finished'
           ORDER BY id DESC LIMIT 1) AS child_exit`,
      [workspaceId, manifest.idempotencyKey, runId],
    );
    expect(authority.rows[0]).toMatchObject({
      run_count: '1', lineage_count: '1', provider_receipt_count: '1', job_count: '1',
      safety_deploy: false, merge_strategy: 'draft-pr', auto_merge: false,
      authority_version: 1, closeout_count: '1', child_exit: 17,
    });

    const terminalReplay = await client.triggerTaskManifestExecution({
      workspaceId,
      manifest,
      idempotencyKey: manifest.idempotencyKey,
      humanApproval: manifestApproval,
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'draft-pr',
      terminalMode: 'ansi-html',
    });
    expect(terminalReplay.dispatchOutcome?.disposition).toBe('terminal_failure');
    expect(terminalReplay.dispatchOutcome?.runId).toBe(runId);

    const interruptedCompiled = compileTaskManifestIntent({
      workspaceId,
      task: 'Add a second bounded documentation note in README and validate it in a branch',
      rawText: 'second bounded README documentation note in a branch',
      normalizedText: 'second bounded README documentation note in a branch',
      target: 'README.md',
      bounded: true,
      branchMode: 'branch-required',
      sourceRefs: {
        provider: 'certification', source: 'reservation-recovery', channelId: 'cert-channel',
        messageId: `cert-${crypto.randomUUID()}`, actorId: 'cert-operator',
        occurredAt: '2024-03-16T00:04:41.000Z',
      },
      constraints: ['Do not deploy'],
      acceptanceCriteria: ['README remains valid'],
      validationCommands: ['git diff --check'],
      executionHints: { agentOverride: 'claude', terminalMode: 'ansi-html', mergeStrategy: 'draft-pr' },
    });
    const interruptedManifest = interruptedCompiled.manifest;
    const interruptedApproval = signedApproval(
      taskManifestApprovalTargetHash(interruptedManifest),
      `approval-${interruptedManifest.manifestId}`,
    );
    process.env.RORCA_TASK_MANIFEST_FAILPOINT = 'after_reservation_before_preparation';
    try {
      await expect(client.triggerTaskManifestExecution({
        workspaceId,
        manifest: interruptedManifest,
        idempotencyKey: interruptedManifest.idempotencyKey,
        humanApproval: interruptedApproval,
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'draft-pr',
        terminalMode: 'ansi-html',
      })).rejects.toThrow();
    } finally {
      delete process.env.RORCA_TASK_MANIFEST_FAILPOINT;
    }
    const interruptedReservation = await pool.query<{
      id: number; branch_name: string | null; execution_worktree_path: string | null;
    }>(
      `SELECT id, branch_name, execution_worktree_path FROM pipeline_runs
        WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, interruptedManifest.idempotencyKey],
    );
    expect(interruptedReservation.rows).toHaveLength(1);
    expect(interruptedReservation.rows[0]).toMatchObject({
      branch_name: null,
      execution_worktree_path: null,
    });
    const interruptedRunId = Number(interruptedReservation.rows[0].id);
    expect((await pool.query(
      `SELECT 1 FROM pgboss_live_cross_cert.job
        WHERE name = 'pipeline:run' AND data->>'runId' = $1::text`,
      [interruptedRunId],
    )).rowCount).toBe(0);

    const interruptedReplay = await client.triggerTaskManifestExecution({
      workspaceId,
      manifest: interruptedManifest,
      idempotencyKey: interruptedManifest.idempotencyKey,
      humanApproval: interruptedApproval,
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'draft-pr',
      terminalMode: 'ansi-html',
    });
    expect(interruptedReplay.dispatchOutcome?.runId).toBe(interruptedRunId);
    expect(interruptedReplay.dispatchOutcome?.disposition).toBe('queued');
    expect(await waitFor(async () => {
      const row = await pool.query(
        `SELECT 1 FROM wal_events WHERE canonical_run_id = $1
          AND event_type = 'run_closeout' AND trust_provenance = 'host'
          AND trusted_source = 'worker'`,
        [interruptedRunId],
      );
      return row.rowCount === 1;
    })).toBe(true);
    expect((await pool.query(
      `SELECT COUNT(*)::text AS count FROM pgboss_live_cross_cert.job
        WHERE name = 'pipeline:run' AND data->>'runId' = $1::text`,
      [interruptedRunId],
    )).rows[0].count).toBe('1');

    const wrongScope = { ...manifest, workspaceId: `${workspaceId}-wrong` };
    await expect(client.triggerTaskManifestExecution({
      workspaceId,
      manifest: wrongScope,
      idempotencyKey: manifest.idempotencyKey,
      autoMerge: false,
      mergeStrategy: 'draft-pr',
    })).rejects.toThrow();
    expect((await pool.query(
      'SELECT COUNT(*)::text AS count FROM pipeline_runs WHERE idempotency_key = $1',
      [manifest.idempotencyKey],
    )).rows[0].count).toBe('1');
  }, 90_000);
});
