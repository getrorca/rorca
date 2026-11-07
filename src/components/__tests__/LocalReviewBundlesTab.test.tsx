/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAdapters = vi.fn();
const listBundles = vi.fn();

vi.mock('../../api/delivery', () => ({
  getDeliveryAdapters: (...args: unknown[]) => getAdapters(...args),
  listLocalReviewBundles: (...args: unknown[]) => listBundles(...args),
}));

import LocalReviewBundlesTab from '../LocalReviewBundlesTab';

const catalog = {
  contractVersion: 'rorca.delivery-adapter.v1',
  defaultAdapterId: 'local-review-bundle',
  adapters: [
    { adapterId: 'local-review-bundle', label: 'Local review bundle', default: true, requiresNetwork: false, requiresCredentials: false, implementationStatus: 'canonical_adapter' },
    { adapterId: 'github-app', label: 'Legacy GitHub delivery surfaces', optional: true, default: false, implementationStatus: 'legacy_optional_surfaces' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getAdapters.mockResolvedValue(catalog);
  listBundles.mockResolvedValue({ schemaVersion: 'rorca.local-review-bundle-read.v1', items: [], limit: 100 });
});

describe('LocalReviewBundlesTab', () => {
  it('presents local delivery as the no-provider default and keeps merge/deploy explicitly unauthorized', async () => {
    render(<LocalReviewBundlesTab workspaceId="workspace-one" runId={42} />);
    expect(await screen.findByTestId('local-review-bundles-tab')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('No network')).toBeInTheDocument();
    expect(screen.getByText(/No GitHub account, PAT, webhook, remote provider, merge, or deployment authority/)).toBeInTheDocument();
    expect(screen.getByText(/Legacy GitHub delivery routes remain optional/)).toBeInTheDocument();
    expect(screen.getByText(/cannot mint pass authority/)).toBeInTheDocument();
  });

  it('keeps Workbench read-only and separates exact host-attempt finalization', async () => {
    render(<LocalReviewBundlesTab workspaceId="workspace-one" runId={42} />);
    expect(await screen.findByText('Read-only review surface')).toBeInTheDocument();
    expect(screen.getByText(/requires an exact host attempt and generation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finalize local bundle/ })).not.toBeInTheDocument();
  });

  it('renders only the safe read model and visible integrity/no-authority state', async () => {
    listBundles.mockResolvedValue({
      schemaVersion: 'rorca.local-review-bundle-read.v1', limit: 100,
      items: [{
        bundleId: `lrb-${'a'.repeat(64)}`,
        identity: { storyId: 'US-001', attempt: 1 },
        repository: { branch: 'local/story', baseSha: '1'.repeat(40), headSha: '2'.repeat(40) },
        changedFileCount: 2,
        artifacts: [{ bytes: 512 }],
        validation: { status: 'passed', receiptCount: 1 },
        createdAt: '2026-07-28T12:00:00.000Z',
        projectionKey: `sha256/aa/${'a'.repeat(64)}`,
        projectionIntegrity: 'verified',
      }],
    });
    render(<LocalReviewBundlesTab workspaceId="workspace-one" runId={42} />);
    expect(await screen.findByText('verified')).toBeInTheDocument();
    expect(screen.getByText('host validation passed')).toBeInTheDocument();
    expect(screen.getByText('merge: not authorized')).toBeInTheDocument();
    expect(screen.getByText('deploy: not authorized')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finalize local bundle/ })).not.toBeInTheDocument();
  });
});
