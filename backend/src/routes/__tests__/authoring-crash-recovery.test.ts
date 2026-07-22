/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { closePool, execute, queryOne } from '../../db/index';
import specsRouter from '../specs';
import { errorHandler } from '../../lib/error-handler';
import {
  adaptCanonicalStoriesToAuthoringDraft,
  buildLifecycleAuthoringSection,
  runAuthoringPreflight,
} from '../../lib/ssdlc-forge-authoring';
import { planAuthoring } from '../../lib/ssdlc-authoring-planner';
import { stableWalJson } from '../../lib/trusted-wal';

function app() {
  const value = express();
  value.use(express.json({ limit: '2mb' }));
  value.use((req, _res, next) => {
    req.user = { id: 'local-human', email: 'human@example.test', role: 'admin', plan: 'enterprise' } as any;
    next();
  });
  value.use('/api/specs', specsRouter);
  value.use(errorHandler);
  return value;
}

const canonicalStories = [
  {
    id: 'AUTH-001',
    title: 'Users authenticate with explicit outcomes',
    description: 'Users receive an authenticated session or an observable denial without ambiguous state.',
    acceptanceCriteria: ['The service reports an authenticated session for valid credentials.'],
    dependsOn: [],
  },
  {
    id: 'AUTH-002',
    title: 'Operators observe authentication recovery',
    description: 'Operators can verify recovery and safe degradation after authentication failures.',
    acceptanceCriteria: ['A recovery check reports restored authentication behavior after a transient failure.'],
    dependsOn: ['AUTH-001'],
  },
];

type Fixture = {
  workspaceId: string;
  workspacePath: string;
  slug: string;
  requestBody: Record<string, unknown>;
  acceptedPlanHash: string;
  acceptedPreflightHash: string;
};

async function createFixture(label: string): Promise<Fixture> {
  const workspaceId = `authoring-crash-${label}-${crypto.randomUUID()}`;
  const uniqueTitle = `Safe authentication ${label} ${workspaceId.slice(-8)}`;
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-authoring-crash-'));
  await execute('INSERT INTO workspaces (id, label, path) VALUES ($1,$2,$3)', [workspaceId, label, workspacePath]);
  const lifecycle = buildLifecycleAuthoringSection({
    workspaceId,
    title: uniqueTitle,
    brief: 'Users can authenticate and recover safely',
    contextUsed: { text: 'bounded test context', meta: { test: true } },
    contextSummary: { predictedFiles: ['src/auth/session.ts'] },
    invocationSurface: 'test.authoring.crash',
  });
  const planning = planAuthoring(lifecycle.plannerInputSeed);
  if (!planning.acceptedPlan) throw new Error('Fixture authoring plan was not accepted');
  const specs = adaptCanonicalStoriesToAuthoringDraft(planning.acceptedPlan, [{
    specReference: planning.acceptedPlan.specBoundaries[0]!.specReference,
    stories: canonicalStories,
  }]);
  const preflightInput = {
    schemaVersion: 1 as const,
    workspaceId,
    plannerInput: lifecycle.plannerInputSeed,
    specs,
    attempt: 1,
    priorAttempts: [],
    materialRevisions: [],
    callerSurface: 'test.authoring.crash',
    model: 'test-model',
  };
  const accepted = runAuthoringPreflight(preflightInput);
  if (accepted.state !== 'accepted' || !accepted.acceptedPlanHash || !accepted.acceptedPreflightHash) {
    throw new Error(`Fixture preflight was not accepted: ${accepted.state}`);
  }
  const receipt = await queryOne<{ id: number }>(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
     VALUES ('spec_authoring_preflight',$1,'test-authoring',$2::jsonb) RETURNING id`,
    [workspaceId, JSON.stringify({
      state: 'accepted',
      acceptedPlanHash: accepted.acceptedPlanHash,
      acceptedPreflightHash: accepted.acceptedPreflightHash,
    })],
  );
  const slug = planning.acceptedPlan.specBoundaries[0]!.slugSeed;
  return {
    workspaceId,
    workspacePath,
    slug,
    acceptedPlanHash: accepted.acceptedPlanHash,
    acceptedPreflightHash: accepted.acceptedPreflightHash,
    requestBody: {
      workspaceId,
      title: uniqueTitle,
      slug,
      brief: 'Users can authenticate and recover safely',
      stories: canonicalStories,
      source: 'hermes-chatops-skill-first',
      contextUsed: { text: 'Bounded exact authoring crash-recovery context.', meta: { source: 'test' } },
      policyPresetId: 'fast_import',
      authoringPreflight: {
        schemaVersion: 1,
        profileVersion: lifecycle.profileVersion,
        acceptedPlan: planning.acceptedPlan,
        planHash: accepted.acceptedPlanHash,
        specs,
        acceptedPreflightHash: accepted.acceptedPreflightHash,
        preflightAttemptCount: 1,
        priorAttempts: [],
        materialRevisions: [],
        callerSurface: 'test.authoring.crash',
        model: 'test-model',
        preflightReceiptId: receipt!.id,
      },
    },
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  delete process.env.RORCA_AUTHORING_FAILPOINT;
  delete process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON;
  await execute('DELETE FROM authoring_mutation_operations WHERE workspace_id = $1', [fixture.workspaceId]).catch(() => undefined);
  await execute('DELETE FROM provider_human_authority_receipts WHERE workspace_id = $1', [fixture.workspaceId]).catch(() => undefined);
  await execute('DELETE FROM workspaces WHERE id = $1', [fixture.workspaceId]).catch(() => undefined);
  fs.rmSync(fixture.workspacePath, { recursive: true, force: true });
}

async function persistFixture(fixture: Fixture): Promise<Record<string, unknown>> {
  const response = await request(app())
    .post('/api/specs/persist')
    .set('Idempotency-Key', `persist:${crypto.randomUUID()}`)
    .send(fixture.requestBody);
  if (response.status !== 200) throw new Error(`Fixture persistence failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body as Record<string, unknown>;
}

function providerEventForTarget(fixture: Fixture, targetHash: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const issuerId = `issuer-${crypto.randomUUID()}`;
  const keyId = 'authoring-key';
  const providerTenantId = `tenant-${fixture.workspaceId}`;
  process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON = JSON.stringify([{
    issuerId,
    keyId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    provider: 'slack',
    providerTenantId,
    workspaceId: fixture.workspaceId,
  }]);
  const unsigned = {
    schemaVersion: 'provider-human-event.v1' as const,
    issuerId,
    keyId,
    provider: 'slack',
    providerTenantId,
    actorId: `approver-${crypto.randomUUID()}`,
    conversationId: 'authoring-crash-test',
    threadId: 'thread-1',
    messageId: `message-${crypto.randomUUID()}`,
    occurredAt: new Date().toISOString(),
    normalizedCommandHash: targetHash,
    ingressIdempotencyKey: `ingress:${crypto.randomUUID()}`,
  };
  const signature = crypto.sign(null, Buffer.from(stableWalJson(unsigned), 'utf8'), privateKey).toString('base64url');
  return { ...unsigned, signature };
}

const persistFailpoints = [
  'persist_after_claim',
  'persist_after_spec_file_before_diagram',
  'persist_after_file_publication',
  'persist_after_snapshot',
  'persist_after_lifecycle_compilation',
  'persist_after_wal',
  'persist_before_receipt_completion',
] as const;

describe('governed authoring crash roll-forward', () => {
  afterAll(async () => { await closePool(); });
  test.each(persistFailpoints)('persist replay rolls forward exactly after %s', async (failpoint) => {
    const fixture = await createFixture(failpoint.replaceAll('_', '-'));
    const key = `persist:${crypto.randomUUID()}`;
    try {
      process.env.RORCA_AUTHORING_FAILPOINT = failpoint;
      const interrupted = await request(app()).post('/api/specs/persist').set('Idempotency-Key', key).send(fixture.requestBody);
      expect(interrupted.status).toBe(500);

      delete process.env.RORCA_AUTHORING_FAILPOINT;
      const recovered = await request(app()).post('/api/specs/persist').set('Idempotency-Key', key).send(fixture.requestBody);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual(expect.objectContaining({
        slug: fixture.slug,
        mutationReceipt: expect.objectContaining({ receiptId: expect.any(String), requestHash: expect.stringMatching(/^sha256:/) }),
      }));
      const replay = await request(app()).post('/api/specs/persist').set('Idempotency-Key', key).send(fixture.requestBody);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(recovered.body);

      const receiptId = recovered.body.mutationReceipt.receiptId as string;
      const counts = await queryOne<{ versions: string; operations: string; completed_wal: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM spec_versions WHERE spec_slug = $1
             AND content_json::jsonb #>> '{authoring,mutationReceipt,receiptId}' = $2) AS versions,
           (SELECT COUNT(*)::text FROM authoring_mutation_operations WHERE receipt_id = $2::uuid AND state = 'completed') AS operations,
           (SELECT COUNT(*)::text FROM wal_events WHERE ingest_key = $3) AS completed_wal`,
        [fixture.slug, receiptId, `authoring-persist-complete:v1:${receiptId}`],
      );
      expect(counts).toEqual({ versions: '1', operations: '1', completed_wal: '1' });
      expect(fs.existsSync(path.join(fixture.workspacePath, 'forge/specs/pending', `${fixture.slug}-diagrams.md`))).toBe(true);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 90_000);

  test.each([
    'approve_after_claim',
    'approve_after_provider_approval',
    'approve_after_rename',
    'approve_after_wal',
    'approve_before_receipt_completion',
  ] as const)('approval replay rolls forward exactly after %s', async (failpoint) => {
    const fixture = await createFixture(failpoint.replaceAll('_', '-'));
    const approvalKey = `approve:${crypto.randomUUID()}`;
    try {
      const persisted = await persistFixture(fixture);
      const mutationReceipt = persisted.mutationReceipt as Record<string, unknown>;
      const targetRequest = {
        workspaceId: fixture.workspaceId,
        acceptedPlanHash: fixture.acceptedPlanHash,
        acceptedPreflightHash: fixture.acceptedPreflightHash,
        persistReceiptId: mutationReceipt.receiptId,
        persistRequestHash: mutationReceipt.requestHash,
      };
      const target = await request(app()).post(`/api/specs/${fixture.slug}/approval-target`).send(targetRequest);
      if (target.status !== 200) throw new Error(`Approval target failed: ${target.status} ${JSON.stringify(target.body)}`);
      const approvalBody = {
        workspaceId: fixture.workspaceId,
        readinessOverride: false,
        humanApproval: {
          acceptedPlanHash: fixture.acceptedPlanHash,
          acceptedPreflightHash: fixture.acceptedPreflightHash,
          persistReceiptId: mutationReceipt.receiptId,
          persistRequestHash: mutationReceipt.requestHash,
          attestation: providerEventForTarget(fixture, target.body.targetHash),
        },
      };

      process.env.RORCA_AUTHORING_FAILPOINT = failpoint;
      const interrupted = await request(app()).post(`/api/specs/${fixture.slug}/approve`).set('Idempotency-Key', approvalKey).send(approvalBody);
      expect(interrupted.status).toBe(500);
      delete process.env.RORCA_AUTHORING_FAILPOINT;

      const recovered = await request(app()).post(`/api/specs/${fixture.slug}/approve`).set('Idempotency-Key', approvalKey).send(approvalBody);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual(expect.objectContaining({
        ok: true,
        mutationReceipt: expect.objectContaining({ receiptId: expect.any(String), requestHash: expect.stringMatching(/^sha256:/) }),
        providerApproval: expect.objectContaining({ receiptId: expect.any(String), targetHash: target.body.targetHash }),
        responseIdentity: expect.objectContaining({
          schemaVersion: 'rorca.spec-approval-response-identity.v1',
          workspaceId: fixture.workspaceId,
          specId: fixture.slug,
          idempotencyKey: approvalKey,
          targetHash: target.body.targetHash,
          actorId: expect.any(String),
          acceptedPlanHash: fixture.acceptedPlanHash,
          acceptedPreflightHash: fixture.acceptedPreflightHash,
          persistReceiptId: mutationReceipt.receiptId,
          persistRequestHash: mutationReceipt.requestHash,
        }),
      }));
      const replay = await request(app()).post(`/api/specs/${fixture.slug}/approve`).set('Idempotency-Key', approvalKey).send(approvalBody);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(recovered.body);

      const approvalReceiptId = recovered.body.mutationReceipt.receiptId as string;
      const counts = await queryOne<{ operations: string; approval_wal: string; provider_receipts: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM authoring_mutation_operations
             WHERE receipt_id = $1::uuid AND state = 'completed') AS operations,
           (SELECT COUNT(*)::text FROM wal_events WHERE ingest_key = $2) AS approval_wal,
           (SELECT COUNT(*)::text FROM provider_human_authority_receipts
             WHERE workspace_id = $3 AND purpose = 'spec_set_approval') AS provider_receipts`,
        [approvalReceiptId, `authoring-approve:v1:${approvalReceiptId}`, fixture.workspaceId],
      );
      expect(counts).toEqual({ operations: '1', approval_wal: '1', provider_receipts: '1' });
      expect(fs.existsSync(path.join(fixture.workspacePath, 'forge/specs/pending', `${fixture.slug}.json`))).toBe(false);
      expect(fs.existsSync(path.join(fixture.workspacePath, 'forge/specs/approved', `${fixture.slug}.json`))).toBe(true);

      const state = await request(app()).post('/api/specs/authoring/mutation-state').send({
        workspaceId: fixture.workspaceId,
        operation: 'approve',
        idempotencyKey: approvalKey,
        request: { specId: fixture.slug, ...approvalBody },
      });
      expect(state.status).toBe(200);
      expect(state.body).toEqual(expect.objectContaining({
        schemaVersion: 'rorca.authoring-mutation-state.v1',
        completed: true,
        responseBody: recovered.body,
      }));
    } finally {
      await cleanupFixture(fixture);
    }
  }, 90_000);

  test('persist replay rejects receipt-preserving material tampering', async () => {
    const fixture = await createFixture('material-tamper');
    const key = `persist:${crypto.randomUUID()}`;
    try {
      process.env.RORCA_AUTHORING_FAILPOINT = 'persist_after_file_publication';
      expect((await request(app()).post('/api/specs/persist').set('Idempotency-Key', key).send(fixture.requestBody)).status).toBe(500);
      const specPath = path.join(fixture.workspacePath, 'forge/specs/pending', `${fixture.slug}.json`);
      const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      content.title = 'Tampered title';
      fs.writeFileSync(specPath, JSON.stringify(content, null, 2));
      delete process.env.RORCA_AUTHORING_FAILPOINT;
      const replay = await request(app()).post('/api/specs/persist').set('Idempotency-Key', key).send(fixture.requestBody);
      expect(replay.status).toBe(409);
      expect(replay.body.error).toMatch(/material differs/i);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 90_000);
});
