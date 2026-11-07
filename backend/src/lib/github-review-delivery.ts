/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  GithubProviderBindingSchema,
  type GithubProviderBinding,
  type ScmCapability,
} from './authority-provider-adapter';
import {
  fetchGithubWithTimeout,
  withTrustedGithubInstallationLeaseToken,
  type GithubInstallationLeaseMetadata,
} from './github-app-credential-provider';
import { ConflictError, ForbiddenError, UnprocessableError, ValidationError } from './errors';
import { githubProviderError } from './github-provider-error';
import { assertGithubRef, githubRepoApiUrl } from './github-repository-authority';

const execFileAsync = promisify(execFile);
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REVIEWER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_PROVIDER_BODY = 1024 * 1024;
const MAX_CHANGED_PATHS = 500;
const MAX_BLOB_BYTES = 10 * 1024 * 1024;

export const GITHUB_REVIEW_DELIVERY_SCHEMA_VERSION = 'rorca.github-review-delivery.v2' as const;
/**
 * Identity used for commits Rorca pushes on the operator's behalf. Overridable
 * so self-hosted deployments attribute automation commits to themselves rather
 * than to a vendor domain they do not own.
 */
export const RORCA_GITHUB_MACHINE_IDENTITY = Object.freeze({
  name: process.env.RORCA_AUTOMATION_NAME?.trim() || 'Rorca Automation',
  email: process.env.RORCA_AUTOMATION_EMAIL?.trim() || 'automation@rorca.local',
});

const GithubExternalOperationSchema = z.enum([
  'scm.branch.write',
  'scm.pull_request.write',
  'scm.checks.read',
  'scm.review.request',
]);
export type GithubExternalOperation = z.infer<typeof GithubExternalOperationSchema>;

const ALLOWED_OPERATIONS: Readonly<Record<string, true>> = Object.freeze({
  prepareRepository: true,
  createBranch: true,
  commit: true,
  'scm.branch.write': true,
  'scm.pull_request.write': true,
  'scm.checks.read': true,
  'scm.review.request': true,
  cleanupRepository: true,
});

/** The review adapter has no merge, force-push, release, administration, secret, or deployment operation. */
export function assertGithubReviewDeliveryOperation(operation: string): void {
  if (ALLOWED_OPERATIONS[operation] !== true) {
    throw new ForbiddenError('GitHub review delivery operation is not authorized', { operation });
  }
}

const RepositorySchema = z.object({
  id: z.number().int().positive(),
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
}).strict();

export const GithubExternalSendGrantSchema = z.object({
  grantId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  repository: RepositorySchema,
  baseBranch: z.string().min(1).max(255),
  baseRevision: z.string().regex(GIT_OBJECT_ID),
  branch: z.string().min(1).max(255),
  headRevision: z.string().regex(GIT_OBJECT_ID),
  operations: z.array(GithubExternalOperationSchema).min(1).max(4)
    .refine((value) => new Set(value).size === value.length, 'External-send operations must be unique'),
  decision: z.literal('accepted'),
  externalSend: z.literal(true),
  expiresAt: z.string().datetime(),
}).strict();
export type GithubExternalSendGrant = z.infer<typeof GithubExternalSendGrantSchema>;

export interface GithubPreparedRepository {
  readonly checkoutId: string;
  readonly repositoryPath: string;
  readonly checkoutPath: string;
  readonly approvedBaseRevision: string;
  readonly isolated: true;
}

export interface GithubReviewBranch extends GithubPreparedRepository {
  readonly branch: string;
  readonly workspaceId: string;
  readonly runId: number;
  readonly storyId: string;
  readonly replayed: boolean;
}

export interface GithubReviewCommit extends GithubReviewBranch {
  readonly headRevision: string;
  readonly message: string;
  readonly authoredAt: string;
  readonly author: typeof RORCA_GITHUB_MACHINE_IDENTITY;
  readonly replayed: boolean;
}

export interface GithubBranchPushResult {
  readonly branch: string;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly replayed: boolean;
}

export interface GithubPullRequestResult {
  readonly id: number;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly headRevision: string;
  readonly replayed: boolean;
}

export const GithubCheckObservationSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['queued', 'in_progress', 'completed']),
  conclusion: z.enum([
    'action_required', 'cancelled', 'failure', 'neutral', 'skipped',
    'stale', 'startup_failure', 'success', 'timed_out',
  ]).nullable(),
}).strict();
export type GithubCheckObservation = z.infer<typeof GithubCheckObservationSchema>;

export interface GithubReviewRequestResult {
  readonly users: readonly string[];
  readonly teams: readonly string[];
  readonly replayed: boolean;
}

const GithubPullRequestReceiptSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  url: z.string().url(),
}).strict().superRefine((value, context) => {
  const parsed = new URL(value.url);
  if (parsed.origin !== 'https://github.com' || !parsed.pathname.endsWith(`/pull/${value.number}`)) {
    context.addIssue({ code: 'custom', message: 'Pull-request URL must be the canonical GitHub review URL' });
  }
});
const GithubReceiptAuthoritySchema = z.object({
  requestId: z.string().uuid(),
  grantId: z.string().uuid(),
  leaseId: z.string().uuid(),
  attempts: z.array(z.object({
    id: z.string().uuid(),
    operation: GithubExternalOperationSchema,
  }).strict()).min(4).max(64).superRefine((attempts, context) => {
    if (new Set(attempts.map(({ id }) => id)).size !== attempts.length) {
      context.addIssue({ code: 'custom', message: 'Receipt operation attempt identifiers must be unique' });
    }
    for (const operation of GithubExternalOperationSchema.options) {
      if (!attempts.some((attempt) => attempt.operation === operation)) {
        context.addIssue({ code: 'custom', message: `Receipt is missing operation lineage for ${operation}` });
      }
    }
  }),
}).strict();

export interface GithubReviewDeliveryLineage {
  workspaceId: string;
  requestId: string;
  grantId: string;
  leaseId: string;
  attempts: readonly { id: string; operation: GithubExternalOperation }[];
}

export const GithubReviewDeliveryReceiptSchema = z.object({
  schemaVersion: z.literal(GITHUB_REVIEW_DELIVERY_SCHEMA_VERSION),
  adapterId: z.literal('github-app'),
  workspaceId: z.string().min(1).max(255),
  authority: GithubReceiptAuthoritySchema,
  installationId: z.number().int().positive(),
  repository: RepositorySchema,
  approvedBaseRevision: z.string().regex(GIT_OBJECT_ID),
  headRevision: z.string().regex(GIT_OBJECT_ID),
  isolatedCheckout: z.object({
    checkoutId: z.string().uuid(),
    approvedRevision: z.string().regex(GIT_OBJECT_ID),
  }).strict(),
  branch: z.string().min(1).max(255),
  commit: z.object({
    authorName: z.literal(RORCA_GITHUB_MACHINE_IDENTITY.name),
    authorEmail: z.literal(RORCA_GITHUB_MACHINE_IDENTITY.email),
  }).strict(),
  pullRequest: GithubPullRequestReceiptSchema,
  checks: z.array(GithubCheckObservationSchema).max(100),
  reviewRequest: z.object({
    users: z.array(z.string().regex(REVIEWER)).max(15),
    teams: z.array(z.string().regex(REVIEWER)).max(15),
    requested: z.literal(true),
  }).strict(),
  replay: z.object({
    branchPush: z.boolean(),
    pullRequest: z.boolean(),
    reviewRequest: z.boolean(),
  }).strict(),
  prohibitedEffects: z.object({
    protectedBranchPush: z.literal(false),
    forcePush: z.literal(false),
    merge: z.literal(false),
    tag: z.literal(false),
    release: z.literal(false),
    repositoryAdministration: z.literal(false),
    actionsSecretMutation: z.literal(false),
    productionDeployment: z.literal(false),
  }).strict(),
}).strict().superRefine((value, context) => {
  const pullUrl = new URL(value.pullRequest.url);
  const expectedPath = `/${value.repository.owner}/${value.repository.name}/pull/${value.pullRequest.number}`.toLowerCase();
  if (pullUrl.pathname.toLowerCase() !== expectedPath) {
    context.addIssue({ code: 'custom', message: 'Pull-request URL must match the receipt repository' });
  }
  if (value.isolatedCheckout.approvedRevision !== value.approvedBaseRevision) {
    context.addIssue({ code: 'custom', message: 'Isolated checkout must match the approved base revision' });
  }
});
export type GithubReviewDeliveryReceipt = z.infer<typeof GithubReviewDeliveryReceiptSchema>;

export interface GithubReviewDeliveryPorts {
  fetch: typeof fetch;
  now: () => Date;
  worktreeRoot: string;
  withLeaseToken: <T>(
    leaseId: string,
    operation: (token: string, metadata: GithubInstallationLeaseMetadata) => Promise<T>,
  ) => Promise<T>;
}

const DEFAULT_PORTS: GithubReviewDeliveryPorts = {
  fetch,
  now: () => new Date(),
  worktreeRoot: path.join(os.tmpdir(), 'rorca-github-review-worktrees'),
  withLeaseToken: withTrustedGithubInstallationLeaseToken,
};

const ProviderRefSchema = z.object({
  object: z.object({ sha: z.string().regex(GIT_OBJECT_ID) }).passthrough(),
}).passthrough();
const ProviderObjectSchema = z.object({ sha: z.string().regex(GIT_OBJECT_ID) }).passthrough();
const ProviderPullRequestSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  head: z.object({ ref: z.string(), sha: z.string().regex(GIT_OBJECT_ID) }).passthrough(),
  base: z.object({ ref: z.string() }).passthrough(),
}).passthrough();
const ProviderCheckRunsSchema = z.object({
  check_runs: z.array(z.object({
    id: z.number().int().positive(),
    status: z.enum(['queued', 'in_progress', 'completed']),
    conclusion: GithubCheckObservationSchema.shape.conclusion,
  }).passthrough()).max(100),
}).passthrough();
const ProviderRequestedReviewersSchema = z.object({
  users: z.array(z.object({ login: z.string().regex(REVIEWER) }).passthrough()).max(100).default([]),
  teams: z.array(z.object({ slug: z.string().regex(REVIEWER) }).passthrough()).max(100).default([]),
}).passthrough();

function parseStrict<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(message);
  return parsed.data;
}

function normalizeRevision(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!GIT_OBJECT_ID.test(normalized)) throw new ValidationError(`${field} must be a full Git object id`);
  return normalized;
}

function normalizeCommitDate(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new ValidationError('authoredAt must be an ISO date-time');
  return new Date(Math.floor(timestamp / 1000) * 1000).toISOString();
}

function parseNulList(value: Buffer): string[] {
  const text = value.toString('utf8');
  if (!text) return [];
  const values = text.split('\0');
  if (values.at(-1) === '') values.pop();
  if (values.some((entry) => !entry || entry.includes('\u0000'))) {
    throw new UnprocessableError('Git returned an invalid changed path', 'GITHUB_DELIVERY_PATH_INVALID');
  }
  return values;
}

function refPath(branch: string): string {
  assertGithubRef(branch);
  return branch.split('/').map(encodeURIComponent).join('/');
}

function assertCanonicalPullRequestUrl(value: GithubPullRequestResult, repository: { owner: string; name: string }): void {
  const parsed = new URL(value.url);
  const expectedPath = `/${repository.owner}/${repository.name}/pull/${value.number}`.toLowerCase();
  if (parsed.origin !== 'https://github.com' || parsed.pathname.toLowerCase() !== expectedPath) {
    throw new UnprocessableError('GitHub returned a non-canonical pull-request URL', 'GITHUB_DELIVERY_PR_URL_INVALID');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export function buildGithubReviewBranchName(workspaceId: string, runId: number, storyId: string): string {
  if (!workspaceId.trim()) throw new ValidationError('workspaceId is required');
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new ValidationError('runId must be a positive safe integer');
  if (!storyId.trim() || storyId.length > 160) throw new ValidationError('storyId is invalid');
  const slug = storyId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'story';
  const suffix = crypto.createHash('sha256').update(`${workspaceId}\0${runId}\0${storyId}`).digest('hex').slice(0, 12);
  const branch = `rorca/run-${runId}/${slug}-${suffix}`;
  assertGithubRef(branch);
  return branch;
}

export class GithubReviewDeliveryOperations {
  private readonly ports: GithubReviewDeliveryPorts;

  constructor(ports: Partial<GithubReviewDeliveryPorts> = {}) {
    this.ports = { ...DEFAULT_PORTS, ...ports };
  }

  private async git(cwd: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<Buffer> {
    try {
      const result = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT,
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
          ...extraEnv,
        },
      });
      return result.stdout;
    } catch {
      throw new ConflictError('Credential-free Git review operation failed', {
        reason: 'github_review_git_operation_failed',
        retryable: false,
      });
    }
  }

  private async gitText(cwd: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<string> {
    return (await this.git(cwd, args, extraEnv)).toString('utf8').trimEnd();
  }

  async prepareRepository(input: {
    repositoryPath: string;
    approvedBaseRevision: string;
    checkoutLabel?: string;
  }): Promise<GithubPreparedRepository> {
    assertGithubReviewDeliveryOperation('prepareRepository');
    const approvedBaseRevision = normalizeRevision(input.approvedBaseRevision, 'approvedBaseRevision');
    const repositoryPath = await realpath(input.repositoryPath).catch(() => {
      throw new ValidationError('repositoryPath must identify an existing repository');
    });
    const topLevel = await this.gitText(repositoryPath, ['rev-parse', '--show-toplevel']);
    if (await realpath(topLevel) !== repositoryPath) {
      throw new ValidationError('repositoryPath must be the repository root');
    }
    const observedBase = normalizeRevision(
      await this.gitText(repositoryPath, ['rev-parse', '--verify', `${approvedBaseRevision}^{commit}`]),
      'approvedBaseRevision',
    );
    if (observedBase !== approvedBaseRevision) {
      throw new ConflictError('Approved base revision does not resolve exactly');
    }

    await mkdir(this.ports.worktreeRoot, { recursive: true, mode: 0o700 });
    const label = (input.checkoutLabel ?? 'review').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'review';
    const checkoutPath = await mkdtemp(path.join(this.ports.worktreeRoot, `${label}-`));
    try {
      await this.git(repositoryPath, ['worktree', 'add', '--detach', checkoutPath, approvedBaseRevision]);
      const checkoutHead = normalizeRevision(await this.gitText(checkoutPath, ['rev-parse', 'HEAD']), 'checkout HEAD');
      if (checkoutHead !== approvedBaseRevision) throw new ConflictError('Isolated checkout is not at the approved revision');
    } catch (error) {
      await rm(checkoutPath, { recursive: true, force: true });
      throw error;
    }

    return Object.freeze({
      checkoutId: crypto.randomUUID(),
      repositoryPath,
      checkoutPath,
      approvedBaseRevision,
      isolated: true as const,
    });
  }

  async createBranch(
    prepared: GithubPreparedRepository,
    identity: { workspaceId: string; runId: number; storyId: string },
  ): Promise<GithubReviewBranch> {
    assertGithubReviewDeliveryOperation('createBranch');
    const branch = buildGithubReviewBranchName(identity.workspaceId, identity.runId, identity.storyId);
    const current = await this.gitText(prepared.checkoutPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = normalizeRevision(await this.gitText(prepared.checkoutPath, ['rev-parse', 'HEAD']), 'checkout HEAD');
    if (current === branch) {
      await this.assertReusableBranchHead(prepared, head);
      return Object.freeze({ ...prepared, ...identity, branch, replayed: true });
    }
    if (current !== 'HEAD') throw new ConflictError('Isolated checkout already has an unexpected branch');
    if (head !== prepared.approvedBaseRevision) throw new ConflictError('Branch creation lost the approved base revision');

    const existing = await this.gitText(prepared.repositoryPath, [
      'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`,
    ]);
    if (existing) {
      const existingHead = normalizeRevision(existing, 'existing review branch HEAD');
      await this.assertReusableBranchHead(prepared, existingHead);
      await this.git(prepared.checkoutPath, ['checkout', branch]);
      const attachedHead = normalizeRevision(
        await this.gitText(prepared.checkoutPath, ['rev-parse', 'HEAD']),
        'attached review branch HEAD',
      );
      if (attachedHead !== existingHead) throw new ConflictError('Existing review branch changed during restart');
      return Object.freeze({ ...prepared, ...identity, branch, replayed: true });
    }

    await this.git(prepared.checkoutPath, ['checkout', '-b', branch, prepared.approvedBaseRevision]);
    return Object.freeze({ ...prepared, ...identity, branch, replayed: false });
  }

  private async assertReusableBranchHead(prepared: GithubPreparedRepository, headRevision: string): Promise<void> {
    if (headRevision === prepared.approvedBaseRevision) return;
    const count = await this.gitText(
      prepared.repositoryPath,
      ['rev-list', '--count', `${prepared.approvedBaseRevision}..${headRevision}`],
    );
    const parent = normalizeRevision(
      await this.gitText(prepared.repositoryPath, ['rev-parse', `${headRevision}^`]),
      'existing review commit parent',
    );
    if (count !== '1' || parent !== prepared.approvedBaseRevision) {
      throw new ConflictError('Existing review branch is not the single authorized review commit');
    }
  }

  async commit(branch: GithubReviewBranch, input: { message: string; authoredAt: string }): Promise<GithubReviewCommit> {
    assertGithubReviewDeliveryOperation('commit');
    if (!input.message.trim() || input.message.length > 4096 || input.message.includes('\0')) {
      throw new ValidationError('Commit message is invalid');
    }
    const authoredAt = normalizeCommitDate(input.authoredAt);
    const currentBranch = await this.gitText(branch.checkoutPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (currentBranch !== branch.branch) throw new ConflictError('Commit target is not the authorized review branch');
    const beforeHead = normalizeRevision(await this.gitText(branch.checkoutPath, ['rev-parse', 'HEAD']), 'checkout HEAD');
    const status = await this.git(branch.checkoutPath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);

    if (beforeHead !== branch.approvedBaseRevision) {
      if (status.length > 0) throw new ConflictError('Review branch already contains a commit and additional changes');
      await this.assertSingleRorcaCommit(branch, beforeHead, input.message, authoredAt);
      return Object.freeze({
        ...branch,
        headRevision: beforeHead,
        message: input.message,
        authoredAt,
        author: RORCA_GITHUB_MACHINE_IDENTITY,
        replayed: true,
      });
    }
    if (status.length === 0) throw new ValidationError('Review branch has no changes to commit');

    await this.git(branch.checkoutPath, ['add', '--all']);
    const identityEnvironment = {
      GIT_AUTHOR_NAME: RORCA_GITHUB_MACHINE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: RORCA_GITHUB_MACHINE_IDENTITY.email,
      GIT_COMMITTER_NAME: RORCA_GITHUB_MACHINE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: RORCA_GITHUB_MACHINE_IDENTITY.email,
      GIT_AUTHOR_DATE: authoredAt,
      GIT_COMMITTER_DATE: authoredAt,
    };
    await this.git(branch.checkoutPath, [
      'commit', '--no-gpg-sign', '--no-verify', '--cleanup=verbatim', '-m', input.message,
    ], identityEnvironment);
    const headRevision = normalizeRevision(await this.gitText(branch.checkoutPath, ['rev-parse', 'HEAD']), 'commit HEAD');
    await this.assertSingleRorcaCommit(branch, headRevision, input.message, authoredAt);
    return Object.freeze({
      ...branch,
      headRevision,
      message: input.message,
      authoredAt,
      author: RORCA_GITHUB_MACHINE_IDENTITY,
      replayed: false,
    });
  }

  private async assertSingleRorcaCommit(
    branch: GithubReviewBranch,
    headRevision: string,
    message: string,
    authoredAt: string,
  ): Promise<void> {
    const count = await this.gitText(branch.checkoutPath, ['rev-list', '--count', `${branch.approvedBaseRevision}..${headRevision}`]);
    const parent = normalizeRevision(await this.gitText(branch.checkoutPath, ['rev-parse', `${headRevision}^`]), 'commit parent');
    const metadata = await this.gitText(branch.checkoutPath, [
      'show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%cI%x00%B', headRevision,
    ]);
    const [authorName, authorEmail, committerName, committerEmail, authorDate, committerDate, ...messageParts] = metadata.split('\0');
    if (count !== '1' || parent !== branch.approvedBaseRevision
      || authorName !== RORCA_GITHUB_MACHINE_IDENTITY.name || authorEmail !== RORCA_GITHUB_MACHINE_IDENTITY.email
      || committerName !== RORCA_GITHUB_MACHINE_IDENTITY.name || committerEmail !== RORCA_GITHUB_MACHINE_IDENTITY.email
      || normalizeCommitDate(authorDate) !== authoredAt || normalizeCommitDate(committerDate) !== authoredAt
      || messageParts.join('\0').trimEnd() !== message.trimEnd()) {
      throw new ConflictError('Review branch must contain exactly one deterministic Rorca-authored commit');
    }
  }

  private validateGrant(
    grantInput: GithubExternalSendGrant,
    bindingInput: GithubProviderBinding,
    commit: GithubReviewCommit,
    operation: GithubExternalOperation,
  ): { grant: GithubExternalSendGrant; binding: GithubProviderBinding } {
    assertGithubReviewDeliveryOperation(operation);
    const grant = parseStrict(GithubExternalSendGrantSchema, grantInput, 'External-send grant is invalid');
    const binding = parseStrict(GithubProviderBindingSchema, bindingInput, 'GitHub provider binding is invalid');
    assertGithubRef(grant.baseBranch);
    assertGithubRef(grant.branch);
    const expectedBranch = buildGithubReviewBranchName(grant.workspaceId, commit.runId, commit.storyId);
    if (grant.branch === grant.baseBranch
      || grant.branch !== commit.branch
      || commit.workspaceId !== grant.workspaceId
      || grant.branch !== expectedBranch) {
      throw new ForbiddenError('Protected or unbound branch delivery is not authorized');
    }
    if (grant.workspaceId !== binding.workspaceId || grant.workspaceId.trim() === ''
      || grant.bindingId !== binding.bindingId || grant.bindingGeneration !== binding.bindingGeneration
      || grant.repository.id !== binding.repositoryId
      || grant.repository.owner.toLowerCase() !== binding.repository.owner.toLowerCase()
      || grant.repository.name.toLowerCase() !== binding.repository.name.toLowerCase()
      || grant.baseRevision !== commit.approvedBaseRevision || grant.headRevision !== commit.headRevision) {
      throw new ConflictError('External-send grant does not match the immutable delivery request');
    }
    if (binding.bindingStatus !== 'active' || binding.registrationStatus !== 'active'
      || binding.installationStatus !== 'active' || !binding.providerProfileVerified) {
      throw new ForbiddenError('GitHub provider binding is not healthy');
    }
    if (!grant.operations.includes(operation)) throw new ForbiddenError('External-send grant does not authorize this operation');
    const expiresAt = new Date(grant.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= this.ports.now().getTime()) {
      throw new ForbiddenError('External-send grant is expired');
    }
    return { grant, binding };
  }

  private async withOperationToken<T>(
    leaseId: string,
    grantInput: GithubExternalSendGrant,
    bindingInput: GithubProviderBinding,
    commit: GithubReviewCommit,
    operation: GithubExternalOperation,
    callback: (token: string, grant: GithubExternalSendGrant, binding: GithubProviderBinding) => Promise<T>,
  ): Promise<T> {
    const { grant, binding } = this.validateGrant(grantInput, bindingInput, commit, operation);
    return this.ports.withLeaseToken(leaseId, async (token, metadata) => {
      this.assertLease(metadata, grant, operation);
      return callback(token, grant, binding);
    });
  }

  private assertLease(
    metadata: GithubInstallationLeaseMetadata,
    grant: GithubExternalSendGrant,
    operation: GithubExternalOperation,
  ): void {
    if (metadata.workspaceId !== grant.workspaceId || metadata.bindingId !== grant.bindingId
      || metadata.bindingGeneration !== grant.bindingGeneration || metadata.authorityGrantId !== grant.grantId
      || metadata.repository.id !== grant.repository.id
      || metadata.repository.owner.toLowerCase() !== grant.repository.owner.toLowerCase()
      || metadata.repository.name.toLowerCase() !== grant.repository.name.toLowerCase()
      || !metadata.capabilities.includes(operation as ScmCapability)
      || new Date(metadata.expiresAt).getTime() <= this.ports.now().getTime()) {
      throw new ForbiddenError('Installation lease does not match the external-send grant');
    }
  }

  private async providerFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchGithubWithTimeout(this.ports.fetch, url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new UnprocessableError(
        'GitHub provider request could not be completed',
        'GITHUB_REVIEW_DELIVERY_TRANSPORT_FAILED',
      );
    }
  }

  private async providerJson<T>(response: Response, schema: z.ZodType<T>, code: string): Promise<T> {
    if (!response.ok) throw githubProviderError(response, code);
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_PROVIDER_BODY) {
      throw new UnprocessableError('GitHub provider response exceeded the safe limit', 'GITHUB_REVIEW_PROVIDER_RESPONSE_INVALID');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new UnprocessableError('GitHub provider response was invalid', 'GITHUB_REVIEW_PROVIDER_RESPONSE_INVALID');
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new UnprocessableError('GitHub provider response was invalid', 'GITHUB_REVIEW_PROVIDER_RESPONSE_INVALID');
    }
    return result.data;
  }

  private async findRemoteHead(token: string, repository: { owner: string; name: string }, branch: string): Promise<string | null> {
    const response = await this.providerFetch(token, githubRepoApiUrl(
      repository.owner,
      repository.name,
      `/git/ref/heads/${refPath(branch)}`,
    ));
    if (response.status === 404) return null;
    return (await this.providerJson(response, ProviderRefSchema, 'GITHUB_REVIEW_REF_LOOKUP_FAILED')).object.sha;
  }

  async pushBranch(input: {
    leaseId: string;
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
  }): Promise<GithubBranchPushResult> {
    return this.withOperationToken(
      input.leaseId,
      input.grant,
      input.binding,
      input.commit,
      'scm.branch.write',
      async (token, grant) => {
        const remoteHead = await this.findRemoteHead(token, grant.repository, grant.branch);
        if (remoteHead === grant.headRevision) {
          return Object.freeze({
            branch: grant.branch,
            baseRevision: grant.baseRevision,
            headRevision: grant.headRevision,
            replayed: true,
          });
        }
        if (remoteHead !== null && remoteHead !== grant.baseRevision) {
          throw new ConflictError('Remote review branch has an unexpected head revision');
        }

        const baseResponse = await this.providerFetch(token, githubRepoApiUrl(
          grant.repository.owner,
          grant.repository.name,
          `/git/commits/${grant.baseRevision}`,
        ));
        const remoteBase = await this.providerJson(baseResponse, ProviderObjectSchema, 'GITHUB_REVIEW_BASE_LOOKUP_FAILED');
        if (remoteBase.sha !== grant.baseRevision) throw new ConflictError('Remote repository does not contain the approved base revision');

        await this.publishCommitObjects(token, grant, input.commit);
        const response = remoteHead === null
          ? await this.providerFetch(token, githubRepoApiUrl(grant.repository.owner, grant.repository.name, '/git/refs'), {
            method: 'POST',
            body: JSON.stringify({ ref: `refs/heads/${grant.branch}`, sha: grant.headRevision }),
          })
          : await this.providerFetch(token, githubRepoApiUrl(
            grant.repository.owner,
            grant.repository.name,
            `/git/refs/heads/${refPath(grant.branch)}`,
          ), {
            method: 'PATCH',
            body: JSON.stringify({ sha: grant.headRevision, force: false }),
          });
        if (!response.ok) {
          const reconciled = await this.findRemoteHead(token, grant.repository, grant.branch);
          if (reconciled !== grant.headRevision) throw githubProviderError(response, 'GITHUB_REVIEW_REF_WRITE_FAILED');
        }
        return Object.freeze({
          branch: grant.branch,
          baseRevision: grant.baseRevision,
          headRevision: grant.headRevision,
          replayed: false,
        });
      },
    );
  }

  private async publishCommitObjects(
    token: string,
    grant: GithubExternalSendGrant,
    commit: GithubReviewCommit,
  ): Promise<void> {
    const changed = parseNulList(await this.git(commit.checkoutPath, [
      'diff', '--name-only', '--no-renames', '--diff-filter=ACMRTUXB', '-z',
      grant.baseRevision, grant.headRevision, '--',
    ]));
    const deleted = parseNulList(await this.git(commit.checkoutPath, [
      'diff', '--name-only', '--no-renames', '--diff-filter=D', '-z',
      grant.baseRevision, grant.headRevision, '--',
    ]));
    const allPaths = [...new Set([...changed, ...deleted])];
    if (allPaths.length === 0 || allPaths.length > MAX_CHANGED_PATHS) {
      throw new UnprocessableError('Review commit changed-path count is outside the delivery limit', 'GITHUB_REVIEW_CHANGE_LIMIT');
    }

    const tree: Array<{ path: string; mode?: string; type?: 'blob'; sha: string | null }> = [];
    for (const changedPath of changed) {
      const entry = await this.readTreeEntry(commit.checkoutPath, grant.headRevision, changedPath);
      if (entry.type !== 'blob' || !['100644', '100755', '120000'].includes(entry.mode)) {
        throw new ForbiddenError('Review delivery supports only regular files and symbolic-link blobs');
      }
      const content = await this.git(commit.checkoutPath, ['cat-file', 'blob', entry.sha]);
      if (content.byteLength > MAX_BLOB_BYTES) {
        throw new UnprocessableError('Review blob exceeds the delivery limit', 'GITHUB_REVIEW_BLOB_LIMIT');
      }
      const blobResponse = await this.providerFetch(token, githubRepoApiUrl(
        grant.repository.owner,
        grant.repository.name,
        '/git/blobs',
      ), {
        method: 'POST',
        body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
      });
      const blob = await this.providerJson(blobResponse, ProviderObjectSchema, 'GITHUB_REVIEW_BLOB_WRITE_FAILED');
      if (blob.sha !== entry.sha) throw new ConflictError('Provider blob identity differs from the local Git object');
      tree.push({ path: changedPath, mode: entry.mode, type: 'blob', sha: entry.sha });
    }
    for (const deletedPath of deleted) tree.push({ path: deletedPath, sha: null });

    const baseTree = normalizeRevision(
      await this.gitText(commit.checkoutPath, ['rev-parse', `${grant.baseRevision}^{tree}`]),
      'base tree',
    );
    const localTree = normalizeRevision(
      await this.gitText(commit.checkoutPath, ['rev-parse', `${grant.headRevision}^{tree}`]),
      'commit tree',
    );
    const treeResponse = await this.providerFetch(token, githubRepoApiUrl(
      grant.repository.owner,
      grant.repository.name,
      '/git/trees',
    ), {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTree, tree }),
    });
    const providerTree = await this.providerJson(treeResponse, ProviderObjectSchema, 'GITHUB_REVIEW_TREE_WRITE_FAILED');
    if (providerTree.sha !== localTree) throw new ConflictError('Provider tree identity differs from the local Git tree');

    const commitResponse = await this.providerFetch(token, githubRepoApiUrl(
      grant.repository.owner,
      grant.repository.name,
      '/git/commits',
    ), {
      method: 'POST',
      body: JSON.stringify({
        message: commit.message,
        tree: localTree,
        parents: [grant.baseRevision],
        author: { ...RORCA_GITHUB_MACHINE_IDENTITY, date: commit.authoredAt },
        committer: { ...RORCA_GITHUB_MACHINE_IDENTITY, date: commit.authoredAt },
      }),
    });
    const providerCommit = await this.providerJson(commitResponse, ProviderObjectSchema, 'GITHUB_REVIEW_COMMIT_WRITE_FAILED');
    if (providerCommit.sha !== grant.headRevision) {
      throw new ConflictError('Provider commit identity differs from the deterministic local commit');
    }
  }

  private async readTreeEntry(
    checkoutPath: string,
    revision: string,
    changedPath: string,
  ): Promise<{ mode: string; type: string; sha: string }> {
    if (!changedPath || path.isAbsolute(changedPath) || changedPath.split('/').some((segment) => segment === '..' || segment === '.git')) {
      throw new ForbiddenError('Changed path is not safe for review delivery');
    }
    const output = await this.gitText(checkoutPath, ['ls-tree', revision, '--', changedPath]);
    const tab = output.indexOf('\t');
    const metadata = tab < 0 ? [] : output.slice(0, tab).split(' ');
    if (metadata.length !== 3 || output.slice(tab + 1) !== changedPath || !GIT_OBJECT_ID.test(metadata[2])) {
      throw new ConflictError('Changed path does not resolve to one exact Git tree entry');
    }
    return { mode: metadata[0], type: metadata[1], sha: metadata[2] };
  }

  private async lookupPullRequest(
    token: string,
    repository: { owner: string; name: string },
    branch: string,
    baseBranch: string,
    expectedHead: string,
  ): Promise<z.infer<typeof ProviderPullRequestSchema> | null> {
    const query = `?state=all&head=${encodeURIComponent(`${repository.owner}:${branch}`)}&base=${encodeURIComponent(baseBranch)}&per_page=10`;
    const response = await this.providerFetch(token, githubRepoApiUrl(repository.owner, repository.name, `/pulls${query}`));
    const schema = z.array(ProviderPullRequestSchema).max(10);
    const pulls = await this.providerJson(response, schema, 'GITHUB_REVIEW_PR_LOOKUP_FAILED');
    if (pulls.length > 1) throw new ConflictError('More than one pull request exists for the review branch');
    const pull = pulls[0];
    if (!pull) return null;
    if (pull.head.ref !== branch || pull.base.ref !== baseBranch || pull.head.sha !== expectedHead) {
      throw new ConflictError('Existing pull request does not match the authorized review revisions');
    }
    return pull;
  }

  async createOrUpdatePullRequest(input: {
    leaseId: string;
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
    title: string;
    body: string;
  }): Promise<GithubPullRequestResult> {
    if (!input.title.trim() || input.title.length > 256 || input.body.length > 60_000) {
      throw new ValidationError('Pull-request title or body is invalid');
    }
    return this.withOperationToken(
      input.leaseId,
      input.grant,
      input.binding,
      input.commit,
      'scm.pull_request.write',
      async (token, grant) => {
        const existing = await this.lookupPullRequest(
          token, grant.repository, grant.branch, grant.baseBranch, grant.headRevision,
        );
        let pull: z.infer<typeof ProviderPullRequestSchema>;
        let replayed: boolean;
        if (existing) {
          const response = await this.providerFetch(token, githubRepoApiUrl(
            grant.repository.owner,
            grant.repository.name,
            `/pulls/${existing.number}`,
          ), {
            method: 'PATCH',
            body: JSON.stringify({ title: input.title, body: input.body, base: grant.baseBranch, state: 'open' }),
          });
          pull = await this.providerJson(response, ProviderPullRequestSchema, 'GITHUB_REVIEW_PR_UPDATE_FAILED');
          replayed = true;
        } else {
          const response = await this.providerFetch(token, githubRepoApiUrl(
            grant.repository.owner,
            grant.repository.name,
            '/pulls',
          ), {
            method: 'POST',
            body: JSON.stringify({ title: input.title, body: input.body, head: grant.branch, base: grant.baseBranch, draft: false }),
          });
          if (!response.ok) {
            const reconciled = await this.lookupPullRequest(
              token, grant.repository, grant.branch, grant.baseBranch, grant.headRevision,
            );
            if (!reconciled) throw githubProviderError(response, 'GITHUB_REVIEW_PR_CREATE_FAILED');
            pull = reconciled;
            replayed = true;
          } else {
            pull = await this.providerJson(response, ProviderPullRequestSchema, 'GITHUB_REVIEW_PR_CREATE_FAILED');
            replayed = false;
          }
        }
        const result = Object.freeze({
          id: pull.id,
          number: pull.number,
          url: pull.html_url,
          branch: grant.branch,
          baseBranch: grant.baseBranch,
          headRevision: grant.headRevision,
          replayed,
        });
        if (pull.head.ref !== result.branch || pull.head.sha !== result.headRevision || pull.base.ref !== result.baseBranch) {
          throw new ConflictError('GitHub pull request response does not match the authorized branch');
        }
        assertCanonicalPullRequestUrl(result, grant.repository);
        return result;
      },
    );
  }

  async observeChecks(input: {
    leaseId: string;
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
  }): Promise<readonly GithubCheckObservation[]> {
    return this.withOperationToken(
      input.leaseId,
      input.grant,
      input.binding,
      input.commit,
      'scm.checks.read',
      async (token, grant) => {
        const response = await this.providerFetch(token, githubRepoApiUrl(
          grant.repository.owner,
          grant.repository.name,
          `/commits/${grant.headRevision}/check-runs?filter=latest&per_page=100`,
        ));
        const body = await this.providerJson(response, ProviderCheckRunsSchema, 'GITHUB_REVIEW_CHECKS_LOOKUP_FAILED');
        return Object.freeze(body.check_runs
          .map(({ id, status, conclusion }) => Object.freeze({ id, status, conclusion }))
          .sort((left, right) => left.id - right.id));
      },
    );
  }

  async requestReview(input: {
    leaseId: string;
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
    pullRequest: GithubPullRequestResult;
    users?: readonly string[];
    teams?: readonly string[];
  }): Promise<GithubReviewRequestResult> {
    const users = [...new Set(input.users ?? [])];
    const teams = [...new Set(input.teams ?? [])];
    if (users.length + teams.length === 0 || users.length > 15 || teams.length > 15
      || users.some((reviewer) => !REVIEWER.test(reviewer))
      || teams.some((reviewer) => !REVIEWER.test(reviewer))) {
      throw new ValidationError('At least one valid review target is required');
    }
    if (input.pullRequest.branch !== input.commit.branch
      || input.pullRequest.headRevision !== input.commit.headRevision) {
      throw new ConflictError('Review request pull request does not match the authorized commit');
    }
    return this.withOperationToken(
      input.leaseId,
      input.grant,
      input.binding,
      input.commit,
      'scm.review.request',
      async (token, grant) => {
        const url = githubRepoApiUrl(
          grant.repository.owner,
          grant.repository.name,
          `/pulls/${input.pullRequest.number}/requested_reviewers`,
        );
        const currentResponse = await this.providerFetch(token, url);
        const current = await this.providerJson(
          currentResponse,
          ProviderRequestedReviewersSchema,
          'GITHUB_REVIEW_REQUEST_LOOKUP_FAILED',
        );
        const currentUsers = new Set(current.users.map(({ login }) => login.toLowerCase()));
        const currentTeams = new Set(current.teams.map(({ slug }) => slug.toLowerCase()));
        const replayed = users.every((reviewer) => currentUsers.has(reviewer.toLowerCase()))
          && teams.every((reviewer) => currentTeams.has(reviewer.toLowerCase()));
        if (!replayed) {
          const response = await this.providerFetch(token, url, {
            method: 'POST',
            body: JSON.stringify({ reviewers: users, team_reviewers: teams }),
          });
          await this.providerJson(response, ProviderRequestedReviewersSchema, 'GITHUB_REVIEW_REQUEST_FAILED');
        }
        return Object.freeze({ users: Object.freeze(users), teams: Object.freeze(teams), replayed });
      },
    );
  }

  createReceipt(input: {
    lineage: GithubReviewDeliveryLineage;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
    push: GithubBranchPushResult;
    pullRequest: GithubPullRequestResult;
    checks: readonly GithubCheckObservation[];
    reviewRequest: GithubReviewRequestResult;
  }): GithubReviewDeliveryReceipt {
    if (input.binding.repositoryId === null
      || input.lineage.workspaceId !== input.binding.workspaceId
      || input.commit.workspaceId !== input.lineage.workspaceId
      || input.commit.approvedBaseRevision !== input.push.baseRevision
      || input.commit.headRevision !== input.push.headRevision
      || input.commit.branch !== input.push.branch
      || input.pullRequest.headRevision !== input.commit.headRevision
      || input.pullRequest.branch !== input.commit.branch) {
      throw new ConflictError('Review delivery facts do not describe one immutable repository journey');
    }
    const receipt = GithubReviewDeliveryReceiptSchema.parse({
      schemaVersion: GITHUB_REVIEW_DELIVERY_SCHEMA_VERSION,
      adapterId: 'github-app',
      workspaceId: input.lineage.workspaceId,
      authority: {
        requestId: input.lineage.requestId,
        grantId: input.lineage.grantId,
        leaseId: input.lineage.leaseId,
        attempts: input.lineage.attempts.map(({ id, operation }) => ({ id, operation })),
      },
      installationId: input.binding.installationId,
      repository: {
        id: input.binding.repositoryId,
        owner: input.binding.repository.owner,
        name: input.binding.repository.name,
      },
      approvedBaseRevision: input.commit.approvedBaseRevision,
      headRevision: input.commit.headRevision,
      isolatedCheckout: {
        checkoutId: input.commit.checkoutId,
        approvedRevision: input.commit.approvedBaseRevision,
      },
      branch: input.commit.branch,
      commit: {
        authorName: RORCA_GITHUB_MACHINE_IDENTITY.name,
        authorEmail: RORCA_GITHUB_MACHINE_IDENTITY.email,
      },
      pullRequest: {
        id: input.pullRequest.id,
        number: input.pullRequest.number,
        url: input.pullRequest.url,
      },
      checks: input.checks,
      reviewRequest: {
        users: [...input.reviewRequest.users],
        teams: [...input.reviewRequest.teams],
        requested: true,
      },
      replay: {
        branchPush: input.push.replayed,
        pullRequest: input.pullRequest.replayed,
        reviewRequest: input.reviewRequest.replayed,
      },
      prohibitedEffects: {
        protectedBranchPush: false,
        forcePush: false,
        merge: false,
        tag: false,
        release: false,
        repositoryAdministration: false,
        actionsSecretMutation: false,
        productionDeployment: false,
      },
    });
    return deepFreeze(receipt);
  }

  async cleanupRepository(prepared: GithubPreparedRepository): Promise<{ replayed: boolean }> {
    assertGithubReviewDeliveryOperation('cleanupRepository');
    const exists = await stat(prepared.checkoutPath).then(() => true, () => false);
    if (!exists) return Object.freeze({ replayed: true });
    await this.git(prepared.repositoryPath, ['worktree', 'remove', '--force', prepared.checkoutPath]);
    await rm(prepared.checkoutPath, { recursive: true, force: true });
    return Object.freeze({ replayed: false });
  }
}
