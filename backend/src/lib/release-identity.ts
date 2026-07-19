/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact immutable identity and local fencing for every release actuator. */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { queryOne } from '../db/index';
import { assertCanonicalRunCheckout } from './run-git-authority';
import {
  getGithubRepositoryAuthority,
  type GithubRepositoryAuthority,
} from './github-repository-authority';
import {
  resolveWorkspaceGitHubToken,
  type GithubCredentialPurpose,
  type ResolvedGitHubToken,
} from './github-token-resolver';

const FULL_SHA = /^[0-9a-f]{40}$/;
const LOCK_WAIT_MS = 10_000;

export interface RunReleaseIdentity {
  runId: number;
  workspaceId: string;
  specId: string;
  authorizedSha: string;
  branchName: string;
  workspaceRealpath: string;
  worktreeRealpath: string;
  repository: {
    owner: string;
    name: string;
    source: 'github-app-installation' | 'pat-oauth-fallback';
    bindingId: string | null;
    installationId: number | null;
    repositoryId: number | null;
  } | null;
}

interface FrozenRunRow {
  workspace_id: string;
  spec_path: string;
  branch_name: string | null;
  worktree_path: string | null;
  execution_workspace_path: string | null;
  execution_worktree_path: string | null;
  terminal_checkout_sha: string | null;
}

function sameRepository(
  expected: NonNullable<RunReleaseIdentity['repository']>,
  actual: GithubRepositoryAuthority,
): boolean {
  return expected.owner.toLowerCase() === actual.owner.toLowerCase()
    && expected.name.toLowerCase() === actual.name.toLowerCase()
    && expected.source === actual.source
    && expected.bindingId === actual.bindingId
    && expected.installationId === actual.installationId
    && expected.repositoryId === actual.repositoryId;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockPath(identity: RunReleaseIdentity): string {
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    repository: identity.workspaceRealpath,
    runId: identity.runId,
  })).digest('hex');
  return path.join(os.tmpdir(), `rorca-release-${digest}.lock`);
}

async function acquire(identity: RunReleaseIdentity): Promise<() => void> {
  const target = lockPath(identity);
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
        // The owner may be between O_EXCL creation and writing its PID. Never
        // delete a fresh unreadable lock; only reclaim a clearly stale file.
        try {
          if (Date.now() - fs.statSync(target).mtimeMs > 30_000) fs.unlinkSync(target);
        } catch { /* contender or owner changed it */ }
      }
      if (Date.now() >= deadline) throw new Error('release actuation lock is busy');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export async function withRunReleaseLock<T>(
  identity: RunReleaseIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquire(identity);
  try { return await operation(); }
  finally { release(); }
}

/** Re-read DB paths and prove the exact canonical branch/HEAD while locked. */
export async function revalidateRunReleaseIdentity(
  identity: RunReleaseIdentity,
  options: { requireLiveCheckout?: boolean } = { requireLiveCheckout: true },
): Promise<void> {
  if (!Number.isSafeInteger(identity.runId) || identity.runId <= 0
    || !FULL_SHA.test(identity.authorizedSha)) throw new Error('release identity is invalid');
  const run = await queryOne<FrozenRunRow>(`
    SELECT workspace_id, spec_path, branch_name, worktree_path,
           execution_workspace_path, execution_worktree_path, terminal_checkout_sha
      FROM pipeline_runs WHERE id = $1
  `, [identity.runId]);
  if (!run
    || run.workspace_id !== identity.workspaceId
    || path.basename(run.spec_path, '.json') !== identity.specId
    || run.branch_name !== identity.branchName
    || run.execution_workspace_path !== identity.workspaceRealpath
    || run.execution_worktree_path !== identity.worktreeRealpath) {
    throw new Error('release identity differs from DB-frozen run authority');
  }
  if (options.requireLiveCheckout !== false) {
    const checkout = assertCanonicalRunCheckout({
      cwd: identity.worktreeRealpath,
      repositoryTopLevel: identity.workspaceRealpath,
      branchName: identity.branchName,
      expectedHead: identity.authorizedSha,
    });
    if (checkout.headSha !== identity.authorizedSha) throw new Error('release HEAD advanced after authorization');
  } else if (run.terminal_checkout_sha?.toLowerCase() !== identity.authorizedSha) {
    throw new Error('immutable terminal checkout attestation differs from release SHA');
  }
}

export interface GithubReleaseActuationContext {
  identity: RunReleaseIdentity;
  authority: GithubRepositoryAuthority;
  credential: ResolvedGitHubToken;
}

/**
 * Canonical external-effect boundary. It holds the per-run/repository lock,
 * reacquires exact repository authority, resolves a purpose token last, then
 * repeats HEAD validation immediately before handing control to the actuator.
 */
export async function withGithubReleaseActuation<T>(
  identity: RunReleaseIdentity,
  purpose: GithubCredentialPurpose,
  actuator: (context: GithubReleaseActuationContext) => Promise<T>,
): Promise<T> {
  return withRunReleaseLock(identity, async () => {
    await revalidateRunReleaseIdentity(identity);
    if (!identity.repository) throw new Error('release has no frozen repository authority');
    const authority = await getGithubRepositoryAuthority(identity.workspaceId, {
      requireActive: true,
      expectedRepository: identity.repository,
    });
    if (!authority || !sameRepository(identity.repository, authority)) {
      throw new Error('canonical repository authority changed after release authorization');
    }
    const credential = await resolveWorkspaceGitHubToken(identity.workspaceId, {
      repository: { owner: authority.owner, name: authority.name },
      purpose,
    });
    if (!credential) throw new Error('purpose-scoped release credential is unavailable');
    if (authority.source === 'github-app-installation'
      && credential.source !== 'github-app-installation') {
      throw new Error('GitHub App release authority cannot downgrade to legacy credentials');
    }
    if (authority.source === 'pat-oauth-fallback'
      && !['workspace-oauth', 'workspace-pat'].includes(credential.source)) {
      throw new Error('legacy credential was not explicitly selected by repository authority');
    }
    await revalidateRunReleaseIdentity(identity);
    return actuator({ identity, authority, credential });
  });
}
