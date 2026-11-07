/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  WAVE4_CONTRACT_VERSION, WAVE4_REVIEWED_WAVE2_SHA, WAVE4_REVIEWED_WAVE3_SHA,
  WAVE4_WAVE2_MIGRATION_HEAD, WAVE4_WAVE3A_MIGRATION_HEAD, WAVE4_WAVE3A_SPEC_REVISION,
  WAVE4_WAVE3B_MIGRATION_HEAD, WAVE4_WAVE3B_SPEC_REVISION, WAVE4_WAVE3_CONFORMANCE_RECEIPT,
  WAVE4_WAVE3_RELEASE_REVIEW_RECEIPT, WAVE4_WAVE3_RELEASE_REVIEWER, WAVE4_WAVE3_REVIEWED_TREE,
  WAVE4_WAVE3_SECURITY_REVIEW_RECEIPT, WAVE4_WAVE3_SECURITY_REVIEWER,
  verifyWave4Prerequisites, type Wave4PrerequisitePacket,
} from '../wave4-federation-gate';

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
function packet(): Wave4PrerequisitePacket {
  return { schemaVersion: 'rorca.wave4-prerequisite-packet.v1',
    wave2: { implementationSha: WAVE4_REVIEWED_WAVE2_SHA, migrationHead: WAVE4_WAVE2_MIGRATION_HEAD,
      contractVersion: WAVE4_CONTRACT_VERSION, contractHash: hash('a') },
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
    integration: { exactSha: WAVE4_REVIEWED_WAVE3_SHA, compatibilityVersion: WAVE4_CONTRACT_VERSION, unresolvedConflicts: [] },
    activeImplementationWaves: ['ROR-26'], configuredRuntimeIds: ['runtime:pilot'], revoked: false };
}

describe('Wave 4 exact prerequisite gate', () => {
  test('binds exact reviewed packets while granting no lifecycle or release authority', () => {
    expect(verifyWave4Prerequisites(packet())).toMatchObject({ accepted: true, runtimeLimit: 1,
      executionAuthority: 'execute_bounded', lifecycleDecisionAuthority: 'none', providerHumanAuthority: 'none',
      mergeAuthority: 'none', deploymentAuthority: 'none', productionAuthority: 'none' });
  });

  test.each([
    ['changed Wave 3 integration SHA', (value: Wave4PrerequisitePacket) => ({ ...value, integration: { ...value.integration, exactSha: '0'.repeat(40) } })],
    ['self review', (value: Wave4PrerequisitePacket) => ({ ...value, wave3a: { ...value.wave3a, reviewerId: value.wave3a.implementerId } })],
    ['overlapping implementation wave', (value: Wave4PrerequisitePacket) => ({ ...value, activeImplementationWaves: ['ROR-26', 'ROR-31'] })],
    ['second runtime', (value: Wave4PrerequisitePacket) => ({ ...value, configuredRuntimeIds: ['runtime:pilot', 'runtime:other'] })],
    ['self-asserted conformance digest', (value: Wave4PrerequisitePacket) => ({
      ...value, wave3a: { ...value.wave3a, conformanceReceiptHash: hash('b') },
    })],
    ['nonzero independent-review findings', (value: Wave4PrerequisitePacket) => ({
      ...value, wave3b: { ...value.wave3b, findingCount: 1 },
    })],
    ['revocation', (value: Wave4PrerequisitePacket) => ({ ...value, revoked: true })],
  ])('fails closed for %s before mutation', (_label, mutate) => {
    expect(() => verifyWave4Prerequisites(mutate(packet()) as Wave4PrerequisitePacket)).toThrow();
  });
});
