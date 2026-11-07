/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import {
  ActionEnvelopeV1Schema,
  MISSION_CONTRACT_VERSIONS,
  type ActionEnvelopeV1,
  type BlockerV1,
  type EntityRefV1,
  type OwnerRefV1,
  type PermittedActionV1,
  type RevisionRefV1,
} from '../../../shared/contracts/mission';
import { WorkspaceProvider } from '../../contexts/WorkspaceContext';
import { AuthProvider } from '../../contexts/AuthContext';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { HelpTipsProvider } from '../../contexts/HelpTipsContext';
import TodayPanel from '../TodayPanel';

// The project targets lib ES2022, but the test runtime (Node 22) provides
// Promise.withResolvers. Augment the type locally so the deferred-fetch gate
// below stays linear without the Promise executor form.
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

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

const WORKSPACE_RESPONSE = {
  items: [{ id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] }],
  total: 1,
  hasMore: false,
};

// ─── Contract-valid fixtures (parsed at construction so they can never drift) ─

interface EnvelopeInput {
  actionId: string;
  priority: ActionEnvelopeV1['priority'];
  entityKind: EntityRefV1['kind'];
  entityId: string;
  entityLabel: string;
  whyNow: string;
  consequence: string;
  permittedKind: PermittedActionV1['kind'];
  permittedLabel: string;
  permittedHref: string;
  requiresApproval?: boolean;
  owner?: OwnerRefV1;
  revision?: RevisionRefV1;
  missionLabel?: string;
  blocker?: BlockerV1;
  outcome?: ActionEnvelopeV1['state']['outcome'];
  liveness?: ActionEnvelopeV1['state']['liveness'];
  risk?: ActionEnvelopeV1['state']['risk'];
}

function makeEnvelope(input: EnvelopeInput): ActionEnvelopeV1 {
  return ActionEnvelopeV1Schema.parse({
    schemaVersion: MISSION_CONTRACT_VERSIONS.actionEnvelope,
    actionId: input.actionId,
    workspaceId: 'ws-1',
    entity: {
      schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
      workspaceId: 'ws-1',
      kind: input.entityKind,
      id: input.entityId,
      ...(input.revision ? { revision: input.revision } : {}),
      label: input.entityLabel,
    },
    ...(input.missionLabel
      ? {
          mission: {
            schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
            workspaceId: 'ws-1',
            kind: 'mission',
            id: 'mission-1',
            label: input.missionLabel,
          },
        }
      : {}),
    priority: input.priority,
    whyNow: input.whyNow,
    state: {
      schemaVersion: MISSION_CONTRACT_VERSIONS.operationalStatePacket,
      outcome: input.outcome ?? 'pending',
      liveness: input.liveness ?? 'running',
      risk: input.risk ?? 'low',
      confidence: 'high',
      freshness: 'fresh',
      authority: 'authoritative',
      observedAt: '2026-08-06T11:58:00Z',
      source: { kind: 'backend', id: 'attention-projector', label: 'Attention projector' },
      ...(input.blocker ? { blocker: input.blocker } : {}),
      consequence: input.consequence,
      nextSafeAction: {
        actionId: `${input.actionId}-safe`,
        label: 'Open the object',
        rationale: 'The safest next step is to inspect the authoritative object.',
        requiresApproval: false,
        authority: 'user',
        href: '/missions',
      },
    },
    owner: input.owner ?? { kind: 'unassigned', label: 'Unassigned' },
    createdAt: '2026-08-06T11:50:00Z',
    freshness: 'fresh',
    permittedAction: {
      actionId: input.actionId,
      kind: input.permittedKind,
      label: input.permittedLabel,
      requiresApproval: input.requiresApproval ?? false,
      authority: 'user',
      href: input.permittedHref,
    },
  });
}

const SAFETY_ITEM = makeEnvelope({
  actionId: 'act-safety-1',
  priority: 'safety',
  entityKind: 'spec',
  entityId: 'spec-1',
  entityLabel: 'Context intelligence spec',
  revision: { kind: 'spec_version', value: 'spec-v7' },
  missionLabel: 'Ship context intelligence',
  whyNow: 'A failing gate is blocking the release candidate.',
  consequence: 'Release stays blocked until the gate is re-reviewed.',
  permittedKind: 'review',
  permittedLabel: 'Review spec',
  permittedHref: '/workspaces/ws-1/specs/spec-1/review',
  requiresApproval: true,
  owner: { kind: 'user', id: 'user-1', label: 'Dimitri' },
  outcome: 'failed',
  liveness: 'stalled',
  risk: 'critical',
});

const DECISION_ITEM = makeEnvelope({
  actionId: 'act-decision-1',
  priority: 'decision',
  entityKind: 'decision',
  entityId: 'decision-9',
  entityLabel: 'Choose embedding model',
  whyNow: 'Two stories need the embedding choice before they can start.',
  consequence: 'Stories stay queued until the decision is made.',
  permittedKind: 'open_decision',
  permittedLabel: 'Open decision',
  permittedHref: '/workspaces/ws-1/objects/decision/decision-9',
});

const BLOCKED_ITEM = makeEnvelope({
  actionId: 'act-blocked-1',
  priority: 'blocked',
  entityKind: 'run',
  entityId: '42',
  entityLabel: 'Run 42',
  revision: { kind: 'snapshot', value: 'snap-0042' },
  whyNow: 'The run stalled on a missing credential.',
  consequence: 'Wave 2 cannot start while the credential is missing.',
  permittedKind: 'resolve_blocker',
  permittedLabel: 'Resolve blocker',
  permittedHref: '/workspaces/ws-1/runs/42',
  owner: { kind: 'system', id: 'scheduler', label: 'Scheduler' },
  blocker: {
    code: 'missing-credential',
    message: 'The provider credential is not configured for this workspace.',
    remediation: 'Add the credential in Settings, then retry the run.',
  },
  liveness: 'stalled',
  risk: 'high',
});

const ATTENTION_RESPONSE = {
  items: [SAFETY_ITEM, DECISION_ITEM, BLOCKED_ITEM],
  generatedAt: '2026-08-06T11:59:00Z',
};

// ─── API mock ─────────────────────────────────────────────────────────────────

function installApiMock(attentionHandler: () => Promise<unknown>) {
  mockApiFetch.mockImplementation((url: string) => {
    if (url === '/api/workspaces') return Promise.resolve(WORKSPACE_RESPONSE);
    if (url === '/api/health') return Promise.resolve({ status: 'ok' });
    if (url.startsWith('/api/pipeline/runs')) return Promise.resolve({ items: [] });
    if (url.includes('/pipeline-config')) return Promise.resolve({ config: {} });
    if (url.includes('/attention')) return attentionHandler();
    return Promise.reject(new Error(`Unexpected apiFetch: ${url}`));
  });
}

function attentionCallCount(): number {
  return mockApiFetch.mock.calls.filter(([url]) => String(url).includes('/attention')).length;
}

function renderToday() {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <HelpTipsProvider>
            <MemoryRouter initialEntries={['/today']}>
              <WorkspaceProvider>
                <Routes>
                  <Route path="/today" element={<TodayPanel />} />
                  <Route path="/missions" element={<div>Missions page</div>} />
                </Routes>
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
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.localStorage.setItem('rorca_workspaceId', 'ws-1');
  installApiMock(() => Promise.resolve(ATTENTION_RESPONSE));
});

describe('TodayPanel', () => {
  it('renders items in exact server order with envelope-authored content', async () => {
    renderToday();

    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(3);
    expect(screen.getByRole('list', { name: 'Ranked actions' })).toBeInTheDocument();

    // Exact server order: safety, decision, blocked.
    expect(within(cards[0]).getByText('Context intelligence spec')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Choose embedding model')).toBeInTheDocument();
    expect(within(cards[2]).getByText('Run 42')).toBeInTheDocument();

    // Safety card: priority marker, why-now, consequence, owner, revision chip, mission, action.
    expect(within(cards[0]).getByText('Safety risk')).toBeInTheDocument();
    expect(within(cards[0]).getByText('A failing gate is blocking the release candidate.')).toBeInTheDocument();
    expect(
      within(cards[0]).getByText('Consequence: Release stays blocked until the gate is re-reviewed.'),
    ).toBeInTheDocument();
    expect(within(cards[0]).getByText('Owner: Dimitri')).toBeInTheDocument();
    expect(within(cards[0]).getByRole('button', { name: 'Copy spec_version: spec-v7' })).toBeInTheDocument();
    expect(within(cards[0]).getByText('Mission: Ship context intelligence')).toBeInTheDocument();
    expect(
      within(cards[0]).getByRole('link', { name: 'Review spec, requires approval' }),
    ).toBeInTheDocument();

    // Decision card: unassigned owner, no revision chip.
    expect(within(cards[1]).getByText('Decision needed')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Unassigned')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Consequence: Stories stay queued until the decision is made.')).toBeInTheDocument();
    expect(within(cards[1]).queryByRole('button', { name: /^Copy / })).not.toBeInTheDocument();
    expect(within(cards[1]).getByRole('link', { name: 'Open decision' })).toBeInTheDocument();

    // Blocked card: server-authored blocker note and system owner.
    expect(within(cards[2]).getByText('Blocked')).toBeInTheDocument();
    expect(within(cards[2]).getByText('missing-credential')).toBeInTheDocument();
    expect(within(cards[2]).getByText('Owner: Scheduler')).toBeInTheDocument();
    expect(within(cards[2]).getByRole('button', { name: 'Copy snapshot: snap-0042' })).toBeInTheDocument();
    expect(within(cards[2]).getByRole('link', { name: 'Resolve blocker' })).toBeInTheDocument();
  });

  it('appends a returnTo context to the permitted action href', async () => {
    renderToday();

    const cards = await screen.findAllByRole('article');
    const actionLink = within(cards[0]).getByRole('link', { name: 'Review spec, requires approval' });
    const href = actionLink.getAttribute('href') ?? '';
    expect(href.startsWith('/workspaces/ws-1/specs/spec-1/review')).toBe(true);
    expect(href).toContain('returnTo=');
  });

  it('links a spec-kind entity title to the mission workspace', async () => {
    renderToday();

    const cards = await screen.findAllByRole('article');
    const titleLink = within(cards[0]).getByRole('link', { name: 'Context intelligence spec' });
    const href = titleLink.getAttribute('href') ?? '';
    expect(href.startsWith('/missions/spec-1')).toBe(true);
    expect(href).toContain('returnTo=');
  });

  it('shows a retryable error banner when the projection fetch fails', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    installApiMock(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new ApiError(500, 'server_error', 'boom'));
      return Promise.resolve(ATTENTION_RESPONSE);
    });
    renderToday();

    expect(
      await screen.findByText('The attention projection is unavailable. boom'),
    ).toBeInTheDocument();
    const callsBeforeRetry = attentionCallCount();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(attentionCallCount()).toBeGreaterThan(callsBeforeRetry);
    expect(await screen.findAllByRole('article')).toHaveLength(3);
  });

  it('fails closed on contract violation and renders no action cards', async () => {
    installApiMock(() => Promise.resolve({ items: [{ bogus: true }], generatedAt: 'x' }));
    renderToday();

    expect(
      await screen.findByText('Attention data failed contract validation'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The server response did not match the published contract. This surface fails closed rather than guessing state.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Contract issues')).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('shows the empty state with an Open Missions action when nothing is ranked', async () => {
    const user = userEvent.setup();
    installApiMock(() => Promise.resolve({ items: [], generatedAt: '2026-08-06T11:59:00Z' }));
    renderToday();

    expect(await screen.findByText('Nothing needs your decision')).toBeInTheDocument();
    expect(
      screen.getByText('The server found no pending decisions, blockers, or risks for this workspace.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open Missions' }));
    expect(await screen.findByText('Missions page')).toBeInTheDocument();
  });

  it('filters by priority presentation-only and restores with All', async () => {
    const user = userEvent.setup();
    renderToday();

    expect(await screen.findAllByRole('article')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /^Decisions/ }));
    const decisionOnly = screen.getAllByRole('article');
    expect(decisionOnly).toHaveLength(1);
    expect(within(decisionOnly[0]).getByText('Choose embedding model')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Decisions/ })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /^All/ }));
    expect(screen.getAllByRole('article')).toHaveLength(3);
    // Server order preserved through filtering.
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Context intelligence spec');
  });

  it('shows a skeleton list while the first load is in flight', async () => {
    const gate = Promise.withResolvers<unknown>();
    installApiMock(() => gate.promise);
    renderToday();

    const skeleton = await screen.findByLabelText('Loading ranked actions');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryAllByRole('article')).toHaveLength(0);

    gate.resolve(ATTENTION_RESPONSE);
    expect(await screen.findAllByRole('article')).toHaveLength(3);
    expect(screen.queryByLabelText('Loading ranked actions')).not.toBeInTheDocument();
  });

  it('ignores an older refresh response when a newer refresh completes first', async () => {
    const older = Promise.withResolvers<unknown>();
    const newer = Promise.withResolvers<unknown>();
    let attempt = 0;
    installApiMock(() => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve(ATTENTION_RESPONSE);
      if (attempt === 2) return older.promise;
      return newer.promise;
    });
    const user = userEvent.setup();
    renderToday();
    expect(await screen.findAllByRole('article')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    newer.resolve({
      items: [DECISION_ITEM],
      generatedAt: '2026-08-06T12:01:00Z',
    });

    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(1);
      expect(screen.getByText('Choose embedding model')).toBeInTheDocument();
    });

    older.resolve({
      items: [BLOCKED_ITEM],
      generatedAt: '2026-08-06T12:00:00Z',
    });
    await Promise.resolve();
    expect(screen.getByText('Choose embedding model')).toBeInTheDocument();
    expect(screen.queryByText('Run 42')).not.toBeInTheDocument();
  });

  it('retains rows and marks them stale when a background refresh fails until retry succeeds', async () => {
    let attempt = 0;
    installApiMock(() => {
      attempt += 1;
      if (attempt === 2) return Promise.reject(new ApiError(503, 'UNAVAILABLE', 'refresh service unavailable'));
      return Promise.resolve(ATTENTION_RESPONSE);
    });
    const user = userEvent.setup();
    renderToday();
    expect(await screen.findAllByRole('article')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const staleAlert = await screen.findByRole('alert');
    expect(staleAlert).toHaveTextContent('Refresh failed. Showing the last successful ranking');
    expect(staleAlert).toHaveTextContent('refresh service unavailable');
    expect(screen.getAllByRole('article')).toHaveLength(3);

    await user.click(within(staleAlert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Refresh failed/)).not.toBeInTheDocument());
    expect(screen.getAllByRole('article')).toHaveLength(3);
  });
});
