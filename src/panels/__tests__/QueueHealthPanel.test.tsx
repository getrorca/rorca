/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import QueueHealthPanel, {
  deriveQueueDisplayStatus,
  type WorkerHealth,
} from '../QueueHealthPanel';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

vi.mock('../../hooks/useWalSSE', () => ({
  useWalSSE: vi.fn(),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const BASE_HEALTH: WorkerHealth = {
  workerActive: true,
  workerPid: 123,
  queueHealth: 'healthy',
  queueStats: {
    pending: 0,
    active: 0,
    failed: 0,
    completed24h: 4,
    failedInLast24h: 0,
    pickupLatency: {
      avgSeconds: 0.5,
      p50Seconds: 0.4,
      p95Seconds: 0.8,
      maxSeconds: 1,
      sampleCount: 4,
      status: 'healthy',
    },
    queues: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
});

describe('queue health truth table', () => {
  it.each([
    ['idle', BASE_HEALTH],
    ['healthy', { ...BASE_HEALTH, queueStats: { ...BASE_HEALTH.queueStats, active: 1 } }],
    ['degraded', { ...BASE_HEALTH, queueHealth: 'degraded' as const }],
    ['critical', { ...BASE_HEALTH, queueHealth: 'critical' as const }],
    ['offline', { ...BASE_HEALTH, workerActive: false }],
    ['unknown', { ...BASE_HEALTH, workerActive: undefined } as unknown as WorkerHealth],
  ] as const)('derives %s without allowing an inactive worker to be healthy', (expected, health) => {
    expect(deriveQueueDisplayStatus(health)).toBe(expected);
  });

  it('renders an inactive worker as offline, not healthy or idle', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
      if (path === '/api/pipeline/worker/health') return { ...BASE_HEALTH, workerActive: false, queueHealth: 'critical' };
      if (path.includes('/api/pipeline/queue/health-history')) return { snapshots: [], interval: '5m', totalSnapshots: 0, windowHours: 24 };
      return {};
    });

    renderWithProviders(<QueueHealthPanel />);

    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.getByText(/Worker heartbeat is inactive/i)).toBeInTheDocument();
    expect(screen.queryByText('healthy')).not.toBeInTheDocument();
  });

  it('renders a failed health request as unavailable without zero metrics', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
      if (path === '/api/pipeline/worker/health') throw new Error('network down');
      if (path.includes('/api/pipeline/queue/health-history')) throw new Error('history down');
      return {};
    });

    renderWithProviders(<QueueHealthPanel />);

    expect(await screen.findByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText(/no status or zero metrics are shown/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 pending/i)).not.toBeInTheDocument();
    expect(screen.queryByText('healthy')).not.toBeInTheDocument();
  });

  it('renders malformed health responses as unknown', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
      if (path === '/api/pipeline/worker/health') return { queueHealth: 'healthy', queueStats: BASE_HEALTH.queueStats };
      if (path.includes('/api/pipeline/queue/health-history')) return { snapshots: [], interval: '5m', totalSnapshots: 0, windowHours: 24 };
      return {};
    });

    renderWithProviders(<QueueHealthPanel />);

    expect(await screen.findByText('unknown')).toBeInTheDocument();
    expect(screen.getByText(/did not satisfy the health contract/i)).toBeInTheDocument();
  });
});
