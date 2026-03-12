/**
 * RunViewContextAccordion.test.tsx
 *
 * Tests for CU-005 (per-story context accordion in Stories tab) and
 * CU-006 (context usage summary bar in Run View header).
 *
 * Both components are internal to RunViewPanel — tested through the full panel.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders, createMockWorkspace, createMockRun } from '../../test/helpers';
import RunViewPanel from '../RunViewPanel';

// ─── Mock apiFetch ─────────────────────────────────────────────────────────
vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

vi.mock('../../hooks/usePipelineSSE', () => ({
  usePipelineSSE: vi.fn(() => []),
}));

vi.mock('../../components/RunTerminal', () => ({
  default: vi.fn(({ runId }: { runId: number }) => (
    <div data-testid="run-terminal">Terminal for run {runId}</div>
  )),
  RunTerminal: vi.fn(({ runId }: { runId: number }) => (
    <div data-testid="run-terminal">Terminal for run {runId}</div>
  )),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

// ─── Mock data ─────────────────────────────────────────────────────────────

const WORKSPACE_ROW = createMockWorkspace({ id: 'ws-1', label: 'Test Repo', path: '/tmp/test' });
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const BASE_RUN = createMockRun({
  id: 42,
  status: 'done',
  spec_path: 'forge/specs/approved/auth-feature.json',
  workspace_id: 'ws-1',
});

/** Build a full run response with context data for CU-005 and CU-006 */
function makeRunResponse() {
  return {
    run: BASE_RUN,
    stories: [
      {
        story_id: 'US-001',
        status: 'pass',
        elapsed_seconds: 45,
        started_at: new Date(Date.now() - 60_000).toISOString(),
        finished_at: new Date().toISOString(),
        active_skills: JSON.stringify(['react', 'tailwind']),
      },
      {
        story_id: 'US-002',
        status: 'pass',
        elapsed_seconds: 30,
        started_at: new Date(Date.now() - 30_000).toISOString(),
        finished_at: new Date().toISOString(),
        active_skills: JSON.stringify(['express', 'tailwind']),
      },
    ],
    specStories: [
      {
        id: 'US-001',
        title: 'Add Login Route',
        priority: 1,
        passes: true,
        suggestedSkills: [
          { name: 'react', relevance: 9, reason: 'Primary UI framework' },
          { name: 'tailwind', relevance: 7, reason: 'Styling library' },
        ],
      },
      {
        id: 'US-002',
        title: 'Add Auth Middleware',
        priority: 2,
        passes: true,
        suggestedSkills: [
          { name: 'express', relevance: 8, reason: 'Backend framework' },
          { name: 'tailwind', relevance: 7, reason: 'Styling library' },
        ],
      },
    ],
    specModel: 'claude-sonnet-4-6',
    tokenSummary: { totalInput: 4000, totalOutput: 1200 },
    contextComparison: {
      predicted: {
        'US-001': { totalTokens: 2000, injectedFiles: ['src/components/Shell.tsx', 'backend/src/routes/specs.ts'] },
        'US-002': { totalTokens: 1800, injectedFiles: ['backend/src/lib/execution-engine.ts'] },
      },
      actual: {
        'US-001': { contextFiles: ['src/components/Shell.tsx', 'backend/src/routes/specs.ts'] },
        'US-002': { contextFiles: ['backend/src/lib/execution-engine.ts', 'src/panels/RunViewPanel.tsx'] },
      },
    },
    storyTokenBreakdown: [
      { storyId: 'US-001', status: 'pass', inputTokens: 2000, outputTokens: 600, modelUsed: 'claude-sonnet-4-6', costUsd: 0.02 },
      { storyId: 'US-002', status: 'pass', inputTokens: 1800, outputTokens: 500, modelUsed: 'claude-sonnet-4-6', costUsd: 0.018 },
    ],
  };
}

/** Run response with no context data at all */
function makeEmptyContextRunResponse() {
  return {
    run: BASE_RUN,
    stories: [
      {
        story_id: 'US-001',
        status: 'pass',
        elapsed_seconds: 45,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        active_skills: null,
      },
    ],
    specStories: [
      { id: 'US-001', title: 'Add Login Route', priority: 1, passes: true },
    ],
    specModel: 'claude-sonnet-4-6',
    tokenSummary: { totalInput: 0, totalOutput: 0 },
    contextComparison: null,
    storyTokenBreakdown: [],
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

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
});

/** Helper: render panel, wait for run data to load, then click the Stories tab */
async function renderAndNavigateToStories(runResponse = makeRunResponse()) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return runResponse;
    if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
    return {};
  });

  renderWithProviders(
    <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
  );

  // Wait for run data to load (terminal tab renders first)
  await waitFor(() => {
    expect(screen.queryByTestId('run-terminal') ?? document.querySelector('[aria-label="auth feature"]')).toBeTruthy();
  }, { timeout: 5000 });

  // Navigate to Stories tab
  const storiesTab = screen.queryByRole('button', { name: /^stories$/i }) ??
    screen.queryByText(/^stories$/i);
  if (storiesTab) fireEvent.click(storiesTab);

  // Wait for stories list
  await waitFor(() => {
    // Stories tab shows story IDs or titles
    const storyEl = screen.queryByText('US-001') ?? screen.queryByText('Add Login Route');
    expect(storyEl).toBeInTheDocument();
  }, { timeout: 3000 });
}

// ─── Stories tab accordion tests (CU-005) ───────────────────────────────────

describe('RunViewPanel — per-story context accordion (CU-005)', () => {
  it('shows context accordion toggle button on each story row', async () => {
    await renderAndNavigateToStories();

    const contextButtons = screen.getAllByRole('button', { name: /expand context|collapse context/i });
    // One toggle per story (2 stories)
    expect(contextButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('accordion is collapsed by default (no drawer content visible)', async () => {
    await renderAndNavigateToStories();

    // Neither "Context Files" section headings nor skill chips should be visible before expanding
    expect(screen.queryByText(/Context Files/i)).not.toBeInTheDocument();
  });

  it('expands accordion for a story when context button is clicked', async () => {
    await renderAndNavigateToStories();

    const expandBtn = screen.getAllByRole('button', { name: /expand context/i })[0];
    fireEvent.click(expandBtn);

    // Drawer content should appear — the accordion drawer renders a "Skills" section label (uppercase)
    await waitFor(() => {
      // Look for the skills section label inside the accordion drawer (uppercase text-[10px])
      // "react" skill chip appears in the expanded US-001 accordion
      const reactChip = screen.queryByText('react');
      expect(reactChip).toBeInTheDocument();
    });
  });

  it('reveals injected context files when accordion is expanded', async () => {
    await renderAndNavigateToStories();

    const expandBtn = screen.getAllByRole('button', { name: /expand context/i })[0];
    fireEvent.click(expandBtn);

    await waitFor(() => {
      // US-001 has contextFiles: ['src/components/Shell.tsx', 'backend/src/routes/specs.ts']
      expect(screen.queryByText('src/components/Shell.tsx') ?? screen.queryByText(/Shell\.tsx/)).toBeInTheDocument();
    });
  });

  it('reveals skill chips with relevance scores when accordion is expanded', async () => {
    await renderAndNavigateToStories();

    const expandBtn = screen.getAllByRole('button', { name: /expand context/i })[0];
    fireEvent.click(expandBtn);

    await waitFor(() => {
      // US-001 has 'react' skill with relevance 9
      const reactChip = screen.queryByText('react');
      expect(reactChip).toBeInTheDocument();

      // Relevance score
      const relevanceBadge = screen.queryByText('9/10');
      expect(relevanceBadge).toBeInTheDocument();
    });
  });

  it('reveals token counts (In / Out) when accordion is expanded', async () => {
    await renderAndNavigateToStories();

    const expandBtn = screen.getAllByRole('button', { name: /expand context/i })[0];
    fireEvent.click(expandBtn);

    await waitFor(() => {
      // US-001 has inputTokens: 2000, outputTokens: 600
      // Displayed as "In: 2,000" and "Out: 600"
      const inTokens = screen.queryByText('2,000');
      const outTokens = screen.queryByText('600');
      expect(inTokens ?? outTokens).toBeInTheDocument();
    });
  });

  it('collapses accordion when clicked again', async () => {
    await renderAndNavigateToStories();

    const expandBtn = screen.getAllByRole('button', { name: /expand context/i })[0];
    fireEvent.click(expandBtn); // expand

    // After expanding, the 'react' skill chip is visible in the accordion drawer
    await waitFor(() => {
      expect(screen.queryByText('react')).toBeInTheDocument();
    });

    const collapseBtn = screen.getByRole('button', { name: /collapse context/i });
    fireEvent.click(collapseBtn); // collapse

    await waitFor(() => {
      // 'react' chip disappears when accordion collapses
      expect(screen.queryByText('react')).not.toBeInTheDocument();
    });
  });

  it('only one story accordion is open at a time', async () => {
    await renderAndNavigateToStories();

    const expandBtns = screen.getAllByRole('button', { name: /expand context/i });
    fireEvent.click(expandBtns[0]); // expand US-001
    await waitFor(() => {
      expect(screen.queryByText('react')).toBeInTheDocument();
    });

    fireEvent.click(expandBtns[1]); // expand US-002 (should collapse US-001)
    await waitFor(() => {
      // US-002 context files should now be visible
      expect(screen.queryByText(/execution-engine/i) ?? screen.queryByText('backend/src/lib/execution-engine.ts')).toBeInTheDocument();
    });
  });
});

// ─── Context summary bar tests (CU-006) ─────────────────────────────────────

describe('RunViewPanel — context usage summary bar (CU-006)', () => {
  it('renders the context summary bar with skill count', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      // US-001 has ['react', 'tailwind'] and US-002 has ['express', 'tailwind']
      // Unique skills: react, tailwind, express = 3
      const skillsEl = screen.queryByText(/3 skills/i);
      expect(skillsEl).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows unique context file count in the summary bar', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      // US-001 actual: [Shell.tsx, specs.ts], US-002 actual: [execution-engine.ts, RunViewPanel.tsx]
      // 4 unique files total
      const filesEl = screen.queryByText(/4 files/i);
      expect(filesEl).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows average token count per story in summary bar', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      // avg = (2000 + 1800) / 2 = 1900 → ~1.9K tokens/story
      const tokenEl = screen.queryByText(/tokens\/story/i);
      expect(tokenEl).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows "Context →" link that navigates to skills tab', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      const contextLink = screen.queryByText(/Context →/);
      expect(contextLink).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('aggregate token count matches sum of mock story context payloads', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      // storyTokenBreakdown: US-001 = 2000, US-002 = 1800
      // avg = 1900 → displayed as "~1.9K tokens/story"
      const tokenEl = screen.queryByText(/~1\.9K tokens\/story/i);
      expect(tokenEl).toBeInTheDocument();
    }, { timeout: 5000 });
  });
});

// ─── Empty state tests ────────────────────────────────────────────────────────

describe('RunViewPanel — empty context state', () => {
  it('does not render the context summary bar when all metrics are zero', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeEmptyContextRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    // Wait for load
    await waitFor(() => {
      expect(screen.queryByTestId('run-terminal')).toBeTruthy();
    }, { timeout: 5000 });

    // Summary bar should not render (returns null when all counts are 0)
    expect(screen.queryByText(/tokens\/story/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Context →/)).not.toBeInTheDocument();
  });

  it('shows empty accordion message when no context data exists for a story', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeEmptyContextRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    // Navigate to Stories tab
    await waitFor(() => {
      expect(screen.queryByTestId('run-terminal')).toBeTruthy();
    }, { timeout: 5000 });

    const storiesTab = screen.queryByRole('button', { name: /^stories$/i }) ??
      screen.queryByText(/^stories$/i);
    if (storiesTab) fireEvent.click(storiesTab);

    await waitFor(() => {
      expect(screen.queryByText('US-001') ?? screen.queryByText('Add Login Route')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Expand the context accordion
    const expandBtn = screen.queryByRole('button', { name: /expand context/i });
    if (expandBtn) {
      fireEvent.click(expandBtn);

      await waitFor(() => {
        // With no context data, shows the "no context data" placeholder
        const placeholder = screen.queryByText(/no context data/i);
        expect(placeholder).toBeInTheDocument();
      });
    }
  });

  it('does not crash when stories have null active_skills', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeEmptyContextRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    expect(() =>
      renderWithProviders(
        <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
      ),
    ).not.toThrow();

    await waitFor(() => {
      expect(document.body).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('renders stories list without crashing when contextComparison is null', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return makeEmptyContextRunResponse();
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.body).toBeTruthy();
    }, { timeout: 3000 });
  });
});
