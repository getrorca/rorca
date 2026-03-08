import { useState, useEffect, useCallback } from 'react';
import {
  Search,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ScrollText,
  ArrowUpDown,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';

/* ─── Types ───────────────────────────────────────────────────────── */

interface WalEvent {
  id: number;
  ts: string;
  event_type: string;
  workspace_id: string | null;
  spec_id: string | null;
  story_id: string | null;
  actor: string;
  payload: string | null;
}

interface AuditResponse {
  items: WalEvent[];
  total: number;
  hasMore: boolean;
  cursor?: string;
  eventTypes: string[];
}

/* ─── Constants ──────────────────────────────────────────────────── */

const PAGE_SIZE = 50;

/* ─── Helpers ────────────────────────────────────────────────────── */

function formatTimestamp(ts: string): string {
  const d = new Date(ts + (ts.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function eventTypeBadgeColor(type: string): string {
  if (type.includes('approve') || type.includes('pass')) return 'bg-emerald-500/15 text-emerald-400';
  if (type.includes('reject') || type.includes('fail')) return 'bg-red-500/15 text-red-400';
  if (type.includes('start') || type.includes('trigger')) return 'bg-blue-500/15 text-blue-400';
  if (type.includes('finish') || type.includes('complete')) return 'bg-violet-500/15 text-violet-400';
  if (type.includes('create') || type.includes('generate')) return 'bg-amber-500/15 text-amber-400';
  if (type.includes('merge')) return 'bg-teal-500/15 text-teal-400';
  return 'bg-zinc-500/15 text-zinc-400';
}

function formatPayload(payload: string | null): string {
  if (!payload) return '{}';
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

function buildDetails(event: WalEvent): string {
  const parts: string[] = [];
  if (event.spec_id) parts.push(`spec: ${event.spec_id}`);
  if (event.story_id) parts.push(`story: ${event.story_id}`);
  if (!parts.length && event.payload) {
    try {
      const p = JSON.parse(event.payload);
      if (p.specId) parts.push(`spec: ${p.specId}`);
      if (p.storyId) parts.push(`story: ${p.storyId}`);
      if (p.label) parts.push(p.label);
      if (p.title) parts.push(p.title);
    } catch { /* ignore */ }
  }
  return parts.join(' | ') || '—';
}

/* ─── Component ──────────────────────────────────────────────────── */

export default function AuditLogPanel() {
  const { workspaceId, workspaces } = useWorkspace();

  // Data
  const [events, setEvents] = useState<WalEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [wsFilter, setWsFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');

  // Pagination
  const [page, setPage] = useState(0);

  // Expanded row
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchAuditLog = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
        sort: sortOrder,
      });
      if (eventTypeFilter) params.set('event_type', eventTypeFilter);
      if (wsFilter) params.set('workspace_id', wsFilter);
      else if (workspaceId) params.set('workspace_id', workspaceId);
      if (actorFilter) params.set('actor', actorFilter);
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      if (searchQuery) params.set('q', searchQuery);

      const data = await apiFetch<AuditResponse>(`/api/wal?${params}`);
      setEvents(data.items);
      setTotal(data.total);
      setEventTypes(data.eventTypes);
    } catch (err) {
      console.error('Failed to fetch audit log:', err);
    } finally {
      setLoading(false);
    }
  }, [page, sortOrder, eventTypeFilter, wsFilter, workspaceId, actorFilter, dateFrom, dateTo, searchQuery]);

  // Reset to page 0 when filters change
  useEffect(() => {
    setPage(0);
  }, [eventTypeFilter, wsFilter, actorFilter, dateFrom, dateTo, searchQuery, sortOrder]);

  useEffect(() => {
    fetchAuditLog();
  }, [fetchAuditLog]);

  return (
    <div
      role="main"
      aria-label="Audit Log"
      className="flex flex-col h-full overflow-hidden"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-[var(--text)]">Audit Log</h1>
          <span className="text-xs text-muted">{total} event{total !== 1 ? 's' : ''}</span>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap items-end gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              placeholder="Search events..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search audit log events"
              className="w-full h-8 pl-8 pr-3 text-xs bg-bg border border-border rounded text-[var(--text)] placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>

          {/* Event type dropdown */}
          <select
            value={eventTypeFilter}
            onChange={(e) => setEventTypeFilter(e.target.value)}
            aria-label="Filter by event type"
            className="h-8 px-2 text-xs bg-bg border border-border rounded text-[var(--text)] focus:outline-none focus:border-accent"
          >
            <option value="">All types</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {/* Workspace selector */}
          <select
            value={wsFilter}
            onChange={(e) => setWsFilter(e.target.value)}
            aria-label="Filter by workspace"
            className="h-8 px-2 text-xs bg-bg border border-border rounded text-[var(--text)] focus:outline-none focus:border-accent"
          >
            <option value="">All workspaces</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>

          {/* Actor search */}
          <input
            type="text"
            placeholder="Actor..."
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            aria-label="Filter by actor"
            className="h-8 w-full sm:w-28 px-2 text-xs bg-bg border border-border rounded text-[var(--text)] placeholder:text-muted focus:outline-none focus:border-accent"
          />

          {/* Date from */}
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="Filter from date"
            className="h-8 px-2 text-xs bg-bg border border-border rounded text-[var(--text)] focus:outline-none focus:border-accent"
          />

          {/* Date to */}
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="Filter to date"
            className="h-8 px-2 text-xs bg-bg border border-border rounded text-[var(--text)] focus:outline-none focus:border-accent"
          />

          {/* Sort toggle */}
          <button
            onClick={() => setSortOrder(s => s === 'newest' ? 'oldest' : 'newest')}
            className="h-8 px-2.5 flex items-center gap-1 text-xs bg-bg border border-border rounded text-muted hover:text-[var(--text)] transition-colors"
            aria-label={sortOrder === 'newest' ? 'Sort order: newest first. Click for oldest first' : 'Sort order: oldest first. Click for newest first'}
          >
            <ArrowUpDown size={12} />
            {sortOrder === 'newest' ? 'Newest' : 'Oldest'}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto" aria-label="Audit log events" role="region">
        <div className="overflow-x-auto min-w-full">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={24} className="animate-spin text-muted" />
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted text-sm">
            <ScrollText size={32} className="mb-2 opacity-50" />
            <p>No events found</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="px-4 py-2.5 font-medium w-8"></th>
                <th className="px-4 py-2.5 font-medium">Timestamp</th>
                <th className="px-4 py-2.5 font-medium">Actor</th>
                <th className="px-4 py-2.5 font-medium">Event Type</th>
                <th className="px-4 py-2.5 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const isExpanded = expandedId === event.id;
                return (
                  <TableRow
                    key={event.id}
                    event={event}
                    isExpanded={isExpanded}
                    onToggle={() => setExpandedId(isExpanded ? null : event.id)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
        </div>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="px-5 py-3 border-t border-border shrink-0 flex items-center justify-between">
          <span className="text-xs text-muted">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
              className="w-7 h-7 flex items-center justify-center rounded bg-bg border border-border text-muted hover:text-[var(--text)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2 text-xs text-muted">
              {page + 1} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => p + 1)}
              className="w-7 h-7 flex items-center justify-center rounded bg-bg border border-border text-muted hover:text-[var(--text)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Table Row ──────────────────────────────────────────────────── */

function TableRow({
  event,
  isExpanded,
  onToggle,
}: {
  event: WalEvent;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        tabIndex={0}
        role="button"
        aria-expanded={isExpanded}
        aria-label={`Event: ${event.event_type}, actor: ${event.actor}. Press Enter to ${isExpanded ? 'collapse' : 'expand'} details.`}
        className="border-b border-border/50 hover:bg-bg/50 cursor-pointer transition-colors focus:outline-none focus:bg-bg/50"
      >
        <td className="px-4 py-2.5 text-muted" aria-hidden="true">
          {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </td>
        <td className="px-4 py-2.5 text-[var(--text)] whitespace-nowrap font-mono">
          {formatTimestamp(event.ts)}
        </td>
        <td className="px-4 py-2.5 text-[var(--text)]">
          {event.actor}
        </td>
        <td className="px-4 py-2.5">
          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${eventTypeBadgeColor(event.event_type)}`}>
            {event.event_type}
          </span>
        </td>
        <td className="px-4 py-2.5 text-muted truncate max-w-[300px]">
          {buildDetails(event)}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-border/50">
          <td colSpan={5} className="px-4 py-3 bg-bg/30">
            <pre className="text-[11px] text-[var(--text)] font-mono whitespace-pre-wrap break-all max-h-64 overflow-auto p-3 bg-bg rounded border border-border">
              {formatPayload(event.payload)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
