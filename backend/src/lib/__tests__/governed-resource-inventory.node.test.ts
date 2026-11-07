/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CanonicalResourceInventory,
  DeterministicFakeResourceProvider,
  GovernedResourceSaga,
  type OffboardRequest,
  type ProvisionRequest,
  type CanonicalResourceInventoryRow,
  type OffboardAuthorityPort,
  type VerifiedOffboardState,
} from '../governed-resource-inventory';
import { governedOperationsHash } from '../governed-operations-primitives';

const NOW = Date.parse('2026-08-05T14:00:00.000Z');
const OWNER_LABELS = Object.freeze({ 'rorca.workspace': 'workspace:a', 'rorca.owner': 'wave4-pilot', 'rorca.managed': 'true' });
const OFFBOARD_RECEIPT_HASH = governedOperationsHash('offboard-authorization');
class OffboardAuthorityFixture implements OffboardAuthorityPort {
  activeLeaseOrDispatch = false;
  sharedDependency = false;
  deny = false;
  cleanupActiveLeaseOrDispatch = false;
  async verifyAuthorization(request: OffboardRequest, inventory: CanonicalResourceInventoryRow): Promise<VerifiedOffboardState | null> {
    if (this.deny) return null;
    return this.state(request, inventory, this.activeLeaseOrDispatch);
  }
  async reobserveCleanupState(request: OffboardRequest, inventory: CanonicalResourceInventoryRow): Promise<VerifiedOffboardState | null> {
    if (this.deny) return null;
    return this.state(request, inventory, this.cleanupActiveLeaseOrDispatch);
  }
  private state(request: OffboardRequest, inventory: CanonicalResourceInventoryRow, activeLeaseOrDispatch: boolean): VerifiedOffboardState {
    const material = { workspaceId: request.workspaceId, externalId: request.externalId, inventoryHash: inventory.rowHash,
      activeLeaseOrDispatch, sharedDependency: this.sharedDependency };
    return { authorizationReceiptId: request.authorizationReceiptId, authorizationReceiptHash: request.authorizationReceiptHash,
      workspaceId: request.workspaceId, resourceType: request.resourceType, externalId: request.externalId,
      inventoryHash: inventory.rowHash, expiresAt: NOW + 60_000, activeLeaseOrDispatch,
      sharedDependency: this.sharedDependency, observationHash: governedOperationsHash(material) };
  }
}

function request(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return { sagaId: 'saga:provision:1', idempotencyKey: 'provision:1', workspaceId: 'workspace:a',
    resourceType: 'provider_project', ownerLabels: OWNER_LABELS, provider: 'fake-provider', accountId: 'account:fixture',
    region: 'local-1', desiredRevision: 'revision:2', credentialReferenceId: 'vault://workspace-a/provider/credential/v2',
    dependencies: ['dependency:runtime'], retentionClass: 'evidence_retained', authorityHealthy: true,
    capabilityHealthy: true, quotaUnits: 1, ...overrides };
}

async function provisioned(kind: 'local_fake_provider' | 'local_fake_forgejo' = 'local_fake_provider') {
  const inventory = new CanonicalResourceInventory();
  const provider = new DeterministicFakeResourceProvider(kind);
  const authority = new OffboardAuthorityFixture();
  const saga = new GovernedResourceSaga(inventory, provider, authority, () => NOW);
  const provisionRequest = request({ resourceType: kind === 'local_fake_forgejo' ? 'forgejo_repository' : 'provider_project' });
  const result = await saga.provision(provisionRequest);
  assert.equal(result.status, 'admitted');
  assert.ok(result.externalId);
  const row = inventory.get(provisionRequest.workspaceId, provisionRequest.resourceType, result.externalId);
  assert.ok(row);
  return { inventory, provider, authority, saga, provisionRequest, result, row };
}

test('W4-013 provisions all authority/quota/adopt-or-create/PATCH/verify/record/admit stages into canonical inventory', async () => {
  const { provider, result, row } = await provisioned();
  assert.deepEqual(result.stages.map(stage => stage.stage), ['authority_capability_health', 'quota_reserve',
    'create_or_adopt', 'identity_preserving_patch', 'verify', 'record_inventory', 'admit']);
  assert.ok(result.stages.every(stage => stage.compensationId && stage.indeterminateAction));
  assert.deepEqual(provider.calls, ['create', 'patch', 'verify']);
  assert.equal(provider.calls.includes('delete'), false);
  assert.equal(result.realProviderMutation, false);
  assert.equal(row.schemaVersion, 'rorca.workspace-resource-inventory.v1');
  assert.equal(row.workspaceId, 'workspace:a');
  assert.equal(row.externalId, result.externalId);
  assert.deepEqual(row.ownerLabels, OWNER_LABELS);
  assert.equal(row.provider, 'fake-provider');
  assert.equal(row.accountId, 'account:fixture');
  assert.equal(row.region, 'local-1');
  assert.equal(row.desiredRevision, 'revision:2');
  assert.equal(row.observedRevision, 'revision:2');
  assert.equal(row.credentialReferenceId, 'vault://workspace-a/provider/credential/v2');
  assert.deepEqual(row.dependencies, ['dependency:runtime']);
  assert.equal(row.retentionClass, 'evidence_retained');
  assert.equal(row.lifecycleStatus, 'admitted');
  assert.equal(row.createdAt, new Date(NOW).toISOString());
  assert.match(row.rowHash, /^sha256:[0-9a-f]{64}$/);
});

test('W4-013 discovery without exact owner labels and inventory linkage is quarantine-only with zero mutation', async () => {
  const { inventory, result, row } = await provisioned(); assert.ok(result.externalId);
  const exact = inventory.observeDiscovery('workspace:a', OWNER_LABELS, { externalId: result.externalId,
    resourceType: 'provider_project', ownerLabels: OWNER_LABELS, provider: row.provider, accountId: row.accountId,
    region: row.region, revision: row.observedRevision, linkedInventoryHash: row.rowHash, shared: false, referenced: false });
  assert.equal(exact.status, 'linked');
  const fixtures = [
    { externalId: 'unknown:1', ownerLabels: OWNER_LABELS, linkedInventoryHash: null, shared: false, referenced: false },
    { externalId: result.externalId, ownerLabels: { ...OWNER_LABELS, 'rorca.workspace': 'workspace:b' }, linkedInventoryHash: row.rowHash, shared: false, referenced: false },
    { externalId: result.externalId, ownerLabels: OWNER_LABELS, linkedInventoryHash: row.rowHash, shared: true, referenced: false },
    { externalId: result.externalId, ownerLabels: OWNER_LABELS, linkedInventoryHash: row.rowHash, shared: false, referenced: true },
  ];
  for (const fixture of fixtures) {
    const observed = inventory.observeDiscovery('workspace:a', OWNER_LABELS, { resourceType: 'provider_project',
      provider: row.provider, accountId: row.accountId, region: row.region, revision: row.observedRevision, ...fixture });
    assert.equal(observed.status, 'quarantined_observation');
    assert.equal(observed.mutationCount, 0);
  }
  assert.equal(inventory.get('workspace:a', 'provider_project', result.externalId)?.rowHash, row.rowHash);
});

test('W4-013 duplicate provisioning is idempotent, changed replay rejects, and provider uncertainty creates no replacement', async () => {
  const inventory = new CanonicalResourceInventory();
  const provider = new DeterministicFakeResourceProvider();
  const saga = new GovernedResourceSaga(inventory, provider, new OffboardAuthorityFixture(), () => NOW);
  const input = request();
  const first = await saga.provision(input);
  const calls = [...provider.calls];
  assert.deepEqual(await saga.provision(input), first);
  assert.deepEqual(provider.calls, calls);
  await assert.rejects(saga.provision({ ...input, desiredRevision: 'revision:changed' }), /Changed saga replay/);

  const uncertainProvider = new DeterministicFakeResourceProvider(); uncertainProvider.nextCreateOutcome = 'timeout';
  const uncertainSaga = new GovernedResourceSaga(new CanonicalResourceInventory(), uncertainProvider, new OffboardAuthorityFixture(), () => NOW);
  const uncertainInput = request({ sagaId: 'saga:timeout', idempotencyKey: 'provision:timeout' });
  const uncertain = await uncertainSaga.provision(uncertainInput);
  assert.equal(uncertain.status, 'indeterminate');
  assert.equal(uncertainProvider.calls.filter(call => call === 'create').length, 1);
  assert.deepEqual(await uncertainSaga.provision(uncertainInput), uncertain);
  assert.equal(uncertainProvider.calls.filter(call => call === 'create').length, 1);
});

test('W4-013 compensation and stale inventory fail closed without delete/recreate', async () => {
  const inventory = new CanonicalResourceInventory();
  const provider = new DeterministicFakeResourceProvider(); provider.verifyRevisionOverride = 'stale-provider-revision';
  const saga = new GovernedResourceSaga(inventory, provider, new OffboardAuthorityFixture(), () => NOW);
  const compensated = await saga.provision(request({ sagaId: 'saga:compensated', idempotencyKey: 'provision:compensated' }));
  assert.equal(compensated.status, 'blocked');
  assert.equal(compensated.stages.at(-1)?.status, 'compensated');
  assert.equal(provider.calls.includes('compensate'), true);
  assert.equal(provider.calls.includes('delete'), false);

  const failedProvider = new DeterministicFakeResourceProvider();
  failedProvider.verifyRevisionOverride = 'stale-provider-revision'; failedProvider.failCompensation = true;
  const failed = await new GovernedResourceSaga(new CanonicalResourceInventory(), failedProvider, new OffboardAuthorityFixture(), () => NOW)
    .provision(request({ sagaId: 'saga:failed-compensation', idempotencyKey: 'provision:failed-compensation' }));
  assert.equal(failed.status, 'quarantined');
  assert.equal(failed.stages.at(-1)?.status, 'indeterminate');

  const established = await provisioned();
  assert.throws(() => established.inventory.updateObserved('workspace:a', established.provisionRequest.resourceType,
    established.result.externalId!, governedOperationsHash('stale'), { observedRevision: 'other',
      updatedAt: new Date(NOW).toISOString(), lifecycleStatus: 'admitted' }), /Stale inventory/);
});

test('W4-013 separately authorized offboarding blocks active leases and shared dependencies, then replays safely', async () => {
  const blockedLease = await provisioned('local_fake_forgejo');
  blockedLease.authority.activeLeaseOrDispatch = true;
  const base: OffboardRequest = { sagaId: 'saga:offboard:1', idempotencyKey: 'offboard:1', workspaceId: 'workspace:a',
    resourceType: blockedLease.provisionRequest.resourceType, externalId: blockedLease.result.externalId!,
    inventoryHash: blockedLease.inventory.get('workspace:a', blockedLease.provisionRequest.resourceType, blockedLease.result.externalId!)!.rowHash,
    authorizationReceiptId: 'offboard-authorization:1', authorizationReceiptHash: OFFBOARD_RECEIPT_HASH,
    cleanupPreviewHash: governedOperationsHash({ cleanup: blockedLease.result.externalId }) };
  const blocked = await blockedLease.saga.offboard(base);
  assert.equal(blocked.status, 'quarantined');
  assert.equal(blocked.stages.at(-1)?.stage, 'verify_no_active_lease_dispatch');
  assert.equal(blockedLease.provider.calls.includes('delete'), false);

  const shared = await provisioned();
  shared.authority.sharedDependency = true;
  const sharedRequest: OffboardRequest = { ...base, sagaId: 'saga:offboard:shared', idempotencyKey: 'offboard:shared',
    resourceType: shared.provisionRequest.resourceType, externalId: shared.result.externalId!,
    inventoryHash: shared.row.rowHash };
  const sharedResult = await shared.saga.offboard(sharedRequest);
  assert.equal(sharedResult.status, 'quarantined');
  assert.equal(sharedResult.stages.at(-1)?.stage, 'detach_dependencies');
  assert.equal(shared.provider.calls.includes('delete'), false);

  const completed = await provisioned();
  const completedRequest: OffboardRequest = { ...base, sagaId: 'saga:offboard:complete', idempotencyKey: 'offboard:complete',
    resourceType: completed.provisionRequest.resourceType, externalId: completed.result.externalId!,
    inventoryHash: completed.row.rowHash };
  const offboarded = await completed.saga.offboard(completedRequest);
  assert.equal(offboarded.status, 'offboarded');
  assert.deepEqual(offboarded.stages.map(stage => stage.stage), ['authorize_offboarding', 'revoke_admission', 'fence_quarantine',
    'verify_no_active_lease_dispatch', 'rotate_revoke_credentials', 'archive_retained_evidence', 'detach_dependencies',
    'preview_cleanup', 'execute_cleanup', 'verify_inventory']);
  const calls = [...completed.provider.calls];
  assert.deepEqual(await completed.saga.offboard(completedRequest), offboarded);
  assert.deepEqual(completed.provider.calls, calls);
  assert.equal(completed.inventory.get('workspace:a', completed.provisionRequest.resourceType,
    completed.result.externalId!)?.lifecycleStatus, 'offboarded');
});

test('W4-013 offboarding ignores caller claims and re-observes authority, leases, dispatches, and dependencies before delete', async () => {
  const fixture = await provisioned();
  const requestValue: OffboardRequest = { sagaId: 'offboard:race', idempotencyKey: 'offboard:race',
    workspaceId: 'workspace:a', resourceType: fixture.provisionRequest.resourceType,
    externalId: fixture.result.externalId!, inventoryHash: fixture.row.rowHash,
    authorizationReceiptId: 'receipt:offboard:race', authorizationReceiptHash: OFFBOARD_RECEIPT_HASH,
    cleanupPreviewHash: governedOperationsHash('cleanup:race') };
  fixture.authority.cleanupActiveLeaseOrDispatch = true;
  const result = await fixture.saga.offboard(requestValue);
  assert.equal(result.status, 'quarantined');
  assert.equal(result.stages.at(-1)?.stage, 'execute_cleanup');
  assert.equal(fixture.provider.calls.includes('delete'), false);

  const denied = await provisioned();
  denied.authority.deny = true;
  const deniedResult = await denied.saga.offboard({ ...requestValue, sagaId: 'offboard:denied',
    idempotencyKey: 'offboard:denied', externalId: denied.result.externalId!, inventoryHash: denied.row.rowHash });
  assert.equal(deniedResult.status, 'blocked');
  assert.equal(denied.provider.calls.includes('delete'), false);
});

test('W4-013 replacement is a distinct reviewed new-identity saga with immutable lineage', async () => {
  const established = await provisioned();
  const replacement = request({ sagaId: 'saga:replacement', idempotencyKey: 'provision:replacement',
    desiredRevision: 'revision:replacement', replacement: { priorExternalId: established.result.externalId!,
      priorInventoryHash: established.row.rowHash, reviewHash: governedOperationsHash('independent replacement review'),
      revalidated: true, compensationId: 'compensation:restore-prior-admission' } });
  const result = await established.saga.provision(replacement);
  assert.equal(result.status, 'admitted');
  assert.notEqual(result.externalId, established.result.externalId);
  const row = established.inventory.get('workspace:a', 'provider_project', result.externalId!);
  assert.equal(row?.lineageExternalId, established.result.externalId);
  assert.equal(established.inventory.get('workspace:a', 'provider_project',
    established.result.externalId!)?.rowHash, established.row.rowHash);
  const callsBefore = established.provider.calls.length;
  await assert.rejects(established.saga.provision(request({ sagaId: 'saga:replacement:unreviewed',
    idempotencyKey: 'provision:replacement:unreviewed', replacement: { priorExternalId: established.result.externalId!,
      priorInventoryHash: established.row.rowHash, reviewHash: governedOperationsHash('review'),
      revalidated: false, compensationId: 'compensation:restore' } })), /lineage, revalidation, compensation, and review/);
  assert.equal(established.provider.calls.length, callsBefore);
});

test('W4-013 credential rotation covers expiry, compromise, provider 401, bounded overlap, and rollback by vault reference', async () => {
  const { saga } = await provisioned();
  const common = { workspaceId: 'workspace:a', externalId: 'provider:1', priorCredentialReferenceId: 'vault://a/credential/v1',
    nextCredentialReferenceId: 'vault://a/credential/v2', maximumOverlapMs: 60_000, rollback: false };
  const proactive = saga.rotateCredential({ ...common, reason: 'proactive_expiry', overlapMs: 30_000 });
  assert.equal(proactive.revokedReferenceId, null);
  const compromised = saga.rotateCredential({ ...common, reason: 'compromise', overlapMs: 0 });
  assert.equal(compromised.revokedReferenceId, common.priorCredentialReferenceId);
  const unauthorized = saga.rotateCredential({ ...common, reason: 'provider_401', overlapMs: 0 });
  assert.equal(unauthorized.revokedReferenceId, common.priorCredentialReferenceId);
  const rollback = saga.rotateCredential({ ...common, reason: 'proactive_expiry', overlapMs: 0, rollback: true });
  assert.equal(rollback.activeReferenceId, common.priorCredentialReferenceId);
  assert.equal(rollback.historicalIdentityRewritten, false);
  assert.throws(() => saga.rotateCredential({ ...common, reason: 'proactive_expiry', overlapMs: 60_001 }), /bounded vault references/);
  assert.doesNotMatch(JSON.stringify([proactive, compromised, unauthorized, rollback]), /password|privateKey|plaintext/);
});
