import { useState, useEffect, useCallback, useRef } from 'react';
import { BookOpen, Trash2, Pencil, Search, Pin, Save, X, Check, Bot, Undo2 } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MemoryItem {
  id: number;
  workspaceId: string;
  category: string;
  content: string;
  sourceStoryId: string | null;
  sourceRunId: number | null;
  confidence: string;
  relatedFiles: string[];
  pinned: boolean;
  sourceType: string | null;
  createdAt: string;
}

interface MemoryListResponse {
  items: MemoryItem[];
  total: number;
  pinned: number;
  recentRunIds: number[];
  categories: string[];
}

const CATEGORIES = ['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha', 'Run Synthesis'] as const;

const CATEGORY_COLORS: Record<string, string> = {
  Architecture: 'bg-blue-500/10 text-blue-500',
  Convention: 'bg-purple-500/10 text-purple-500',
  'Bug Fix': 'bg-red-500/10 text-red-500',
  Decision: 'bg-amber-500/10 text-amber-500',
  Pattern: 'bg-emerald-500/10 text-emerald-500',
  Gotcha: 'bg-orange-500/10 text-orange-500',
  'Run Synthesis': 'bg-cyan-500/10 text-cyan-500',
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-emerald-500',
  medium: 'text-amber-500',
  low: 'text-red-400',
};

const SOURCE_TYPES = ['synthesis', 'manual', 'mcp', 'auto-extracted', 'import'] as const;

const SOURCE_TYPE_LABELS: Record<string, string> = {
  synthesis: 'Synthesis',
  manual: 'Manual',
  mcp: 'MCP',
  'auto-extracted': 'Auto-extracted',
  import: 'Import',
};

const SOURCE_TYPE_COLORS: Record<string, string> = {
  synthesis: 'bg-cyan-500/10 text-cyan-500',
  manual: 'bg-violet-500/10 text-violet-500',
  mcp: 'bg-indigo-500/10 text-indigo-500',
  'auto-extracted': 'bg-teal-500/10 text-teal-500',
  import: 'bg-pink-500/10 text-pink-500',
};

// ─── Undo Toast ─────────────────────────────────────────────────────────────

function UndoToast({ message, onUndo, onDismiss }: {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 10000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--text)] text-bg text-xs font-medium shadow-lg animate-in slide-in-from-bottom-2">
      <span>{message}</span>
      <button
        onClick={onUndo}
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/20 hover:bg-white/30 transition-colors"
      >
        <Undo2 size={11} />
        Undo
      </button>
      <button onClick={onDismiss} className="p-0.5 hover:opacity-70">
        <X size={12} />
      </button>
    </div>
  );
}

// ─── Inline Edit Textarea ───────────────────────────────────────────────────

function InlineEditor({ value, onSave, onCancel }: {
  value: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-full text-xs px-3 py-2 rounded border border-accent/50 bg-bg text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent resize-y"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave(text);
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onSave(text)}
          disabled={!text.trim()}
          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
        >
          <Save size={10} />
          Save
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border border-border text-muted hover:bg-surface-200"
        >
          <X size={10} />
          Cancel
        </button>
        <span className="text-[9px] text-muted ml-1">Cmd+Enter to save</span>
      </div>
    </div>
  );
}

// ─── Entry Row ──────────────────────────────────────────────────────────────

function EntryRow({ item, isSelected, isEditing, onToggleSelect, onEdit, onSaveEdit, onCancelEdit, onDelete, onTogglePin }: {
  item: MemoryItem;
  isSelected: boolean;
  isEditing: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const dateStr = new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className={`group p-3 border rounded-lg transition-colors ${
      item.pinned ? 'border-amber-500/30 bg-amber-500/5' : 'border-border hover:bg-surface-200'
    }`}>
      <div className="flex items-start gap-2">
        {/* Checkbox */}
        <label className="mt-0.5 shrink-0">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-accent/50 cursor-pointer"
          />
        </label>

        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${CATEGORY_COLORS[item.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
              {item.category}
            </span>
            <span className={`text-[10px] font-medium ${CONFIDENCE_COLORS[item.confidence] ?? 'text-muted'}`}>
              {item.confidence}
            </span>
            {item.pinned && (
              <Pin size={10} className="text-amber-500 fill-amber-500" />
            )}
            {item.sourceStoryId && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] font-medium rounded bg-cyan-500/10 text-cyan-500">
                <Bot size={9} />
                {item.sourceStoryId}
              </span>
            )}
            {item.sourceRunId && (
              <span className="text-[9px] text-muted font-mono">run #{item.sourceRunId}</span>
            )}
            {item.sourceType && (
              <span className={`px-1 py-0.5 text-[9px] font-medium rounded ${SOURCE_TYPE_COLORS[item.sourceType] ?? 'bg-gray-500/10 text-gray-500'}`}>
                {SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}
              </span>
            )}
            <span className="text-[10px] text-muted tabular-nums ml-auto shrink-0">{dateStr}</span>
          </div>

          {/* Content */}
          {isEditing ? (
            <InlineEditor
              value={item.content}
              onSave={onSaveEdit}
              onCancel={onCancelEdit}
            />
          ) : (
            <p className="text-xs text-[var(--text)]/80 leading-relaxed whitespace-pre-wrap">{item.content}</p>
          )}

          {/* Related files */}
          {(item.relatedFiles?.length ?? 0) > 0 && !isEditing && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {(item.relatedFiles ?? []).slice(0, 3).map((f) => (
                <span key={f} className="px-1 py-0.5 text-[9px] font-mono rounded bg-surface-200 text-muted">{f}</span>
              ))}
              {(item.relatedFiles?.length ?? 0) > 3 && (
                <span className="text-[9px] text-muted">+{(item.relatedFiles?.length ?? 0) - 3} more</span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        {!isEditing && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              onClick={onEdit}
              className="p-1.5 rounded hover:bg-bg transition-colors"
              title="Edit content"
            >
              <Pencil size={12} className="text-muted" />
            </button>
            <button
              onClick={onTogglePin}
              className="p-1.5 rounded hover:bg-amber-500/10 transition-colors"
              title={item.pinned ? 'Unpin' : 'Pin — always include in prompts'}
            >
              <Pin size={12} className={item.pinned ? 'text-amber-500 fill-amber-500' : 'text-muted'} />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 rounded hover:bg-red-500/10 transition-colors"
              title="Delete"
            >
              <Trash2 size={12} className="text-red-500/60" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Floating Action Bar ────────────────────────────────────────────────────

function BulkActionBar({ count, onDelete, onPin, onClear }: {
  count: number;
  onDelete: () => void;
  onPin: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--text)] text-bg text-xs font-medium shadow-lg">
      <Check size={12} />
      <span>{count} selected</span>
      <div className="w-px h-4 bg-bg/30 mx-1" />
      <button
        onClick={onDelete}
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
      >
        <Trash2 size={11} />
        Delete
      </button>
      <button
        onClick={onPin}
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
      >
        <Pin size={11} />
        Pin
      </button>
      <button onClick={onClear} className="p-1 hover:opacity-70">
        <X size={12} />
      </button>
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

export default function MemoryPanel() {
  const { workspaceId } = useWorkspace();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pinnedCount, setPinnedCount] = useState(0);
  const [recentRunIds, setRecentRunIds] = useState<number[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Filters
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterConfidence, setFilterConfidence] = useState<string>('');
  const [filterRunId, setFilterRunId] = useState<string>('');
  const [filterSourceType, setFilterSourceType] = useState<string>('');
  const [searchText, setSearchText] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset filters when workspace changes
  useEffect(() => {
    setFilterCategory('');
    setFilterConfidence('');
    setFilterRunId('');
    setFilterSourceType('');
    setSearchText('');
  }, [workspaceId]);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Editing
  const [editingId, setEditingId] = useState<number | null>(null);

  // Undo
  const [undoState, setUndoState] = useState<{ id: number; message: string } | null>(null);

  const fetchItems = useCallback(async () => {
    if (!workspaceId) return;
    const params = new URLSearchParams({ workspaceId, limit: '500' });
    if (filterCategory) params.set('category', filterCategory);
    if (filterConfidence) params.set('confidence', filterConfidence);
    if (filterRunId) params.set('sourceRunId', filterRunId);
    if (searchText) params.set('search', searchText);

    try {
      const data = await apiFetch<MemoryListResponse>(`/api/memory/items?${params}`);
      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotalCount(Number(data?.total ?? 0));
      setPinnedCount(Number(data?.pinned ?? 0));
      setRecentRunIds(Array.isArray(data?.recentRunIds) ? data.recentRunIds : []);
    } catch { /* ignore */ }
    setLoaded(true);
  }, [workspaceId, filterCategory, filterConfidence, filterRunId, searchText]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Debounced search
  const handleSearchChange = (val: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setSearchText(val), 300);
  };

  // ── Actions ─────────────────────────────────────────────────────────────

  const handleDelete = async (id: number) => {
    try {
      await apiFetch(`/api/memory/items/${id}`, { method: 'DELETE' });
      setUndoState({ id, message: 'Memory deleted. Undo?' });
      await fetchItems();
    } catch { /* ignore */ }
  };

  const handleUndelete = async (id: number) => {
    try {
      await apiFetch(`/api/memory/items/${id}/undelete`, { method: 'POST' });
      setUndoState(null);
      await fetchItems();
    } catch { /* ignore */ }
  };

  const handleTogglePin = async (item: MemoryItem) => {
    try {
      await apiFetch(`/api/memory/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !item.pinned }),
      });
      await fetchItems();
    } catch { /* ignore */ }
  };

  const handleSaveEdit = async (id: number, content: string) => {
    try {
      await apiFetch(`/api/memory/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      setEditingId(null);
      await fetchItems();
    } catch { /* ignore */ }
  };

  // Bulk actions
  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await apiFetch('/api/memory/items/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'delete' }),
      });
      setSelectedIds(new Set());
      await fetchItems();
    } catch { /* ignore */ }
  };

  const handleBulkPin = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await apiFetch('/api/memory/items/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'pin' }),
      });
      setSelectedIds(new Set());
      await fetchItems();
    } catch { /* ignore */ }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Client-side source type filtering
  const filteredItems = filterSourceType
    ? items.filter(i => (i.sourceType ?? 'manual') === filterSourceType)
    : items;

  // Category counts from filtered items
  const categoryCounts = filteredItems.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1;
    return acc;
  }, {});

  // Source type counts from current items (pre-source-filter, so pills always show all counts)
  const sourceTypeCounts = items.reduce<Record<string, number>>((acc, e) => {
    const st = e.sourceType ?? 'manual';
    acc[st] = (acc[st] ?? 0) + 1;
    return acc;
  }, {});

  // Count items from the current run (most recent run)
  const currentRunCount = recentRunIds.length > 0
    ? filteredItems.filter(i => i.sourceRunId === recentRunIds[0]).length
    : 0;

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div
      role="main"
      aria-label="Memory Ledger"
      className="h-full flex flex-col overflow-hidden bg-bg"
    >
      <div className="h-full overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-4">

          {/* Count badge header */}
          <div className="flex items-center gap-3 text-[11px]">
            <span className="font-medium text-[var(--text)]">{totalCount} memories</span>
            {pinnedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-500">
                <Pin size={10} className="fill-amber-500" />
                {pinnedCount} pinned
              </span>
            )}
            {currentRunCount > 0 && (
              <span className="text-cyan-500">
                {currentRunCount} this run
              </span>
            )}
          </div>

          {/* Toolbar: search + filters */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                placeholder="Search memories..."
                defaultValue={searchText}
                onChange={(e) => handleSearchChange(e.target.value)}
                aria-label="Search memories"
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-bg border border-border rounded-md text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>

            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              aria-label="Filter by category"
              className="text-xs px-2 py-1.5 rounded border border-border bg-bg text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All categories</option>
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            <select
              value={filterConfidence}
              onChange={(e) => setFilterConfidence(e.target.value)}
              aria-label="Filter by confidence"
              className="text-xs px-2 py-1.5 rounded border border-border bg-bg text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All confidence</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            {recentRunIds.length > 0 && (
              <select
                value={filterRunId}
                onChange={(e) => setFilterRunId(e.target.value)}
                aria-label="Filter by source run"
                className="text-xs px-2 py-1.5 rounded border border-border bg-bg text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="">All runs</option>
                {recentRunIds.map(id => (
                  <option key={id} value={id}>Run #{id}</option>
                ))}
              </select>
            )}

            <select
              value={filterSourceType}
              onChange={(e) => setFilterSourceType(e.target.value)}
              aria-label="Filter by source type"
              className="text-xs px-2 py-1.5 rounded border border-border bg-bg text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All sources</option>
              {SOURCE_TYPES.map(st => (
                <option key={st} value={st}>{SOURCE_TYPE_LABELS[st]}</option>
              ))}
            </select>
          </div>

          {/* Category pills */}
          <div className="flex flex-wrap gap-1.5 items-center">
            {CATEGORIES.map(c => {
              const count = categoryCounts[c] ?? 0;
              if (count === 0) return null;
              const isActive = filterCategory === c;
              return (
                <button
                  key={c}
                  onClick={() => setFilterCategory(isActive ? '' : c)}
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
          </div>

          {/* Source type pills */}
          <div className="flex flex-wrap gap-1.5 items-center">
            {SOURCE_TYPES.map(st => {
              const count = sourceTypeCounts[st] ?? 0;
              if (count === 0) return null;
              const isActive = filterSourceType === st;
              return (
                <button
                  key={st}
                  onClick={() => setFilterSourceType(isActive ? '' : st)}
                  className={`px-2 py-0.5 text-[10px] font-medium rounded-full transition-colors ${
                    isActive
                      ? SOURCE_TYPE_COLORS[st]
                      : 'bg-surface-200 text-muted hover:bg-surface-300'
                  }`}
                >
                  {SOURCE_TYPE_LABELS[st]} ({count})
                </button>
              );
            })}
          </div>

          {/* Entries list */}
          <ul role="list" aria-label="Memory entries" className="space-y-2">
            {filteredItems.length === 0 ? (
              <li role="listitem" className="py-12 text-center">
                {totalCount === 0 ? (
                  <div className="flex flex-col items-center max-w-[400px] mx-auto">
                    <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
                      <BookOpen size={28} className="text-accent" />
                    </div>
                    <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">No memory entries yet</h3>
                    <p className="text-sm text-muted leading-relaxed">
                      Memory entries are created automatically as specs run. They capture patterns, conventions, and decisions learned from each story.
                    </p>
                  </div>
                ) : (
                  <>
                    <BookOpen size={24} className="mx-auto text-muted mb-3" />
                    <p className="text-sm text-muted">No entries match your filters.</p>
                  </>
                )}
              </li>
            ) : (
              filteredItems.map((item) => (
                <li key={item.id} role="listitem">
                  <EntryRow
                    item={item}
                    isSelected={selectedIds.has(item.id)}
                    isEditing={editingId === item.id}
                    onToggleSelect={() => toggleSelect(item.id)}
                    onEdit={() => setEditingId(item.id)}
                    onSaveEdit={(text) => handleSaveEdit(item.id, text)}
                    onCancelEdit={() => setEditingId(null)}
                    onDelete={() => handleDelete(item.id)}
                    onTogglePin={() => handleTogglePin(item)}
                  />
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

      {/* Bulk action bar */}
      <BulkActionBar
        count={selectedIds.size}
        onDelete={handleBulkDelete}
        onPin={handleBulkPin}
        onClear={() => setSelectedIds(new Set())}
      />

      {/* Undo toast */}
      {undoState && (
        <UndoToast
          message={undoState.message}
          onUndo={() => handleUndelete(undoState.id)}
          onDismiss={() => setUndoState(null)}
        />
      )}
    </div>
  );
}
