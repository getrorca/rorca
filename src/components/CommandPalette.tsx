import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, ArrowRight, Clock, Command } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { NAV_ITEMS, type PanelId } from './Sidebar';

/* ─── Types ───────────────────────────────────────────────────────── */

interface CommandItem {
  id: string;
  label: string;
  category: 'panel' | 'spec' | 'run' | 'action';
  description?: string;
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
  panel: 'Navigate',
  spec: 'Specs',
  run: 'Runs',
  action: 'Actions',
};

const CATEGORY_ORDER: CommandItem['category'][] = ['action', 'panel', 'spec', 'run'];

/* ─── Component ───────────────────────────────────────────────────── */

export default function CommandPalette({ onNavigate, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
        action: () => {
          onNavigate(spec.status === 'pending' ? 'queue' : 'archive');
          onClose();
        },
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
        action: () => { onNavigate('archive'); onClose(); },
      });
      // Story-level entries from archive
      for (const title of spec.storyTitles) {
        items.push({
          id: `story:${spec.id}:${title}`,
          label: title,
          category: 'spec',
          description: `Story in ${spec.specName}`,
          action: () => { onNavigate('archive'); onClose(); },
        });
      }
    }

    // Story-level entries from queue specs
    for (const spec of specs) {
      // We don't have story titles in SpecSummary, but the archive has them
      const archiveMatch = archiveSpecs.find((a) => a.id === spec.id);
      if (archiveMatch) {
        for (const title of archiveMatch.storyTitles) {
          items.push({
            id: `story:${spec.id}:${title}`,
            label: title,
            category: 'spec',
            description: `Story in ${spec.specName}`,
            action: () => {
              onNavigate(spec.status === 'pending' ? 'queue' : 'archive');
              onClose();
            },
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
        action: () => { onNavigate('pipeline'); onClose(); },
      });
    }

    // Actions
    items.push({
      id: 'action:new-spec',
      label: 'New Spec',
      category: 'action',
      description: 'Create a new spec in Spec Forge',
      action: () => { onNavigate('forge'); onClose(); },
    });
    items.push({
      id: 'action:direction',
      label: 'Edit Direction Stack',
      category: 'action',
      description: 'Configure direction layers',
      action: () => { onNavigate('stack'); onClose(); },
    });
    items.push({
      id: 'action:review',
      label: 'Review Pending Specs',
      category: 'action',
      description: 'Go to Review Queue',
      action: () => { onNavigate('queue'); onClose(); },
    });
    items.push({
      id: 'action:worktrees',
      label: 'Manage Worktrees',
      category: 'action',
      description: 'View and merge git worktrees',
      action: () => { onNavigate('worktrees'); onClose(); },
    });

    return items;
  }, [specs, archiveSpecs, runs, onNavigate, onClose]);

  // Filter and rank results
  const results = useMemo(() => {
    if (!query.trim()) {
      // Show recents first, then actions
      const recent = getRecent();
      const recentItems = recent
        .map((id) => allItems.find((item) => item.id === id))
        .filter((item): item is CommandItem => !!item);

      const recentIds = new Set(recent);
      const otherItems = allItems
        .filter((item) => !recentIds.has(item.id) && (item.category === 'action' || item.category === 'panel'))
        .slice(0, 10);

      return [...recentItems, ...otherItems];
    }

    return allItems
      .map((item) => {
        const labelMatch = fuzzyMatch(query, item.label);
        const descMatch = item.description ? fuzzyMatch(query, item.description) : { match: false, score: 0 };
        const idMatch = fuzzyMatch(query, item.id);
        const bestScore = Math.max(labelMatch.score, descMatch.score * 0.7, idMatch.score * 0.5);
        return { item, match: labelMatch.match || descMatch.match || idMatch.match, score: bestScore };
      })
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => r.item);
  }, [query, allItems]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIdx(0);
  }, [results.length, query]);

  // Execute selected item
  const executeItem = useCallback((item: CommandItem) => {
    addRecent(item.id);
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
        setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault();
        executeItem(results[selectedIdx]);
        return;
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [results, selectedIdx, executeItem, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIdx] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // Group results by category for display
  const grouped = useMemo(() => {
    const groups: { category: CommandItem['category']; items: CommandItem[] }[] = [];
    const byCategory = new Map<CommandItem['category'], CommandItem[]>();

    for (const item of results) {
      let arr = byCategory.get(item.category);
      if (!arr) {
        arr = [];
        byCategory.set(item.category, arr);
      }
      arr.push(item);
    }

    // If no query, show as flat list (recents + suggestions)
    if (!query.trim()) {
      const recentIds = new Set(getRecent());
      const recentItems = results.filter((r) => recentIds.has(r.id));
      const otherItems = results.filter((r) => !recentIds.has(r.id));

      if (recentItems.length > 0) {
        groups.push({ category: 'action', items: recentItems }); // labeled "Recent" below
      }
      if (otherItems.length > 0) {
        groups.push({ category: 'panel', items: otherItems }); // labeled "Suggestions"
      }
      return { groups, isRecentsMode: recentItems.length > 0 };
    }

    for (const cat of CATEGORY_ORDER) {
      const items = byCategory.get(cat);
      if (items && items.length > 0) {
        groups.push({ category: cat, items });
      }
    }
    return { groups, isRecentsMode: false };
  }, [results, query]);

  // Flat index counter for keyboard navigation
  let flatIdx = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
      onClick={onClose}
    >
      <div
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
            className="flex-1 bg-transparent text-sm text-text placeholder:text-muted focus:outline-none"
          />
          <kbd className="text-[10px] text-muted bg-bg border border-border rounded px-1.5 py-0.5 font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-4 py-8 text-center text-muted text-sm">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {grouped.groups.map((group) => {
            const groupLabel = !query.trim()
              ? (grouped.isRecentsMode && group === grouped.groups[0] ? 'Recent' : 'Suggestions')
              : CATEGORY_LABELS[group.category];

            return (
              <div key={group.category + groupLabel}>
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {groupLabel}
                </div>
                {group.items.map((item) => {
                  const currentIdx = flatIdx++;
                  const isSelected = currentIdx === selectedIdx;
                  const recentIds = getRecent();
                  const isRecent = recentIds.includes(item.id);

                  return (
                    <button
                      key={item.id}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                        isSelected ? 'bg-accent/10 text-text' : 'text-text hover:bg-bg'
                      }`}
                      onClick={() => executeItem(item)}
                      onMouseEnter={() => setSelectedIdx(currentIdx)}
                    >
                      {isRecent && !query.trim() ? (
                        <Clock size={14} className="text-muted shrink-0" />
                      ) : (
                        <ArrowRight size={14} className="text-muted shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{item.label}</div>
                        {item.description && (
                          <div className="text-xs text-muted truncate">{item.description}</div>
                        )}
                      </div>
                      {isSelected && (
                        <kbd className="text-[10px] text-muted bg-bg border border-border rounded px-1.5 py-0.5 font-mono shrink-0">
                          Enter
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
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
