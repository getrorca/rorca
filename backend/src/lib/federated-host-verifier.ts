/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { governedHash } from './governed-contracts';
import { ConflictError, UnprocessableError } from './errors';
import type { FederatedResultProposal } from './federated-runtime-contracts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 1024 * 1024;

export interface FederatedHostWorktree {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly sourceCheckoutPath: string;
  readonly allowedPaths: readonly string[];
}

export interface FederatedHostVerificationPorts {
  loadWorktree(workspaceId: string, worktreeId: string): Promise<FederatedHostWorktree | null>;
  verifyValidation(input: { workspaceId: string; attemptId: string; validationId: string; commandHash: string; artifactHash: string }): Promise<boolean>;
  verifyArtifact(input: { workspaceId: string; artifactId: string; contentHash: string; byteLength: number; restrictedReferenceId: string }): Promise<boolean>;
}

export interface FederatedHostVerification {
  readonly schemaVersion: 'rorca.federated-host-verification.v1';
  readonly verified: true;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly worktreeId: string;
  readonly changedPaths: readonly string[];
  readonly changedPathHash: string;
  readonly gitObservationHash: string;
  readonly validationObservationHash: string;
  readonly artifactObservationHash: string;
  readonly observedAt: string;
  readonly runtimeClaimsTrust: 'runtime_asserted';
  readonly hostEvidenceTrust: 'host_observed';
  readonly closeoutAuthority: 'none';
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, timeout: 15_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return result.stdout.trimEnd();
  } catch {
    throw new ConflictError('Host Git verification failed', { reason: 'git_observation_failed', retryable: false });
  }
}

function pathPermitted(path: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`));
}

async function assertBoundedPath(root: string, path: string): Promise<void> {
  const absolute = resolve(root, path);
  const logicalRelative = relative(root, absolute);
  if (isAbsolute(path) || logicalRelative.startsWith(`..${sep}`) || logicalRelative === '..') {
    throw new UnprocessableError('Changed path escapes the isolated worktree', 'PATH_ESCAPE');
  }
  const info = await lstat(absolute).catch(() => null);
  if (info?.isSymbolicLink()) throw new UnprocessableError('Changed path may not be a symlink', 'SYMLINK_PATH_FORBIDDEN');
  const resolved = await realpath(absolute).catch(() => absolute);
  const physicalRelative = relative(root, resolved);
  if (physicalRelative.startsWith(`..${sep}`) || physicalRelative === '..') {
    throw new UnprocessableError('Changed path resolves outside the isolated worktree', 'PATH_ESCAPE');
  }
}

export class FederatedHostVerifier {
  constructor(private readonly ports: FederatedHostVerificationPorts, private readonly now: () => Date = () => new Date()) {}

  async verify(proposal: FederatedResultProposal): Promise<FederatedHostVerification> {
    const binding = proposal.binding;
    const configured = await this.ports.loadWorktree(binding.workspaceId, binding.worktreeId);
    if (!configured || configured.workspaceId !== binding.workspaceId || configured.repositoryId !== binding.repositoryId) {
      throw new ConflictError('Host worktree identity is unavailable', { reason: 'worktree_identity_missing', retryable: false });
    }
    const root = await realpath(configured.worktreePath);
    const sourceRoot = await realpath(configured.sourceCheckoutPath);
    if (root === sourceRoot || root.startsWith(`${sourceRoot}${sep}`) || sourceRoot.startsWith(`${root}${sep}`)) {
      throw new ConflictError('Federated worktree is not isolated from the source checkout', { reason: 'source_checkout_overlap', retryable: false });
    }
    const top = await realpath(await git(root, ['rev-parse', '--show-toplevel']));
    if (top !== root) throw new ConflictError('Git top-level differs from registered worktree', { reason: 'worktree_identity_mismatch', retryable: false });
    const objectFormat = await git(root, ['rev-parse', '--show-object-format']);
    const expectedLength = objectFormat === 'sha256' ? 64 : objectFormat === 'sha1' ? 40 : 0;
    if (!expectedLength || [binding.baseSha, binding.currentSha, binding.expectedHeadSha, proposal.observedHeadSha].some((sha) => sha.length !== expectedLength)) {
      throw new ConflictError('Git object format or full revision is inconsistent', { reason: 'git_identity_mismatch', retryable: false });
    }
    const head = await git(root, ['rev-parse', 'HEAD']);
    if (head !== proposal.observedHeadSha || head !== binding.expectedHeadSha) {
      throw new ConflictError('Host-observed head differs from the exact proposed revision', { reason: 'head_revision_drift', retryable: false });
    }
    if (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
      throw new ConflictError('Federated result worktree is dirty', { reason: 'dirty_worktree', retryable: false });
    }
    await git(root, ['merge-base', '--is-ancestor', binding.baseSha, head]);
    const submodules = await git(root, ['submodule', 'status', '--recursive']);
    if (submodules.split('\n').filter(Boolean).some((line) => !line.startsWith(' '))) {
      throw new ConflictError('Submodule state drifted', { reason: 'submodule_drift', retryable: false });
    }
    const remoteNames = (await git(root, ['remote'])).split('\n').filter(Boolean);
    if (remoteNames.length !== 1 || remoteNames[0] !== 'origin') {
      throw new ConflictError('Repository contains an undeclared remote', { reason: 'alternate_remote', retryable: false });
    }
    const fetchUrls = (await git(root, ['remote', 'get-url', '--all', 'origin'])).split('\n').filter(Boolean);
    const pushUrls = (await git(root, ['remote', 'get-url', '--push', '--all', 'origin'])).split('\n').filter(Boolean);
    if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] !== pushUrls[0]) {
      throw new ConflictError('Repository remote or push authority differs', { reason: 'alternate_remote', retryable: false });
    }
    const origin = fetchUrls[0]!;
    const remoteHash = governedHash('rorca.repository-remote-authority.v1', { origin });
    if (remoteHash !== binding.remoteAuthorityHash) {
      throw new ConflictError('Repository remote authority differs', { reason: 'alternate_remote', retryable: false });
    }
    const changedPaths = (await git(root, ['diff', '--name-only', '--no-renames', `${binding.baseSha}...${head}`]))
      .split('\n').filter(Boolean).sort();
    if (changedPaths.length > 500 || changedPaths.some((path) => !pathPermitted(path, configured.allowedPaths))) {
      throw new UnprocessableError('Federated result changed a forbidden path', 'FORBIDDEN_PATH');
    }
    for (const path of changedPaths) await assertBoundedPath(root, path);
    const claimedPaths = [...proposal.changedPaths].sort();
    const changedPathHash = governedHash('rorca.federated-changed-paths.v1', changedPaths as never);
    if (changedPathHash !== proposal.changedPathHash || changedPathHash !== binding.changedPathManifestHash
        || claimedPaths.length !== changedPaths.length || claimedPaths.some((path, index) => path !== changedPaths[index])) {
      throw new ConflictError('Changed path claim differs from host observation', { reason: 'changed_path_mismatch', retryable: false });
    }
    const validationObservations: Array<{ validationId: string; commandHash: string; artifactHash: string }> = [];
    for (const validation of proposal.validations) {
      if (!await this.ports.verifyValidation({ workspaceId: binding.workspaceId, attemptId: binding.attemptId,
        validationId: validation.validationId, commandHash: validation.commandHash, artifactHash: validation.artifactHash })) {
        throw new ConflictError('Required host validation evidence is missing', { reason: 'validation_unverified', retryable: false });
      }
      validationObservations.push({ validationId: validation.validationId, commandHash: validation.commandHash, artifactHash: validation.artifactHash });
    }
    const validationObservationHash = governedHash('rorca.federated-host-validations.v1', validationObservations as never);
    if (validationObservationHash !== proposal.validationSetHash) {
      throw new ConflictError('Validation claim set differs from host observations', { reason: 'validation_set_mismatch', retryable: false });
    }
    const artifactObservations: Array<{ artifactId: string; contentHash: string; byteLength: number; restrictedReferenceId: string }> = [];
    for (const artifact of proposal.artifacts) {
      if (!await this.ports.verifyArtifact({ workspaceId: binding.workspaceId, ...artifact })) {
        throw new ConflictError('Result artifact integrity is unverifiable', { reason: 'artifact_unverified', retryable: false });
      }
      artifactObservations.push(artifact);
    }
    const artifactObservationHash = governedHash('rorca.federated-host-artifacts.v1', artifactObservations as never);
    if (artifactObservationHash !== proposal.artifactSetHash) {
      throw new ConflictError('Artifact claim set differs from host observations', { reason: 'artifact_set_mismatch', retryable: false });
    }
    const observedAt = this.now().toISOString();
    return Object.freeze({ schemaVersion: 'rorca.federated-host-verification.v1', verified: true,
      repositoryId: binding.repositoryId, baseSha: binding.baseSha, headSha: head, worktreeId: binding.worktreeId,
      changedPaths: Object.freeze(changedPaths), changedPathHash,
      gitObservationHash: governedHash('rorca.federated-host-git-observation.v1', { repositoryId: binding.repositoryId,
        baseSha: binding.baseSha, headSha: head, worktreeId: binding.worktreeId, changedPaths, remoteHash, observedAt } as never),
      validationObservationHash, artifactObservationHash, observedAt, runtimeClaimsTrust: 'runtime_asserted',
      hostEvidenceTrust: 'host_observed', closeoutAuthority: 'none' });
  }
}
