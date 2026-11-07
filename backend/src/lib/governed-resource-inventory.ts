/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { boundedRedactedObservation, governedOperationsHash, requireExactHash, type Sha256 } from './governed-operations-primitives';

export type ResourceType = 'provider_project' | 'runtime_identity' | 'forgejo_repository' | 'forgejo_runner';
export type RetentionClass = 'ephemeral' | 'evidence_retained' | 'legal_hold';
export type ResourceLifecycleStatus = 'provisioning' | 'admitted' | 'quarantined' | 'offboarding' | 'offboarded' | 'indeterminate';

export interface CanonicalResourceInventoryRow {
  schemaVersion: 'rorca.workspace-resource-inventory.v1';
  workspaceId: string;
  resourceType: ResourceType;
  externalId: string;
  ownerLabels: Readonly<Record<string, string>>;
  provider: string;
  accountId: string;
  region: string;
  desiredRevision: string;
  observedRevision: string;
  credentialReferenceId: string;
  dependencies: readonly string[];
  retentionClass: RetentionClass;
  createdAt: string;
  updatedAt: string;
  lifecycleStatus: ResourceLifecycleStatus;
  lineageExternalId: string | null;
  rowHash: Sha256;
}

export interface DiscoveredResource {
  externalId: string;
  resourceType: ResourceType;
  ownerLabels: Readonly<Record<string, string>>;
  provider: string;
  accountId: string;
  region: string;
  revision: string;
  linkedInventoryHash: Sha256 | null;
  shared: boolean;
  referenced: boolean;
}

export interface DiscoveryObservation {
  workspaceId: string;
  externalId: string;
  status: 'linked' | 'quarantined_observation';
  reasonCode: string;
  mutationCount: 0;
  observationHash: Sha256;
}

export type ProvisionStage = 'authority_capability_health' | 'quota_reserve' | 'create_or_adopt'
  | 'identity_preserving_patch' | 'verify' | 'record_inventory' | 'admit';
export type OffboardStage = 'authorize_offboarding' | 'revoke_admission' | 'fence_quarantine'
  | 'verify_no_active_lease_dispatch' | 'rotate_revoke_credentials' | 'archive_retained_evidence'
  | 'detach_dependencies' | 'preview_cleanup' | 'execute_cleanup' | 'verify_inventory';

export interface SagaStageReceipt {
  sequence: number;
  stage: ProvisionStage | OffboardStage;
  status: 'completed' | 'compensated' | 'blocked' | 'indeterminate';
  compensationId: string;
  indeterminateAction: string;
  receiptHash: Sha256;
}

export interface NewIdentityReplacementAuthorization {
  priorExternalId: string;
  priorInventoryHash: Sha256;
  reviewHash: Sha256;
  revalidated: boolean;
  compensationId: string;
}

export interface ProvisionRequest {
  sagaId: string;
  idempotencyKey: string;
  workspaceId: string;
  resourceType: ResourceType;
  ownerLabels: Readonly<Record<string, string>>;
  provider: string;
  accountId: string;
  region: string;
  desiredRevision: string;
  credentialReferenceId: string;
  dependencies: readonly string[];
  retentionClass: RetentionClass;
  authorityHealthy: boolean;
  capabilityHealthy: boolean;
  quotaUnits: number;
  adoptExternalId?: string;
  expectedInventoryHash?: Sha256;
  replacement?: NewIdentityReplacementAuthorization;
}

export interface OffboardRequest {
  sagaId: string;
  idempotencyKey: string;
  workspaceId: string;
  resourceType: ResourceType;
  externalId: string;
  inventoryHash: Sha256;
  authorizationReceiptId: string;
  authorizationReceiptHash: Sha256;
  cleanupPreviewHash: Sha256;
}

export interface VerifiedOffboardState {
  authorizationReceiptId: string;
  authorizationReceiptHash: Sha256;
  workspaceId: string;
  resourceType: ResourceType;
  externalId: string;
  inventoryHash: Sha256;
  expiresAt: number;
  activeLeaseOrDispatch: boolean;
  sharedDependency: boolean;
  observationHash: Sha256;
}

export interface OffboardAuthorityPort {
  verifyAuthorization(request: OffboardRequest, inventory: CanonicalResourceInventoryRow): Promise<VerifiedOffboardState | null>;
  reobserveCleanupState(request: OffboardRequest, inventory: CanonicalResourceInventoryRow): Promise<VerifiedOffboardState | null>;
}

export interface SagaResult {
  sagaId: string;
  requestHash: Sha256;
  status: 'admitted' | 'offboarded' | 'blocked' | 'indeterminate' | 'quarantined';
  externalId: string | null;
  stages: readonly SagaStageReceipt[];
  providerMutations: number;
  realProviderMutation: false;
  resultHash: Sha256;
}

export interface CredentialRotationRequest {
  workspaceId: string;
  externalId: string;
  reason: 'proactive_expiry' | 'compromise' | 'provider_401';
  priorCredentialReferenceId: string;
  nextCredentialReferenceId: string;
  overlapMs: number;
  maximumOverlapMs: number;
  rollback: boolean;
}

export interface LocalResourceProvider {
  readonly kind: 'local_fake_provider' | 'local_fake_forgejo';
  create(requestHash: Sha256, labels: Readonly<Record<string, string>>): Promise<{ externalId: string; revision: string; outcome: 'created' | 'timeout' | 'partial' }>;
  adopt(externalId: string, requestHash: Sha256): Promise<{ revision: string; exactRequest: boolean }>;
  patch(externalId: string, desiredRevision: string): Promise<{ revision: string; identityPreserved: true }>;
  verify(externalId: string): Promise<{ found: boolean; revision: string; labels: Readonly<Record<string, string>> }>;
  compensate(externalId: string): Promise<{ compensated: boolean }>;
  delete(externalId: string): Promise<{ absent: boolean }>;
}

interface Replay { requestHash: Sha256; result: SagaResult }

function inventoryMaterial(row: Omit<CanonicalResourceInventoryRow, 'rowHash'>): Omit<CanonicalResourceInventoryRow, 'rowHash'> {
  return row;
}

function labelsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return governedOperationsHash(left) === governedOperationsHash(right);
}

export class CanonicalResourceInventory {
  private readonly rows = new Map<string, CanonicalResourceInventoryRow>();
  private readonly observations: DiscoveryObservation[] = [];

  get(workspaceId: string, resourceType: ResourceType, externalId: string): CanonicalResourceInventoryRow | undefined {
    const row = this.rows.get(`${workspaceId}:${resourceType}:${externalId}`);
    return row ? structuredClone(row) : undefined;
  }

  all(workspaceId: string): readonly CanonicalResourceInventoryRow[] {
    return [...this.rows.values()].filter(row => row.workspaceId === workspaceId).map(row => structuredClone(row));
  }

  record(row: Omit<CanonicalResourceInventoryRow, 'rowHash'>): CanonicalResourceInventoryRow {
    if (!row.workspaceId || !row.externalId || !row.credentialReferenceId || row.dependencies.some(value => !value)) {
      throw new Error('Inventory identity, credential reference, and dependencies must be complete');
    }
    if (!row.credentialReferenceId.startsWith('vault://') || /[\s{}"'=]/.test(row.credentialReferenceId)) {
      throw new Error('Inventory stores vault credential-reference identity only, never plaintext env or JSON secrets');
    }
    const key = `${row.workspaceId}:${row.resourceType}:${row.externalId}`;
    const current = this.rows.get(key);
    if (current && (current.externalId !== row.externalId || current.createdAt !== row.createdAt
      || current.credentialReferenceId !== row.credentialReferenceId)) {
      throw new Error('Immutable external and historical credential identity cannot be rewritten');
    }
    const sealed = Object.freeze({ ...row, ownerLabels: Object.freeze({ ...row.ownerLabels }),
      dependencies: Object.freeze([...row.dependencies]), rowHash: governedOperationsHash(inventoryMaterial(row)) });
    this.rows.set(key, sealed);
    return structuredClone(sealed);
  }

  updateObserved(workspaceId: string, resourceType: ResourceType, externalId: string,
    expectedHash: Sha256, patch: Pick<CanonicalResourceInventoryRow, 'observedRevision' | 'updatedAt' | 'lifecycleStatus'>): CanonicalResourceInventoryRow {
    const key = `${workspaceId}:${resourceType}:${externalId}`;
    const current = this.rows.get(key);
    if (!current || current.rowHash !== expectedHash) throw new Error('Stale inventory revision');
    const { rowHash: _rowHash, ...material } = current;
    return this.record({ ...material, ...patch });
  }

  observeDiscovery(workspaceId: string, exactLabels: Readonly<Record<string, string>>, resource: DiscoveredResource): DiscoveryObservation {
    const row = this.get(workspaceId, resource.resourceType, resource.externalId);
    const linked = Boolean(row && resource.linkedInventoryHash === row.rowHash && labelsEqual(resource.ownerLabels, exactLabels)
      && labelsEqual(resource.ownerLabels, row.ownerLabels) && !resource.shared && !resource.referenced);
    const reasonCode = linked ? 'exact_inventory_and_owner_labels' : !row ? 'unknown_resource'
      : resource.shared ? 'shared_resource' : resource.referenced ? 'referenced_resource'
        : !labelsEqual(resource.ownerLabels, exactLabels) ? 'owner_labels_mismatch' : 'inventory_link_ambiguous';
    const material = { workspaceId, externalId: resource.externalId,
      status: linked ? 'linked' as const : 'quarantined_observation' as const,
      reasonCode, mutationCount: 0 as const };
    const observation = Object.freeze({ ...material, observationHash: governedOperationsHash(material) });
    this.observations.push(observation);
    return structuredClone(observation);
  }
}

export class GovernedResourceSaga {
  private readonly replays = new Map<string, Replay>();
  private readonly requestToExternalId = new Map<Sha256, string>();

  constructor(private readonly inventory: CanonicalResourceInventory, private readonly provider: LocalResourceProvider,
    private readonly offboardAuthority: OffboardAuthorityPort, private readonly now: () => number = Date.now) {}

  async provision(request: ProvisionRequest): Promise<SagaResult> {
    this.validateRequest(request);
    const requestHash = governedOperationsHash(request);
    const replay = this.replay(`${request.workspaceId}:provision:${request.idempotencyKey}`, requestHash);
    if (replay) return replay;
    if (request.replacement) {
      const replacement = request.replacement;
      requireExactHash(replacement.reviewHash, 'replacement review hash');
      const prior = this.inventory.get(request.workspaceId, request.resourceType, replacement.priorExternalId);
      if (!prior || prior.rowHash !== replacement.priorInventoryHash || !replacement.revalidated
        || !replacement.compensationId || request.adoptExternalId) {
        throw new Error('New-identity replacement requires exact lineage, revalidation, compensation, and review');
      }
    }
    const stages: SagaStageReceipt[] = [];
    let providerMutations = 0;
    let externalId: string | null = null;
    const append = (stage: ProvisionStage, status: SagaStageReceipt['status'], detail: string) => {
      stages.push(this.stage(stages.length + 1, stage, status, `compensate:${stage}`, detail));
    };
    if (!request.authorityHealthy || !request.capabilityHealthy) {
      append('authority_capability_health', 'blocked', 'governed authority or capability unhealthy');
      return this.finish(request, requestHash, stages, 'blocked', externalId, providerMutations);
    }
    append('authority_capability_health', 'completed', 'exact authority and capability observed');
    if (!Number.isSafeInteger(request.quotaUnits) || request.quotaUnits < 1) {
      append('quota_reserve', 'blocked', 'quota reservation denied');
      return this.finish(request, requestHash, stages, 'blocked', externalId, providerMutations);
    }
    append('quota_reserve', 'completed', 'scoped quota reservation recorded');
    const knownExternalId = this.requestToExternalId.get(requestHash);
    if (knownExternalId) externalId = knownExternalId;
    else if (request.adoptExternalId) {
      const adoption = await this.provider.adopt(request.adoptExternalId, requestHash);
      if (!adoption.exactRequest) {
        append('create_or_adopt', 'indeterminate', 'adoption request identity not exact; no replacement may be created');
        return this.finish(request, requestHash, stages, 'indeterminate', request.adoptExternalId, providerMutations);
      }
      externalId = request.adoptExternalId;
      this.requestToExternalId.set(requestHash, externalId);
    } else {
      const created = await this.provider.create(requestHash, request.ownerLabels);
      providerMutations += 1;
      externalId = created.externalId;
      this.requestToExternalId.set(requestHash, externalId);
      if (created.outcome !== 'created') {
        append('create_or_adopt', 'indeterminate', 'provider outcome unprovable; reconcile exact external identity and request hash');
        return this.finish(request, requestHash, stages, 'indeterminate', externalId, providerMutations);
      }
    }
    append('create_or_adopt', 'completed', 'exact external identity established');
    const patched = await this.provider.patch(externalId, request.desiredRevision);
    providerMutations += 1;
    if (!patched.identityPreserved) throw new Error('Delete/recreate rejected when identity-preserving PATCH exists');
    append('identity_preserving_patch', 'completed', 'identity-preserving PATCH applied');
    const verification = await this.provider.verify(externalId);
    if (!verification.found || verification.revision !== request.desiredRevision || !labelsEqual(verification.labels, request.ownerLabels)) {
      const compensation = await this.provider.compensate(externalId); providerMutations += 1;
      append('verify', compensation.compensated ? 'compensated' : 'indeterminate',
        compensation.compensated ? 'failed verification compensated without replacement' : 'failed compensation quarantines exact external identity');
      return this.finish(request, requestHash, stages, compensation.compensated ? 'blocked' : 'quarantined', externalId, providerMutations);
    }
    append('verify', 'completed', 'provider independently re-observed');
    const timestamp = new Date(this.now()).toISOString();
    const existing = this.inventory.get(request.workspaceId, request.resourceType, externalId);
    if (existing && request.expectedInventoryHash !== existing.rowHash) {
      append('record_inventory', 'blocked', 'stale inventory cannot be overwritten');
      return this.finish(request, requestHash, stages, 'quarantined', externalId, providerMutations);
    }
    const inventoryRow = this.inventory.record({ schemaVersion: 'rorca.workspace-resource-inventory.v1',
      workspaceId: request.workspaceId, resourceType: request.resourceType, externalId,
      ownerLabels: request.ownerLabels, provider: request.provider, accountId: request.accountId, region: request.region,
      desiredRevision: request.desiredRevision, observedRevision: verification.revision,
      credentialReferenceId: request.credentialReferenceId, dependencies: request.dependencies,
      retentionClass: request.retentionClass, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
      lifecycleStatus: 'provisioning', lineageExternalId: request.replacement?.priorExternalId ?? null });
    append('record_inventory', 'completed', inventoryRow.rowHash);
    this.inventory.updateObserved(request.workspaceId, request.resourceType, externalId, inventoryRow.rowHash,
      { observedRevision: verification.revision, updatedAt: timestamp, lifecycleStatus: 'admitted' });
    append('admit', 'completed', 'operational admission recorded; no provider-human or lifecycle authority');
    return this.finish(request, requestHash, stages, 'admitted', externalId, providerMutations);
  }

  async offboard(request: OffboardRequest): Promise<SagaResult> {
    const requestHash = governedOperationsHash(request);
    const replay = this.replay(`${request.workspaceId}:offboard:${request.idempotencyKey}`, requestHash);
    if (replay) return replay;
    const stages: SagaStageReceipt[] = [];
    let providerMutations = 0;
    const append = (stage: OffboardStage, status: SagaStageReceipt['status'], detail: string) => {
      stages.push(this.stage(stages.length + 1, stage, status, `compensate:${stage}`, detail));
    };
    const row = this.inventory.get(request.workspaceId, request.resourceType, request.externalId);
    const authorized = row ? await this.offboardAuthority.verifyAuthorization(request, row) : null;
    if (!row || row.rowHash !== request.inventoryHash || !authorized
      || !this.exactOffboardState(request, row, authorized)) {
      append('authorize_offboarding', 'blocked', 'immutable exact offboarding authorization or inventory identity missing');
      return this.finish(request, requestHash, stages, 'blocked', request.externalId, providerMutations);
    }
    append('authorize_offboarding', 'completed', authorized.authorizationReceiptHash);
    append('revoke_admission', 'completed', 'admission revoked operationally');
    const quarantined = this.inventory.updateObserved(request.workspaceId, request.resourceType, request.externalId,
      row.rowHash, { observedRevision: row.observedRevision, updatedAt: new Date(this.now()).toISOString(), lifecycleStatus: 'quarantined' });
    append('fence_quarantine', 'completed', quarantined.rowHash);
    if (authorized.activeLeaseOrDispatch) {
      append('verify_no_active_lease_dispatch', 'blocked', 'independently observed active lease or dispatch prevents cleanup');
      return this.finish(request, requestHash, stages, 'quarantined', request.externalId, providerMutations);
    }
    append('verify_no_active_lease_dispatch', 'completed', 'no active lease or dispatch');
    append('rotate_revoke_credentials', 'completed', 'scoped vault credential reference revoked');
    append('archive_retained_evidence', 'completed', 'retention-class evidence archived by reference');
    if (authorized.sharedDependency) {
      append('detach_dependencies', 'blocked', 'independently observed shared dependency prevents detach and deletion');
      return this.finish(request, requestHash, stages, 'quarantined', request.externalId, providerMutations);
    }
    append('detach_dependencies', 'completed', 'dependency references detached');
    requireExactHash(request.cleanupPreviewHash, 'cleanup preview hash');
    append('preview_cleanup', 'completed', request.cleanupPreviewHash);
    const latestInventory = this.inventory.get(request.workspaceId, request.resourceType, request.externalId);
    const cleanupState = latestInventory
      ? await this.offboardAuthority.reobserveCleanupState(request, latestInventory) : null;
    if (!latestInventory || !cleanupState || !this.exactOffboardState(request, latestInventory, cleanupState)
      || cleanupState.activeLeaseOrDispatch || cleanupState.sharedDependency) {
      append('execute_cleanup', 'blocked', 'cleanup-time lease, dispatch, dependency, authorization, or inventory revalidation failed');
      return this.finish(request, requestHash, stages, 'quarantined', request.externalId, providerMutations);
    }
    const deletion = await this.provider.delete(request.externalId); providerMutations += 1;
    append('execute_cleanup', deletion.absent ? 'completed' : 'indeterminate', deletion.absent ? 'exact external identity absent' : 'cleanup outcome unprovable');
    if (!deletion.absent) return this.finish(request, requestHash, stages, 'indeterminate', request.externalId, providerMutations);
    const current = this.inventory.get(request.workspaceId, request.resourceType, request.externalId);
    if (!current) throw new Error('Inventory disappeared before verification');
    this.inventory.updateObserved(request.workspaceId, request.resourceType, request.externalId, current.rowHash,
      { observedRevision: current.observedRevision, updatedAt: new Date(this.now()).toISOString(), lifecycleStatus: 'offboarded' });
    append('verify_inventory', 'completed', 'inventory retains immutable identity with offboarded status');
    return this.finish(request, requestHash, stages, 'offboarded', request.externalId, providerMutations);
  }

  rotateCredential(request: CredentialRotationRequest): { activeReferenceId: string; revokedReferenceId: string | null; historicalIdentityRewritten: false; receiptHash: Sha256 } {
    if (!request.nextCredentialReferenceId.startsWith('vault://') || !request.priorCredentialReferenceId.startsWith('vault://')
      || request.nextCredentialReferenceId === request.priorCredentialReferenceId || request.overlapMs < 0
      || request.overlapMs > request.maximumOverlapMs) throw new Error('Credential rotation requires distinct bounded vault references');
    const revokeImmediately = request.reason === 'compromise' || request.reason === 'provider_401';
    const activeReferenceId = request.rollback ? request.priorCredentialReferenceId : request.nextCredentialReferenceId;
    const revokedReferenceId = request.rollback ? request.nextCredentialReferenceId : revokeImmediately || request.overlapMs === 0
      ? request.priorCredentialReferenceId : null;
    const material = { activeReferenceId, revokedReferenceId, historicalIdentityRewritten: false as const };
    return { ...material, receiptHash: governedOperationsHash({ request, ...material }) };
  }

  private exactOffboardState(request: OffboardRequest, inventory: CanonicalResourceInventoryRow,
    state: VerifiedOffboardState): boolean {
    requireExactHash(state.authorizationReceiptHash, 'offboarding authorization receipt hash');
    requireExactHash(state.observationHash, 'offboarding cleanup observation hash');
    return state.authorizationReceiptId === request.authorizationReceiptId
      && state.authorizationReceiptHash === request.authorizationReceiptHash
      && state.workspaceId === request.workspaceId && state.resourceType === request.resourceType
      && state.externalId === request.externalId && state.inventoryHash === inventory.rowHash
      && state.expiresAt >= this.now();
  }

  private validateRequest(request: ProvisionRequest): void {
    if (!request.idempotencyKey || !request.workspaceId || Object.keys(request.ownerLabels).length === 0
      || !request.credentialReferenceId.startsWith('vault://')) throw new Error('Provisioning material identity is incomplete');
    if (/password\s*=|secret\s*=|token\s*=|private.?key\s*=/i.test(JSON.stringify(request))) {
      throw new Error('Plaintext environment or JSON credentials are prohibited');
    }
  }

  private replay(key: string, requestHash: Sha256): SagaResult | null {
    const replay = this.replays.get(key);
    if (!replay) return null;
    if (replay.requestHash !== requestHash) throw new Error('Changed saga replay permanently rejected');
    return structuredClone(replay.result);
  }

  private stage(sequence: number, stage: ProvisionStage | OffboardStage, status: SagaStageReceipt['status'],
    compensationId: string, detail: string): SagaStageReceipt {
    const indeterminateAction = boundedRedactedObservation(`reconcile exact external identity/request hash; ${detail}`);
    const material = { sequence, stage, status, compensationId, indeterminateAction };
    return Object.freeze({ ...material, receiptHash: governedOperationsHash(material) });
  }

  private finish(request: Pick<ProvisionRequest | OffboardRequest, 'sagaId' | 'workspaceId' | 'idempotencyKey'>,
    requestHash: Sha256, stages: SagaStageReceipt[], status: SagaResult['status'], externalId: string | null,
    providerMutations: number): SagaResult {
    const material = { sagaId: request.sagaId, requestHash, status, externalId,
      stages: Object.freeze([...stages]), providerMutations, realProviderMutation: false as const };
    const result = Object.freeze({ ...material, resultHash: governedOperationsHash(material) });
    const operation = stages[0]?.stage === 'authorize_offboarding' ? 'offboard' : 'provision';
    this.replays.set(`${request.workspaceId}:${operation}:${request.idempotencyKey}`, { requestHash, result });
    return structuredClone(result);
  }
}

export class DeterministicFakeResourceProvider implements LocalResourceProvider {
  readonly kind: 'local_fake_provider' | 'local_fake_forgejo';
  readonly resources = new Map<string, { revision: string; labels: Readonly<Record<string, string>>; requestHash: Sha256 }>();
  readonly calls: string[] = [];
  nextCreateOutcome: 'created' | 'timeout' | 'partial' = 'created';
  failCompensation = false;
  verifyRevisionOverride: string | null = null;

  constructor(kind: LocalResourceProvider['kind'] = 'local_fake_provider') { this.kind = kind; }

  async create(requestHash: Sha256, labels: Readonly<Record<string, string>>): Promise<{ externalId: string; revision: string; outcome: 'created' | 'timeout' | 'partial' }> {
    this.calls.push('create');
    const externalId = `${this.kind}:${requestHash.slice(7, 23)}`;
    this.resources.set(externalId, { revision: 'created', labels: { ...labels }, requestHash });
    return { externalId, revision: 'created', outcome: this.nextCreateOutcome };
  }

  async adopt(externalId: string, requestHash: Sha256): Promise<{ revision: string; exactRequest: boolean }> {
    this.calls.push('adopt');
    const resource = this.resources.get(externalId);
    return { revision: resource?.revision ?? 'unknown', exactRequest: resource?.requestHash === requestHash };
  }

  async patch(externalId: string, desiredRevision: string): Promise<{ revision: string; identityPreserved: true }> {
    this.calls.push('patch');
    const resource = this.resources.get(externalId);
    if (!resource) throw new Error('Unknown fake resource');
    this.resources.set(externalId, { ...resource, revision: desiredRevision });
    return { revision: desiredRevision, identityPreserved: true };
  }

  async verify(externalId: string): Promise<{ found: boolean; revision: string; labels: Readonly<Record<string, string>> }> {
    this.calls.push('verify');
    const resource = this.resources.get(externalId);
    return { found: Boolean(resource), revision: this.verifyRevisionOverride ?? resource?.revision ?? 'absent',
      labels: resource?.labels ?? {} };
  }

  async compensate(externalId: string): Promise<{ compensated: boolean }> {
    this.calls.push('compensate');
    if (this.failCompensation) return { compensated: false };
    this.resources.delete(externalId);
    return { compensated: true };
  }

  async delete(externalId: string): Promise<{ absent: boolean }> {
    this.calls.push('delete');
    this.resources.delete(externalId);
    return { absent: !this.resources.has(externalId) };
  }
}
