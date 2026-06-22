/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import HealthDashboardPanel from '../HealthDashboardPanel';

const mockNavigateTo = vi.fn();

vi.mock('../../routes', async () => {
  const actual = await vi.importActual<typeof import('../../routes')>('../../routes');
  return {
    ...actual,
    useAppNavigate: vi.fn(() => mockNavigateTo),
  };
});

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const MOCK_HEALTH_BASIC = {
  status: 'ok',
  version: '1.0.0',
  uptime: 3600,
  db_connected: true,
  active_runs: 0,
  authRequired: false,
};

const MOCK_HEALTH_DETAILED = {
  ...MOCK_HEALTH_BASIC,
  db_size: 1024 * 1024 * 5, // 5 MB
  dbMode: 'docker',
  graphMode: 'lite',
  graphWarnings: ['Run `rorca db start` to ensure the Docker Postgres sidecar is ready with Apache AGE enabled.'],
  databaseCapability: {
    dbMode: 'docker',
    provider: 'docker-postgres',
    extensions: { age: false, vector: true, pgcrypto: true },
    graphMode: 'lite',
    warnings: ['Run `rorca db start` to ensure the Docker Postgres sidecar is ready with Apache AGE enabled.'],
    connection: {
      url: 'postgres://localhost:5432/rorca',
      host: 'localhost',
      port: 5432,
      database: 'rorca',
      local: true,
    },
    connected: true,
  },
  pending_specs_count: 2,
  memory_usage: {
    rss: 1024 * 1024 * 100,
    heapTotal: 1024 * 1024 * 80,
    heapUsed: 1024 * 1024 * 60,
    external: 1024 * 1024 * 5,
  },
  last_backup_at: null,
};

const MOCK_WORKSPACE_HEALTH = {
  score: 85,
  components: [
    { name: 'CLAUDE.md', score: 30, maxScore: 30, status: 'good' },
    { name: 'AGENTS.md', score: 20, maxScore: 20, status: 'good' },
    { name: 'config.json', score: 15, maxScore: 20, status: 'partial' },
    { name: 'MEMORY.md', score: 15, maxScore: 15, status: 'good' },
    { name: 'Skills', score: 5, maxScore: 15, status: 'partial' },
  ],
  scannedAt: new Date().toISOString(),
};

const MOCK_ONTOLOGY_HEALTH = {
  available: true,
  dataAvailable: true,
  workspaceId: 'ws-1',
  ageAvailable: true,
  mode: 'bounded-sql',
  reason: null,
  emptyReason: null,
  bounds: {
    relationLimit: 12,
    hotspotMemoryWindow: 400,
    hotspotResultLimit: 6,
    activityLimit: 12,
    activityWindowDays: 14,
  },
  summary: {
    activeConflictCount: 1,
    supersededMemoryCount: 2,
    hotspotDensityPct: 8.5,
    hotspotCount: 2,
    densestHotspot: {
      scopeType: 'file',
      key: 'backend/src/routes/memory.ts',
      label: 'backend/src/routes/memory.ts',
      memoryCount: 34,
      conflictCount: 1,
      supersededCount: 2,
      lastTouchedAt: '2026-06-02T10:00:00.000Z',
      sampleMemoryIds: [1, 2],
      memoryIds: [1, 2],
      specIds: ['spec-a'],
      filePaths: ['backend/src/routes/memory.ts'],
    },
    recentCurationCount: 3,
  },
  drilldowns: {
    conflicts: {
      total: 1,
      truncated: false,
      items: [
        {
          relationId: 91,
          relationType: 'CONFLICTS_WITH',
          status: 'active',
          updatedAt: '2026-06-03T10:00:00.000Z',
          sourceMemoryId: 1,
          targetMemoryId: 2,
          sourceCategory: 'Architecture',
          targetCategory: 'Decision',
          sourceContent: 'Direction Stack says follow the old flow.',
          targetContent: 'Recent review says use the new flow.',
          sourceSpecId: 'spec-a',
          targetSpecId: 'spec-b',
          sourceStoryId: 'MOG-001',
          targetStoryId: 'MOG-009',
          sourceFiles: ['backend/src/routes/memory.ts'],
          targetFiles: ['src/panels/MemoryPanel.tsx'],
          memoryIds: [1, 2],
          specIds: ['spec-a', 'spec-b'],
          filePaths: ['backend/src/routes/memory.ts', 'src/panels/MemoryPanel.tsx'],
        },
      ],
    },
    superseded: {
      total: 2,
      truncated: false,
      items: [
        {
          relationId: 92,
          relationType: 'SUPERSEDES',
          status: 'active',
          updatedAt: '2026-06-03T09:00:00.000Z',
          memoryId: 4,
          supersededByMemoryId: 5,
          category: 'Convention',
          content: 'Old guidance',
          supersedingCategory: 'Convention',
          supersedingContent: 'New guidance',
          sourceSpecId: 'spec-a',
          supersedingSpecId: 'spec-a',
          sourceStoryId: 'MOG-002',
          supersedingStoryId: 'MOG-009',
          relatedFiles: ['src/panels/MemoryPanel.tsx'],
          supersedingFiles: ['src/panels/MemoryPanel.tsx'],
          memoryIds: [4, 5],
          specIds: ['spec-a'],
          filePaths: ['src/panels/MemoryPanel.tsx'],
        },
      ],
    },
    hotspots: {
      total: 2,
      truncated: false,
      items: [
        {
          scopeType: 'file',
          key: 'backend/src/routes/memory.ts',
          label: 'backend/src/routes/memory.ts',
          memoryCount: 34,
          conflictCount: 1,
          supersededCount: 2,
          lastTouchedAt: '2026-06-02T10:00:00.000Z',
          sampleMemoryIds: [1, 2],
          memoryIds: [1, 2],
          specIds: [],
          filePaths: ['backend/src/routes/memory.ts'],
        },
        {
          scopeType: 'spec',
          key: 'spec-a',
          label: 'spec-a',
          memoryCount: 20,
          conflictCount: 1,
          supersededCount: 1,
          lastTouchedAt: '2026-06-02T10:00:00.000Z',
          sampleMemoryIds: [4, 5],
          memoryIds: [4, 5],
          specIds: ['spec-a'],
          filePaths: [],
        },
      ],
      files: [],
      specs: [],
    },
    recentCuration: {
      total: 3,
      truncated: false,
      items: [
        {
          kind: 'review',
          at: '2026-06-03T11:00:00.000Z',
          action: 'keep',
          summary: 'Review action: keep',
          memoryIds: [1],
          specIds: ['spec-a'],
          filePaths: ['backend/src/routes/memory.ts'],
        },
      ],
    },
  },
};

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigateTo.mockReset();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.removeItem('rorca_memory_analytics_drilldown');
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/health/detailed') return MOCK_HEALTH_DETAILED;
    return { items: [], total: 0, hasMore: false } as never;
  });
});

describe('HealthDashboardPanel', () => {
  it('renders ontology health metrics and drilldowns on the analytics surface', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/health/detailed') return MOCK_HEALTH_DETAILED;
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/analytics/ontology-health?workspace_id=ws-1') return MOCK_ONTOLOGY_HEALTH;
      if (path === '/api/workspaces/ws-1/health') return { ...MOCK_WORKSPACE_HEALTH, semantic: undefined };
      if (path === '/api/conventions/drift/ws-1') throw new Error('no report');
      return {};
    });

    renderWithProviders(<HealthDashboardPanel />);

    expect(await screen.findByText('Ontology Health')).toBeInTheDocument();
    expect(screen.getByText('Docker Postgres')).toBeInTheDocument();
    expect(screen.getAllByText('Graph Lite').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Active conflicts').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hotspot density').length).toBeGreaterThan(0);
    expect(screen.getByText('Direction Stack says follow the old flow.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Hotspot density/i }));
    expect(await screen.findByText('backend/src/routes/memory.ts')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Open in Memory panel/i }));
    expect(mockNavigateTo).toHaveBeenCalledWith('direction');
    const stored = JSON.parse(sessionStorage.getItem('rorca_memory_analytics_drilldown') || '{}');
    expect(stored.metric).toBe('hotspots');
    expect(stored.filePaths).toContain('backend/src/routes/memory.ts');
  });

  it('shows explicit SQL fallback copy when AGE-backed ontology data is unavailable', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/health/detailed') return MOCK_HEALTH_DETAILED;
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/analytics/ontology-health?workspace_id=ws-1') {
        return {
          ...MOCK_ONTOLOGY_HEALTH,
          ageAvailable: false,
          mode: 'bounded-sql-fallback',
          reason: 'Apache AGE extension is unavailable. Ontology health is using bounded SQL summaries and direct provenance drill-downs only.',
        };
      }
      if (path === '/api/workspaces/ws-1/health') return { ...MOCK_WORKSPACE_HEALTH, semantic: undefined };
      if (path === '/api/conventions/drift/ws-1') throw new Error('no report');
      return {};
    });

    renderWithProviders(<HealthDashboardPanel />);

    expect(await screen.findByText('SQL fallback')).toBeInTheDocument();
    expect(screen.getByText(/bounded SQL summaries/i)).toBeInTheDocument();
  });

  it('shows ontology unavailable copy when the analytics endpoint fails', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/health/detailed') return MOCK_HEALTH_DETAILED;
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/analytics/ontology-health?workspace_id=ws-1') throw new Error('Ontology request failed');
      if (path === '/api/workspaces/ws-1/health') return { ...MOCK_WORKSPACE_HEALTH, semantic: undefined };
      if (path === '/api/conventions/drift/ws-1') throw new Error('no report');
      return {};
    });

    renderWithProviders(<HealthDashboardPanel />);

    expect(await screen.findByText(/Ontology health unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Ontology request failed/)).toBeInTheDocument();
  });
});
