/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { renderWithProviders } from '../../test/helpers';
import MissionsPanel from '../MissionsPanel';
import type { ArchiveSpec } from '../../api/types';

vi.mock('../../lib/apiFetch', () => {
  class ApiError extends Error {
    public readonly status: number;
    public readonly code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return {
    apiFetch: vi.fn(),
    ApiError,
    BASE_URL: 'http://localhost:3030',
    onApiFetchError: vi.fn(() => () => {}),
    setTokens: vi.fn(),
    clearTokens: vi.fn(),
    getAccessToken: vi.fn(() => null),
    getRefreshToken: vi.fn(() => null),
  };
});

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const SPEC_ALPHA: ArchiveSpec = {
  id: 'spec-alpha',
  specName: 'Alpha onboarding flow',
  storyCount: 5,
  status: 'approved',
  generatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  storyTitles: ['US-001', 'US-002', 'US-003', 'US-004', 'US-005'],
  tags: [],
  readinessPercent: 87,
  reviewStatus: 'approved',
};

// Deliberately without readinessPercent and reviewStatus: the panel must not
// invent them.
const SPEC_BETA: ArchiveSpec = {
  id: 'spec-beta',
  specName: 'Beta billing migration',
  storyCount: 3,
  status: 'pending',
  generatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  storyTitles: ['US-006', 'US-007', 'US-008'],
  tags: [],
};

const SPEC_GAMMA: ArchiveSpec = {
  id: 'spec-gamma',
  specName: 'Gamma second-page mission',
  storyCount: 1,
  status: 'approved',
  generatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  storyTitles: ['US-009'],
  tags: [],
};

const SPECS_RESPONSE = { items: [SPEC_ALPHA, SPEC_BETA], total: 2, hasMore: false };
const EMPTY_SPECS_RESPONSE = { items: [], total: 0, hasMore: false };

function mockEndpoints(specsResponder: (url: string) => Promise<unknown>) {
  mockApiFetch.mockImplementation((url) => {
    const u = String(url);
    if (u === '/api/workspaces') return Promise.resolve(WORKSPACE_RESPONSE);
    if (u.startsWith('/api/specs?')) return specsResponder(u);
    if (u.startsWith('/api/pipeline/runs?')) {
      return Promise.resolve({ items: [], total: 0, hasMore: false });
    }
    if (u.startsWith('/api/workspaces/')) return Promise.resolve({ config: {} });
    return Promise.reject(new Error(`Unexpected URL: ${u}`));
  });
}

function specsCallCount(): number {
  return mockApiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/specs?')).length;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

async function renderPanel() {
  const result = renderWithProviders(
    <>
      <MissionsPanel />
      <LocationProbe />
    </>,
  );
  await screen.findByText('Alpha onboarding flow');
  return result;
}

beforeEach(() => {
  mockApiFetch.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('MissionsPanel', () => {
  it('renders mission rows from persisted specs with exact links and meta', async () => {
    mockEndpoints(() => Promise.resolve(SPECS_RESPONSE));
    await renderPanel();

    const list = screen.getByRole('list', { name: 'Missions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    // Primary action navigates into the Mission workspace.
    const alphaLink = screen.getByRole('link', { name: 'Alpha onboarding flow' });
    expect(alphaLink).toHaveAttribute('href', '/missions/spec-alpha');
    const betaLink = screen.getByRole('link', { name: 'Beta billing migration' });
    expect(betaLink).toHaveAttribute('href', '/missions/spec-beta');

    // Alpha row: full meta including review status and readiness.
    const alphaRow = alphaLink.closest('li');
    expect(alphaRow).not.toBeNull();
    const alpha = within(alphaRow as HTMLElement);
    alpha.getByText('status: approved');
    alpha.getByText(/review: approved/);
    alpha.getByText(/5 stories/);
    alpha.getByText(/readiness 87%/);
    alpha.getByText(/created .*ago/);

    // Beta row: readiness and review must be absent, never inferred.
    const betaRow = betaLink.closest('li');
    expect(betaRow).not.toBeNull();
    const beta = within(betaRow as HTMLElement);
    beta.getByText('status: pending');
    beta.getByText(/3 stories/);
    beta.getByText(/created .*ago/);
    expect(beta.queryByText(/readiness/)).toBeNull();
    expect(beta.queryByText(/review:/)).toBeNull();

    // The specs list is fetched for the resolved workspace.
    const specsCall = mockApiFetch.mock.calls.find(([url]) => String(url).startsWith('/api/specs?'));
    expect(specsCall).toBeDefined();
    expect(String(specsCall?.[0])).toContain('workspaceId=ws-1');
  });

  it('filters rows client-side, shows the no-match line, and restores on clear', async () => {
    mockEndpoints(() => Promise.resolve(SPECS_RESPONSE));
    const user = userEvent.setup();
    await renderPanel();

    const filter = screen.getByLabelText('Filter missions by title');
    await user.type(filter, 'alpha');
    expect(screen.queryByRole('link', { name: 'Alpha onboarding flow' })).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Beta billing migration' })).toBeNull();

    await user.clear(filter);
    await user.type(filter, 'zzzz-nonsense');
    expect(screen.getByText('No missions match “zzzz-nonsense”.')).not.toBeNull();
    expect(screen.queryByRole('list', { name: 'Missions' })).toBeNull();

    await user.clear(filter);
    expect(screen.getByRole('link', { name: 'Alpha onboarding flow' })).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Beta billing migration' })).not.toBeNull();

    // Filtering is presentation-only: no additional specs fetch.
    expect(specsCallCount()).toBe(1);
  });

  it('shows the empty state and Create a spec navigates to /specs', async () => {
    mockEndpoints(() => Promise.resolve(EMPTY_SPECS_RESPONSE));
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <MissionsPanel />
        <LocationProbe />
      </>,
    );

    await screen.findByText('No missions yet');
    expect(
      screen.getByText('A mission appears here as soon as a spec is persisted in this workspace.'),
    ).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create a spec' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/specs');
    });
  });

  it('shows an inline error banner and retry refetches', async () => {
    let shouldFail = true;
    mockEndpoints(() => (
      shouldFail ? Promise.reject(new Error('specs unavailable')) : Promise.resolve(SPECS_RESPONSE)
    ));
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <MissionsPanel />
        <LocationProbe />
      </>,
    );

    await screen.findByText('specs unavailable');
    expect(specsCallCount()).toBe(1);

    shouldFail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('Alpha onboarding flow');
    expect(specsCallCount()).toBe(2);
    expect(screen.queryByText('specs unavailable')).toBeNull();
  });

  it('links Spec review to the canonical spec surface with a return context', async () => {
    mockEndpoints(() => Promise.resolve(SPECS_RESPONSE));
    await renderPanel();

    const reviewLinks = screen.getAllByRole('link', { name: 'Spec review' });
    expect(reviewLinks).toHaveLength(2);

    const alphaReview = reviewLinks[0].getAttribute('href') ?? '';
    expect(alphaReview).toContain('/workspaces/ws-1/specs/spec-alpha/review');
    expect(alphaReview).toContain('returnTo=');

    const betaReview = reviewLinks[1].getAttribute('href') ?? '';
    expect(betaReview).toContain('/workspaces/ws-1/specs/spec-beta/review');
    expect(betaReview).toContain('returnTo=');
  });

  it('loads a cursor page on demand and keeps missions duplicate-free', async () => {
    mockEndpoints((url) => {
      const params = new URL(url, 'http://localhost').searchParams;
      if (params.get('cursor') === 'page-2') {
        return Promise.resolve({
          items: [SPEC_BETA, SPEC_GAMMA],
          total: 3,
          hasMore: false,
        });
      }
      return Promise.resolve({
        items: [SPEC_ALPHA, SPEC_BETA],
        total: 3,
        hasMore: true,
        cursor: 'page-2',
      });
    });
    const user = userEvent.setup();
    await renderPanel();

    expect(screen.getByText('Searching 2 loaded of 3 missions. Load more to expand search.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more missions' }));

    expect(await screen.findByRole('link', { name: 'Gamma second-page mission' })).toHaveAttribute(
      'href',
      '/missions/spec-gamma',
    );
    const missionRows = within(screen.getByRole('list', { name: 'Missions' })).getAllByRole('listitem');
    expect(missionRows).toHaveLength(3);
    expect(screen.getAllByRole('link', { name: 'Beta billing migration' })).toHaveLength(1);
    expect(screen.getByText('Searching all 3 loaded missions.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more missions' })).not.toBeInTheDocument();
  });
});
