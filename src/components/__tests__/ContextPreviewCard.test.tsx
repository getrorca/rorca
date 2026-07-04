/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ContextPreviewCard tests — US-023
 * Covers: full context, stale graph, missing Hilo, no relevant files
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ContextPreviewCard from '../ContextPreviewCard';

// Mock apiFetch
vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: '',
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = apiFetch as ReturnType<typeof vi.fn>;

// Mock workspace context
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'test-workspace', workspaces: [{ id: 'test-workspace', name: 'Test' }] }),
}));

function mockFullContextResponse() {
  mockApiFetch.mockImplementation((url: string, opts?: Record<string, unknown>) => {
    if (url === '/api/specs/generation-context') {
      return Promise.resolve({
        contextSummary: {
          directionLayers: {
            l1: true,
            l2: { present: true, domain: 'web' },
            l3: true,
            l1Title: 'Global Standards',
            l2Title: 'Web Conventions',
            l3Title: 'Rorca Project',
            l1Tokens: 1200,
            l2Tokens: 800,
            l3Tokens: 3000,
          },
          skills: ['rorca-forge', 'excalidraw-diagram', 'rorca-approve'],
          memoryEntries: 5,
          agentsMd: true,
          template: 'feature-template',
          schemaSnapshot: true,
          estimatedTokens: 15000,
          modelContextWindow: 200000,
          retrieval: {
            cagHits: 3,
            ragHits: 2,
            graphHits: 5,
            tier: 'hybrid',
            latencyMs: 120,
            ontologyExplainability: {
              status: 'available',
              activeCount: 2,
              suppressedCount: 1,
              conflictCount: 0,
              hiddenExplanationCount: 0,
              examples: ['US-001 → file-a.ts', 'US-002 → file-b.ts'],
              message: '',
            },
          },
          workspaceRouting: {
            stack: ['React', 'TypeScript', 'Express', 'PostgreSQL'],
            missingContextFiles: [],
            richnessScore: 8,
            contract: {},
          },
          predictedFiles: ['src/components/Shell.tsx', 'src/lib/apiFetch.ts', 'backend/src/server.ts'],
        },
      });
    }
    if (url?.startsWith('/api/workspaces/') && url?.endsWith('/hydration')) {
      return Promise.resolve({
        workspaceId: 'test-workspace',
        provider: 'hilo',
        latest: {
          status: 'succeeded',
          finishedAt: new Date().toISOString(),
          gitSha: 'abc1234',
          counts: { nodes: 45, edges: 120, files: 30 },
        },
        freshness: 'clean',
        freshnessDetails: {
          gitRepo: true,
          hasHydration: true,
          headMatches: true,
          dirtyTree: false,
          currentHead: 'abc1234',
          hydratedSha: 'abc1234',
          humanSummary: 'Graph is current',
        },
        counts: { nodes: 45, edges: 120, files: 30 },
        errors: { hasErrors: false, latestError: null, latestErrorStatus: null },
        currentStatus: null,
        actionHint: 'none',
        actionMessage: null,
      });
    }
    // Hydrate POST
    if (url?.startsWith('/api/workspaces/') && url?.endsWith('/hydration') && opts?.method === 'POST') {
      return Promise.resolve({
        hydrationId: 99,
        status: 'pending',
        idempotent: false,
        message: 'Hydration queued',
      });
    }
    return Promise.resolve(null);
  });
}

function mockStaleGraphResponse() {
  mockApiFetch.mockImplementation((url: string, _opts?: Record<string, unknown>) => {
    if (url === '/api/specs/generation-context') {
      return Promise.resolve({
        contextSummary: {
          directionLayers: {
            l1: true,
            l2: { present: false, domain: null },
            l3: true,
            l1Title: 'Standards',
            l2Title: null,
            l3Title: 'Project',
            l1Tokens: 1000,
            l2Tokens: 0,
            l3Tokens: 2000,
          },
          skills: [],
          memoryEntries: 1,
          agentsMd: false,
          template: null,
          schemaSnapshot: false,
          estimatedTokens: 5000,
          modelContextWindow: 200000,
          retrieval: {
            cagHits: 1,
            ragHits: 0,
            graphHits: 0,
            tier: 'cache',
            latencyMs: 40,
          },
          workspaceRouting: {
            stack: ['TypeScript'],
            missingContextFiles: [],
            richnessScore: 3,
            contract: {},
          },
        },
      });
    }
    if (url?.startsWith('/api/workspaces/') && url?.endsWith('/hydration')) {
      return Promise.resolve({
        workspaceId: 'test-workspace',
        provider: 'hilo',
        latest: {
          status: 'succeeded',
          finishedAt: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
          gitSha: 'old1234',
          counts: { nodes: 20, edges: 50, files: 15 },
        },
        freshness: 'stale',
        freshnessDetails: {
          gitRepo: true,
          hasHydration: true,
          headMatches: false,
          dirtyTree: false,
          currentHead: 'newabcd',
          hydratedSha: 'old1234',
          humanSummary: 'Graph was built at old1234 but HEAD is now at newabcd',
        },
        counts: { nodes: 20, edges: 50, files: 15 },
        errors: { hasErrors: false, latestError: null, latestErrorStatus: null },
        currentStatus: null,
        actionHint: 'rehydrate',
        actionMessage: 'Graph is out of date. Re-hydrate to update.',
      });
    }
    return Promise.resolve(null);
  });
}

function mockMissingHiloResponse() {
  mockApiFetch.mockImplementation((url: string, _opts?: Record<string, unknown>) => {
    if (url === '/api/specs/generation-context') {
      return Promise.resolve({
        contextSummary: {
          directionLayers: {
            l1: false,
            l2: { present: false, domain: null },
            l3: false,
            l1Title: null,
            l2Title: null,
            l3Title: null,
            l1Tokens: 0,
            l2Tokens: 0,
            l3Tokens: 0,
          },
          skills: [],
          memoryEntries: 0,
          agentsMd: false,
          template: null,
          schemaSnapshot: false,
          estimatedTokens: 1000,
          modelContextWindow: 200000,
          retrieval: {
            cagHits: 0,
            ragHits: 0,
            graphHits: 0,
            tier: 'cache',
            latencyMs: 10,
          },
          workspaceRouting: {
            stack: [],
            missingContextFiles: ['AGENTS.md', 'CLAUDE.md'],
            richnessScore: 1,
            contract: {},
          },
        },
      });
    }
    if (url?.startsWith('/api/workspaces/') && url?.endsWith('/hydration')) {
      return Promise.resolve({
        workspaceId: 'test-workspace',
        provider: 'hilo',
        latest: null,
        freshness: 'missing',
        freshnessDetails: {
          gitRepo: false,
          hasHydration: false,
          headMatches: false,
          dirtyTree: false,
          currentHead: null,
          hydratedSha: null,
          humanSummary: 'No hydration data available',
        },
        counts: {},
        errors: { hasErrors: false, latestError: null, latestErrorStatus: null },
        currentStatus: null,
        actionHint: 'configure_hilo',
        actionMessage: 'Hilo is not available for this workspace. Configure and enable Hilo to hydrate the codegraph.',
      });
    }
    return Promise.resolve(null);
  });
}

function mockNoRelevantFilesResponse() {
  mockApiFetch.mockImplementation((url: string, _opts?: Record<string, unknown>) => {
    if (url === '/api/specs/generation-context') {
      return Promise.resolve({
        contextSummary: {
          directionLayers: {
            l1: true,
            l2: { present: false, domain: null },
            l3: false,
            l1Title: 'Standards',
            l2Title: null,
            l3Title: null,
            l1Tokens: 500,
            l2Tokens: 0,
            l3Tokens: 0,
          },
          skills: [],
          memoryEntries: 0,
          agentsMd: false,
          template: null,
          schemaSnapshot: false,
          estimatedTokens: 2000,
          modelContextWindow: 200000,
          workspaceRouting: {
            stack: [],
            missingContextFiles: [],
            richnessScore: 2,
            contract: {},
          },
        },
      });
    }
    if (url?.startsWith('/api/workspaces/') && url?.endsWith('/hydration')) {
      return Promise.resolve({
        workspaceId: 'test-workspace',
        provider: 'hilo',
        latest: null,
        freshness: 'missing',
        freshnessDetails: {
          gitRepo: false, hasHydration: false, headMatches: false, dirtyTree: false,
          currentHead: null, hydratedSha: null, humanSummary: 'No data',
        },
        counts: {},
        errors: { hasErrors: false, latestError: null, latestErrorStatus: null },
        currentStatus: null,
        actionHint: 'configure_hilo',
        actionMessage: null,
      });
    }
    return Promise.resolve(null);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('ContextPreviewCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders collapsed by default', () => {
    render(<ContextPreviewCard workspaceId="test-workspace" brief="Build a login system" />);
    expect(screen.getByTestId('context-preview-card')).toBeInTheDocument();
    expect(screen.getByTestId('context-preview-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('context-preview-body')).not.toBeInTheDocument();
  });

  it('expands and loads context preview on click (full context)', async () => {
    mockFullContextResponse();
    render(<ContextPreviewCard workspaceId="test-workspace" brief="Build a login system" />);

    fireEvent.click(screen.getByTestId('context-preview-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('context-preview-body')).toBeInTheDocument();
    });

    // Should show direction layers
    await waitFor(() => {
      expect(screen.getByTestId('context-preview-section-direction-layers')).toBeInTheDocument();
    });

    // Should show skills section
    expect(screen.getByTestId('context-preview-section-skills')).toBeInTheDocument();

    // Should show memory section
    expect(screen.getByTestId('context-preview-section-memory-&-retrieval')).toBeInTheDocument();

    // Should show graph section
    expect(screen.getByTestId('context-preview-section-knowledge-graph')).toBeInTheDocument();

    // Should show files section
    expect(screen.getByTestId('context-preview-section-context-files')).toBeInTheDocument();

    // Should show token bar
    expect(screen.getByTestId('context-preview-token-bar')).toBeInTheDocument();

    // Graph should be up-to-date
    const freshness = screen.getByTestId('context-preview-graph-freshness');
    expect(freshness).toHaveTextContent('Knowledge graph up to date');
  });

  it('shows stale graph warning and rehydrate button', async () => {
    mockStaleGraphResponse();
    render(<ContextPreviewCard workspaceId="test-workspace" brief="Build a login system" />);

    fireEvent.click(screen.getByTestId('context-preview-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('context-preview-graph-freshness')).toBeInTheDocument();
    });

    const freshness = screen.getByTestId('context-preview-graph-freshness');
    expect(freshness).toHaveTextContent('Knowledge graph is stale');

    // Should have hydrate button
    const hydrateBtn = screen.getByTestId('context-preview-hydrate-btn');
    expect(hydrateBtn).toBeInTheDocument();
    expect(hydrateBtn).toHaveTextContent('Re-hydrate');
  });

  it('shows missing Hilo indicator when graph unavailable', async () => {
    mockMissingHiloResponse();
    render(<ContextPreviewCard workspaceId="test-workspace" brief="Build a login system" />);

    fireEvent.click(screen.getByTestId('context-preview-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('context-preview-graph-freshness')).toBeInTheDocument();
    });

    const freshness = screen.getByTestId('context-preview-graph-freshness');
    expect(freshness).toHaveTextContent('Knowledge graph unavailable');

    // Should show Hilo not configured indicator
    expect(screen.getByTestId('context-preview-hilo-missing')).toBeInTheDocument();
    expect(screen.getByTestId('context-preview-hilo-missing')).toHaveTextContent('Hilo not configured');
  });

  it('shows no relevant files when context is sparse', async () => {
    mockNoRelevantFilesResponse();
    render(<ContextPreviewCard workspaceId="test-workspace" brief="Some obscure topic" />);

    fireEvent.click(screen.getByTestId('context-preview-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('context-preview-body')).toBeInTheDocument();
    });

    // Expand the files section
    const filesSection = screen.getByTestId('context-preview-section-context-files');
    fireEvent.click(filesSection);

    await waitFor(() => {
      expect(screen.getByTestId('context-preview-section-context-files-body')).toBeInTheDocument();
    });

    // Should show "no relevant files" entry
    expect(screen.getByTestId('context-preview-entry-files-none')).toBeInTheDocument();
  });

  it('shows warnings when context has issues', async () => {
    mockMissingHiloResponse();
    render(<ContextPreviewCard workspaceId="test-workspace" brief="Some obscure topic" />);

    fireEvent.click(screen.getByTestId('context-preview-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('context-preview-body')).toBeInTheDocument();
    });

    // Should show warnings about missing direction layers
    await waitFor(() => {
      const warnings = screen.getAllByTestId('context-preview-warning');
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  it('triggers hydration when hydrate button is clicked', async () => {
    mockStaleGraphResponse();
    render(<ContextPreviewCard workspaceId="test-workspace" brief="Build a login system" />);

    fireEvent.click(screen.getByTestId('context-preview-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('context-preview-hydrate-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('context-preview-hydrate-btn'));

    // Should call the hydration endpoint
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workspaces/test-workspace/hydration'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows loading state when fetching context', async () => {
    // Return a promise that never resolves so loading state persists
    mockApiFetch.mockImplementation(() => new Promise(() => {}));

    render(<ContextPreviewCard workspaceId="test-workspace" brief="Build a login system" />);
    fireEvent.click(screen.getByTestId('context-preview-toggle'));

    // Loading indicator should appear while promise is pending
    await waitFor(() => {
      expect(screen.getByTestId('context-preview-loading')).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  it('shows error state when fetch throws synchronously', async () => {
    // Synchronous throw bypasses the .catch chain inside fetchContextPreview
    mockApiFetch.mockImplementation(() => { throw new Error('Network error'); });

    render(<ContextPreviewCard workspaceId="test-workspace" brief="Build a login system" />);
    fireEvent.click(screen.getByTestId('context-preview-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('context-preview-error')).toBeInTheDocument();
    });
  });

  it('collapses when header is clicked again', async () => {
    mockFullContextResponse();
    render(<ContextPreviewCard workspaceId="test-workspace" brief="Build a login system" />);

    // Expand
    fireEvent.click(screen.getByTestId('context-preview-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('context-preview-body')).toBeInTheDocument();
    });

    // Collapse
    fireEvent.click(screen.getByTestId('context-preview-toggle'));
    await waitFor(() => {
      expect(screen.queryByTestId('context-preview-body')).not.toBeInTheDocument();
    });
  });
});
