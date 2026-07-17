/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Read-only GitHub PR observation and append-only exact-SHA evidence.
 *
 * The caller selects a canonical Rorca run, not an arbitrary repository/PR.
 * Repository, PR number, head branch, base branch, and policy scope are derived
 * server-side. GitHub is never mutated by this module.
 */

import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db/index';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import {
  getActiveAutonomousDeliveryPolicy,
  stablePolicyJson,
  type AutonomousDeliveryPolicyRecord,
} from './autonomous-delivery-policy';
import { githubRateLimiter } from './github-rate-limiter';
import { resolveWorkspaceGitHubToken } from './github-token-resolver';
import { paginateQuery, type PaginatedResponse, type PaginationParams } from './paginate';

export const GITHUB_PR_DELIVERY_EVIDENCE_SCHEMA_VERSION = 'rorca.github-pr-delivery-evidence.v1' as const;
const MAX_PROVIDER_ITEMS = 500;
const PER_PAGE = 100;
const FULL_SHA = /^[0-9a-f]{40,64}$/;

export interface DeliveryEvidencePrincipal {
  principalId: string;
  displayLabel: string;
}

export interface NormalizedGithubCheck {
  source: 'check_run' | 'commit_status';
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  completed: boolean;
  providerUrl: string | null;
  observedAt: string | null;
  app: string | null;
}

export interface NormalizedGithubReview {
  id: string;
  reviewer: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending' | 'unknown';
  commitSha: string | null;
  currentHead: boolean;
  submittedAt: string | null;
  authorAssociation: string | null;
}

export interface GithubCheckSummary {
  required: string[];
  passing: string[];
  pending: string[];
  failing: string[];
  missing: string[];
  allRequiredPassed: boolean;
  policyAvailable: boolean;
  policyScopeMatches: boolean;
  truncated: boolean;
}

export interface GithubReviewSummary {
  minimumApprovals: number | null;
  currentApprovals: number;
  approvedReviewers: string[];
  requiredReviewers: string[];
  missingRequiredReviewers: string[];
  changesRequestedBy: string[];
  requireCodeOwnerReview: boolean;
  codeOwnerReviewStatus: 'not_required' | 'unverified';
  reviewSatisfied: boolean;
  policyAvailable: boolean;
  policyScopeMatches: boolean;
  truncated: boolean;
}

export interface GithubPrDeliveryEvidence {
  schemaVersion: typeof GITHUB_PR_DELIVERY_EVIDENCE_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  runId: number;
  specSlug: string;
  policy: { id: string; digest: string } | null;
  repository: { owner: string; name: string };
  pullRequest: {
    number: number;
    url: string;
    state: 'open' | 'closed';
    draft: boolean;
    merged: boolean;
    headRef: string;
    baseRef: string;
    headSha: string;
    baseSha: string;
    mergeCommitSha: string | null;
    mergeable: boolean | null;
    mergeableState: string;
  };
  freshness: {
    comparisonStatus: 'ahead' | 'behind' | 'diverged' | 'identical' | 'unknown';
    aheadBy: number;
    behindBy: number;
    branchFresh: boolean;
  };
  checks: NormalizedGithubCheck[];
  checksTruncated: boolean;
  reviews: NormalizedGithubReview[];
  reviewsTruncated: boolean;
  checkSummary: GithubCheckSummary;
  reviewSummary: GithubReviewSummary;
  providerObservedAt: string;
  observedBy: DeliveryEvidencePrincipal;
  payloadHash: `sha256:${string}`;
  createdAt: string;
}

interface RunBindingRow {
  id: number | string;
  workspace_id: string;
  spec_path: string;
  branch_name: string | null;
  pr_number: number | string | null;
  repo_owner: string;
  repo_name: string;
  auto_pr_target_branch: string;
}

interface EvidenceRow {
  id: string;
  workspace_id: string;
  run_id: number | string;
  policy_id: string | null;
  policy_digest: string | null;
  repo_owner: string;
  repo_name: string;
  pr_number: number | string;
  pr_url: string;
  pr_state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  head_ref: string;
  base_ref: string;
  head_sha: string;
  base_sha: string;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  mergeable_state: string;
  comparison_status: GithubPrDeliveryEvidence['freshness']['comparisonStatus'];
  ahead_by: number | string;
  behind_by: number | string;
  branch_fresh: boolean;
  checks: unknown;
  checks_truncated: boolean;
  reviews: unknown;
  reviews_truncated: boolean;
  check_summary: unknown;
  review_summary: unknown;
  provider_observed_at: string | Date;
  observed_by_principal_id: string;
  observed_by_display_label: string;
  payload_hash: `sha256:${string}`;
  created_at: string | Date;
  spec_slug?: string;
}

interface GithubPullResponse {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  merge_commit_sha?: string | null;
  updated_at?: string;
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base: { ref: string; sha: string; repo?: { full_name?: string } | null };
}

interface GithubEvidenceDependencies {
  fetchJson: <T>(url: string, token: string) => Promise<T>;
  resolveToken: typeof resolveWorkspaceGitHubToken;
  getActivePolicy: typeof getActiveAutonomousDeliveryPolicy;
  queryOne: typeof queryOne;
  query: typeof query;
  transaction: typeof transaction;
  now: () => Date;
}

async function defaultFetchJson<T>(url: string, token: string): Promise<T> {
  const response = await githubRateLimiter.execute(() => fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Rorca-OSS',
    },
  }));
  if (!response.ok) {
    throw new UnprocessableError(`GitHub evidence request failed with status ${response.status}`, 'GITHUB_EVIDENCE_UNAVAILABLE', {
      providerStatus: response.status,
    });
  }
  return response.json() as Promise<T>;
}

const DEFAULT_DEPS: GithubEvidenceDependencies = {
  fetchJson: defaultFetchJson,
  resolveToken: resolveWorkspaceGitHubToken,
  getActivePolicy: getActiveAutonomousDeliveryPolicy,
  queryOne,
  query,
  transaction,
  now: () => new Date(),
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value ?? fallback) as T;
}

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function boundedText(value: unknown, maxLength = 255): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeProviderUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || (url.hostname !== 'github.com' && url.hostname !== 'api.github.com')) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

function normalizedSha(value: unknown, field: string): string {
  const sha = boundedText(value, 64).toLowerCase();
  if (!FULL_SHA.test(sha)) throw new ValidationError(`${field} must be a full Git commit SHA`, { field });
  return sha;
}

function specSlug(specPath: string): string {
  return specPath.split('/').pop()?.replace(/\.json$/i, '') || specPath;
}

function payloadDigest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(stablePolicyJson(value), 'utf8').digest('hex')}`;
}

function githubApi(owner: string, repo: string, suffix: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

function checkConclusionPass(value: string | null): boolean {
  // Neutral/skipped are not success unless a future immutable policy schema
  // explicitly opts into them.
  return value === 'success';
}

function newerProviderItem(
  candidate: { id: string; observedAt?: string | null; submittedAt?: string | null },
  current: { id: string; observedAt?: string | null; submittedAt?: string | null },
): boolean {
  const candidateObservedAt = candidate.observedAt ?? candidate.submittedAt;
  const currentObservedAt = current.observedAt ?? current.submittedAt;
  const candidateTime = candidateObservedAt ? new Date(candidateObservedAt).getTime() : 0;
  const currentTime = currentObservedAt ? new Date(currentObservedAt).getTime() : 0;
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  try { return BigInt(candidate.id) > BigInt(current.id); } catch { return candidate.id.localeCompare(current.id) > 0; }
}

function latestCheckIdentities(checks: NormalizedGithubCheck[]): NormalizedGithubCheck[] {
  const latest = new Map<string, NormalizedGithubCheck>();
  for (const check of checks) {
    const key = `${check.source}:${check.name.toLowerCase()}:${(check.app ?? 'unknown').toLowerCase()}`;
    const current = latest.get(key);
    if (!current || newerProviderItem(check, current)) latest.set(key, check);
  }
  return [...latest.values()];
}

function checkIsPending(check: NormalizedGithubCheck): boolean {
  return !check.completed || check.status === 'queued' || check.status === 'in_progress' || check.status === 'pending';
}

function summarizeChecks(
  checks: NormalizedGithubCheck[],
  truncated: boolean,
  policy: AutonomousDeliveryPolicyRecord | null,
  policyScopeMatches: boolean,
): GithubCheckSummary {
  const required = policy?.requiredChecks ?? [];
  const passing: string[] = [];
  const pending: string[] = [];
  const failing: string[] = [];
  const missing: string[] = [];

  for (const name of required) {
    const matches = latestCheckIdentities(checks.filter((check) => check.name === name));
    if (matches.length === 0) {
      missing.push(name);
      continue;
    }
    // Every latest provider identity sharing the required context must pass.
    // A spoofed success cannot mask the real app's pending/failing result.
    if (matches.some(checkIsPending)) pending.push(name);
    else if (matches.every((check) => check.completed && checkConclusionPass(check.conclusion))) passing.push(name);
    else failing.push(name);
  }
  return {
    required,
    passing,
    pending,
    failing,
    missing,
    allRequiredPassed: Boolean(policy) && policyScopeMatches && !truncated && pending.length === 0 && failing.length === 0 && missing.length === 0,
    policyAvailable: Boolean(policy),
    policyScopeMatches,
    truncated,
  };
}

function summarizeReviews(
  reviews: NormalizedGithubReview[],
  truncated: boolean,
  policy: AutonomousDeliveryPolicyRecord | null,
  policyScopeMatches: boolean,
): GithubReviewSummary {
  const latestByReviewer = new Map<string, NormalizedGithubReview>();
  for (const review of reviews) {
    const key = review.reviewer.toLowerCase();
    const current = latestByReviewer.get(key);
    if (!current || newerProviderItem(review, current)) latestByReviewer.set(key, review);
  }
  const latest = [...latestByReviewer.values()];
  const approvedReviewers = latest
    .filter((review) => review.currentHead && review.state === 'approved')
    .map((review) => review.reviewer)
    .sort((left, right) => left.localeCompare(right));
  const changesRequestedBy = latest
    // A push does not erase an unresolved change request. Only a later
    // provider-authoritative review state by that reviewer supersedes it.
    .filter((review) => review.state === 'changes_requested')
    .map((review) => review.reviewer)
    .sort((left, right) => left.localeCompare(right));
  const requiredReviewers = policy?.reviewRules.requiredReviewers ?? [];
  const approvedKeys = new Set(approvedReviewers.map((reviewer) => reviewer.toLowerCase()));
  const missingRequiredReviewers = requiredReviewers.filter((reviewer) => !approvedKeys.has(reviewer.toLowerCase()));
  const requireCodeOwnerReview = policy?.reviewRules.requireCodeOwnerReview ?? false;
  const minimumApprovals = policy?.reviewRules.minimumApprovals ?? null;
  return {
    minimumApprovals,
    currentApprovals: approvedReviewers.length,
    approvedReviewers,
    requiredReviewers,
    missingRequiredReviewers,
    changesRequestedBy,
    requireCodeOwnerReview,
    codeOwnerReviewStatus: requireCodeOwnerReview ? 'unverified' : 'not_required',
    reviewSatisfied: Boolean(policy)
      && policyScopeMatches
      && !truncated
      && approvedReviewers.length >= (minimumApprovals ?? Number.POSITIVE_INFINITY)
      && missingRequiredReviewers.length === 0
      && changesRequestedBy.length === 0
      && !requireCodeOwnerReview,
    policyAvailable: Boolean(policy),
    policyScopeMatches,
    truncated,
  };
}

async function paginated<T>(
  deps: GithubEvidenceDependencies,
  urlForPage: (page: number) => string,
  token: string,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= Math.ceil(MAX_PROVIDER_ITEMS / PER_PAGE); page += 1) {
    const response = await deps.fetchJson<T[]>(urlForPage(page), token);
    items.push(...response.slice(0, MAX_PROVIDER_ITEMS - items.length));
    if (response.length < PER_PAGE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

async function paginatedCheckRuns<T>(
  deps: GithubEvidenceDependencies,
  owner: string,
  repo: string,
  headSha: string,
  token: string,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let totalCount = 0;
  for (let page = 1; page <= Math.ceil(MAX_PROVIDER_ITEMS / PER_PAGE); page += 1) {
    const response = await deps.fetchJson<{ total_count?: number; check_runs?: T[] }>(
      githubApi(owner, repo, `/commits/${headSha}/check-runs?filter=latest&per_page=${PER_PAGE}&page=${page}`),
      token,
    );
    const pageItems = response.check_runs ?? [];
    totalCount = Number(response.total_count ?? pageItems.length);
    items.push(...pageItems.slice(0, MAX_PROVIDER_ITEMS - items.length));
    if (pageItems.length < PER_PAGE || items.length >= totalCount) {
      return { items, truncated: totalCount > MAX_PROVIDER_ITEMS };
    }
  }
  return { items, truncated: totalCount > items.length || items.length >= MAX_PROVIDER_ITEMS };
}

function normalizeReviewState(value: unknown): NormalizedGithubReview['state'] {
  const state = boundedText(value, 64).toLowerCase();
  if (['approved', 'changes_requested', 'commented', 'dismissed', 'pending'].includes(state)) {
    return state as NormalizedGithubReview['state'];
  }
  return 'unknown';
}

function mapEvidence(row: EvidenceRow, slug: string): GithubPrDeliveryEvidence {
  return {
    schemaVersion: GITHUB_PR_DELIVERY_EVIDENCE_SCHEMA_VERSION,
    id: row.id,
    workspaceId: row.workspace_id,
    runId: Number(row.run_id),
    specSlug: row.spec_slug ?? slug,
    policy: row.policy_id && row.policy_digest ? { id: row.policy_id, digest: row.policy_digest } : null,
    repository: { owner: row.repo_owner, name: row.repo_name },
    pullRequest: {
      number: Number(row.pr_number), url: row.pr_url, state: row.pr_state, draft: row.draft,
      merged: row.merged, headRef: row.head_ref, baseRef: row.base_ref, headSha: row.head_sha,
      baseSha: row.base_sha, mergeCommitSha: row.merge_commit_sha, mergeable: row.mergeable,
      mergeableState: row.mergeable_state,
    },
    freshness: {
      comparisonStatus: row.comparison_status, aheadBy: Number(row.ahead_by), behindBy: Number(row.behind_by),
      branchFresh: row.branch_fresh,
    },
    checks: parseJson<NormalizedGithubCheck[]>(row.checks, []),
    checksTruncated: row.checks_truncated,
    reviews: parseJson<NormalizedGithubReview[]>(row.reviews, []),
    reviewsTruncated: row.reviews_truncated,
    checkSummary: parseJson<GithubCheckSummary>(row.check_summary, {
      required: [], passing: [], pending: [], failing: [], missing: [], allRequiredPassed: false,
      policyAvailable: false, policyScopeMatches: false, truncated: false,
    }),
    reviewSummary: parseJson<GithubReviewSummary>(row.review_summary, {
      minimumApprovals: null, currentApprovals: 0, approvedReviewers: [], requiredReviewers: [],
      missingRequiredReviewers: [], changesRequestedBy: [], requireCodeOwnerReview: false,
      codeOwnerReviewStatus: 'not_required', reviewSatisfied: false, policyAvailable: false,
      policyScopeMatches: false, truncated: false,
    }),
    providerObservedAt: iso(row.provider_observed_at)!,
    observedBy: { principalId: row.observed_by_principal_id, displayLabel: row.observed_by_display_label },
    payloadHash: row.payload_hash,
    createdAt: iso(row.created_at)!,
  };
}

export async function observeGithubPrDeliveryEvidence(
  input: {
    workspaceId: string;
    runId: number;
    expectedHeadSha: string;
    principal: DeliveryEvidencePrincipal;
  },
  overrides: Partial<GithubEvidenceDependencies> = {},
): Promise<{ evidence: GithubPrDeliveryEvidence; replayed: boolean }> {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw new ValidationError('runId must be a positive safe integer');
  const expectedHeadSha = normalizedSha(input.expectedHeadSha, 'expectedHeadSha');
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const run = await deps.queryOne<RunBindingRow>(
    `SELECT r.id, r.workspace_id, r.spec_path, r.branch_name, r.pr_number,
            g.repo_owner, g.repo_name, g.auto_pr_target_branch
       FROM pipeline_runs r
       JOIN workspace_github_webhooks g ON g.workspace_id = r.workspace_id
      WHERE r.id = $1 AND r.workspace_id = $2`,
    [input.runId, input.workspaceId],
  );
  if (!run) throw new NotFoundError('GitHub-bound pipeline run', String(input.runId));
  if (!run.pr_number) throw new UnprocessableError('Run has no canonical pull request binding', 'PR_BINDING_REQUIRED');
  if (!run.branch_name) throw new UnprocessableError('Run has no canonical branch binding', 'BRANCH_BINDING_REQUIRED');

  const token = await deps.resolveToken(input.workspaceId);
  if (!token) throw new UnprocessableError('Workspace GitHub credential is unavailable', 'GITHUB_CREDENTIAL_UNAVAILABLE');
  const owner = run.repo_owner;
  const repo = run.repo_name;
  const prNumber = Number(run.pr_number);
  const pr = await deps.fetchJson<GithubPullResponse>(githubApi(owner, repo, `/pulls/${prNumber}`), token.token);
  const headSha = normalizedSha(pr.head?.sha, 'pullRequest.head.sha');
  const baseSha = normalizedSha(pr.base?.sha, 'pullRequest.base.sha');
  const providerRepo = boundedText(pr.head?.repo?.full_name, 512).toLowerCase();
  if (providerRepo && providerRepo !== `${owner}/${repo}`.toLowerCase()) {
    throw new ConflictError('Pull request repository does not match the workspace GitHub binding');
  }
  const expectedPrUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  if (pr.html_url !== expectedPrUrl) throw new ConflictError('GitHub returned an unexpected pull request URL');
  if (pr.number !== prNumber) throw new ConflictError('GitHub returned a different pull request identity');
  if (pr.head.ref !== run.branch_name) throw new ConflictError('Pull request head branch does not match the canonical run branch');
  if (pr.base.ref !== run.auto_pr_target_branch) throw new ConflictError('Pull request base branch does not match the canonical workspace target branch');
  if (headSha !== expectedHeadSha) {
    throw new ConflictError('Pull request head SHA changed; observe again using the current immutable SHA', {
      expectedHeadSha,
      observedHeadSha: headSha,
    });
  }

  const [checkRunsPage, statusPage, reviewPage, comparison, policy] = await Promise.all([
    paginatedCheckRuns<{ id: number; name: string; status: string; conclusion?: string | null; details_url?: string | null; completed_at?: string | null; started_at?: string | null; app?: { slug?: string | null } | null }>(
      deps, owner, repo, headSha, token.token,
    ),
    paginated<{ id: number; context: string; state: string; target_url?: string | null; updated_at?: string | null; creator?: { login?: string | null } | null }>(
      deps,
      (page) => githubApi(owner, repo, `/commits/${headSha}/statuses?per_page=${PER_PAGE}&page=${page}`),
      token.token,
    ),
    paginated<{ id: number; state: string; commit_id?: string | null; submitted_at?: string | null; user?: { login?: string | null } | null; author_association?: string | null }>(
      deps,
      (page) => githubApi(owner, repo, `/pulls/${prNumber}/reviews?per_page=${PER_PAGE}&page=${page}`),
      token.token,
    ),
    deps.fetchJson<{ status?: string; ahead_by?: number; behind_by?: number }>(
      githubApi(owner, repo, `/compare/${encodeURIComponent(pr.base.ref)}...${headSha}`), token.token,
    ),
    deps.getActivePolicy(input.workspaceId, deps.now()),
  ]);

  // Close the observation window: provider head/base/branch/state and policy
  // must be identical before and after checks/reviews/comparison collection.
  const [finalPr, finalPolicy] = await Promise.all([
    deps.fetchJson<GithubPullResponse>(githubApi(owner, repo, `/pulls/${prNumber}`), token.token),
    deps.getActivePolicy(input.workspaceId, deps.now()),
  ]);
  const finalHeadSha = normalizedSha(finalPr.head?.sha, 'finalPullRequest.head.sha');
  const finalBaseSha = normalizedSha(finalPr.base?.sha, 'finalPullRequest.base.sha');
  if (finalPr.number !== pr.number || finalPr.html_url !== pr.html_url
    || finalPr.head.ref !== pr.head.ref || finalPr.base.ref !== pr.base.ref
    || finalHeadSha !== headSha || finalBaseSha !== baseSha
    || finalPr.state !== pr.state || Boolean(finalPr.draft) !== Boolean(pr.draft)
    || Boolean(finalPr.merged) !== Boolean(pr.merged)) {
    throw new ConflictError('Pull request changed while exact-SHA evidence was being observed');
  }
  if ((policy?.id ?? null) !== (finalPolicy?.id ?? null)
    || (policy?.policyDigest ?? null) !== (finalPolicy?.policyDigest ?? null)) {
    throw new ConflictError('Standing delivery policy changed while exact-SHA evidence was being observed');
  }

  const checkRuns = checkRunsPage.items.map<NormalizedGithubCheck>((check) => ({
    source: 'check_run',
    id: String(check.id),
    name: boundedText(check.name, 200),
    status: boundedText(check.status, 64).toLowerCase(),
    conclusion: check.conclusion ? boundedText(check.conclusion, 64).toLowerCase() : null,
    completed: check.status === 'completed',
    providerUrl: safeProviderUrl(check.details_url),
    observedAt: iso(check.completed_at ?? check.started_at),
    app: check.app?.slug ? boundedText(check.app.slug, 100) : null,
  }));
  const statuses = statusPage.items.map<NormalizedGithubCheck>((status) => ({
    source: 'commit_status',
    id: String(status.id),
    name: boundedText(status.context, 200),
    status: boundedText(status.state, 64).toLowerCase(),
    conclusion: boundedText(status.state, 64).toLowerCase(),
    completed: status.state !== 'pending',
    providerUrl: safeProviderUrl(status.target_url),
    observedAt: iso(status.updated_at),
    app: status.creator?.login ? boundedText(status.creator.login, 100) : null,
  }));
  const checks = [...checkRuns, ...statuses]
    .filter((check) => check.name.length > 0)
    .sort((left, right) => `${left.name}:${left.source}:${left.id}`.localeCompare(`${right.name}:${right.source}:${right.id}`))
    .slice(0, MAX_PROVIDER_ITEMS);
  const checksTruncated = checkRunsPage.truncated || statusPage.truncated
    || checkRuns.length + statuses.length > MAX_PROVIDER_ITEMS;

  const reviews = reviewPage.items
    .filter((review) => Boolean(review.user?.login))
    .map<NormalizedGithubReview>((review) => {
      const commitSha = review.commit_id && FULL_SHA.test(review.commit_id.toLowerCase()) ? review.commit_id.toLowerCase() : null;
      return {
        id: String(review.id),
        reviewer: boundedText(review.user?.login, 100),
        state: normalizeReviewState(review.state),
        commitSha,
        currentHead: commitSha === headSha,
        submittedAt: iso(review.submitted_at),
        authorAssociation: review.author_association ? boundedText(review.author_association, 64) : null,
      };
    })
    .sort((left, right) => `${left.reviewer}:${left.id}`.localeCompare(`${right.reviewer}:${right.id}`));

  const comparisonStatusRaw = boundedText(comparison.status, 32).toLowerCase();
  const comparisonStatus = ['ahead', 'behind', 'diverged', 'identical'].includes(comparisonStatusRaw)
    ? comparisonStatusRaw as GithubPrDeliveryEvidence['freshness']['comparisonStatus']
    : 'unknown';
  const aheadBy = Math.max(0, Number(comparison.ahead_by ?? 0));
  const behindBy = Math.max(0, Number(comparison.behind_by ?? 0));
  const branchFresh = behindBy === 0 && (comparisonStatus === 'ahead' || comparisonStatus === 'identical');
  const policyScopeMatches = Boolean(policy)
    && policy!.repository.owner.toLowerCase() === owner.toLowerCase()
    && policy!.repository.name.toLowerCase() === repo.toLowerCase()
    && policy!.baseBranch === pr.base.ref;
  const checkSummary = summarizeChecks(checks, checksTruncated, policy, policyScopeMatches);
  const reviewSummary = summarizeReviews(reviews, reviewPage.truncated, policy, policyScopeMatches);
  const providerObservedAt = deps.now().toISOString();
  const stablePayload = {
    schemaVersion: GITHUB_PR_DELIVERY_EVIDENCE_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    runId: input.runId,
    specSlug: specSlug(run.spec_path),
    policy: policy ? { id: policy.id, digest: policy.policyDigest } : null,
    repository: { owner, name: repo },
    pullRequest: {
      number: prNumber, url: pr.html_url, state: pr.state, draft: Boolean(pr.draft), merged: Boolean(pr.merged),
      headRef: pr.head.ref, baseRef: pr.base.ref, headSha, baseSha,
      mergeCommitSha: finalPr.merge_commit_sha && FULL_SHA.test(finalPr.merge_commit_sha.toLowerCase()) ? finalPr.merge_commit_sha.toLowerCase() : null,
      mergeable: typeof finalPr.mergeable === 'boolean' ? finalPr.mergeable : null,
      mergeableState: boundedText(finalPr.mergeable_state || 'unknown', 64),
    },
    freshness: { comparisonStatus, aheadBy, behindBy, branchFresh },
    checks, checksTruncated, reviews, reviewsTruncated: reviewPage.truncated,
    checkSummary, reviewSummary,
  };
  const payloadHash = payloadDigest(stablePayload);
  const id = randomUUID();

  return deps.transaction(async (client: PoolClient) => {
    const existing = await client.query<EvidenceRow>(
      `SELECT e.*, regexp_replace(r.spec_path, '^.*/|\\.json$', '', 'g') AS spec_slug
         FROM github_pr_delivery_evidence e
         JOIN pipeline_runs r ON r.id = e.run_id
        WHERE e.workspace_id = $1 AND e.repo_owner = $2 AND e.repo_name = $3
          AND e.pr_number = $4 AND e.head_sha = $5 AND e.payload_hash = $6
        FOR SHARE`,
      [input.workspaceId, owner, repo, prNumber, headSha, payloadHash],
    );
    if (existing.rows[0]) return { evidence: mapEvidence(existing.rows[0], specSlug(run.spec_path)), replayed: true };

    const inserted = await client.query<EvidenceRow>(
      `INSERT INTO github_pr_delivery_evidence
        (id, workspace_id, run_id, policy_id, policy_digest, repo_owner, repo_name,
         pr_number, pr_url, pr_state, draft, merged, head_ref, base_ref, head_sha, base_sha,
         merge_commit_sha, mergeable, mergeable_state, comparison_status, ahead_by, behind_by,
         branch_fresh, checks, checks_truncated, reviews, reviews_truncated, check_summary,
         review_summary, provider_observed_at, observed_by_principal_id,
         observed_by_display_label, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25, $26::jsonb, $27,
               $28::jsonb, $29::jsonb, $30, $31, $32, $33)
       ON CONFLICT (workspace_id, repo_owner, repo_name, pr_number, head_sha, payload_hash)
       DO NOTHING
       RETURNING *`,
      [id, input.workspaceId, input.runId, policy?.id ?? null, policy?.policyDigest ?? null, owner, repo,
        prNumber, pr.html_url, pr.state, Boolean(pr.draft), Boolean(pr.merged), pr.head.ref, pr.base.ref,
        headSha, baseSha, stablePayload.pullRequest.mergeCommitSha, stablePayload.pullRequest.mergeable,
        stablePayload.pullRequest.mergeableState, comparisonStatus, aheadBy, behindBy, branchFresh,
        JSON.stringify(checks), checksTruncated, JSON.stringify(reviews), reviewPage.truncated,
        JSON.stringify(checkSummary), JSON.stringify(reviewSummary), providerObservedAt,
        input.principal.principalId, input.principal.displayLabel, payloadHash],
    );
    if (!inserted.rows[0]) {
      const raced = await client.query<EvidenceRow>(
        `SELECT e.*, regexp_replace(r.spec_path, '^.*/|\\.json$', '', 'g') AS spec_slug
           FROM github_pr_delivery_evidence e
           JOIN pipeline_runs r ON r.id = e.run_id
          WHERE e.workspace_id = $1 AND e.repo_owner = $2 AND e.repo_name = $3
            AND e.pr_number = $4 AND e.head_sha = $5 AND e.payload_hash = $6`,
        [input.workspaceId, owner, repo, prNumber, headSha, payloadHash],
      );
      if (!raced.rows[0]) throw new ConflictError('Concurrent GitHub evidence observation could not be resolved');
      return { evidence: mapEvidence(raced.rows[0], specSlug(run.spec_path)), replayed: true };
    }
    await client.query(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
       VALUES ('github_pr_delivery_evidence_observed', $1, $2, $3, $4::jsonb)`,
      [input.workspaceId, specSlug(run.spec_path), input.principal.displayLabel, JSON.stringify({
        evidenceId: id, runId: input.runId, prNumber, headSha, baseSha,
        policyDigest: policy?.policyDigest ?? null, allRequiredChecksPassed: checkSummary.allRequiredPassed,
        reviewSatisfied: reviewSummary.reviewSatisfied, branchFresh, payloadHash,
      })],
    );
    return { evidence: mapEvidence({ ...inserted.rows[0], spec_slug: specSlug(run.spec_path) }, specSlug(run.spec_path)), replayed: false };
  });
}

export async function getGithubPrDeliveryEvidenceById(
  workspaceId: string,
  evidenceId: string,
): Promise<GithubPrDeliveryEvidence | null> {
  const row = await queryOne<EvidenceRow>(`
    SELECT e.*, regexp_replace(r.spec_path, '^.*/|\\.json$', '', 'g') AS spec_slug
    FROM github_pr_delivery_evidence e
    JOIN pipeline_runs r ON r.id = e.run_id
    WHERE e.workspace_id = $1 AND e.id = $2
  `, [workspaceId, evidenceId]);
  return row ? mapEvidence(row, row.spec_slug ?? '') : null;
}

export async function listGithubPrDeliveryEvidence(input: {
  workspaceId: string;
  runId?: number;
  pagination: PaginationParams;
}): Promise<PaginatedResponse<GithubPrDeliveryEvidence>> {
  if (input.runId !== undefined && (!Number.isSafeInteger(input.runId) || input.runId <= 0)) {
    throw new ValidationError('runId must be a positive safe integer');
  }
  const result = await paginateQuery<EvidenceRow>({
    query: `SELECT e.*, regexp_replace(r.spec_path, '^.*/|\\.json$', '', 'g') AS spec_slug
              FROM github_pr_delivery_evidence e
              JOIN pipeline_runs r ON r.id = e.run_id
             WHERE e.workspace_id = $1
               AND ($2::bigint IS NULL OR e.run_id = $2)`,
    countQuery: `SELECT COUNT(*)::integer AS total
                   FROM github_pr_delivery_evidence e
                  WHERE e.workspace_id = $1
                    AND ($2::bigint IS NULL OR e.run_id = $2)`,
    params: [input.workspaceId, input.runId ?? null],
    pagination: input.pagination,
    orderBy: 'e.created_at DESC',
    cursorColumn: 'created_at',
    cursorDirection: 'desc',
  });
  return {
    ...result,
    items: result.items.map((row) => mapEvidence(row, row.spec_slug ?? 'unknown-spec')),
  };
}
