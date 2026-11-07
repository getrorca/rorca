/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { governedHash } from '../governed-contracts';
import { FederatedHostVerifier } from '../federated-host-verifier';
import type { FederatedResultProposal } from '../federated-runtime-contracts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

const h = (value: string): string => `sha256:${value.repeat(64)}`;
function bindingFixture() {
  const sha = 'a'.repeat(40);
  return { workspaceId: 'workspace:one', runtimeId: 'runtime:pilot', missionId: 'mission:one', missionRevision: 1,
    missionHash: h('1'), workPackageId: 'work-package:one', workPackageRevision: 1, workPackageHash: h('2'),
    specId: 'spec:one', specVersion: 1, specHash: h('3'), storyId: 'story:one', storyVersion: 1, storyHash: h('4'),
    criteriaManifestHash: h('5'), attemptId: 'attempt:one', leaseId: 'lease:one', fencingToken: 1,
    expectedLeaseExpiresAt: '2026-08-05T13:00:00.000Z', policyDefinitionHash: h('6'), policyActivationId: 'activation:one',
    policyActivationRevision: 1, policyActivationHash: h('7'), checkpointId: 'checkpoint:one', checkpointHash: h('8'),
    retrievalReceiptId: 'receipt:one', retrievalReceiptHash: h('9'), bundleId: 'bundle:one', bundleHash: h('a'),
    dispatchId: 'dispatch:one', dispatchHash: h('b'), repositoryId: 'repository:one', remoteAuthorityHash: h('c'),
    baseSha: sha, currentSha: sha, expectedHeadSha: sha, worktreeId: 'worktree:one', allowedPathManifestHash: h('d'),
    requiredPathManifestHash: h('e'), changedPathManifestHash: h('f'), forbiddenPathManifestHash: h('0'),
    validationManifestHash: h('1') };
}

function proposalFixture(baseSha: string, headSha: string, changedPaths: string[], bindingPatch: Record<string, unknown> = {}) {
  const validation = { validationId: 'validation:one', commandHash: h('1'), claimedOutcome: 'passed' as const,
    artifactHash: h('2'), observedAt: '2026-08-05T12:00:00.000Z' };
  const artifact = { artifactId: 'artifact:one', contentHash: h('3'), byteLength: 64, restrictedReferenceId: 'restricted:one' };
  const changedPathHash = governedHash('rorca.federated-changed-paths.v1', changedPaths);
  const binding = { ...bindingFixture(), baseSha, currentSha: baseSha, expectedHeadSha: headSha,
    remoteAuthorityHash: governedHash('rorca.repository-remote-authority.v1', { origin: 'https://example.invalid/rorca.git' }),
    changedPathManifestHash: changedPathHash, ...bindingPatch };
  return { schemaVersion: 'rorca.federated-result-proposal.v1', contractVersion: '1.0.0', proposalId: 'proposal:one',
    binding, generation: 1, sessionId: 'session:one', terminalSequence: 3, completionCandidateState: 'controller_validated',
    completionCandidateHash: h('4'), changedPaths, changedPathHash, validations: [validation],
    validationSetHash: governedHash('rorca.federated-host-validations.v1',
      [{ validationId: validation.validationId, commandHash: validation.commandHash, artifactHash: validation.artifactHash }]),
    artifacts: [artifact], artifactSetHash: governedHash('rorca.federated-host-artifacts.v1', [artifact]),
    outcomeClaim: 'succeeded', observedHeadSha: headSha, submittedAt: '2026-08-05T12:00:00.000Z',
    idempotencyKey: 'result:one', closeoutAuthority: 'none', lifecycleAuthority: 'none',
    mergeAuthority: 'none', deploymentAuthority: 'none' } as FederatedResultProposal;
}

describe('FederatedHostVerifier', () => {
  let root: string;
  let repository: string;
  let source: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rorca-wave4-host-'));
    repository = join(root, 'worktree');
    source = join(root, 'source-checkout');
    mkdirSync(repository); mkdirSync(source);
    git(repository, 'init'); git(repository, 'config', 'user.email', 'host@example.test'); git(repository, 'config', 'user.name', 'Host Test');
    git(repository, 'remote', 'add', 'origin', 'https://example.invalid/rorca.git');
    writeFileSync(join(repository, 'base.txt'), 'base\n'); git(repository, 'add', 'base.txt'); git(repository, 'commit', '-m', 'base');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function verifierFor(proposal: FederatedResultProposal, allowedPaths: string[] = ['backend'],
    worktreePath = repository, sourceCheckoutPath = source) {
    return new FederatedHostVerifier({
      loadWorktree: async () => ({ workspaceId: proposal.binding.workspaceId, worktreeId: proposal.binding.worktreeId,
        repositoryId: proposal.binding.repositoryId, worktreePath, sourceCheckoutPath, allowedPaths }),
      verifyValidation: async () => true, verifyArtifact: async () => true,
    }, () => new Date('2026-08-05T12:01:00.000Z'));
  }

  function committedProposal(path = 'backend/result.ts', content = 'export const result = true;\n') {
    const baseSha = git(repository, 'rev-parse', 'HEAD');
    mkdirSync(join(repository, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(repository, path), content);
    git(repository, 'add', path); git(repository, 'commit', '-m', `change ${path}`);
    const headSha = git(repository, 'rev-parse', 'HEAD');
    return { baseSha, headSha, proposal: proposalFixture(baseSha, headSha, [path]) };
  }

  test('independently observes full Git identity, bounded paths, validations, and artifact integrity', async () => {
    const baseSha = git(repository, 'rev-parse', 'HEAD');
    mkdirSync(join(repository, 'backend')); writeFileSync(join(repository, 'backend', 'result.ts'), 'export const result = true;\n');
    git(repository, 'add', 'backend/result.ts'); git(repository, 'commit', '-m', 'result');
    const headSha = git(repository, 'rev-parse', 'HEAD');
    const changedPaths = ['backend/result.ts'];
    const changedPathHash = governedHash('rorca.federated-changed-paths.v1', changedPaths);
    const validation = { validationId: 'validation:one', commandHash: h('1'), claimedOutcome: 'passed' as const,
      artifactHash: h('2'), observedAt: '2026-08-05T12:00:00.000Z' };
    const validationSetHash = governedHash('rorca.federated-host-validations.v1',
      [{ validationId: validation.validationId, commandHash: validation.commandHash, artifactHash: validation.artifactHash }]);
    const artifact = { artifactId: 'artifact:one', contentHash: h('3'), byteLength: 64, restrictedReferenceId: 'restricted:one' };
    const artifactSetHash = governedHash('rorca.federated-host-artifacts.v1', [artifact]);
    const binding = { ...bindingFixture(), baseSha, currentSha: baseSha, expectedHeadSha: headSha,
      remoteAuthorityHash: governedHash('rorca.repository-remote-authority.v1', { origin: 'https://example.invalid/rorca.git' }),
      changedPathManifestHash: changedPathHash };
    const proposal = { schemaVersion: 'rorca.federated-result-proposal.v1', contractVersion: '1.0.0', proposalId: 'proposal:one',
      binding, generation: 1, sessionId: 'session:one', terminalSequence: 3, completionCandidateState: 'controller_validated',
      completionCandidateHash: h('4'), changedPaths, changedPathHash, validations: [validation], validationSetHash,
      artifacts: [artifact], artifactSetHash, outcomeClaim: 'succeeded', observedHeadSha: headSha,
      submittedAt: '2026-08-05T12:00:00.000Z', idempotencyKey: 'result:one', closeoutAuthority: 'none',
      lifecycleAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none' } as FederatedResultProposal;
    const verifier = new FederatedHostVerifier({
      loadWorktree: async () => ({ workspaceId: binding.workspaceId, worktreeId: binding.worktreeId,
        repositoryId: binding.repositoryId, worktreePath: repository, sourceCheckoutPath: source, allowedPaths: ['backend'] }),
      verifyValidation: async () => true, verifyArtifact: async () => true,
    }, () => new Date('2026-08-05T12:01:00.000Z'));
    await expect(verifier.verify(proposal)).resolves.toMatchObject({ verified: true, baseSha, headSha,
      changedPaths, changedPathHash, runtimeClaimsTrust: 'runtime_asserted', hostEvidenceTrust: 'host_observed', closeoutAuthority: 'none' });
    writeFileSync(join(repository, 'backend', 'result.ts'), 'dirty runtime mutation\n');
    await expect(verifier.verify(proposal)).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'dirty_worktree', retryable: false } });
  });

  test('fails closed on a short SHA while preserving the committed result', async () => {
    const { headSha, proposal } = committedProposal();
    const short = { ...proposal, binding: { ...proposal.binding, baseSha: proposal.binding.baseSha.slice(0, 12) } };
    await expect(verifierFor(short).verify(short)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'git_identity_mismatch', retryable: false },
    });
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(existsSync(join(repository, 'backend/result.ts'))).toBe(true);
  });

  test('fails closed on an alternate remote while preserving the worktree', async () => {
    const { headSha, proposal } = committedProposal();
    git(repository, 'remote', 'set-url', 'origin', 'https://alternate.invalid/rorca.git');
    await expect(verifierFor(proposal).verify(proposal)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'alternate_remote', retryable: false },
    });
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  test.each([
    ['an undeclared remote', () => git(repository, 'remote', 'add', 'mirror', 'https://mirror.invalid/rorca.git')],
    ['an undeclared push URL', () => git(repository, 'remote', 'set-url', '--push', 'origin', 'https://push.invalid/rorca.git')],
  ])('fails closed on %s', async (_label, mutateRemote) => {
    const { headSha, proposal } = committedProposal();
    mutateRemote();
    await expect(verifierFor(proposal).verify(proposal)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'alternate_remote', retryable: false },
    });
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  test('fails closed on a committed symlink escape without deleting its artifact', async () => {
    const baseSha = git(repository, 'rev-parse', 'HEAD');
    mkdirSync(join(repository, 'backend'));
    writeFileSync(join(root, 'outside.txt'), 'restricted outside artifact\n');
    symlinkSync(join(root, 'outside.txt'), join(repository, 'backend', 'escape'));
    git(repository, 'add', 'backend/escape'); git(repository, 'commit', '-m', 'symlink escape');
    const headSha = git(repository, 'rev-parse', 'HEAD');
    const proposal = proposalFixture(baseSha, headSha, ['backend/escape']);
    await expect(verifierFor(proposal).verify(proposal)).rejects.toMatchObject({ code: 'SYMLINK_PATH_FORBIDDEN' });
    expect(existsSync(join(root, 'outside.txt'))).toBe(true);
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  test('fails closed when the registered worktree escapes into the source checkout', async () => {
    const { headSha, proposal } = committedProposal();
    await expect(verifierFor(proposal, ['backend'], repository, root).verify(proposal)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'source_checkout_overlap', retryable: false },
    });
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  test('fails closed when the source checkout is nested inside the runtime worktree', async () => {
    const { headSha, proposal } = committedProposal();
    const nestedSource = join(repository, 'nested-source-checkout');
    mkdirSync(nestedSource);
    await expect(verifierFor(proposal, ['backend'], repository, nestedSource).verify(proposal)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'source_checkout_overlap', retryable: false },
    });
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  test('fails closed on submodule drift while preserving the superproject artifact', async () => {
    const dependency = join(root, 'dependency');
    mkdirSync(dependency); git(dependency, 'init'); git(dependency, 'config', 'user.email', 'host@example.test');
    git(dependency, 'config', 'user.name', 'Host Test'); writeFileSync(join(dependency, 'dependency.txt'), 'one\n');
    git(dependency, 'add', 'dependency.txt'); git(dependency, 'commit', '-m', 'dependency');
    const baseSha = git(repository, 'rev-parse', 'HEAD');
    execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', repository, 'submodule', 'add', dependency, 'vendor/dependency']);
    git(repository, 'commit', '-am', 'add dependency');
    const headSha = git(repository, 'rev-parse', 'HEAD');
    const proposal = proposalFixture(baseSha, headSha, ['.gitmodules', 'vendor/dependency']);
    rmSync(join(repository, 'vendor/dependency'), { recursive: true, force: true });
    await expect(verifierFor(proposal, ['.gitmodules', 'vendor']).verify(proposal)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'dirty_worktree', retryable: false },
    });
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  test('fails closed on a dirty base and preserves the uncommitted artifact', async () => {
    const { proposal } = committedProposal();
    writeFileSync(join(repository, 'base.txt'), 'dirty base mutation\n');
    await expect(verifierFor(proposal).verify(proposal)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'dirty_worktree', retryable: false },
    });
    expect(existsSync(join(repository, 'base.txt'))).toBe(true);
    expect(git(repository, 'status', '--porcelain=v1')).toContain('base.txt');
  });

  test('fails closed on a forbidden file and preserves its commit', async () => {
    const { headSha, proposal } = committedProposal('secrets/forbidden.txt', 'bounded artifact, never integrated\n');
    await expect(verifierFor(proposal).verify(proposal)).rejects.toMatchObject({ code: 'FORBIDDEN_PATH' });
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(existsSync(join(repository, 'secrets/forbidden.txt'))).toBe(true);
  });

  test('fails closed on a changed-path context mismatch and preserves exact Git state', async () => {
    const { headSha, proposal } = committedProposal();
    const mismatched = { ...proposal, binding: { ...proposal.binding, changedPathManifestHash: h('9') } };
    await expect(verifierFor(mismatched).verify(mismatched)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'changed_path_mismatch', retryable: false },
    });
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(git(repository, 'status', '--porcelain=v1')).toBe('');
  });
});
