import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextSummaryCard from '../../components/ContextSummaryCard';
import type { ContextSummary } from '../SpecForgeOutput';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FULL_SUMMARY: ContextSummary = {
  directionLayers: {
    l1: true,
    l2: { present: true, domain: 'saas' },
    l3: true,
  },
  skills: ['react', 'tailwind', 'prisma'],
  memoryEntries: 5,
  agentsMd: true,
  template: 'saas-starter',
  schemaSnapshot: true,
  gitMemory: true,
  estimatedTokens: 12000,
  modelContextWindow: 200000,
  retrieval: {
    cagHits: 3,
    ragHits: 2,
    graphHits: 1,
    tier: 'hybrid',
    latencyMs: 42,
  },
};

const EMPTY_SUMMARY: ContextSummary = {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Expands the card by clicking the toggle button. */
function expandCard() {
  fireEvent.click(screen.getByRole('button', { name: /context injected/i }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContextSummaryCard', () => {
  describe('visibility — card is above the fold when generated', () => {
    it('renders the card header without crashing', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expect(screen.getByRole('button', { name: /context injected/i })).toBeInTheDocument();
    });

    it('is expanded by default when isGenerating=true (above the fold, not collapsed)', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} isGenerating />);
      // When expanded, direction layer content is visible without interaction
      expect(screen.getByLabelText('L1: present')).toBeInTheDocument();
    });

    it('is collapsed by default when isGenerating is not set', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      // Expanded direction layer titles should not be visible yet
      expect(screen.queryByText('L1 Standards')).not.toBeInTheDocument();
    });
  });

  describe('direction layers — presence and labels', () => {
    it('shows L1, L2, L3 inline badges when collapsed', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      // Collapsed state shows inline status badges
      expect(screen.getByLabelText('L1: present')).toBeInTheDocument();
      expect(screen.getByLabelText('L2: present')).toBeInTheDocument();
      expect(screen.getByLabelText('L3: present')).toBeInTheDocument();
    });

    it('shows full direction layer labels when expanded', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      expect(screen.getByLabelText('L1: present')).toBeInTheDocument();
      expect(screen.getByLabelText('L2: present')).toBeInTheDocument();
      expect(screen.getByLabelText('L3: present')).toBeInTheDocument();
      expect(screen.getByText('L1 Standards')).toBeInTheDocument();
      expect(screen.getByText('L2 saas')).toBeInTheDocument();
      expect(screen.getByText('L3 Project')).toBeInTheDocument();
    });

    it('shows L2 domain label when domain is set', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      // L2 saas domain — rendered as "L2 saas"
      const l2Badge = screen.getByText('L2 saas');
      expect(l2Badge).toBeInTheDocument();
    });

    it('shows "missing" aria label for absent direction layers', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expect(screen.getByLabelText('L1: missing')).toBeInTheDocument();
      expect(screen.getByLabelText('L2: missing')).toBeInTheDocument();
      expect(screen.getByLabelText('L3: missing')).toBeInTheDocument();
    });

    it('shows all three absent layers as missing when expanded with empty data', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expandCard();
      expect(screen.getByLabelText('L1 Standards: missing')).toBeInTheDocument();
      expect(screen.getByLabelText('L2 Conventions: missing')).toBeInTheDocument();
      expect(screen.getByLabelText('L3 Project: missing')).toBeInTheDocument();
    });
  });

  describe('skills — names and count', () => {
    it('shows skill count badge when collapsed', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expect(screen.getByText(/3 skills/i)).toBeInTheDocument();
    });

    it('shows all skill names when expanded', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      expect(screen.getByText(/react/i)).toBeInTheDocument();
      expect(screen.getByText(/tailwind/i)).toBeInTheDocument();
      expect(screen.getByText(/prisma/i)).toBeInTheDocument();
    });

    it('shows skill presence indicator when expanded', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      // Skills section shows count indicator
      expect(screen.getByText(/skills/i)).toBeInTheDocument();
      expect(screen.getByText('✓ 3')).toBeInTheDocument();
    });

    it('does not show skill count badge when no skills', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expect(screen.queryByText(/skill/i)).not.toBeInTheDocument();
    });

    it('shows "—" for skills when no skills are present (expanded)', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expandCard();
      const skillsSection = screen.getByText(/^Skills$/i).closest('span')?.parentElement;
      expect(skillsSection).toBeInTheDocument();
    });
  });

  describe('token usage bar', () => {
    it('renders the token usage progress bar when expanded', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      const bar = screen.getByRole('progressbar');
      expect(bar).toBeInTheDocument();
      expect(bar).toHaveAttribute('aria-label', 'Token usage: 6%');
    });

    it('shows token count in K format when expanded', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      // 12000 tokens = 12.0K out of 200K
      expect(screen.getByText(/12\.0K/)).toBeInTheDocument();
    });

    it('renders token bar with zero tokens without crashing', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expandCard();
      const bar = screen.getByRole('progressbar');
      expect(bar).toBeInTheDocument();
      expect(bar).toHaveAttribute('aria-valuenow', '0');
    });

    it('shows warning color for high token usage (>50%)', () => {
      const highUsageSummary: ContextSummary = {
        ...FULL_SUMMARY,
        estimatedTokens: 120000, // 60% of 200K
      };
      render(<ContextSummaryCard summary={highUsageSummary} />);
      expandCard();
      expect(screen.getByText(/high context usage/i)).toBeInTheDocument();
    });

    it('shows error color for critical token usage (>80%)', () => {
      const criticalUsageSummary: ContextSummary = {
        ...FULL_SUMMARY,
        estimatedTokens: 170000, // 85% of 200K
      };
      render(<ContextSummaryCard summary={criticalUsageSummary} />);
      expandCard();
      expect(screen.getByText(/context near limit/i)).toBeInTheDocument();
    });
  });

  describe('context files section', () => {
    it('shows AGENTS.md checkmark when agentsMd is true', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      expect(screen.getByText(/AGENTS\.md ✓/)).toBeInTheDocument();
    });

    it('shows Schema checkmark when schemaSnapshot is true', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      expect(screen.getByText(/Schema ✓/)).toBeInTheDocument();
    });

    it('shows Git Memory checkmark when gitMemory is true', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      expect(screen.getByText(/Git Memory ✓/)).toBeInTheDocument();
    });

    it('shows dashes for absent context files', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expandCard();
      expect(screen.getByText(/AGENTS\.md —/)).toBeInTheDocument();
      expect(screen.getByText(/Schema —/)).toBeInTheDocument();
      expect(screen.getByText(/Git Memory —/)).toBeInTheDocument();
    });
  });

  describe('empty state — graceful rendering with no data', () => {
    it('renders without crashing when all fields are empty/false', () => {
      expect(() => render(<ContextSummaryCard summary={EMPTY_SUMMARY} />)).not.toThrow();
    });

    it('renders toggle button even with empty summary', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expect(screen.getByRole('button', { name: /context injected/i })).toBeInTheDocument();
    });

    it('does not show blank white box — renders card border and header', () => {
      const { container } = render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      const card = container.querySelector('[aria-label="Spec generation context summary"]');
      expect(card).toBeInTheDocument();
      expect(card?.classList.contains('border')).toBe(true);
    });

    it('expands without crashing when empty', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expect(() => expandCard()).not.toThrow();
    });

    it('shows "— 0 entries" for memory when no memory entries', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expandCard();
      expect(screen.getByText(/— 0 entries/)).toBeInTheDocument();
    });

    it('shows "— none" for template when no template', () => {
      render(<ContextSummaryCard summary={EMPTY_SUMMARY} />);
      expandCard();
      expect(screen.getByText(/— none/)).toBeInTheDocument();
    });
  });

  describe('toggle behavior', () => {
    it('toggles expanded state on button click', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      // Initially collapsed
      expect(screen.queryByText('L1 Standards')).not.toBeInTheDocument();
      // Expand
      expandCard();
      expect(screen.getByText('L1 Standards')).toBeInTheDocument();
      // Collapse again
      expandCard();
      expect(screen.queryByText('L1 Standards')).not.toBeInTheDocument();
    });

    it('aria-expanded reflects expanded state', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      const btn = screen.getByRole('button', { name: /context injected/i });
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(btn);
      expect(btn).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('retrieval metrics', () => {
    it('shows CAG cache hits when retrieval data present', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      expect(screen.getByText(/3 hits/)).toBeInTheDocument();
    });

    it('shows retrieval tier badge', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      expect(screen.getByText('hybrid')).toBeInTheDocument();
    });

    it('shows latency when present', () => {
      render(<ContextSummaryCard summary={FULL_SUMMARY} />);
      expandCard();
      expect(screen.getByText('42ms')).toBeInTheDocument();
    });

    it('renders without retrieval data (no crash, no blank box)', () => {
      const noRetrieval: ContextSummary = {
        ...FULL_SUMMARY,
        retrieval: undefined,
        vectorHits: undefined,
        graphHits: undefined,
        retrievalTier: undefined,
        retrievalLatencyMs: undefined,
      };
      expect(() => {
        render(<ContextSummaryCard summary={noRetrieval} />);
      }).not.toThrow();
    });
  });
});
