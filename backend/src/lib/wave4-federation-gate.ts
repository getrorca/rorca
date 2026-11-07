/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { canonicalTransaction } from '../db';
import { governedHash } from './governed-contracts';

export const WAVE4_REVIEWED_WAVE2_SHA = '1420fb4c819aad692894da9449bc4958ed74dd49' as const;
export const WAVE4_REVIEWED_WAVE3_SHA = 'a66537fc3a5607a80f6b1010ebdde238d3b6ce8f' as const;
export const WAVE4_WAVE3A_SPEC_REVISION = 'sha256:249b8fc33c6223acd63549f28c59714dfe3212df3b4d00572f9aef2e2252060d' as const;
export const WAVE4_WAVE3B_SPEC_REVISION = 'sha256:992cdad5119b7f4e359d3839665d10a9dd19aeec4fbdec6e2bf895c6f5e9ddd4' as const;
export const WAVE4_WAVE2_MIGRATION_HEAD = 20260731157000 as const;
export const WAVE4_WAVE3A_MIGRATION_HEAD = 20260804182000 as const;
export const WAVE4_WAVE3B_MIGRATION_HEAD = 20260805100000 as const;
export const WAVE4_CONTRACT_VERSION = '1.0.0' as const;
export const WAVE4_WAVE3_REVIEWED_TREE = 'a8bea27e85c9340d69ed078cd15a9dbfdc586abd' as const;
export const WAVE4_WAVE3_CONFORMANCE_RECEIPT = 'sha256:c998212b90ef90d3c6aabd3f26c2a2ecf15a7df4fecea44c5a663b4bf159a5c4' as const;
export const WAVE4_WAVE3_SECURITY_REVIEW_RECEIPT = 'sha256:dc093ac2fbed1642b6203541828503d90539d8cb7aea4b15f37409e58edaf8d0' as const;
export const WAVE4_WAVE3_RELEASE_REVIEW_RECEIPT = 'sha256:51cca9d2ed931e2f482f180f57ae50197a7b0ba20a9c72c330ab5300311d295f' as const;
export const WAVE4_WAVE3_REVIEW_BUNDLE_RECEIPT = 'sha256:4e9ef68f52918a33471b04dab4a084a177d0b5b5289aae12c622d7977459edeb' as const;
export const WAVE4_WAVE3_SECURITY_REVIEWER = 'Wave3SecFinal2' as const;
export const WAVE4_WAVE3_RELEASE_REVIEWER = 'Wave3RelFinal2' as const;

// Receipt-hash provenance (all hashes are sha256 of committed artifacts):
// - WAVE4_WAVE3A_SPEC_REVISION / WAVE4_WAVE3B_SPEC_REVISION: the frozen wave-3a /
//   wave-3b spec files at the reviewed Wave 3 SHA a66537fc.
// - WAVE4_WAVE3_CONFORMANCE_RECEIPT: docs/wave3-complete-gate-receipt.md at a66537fc
//   (the 8/8 shard, 5,688-pass gate receipt).
// - WAVE4_WAVE3_SECURITY_REVIEW_RECEIPT: docs/wave3-redaction-review-receipt.md at
//   a66537fc (the security-boundary review receipt, 10-file/0-hit sweep).
// - WAVE4_WAVE3_RELEASE_REVIEW_RECEIPT: the Wave 3 verdict ledger
//   (.autonomous-runner-implementation-progress.md at 305df001) recording both
//   independent reviewer acceptances with zero findings.
// - WAVE4_WAVE3_REVIEW_BUNDLE_RECEIPT: sha256 of the concatenation of the three
//   documents above (gate receipt + redaction receipt + ledger).

const Hash = /^sha256:[a-f0-9]{64}$/;

export interface Wave4PrerequisitePacket {
  readonly schemaVersion: 'rorca.wave4-prerequisite-packet.v1';
  readonly wave2: Readonly<{ implementationSha: typeof WAVE4_REVIEWED_WAVE2_SHA; migrationHead: typeof WAVE4_WAVE2_MIGRATION_HEAD; contractVersion: typeof WAVE4_CONTRACT_VERSION; contractHash: string }>;
  readonly wave3a: Readonly<{ specRevision: typeof WAVE4_WAVE3A_SPEC_REVISION; implementationSha: typeof WAVE4_REVIEWED_WAVE3_SHA; migrationHead: typeof WAVE4_WAVE3A_MIGRATION_HEAD; conformanceReceiptHash: string; reviewReceiptHash: string; reviewerId: string; implementerId: string; reviewVerdict: 'accepted'; findingCount: 0; reviewedTree: typeof WAVE4_WAVE3_REVIEWED_TREE }>;
  readonly wave3b: Readonly<{ specRevision: typeof WAVE4_WAVE3B_SPEC_REVISION; implementationSha: typeof WAVE4_REVIEWED_WAVE3_SHA; migrationHead: typeof WAVE4_WAVE3B_MIGRATION_HEAD; conformanceReceiptHash: string; reviewReceiptHash: string; reviewerId: string; implementerId: string; reviewVerdict: 'accepted'; findingCount: 0; reviewedTree: typeof WAVE4_WAVE3_REVIEWED_TREE }>;
  readonly integration: Readonly<{ exactSha: typeof WAVE4_REVIEWED_WAVE3_SHA; compatibilityVersion: typeof WAVE4_CONTRACT_VERSION; unresolvedConflicts: readonly [] }>;
  readonly activeImplementationWaves: readonly ['ROR-26'];
  readonly configuredRuntimeIds: readonly [string];
  readonly revoked: false;
}

export interface Wave4FederationGate {
  readonly schemaVersion: 'rorca.wave4-federation-gate.v1';
  readonly accepted: true;
  readonly packetHash: string;
  readonly runtimeLimit: 1;
  readonly executionAuthority: 'execute_bounded';
  readonly lifecycleDecisionAuthority: 'none';
  readonly providerHumanAuthority: 'none';
  readonly mergeAuthority: 'none';
  readonly deploymentAuthority: 'none';
  readonly productionAuthority: 'none';
}

export function verifyWave4Prerequisites(packet: Wave4PrerequisitePacket): Wave4FederationGate {
  const exact = packet.schemaVersion === 'rorca.wave4-prerequisite-packet.v1'
    && packet.wave2.implementationSha === WAVE4_REVIEWED_WAVE2_SHA
    && packet.wave2.migrationHead === WAVE4_WAVE2_MIGRATION_HEAD
    && packet.wave2.contractVersion === WAVE4_CONTRACT_VERSION
    && packet.wave3a.specRevision === WAVE4_WAVE3A_SPEC_REVISION
    && packet.wave3a.implementationSha === WAVE4_REVIEWED_WAVE3_SHA
    && packet.wave3a.migrationHead === WAVE4_WAVE3A_MIGRATION_HEAD
    && packet.wave3b.specRevision === WAVE4_WAVE3B_SPEC_REVISION
    && packet.wave3b.implementationSha === WAVE4_REVIEWED_WAVE3_SHA
    && packet.wave3b.migrationHead === WAVE4_WAVE3B_MIGRATION_HEAD
    && packet.wave3a.conformanceReceiptHash === WAVE4_WAVE3_CONFORMANCE_RECEIPT
    && packet.wave3a.reviewReceiptHash === WAVE4_WAVE3_SECURITY_REVIEW_RECEIPT
    && packet.wave3a.reviewerId === WAVE4_WAVE3_SECURITY_REVIEWER
    && packet.wave3a.reviewVerdict === 'accepted' && packet.wave3a.findingCount === 0
    && packet.wave3a.reviewedTree === WAVE4_WAVE3_REVIEWED_TREE
    && packet.wave3b.conformanceReceiptHash === WAVE4_WAVE3_CONFORMANCE_RECEIPT
    && packet.wave3b.reviewReceiptHash === WAVE4_WAVE3_RELEASE_REVIEW_RECEIPT
    && packet.wave3b.reviewerId === WAVE4_WAVE3_RELEASE_REVIEWER
    && packet.wave3b.reviewVerdict === 'accepted' && packet.wave3b.findingCount === 0
    && packet.wave3b.reviewedTree === WAVE4_WAVE3_REVIEWED_TREE
    && packet.integration.exactSha === WAVE4_REVIEWED_WAVE3_SHA
    && packet.integration.compatibilityVersion === WAVE4_CONTRACT_VERSION
    && packet.integration.unresolvedConflicts.length === 0
    && packet.revoked === false;
  if (!exact) throw new Error('Wave 4 prerequisite evidence is missing, stale, changed, revoked, incompatible, or ambiguous');
  for (const lane of [packet.wave3a, packet.wave3b]) {
    if (!Hash.test(lane.conformanceReceiptHash) || !Hash.test(lane.reviewReceiptHash)
        || lane.reviewerId === lane.implementerId) {
      throw new Error('Wave 4 requires exact-SHA conformance and independent review receipts');
    }
  }
  if (!Hash.test(packet.wave2.contractHash)) throw new Error('Wave 2 exact contract hash is required');
  if (packet.activeImplementationWaves.length !== 1 || packet.activeImplementationWaves[0] !== 'ROR-26') {
    throw new Error('Wave 4 cannot overlap another implementation wave');
  }
  if (packet.configuredRuntimeIds.length !== 1 || !/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/.test(packet.configuredRuntimeIds[0])) {
    throw new Error('Wave 4 permits exactly one named federated runtime');
  }
  return Object.freeze({
    schemaVersion: 'rorca.wave4-federation-gate.v1', accepted: true,
    packetHash: governedHash('rorca.wave4-prerequisite-packet.v1', packet as never), runtimeLimit: 1,
    executionAuthority: 'execute_bounded', lifecycleDecisionAuthority: 'none', providerHumanAuthority: 'none',
    mergeAuthority: 'none', deploymentAuthority: 'none', productionAuthority: 'none',
  });
}

export async function loadCanonicalWave4FederationGate(): Promise<Wave4FederationGate> {
  const result = await canonicalTransaction(async (client) => (await client.query<{ readiness: unknown }>(
    'SELECT rorca.load_wave4_federation_readiness_v1() readiness')).rows[0]);
  if (!result?.readiness || typeof result.readiness !== 'object') throw new Error('Wave 4 canonical readiness receipt is absent');
  const row = result.readiness as Record<string, unknown>;
  const configuredRuntimeIds = row.configured_runtime_ids;
  if (row.state !== 'ready' || row.reviewed_wave2_sha !== WAVE4_REVIEWED_WAVE2_SHA
      || row.reviewed_wave3_sha !== WAVE4_REVIEWED_WAVE3_SHA
      || row.wave3a_spec_revision !== WAVE4_WAVE3A_SPEC_REVISION
      || row.wave3b_spec_revision !== WAVE4_WAVE3B_SPEC_REVISION
      || Number(row.wave2_migration_head) !== WAVE4_WAVE2_MIGRATION_HEAD
      || Number(row.wave3a_migration_head) !== WAVE4_WAVE3A_MIGRATION_HEAD
      || Number(row.wave3b_migration_head) !== WAVE4_WAVE3B_MIGRATION_HEAD
      || row.contract_version !== WAVE4_CONTRACT_VERSION || Number(row.runtime_limit) !== 1
      || !Hash.test(String(row.wave2_prerequisite_receipt_hash ?? ''))
      || row.conformance_receipt_hash !== WAVE4_WAVE3_CONFORMANCE_RECEIPT
      || row.independent_review_receipt_hash !== WAVE4_WAVE3_REVIEW_BUNDLE_RECEIPT
      || row.wave3_security_review_receipt_hash !== WAVE4_WAVE3_SECURITY_REVIEW_RECEIPT
      || row.wave3_release_review_receipt_hash !== WAVE4_WAVE3_RELEASE_REVIEW_RECEIPT
      || row.wave3_security_reviewer_id !== WAVE4_WAVE3_SECURITY_REVIEWER
      || row.wave3_release_reviewer_id !== WAVE4_WAVE3_RELEASE_REVIEWER
      || row.wave3_security_verdict !== 'accepted' || row.wave3_release_verdict !== 'accepted'
      || Number(row.wave3_security_finding_count) !== 0 || Number(row.wave3_release_finding_count) !== 0
      || row.reviewed_wave3_tree_sha !== WAVE4_WAVE3_REVIEWED_TREE
      || !Array.isArray(configuredRuntimeIds) || configuredRuntimeIds.length !== 1
      || configuredRuntimeIds.some((id) => typeof id !== 'string')) {
    throw new Error('Wave 4 canonical readiness receipt is stale, self-asserted, or conflicting');
  }
  return verifyWave4Prerequisites({
    schemaVersion: 'rorca.wave4-prerequisite-packet.v1',
    wave2: { implementationSha: WAVE4_REVIEWED_WAVE2_SHA, migrationHead: WAVE4_WAVE2_MIGRATION_HEAD,
      contractVersion: WAVE4_CONTRACT_VERSION, contractHash: String(row.wave2_prerequisite_receipt_hash) },
    wave3a: { specRevision: WAVE4_WAVE3A_SPEC_REVISION, implementationSha: WAVE4_REVIEWED_WAVE3_SHA,
      migrationHead: WAVE4_WAVE3A_MIGRATION_HEAD, conformanceReceiptHash: WAVE4_WAVE3_CONFORMANCE_RECEIPT,
      reviewReceiptHash: WAVE4_WAVE3_SECURITY_REVIEW_RECEIPT, reviewerId: WAVE4_WAVE3_SECURITY_REVIEWER,
      implementerId: 'Wave3ImplementationTeam', reviewVerdict: 'accepted', findingCount: 0,
      reviewedTree: WAVE4_WAVE3_REVIEWED_TREE },
    wave3b: { specRevision: WAVE4_WAVE3B_SPEC_REVISION, implementationSha: WAVE4_REVIEWED_WAVE3_SHA,
      migrationHead: WAVE4_WAVE3B_MIGRATION_HEAD, conformanceReceiptHash: WAVE4_WAVE3_CONFORMANCE_RECEIPT,
      reviewReceiptHash: WAVE4_WAVE3_RELEASE_REVIEW_RECEIPT, reviewerId: WAVE4_WAVE3_RELEASE_REVIEWER,
      implementerId: 'Wave3ImplementationTeam', reviewVerdict: 'accepted', findingCount: 0,
      reviewedTree: WAVE4_WAVE3_REVIEWED_TREE },
    integration: { exactSha: WAVE4_REVIEWED_WAVE3_SHA, compatibilityVersion: WAVE4_CONTRACT_VERSION,
      unresolvedConflicts: [] },
    activeImplementationWaves: ['ROR-26'], configuredRuntimeIds: [String(configuredRuntimeIds[0])], revoked: false,
  });
}
