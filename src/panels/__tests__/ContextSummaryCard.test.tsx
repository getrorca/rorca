import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextSummaryCard from '../../components/ContextSummaryCard';
import type { ContextSummary } from '../SpecForgeOutput';

// ─── Mock data helpers ──────────────────────────────────────────────────────

function makeFullSummary(): ContextSummary {
  return {
    directionLayers: {
      l1: true,
      l1Title: 'Engineering Standards',
      l1Tokens: 1200,
      l2: { present: true, domain: 'saas' },
      l2Title: 'SaaS Conventions',
      l2Tokens: 800,
      l3: true,
      l3Title: 'Rorca Project',
      l3Tokens: 3500,
    },
    skills: ['react', 'tailwind', 'express'],
    memoryEntries: 5,
    agentsMd: true,
    template: null,
    schemaSnapshot: true,
    gitMemory: true,
    estimatedTokens: 12000,
    modelContextWindow: 200000,
    retrieval: {
      cagHits: 3,
      ragHits: 2,
      graphHits: 1,
      tier: 'hybrid',
      latencyMs: 80,
    },
    predictedFiles: [
      'src/components/Shell.tsx',
      'src/panels/RunViewPanel.tsx',
      'backend/src/routes/specs.ts',
    ],
  };
}

function makeEmptySummary(): ContextSummary {
  return {
    directionLayers: {
      l1: false,
      l2: { present: false, domain: null },
      l3: false,
    },
    skills: [],
    memoryEntries: 0,
    agentsMd: false,
    template: null,
    schemaSnapshot: false,
    gitMemory: false,
    estimatedTokens: 0,
    modelContextWindow: 200000,
  };
}

/** Render card and expand it */
function renderExpanded(summary: ContextSummary, skillDetails?: Array<{ name: string; relevance?: number; reason?: string }>) {
  render(<ContextSummaryCard summary={summary} skillDetails={skillDetails} />);
  // Default state is collapsed — click header to expand
  const header = screen.getByRole('button', { name: /context injected/i });
  fireEvent.click(header);
  return header;
}

// ─── Happy path tests ────────────────────────────────────────────────────────

describe('ContextSummaryCard — happy path', () => {
  it('renders the collapsible header above the fold', () => {
    render(<ContextSummaryCard summary={makeFullSummary()} />);
    // Header button is always visible regardless of expansion state
    const header = screen.getByRole('button', { name: /context injected/i });
    expect(header).toBeInTheDocument();
    // The outer container has aria-label for identification
    const card = document.querySelector('[aria-label="Spec generation context summary"]');
    expect(card).toBeInTheDocument();
  });

  it('expands to show direction layer badges when header is clicked', () => {
    renderExpanded(makeFullSummary());
    // When expanded, direction layer StatusBadge elements appear in expanded section
    // They render with aria-label "L1: present", "L2: present", "L3: present"
    const l1 = document.querySelector('[aria-label="L1: present"]');
    const l2 = document.querySelector('[aria-label="L2: present"]');
    const l3 = document.querySelector('[aria-label="L3: present"]');
    expect(l1).toBeInTheDocument();
    expect(l2).toBeInTheDocument();
    expect(l3).toBeInTheDocument();
  });

  it('shows direction layer titles in expanded section', () => {
    renderExpanded(makeFullSummary());
    // StatusBadge renders "L1 Engineering Standards" (label + title) in text
    expect(screen.getByText(/Engineering Standards/)).toBeInTheDocument();
    expect(screen.getByText(/SaaS Conventions/)).toBeInTheDocument();
    expect(screen.getByText(/Rorca Project/)).toBeInTheDocument();
  });

  it('shows direction layer token counts in expanded section', () => {
    renderExpanded(makeFullSummary());
    // Token counts: 1200 → "1.2K tok", 800 → "800 tok", 3500 → "3.5K tok"
    expect(screen.getByText('1.2K tok')).toBeInTheDocument();
    expect(screen.getByText('800 tok')).toBeInTheDocument();
    expect(screen.getByText('3.5K tok')).toBeInTheDocument();
  });

  it('shows skill chip names when skillDetails are provided', () => {
    const skillDetails = [
      { name: 'react', relevance: 9, reason: 'Primary UI framework' },
      { name: 'tailwind', relevance: 6, reason: 'Styling library' },
      { name: 'express', relevance: 4, reason: 'Backend framework' },
    ];
    renderExpanded(makeFullSummary(), skillDetails);
    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.getByText('tailwind')).toBeInTheDocument();
    expect(screen.getByText('express')).toBeInTheDocument();
  });

  it('shows skill relevance scores when skillDetails are provided', () => {
    const skillDetails = [
      { name: 'react', relevance: 9 },
      { name: 'tailwind', relevance: 6 },
      { name: 'express', relevance: 4 },
    ];
    renderExpanded(makeFullSummary(), skillDetails);
    // Relevance scores appear as text inside badges
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('shows files drawer toggle button with count when predictedFiles is set', () => {
    renderExpanded(makeFullSummary());
    // "Context Files (3)" toggle button is rendered
    const filesToggle = screen.getByRole('button', { name: /context files/i });
    expect(filesToggle).toBeInTheDocument();
    expect(filesToggle.textContent).toContain('3');
  });

  it('renders predicted file names after expanding the files drawer', () => {
    renderExpanded(makeFullSummary());
    fireEvent.click(screen.getByRole('button', { name: /context files/i }));
    expect(screen.getByText('src/components/Shell.tsx')).toBeInTheDocument();
    expect(screen.getByText('src/panels/RunViewPanel.tsx')).toBeInTheDocument();
    expect(screen.getByText('backend/src/routes/specs.ts')).toBeInTheDocument();
  });

  it('renders token usage progress bar when expanded', () => {
    renderExpanded(makeFullSummary());
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toBeInTheDocument();
    // 12000/200000 = 6%
    expect(progressbar).toHaveAttribute('aria-valuenow', '6');
  });

  it('starts in expanded state when isGenerating=true', () => {
    render(<ContextSummaryCard summary={makeFullSummary()} isGenerating />);
    // When isGenerating, the component starts expanded — layer badges should be visible immediately
    const l1 = document.querySelector('[aria-label="L1: present"]');
    expect(l1).toBeInTheDocument();
  });
});

// ─── Empty state tests ───────────────────────────────────────────────────────

describe('ContextSummaryCard — empty state', () => {
  it('does not crash with no direction layers, no skills, and no files', () => {
    expect(() => render(<ContextSummaryCard summary={makeEmptySummary()} />)).not.toThrow();
  });

  it('renders the header button even when all data is empty', () => {
    render(<ContextSummaryCard summary={makeEmptySummary()} />);
    expect(screen.getByRole('button', { name: /context injected/i })).toBeInTheDocument();
  });

  it('shows missing badges for L1, L2, L3 when layers are absent', () => {
    renderExpanded(makeEmptySummary());
    // StatusBadge renders aria-label="L1 Standards: missing" etc
    const l1 = document.querySelector('[aria-label="L1 Standards: missing"]');
    const l2 = document.querySelector('[aria-label="L2 Conventions: missing"]');
    const l3 = document.querySelector('[aria-label="L3 Project: missing"]');
    expect(l1).toBeInTheDocument();
    expect(l2).toBeInTheDocument();
    expect(l3).toBeInTheDocument();
  });

  it('shows skills dash indicator when skills array is empty', () => {
    renderExpanded(makeEmptySummary());
    // The skills section still renders with a "—" indicator
    const skillLabel = document.querySelector('[class*="skills"]') ?? screen.queryByText(/Skills/);
    expect(skillLabel).toBeInTheDocument();
  });

  it('does not render the files drawer toggle when predictedFiles is absent', () => {
    renderExpanded(makeEmptySummary());
    expect(screen.queryByRole('button', { name: /context files/i })).not.toBeInTheDocument();
  });

  it('renders token progress bar at 0% without crashing', () => {
    renderExpanded(makeEmptySummary());
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toBeInTheDocument();
    expect(progressbar).toHaveAttribute('aria-valuenow', '0');
  });

  it('does not render individual skill name chips when skillDetails is empty', () => {
    render(<ContextSummaryCard summary={makeEmptySummary()} skillDetails={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /context injected/i }));
    // When skills array is empty, the skillDetails chip rendering is skipped entirely
    // No skill names should appear as chip text
    expect(screen.queryByText('react')).not.toBeInTheDocument();
    expect(screen.queryByText('tailwind')).not.toBeInTheDocument();
  });
});

// ─── Data accuracy tests ─────────────────────────────────────────────────────

describe('ContextSummaryCard — data accuracy', () => {
  it('formats token counts ≥1000 as "X.YK tok"', () => {
    renderExpanded(makeFullSummary());
    // L3 has 3500 tokens → "3.5K tok"
    expect(screen.getByText('3.5K tok')).toBeInTheDocument();
    // L1 has 1200 tokens → "1.2K tok"
    expect(screen.getByText('1.2K tok')).toBeInTheDocument();
  });

  it('displays token counts under 1000 without K suffix', () => {
    renderExpanded(makeFullSummary());
    // L2 has 800 tokens → "800 tok"
    expect(screen.getByText('800 tok')).toBeInTheDocument();
  });

  it('applies emerald color class to high-relevance skill chips (≥8)', () => {
    const skillDetails = [{ name: 'react', relevance: 9 }];
    renderExpanded(makeFullSummary(), skillDetails);
    const relevanceBadge = screen.getByText('9');
    // emerald class for high relevance
    expect(relevanceBadge.className).toMatch(/emerald/);
  });

  it('applies blue color class to medium-relevance skill chips (5-7)', () => {
    const skillDetails = [{ name: 'tailwind', relevance: 6 }];
    renderExpanded(makeFullSummary(), skillDetails);
    const relevanceBadge = screen.getByText('6');
    expect(relevanceBadge.className).toMatch(/blue/);
  });

  it('renders skill chip with title tooltip from reason field', () => {
    const skillDetails = [{ name: 'react', relevance: 9, reason: 'Primary UI framework' }];
    renderExpanded(makeFullSummary(), skillDetails);
    // The outer chip span has title="Primary UI framework"
    const chipEl = document.querySelector('[title="Primary UI framework"]');
    expect(chipEl).toBeInTheDocument();
  });

  it('shows "+N more" overflow indicator when predictedFiles exceeds 20', () => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
    const summary = { ...makeFullSummary(), predictedFiles: manyFiles };
    render(<ContextSummaryCard summary={summary} />);
    fireEvent.click(screen.getByRole('button', { name: /context injected/i }));
    fireEvent.click(screen.getByRole('button', { name: /context files/i }));
    // 25 - 20 = 5 overflow
    expect(screen.getByText('+5 more')).toBeInTheDocument();
  });

  it('shows "L2 Conventions" label when l2 is missing and domain is null', () => {
    renderExpanded(makeEmptySummary());
    // aria-label fallback: "L2 Conventions: missing"
    const l2 = document.querySelector('[aria-label="L2 Conventions: missing"]');
    expect(l2).toBeInTheDocument();
  });

  it('shows the retrieval tier badge when retrieval is provided', () => {
    renderExpanded(makeFullSummary());
    // "hybrid" tier badge appears in retrieval section
    expect(screen.getByText('hybrid')).toBeInTheDocument();
  });

  it('shows retrieval latency in milliseconds', () => {
    renderExpanded(makeFullSummary());
    expect(screen.getByText('80ms')).toBeInTheDocument();
  });
});
