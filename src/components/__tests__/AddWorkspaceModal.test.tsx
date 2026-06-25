/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * LHM-008 — AddWorkspaceModal DB-mode honesty coverage.
 *
 * Proves the onboarding modal surfaces explicit Native / Docker / BYOP mode
 * selection, keeps the Graph Lite vs Full Graph copy truthful, only reveals
 * the secret DATABASE_URL field for BYOP, validates that BYOP requires a URL
 * before submitting, and forwards the selected mode (and BYOP secret) to the
 * workspace-create API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
}));

import AddWorkspaceModal from '../AddWorkspaceModal';
import { apiFetch } from '../../lib/apiFetch';
import { defaultDatabaseSetupGuidance } from '../../lib/databaseSetup';

const mockApiFetch = vi.mocked(apiFetch);

/**
 * Wire apiFetch so the GET /api/health probe returns the supplied database
 * setup guidance and the POST /api/workspaces create returns a workspace.
 */
function wireApiFetch(options?: {
  selectedMode?: 'native' | 'docker' | 'byop';
  createError?: Error;
}) {
  mockApiFetch.mockImplementation(((url: string, init?: { method?: string }) => {
    if (url === '/api/health') {
      return Promise.resolve({
        databaseSetup: {
          ...defaultDatabaseSetupGuidance,
          selectedMode: options?.selectedMode ?? 'native',
        },
        databaseCapability: { dbMode: options?.selectedMode ?? 'native' },
      });
    }
    if (url === '/api/workspaces' && init?.method === 'POST') {
      if (options?.createError) return Promise.reject(options.createError);
      return Promise.resolve({
        workspace: { id: 'cashflowai', label: 'CashflowAI', path: '/tmp/x', domains: [] },
        needsBootstrap: false,
      });
    }
    return Promise.resolve({});
  }) as typeof apiFetch);
}

function renderModal() {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  render(<AddWorkspaceModal onClose={onClose} onSuccess={onSuccess} />);
  return { onClose, onSuccess };
}

describe('AddWorkspaceModal — DB mode selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers all three explicit database modes', async () => {
    wireApiFetch();
    renderModal();

    // Labels appear both in the mode card and the selected-guide panel.
    expect((await screen.findAllByText('Local / native Postgres')).length).toBeGreaterThan(0);
    expect(screen.getByText('Docker Postgres with AGE')).toBeInTheDocument();
    expect(screen.getByText('Bring your own Postgres')).toBeInTheDocument();
  });

  it('keeps Graph Lite vs Full Graph copy truthful in the comparison panel', async () => {
    wireApiFetch();
    renderModal();

    // Both graph modes are explained so users are not surprised by Lite fallback.
    expect(await screen.findByText('Full Graph vs Graph Lite')).toBeInTheDocument();
    expect(screen.getByText('Full Graph')).toBeInTheDocument();
    expect(screen.getAllByText('Graph Lite').length).toBeGreaterThan(0);
    // Native default advertises Graph Lite, not an overclaimed Full Graph.
    expect(screen.getAllByText(/Graph Lite expected/).length).toBeGreaterThan(0);
  });

  it('only reveals the secret DATABASE_URL field after selecting BYOP', async () => {
    wireApiFetch();
    renderModal();

    await screen.findByText('Bring your own Postgres');
    expect(screen.queryByLabelText('Secure DATABASE_URL input')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Bring your own Postgres'));
    expect(await screen.findByLabelText('Secure DATABASE_URL input')).toBeInTheDocument();
  });

  it('blocks BYOP submission without a DATABASE_URL and does not call the create API', async () => {
    wireApiFetch();
    renderModal();

    await userEvent.click(await screen.findByText('Bring your own Postgres'));
    await userEvent.type(screen.getByLabelText('Label'), 'CashflowAI');
    await userEvent.type(screen.getByLabelText('Path'), '/tmp/cashflow');

    await userEvent.click(screen.getByRole('button', { name: /Create Workspace/i }));

    expect(await screen.findByText('DATABASE_URL is required for BYOP mode')).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/workspaces',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('forwards the selected BYOP mode and secret URL to the create API', async () => {
    wireApiFetch();
    const { onSuccess } = renderModal();

    await userEvent.click(await screen.findByText('Bring your own Postgres'));
    await userEvent.type(screen.getByLabelText('Label'), 'CashflowAI');
    await userEvent.type(screen.getByLabelText('Path'), '/tmp/cashflow');
    await userEvent.type(
      screen.getByLabelText('Secure DATABASE_URL input'),
      'postgres://u:p@db.example.supabase.co:5432/postgres?sslmode=require',
    );

    await userEvent.click(screen.getByRole('button', { name: /Create Workspace/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const postCall = mockApiFetch.mock.calls.find(
      ([url, init]) => url === '/api/workspaces' && (init as { method?: string })?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as { body: string }).body);
    expect(body.dbMode).toBe('byop');
    expect(body.databaseUrl).toBe('postgres://u:p@db.example.supabase.co:5432/postgres?sslmode=require');
  });

  it('omits the BYOP secret when submitting a native workspace', async () => {
    wireApiFetch();
    const { onSuccess } = renderModal();

    await screen.findAllByText('Local / native Postgres');
    await userEvent.type(screen.getByLabelText('Label'), 'CashflowAI');
    await userEvent.type(screen.getByLabelText('Path'), '/tmp/cashflow');

    await userEvent.click(screen.getByRole('button', { name: /Create Workspace/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const postCall = mockApiFetch.mock.calls.find(
      ([url, init]) => url === '/api/workspaces' && (init as { method?: string })?.method === 'POST',
    );
    const body = JSON.parse((postCall![1] as { body: string }).body);
    expect(body.dbMode).toBe('native');
    expect(body.databaseUrl).toBeUndefined();
  });

  it('surfaces a BYOP validation failure from the backend on the DATABASE_URL field', async () => {
    wireApiFetch({
      createError: new Error('The selected PostgreSQL database must have the pgvector extension installed'),
    });
    renderModal();

    await userEvent.click(await screen.findByText('Bring your own Postgres'));
    await userEvent.type(screen.getByLabelText('Label'), 'CashflowAI');
    await userEvent.type(screen.getByLabelText('Path'), '/tmp/cashflow');
    await userEvent.type(
      screen.getByLabelText('Secure DATABASE_URL input'),
      'postgres://u:p@db.example.neon.tech:5432/rorca?sslmode=require',
    );

    await userEvent.click(screen.getByRole('button', { name: /Create Workspace/i }));

    // The full backend message is distinct from the static "pgvector extension installed" checklist item.
    expect(
      await screen.findByText(/must have the pgvector extension installed/),
    ).toBeInTheDocument();
  });
});
