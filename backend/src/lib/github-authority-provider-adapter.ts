/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
  GithubProviderBindingSchema,
  providerBindingIsHealthy,
  type AuthorityCapability,
  type DeliveryAuthorityProviderAdapter,
  type GithubProviderBinding,
  type ProviderBinding,
} from './authority-provider-adapter';
import {
  GITHUB_OPTIONAL_ADAPTER_DESCRIPTOR,
} from './delivery-adapter';
import {
  getWorkspaceGithubAppBinding,
  githubAppBindingHasVerifiedProfile,
  type GithubAppBindingRecord,
} from './github-app-credential-provider';
import { GithubDeliveryReconciler } from './github-delivery-reconciliation';
import {
  GithubReviewDeliveryOperations,
  type GithubBranchPushResult,
  type GithubCheckObservation,
  type GithubExternalSendGrant,
  type GithubPreparedRepository,
  type GithubPullRequestResult,
  type GithubReviewBranch,
  type GithubReviewCommit,
  type GithubReviewDeliveryLineage,
  type GithubReviewDeliveryReceipt,
  type GithubReviewRequestResult,
} from './github-review-delivery';

export const GITHUB_AUTHORITY_CAPABILITIES: readonly AuthorityCapability[] = Object.freeze([
  'scm.repository.read',
  'scm.branch.write',
  'scm.pull_request.write',
  'scm.checks.read',
  'scm.review.request',
]);

type BindingReader = (workspaceId: string) => Promise<GithubAppBindingRecord | null>;
type BindingHealthVerifier = (binding: GithubAppBindingRecord | null) => boolean;

/**
 * Canonical GitHub authority adapter over the existing App registration,
 * workspace repository binding, and vault references. Token minting remains in
 * github-app-credential-provider and is intentionally not performed by discovery.
 */
export class GitHubAuthorityProviderAdapter implements DeliveryAuthorityProviderAdapter {
  readonly contractVersion = DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  readonly descriptor = GITHUB_OPTIONAL_ADAPTER_DESCRIPTOR;
  readonly capabilities = GITHUB_AUTHORITY_CAPABILITIES;

  readonly reconciliation: GithubDeliveryReconciler;

  constructor(
    private readonly readBinding: BindingReader = getWorkspaceGithubAppBinding,
    private readonly verifyBindingHealth: BindingHealthVerifier = githubAppBindingHasVerifiedProfile,
    private readonly reviewDelivery = new GithubReviewDeliveryOperations(),
    reconciliation?: GithubDeliveryReconciler,
  ) {
    this.reconciliation = reconciliation ?? new GithubDeliveryReconciler(reviewDelivery);
  }

  isBindingHealthy(binding: unknown): binding is GithubProviderBinding {
    const parsed = GithubProviderBindingSchema.safeParse(binding);
    return parsed.success && providerBindingIsHealthy(parsed.data);
  }

  async getProviderBinding(workspaceId: string): Promise<GithubProviderBinding | null> {
    const binding = await this.readBinding(workspaceId);
    if (!binding || binding.workspaceId !== workspaceId) return null;

    return GithubProviderBindingSchema.parse({
      providerId: 'github-app',
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      workspaceId: binding.workspaceId,
      bindingStatus: binding.status,
      registrationStatus: binding.registrationStatus,
      installationStatus: binding.installationStatus,
      installationId: binding.installationId,
      repositoryId: binding.repositoryId,
      repository: { owner: binding.repoOwner, name: binding.repoName },
      secretReferences: [
        { purpose: 'app-signing', secretId: binding.privateKeySecretId },
        { purpose: 'webhook-verification', secretId: binding.webhookSecretId },
      ],
      providerProfileVerified: this.verifyBindingHealth(binding),
    });
  }

  async revalidateProviderBinding(workspaceId: string, _bindingId?: string): Promise<ProviderBinding> {
    const binding = await this.getProviderBinding(workspaceId);
    if (!binding) throw new Error('Provider binding not found');
    return binding;
  }

  prepareRepository(input: {
    repositoryPath: string;
    approvedBaseRevision: string;
    checkoutLabel?: string;
  }): Promise<GithubPreparedRepository> {
    return this.reviewDelivery.prepareRepository(input);
  }

  createBranch(
    prepared: GithubPreparedRepository,
    identity: { workspaceId: string; runId: number; storyId: string },
  ): Promise<GithubReviewBranch> {
    return this.reviewDelivery.createBranch(prepared, identity);
  }

  commit(branch: GithubReviewBranch, input: { message: string; authoredAt: string }): Promise<GithubReviewCommit> {
    return this.reviewDelivery.commit(branch, input);
  }

  pushBranch(input: {
    leaseId: string;
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
  }): Promise<GithubBranchPushResult> {
    return this.reviewDelivery.pushBranch(input);
  }

  createOrUpdatePullRequest(input: {
    leaseId: string;
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
    title: string;
    body: string;
  }): Promise<GithubPullRequestResult> {
    return this.reviewDelivery.createOrUpdatePullRequest(input);
  }

  observeChecks(input: {
    leaseId: string;
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
  }): Promise<readonly GithubCheckObservation[]> {
    return this.reviewDelivery.observeChecks(input);
  }

  requestReview(input: {
    leaseId: string;
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
    commit: GithubReviewCommit;
    pullRequest: GithubPullRequestResult;
    users?: readonly string[];
    teams?: readonly string[];
  }): Promise<GithubReviewRequestResult> {
    return this.reviewDelivery.requestReview(input);
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
    return this.reviewDelivery.createReceipt(input);
  }

  cleanupRepository(prepared: GithubPreparedRepository): Promise<{ replayed: boolean }> {
    return this.reviewDelivery.cleanupRepository(prepared);
  }
}
