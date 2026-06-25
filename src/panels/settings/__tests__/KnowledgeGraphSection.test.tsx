/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * LHM-008 — KnowledgeGraphSection UI honesty coverage.
 *
 * Proves the settings surface tells the truth when AGE is missing: Graph Lite
 * copy and badge appear, the connection string is rendered redacted (no
 * credentials), graph population is gated behind Full Graph, and that the
 * Full-Graph (Docker/AGE) path hides the Lite notice and enables population.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { DatabaseCapability } from '../../../contexts/CapabilitiesContext';
import { defaultDatabaseSetupGuidance } from '../../../lib/databaseSetup';

vi.mock('../../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('../../../contexts/CapabilitiesContext', () => ({
  useCapabilities: () => ({ refreshCapabilities: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('../../../contexts/ToastContext', () => ({
  useGlobalToast: () => ({ show: vi.fn() }),
}));

vi.mock('../../../hooks/useWalSSE', () => ({
  useWalSSE: () => undefined,
}));

vi.mock('../../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
}));

import KnowledgeGraphSection from '../KnowledgeGraphSection';
import { apiFetch } from '../../../lib/apiFetch';

const mockApiFetch = vi.mocked(apiFetch);

function makeCapability(overrides: Partial<DatabaseCapability> = {}): DatabaseCapability {
  return {
    dbMode: 'native',
    provider: 'native-postgres',
    extensions: { age: false, vector: true, pgcrypto: false },
    graphMode: 'lite',
    warnings: ['Native mode is running in lite graph mode because Apache AGE is not installed locally.'],
    connection: {
      url: 'postgres://db.example.com:5432/rorca',
      host: 'db.example.com',
      port: 5432,
      database: 'rorca',
      local: false,
    },
    connected: true,
    ...overrides,
  };
}

function makeStatus(capability: DatabaseCapability) {
  return {
    workspaceId: 'ws-1',
    databaseCapability: capability,
    databaseSetup: { ...defaultDatabaseSetupGuidance, selectedMode: capability.dbMode },
    graph: {
      available: capability.graphMode === 'full',
      graphMode: capability.graphMode,
      vertexCount: 0,
      edgeCount: 0,
      graphName: 'rorca_graph',
      lastPopulatedAt: null,
      warnings: capability.warnings,
    },
  };
}

function wireStatus(capability: DatabaseCapability) {
  mockApiFetch.mockImplementation(((url: string) => {
    if (url.startsWith('/api/workspaces/ws-1/status')) {
      return Promise.resolve(makeStatus(capability));
    }
    return Promise.resolve({});
  }) as typeof apiFetch);
}

describe('KnowledgeGraphSection — Graph Lite honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Graph Lite copy and badge when AGE is missing', async () => {
    wireStatus(makeCapability());
    render(<KnowledgeGraphSection />);

    expect(await screen.findByText('Graph Lite is active')).toBeInTheDocument();
    // The GraphCapabilityNotice spells out the fallback story rather than failing opaquely.
    expect(
      screen.getByText(/Knowledge Graph, relevance, and memory surfaces stay useful with fallback data/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Graph Lite').length).toBeGreaterThan(0);
  });

  it('renders the connection string redacted, never exposing credentials', async () => {
    wireStatus(makeCapability());
    render(<KnowledgeGraphSection />);

    const connection = await screen.findByText('postgres://db.example.com:5432/rorca');
    expect(connection).toBeInTheDocument();
    expect(connection.textContent).not.toContain('@');
    expect(connection.textContent).not.toMatch(/password|secret/i);
  });

  it('reports the AGE warning verbatim from the capability contract', async () => {
    wireStatus(makeCapability());
    render(<KnowledgeGraphSection />);

    // The warning is echoed both in the notice hint and the warnings list.
    expect(
      (await screen.findAllByText(/lite graph mode because Apache AGE is not installed locally/)).length,
    ).toBeGreaterThan(0);
  });

  it('gates graph population behind Full Graph when AGE is missing', async () => {
    wireStatus(makeCapability());
    render(<KnowledgeGraphSection />);

    const populateBtn = await screen.findByRole('button', { name: /Populate Graph/i });
    expect(populateBtn).toBeDisabled();
    expect(screen.getByText('Graph population requires full AGE support.')).toBeInTheDocument();
  });

  it('hides the Lite notice and enables population on the Full Graph (Docker/AGE) path', async () => {
    wireStatus(
      makeCapability({
        dbMode: 'docker',
        provider: 'docker-postgres',
        extensions: { age: true, vector: true, pgcrypto: false },
        graphMode: 'full',
        warnings: [],
        connection: {
          url: 'postgres://localhost:5432/rorca',
          host: 'localhost',
          port: 5432,
          database: 'rorca',
          local: true,
        },
      }),
    );
    render(<KnowledgeGraphSection />);

    const populateBtn = await screen.findByRole('button', { name: /Populate Graph/i });
    expect(populateBtn).toBeEnabled();
    expect(screen.queryByText('Graph Lite is active')).not.toBeInTheDocument();
    expect(screen.queryByText('Graph population requires full AGE support.')).not.toBeInTheDocument();
  });

  it('reveals the secret DATABASE_URL input only for the BYOP mode card', async () => {
    wireStatus(makeCapability());
    render(<KnowledgeGraphSection />);

    await screen.findByText('Graph Lite is active');
    expect(screen.queryByLabelText('Secure DATABASE_URL input')).not.toBeInTheDocument();

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByText('Bring your own Postgres'));
    await waitFor(() => expect(screen.getByLabelText('Secure DATABASE_URL input')).toBeInTheDocument());
  });
});
