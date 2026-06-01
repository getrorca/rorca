/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef, useCallback, useMemo, useDeferredValue } from 'react';
import { Search, ArrowRight, Clock, Command, Hammer, Trash2, Menu } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { NAV_ITEMS, type PanelId } from './Sidebar';
import { useFocusTrap } from '../hooks/useFocusTrap';

/* ─── Types ───────────────────────────────────────────────────────── */

interface CommandItem {
  id: string;
  label: string;
  category: 'panel' | 'spec' | 'run' | 'action';
  description?: string;
  shortcut?: string;
  keywords?: string[];
  group?: string;
  icon?: typeof Search;
  action: () => void;
}

interface SpecSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved';
}

interface PipelineRun {
  id: number;
  spec_path: string;
  status: string;
  started_at: string;
}

interface ArchiveSpec {
  id: string;
  specName: string;
  status: string;
  storyTitles: string[];
}

interface CommandPaletteProps {
  onNavigate: (panel: PanelId) => void;
  onClose: () => void;
  activePanel: PanelId;
  activeRunId?: number | null;
  onSendToForge?: (brief: string) => void;
}

/* ─── Fuzzy match ─────────────────────────────────────────────────── */

function fuzzyMatch(query: string, text: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring match is best
  if (t.includes(q)) {
    const idx = t.indexOf(q);
    // Prefer matches at start of string/word
    const posBonus = idx === 0 ? 100 : t[idx - 1] === ' ' ? 50 : 0;
    return { match: true, score: 200 + posBonus + (q.length / t.length) * 50 };
  }

  // Fuzzy: each query char must appear in order
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Consecutive chars score higher
      score += (lastIdx === ti - 1) ? 10 : 1;
      // Word boundary bonus
      if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '-' || t[ti - 1] === '_') {
        score += 5;
      }
      lastIdx = ti;
      qi++;
    }
  }

  if (qi === q.length) {
    return { match: true, score };
  }

  return { match: false, score: 0 };
}

const RECENT_KEY = 'rorca-cmd-palette-recent';
const MAX_RECENT = 5;

function getRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function addRecent(id: string) {
  const recent = getRecent().filter((r) => r !== id);
  recent.unshift(id);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

/* ─── Category labels ─────────────────────────────────────────────── */

const CATEGORY_LABELS: Record<CommandItem['category'], string> = {
  panel: 'Navigation',
  spec: 'Specs',
  run: 'Runs',
  action: 'Actions',
};

const CATEGORY_ORDER: CommandItem['category'][] = ['action', 'panel', 'spec', 'run'];

/** Score threshold — below this, Forge fallback appears */
const FORGE_FALLBACK_THRESHOLD = 80;

/** Context-aware boost: maps active panel/context to command IDs that should rank higher */
const CONTEXT_BOOSTS: Record<string, string[]> = {
  specs: [
    'action:new-spec', 'action:search-archive', 'action:review',
  ],
  runs: [
    'action:trigger-pipeline', 'action:view-active-run', 'panel:runs',
  ],
  'run-view': [
    'panel:runs', 'action:view-active-run', 'action:trigger-pipeline',
  ],
  analytics: [
    'panel:analytics',
  ],
  direction: [
    'action:direction', 'panel:direction',
  ],
  settings: [
    'action:workspace-settings', 'panel:settings',
  ],
};

function clearRecent() {
  localStorage.removeItem(RECENT_KEY);
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function CommandPalette({ onNavigate, onClose, activePanel, activeRunId, onSendToForge }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true);
  const { workspaceId } = useWorkspace();

  // Remote data
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [archiveSpecs, setArchiveSpecs] = useState<ArchiveSpec[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);

  // Load data on mount
  useEffect(() => {
    if (!workspaceId) return;
    const params = `workspaceId=${workspaceId}`;
    apiFetch<{ items: SpecSummary[] }>(`/api/specs?${params}`).then((r) => setSpecs(r.items)).catch(() => {});
    apiFetch<{ items: ArchiveSpec[] }>(`/api/specs/archive?${params}&limit=50`).then((r) => setArchiveSpecs(r.items)).catch(() => {});
    apiFetch<{ items: PipelineRun[] }>(`/api/pipeline/runs?${params}`).then((r) => setRuns(r.items)).catch(() => {});
  }, [workspaceId]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Build all command items
  const allItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];

    // Panel navigation
    for (const nav of NAV_ITEMS) {
      items.push({
        id: `panel:${nav.id}`,
        label: nav.label,
        category: 'panel',
        description: `Go to ${nav.label}`,
        action: () => { onNavigate(nav.id); onClose(); },
      });
    }

    // Specs (pending + approved from queue)
    for (const spec of specs) {
      items.push({
        id: `spec:${spec.id}`,
        label: spec.specName,
        category: 'spec',
        description: `${spec.status} \u00B7 ${spec.storyCount} stories`,
        action: () => { onNavigate('specs'); onClose(); },
      });
    }

    // Archive specs (deduplicate against queue specs)
    const queueIds = new Set(specs.map((s) => s.id));
    for (const spec of archiveSpecs) {
      if (queueIds.has(spec.id)) continue;
      items.push({
        id: `spec:${spec.id}`,
        label: spec.specName,
        category: 'spec',
        description: `${spec.status} \u00B7 ${spec.storyTitles.length} stories`,
        action: () => { onNavigate('specs'); onClose(); },
      });
      // Story-level entries from archive
      for (const title of spec.storyTitles) {
        items.push({
          id: `story:${spec.id}:${title}`,
          label: title,
          category: 'spec',
          description: `Story in ${spec.specName}`,
          action: () => { onNavigate('specs'); onClose(); },
        });
      }
    }

    // Story-level entries from queue specs
    for (const spec of specs) {
      const archiveMatch = archiveSpecs.find((a) => a.id === spec.id);
      if (archiveMatch) {
        for (const title of archiveMatch.storyTitles) {
          items.push({
            id: `story:${spec.id}:${title}`,
            label: title,
            category: 'spec',
            description: `Story in ${spec.specName}`,
            action: () => { onNavigate('specs'); onClose(); },
          });
        }
      }
    }

    // Pipeline runs
    for (const run of runs) {
      const specSlug = run.spec_path.replace(/.*\//, '').replace('.json', '');
      items.push({
        id: `run:${run.id}`,
        label: `Run #${run.id}`,
        category: 'run',
        description: `${specSlug} \u00B7 ${run.status}`,
        action: () => { onNavigate('runs'); onClose(); },
      });
    }

    // Actions
    items.push({
      id: 'action:toggle-drawer',
      label: 'Toggle navigation drawer',
      category: 'action',
      description: 'Show all panels',
      shortcut: '⌘\\',
      action: () => { window.dispatchEvent(new Event('rorca:toggle-drawer')); onClose(); },
    });
    items.push({
      id: 'action:open-execution-trace',
      label: 'Open Execution Trace',
      category: 'action',
      description: 'View run logs for the selected run',
      icon: Search,
      keywords: ['execution trace', 'run logs', 'pipeline output', 'stdout', 'stderr'],
      group: 'Runs',
      action: () => { onNavigate('runs'); onClose(); },
    });
    items.push({
      id: 'action:new-spec',
      label: 'New Spec',
      category: 'action',
      description: 'Create a new spec',
      shortcut: '⌘N',
      action: () => { onSendToForge?.(''); onNavigate('specs'); onClose(); },
    });
    items.push({
      id: 'action:trigger-pipeline',
      label: 'Trigger Pipeline Run',
      category: 'action',
      description: 'Open Runs to start a new run',
      shortcut: '⌘⇧R',
      action: () => { onNavigate('runs'); onClose(); },
    });
    items.push({
      id: 'action:view-active-run',
      label: 'View Active Run',
      category: 'action',
      description: runs.find((r) => r.status === 'running') ? `Run #${runs.find((r) => r.status === 'running')!.id} in progress` : 'Navigate to Runs',
      action: () => { onNavigate('runs'); onClose(); },
    });
    items.push({
      id: 'action:search-archive',
      label: 'Search Specs',
      category: 'action',
      description: 'Find specs and stories',
      action: () => {
        onNavigate('specs');
        onClose();
        setTimeout(() => {
          const searchInput = document.querySelector<HTMLInputElement>('[data-archive-search]');
          searchInput?.focus();
        }, 100);
      },
    });
    items.push({
      id: 'action:direction',
      label: 'Edit Direction',
      category: 'action',
      description: 'Configure direction layers',
      action: () => { onNavigate('direction'); onClose(); },
    });
    items.push({
      id: 'action:review',
      label: 'Review Pending Specs',
      category: 'action',
      description: 'View pending specs',
      action: () => { onNavigate('specs'); onClose(); },
    });
    items.push({
      id: 'action:worktrees',
      label: 'Manage Worktrees',
      category: 'action',
      description: 'View and merge git worktrees',
      action: () => { onNavigate('runs'); onClose(); },
    });
    items.push({
      id: 'action:workspace-settings',
      label: 'Workspace Settings',
      category: 'action',
      description: 'Configure workspace, environment variables, and hooks',
      action: () => { onNavigate('settings'); onClose(); },
    });
    items.push({
      id: 'action:approve-all',
      label: 'Approve All Drafts',
      category: 'action',
      description: `Approve all ${specs.filter(s => s.status === 'pending').length} pending specs`,
      action: () => {
        const pending = specs.filter(s => s.status === 'pending');
        if (pending.length === 0) return;
        Promise.all(pending.map(s =>
          apiFetch(`/api/specs/${encodeURIComponent(s.id)}/approve`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId }),
          }).catch(() => {})
        ));
        onNavigate('specs');
        onClose();
      },
    });

    return items;
  }, [specs, archiveSpecs, runs, onNavigate, onClose, workspaceId]);

  // Determine context key for boosting
  const contextKey = activeRunId != null ? 'run-view' : activePanel;
  const boostIds = CONTEXT_BOOSTS[contextKey] ?? [];

  // Filter and rank results (uses deferred query to keep input responsive)
  const { items: results, topScore } = useMemo(() => {
    if (!deferredQuery.trim()) {
      // Show drawer toggle first, then recents, then context-boosted, then remaining actions/panels
      const drawerItem = allItems.find((item) => item.id === 'action:toggle-drawer');
      const pinnedIds = new Set(drawerItem ? ['action:toggle-drawer'] : []);

      const recent = getRecent();
      const recentItems = recent
        .map((id) => allItems.find((item) => item.id === id))
        .filter((item): item is CommandItem => !!item && !pinnedIds.has(item.id));

      const recentIds = new Set(recent);
      const boostedItems = boostIds
        .map((id) => allItems.find((item) => item.id === id))
        .filter((item): item is CommandItem => !!item && !recentIds.has(item.id) && !pinnedIds.has(item.id));

      const usedIds = new Set([...recent, ...boostIds, ...pinnedIds]);
      const otherItems = allItems
        .filter((item) => !usedIds.has(item.id) && (item.category === 'action' || item.category === 'panel'))
        .slice(0, 10 - boostedItems.length);

      return { items: [...(drawerItem ? [drawerItem] : []), ...recentItems, ...boostedItems, ...otherItems], topScore: Infinity };
    }

    const scored = allItems
      .map((item) => {
        const labelMatch = fuzzyMatch(deferredQuery, item.label);
        const descMatch = item.description ? fuzzyMatch(deferredQuery, item.description) : { match: false, score: 0 };
        const idMatch = fuzzyMatch(deferredQuery, item.id);
        const keywordMatch = item.keywords
          ? Math.max(...item.keywords.map((keyword) => fuzzyMatch(deferredQuery, keyword).score), 0)
          : 0;
        let bestScore = Math.max(labelMatch.score, descMatch.score * 0.7, idMatch.score * 0.5, keywordMatch * 0.8);
        // Context boost: +30 for items relevant to current screen
        if (boostIds.includes(item.id)) bestScore += 30;
        return { item, match: labelMatch.match || descMatch.match || idMatch.match || keywordMatch > 0, score: bestScore };
      })
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    return {
      items: scored.map((r) => r.item),
      topScore: scored.length > 0 ? scored[0].score : 0,
    };
  }, [deferredQuery, allItems, boostIds]);

  // Forge fallback: appears when query has 2+ words and no strong match
  const trimmedQuery = query.trim();
  const wordCount = trimmedQuery ? trimmedQuery.split(/\s+/).length : 0;
  const showForgeFallback = trimmedQuery.length > 0 && wordCount >= 2 && topScore < FORGE_FALLBACK_THRESHOLD;

  const forgeFallbackItem: CommandItem | null = showForgeFallback ? {
    id: 'forge-fallback',
    label: `Send to Forge as brief`,
    category: 'action',
    description: trimmedQuery,
    action: () => {
      onSendToForge?.(trimmedQuery);
      onNavigate('specs');
      onClose();
    },
  } : null;

  // Clear history item: shown at bottom when input is empty and recents exist
  const showClearHistory = !trimmedQuery && getRecent().length > 0;
  const clearHistoryItem: CommandItem | null = showClearHistory ? {
    id: 'clear-history',
    label: 'Clear history',
    category: 'action',
    description: 'Remove all recent commands',
    action: () => {
      clearRecent();
      // Force re-render by toggling query
      setQuery(' ');
      setTimeout(() => setQuery(''), 0);
    },
  } : null;

  // Final display list
  const displayResults = useMemo(() => {
    const items: CommandItem[] = [];
    if (forgeFallbackItem) items.push(forgeFallbackItem);
    items.push(...results);
    if (clearHistoryItem) items.push(clearHistoryItem);
    return items;
  }, [results, showForgeFallback, trimmedQuery, showClearHistory]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIdx(showForgeFallback ? 0 : 0);
  }, [displayResults.length, query, showForgeFallback]);

  // Execute selected item
  const executeItem = useCallback((item: CommandItem) => {
    // Don't track meta-items in recents
    if (item.id !== 'forge-fallback' && item.id !== 'clear-history') {
      addRecent(item.id);
    }
    item.action();
  }, []);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, displayResults.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && displayResults.length > 0) {
        e.preventDefault();
        executeItem(displayResults[selectedIdx]);
        return;
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [displayResults, selectedIdx, executeItem, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const buttons = list.querySelectorAll('button');
    const selected = buttons[selectedIdx] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // Group results by category for display
  const grouped = useMemo(() => {
    type GroupLabel = 'Recent' | 'Suggestions' | 'Forge' | 'Clear' | string;
    const groups: { label: GroupLabel; items: CommandItem[] }[] = [];

    // If no query, show as flat list (recents + suggestions + clear)
    if (!query.trim()) {
      const recentIds = new Set(getRecent());
      const recentItems = results.filter((r) => recentIds.has(r.id));
      const otherItems = results.filter((r) => !recentIds.has(r.id));

      if (recentItems.length > 0) {
        groups.push({ label: 'Recent', items: recentItems });
      }
      if (otherItems.length > 0) {
        groups.push({ label: 'Suggestions', items: otherItems });
      }
      if (clearHistoryItem) {
        groups.push({ label: 'Clear', items: [clearHistoryItem] });
      }
      return groups;
    }

    // With query: forge fallback first, then grouped by category
    if (forgeFallbackItem) {
      groups.push({ label: 'Forge', items: [forgeFallbackItem] });
    }

    const byCategory = new Map<CommandItem['category'], CommandItem[]>();
    for (const item of results) {
      let arr = byCategory.get(item.category);
      if (!arr) {
        arr = [];
        byCategory.set(item.category, arr);
      }
      arr.push(item);
    }

    for (const cat of CATEGORY_ORDER) {
      const items = byCategory.get(cat);
      if (items && items.length > 0) {
        groups.push({ label: CATEGORY_LABELS[cat], items });
      }
    }
    return groups;
  }, [displayResults, query]);

  // Flat index counter for keyboard navigation
  let flatIdx = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        ref={trapRef}
        className="bg-panel border border-border rounded-lg shadow-xl w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search specs, stories, runs, actions..."
            aria-label="Search command palette"
            className="flex-1 bg-transparent text-sm text-text placeholder:text-muted focus:outline-none"
          />
          <kbd className="text-[10px] text-muted bg-bg border border-border rounded px-1.5 py-0.5 font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {displayResults.length === 0 && (
            <div className="px-4 py-8 text-center text-muted text-sm">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {grouped.map((group) => (
            <div key={group.label}>
              {group.label !== 'Clear' && (
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {group.label}
                </div>
              )}
              {group.items.map((item) => {
                const currentIdx = flatIdx++;
                const isSelected = currentIdx === selectedIdx;
                const recentIds = getRecent();
                const isRecent = recentIds.includes(item.id);
                const isForgeFallback = item.id === 'forge-fallback';
                const isClearHistory = item.id === 'clear-history';

                return (
                  <button
                    key={item.id}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                      isClearHistory ? 'border-t border-border' : ''
                    } ${
                      isSelected ? 'bg-accent/10 text-text' : 'text-text hover:bg-bg'
                    }`}
                    onClick={() => executeItem(item)}
                    onMouseEnter={() => setSelectedIdx(currentIdx)}
                  >
                    {isForgeFallback ? (
                      <Hammer size={14} className="text-accent shrink-0" />
                    ) : isClearHistory ? (
                      <Trash2 size={14} className="text-muted shrink-0" />
                    ) : item.id === 'action:toggle-drawer' ? (
                      <Menu size={14} className="text-muted shrink-0" />
                    ) : isRecent && !query.trim() ? (
                      <Clock size={14} className="text-muted shrink-0" />
                    ) : (
                      <ArrowRight size={14} className="text-muted shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm truncate ${isForgeFallback ? 'text-accent' : ''}`}>
                        {isForgeFallback ? `\u2192 ${item.label}` : item.label}
                      </div>
                      {item.description && (
                        <div className={`text-xs truncate ${isForgeFallback ? 'text-muted/70 italic' : 'text-muted'}`}>
                          {item.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {item.shortcut && !isSelected && (
                        <kbd className="text-[10px] text-muted bg-bg border border-border rounded px-1.5 py-0.5 font-mono">
                          {item.shortcut}
                        </kbd>
                      )}
                      {isSelected && (
                        <kbd className="text-[10px] text-muted bg-bg border border-border rounded px-1.5 py-0.5 font-mono">
                          Enter
                        </kbd>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-[10px] text-muted">
          <span className="flex items-center gap-1">
            <kbd className="bg-bg border border-border rounded px-1 py-0.5 font-mono">&uarr;&darr;</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-bg border border-border rounded px-1 py-0.5 font-mono">&crarr;</kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-bg border border-border rounded px-1 py-0.5 font-mono">esc</kbd>
            close
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Command size={10} />
            <span>K</span>
          </span>
        </div>
      </div>
    </div>
  );
}
