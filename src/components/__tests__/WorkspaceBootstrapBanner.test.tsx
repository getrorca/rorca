/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkspaceBootstrapBanner from '../WorkspaceBootstrapBanner';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('../../api/lifecycle', () => ({
  getLifecyclePortfolio: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

import { apiFetch } from '../../lib/apiFetch';
import { getLifecyclePortfolio } from '../../api/lifecycle';

const mockApiFetch = vi.mocked(apiFetch);
const mockGetLifecyclePortfolio = vi.mocked(getLifecyclePortfolio);

function portfolioWith(evaluatedSpecs: number) {
  return {
    items: [], total: 0, hasMore: false, workspace: { id: 'ws-1', label: 'Workspace' },
    phaseOrder: [], stageProfile: null, snapshotId: 'snapshot', evidenceHighWaterMark: 'e:1', decisionHighWaterMark: 'd:1',
    kpis: {
      specs: 1, activeSpecs: 1, evaluatedSpecs, needsCompilation: 0, blockedSpecs: 0,
      deliveredSpecs: 0, inProgressSpecs: 0, needsReconciliation: 1, assuranceComplete: 0,
      missingGates: 0, specsWithBlockers: 0, readyForQa: 0, waitingApprovals: 0,
      recentPhaseTransitions: 0, stories: 0,
      phases: { total: 0, excluded: 0, denominator: 0, passed: 0, completionRate: 0, byStatus: { not_started: 0, in_progress: 0, blocked: 0, awaiting_approval: 0, passed: 0, deferred: 0, not_applicable: 0, stale: 0 } },
    },
  };
}
describe('WorkspaceBootstrapBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockGetLifecyclePortfolio.mockResolvedValue(portfolioWith(0));
  });

  it('shows for a genuinely empty workspace (low health score, no compiled lifecycle plans)', async () => {
    mockApiFetch.mockResolvedValue({ score: 10 });
    render(<WorkspaceBootstrapBanner onSetUpNow={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/This workspace isn't set up yet/)).toBeInTheDocument();
    });
    expect(mockGetLifecyclePortfolio).toHaveBeenCalledWith('ws-1', { sort: 'current_view' }, { limit: 1 });
  });

  it('suppresses the banner when the workspace has compiled lifecycle plans', async () => {
    mockApiFetch.mockResolvedValue({ score: 10 });
    mockGetLifecyclePortfolio.mockResolvedValue(portfolioWith(2));
    render(<WorkspaceBootstrapBanner onSetUpNow={vi.fn()} />);

    await waitFor(() => {
      expect(mockGetLifecyclePortfolio).toHaveBeenCalled();
    });
    expect(screen.queryByText(/This workspace isn't set up yet/)).not.toBeInTheDocument();
  });

  it('stays hidden when the workspace health score is healthy', async () => {
    mockApiFetch.mockResolvedValue({ score: 85 });
    render(<WorkspaceBootstrapBanner onSetUpNow={vi.fn()} />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalled();
    });
    expect(screen.queryByText(/This workspace isn't set up yet/)).not.toBeInTheDocument();
    expect(mockGetLifecyclePortfolio).not.toHaveBeenCalled();
  });

  it('never shows after the setup wizard has been completed', async () => {
    localStorage.setItem('rorca_wizard_completed_ws-1', '1');
    render(<WorkspaceBootstrapBanner onSetUpNow={vi.fn()} />);

    expect(screen.queryByText(/This workspace isn't set up yet/)).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('respects session dismissal', async () => {
    sessionStorage.setItem('rorca_bootstrap_banner_dismissed_ws-1', '1');
    render(<WorkspaceBootstrapBanner onSetUpNow={vi.fn()} />);

    expect(screen.queryByText(/This workspace isn't set up yet/)).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('dismisses via the close button for the rest of the session', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValue({ score: 10 });
    render(<WorkspaceBootstrapBanner onSetUpNow={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Dismiss setup banner')).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText('Dismiss setup banner'));
    expect(screen.queryByText(/This workspace isn't set up yet/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem('rorca_bootstrap_banner_dismissed_ws-1')).toBe('1');
  });
});
