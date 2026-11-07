/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { canonicalTransaction } from '../db';
import { governedHash } from './governed-contracts';

export const WAVE3A_WAVE2_SPEC_SHA = 'sha256:8b6a36021eb7a2b42a141a4d7081eda77cb3f91dc157cf7c146c3b9b355b4730' as const;
export const WAVE3A_CONTRACT_PACKAGE_VERSION = '1.0.0' as const;
export const WAVE3A_CONTRACT_SOURCE_SHA = 'sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb' as const;
export const WAVE3A_WAVE2_MIGRATION_HEAD = 20260731157000 as const;
export const WAVE3A_COMPLETION_MIGRATION = 20260804170000 as const;
export const WAVE3A_WAVE2_IMPLEMENTATION_SHA = '1420fb4c819aad692894da9449bc4958ed74dd49' as const;
export const WAVE3A_SPEC_SHA = 'sha256:249b8fc33c6223acd63549f28c59714dfe3212df3b4d00572f9aef2e2252060d' as const;

export interface Wave3AExactPrerequisitePacket {
  readonly schemaVersion: 'rorca.wave3a-prerequisite-packet.v1';
  readonly wave2SpecSha: typeof WAVE3A_WAVE2_SPEC_SHA;
  readonly contractPackageVersion: typeof WAVE3A_CONTRACT_PACKAGE_VERSION;
  readonly contractSourceSha: typeof WAVE3A_CONTRACT_SOURCE_SHA;
  readonly migrationHead: typeof WAVE3A_WAVE2_MIGRATION_HEAD;
  readonly completionMigration: typeof WAVE3A_COMPLETION_MIGRATION;
  readonly implementationGitSha: typeof WAVE3A_WAVE2_IMPLEMENTATION_SHA;
  readonly conformance: Readonly<{ outcome: 'passed'; receiptHash: string; exactSha: typeof WAVE3A_WAVE2_IMPLEMENTATION_SHA }>;
  readonly independentReview: Readonly<{ outcome: 'accepted'; receiptHash: string; reviewerId: string; implementationActorId: string; exactSha: typeof WAVE3A_WAVE2_IMPLEMENTATION_SHA }>;
  readonly activeImplementationWaves: readonly ['ROR-25','ROR-28'];
  readonly ownership: Readonly<{
    ror28Root: '/private/tmp/rorca-wave3a-ror28-20260805';
    serializedPaths: readonly ['packages/rorca-public-contract','scripts/generate-governed-contract-artifacts.ts','generated schemas','docs/implementation/governed-mission-waves-coverage.json'];
    overlapDecision: 'serialized_integration_only';
  }>;
  readonly wave3aSpecSha: typeof WAVE3A_SPEC_SHA;
}

export interface Wave3AImplementationGate {
  readonly schemaVersion: 'rorca.wave3a-implementation-gate.v1';
  readonly accepted: true;
  readonly packetHash: string;
  readonly executionAuthority: 'none';
  readonly approvalAuthority: 'none';
  readonly mergeAuthority: 'none';
  readonly deploymentAuthority: 'none';
  readonly productionActivationAuthority: 'none';
}

function exactReceiptHash(value: string): boolean { return /^sha256:[a-f0-9]{64}$/.test(value); }

/** Deterministic pure gate: callers must run it before any adapter/store mutation. */
export function verifyWave3AImplementationPrerequisites(packet: Wave3AExactPrerequisitePacket): Wave3AImplementationGate {
  if (packet.schemaVersion !== 'rorca.wave3a-prerequisite-packet.v1'
      || packet.wave2SpecSha !== WAVE3A_WAVE2_SPEC_SHA
      || packet.contractPackageVersion !== WAVE3A_CONTRACT_PACKAGE_VERSION
      || packet.contractSourceSha !== WAVE3A_CONTRACT_SOURCE_SHA
      || packet.migrationHead !== WAVE3A_WAVE2_MIGRATION_HEAD
      || packet.completionMigration !== WAVE3A_COMPLETION_MIGRATION
      || packet.implementationGitSha !== WAVE3A_WAVE2_IMPLEMENTATION_SHA
      || packet.wave3aSpecSha !== WAVE3A_SPEC_SHA) {
    throw new Error('Wave 3A prerequisite packet is missing, stale, changed, or unsupported');
  }
  if (packet.conformance.outcome !== 'passed' || packet.conformance.exactSha !== packet.implementationGitSha
      || !exactReceiptHash(packet.conformance.receiptHash)) {
    throw new Error('Wave 3A requires exact-SHA Wave 2 conformance evidence');
  }
  if (packet.independentReview.outcome !== 'accepted' || packet.independentReview.exactSha !== packet.implementationGitSha
      || !exactReceiptHash(packet.independentReview.receiptHash)
      || packet.independentReview.reviewerId === packet.independentReview.implementationActorId) {
    throw new Error('Wave 3A requires an independent exact-SHA review receipt');
  }
  if (packet.activeImplementationWaves.length !== 2 || packet.activeImplementationWaves[0] !== 'ROR-25'
      || packet.activeImplementationWaves[1] !== 'ROR-28') {
    throw new Error('ROR-28/ROR-25 is the sole permitted parallel implementation pair');
  }
  const expectedSerialized = ['packages/rorca-public-contract','scripts/generate-governed-contract-artifacts.ts','generated schemas','docs/implementation/governed-mission-waves-coverage.json'];
  if (packet.ownership.ror28Root !== '/private/tmp/rorca-wave3a-ror28-20260805'
      || packet.ownership.overlapDecision !== 'serialized_integration_only'
      || packet.ownership.serializedPaths.length !== expectedSerialized.length
      || packet.ownership.serializedPaths.some((entry,index) => entry !== expectedSerialized[index])) {
    throw new Error('Wave 3A ownership map permits an unreviewed shared-file overlap');
  }
  return Object.freeze({
    schemaVersion:'rorca.wave3a-implementation-gate.v1',accepted:true,
    packetHash:governedHash('rorca.wave3a-prerequisite-packet.v1',packet as never),
    executionAuthority:'none',approvalAuthority:'none',mergeAuthority:'none',deploymentAuthority:'none',productionActivationAuthority:'none',
  });
}

/** Load only the migration-owned, immutable readiness receipt used by workers. */
export async function loadCanonicalWave3AImplementationGate(): Promise<Wave3AImplementationGate> {
  const readinessRow = await canonicalTransaction(async (client) => {
    const result = await client.query<{ readiness: unknown }>('SELECT rorca.load_wave3a_readiness_v1() readiness');
    return result.rows[0];
  });
  const readiness = readinessRow?.readiness;
  if (!readiness || typeof readiness !== 'object') throw new Error('Wave 3A canonical readiness receipt is absent');
  const row = readiness as Record<string,unknown>;
  if (row.contract_version !== 'rorca.managed-executor.v1'
      || row.wave2_implementation_git_sha !== WAVE3A_WAVE2_IMPLEMENTATION_SHA
      || Number(row.wave2_migration_head) !== WAVE3A_WAVE2_MIGRATION_HEAD
      || Number(row.wave2_completion_migration) !== WAVE3A_COMPLETION_MIGRATION
      || row.wave3a_spec_sha256 !== WAVE3A_SPEC_SHA
      || Number(row.migration_version) !== 20260804182000
      || row.state !== 'ready') {
    throw new Error('Wave 3A canonical readiness receipt is stale or conflicting');
  }
  return Object.freeze({
    schemaVersion:'rorca.wave3a-implementation-gate.v1',accepted:true,
    packetHash:governedHash('rorca.wave3a-canonical-readiness.v1',readiness as never),
    executionAuthority:'none',approvalAuthority:'none',mergeAuthority:'none',
    deploymentAuthority:'none',productionActivationAuthority:'none',
  });
}
