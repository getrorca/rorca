/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact immutable identity and local fencing for Forgejo release actuation. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execute, queryOne, withPgAdvisoryLock } from '../db/index';
import { isGitSha } from './git-sha';
import { assertCanonicalRunCheckout } from './run-git-authority';
import {
  getWorkspaceForgejoCredential,
  resolveWorkspaceForgejoToken,
  type ForgejoCredentialPurpose,
  type ForgejoCredentialBinding,
  type ResolvedForgejoToken,
} from './forgejo-token-credential-provider';

const LOCK_WAIT_MS = 10_000;

export interface ForgejoRunReleaseIdentity {
  runId: number;
  workspaceId: string;
  specId: string;
  authorizedSha: string;
  branchName: string;
  workspaceRealpath: string;
  worktreeRealpath: string;
  baseBranch: string;
  baseSha: string;
  providerReleaseRef: string | null;
  integrationCheckoutPath: string;
  repository: {
    instanceUrl: string;
    owner: string;
    name: string;
    source: 'forgejo-token';
    bindingId: string;
    repositoryId: number | null;
  } | null;
}

interface FrozenRunRow {
  workspace_id: string;
  spec_path: string;
  branch_name: string | null;
  execution_workspace_path: string | null;
  execution_worktree_path: string | null;
  base_branch: string | null;
  base_sha: string | null;
  provider_release_ref: string | null;
  integration_checkout_path: string | null;
  terminal_checkout_sha: string | null;
}

export function sameForgejoRepository(
  expected: NonNullable<ForgejoRunReleaseIdentity['repository']>,
  actual: ForgejoCredentialBinding,
): boolean {
  return expected.instanceUrl.replace(/\/+$/, '') === actual.instanceUrl.replace(/\/+$/, '')
    && expected.owner.toLowerCase() === actual.owner.toLowerCase()
    && expected.name.toLowerCase() === actual.name.toLowerCase()
    && expected.bindingId === actual.bindingId;
}

export function forgejoCredentialMatchesRepository(
  expected: NonNullable<ForgejoRunReleaseIdentity['repository']>,
  credential: ResolvedForgejoToken,
): boolean {
  return credential.metadata.source === 'forgejo-token'
    && credential.metadata.bindingId === expected.bindingId
    && credential.metadata.owner.toLowerCase() === expected.owner.toLowerCase()
    && credential.metadata.name.toLowerCase() === expected.name.toLowerCase()
    && credential.metadata.instanceUrl.replace(/\/+$/, '') === expected.instanceUrl.replace(/\/+$/, '');
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockPaths(identity: ForgejoRunReleaseIdentity): string[] {
  const keys = [`local:${identity.workspaceRealpath}`];
  if (identity.repository) {
    keys.push(`provider:${identity.repository.owner.toLowerCase()}/${identity.repository.name.toLowerCase()}`);
  }
  return keys.map((key) => {
    const digest = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(os.tmpdir(), `rorca-forgejo-release-${digest}.lock`);
  }).sort();
}

async function acquireTarget(target: string, identity: ForgejoRunReleaseIdentity): Promise<() => void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(target, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, runId: identity.runId }));
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(target); } catch { /* already released */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const holder = JSON.parse(fs.readFileSync(target, 'utf8')) as { pid?: number };
        if (!Number.isSafeInteger(holder.pid) || !processAlive(Number(holder.pid))) {
          fs.unlinkSync(target);
          continue;
        }
      } catch {
        try {
          if (Date.now() - fs.statSync(target).mtimeMs > 30_000) fs.unlinkSync(target);
        } catch { /* contender or owner changed it */ }
      }
      if (Date.now() >= deadline) throw new Error('Forgejo release actuation lock is busy');
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 25);
      await promise;
    }
  }
}

export async function withForgejoRepositoryAuthorityLock<T>(
  workspaceId: string,
  owner: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  void owner;
  void name;
  return withPgAdvisoryLock(`forgejo-authority:${workspaceId}`, async () => {
    // Bind the lock-owning session to the exact workspace so RLS-scoped
    // Forgejo queries inside the fence resolve only that scope.
    await execute(`SELECT set_config('rorca.workspace_id', $1, FALSE)`, [workspaceId]);
    try {
      return await operation();
    } finally {
      await execute(`RESET rorca.workspace_id`).catch(() => {});
    }
  });
}

export async function withForgejoRunReleaseLock<T>(
  identity: ForgejoRunReleaseIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  return withPgAdvisoryLock(`forgejo-authority:${identity.workspaceId}`, async () => {
    const releases: Array<() => void> = [];
    await execute(`SELECT set_config('rorca.workspace_id', $1, FALSE)`, [identity.workspaceId]);
    try {
      for (const target of lockPaths(identity)) releases.push(await acquireTarget(target, identity));
      return await operation();
    } finally {
      for (const release of releases.reverse()) release();
      await execute(`RESET rorca.workspace_id`).catch(() => {});
    }
  });
}

/** Re-read DB paths and prove the exact canonical branch/HEAD while locked. */
export async function revalidateForgejoRunReleaseIdentity(
  identity: ForgejoRunReleaseIdentity,
  options: { requireLiveCheckout?: boolean } = { requireLiveCheckout: true },
): Promise<void> {
  if (!Number.isSafeInteger(identity.runId) || identity.runId <= 0
    || !isGitSha(identity.authorizedSha)
    || !isGitSha(identity.baseSha)
    || !identity.baseBranch
    || !path.isAbsolute(identity.integrationCheckoutPath)) throw new Error('Forgejo release identity is invalid');
  const run = await queryOne<FrozenRunRow>(`
    SELECT pr.workspace_id, pr.spec_path, pr.branch_name,
           pr.execution_workspace_path, pr.execution_worktree_path, pr.terminal_checkout_sha,
           ri.base_branch, ri.base_sha, ri.provider_release_ref, ri.integration_checkout_path
      FROM pipeline_runs pr
      LEFT JOIN pipeline_run_release_intents ri ON ri.run_id = pr.id
     WHERE pr.id = $1
  `, [identity.runId]);
  if (!run
    || run.workspace_id !== identity.workspaceId
    || path.basename(run.spec_path, '.json') !== identity.specId
    || run.branch_name !== identity.branchName
    || run.execution_workspace_path !== identity.workspaceRealpath
    || run.execution_worktree_path !== identity.worktreeRealpath
    || (run.base_branch != null && run.base_branch !== identity.baseBranch)
    || (run.base_sha != null && run.base_sha.toLowerCase() !== identity.baseSha)
    || (run.provider_release_ref != null && run.provider_release_ref !== identity.providerReleaseRef)
    || (run.integration_checkout_path != null && run.integration_checkout_path !== identity.integrationCheckoutPath)) {
    throw new Error('Forgejo release identity differs from DB-frozen run authority');
  }
  if (options.requireLiveCheckout !== false) {
    const checkout = assertCanonicalRunCheckout({
      cwd: identity.worktreeRealpath,
      repositoryTopLevel: identity.workspaceRealpath,
      branchName: identity.branchName,
      expectedHead: identity.authorizedSha,
    });
    if (checkout.headSha !== identity.authorizedSha) {
      throw new Error('Forgejo release HEAD advanced after authorization');
    }
  } else if (run.terminal_checkout_sha?.toLowerCase() !== identity.authorizedSha) {
    throw new Error('immutable terminal checkout attestation differs from Forgejo release SHA');
  }
}

export interface ForgejoReleaseActuationContext {
  identity: ForgejoRunReleaseIdentity;
  binding: ForgejoCredentialBinding;
  credential: ResolvedForgejoToken;
}

/**
 * Canonical external-effect boundary for Forgejo. Holds repository-wide local
 * locks, reacquires the exact credential binding, resolves the purpose token
 * last, and repeats identity revalidation immediately before the actuator.
 */
export async function withForgejoReleaseActuation<T>(
  identity: ForgejoRunReleaseIdentity,
  purpose: ForgejoCredentialPurpose,
  actuator: (context: ForgejoReleaseActuationContext) => Promise<T>,
): Promise<T> {
  return withForgejoRunReleaseLock(identity, async () => {
    await revalidateForgejoRunReleaseIdentity(identity, { requireLiveCheckout: false });
    if (!identity.repository) throw new Error('Forgejo release has no frozen repository authority');
    const binding = await getWorkspaceForgejoCredential(identity.workspaceId);
    if (!binding || !sameForgejoRepository(identity.repository, binding)) {
      throw new Error('canonical Forgejo credential binding changed after release authorization');
    }
    const credential = await resolveWorkspaceForgejoToken(identity.workspaceId, {
      repository: { owner: binding.owner, name: binding.name },
      purpose,
    });
    if (!credential || !forgejoCredentialMatchesRepository(identity.repository, credential)) {
      throw new Error('purpose-scoped Forgejo credential differs from frozen release authority');
    }
    const postTokenBinding = await getWorkspaceForgejoCredential(identity.workspaceId);
    if (!postTokenBinding || !sameForgejoRepository(identity.repository, postTokenBinding)) {
      throw new Error('Forgejo credential binding changed during token resolution');
    }
    await revalidateForgejoRunReleaseIdentity(identity, { requireLiveCheckout: false });
    return actuator({ identity, binding: postTokenBinding, credential });
  });
}
