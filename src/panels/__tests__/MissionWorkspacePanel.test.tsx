/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { AuthProvider } from '../../contexts/AuthContext';
import { HelpTipsProvider } from '../../contexts/HelpTipsContext';
import { WorkspaceProvider } from '../../contexts/WorkspaceContext';
import MissionWorkspacePanel from '../MissionWorkspacePanel';
import {
  DeliveryCaseSummaryV1Schema,
  MISSION_CONTRACT_VERSIONS,
  RunControlProjectionV1Schema,
} from '../../../shared/contracts/mission';
import { MISSION_LENSES } from '../../lib/missionRoutes';
import { createReturnContext, serializeReturnContext } from '../../lib/returnContext';

vi.mock('../../lib/apiFetch', () => {
  class ApiError extends Error {
    public readonly details: Record<string, unknown>;
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'ApiError';
      this.details = details ?? {};
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

import { apiFetch, ApiError } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const NOW = '2026-08-06T12:00:00Z';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const HASH_D = `sha256:${'d'.repeat(64)}`;

const SOURCE_BUNDLE = {
  bundleId: 'bundle-verified-1',
  bundleHash: HASH_A,
  compiledAt: NOW,
  includedSources: [
    { sourceId: 'brief', title: 'Approved delivery brief', sourceVersion: 'rev-17', contentHash: HASH_B, selectedSections: ['Requirements', 'Constraints'] },
    { sourceId: 'policy', title: 'Security policy', sourceVersion: 'v4.2', contentHash: HASH_C, selectedSections: ['Authentication'] },
  ],
  excludedSources: [
    { source: { sourceId: 'notes', title: 'Unreviewed workshop notes', sourceVersion: 'draft-2', contentHash: HASH_D, selectedSections: ['Proposals'] }, reason: 'Draft notes were not approved by the mission owner.' },
  ],
  citations: [
    { citationId: 'cite-auth', sourceId: 'policy', section: 'Authentication', excerptHash: HASH_D, rationale: 'REQ-004 requires approved authentication controls.' },
  ],
  conflicts: [
    { conflictId: 'conflict-auth', sourceIds: ['brief', 'policy'], summary: 'The brief allowed optional authentication while policy requires it.', resolution: 'The approved security policy takes precedence.' },
  ],
};

const MISSION_REF = {
  schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
  workspaceId: 'ws-1',
  kind: 'mission',
  id: 'mission-1',
  revision: { kind: 'snapshot', value: 'm-rev-1' },
  label: 'Ship Mission OS',
} as const;

const SPEC_REF = {
  schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
  workspaceId: 'ws-1',
  kind: 'spec',
  id: 'spec-1',
  revision: { kind: 'spec_version', value: 'spec-rev-9' },
  label: 'Mission OS Spec',
} as const;

const RUN_REF = {
  schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
  workspaceId: 'ws-1',
  kind: 'run',
  id: '42',
  label: 'Run 42',
} as const;

function makePacket(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.operationalStatePacket,
    outcome: 'pending',
    liveness: 'running',
    risk: 'low',
    confidence: 'medium',
    freshness: 'fresh',
    authority: 'authoritative',
    observedAt: NOW,
    source: { kind: 'backend', id: 'mission-read-model', label: 'Mission read model' },
    consequence: 'Two review decisions block the next safe step.',
    nextSafeAction: {
      actionId: 'open-review',
      label: 'Open review decisions',
      rationale: 'Two review decisions are still unresolved.',
      requiresApproval: false,
      authority: 'user',
      href: '/workspaces/ws-1/specs/spec-1/review',
    },
    ...overrides,
  };
}

const STAGE_SUMMARIES: Record<(typeof MISSION_LENSES)[number], string> = {
  planning: 'Intent brief and sources are captured.',
  requirements: 'Stories are sequenced for review.',
  design: 'Architecture decisions are pending.',
  development: 'Canonical lifecycle checks are pending.',
  testing: 'Gates wait on lifecycle evidence.',
  deployment: 'Release bundle is not prepared yet.',
  maintenance: 'No knowledge candidates captured yet.',
};

function makeStage(label: string, summary: string, outcome: string) {
  return {
    label,
    summary,
    state: makePacket({ outcome }),
    updatedAt: NOW,
  };
}

function makeSummary(overrides: Record<string, unknown> = {}) {
  return DeliveryCaseSummaryV1Schema.parse({
    schemaVersion: MISSION_CONTRACT_VERSIONS.deliveryCaseSummary,
    workspaceId: 'ws-1',
    mission: MISSION_REF,
    spec: SPEC_REF,
    stages: {
      planning: makeStage('Planning', STAGE_SUMMARIES.planning, 'succeeded'),
      requirements: makeStage('Requirements', STAGE_SUMMARIES.requirements, 'partial'),
      design: makeStage('Design', STAGE_SUMMARIES.design, 'pending'),
      development: makeStage('Development', STAGE_SUMMARIES.development, 'unknown'),
      testing: makeStage('Testing', STAGE_SUMMARIES.testing, 'unknown'),
      deployment: makeStage('Deployment', STAGE_SUMMARIES.deployment, 'not_available'),
      maintenance: makeStage('Maintenance', STAGE_SUMMARIES.maintenance, 'unknown'),
    },
    review: { state: 'in_review', requiredDecisions: 4, unresolvedDecisions: 2 },
    readiness: { state: 'at_risk', completedChecks: 3, totalChecks: 5 },
    lifecycle: { state: 'active', currentStage: 'development' },
    run: { state: 'running', run: RUN_REF },
    release: { state: 'preparing' },
    state: makePacket(),
    actions: [],
    projectedAt: NOW,
    ...overrides,
  });
}

function makeControl(overrides: Record<string, unknown> = {}) {
  return RunControlProjectionV1Schema.parse({
    schemaVersion: MISSION_CONTRACT_VERSIONS.runControlProjection,
    workspaceId: 'ws-1',
    run: RUN_REF,
    mission: MISSION_REF,
    spec: SPEC_REF,
    stories: [],
    state: makePacket({ outcome: 'partial' }),
    waves: [
      {
        waveId: 'wave-1',
        label: 'Foundation',
        ordinal: 0,
        state: makePacket({ outcome: 'partial' }),
        lanes: [
          {
            laneId: 'lane-1',
            label: 'Build the API',
            agent: 'claude',
            model: 'opus-4',
            state: makePacket({ outcome: 'succeeded', liveness: 'completed' }),
            startedAt: '2026-08-06T11:00:00Z',
            completedAt: '2026-08-06T11:04:20Z',
          },
          {
            laneId: 'lane-2',
            label: 'Write the docs',
            agent: 'codex',
            state: makePacket({ outcome: 'pending', liveness: 'queued' }),
          },
        ],
      },
    ],
    costTokens: {
      currency: 'USD',
      estimatedCost: 1.5,
      actualCost: 0.42,
      inputTokens: 12000,
      outputTokens: 3400,
      totalTokens: 15400,
    },
    evidenceFreshness: {
      state: 'fresh',
      observedAt: NOW,
      newestEvidenceAt: '2026-08-06T11:30:00Z',
      staleAfterSeconds: 900,
      evidenceCount: 7,
    },
    permittedActions: [
      {
        actionId: 'view-evidence',
        kind: 'open_evidence',
        label: 'View run evidence',
        requiresApproval: false,
        authority: 'user',
        href: '/workspaces/ws-1/runs/42',
      },
    ],
    projectedAt: NOW,
    ...overrides,
  });
}

const SUMMARY = makeSummary();
const CONTROL = makeControl();
const EMPTY_LIST = { items: [], total: 0, hasMore: false } as never;

function mockDefault() {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.startsWith('/api/workspaces/ws-1/delivery-cases/spec-1/runs/')) return CONTROL;
    if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) return SUMMARY;
    return EMPTY_LIST;
  });
}

function renderMission(initialEntries: string[]) {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <HelpTipsProvider>
            <MemoryRouter initialEntries={initialEntries}>
              <WorkspaceProvider>
                <main aria-label="Application content">
                  <Routes>
                    <Route path="/missions/:specId" element={<MissionWorkspacePanel />} />
                    <Route path="/missions/:specId/:lens" element={<MissionWorkspacePanel />} />
                    <Route
                      path="/workspaces/:wsId/missions/:specId"
                      element={<MissionWorkspacePanel />}
                    />
                    <Route
                      path="/workspaces/:wsId/missions/:specId/:lens"
                      element={<MissionWorkspacePanel />}
                    />
                  </Routes>
                </main>
              </WorkspaceProvider>
            </MemoryRouter>
          </HelpTipsProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
  mockDefault();
});

describe('MissionWorkspacePanel', () => {
  it('renders the header with identity, revisions, situation, six facets, and one dominant action', async () => {
    const { container } = renderMission(['/missions/spec-1']);
    await screen.findByRole('heading', { level: 1, name: 'Ship Mission OS' });

    expect(screen.getByLabelText(/^Copy mission snapshot:/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Copy spec spec_version:/)).toBeInTheDocument();

    const situation = container.querySelector('.mission-header__situation');
    expect(situation?.textContent).toContain('Lifecycle active');
    expect(situation?.textContent).toContain('development stage');
    expect(situation?.textContent).toContain('readiness 3/5');
    expect(situation?.textContent).toContain('review in review');
    expect(situation?.textContent).toContain('Run: running');
    expect(situation?.textContent).toContain('Release: preparing');
    expect(screen.getByText('Workspace My Repo')).toBeInTheDocument();
    expect(screen.getByText('Mission owner unavailable')).toBeInTheDocument();
    expect(screen.getByText('Action owner unavailable')).toBeInTheDocument();

    const header = container.querySelector('.mission-header');
    expect(header).not.toBeNull();
    expect(header!.querySelectorAll('[data-facet]')).toHaveLength(6);

    const actions = container.querySelectorAll('.mission-header__action');
    expect(actions).toHaveLength(1);
    expect(
      screen.getByRole('link', { name: /Open review decisions/ }),
    ).toBe(actions[0]);
  });

  it('renders the frozen bundle with exact revisions, hash labels, citations, exclusions, and conflict rationale', async () => {
    const bundleSummary = makeSummary({ sourceBundle: SOURCE_BUNDLE, sourceContext: {
      contextState: 'fresh', stale: false, bundleHash: HASH_A, checkedAt: NOW, sources: [],
    } });
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) return bundleSummary;
      return EMPTY_LIST;
    });
    renderMission(['/missions/spec-1/planning']);

    expect(await screen.findByRole('heading', { name: 'Built from 2 sources' })).toBeInTheDocument();
    expect(screen.getByText('Approved delivery brief')).toBeInTheDocument();
    expect(screen.getByText('Revision rev-17')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approved delivery brief content hash/ })).toHaveAttribute('title', HASH_B);
    const citation = screen.getByRole('link', { name: 'Security policy — Authentication' });
    expect(citation).toHaveAttribute('href', '#intent-source-1-section-0');
    citation.focus();
    expect(citation).toHaveFocus();
    expect(screen.getByText('Requirement trace: REQ-004 requires approved authentication controls.')).toBeInTheDocument();
    expect(screen.getAllByText('Excluded sections: Unavailable in this projection')).toHaveLength(2);
    expect(screen.getByText('Unreviewed workshop notes')).toBeInTheDocument();
    expect(screen.getByText('Excluded sections: Proposals')).toBeInTheDocument();
    expect(screen.getByText(/Draft notes were not approved/)).toBeInTheDocument();
    expect(screen.getByText(/The approved security policy takes precedence/)).toBeInTheDocument();
    expect(screen.getByText('No drift detected')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Spec Review' })).not.toBeInTheDocument();
  });

  it('renders honest unavailable bundle and drift states without fabricated source fields', async () => {
    renderMission(['/missions/spec-1/planning']);
    expect(await screen.findByRole('heading', { name: 'Frozen source bundle unavailable' })).toBeInTheDocument();
    expect(screen.getByText('Drift check unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Built from \d+ sources/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open Spec Review' })).toHaveLength(1);
  });

  it('exposes stale frozen source state with exact old/new hashes and one dominant re-review action', async () => {
    const staleSummary = makeSummary({ sourceBundle: SOURCE_BUNDLE, sourceContext: {
      contextState: 'stale', stale: true, bundleHash: HASH_A, checkedAt: NOW,
      sources: [{ sourceId: 'local-brief', locator: 'brief.md', state: 'changed', oldHash: HASH_B, newHash: HASH_C,
        detail: 'Live content differs from the frozen hash; frozen content was not replaced.' }],
    } });
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) return staleSummary;
      return EMPTY_LIST;
    });
    renderMission(['/missions/spec-1/planning']);
    const driftRegion = await screen.findByRole('region', { name: 'Source drift' });
    expect(driftRegion).toHaveTextContent('Source context is stale');
    expect(within(driftRegion).getByRole('button', { name: /brief.md frozen source hash/ })).toHaveAttribute('title', HASH_B);
    expect(within(driftRegion).getByRole('button', { name: /brief.md current source hash/ })).toHaveAttribute('title', HASH_C);
    expect(screen.getByText(/Recompile and re-review/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open Spec Review' })).toHaveLength(1);
  });

  it('distinguishes deleted, unavailable, and unknown live source states', async () => {
    const stateSummary = makeSummary({ sourceBundle: SOURCE_BUNDLE, sourceContext: {
      contextState: 'stale', stale: true, bundleHash: HASH_A, checkedAt: NOW,
      sources: [
        { sourceId: 'deleted', locator: 'deleted.md', state: 'deleted', oldHash: HASH_B, newHash: null, detail: 'Frozen local source no longer exists.' },
        { sourceId: 'unavailable', locator: 'offline.md', state: 'unavailable', oldHash: HASH_B, newHash: null, detail: 'The source verifier was unavailable.' },
        { sourceId: 'unknown', locator: 'external/source', state: 'unknown', oldHash: HASH_B, newHash: null, detail: 'No live verifier is configured.' },
      ],
    } });
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) return stateSummary;
      return EMPTY_LIST;
    });
    renderMission(['/missions/spec-1/planning']);

    const driftRegion = await screen.findByRole('region', { name: 'Source drift' });
    expect(within(driftRegion).getByText('deleted.md · deleted').parentElement).toHaveTextContent('CurrentDeleted');
    expect(within(driftRegion).getByText('offline.md · unavailable').parentElement).toHaveTextContent('CurrentUnavailable');
    expect(within(driftRegion).getByText('external/source · unknown').parentElement).toHaveTextContent('CurrentUnknown');
  });

  it.each(MISSION_LENSES)('renders the %s lens with its stage summary', async (lens) => {
    renderMission([`/missions/spec-1/${lens}`]);
    await screen.findByRole('heading', { level: 1, name: 'Ship Mission OS' });
    expect(await screen.findByText(STAGE_SUMMARIES[lens])).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: `${lens[0].toUpperCase()}${lens.slice(1)} lens` }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('redirects an unknown lens to the base mission path', async () => {
    renderMission(['/missions/spec-1/bogus']);
    expect(await screen.findByText('Case projections')).toBeInTheDocument();
  });

  it('fails closed when the summary payload violates the contract', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) {
        return { ...SUMMARY, bogus: true };
      }
      return EMPTY_LIST;
    });
    const { container } = renderMission(['/missions/spec-1']);
    expect(await screen.findByText(/failed contract validation/)).toBeInTheDocument();
    expect(container.querySelector('.mission-header')).toBeNull();
  });

  it('shows an honest empty state on the build lens when no run is scheduled', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) {
        return makeSummary({ run: { state: 'not_scheduled' } });
      }
      return EMPTY_LIST;
    });
    renderMission(['/missions/spec-1/development']);
    expect(await screen.findByText('No run scheduled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Spec Review' })).toBeInTheDocument();
  });

  it('loads the run control projection on the build lens', async () => {
    renderMission(['/missions/spec-1/development']);
    expect(await screen.findByText('Wave 1 · Foundation')).toBeInTheDocument();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/delivery-cases/spec-1/runs/42/control',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(screen.getByText(/agent claude · model opus-4/)).toBeInTheDocument();
    expect(screen.getByText(/agent codex/)).toBeInTheDocument();
    expect(screen.getByText('elapsed 4m 20s')).toBeInTheDocument();
    expect(screen.getByText('not started')).toBeInTheDocument();
    expect(
      screen.getByText('Cost $0.42 actual · $1.50 estimated · tokens in 12k / out 3.4k'),
    ).toBeInTheDocument();
    expect(screen.getByText(/newest evidence/)).toBeInTheDocument();
    expect(screen.getByText(/7 evidence items · stale after 900s/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View run evidence' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open run in Run View (raw terminal)' }),
    ).toBeInTheDocument();
  });

  it('shows the inline contract state when the control payload is malformed', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/spec-1/runs/')) {
        return { ...CONTROL, bogus: true };
      }
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) return SUMMARY;
      return EMPTY_LIST;
    });
    const { container } = renderMission(['/missions/spec-1/development']);
    expect(
      await screen.findByText('Run control projection failed contract validation'),
    ).toBeInTheDocument();
    expect(container.querySelector('.mission-header')).not.toBeNull();
  });

  it('resolves the Back link from return context and preserves it on the stage rail', async () => {
    const context = createReturnContext({ pathname: '/today', search: '' })!;
    const entry = `/missions/spec-1/requirements?returnTo=${encodeURIComponent(
      serializeReturnContext(context),
    )}`;
    const { container } = renderMission([entry]);
    await screen.findByRole('heading', { level: 1, name: 'Ship Mission OS' });

    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/today');

    const railLink = container.querySelector('.stage-rail__item');
    expect(railLink?.getAttribute('href')).toContain('returnTo=');
  });

  it('renders the no-projection empty state when the backend returns 404', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) {
        throw new ApiError(404, 'NOT_FOUND', 'No delivery case for spec');
      }
      return EMPTY_LIST;
    });
    renderMission(['/missions/spec-1']);
    expect(
      await screen.findByText('No delivery case projection for this spec'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Spec Review' })).toBeInTheDocument();
  });

  it.each([
    {
      label: '401',
      error: new ApiError(401, 'UNAUTHORIZED', 'Session expired'),
      expected: /Authorization failed while loading this mission projection/,
    },
    {
      label: '500',
      error: new ApiError(500, 'INTERNAL', 'Projection service failed'),
      expected: /projection request failed \(HTTP 500\)/,
    },
    {
      label: 'network',
      error: new TypeError('Failed to fetch'),
      expected: /Could not reach the delivery case projection/,
    },
  ])('shows a retryable contextual error for $label instead of a missing projection state', async ({ error, expected }) => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) throw error;
      return EMPTY_LIST;
    });
    renderMission(['/missions/spec-1/planning']);

    expect(await screen.findByRole('heading', { name: 'Mission projection unavailable' })).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByText('Mission spec-1 · Workspace My Repo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/missions');
    expect(screen.queryByText('No delivery case projection for this spec')).not.toBeInTheDocument();
  });

  it('renders eight rail links, marks the active lens, and preserves the query string', async () => {
    const { container } = renderMission(['/missions/spec-1?foo=bar']);
    await screen.findByRole('heading', { level: 1, name: 'Ship Mission OS' });

    const links = container.querySelectorAll('.stage-rail__item');
    expect(links).toHaveLength(8);

    const current = container.querySelector('.stage-rail__item[aria-current="page"]');
    expect(current?.textContent).toContain('Overview');

    links.forEach((link) => {
      expect(link.getAttribute('href')).toContain('foo=bar');
    });
  });

  it('names and visibly labels every normalized stage outcome without color-only dots', async () => {
    const outcomeSummary = makeSummary({
      state: makePacket({ outcome: 'cancelled' }),
      stages: {
        planning: makeStage('Planning', STAGE_SUMMARIES.planning, 'succeeded'),
        requirements: makeStage('Requirements', STAGE_SUMMARIES.requirements, 'failed'),
        design: makeStage('Design', STAGE_SUMMARIES.design, 'partial'),
        development: makeStage('Development', STAGE_SUMMARIES.development, 'pending'),
        testing: makeStage('Testing', STAGE_SUMMARIES.testing, 'unknown'),
        deployment: makeStage('Deployment', STAGE_SUMMARIES.deployment, 'unknown'),
        maintenance: makeStage('Maintenance', STAGE_SUMMARIES.maintenance, 'not_available'),
      },
    });
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/workspaces/ws-1/delivery-cases/')) return outcomeSummary;
      return EMPTY_LIST;
    });
    const { container } = renderMission(['/missions/spec-1']);
    await screen.findByRole('heading', { level: 1, name: 'Ship Mission OS' });

    const expectedOutcomes = [
      ['Overview', 'Cancelled'],
      ['Planning', 'Succeeded'],
      ['Requirements', 'Failed'],
      ['Design', 'Partial'],
      ['Development', 'Pending'],
      ['Testing', 'Unknown'],
      ['Deployment', 'Unknown'],
      ['Maintenance', 'N/A'],
    ] as const;
    for (const [lensLabel, outcomeLabel] of expectedOutcomes) {
      const link = screen.getByRole('link', {
        name: new RegExp(`^${lensLabel} — outcome ${outcomeLabel.replace('/', '\\/')}`),
      });
      expect(within(link).getByText(outcomeLabel)).toBeVisible();
      expect(link.querySelector('.stage-rail__outcome')).not.toHaveAttribute('aria-hidden');
    }
    expect(container.querySelector('.stage-rail__dot')).toBeNull();
  });
});
