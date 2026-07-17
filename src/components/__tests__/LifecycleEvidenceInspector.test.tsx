/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleEvidenceDetail, LifecycleQueryState } from '../../types/lifecycle';
import LifecycleEvidenceInspector from '../LifecycleEvidenceInspector';

const SNAPSHOT = `sha256:${'a'.repeat(64)}`;

function detail(overrides: Partial<LifecycleEvidenceDetail> = {}): LifecycleEvidenceDetail {
  return {
    id: '7', workspaceId: 'ws-1', specId: 'spec-a',
    scope: { workspaceId: 'ws-1', specSlug: 'spec-a', runId: 42, storyId: 'US-001', phaseId: 'qa', gateId: 'gate-qa' },
    source: { type: 'github_check', system: 'GitHub Actions', eventId: 'check-7' },
    observedAt: '2026-07-15T12:00:00.000Z', createdAt: '2026-07-15T12:00:01.000Z', expiresAt: '2026-08-14T12:00:00.000Z',
    subject: { type: 'commit_sha', value: 'abc123' }, phaseSubject: { type: 'commit_sha', value: 'abc123' },
    releaseIdentity: { commitSha: 'abc123', artifactDigest: 'sha256:image', deploymentId: null },
    classification: 'qa', status: 'passed', trustLevel: 'provider_verified', confidence: 0.97,
    excerpt: 'Passed with token [REDACTED]', actor: 'github-actions[bot]', rationale: null,
    environment: 'staging', redactionState: 'normalized_redacted', details: { result: '[REDACTED]' },
    provenanceChain: [{ system: 'github:checks', eventId: 'check-7', observedAt: '2026-07-15T12:00:00.000Z', verification: 'provider-verified' }],
    revisionMismatch: false, eligibleForActiveGate: true, invalidReasons: [], lineageVerified: true, payloadHash: 'sha256:payload', sourcePayloadHash: null,
    rawReference: { available: true, accessTier: 'auth', allowed: true, kind: 'github', label: 'Open GitHub check', reference: 'https://github.com/rorca/rorca/actions/runs/7', href: 'https://github.com/rorca/rorca/actions/runs/7', external: true, rawPayloadIncluded: false },
    snapshotId: SNAPSHOT, evidenceHighWaterMark: 'evidence:7', decisionHighWaterMark: 'decision:1',
    ...overrides,
  };
}

function state(data: LifecycleEvidenceDetail | null, overrides: Partial<LifecycleQueryState<LifecycleEvidenceDetail>> = {}): LifecycleQueryState<LifecycleEvidenceDetail> {
  return { data, snapshotId: data?.snapshotId ?? null, loading: false, refreshing: false, stale: false, partial: false, error: null, ...overrides };
}

describe('LifecycleEvidenceInspector', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('presents normalized source identity, timestamps, lineage, redaction, and authorized raw reference consistently', async () => {
    const user = userEvent.setup();
    render(<LifecycleEvidenceInspector evidence={state(detail())} pinnedSnapshotId={SNAPSHOT} onRefresh={vi.fn()} onClose={vi.fn()} />);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');

    expect(screen.getByRole('heading', { name: 'Evidence Inspector' })).toHaveFocus();
    expect(screen.getByText('GitHub Actions / Github check')).toBeInTheDocument();
    expect(screen.getByText('check-7')).toBeInTheDocument();
    expect(screen.getByText('Passed / Qa')).toBeInTheDocument();
    expect(screen.getByText('abc123')).toBeInTheDocument();
    expect(screen.getByText('sha256:image')).toBeInTheDocument();
    expect(screen.getByText('staging')).toBeInTheDocument();
    expect(screen.getByText(/Normalized redacted · raw payload not included/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open GitHub check' })).toHaveAttribute('href', 'https://github.com/rorca/rorca/actions/runs/7');

    await user.click(screen.getByRole('button', { name: 'Copy reference' }));
    expect(writeText).toHaveBeenCalledWith('https://github.com/rorca/rorca/actions/runs/7');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('keeps a historical item visible while stale and refreshes only on explicit action', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const audited = detail({ revisionMismatch: true, eligibleForActiveGate: false, invalidReasons: ['subject_revision_mismatch'], subject: { type: 'commit_sha', value: 'old-sha' }, releaseIdentity: { commitSha: 'old-sha', artifactDigest: 'sha256:image', deploymentId: null } });
    render(<LifecycleEvidenceInspector evidence={state(audited, { stale: true })} pinnedSnapshotId={SNAPSHOT} onRefresh={onRefresh} onClose={vi.fn()} />);

    expect(screen.getByText(/Historical evidence — excluded from the active gate/)).toBeInTheDocument();
    expect(screen.getByText(/This audited item has not changed/)).toBeInTheDocument();
    expect(screen.getByText('old-sha')).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Refresh against latest snapshot/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders loading, error/refresh, empty, and bounded long payload states', async () => {
    const { rerender } = render(<LifecycleEvidenceInspector evidence={state(null, { loading: true })} pinnedSnapshotId={SNAPSHOT} onRefresh={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Loading pinned evidence…')).toBeInTheDocument();

    rerender(<LifecycleEvidenceInspector evidence={state(null, { error: new Error('Snapshot changed') })} pinnedSnapshotId={SNAPSHOT} onRefresh={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Snapshot changed')).toBeInTheDocument();

    rerender(<LifecycleEvidenceInspector evidence={state(null)} pinnedSnapshotId={SNAPSHOT} onRefresh={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/No evidence item is available/)).toBeInTheDocument();

    rerender(<LifecycleEvidenceInspector evidence={state(detail({ details: { output: 'x'.repeat(20_000) } }))} pinnedSnapshotId={SNAPSHOT} onRefresh={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByText('Bounded normalized payload and provenance'));
    expect(screen.getByText(/payload display bounded at 12,000 characters/)).toBeInTheDocument();
  });
});
