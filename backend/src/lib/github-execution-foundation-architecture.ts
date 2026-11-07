/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export const GITHUB_EXECUTION_FOUNDATION_ARCHITECTURE_VERSION = 'rorca.github-execution-foundation.v2' as const;

/**
 * Machine-readable ownership map for the GitHub execution foundation. Every
 * category is intentionally singular: later stories extend these owners rather
 * than introducing another registration, binding store, token provider, route,
 * settings component, vault, or cache.
 */
export const GITHUB_EXECUTION_FOUNDATION_ARCHITECTURE = Object.freeze({
  version: GITHUB_EXECUTION_FOUNDATION_ARCHITECTURE_VERSION,
  defaultDeliveryAdapterId: 'local-review-bundle',
  githubOptIn: true,
  providerBindingContract: Object.freeze([
    'backend/src/lib/authority-provider-adapter.ts',
  ]),
  appRegistration: Object.freeze([{
    table: 'github_app_registrations',
    owner: 'backend/src/routes/workspace-github-app.ts',
  }]),
  repositoryBinding: Object.freeze([{
    table: 'github_app_workspace_bindings',
    reader: 'backend/src/lib/github-app-credential-provider.ts#getWorkspaceGithubAppBinding',
  }]),
  installationTokenProvider: Object.freeze([{
    implementation: 'backend/src/lib/github-app-credential-provider.ts#preflightGithubInstallationLease',
    legacyResolver: 'backend/src/lib/github-app-credential-provider.ts#resolveRepositoryInstallationToken',
    settlement: 'backend/src/lib/github-app-credential-provider.ts#settleGithubInstallationLease',
    revocationReconciliation: 'backend/src/lib/github-app-credential-provider.ts#reconcileGithubInstallationLeaseRevocation',
    capabilityMapper: 'backend/src/lib/github-app-credential-provider.ts#githubPermissionsForScmCapabilities',
    trustedInjector: 'backend/src/lib/github-app-credential-provider.ts#withTrustedGithubInstallationLeaseToken',
    cache: 'module-memory-only',
  }]),
  settingsApi: Object.freeze([{
    path: '/api/workspaces/:id/github/app',
    router: 'backend/src/routes/workspace-github-app.ts',
  }]),
  settingsUi: Object.freeze([{
    path: 'settings/github',
    component: 'src/panels/GitHubSettingsPanel.tsx',
  }]),
  adapterImplementation: Object.freeze([{
    adapterId: 'github-app',
    implementation: 'backend/src/lib/github-authority-provider-adapter.ts#GitHubAuthorityProviderAdapter',
    selector: 'backend/src/lib/delivery-adapter-selection.ts#selectDeliveryAdapter',
    reviewDelivery: 'backend/src/lib/github-review-delivery.ts#GithubReviewDeliveryOperations',
    reconciler: 'backend/src/lib/github-delivery-reconciliation.ts#GithubDeliveryReconciler',
    attemptTable: 'provider_operation_attempts',
    receiptTable: 'provider_operation_receipts',
    receiptSchema: 'backend/src/lib/github-review-delivery.ts#GithubReviewDeliveryReceiptSchema',
    operations: Object.freeze([
      'prepareRepository',
      'createBranch',
      'commit',
      'scm.branch.write',
      'scm.pull_request.write',
      'scm.checks.read',
      'scm.review.request',
      'cleanupRepository',
    ]),
    prohibitedEffects: Object.freeze([
      'protected_branch_push',
      'force_push',
      'merge',
      'tag',
      'release',
      'repository_administration',
      'actions_secret_mutation',
      'production_deployment',
    ]),
  }]),
});
