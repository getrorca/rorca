import { useState, useEffect, useCallback } from 'react';
import { BookOpen, Plus, Trash2, Pencil, Tag, Search, Filter, Save, X, ChevronRight } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import AppHeader from '../components/AppHeader';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MemoryEntry {
  date: string;
  category: string;
  title: string;
  rule: string;
  context: string;
  source: string;
  lineNumber?: number;
}

const CATEGORIES = ['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha'] as const;

const CATEGORY_COLORS: Record<string, string> = {
  Architecture: 'bg-blue-500/10 text-blue-500',
  Convention: 'bg-purple-500/10 text-purple-500',
  'Bug Fix': 'bg-red-500/10 text-red-500',
  Decision: 'bg-amber-500/10 text-amber-500',
  Pattern: 'bg-emerald-500/10 text-emerald-500',
  Gotcha: 'bg-orange-500/10 text-orange-500',
};

// ─── Entry Card ─────────────────────────────────────────────────────────────

function EntryCard({ entry, onEdit, onDelete }: {
  entry: MemoryEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group p-4 border border-border rounded-lg hover:bg-surface-200 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Header: category badge + date */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${CATEGORY_COLORS[entry.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
              {entry.category}
            </span>
            <span className="text-[10px] text-muted tabular-nums">{entry.date}</span>
            {entry.source && (
              <span className="text-[10px] text-muted font-mono">{entry.source}</span>
            )}
          </div>

          {/* Title */}
          <h3 className="text-sm font-medium text-[var(--text)] mb-1">{entry.title}</h3>

          {/* Rule */}
          <p className="text-xs text-[var(--text)]/80 leading-relaxed">{entry.rule}</p>

          {/* Context */}
          {entry.context && (
            <p className="text-[11px] text-muted mt-1 leading-relaxed">{entry.context}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            className="p-1.5 rounded hover:bg-bg transition-colors"
            title="Edit"
          >
            <Pencil size={12} className="text-muted" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-red-500/10 transition-colors"
            title="Delete"
          >
            <Trash2 size={12} className="text-red-500/60" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add/Edit Form ──────────────────────────────────────────────────────────

function EntryForm({ initial, onSave, onCancel }: {
  initial?: MemoryEntry;
  onSave: (entry: Omit<MemoryEntry, 'date' | 'lineNumber'>) => void;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState(initial?.category ?? 'Decision');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [rule, setRule] = useState(initial?.rule ?? '');
  const [context, setContext] = useState(initial?.context ?? '');
  const [source, setSource] = useState(initial?.source ?? '');

  return (
    <div className="border border-accent/30 rounded-lg p-4 bg-accent/5 space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="text-xs px-2 py-1.5 rounded border border-border bg-bg text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        >
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Source (e.g. CIE-005)"
          className="text-xs px-2 py-1.5 rounded border border-border bg-bg text-[var(--text)] placeholder:text-muted w-32 focus:border-accent focus:ring-1 focus:ring-accent"
        />
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title — short descriptive name"
        className="w-full text-sm px-3 py-2 rounded border border-border bg-bg text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
      />

      <input
        type="text"
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        placeholder="Rule — the actionable pattern or convention"
        className="w-full text-xs px-3 py-2 rounded border border-border bg-bg text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
      />

      <input
        type="text"
        value={context}
        onChange={(e) => setContext(e.target.value)}
        placeholder="Context — why this matters (optional)"
        className="w-full text-xs px-3 py-2 rounded border border-border bg-bg text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
      />

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            if (!title.trim() || !rule.trim()) return;
            onSave({ category, title, rule, context, source });
          }}
          disabled={!title.trim() || !rule.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Save size={12} />
          Save
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted hover:bg-bg transition-colors"
        >
          <X size={12} />
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

export default function MemoryPanel() {
  const { workspaceId } = useWorkspace();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [filteredCategory, setFilteredCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<MemoryEntry | null>(null);
  const [loaded, setLoaded] = useState(false);

  const fetchEntries = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const params = new URLSearchParams({ workspaceId });
      if (filteredCategory) params.set('category', filteredCategory);
      const data = await apiFetch<{ items: MemoryEntry[] }>(`/api/memory?${params}`);
      setEntries(data.items);
    } catch { /* ignore */ }
    setLoaded(true);
  }, [workspaceId, filteredCategory]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const handleAdd = async (entry: Omit<MemoryEntry, 'date' | 'lineNumber'>) => {
    if (!workspaceId) return;
    try {
      await apiFetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...entry }),
      });
      setShowAddForm(false);
      fetchEntries();
    } catch { /* ignore */ }
  };

  const handleEdit = async (original: MemoryEntry, updates: Omit<MemoryEntry, 'date' | 'lineNumber'>) => {
    if (!workspaceId) return;
    try {
      await apiFetch('/api/memory/entry', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          date: original.date,
          title: original.title,
          updates: {
            category: updates.category,
            title: updates.title,
            rule: updates.rule,
            context: updates.context,
          },
        }),
      });
      setEditingEntry(null);
      fetchEntries();
    } catch { /* ignore */ }
  };

  const handleDelete = async (entry: MemoryEntry) => {
    if (!workspaceId) return;
    try {
      await apiFetch('/api/memory/entry', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          date: entry.date,
          title: entry.title,
        }),
      });
      fetchEntries();
    } catch { /* ignore */ }
  };

  // Filter entries by search query
  const filtered = entries.filter(e => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return e.title.toLowerCase().includes(q) ||
      e.rule.toLowerCase().includes(q) ||
      e.context.toLowerCase().includes(q) ||
      e.source.toLowerCase().includes(q);
  });

  // Group by category for the count badges
  const categoryCounts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1;
    return acc;
  }, {});

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <BookOpen size={14} className="text-muted" />
            <span className="text-sm text-muted">Memory Ledger</span>
          </div>
        }
      />

      <div className="h-full overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-4">

          {/* Toolbar: search + filter + add */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                placeholder="Search entries..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-bg border border-border rounded-md text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>

            <div className="flex items-center gap-1">
              <Filter size={12} className="text-muted" />
              <select
                value={filteredCategory ?? ''}
                onChange={(e) => setFilteredCategory(e.target.value || null)}
                className="text-xs px-2 py-1.5 rounded border border-border bg-bg text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="">All categories</option>
                {CATEGORIES.map(c => (
                  <option key={c} value={c}>
                    {c} ({categoryCounts[c] ?? 0})
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => { setShowAddForm(true); setEditingEntry(null); }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              <Plus size={12} />
              Add Entry
            </button>
          </div>

          {/* Category pills summary */}
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map(c => {
              const count = categoryCounts[c] ?? 0;
              if (count === 0) return null;
              const isActive = filteredCategory === c;
              return (
                <button
                  key={c}
                  onClick={() => setFilteredCategory(isActive ? null : c)}
                  className={`px-2 py-0.5 text-[10px] font-medium rounded-full transition-colors ${
                    isActive
                      ? CATEGORY_COLORS[c]
                      : 'bg-surface-200 text-muted hover:bg-surface-300'
                  }`}
                >
                  {c} ({count})
                </button>
              );
            })}
            <span className="px-2 py-0.5 text-[10px] text-muted">
              {entries.length} total
            </span>
          </div>

          {/* Add form */}
          {showAddForm && (
            <EntryForm
              onSave={handleAdd}
              onCancel={() => setShowAddForm(false)}
            />
          )}

          {/* Entries list */}
          <div className="space-y-2">
            {filtered.length === 0 ? (
              <div className="py-12 text-center">
                <BookOpen size={24} className="mx-auto text-muted mb-3" />
                <p className="text-sm text-muted">
                  {entries.length === 0
                    ? 'No memory entries yet. Add one manually or run a pipeline to auto-capture.'
                    : 'No entries match your search.'}
                </p>
              </div>
            ) : (
              filtered.map((entry, i) => (
                editingEntry?.date === entry.date && editingEntry?.title === entry.title ? (
                  <EntryForm
                    key={`${entry.date}-${entry.title}`}
                    initial={entry}
                    onSave={(updates) => handleEdit(entry, updates)}
                    onCancel={() => setEditingEntry(null)}
                  />
                ) : (
                  <EntryCard
                    key={`${entry.date}-${entry.title}-${i}`}
                    entry={entry}
                    onEdit={() => { setEditingEntry(entry); setShowAddForm(false); }}
                    onDelete={() => handleDelete(entry)}
                  />
                )
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
