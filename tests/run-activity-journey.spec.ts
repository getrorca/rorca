/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const WORKSPACE_ID = 'workspace:run-activity-journey';
const RUN_ID = 42;
const T = '2026-08-05T12:00:00.000Z';
const H = `sha256:${'a'.repeat(64)}`;
const PLANES = [
  'source_config_drift',
  'dependency_health',
  'runtime_health',
  'queue_outbox_freshness',
  'lease_fence_retry_recovery',
  'observability_pipeline',
  'provider_operations',
] as const;

type JourneyMode = 'live' | 'reconnecting' | 'gap' | 'cancelled' | 'empty' | 'error' | 'completed';

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function planes() {
  return PLANES.map((plane, index) => ({
    plane,
    status: plane === 'queue_outbox_freshness' ? 'stale' : plane === 'provider_operations' ? 'degraded' : 'healthy',
    sourceClass: `${plane}:probe`,
    sourceIdentity: `${plane}:canonical-source`,
    sourceHash: H,
    observedAt: T,
    validUntil: index === 3 ? '2026-08-05T11:59:00.000Z' : '2026-08-05T12:05:00.000Z',
    reasonCode: `${plane}:observed`,
    impact: `${plane} has an independent bounded impact.`,
    nextSafeAction: `Inspect ${plane} without inferring aggregate readiness.`,
    observationSequence: 900 + index,
  }));
}

function projection(mode: JourneyMode) {
  const operationalPlanes = Object.fromEntries(planes().map((plane) => [plane.plane, plane]));
  return {
    schemaVersion: 'rorca.run-activity-projection.v1',
    streamId: mode === 'empty' ? null : 'stream:journey',
    runtimeGeneration: mode === 'empty' ? null : 7,
    lastSequence: mode === 'empty' ? 0 : 1_000,
    lastEventHash: mode === 'empty' ? null : H,
    eventCount: mode === 'empty' ? 0 : 1_000,
    incomplete: mode === 'gap',
    gap: mode === 'gap' ? { expectedSequence: 999, observedSequence: 1_000, reasonCode: 'pruned' } : null,
    transport: mode === 'reconnecting' ? 'closed' : mode === 'empty' ? 'empty' : 'open',
    lease: mode === 'cancelled' ? 'stale' : mode === 'empty' ? 'unknown' : 'active',
    cancellation: mode === 'cancelled' ? 'requested' : 'none',
    context: mode === 'reconnecting' ? 'retrying' : mode === 'empty' ? 'unknown' : 'compacted',
    completionCandidate: mode === 'completed' ? 'submitted_to_closeout' : 'observed',
    retryBudget: { state: mode === 'reconnecting' ? 'backoff' : 'available', spent: mode === 'reconnecting' ? 2 : 1, maximum: 5 },
    closeout: mode === 'completed' ? { decisionId: 'decision:accepted', decisionHash: H, status: 'accepted', verified: true } : null,
    establishesStoryCompletion: mode === 'completed',
    operationalPlanes,
  };
}

function stateResponse(mode: JourneyMode) {
  return {
    schemaVersion: 'rorca.run-view-state.v1',
    state: mode === 'cancelled' ? 'degraded' : mode === 'completed' ? 'story_accepted' : mode,
    projection: projection(mode),
    operationalPlanes: planes(),
    planeCount: 7,
    notices: [
      'Terminal and runtime activity are observability. Completion is shown only from host closeout records.',
      'Operational planes are independent and have no aggregate readiness authority.',
    ],
    authorityLabels: {
      terminalOutput: 'observability_only', runtimeAssertion: 'observability_only', completionCandidate: 'proposal_only',
      storyCompletion: 'verified_StoryCloseoutDecision.accepted_only', runLifecycle: 'separate_host_authority',
      mergeDeploymentProduction: 'not_authorized',
    },
    authoritative: false,
    authorityEffect: 'none',
  };
}

function event(mode: JourneyMode) {
  const completed = mode === 'completed';
  return {
    eventId: completed ? 'event:closeout' : `event:${mode}`,
    streamSequence: completed ? 1_001 : 1_000,
    observedAt: T,
    kind: completed ? 'story_closeout_observed' : mode === 'reconnecting' ? 'transport_closed' : 'pty_output_referenced',
    plane: completed ? 'closeout' : mode === 'reconnecting' ? 'transport' : 'terminal',
    payload: completed
      ? { decisionId: 'decision:accepted', decisionStatus: 'accepted', reasonCode: 'canonical_closeout_accepted' }
      : mode === 'reconnecting'
        ? { state: 'closed', reasonCode: 'transport:disconnected' }
        : { reasonCode: 'pty:durable-noisy-range', rawBytesIncluded: false },
    redaction: { class: 'restricted', ordinaryProjectionContainsRaw: false },
    authorityEffect: 'none',
  };
}

async function installRunActivityTransport(page: Page) {
  let mode: JourneyMode = 'live';
  await page.addInitScript((workspaceId) => {
    localStorage.setItem('rorca_workspaceId', workspaceId);
    sessionStorage.setItem('rorca_workspaceId', workspaceId);
    localStorage.setItem('rorca_theme', 'light');
  }, WORKSPACE_ID);
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/auth/csrf-token') return json(route, { token: 'run-activity-csrf' });
    if (path === '/api/workspaces') return json(route, {
      items: [{ id: WORKSPACE_ID, name: 'Run Activity Journey', label: 'Run Activity Journey', path: '/tmp/run-activity' }],
      total: 1, hasMore: false,
    });
    if (path === `/api/pipeline/runs/${RUN_ID}`) return json(route, {
      run: { id: RUN_ID, spec_path: 'forge/specs/approved/run-activity.json', workspace_id: WORKSPACE_ID,
        status: 'running', pid: null, started_at: T, finished_at: null, agent_type: 'pi', agent_model: null,
        terminal_mode: 'pty', parallelism: 1 },
      stories: [], specStories: [], storyTokenBreakdown: [], contextComparison: null, runState: null,
    });
    if (path === `/api/mission-control/v1/run-activity/runs/${RUN_ID}/state`) {
      if (mode === 'error') return json(route, { error: 'Run activity unavailable', code: 'RUN_ACTIVITY_UNAVAILABLE' }, 503);
      return json(route, stateResponse(mode));
    }
    if (path === `/api/mission-control/v1/run-activity/runs/${RUN_ID}/events`) {
      if (mode === 'error') return json(route, { error: 'Replay unavailable', code: 'RUN_ACTIVITY_UNAVAILABLE' }, 503);
      const status = mode === 'gap' ? 'gap' : 'ok';
      return json(route, {
        schemaVersion: 'rorca.run-activity-page.v1', status, resetReason: mode === 'gap' ? 'pruned' : null,
        streamId: mode === 'empty' ? null : 'stream:journey', runtimeGeneration: mode === 'empty' ? null : 7,
        firstRetainedSequence: mode === 'empty' ? null : 901, lastDurableSequence: mode === 'empty' ? null : 1_001,
        events: mode === 'empty' || mode === 'gap' ? [] : [event(mode)], nextCursor: 'cursor:durable-tail', hasMore: false,
        authoritative: false, authorityEffect: 'none',
      });
    }
    if (path === `/api/pipeline/runs/${RUN_ID}/output`) {
      const noisy = Buffer.from('\u001b[31mNOISY PTY 100%\u001b[0m\n'.repeat(200)).toString('base64');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: chunk\ndata: ${noisy}\n\nevent: done\ndata: {}\n\n` });
    }
    if (path === '/api/pipeline/stream' || path === '/api/wal/stream') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }
    return json(route, { items: [], total: 0, hasMore: false, config: {} });
  });
  return { setMode: (next: JourneyMode) => { mode = next; } };
}

async function refresh(page: Page) {
  await page.getByRole('button', { name: 'Refresh run activity' }).click({ force: true });
}

test('Run View keeps terminal output non-authoritative while replaying bounded structured state', async ({ page }) => {
  const transport = await installRunActivityTransport(page);
  await page.goto(`/runs/${RUN_ID}`);
  const activityTab = page.getByRole('button', { name: 'Activity', exact: true });
  await activityTab.focus();
  await expect(activityTab).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Stories', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(activityTab).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('run-activity-view')).toBeVisible();

  await expect(page.getByText('Observability only; host closeout remains authoritative.')).toBeVisible();
  await expect(page.getByTestId('run-current-state')).toContainText('generation 7');
  await expect(page.getByTestId('run-current-state')).toContainText('active');
  await expect(page.getByTestId('run-current-state')).toContainText('compacted');
  await expect(page.getByTestId('activity-stream')).toContainText('#1000');
  await expect(page.getByTestId('activity-stream')).toContainText('pty:durable-noisy-range');
  const view = page.getByTestId('run-activity-view');
  await expect(page.getByRole('region', { name: 'Governed run activity' })).toBeVisible();
  await expect(view.getByText('NOISY PTY 100%', { exact: true }).first()).toBeVisible();
  await expect(view.getByTestId('run-current-state')).toBeVisible();
  const skipTerminal = page.getByRole('link', { name: 'Skip terminal output to governed activity' });
  await activityTab.focus();
  for (let index = 0; index < 20 && !await skipTerminal.evaluate((element) => element === document.activeElement); index += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(skipTerminal).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Governed run activity' })).toBeFocused();
  await page.keyboard.press('Tab');
  const refreshButton = page.getByRole('button', { name: 'Refresh run activity' });
  await expect(refreshButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(view.getByTestId('activity-stream')).toContainText('#1000');
  await expect(page.getByTestId('status-planes')).toContainText('queue outbox freshness');
  await expect(page.getByTestId('status-planes')).toContainText('stale');
  await expect(page.getByTestId('status-planes')).toContainText('queue_outbox_freshness:canonical-source');
  await expect(page.getByTestId('status-planes')).toContainText('valid until 2026-08-05T11:59:00.000Z');

  transport.setMode('reconnecting');
  await refresh(page);
  await expect(page.getByText('reconnecting', { exact: true })).toBeVisible();
  await expect(page.getByTestId('run-current-state')).toContainText('retrying');
  await expect(page.getByTestId('run-current-state')).toContainText('backoff · 2/5');

  transport.setMode('gap');
  await refresh(page);
  await expect(page.getByRole('alert')).toContainText('gap: pruned');

  transport.setMode('cancelled');
  await refresh(page);
  await expect(page.getByTestId('run-current-state')).toContainText('requested');
  await expect(page.getByTestId('run-current-state')).toContainText('stale');

  transport.setMode('empty');
  await refresh(page);
  await expect(page.getByText('No durable activity has been observed.')).toBeVisible();

  transport.setMode('error');
  await refresh(page);
  await expect(page.getByTestId('run-activity-view').getByRole('alert')).toContainText(/Run activity|Replay unavailable/i);

  transport.setMode('completed');
  await refresh(page);
  await expect(page.getByText('story_accepted', { exact: true })).toBeVisible();
  await expect(page.getByTestId('run-current-state')).toContainText('accepted · decision:accepted');
  await expect(page.getByTestId('activity-stream')).toContainText('canonical_closeout_accepted');
});
