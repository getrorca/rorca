/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  FederatedAcquireRequestSchema, FederatedLeaseBindingSchema, FederatedResultProposalSchema,
  FederatedRuntimeRegistrationSchema,
} from '../federated-runtime-contracts';

const h = (value = 'a'): string => `sha256:${value.repeat(64)}`;
const sha = 'a'.repeat(40);
const now = '2026-08-05T12:00:00.000Z';
export function bindingFixture() {
  return { workspaceId: 'workspace:one', runtimeId: 'runtime:pilot', missionId: 'mission:one', missionRevision: 1,
    missionHash: h('1'), workPackageId: 'work-package:one', workPackageRevision: 1, workPackageHash: h('2'),
    specId: 'spec:one', specVersion: 1, specHash: h('3'), storyId: 'story:one', storyVersion: 1,
    storyHash: h('4'), criteriaManifestHash: h('5'), attemptId: 'attempt:one', leaseId: 'lease:one', fencingToken: 1,
    expectedLeaseExpiresAt: '2026-08-05T13:00:00.000Z', policyDefinitionHash: h('6'), policyActivationId: 'activation:one',
    policyActivationRevision: 1, policyActivationHash: h('7'), checkpointId: 'checkpoint:one', checkpointHash: h('8'),
    retrievalReceiptId: 'receipt:one', retrievalReceiptHash: h('9'), bundleId: 'bundle:one', bundleHash: h('a'),
    dispatchId: 'dispatch:one', dispatchHash: h('b'), repositoryId: 'repository:one', remoteAuthorityHash: h('c'),
    baseSha: sha, currentSha: sha, expectedHeadSha: sha, worktreeId: 'worktree:one', allowedPathManifestHash: h('d'),
    requiredPathManifestHash: h('e'), changedPathManifestHash: h('f'), forbiddenPathManifestHash: h('0'),
    validationManifestHash: h('1') };
}

describe('federated runtime internal HTTP contracts', () => {
  test('requires the complete exact-revision lease binding and rejects deprecated epoch', () => {
    const binding = bindingFixture();
    expect(FederatedLeaseBindingSchema.parse(binding)).toEqual(binding);
    const acquire = { schemaVersion: 'rorca.federated-acquire-request.v1', offerId: 'offer:one', bindingHash: h('2'),
      binding, generation: 1, sessionId: 'session:one', sessionFileHash: h('3'), turnId: 'turn:one',
      originatingGeneration: 1, cursor: 0, cursorHash: h('4'), idempotencyKey: 'acquire:one' };
    expect(FederatedAcquireRequestSchema.parse(acquire)).toEqual(acquire);
    expect(() => FederatedAcquireRequestSchema.parse({ ...acquire, contextEpoch: 'deprecated' })).toThrow();
    expect(() => FederatedAcquireRequestSchema.parse({ ...acquire, binding: { ...binding, baseSha: 'abc123' } })).toThrow();
  });

  test('registry is one-identity compatible, HTTPS-only, and authority/credential minimizing', () => {
    const registration = { schemaVersion: 'rorca.federated-runtime-registration.v1', runtimeId: 'runtime:pilot',
      workspaceId: 'workspace:one', credentialVersion: 1, keyVersion: 1, credentialDigest: h('a'),
      endpoint: 'https://runtime.invalid/v1', allowedContractVersions: ['1.0.0'], allowedPaths: ['backend/src'],
      mutationBoundsHash: h('b'), status: 'active', expiresAt: '2026-08-06T12:00:00.000Z',
      auditProvenanceHash: h('c'), registeredBy: 'host:operator', idempotencyKey: 'runtime:register:one',
      controlPlaneCredentials: false, databaseCredentials: false, githubCredentials: false, modelProviderCredentials: false,
      providerHumanCredentials: false, mergeAuthority: false, deploymentAuthority: false };
    expect(FederatedRuntimeRegistrationSchema.parse(registration)).toEqual(registration);
    expect(() => FederatedRuntimeRegistrationSchema.parse({ ...registration, endpoint: 'http://runtime.invalid' })).toThrow();
    expect(() => FederatedRuntimeRegistrationSchema.parse({ ...registration, githubCredentials: true })).toThrow();
  });

  test('result remains proposal-only and rejects raw authority or secret-shaped additions', () => {
    const binding = bindingFixture();
    const proposal = { schemaVersion: 'rorca.federated-result-proposal.v1', contractVersion: '1.0.0', proposalId: 'proposal:one',
      binding, generation: 1, sessionId: 'session:one', terminalSequence: 9, completionCandidateState: 'controller_validated',
      completionCandidateHash: h('2'), changedPaths: ['backend/src/example.ts'], changedPathHash: binding.changedPathManifestHash,
      validations: [{ validationId: 'validation:one', commandHash: h('3'), claimedOutcome: 'passed', artifactHash: h('4'), observedAt: now }],
      validationSetHash: h('5'), artifacts: [{ artifactId: 'artifact:one', contentHash: h('6'), byteLength: 128,
        restrictedReferenceId: 'restricted:one' }], artifactSetHash: h('7'), outcomeClaim: 'succeeded', observedHeadSha: sha,
      submittedAt: now, idempotencyKey: 'result:one', closeoutAuthority: 'none', lifecycleAuthority: 'none',
      mergeAuthority: 'none', deploymentAuthority: 'none' };
    expect(FederatedResultProposalSchema.parse(proposal)).toEqual(proposal);
    expect(() => FederatedResultProposalSchema.parse({ ...proposal, contextEpoch: h('8') })).toThrow();
    expect(() => FederatedResultProposalSchema.parse({ ...proposal, rawTranscript: 'secret' })).toThrow();
    expect(() => FederatedResultProposalSchema.parse({ ...proposal, mergeAuthority: 'execute' })).toThrow();
  });
});
