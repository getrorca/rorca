/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';
import {
  EXECUTION_AUTHORITY_EVIDENCE_KINDS,
  EXECUTION_AUTHORITY_PROFILE_SCHEMA_VERSION,
  EXECUTION_AUTHORITY_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
  type ExecutionAuthorityDisableResult,
  type ExecutionAuthorityProfileRecord,
  type ExecutionAuthorityRolloutEvidenceRecord,
} from '../../db/execution-authority-rollout';
import {
  EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION,
  type AuthorityPreflightRequirementRecord,
  type AuthorityRunPreflightRecord,
} from '../../db/execution-authority-preflight';
import {
  EXECUTION_AUTHORITY_SCHEMA_VERSION,
  type ProviderBindingRecord,
} from '../../db/execution-authority';
import {
  assertExecutionAuthorityMutationProviderAvailable,
  assertExecutionAuthorityProgramCannotSelfApprove,
  assertExecutionAuthorityProgramDeliveryPolicy,
  prepareWorkspaceExecutionAuthorityPreflight,
  recordExecutionAuthorityRolloutEvidence,
  REGISTERED_MUTATION_AUTHORITY_ADAPTER_IDS,
  transitionExecutionAuthorityProfile,
  type ExecutionAuthorityRolloutStore,
} from '../execution-authority-rollout';
import {
  settleExecutionAuthorityPreflight,
  type AuthorityPreflightStore,
} from '../execution-authority-preflight';
import { RequiredCapabilityDeclarationSchema } from '../required-capability';
import { ForbiddenError, UnprocessableError } from '../errors';

const FixtureSchema = z.object({
  schemaVersion: z.literal('rorca.execution-authority-rollout-smoke.v1'),
  workspaceId: z.string().min(1),
  observedAt: z.string().datetime({ offset: true }),
  legacySpec: z.object({
    id: z.string(),
    userStories: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  authorityProgramSpec: z.record(z.string(), z.unknown()),
  requiredCapability: RequiredCapabilityDeclarationSchema,
  evidence: z.array(z.object({
    evidenceKind: z.enum(EXECUTION_AUTHORITY_EVIDENCE_KINDS),
    artifactReference: z.string(),
    evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })).length(EXECUTION_AUTHORITY_EVIDENCE_KINDS.length),
}).strict();

const fixture = FixtureSchema.parse(JSON.parse(await readFile(
  new URL('./fixtures/execution-authority-rollout-smoke.json', import.meta.url),
  'utf8',
)));
const NOW = new Date(fixture.observedAt);

class MemoryRolloutStore implements ExecutionAuthorityRolloutStore {
  profile: ExecutionAuthorityProfileRecord = {
    schemaVersion: EXECUTION_AUTHORITY_PROFILE_SCHEMA_VERSION,
    workspaceId: fixture.workspaceId,
    state: 'disabled',
    generation: 1,
    transitionPrincipal: 'system:migration',
    createdAt: NOW,
    updatedAt: NOW,
    enabledAt: null,
    disabledAt: NOW,
  };
  readonly evidence: ExecutionAuthorityRolloutEvidenceRecord[] = [];
  readonly receipts = [{ id: 'receipt-retained' }];
  readonly auditHistory = [{ id: 'audit-retained' }];
  profileReads = 0;

  async getProfile(workspaceId: string): Promise<ExecutionAuthorityProfileRecord | null> {
    this.profileReads += 1;
    return workspaceId === this.profile.workspaceId ? this.profile : null;
  }

  async listEvidence(workspaceId: string): Promise<ExecutionAuthorityRolloutEvidenceRecord[]> {
    return this.evidence.filter((item) => item.workspaceId === workspaceId);
  }

  async getEvidenceByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<ExecutionAuthorityRolloutEvidenceRecord | null> {
    return this.evidence.find((item) => (
      item.workspaceId === workspaceId && item.idempotencyKey === idempotencyKey
    )) ?? null;
  }

  async appendEvidence(
    input: Parameters<ExecutionAuthorityRolloutStore['appendEvidence']>[0],
  ): Promise<ExecutionAuthorityRolloutEvidenceRecord | null> {
    if (await this.getEvidenceByIdempotencyKey(input.workspaceId, input.idempotencyKey)) return null;
    const record: ExecutionAuthorityRolloutEvidenceRecord = {
      id: `evidence-${this.evidence.length + 1}`,
      schemaVersion: EXECUTION_AUTHORITY_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      evidenceKind: input.evidenceKind,
      result: input.result,
      artifactReference: input.artifactReference,
      evidenceDigest: input.evidenceDigest,
      observedAt: input.observedAt,
      operatorPrincipal: input.operatorPrincipal,
      idempotencyKey: input.idempotencyKey,
      provenance: input.provenance,
      createdAt: new Date(input.observedAt.getTime() + this.evidence.length),
    };
    this.evidence.push(record);
    return record;
  }

  async enableProfile(input: {
    workspaceId: string;
    expectedGeneration: number;
    operatorPrincipal: string;
  }): Promise<ExecutionAuthorityProfileRecord | null> {
    if (input.workspaceId !== this.profile.workspaceId || this.profile.state !== 'disabled'
      || input.expectedGeneration !== this.profile.generation) return null;
    this.profile = {
      ...this.profile,
      state: 'enabled',
      generation: this.profile.generation + 1,
      transitionPrincipal: input.operatorPrincipal,
      updatedAt: NOW,
      enabledAt: NOW,
      disabledAt: null,
    };
    return this.profile;
  }

  async disableProfile(input: {
    workspaceId: string;
    expectedGeneration: number;
    operatorPrincipal: string;
  }): Promise<ExecutionAuthorityDisableResult | null> {
    if (input.workspaceId !== this.profile.workspaceId || this.profile.state !== 'enabled'
      || input.expectedGeneration !== this.profile.generation) return null;
    this.profile = {
      ...this.profile,
      state: 'disabled',
      generation: this.profile.generation + 1,
      transitionPrincipal: input.operatorPrincipal,
      updatedAt: NOW,
      disabledAt: NOW,
    };
    return { profile: this.profile, cancelledRequests: 2, revokedGrants: 1, revokedLeases: 1 };
  }
}

class WaitPreflightStore implements AuthorityPreflightStore {
  preflight: AuthorityRunPreflightRecord | null = null;
  requirement: AuthorityPreflightRequirementRecord | null = null;
  runState: string | null = null;
  intentCreates = 0;

  async transaction<T>(operation: () => Promise<T>): Promise<T> { return operation(); }
  async getActivePreflight(): Promise<AuthorityRunPreflightRecord | null> { return this.preflight; }
  async invalidatePreflight(): Promise<boolean> { return true; }
  async createPreflight(input: Parameters<AuthorityPreflightStore['createPreflight']>[0]): Promise<AuthorityRunPreflightRecord> {
    this.preflight = {
      id: '10000000-0000-4000-8000-000000000001',
      schemaVersion: EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION,
      ...input,
      invalidationReason: null,
      createdAt: NOW,
      updatedAt: NOW,
      invalidatedAt: null,
    };
    return this.preflight;
  }
  async listRequirements(): Promise<AuthorityPreflightRequirementRecord[]> {
    return this.requirement ? [this.requirement] : [];
  }
  async createRequirement(
    input: Parameters<AuthorityPreflightStore['createRequirement']>[0],
  ): Promise<AuthorityPreflightRequirementRecord> {
    this.requirement = {
      id: '20000000-0000-4000-8000-000000000001',
      schemaVersion: EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION,
      ...input,
      createdAt: NOW,
      updatedAt: NOW,
    };
    return this.requirement;
  }
  async updateRequirement(): Promise<AuthorityPreflightRequirementRecord | null> { return this.requirement; }
  async updatePreflight(
    input: Parameters<AuthorityPreflightStore['updatePreflight']>[0],
  ): Promise<AuthorityRunPreflightRecord | null> {
    if (!this.preflight) return null;
    this.preflight = { ...this.preflight, ...input, updatedAt: NOW };
    return this.preflight;
  }
  async createIntent(): Promise<never> {
    this.intentCreates += 1;
    throw new TypeError('Unavailable preflight must not create an operation intent');
  }
  async createRequest(): Promise<never> { throw new TypeError('Unavailable preflight must not create a request'); }
  async getRequest(): Promise<null> { return null; }
  async getGrant(): Promise<null> { return null; }
  async getCompletedStoryIds(): Promise<Set<string>> { return new Set(); }
  async setRunState(_runId: number, status: string): Promise<boolean> {
    this.runState = status;
    return true;
  }
}

function fixtureBinding(): ProviderBindingRecord {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
    workspaceId: fixture.workspaceId,
    bindingReference: fixture.requiredCapability.bindingReference,
    generation: fixture.requiredCapability.bindingGeneration,
    capabilityId: fixture.requiredCapability.capabilityId,
    provider: 'fixture',
    environment: fixture.requiredCapability.scope.environment,
    providerResourceId: fixture.requiredCapability.scope.resource,
    secretReference: 'vault://integration-tokens/rea-008-fixture',
    secretFingerprint: `sha256:${'a'.repeat(64)}`,
    status: 'active',
    configuration: {},
    provenance: { source: 'rea-008-disposable-fixture' },
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

async function attachAllEvidence(store: MemoryRolloutStore): Promise<void> {
  for (const item of fixture.evidence) {
    await recordExecutionAuthorityRolloutEvidence({
      workspaceId: fixture.workspaceId,
      evidenceKind: item.evidenceKind,
      result: 'passed',
      artifactReference: item.artifactReference,
      evidenceDigest: item.evidenceDigest,
      observedAt: NOW,
      operatorPrincipal: 'local-operator:fixture',
      idempotencyKey: `rea-008:${item.evidenceKind}`,
      store,
    });
  }
}

test('disabled profile leaves legacy spec bytes and planning path untouched', async () => {
  const store = new MemoryRolloutStore();
  const bytesBefore = Buffer.from(`${JSON.stringify(fixture.legacySpec)}\n`);
  let bindingReads = 0;
  const preflight = await prepareWorkspaceExecutionAuthorityPreflight({
    workspaceId: fixture.workspaceId,
    specRevision: `sha256:${'b'.repeat(64)}`,
    environment: 'test',
    stories: fixture.legacySpec.userStories,
    profileStore: store,
    preflightDependencies: {
      getLatestBinding: async () => { bindingReads += 1; return fixtureBinding(); },
      getExactBinding: async () => { bindingReads += 1; return fixtureBinding(); },
    },
  });
  const bytesAfter = Buffer.from(`${JSON.stringify(fixture.legacySpec)}\n`);

  assert.equal(preflight, null);
  assert.equal(bindingReads, 0);
  assert.deepEqual(bytesAfter, bytesBefore);
  assert.equal(REGISTERED_MUTATION_AUTHORITY_ADAPTER_IDS.length, 0);
});

test('disposable fixture proves evidence gate, enabled no-provider wait, and lossless disable', async () => {
  const store = new MemoryRolloutStore();
  await recordExecutionAuthorityRolloutEvidence({
    workspaceId: fixture.workspaceId,
    evidenceKind: fixture.evidence[0].evidenceKind,
    result: 'passed',
    artifactReference: fixture.evidence[0].artifactReference,
    evidenceDigest: fixture.evidence[0].evidenceDigest,
    observedAt: NOW,
    operatorPrincipal: 'local-operator:fixture',
    idempotencyKey: 'rea-008:migration',
    store,
  });
  await assert.rejects(transitionExecutionAuthorityProfile({
    workspaceId: fixture.workspaceId,
    enabled: true,
    expectedGeneration: 1,
    operatorPrincipal: 'local-operator:fixture',
    store,
  }), (error: unknown) => error instanceof UnprocessableError
    && error.code === 'EXECUTION_AUTHORITY_EVIDENCE_INCOMPLETE');

  await attachAllEvidence(store);
  const enabled = await transitionExecutionAuthorityProfile({
    workspaceId: fixture.workspaceId,
    enabled: true,
    expectedGeneration: 1,
    operatorPrincipal: 'local-operator:fixture',
    store,
  });
  await assert.rejects(
    assertExecutionAuthorityMutationProviderAvailable(fixture.workspaceId, store),
    /No mutation-capable Execution Authority provider adapter/,
  );
  assert.equal('profile' in enabled ? enabled.profile.state : enabled.state, 'enabled');
  assert.equal(store.evidence.length, 6, 'idempotent migration evidence replay must not duplicate history');

  const binding = fixtureBinding();
  const prepared = await prepareWorkspaceExecutionAuthorityPreflight({
    workspaceId: fixture.workspaceId,
    specRevision: `sha256:${'c'.repeat(64)}`,
    environment: 'test',
    stories: [{ id: 'FIXTURE-001', requiredCapabilities: [fixture.requiredCapability] }],
    profileStore: store,
    preflightDependencies: {
      getLatestBinding: async () => binding,
      getExactBinding: async () => binding,
    },
  });
  assert.ok(prepared);
  assert.equal(prepared.requirements[0]?.assessment.credentialMintability, 'unavailable');
  const preflightStore = new WaitPreflightStore();
  const wait = await settleExecutionAuthorityPreflight({
    runId: 808,
    prepared,
    specRevision: prepared.specRevision,
    now: NOW,
    store: preflightStore,
  });
  assert.equal(wait.status, 'WAITING_FOR_AUTHENTICATION');
  assert.equal(wait.dispatchAllowed, false);
  assert.equal(preflightStore.runState, 'WAITING_FOR_AUTHENTICATION');
  assert.equal(preflightStore.intentCreates, 0);

  const receiptsBefore = JSON.stringify(store.receipts);
  const auditBefore = JSON.stringify(store.auditHistory);
  const disabled = await transitionExecutionAuthorityProfile({
    workspaceId: fixture.workspaceId,
    enabled: false,
    expectedGeneration: 2,
    operatorPrincipal: 'local-operator:fixture',
    store,
  });
  assert.ok('profile' in disabled);
  assert.equal(disabled.profile.state, 'disabled');
  assert.equal(disabled.revokedLeases, 1);
  assert.equal(disabled.receiptsPreserved, true);
  assert.equal(disabled.auditHistoryPreserved, true);
  assert.equal(JSON.stringify(store.receipts), receiptsBefore);
  assert.equal(JSON.stringify(store.auditHistory), auditBefore);
  assert.equal(store.evidence.length, 6);
});

test('pending authority program is isolated branch-only and cannot approve itself', () => {
  assert.doesNotThrow(() => assertExecutionAuthorityProgramDeliveryPolicy({
    spec: fixture.authorityProgramSpec,
    autoWorktree: true,
    autoMerge: false,
    mergeStrategy: 'branch-only',
  }));
  for (const mergeStrategy of ['direct', 'pr', 'draft-pr'] as const) {
    assert.throws(() => assertExecutionAuthorityProgramDeliveryPolicy({
      spec: fixture.authorityProgramSpec,
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy,
    }), (error: unknown) => error instanceof UnprocessableError
      && error.code === 'EXECUTION_AUTHORITY_PROGRAM_BRANCH_ONLY');
  }
  assert.throws(() => assertExecutionAuthorityProgramCannotSelfApprove('REA-007'), ForbiddenError);
});

test('rollout migration and surfaces retain the fail-closed contract without pgboss changes', async () => {
  const migration = await readFile(
    new URL('../../db/pg-migrations/20260824120200_execution_authority_rollout.sql', import.meta.url),
    'utf8',
  );
  const profileRepair = await readFile(
    new URL('../../db/pg-migrations/20260824120300_execution_authority_profile_disabled_at_nullable.sql', import.meta.url),
    'utf8',
  );
  const executableMigration = migration.replace(/--[^\n]*/g, '');
  const persistence = await readFile(new URL('../../db/execution-authority-rollout.ts', import.meta.url), 'utf8');
  const route = await readFile(new URL('../../routes/execution-authority.ts', import.meta.url), 'utf8');
  const pipeline = await readFile(new URL('../../routes/pipeline.ts', import.meta.url), 'utf8');

  assert.match(migration, /execution_authority_profiles/);
  assert.match(migration, /passed_kinds <> 6/);
  assert.match(migration, /credential_lease_profile_(?:insert|activation)_guard/);
  assert.match(migration, /ensure_execution_authority_profile_v1\(\)[\s\S]*SECURITY DEFINER/);
  assert.match(migration, /WHERE workspace_id = NEW\.workspace_id\s+FOR SHARE/);
  assert.match(migration, /execution_authority_rollout_evidence_(?:update|delete)_guard/);
  assert.match(profileRepair, /ALTER COLUMN disabled_at DROP NOT NULL/);
  assert.doesNotMatch(executableMigration, /pgboss\./i);
  assert.doesNotMatch(executableMigration, /\b(?:DROP|TRUNCATE)\b/i);
  assert.match(persistence, /status = 'revoked'/);
  assert.doesNotMatch(persistence, /execution_receipts\s+(?:SET|DELETE)/i);
  assert.match(route, /x-rorca-tier: admin/);
  assert.match(route, /x-rorca-mcp: false/);
  assert.match(pipeline, /prepareWorkspaceExecutionAuthorityPreflight/);
  assert.match(pipeline, /assertExecutionAuthorityProgramDeliveryPolicy/);
});
