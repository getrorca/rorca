/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useDebounce } from '../../hooks/useDebounce';
import {
  Clock,
  TerminalSquare,
  FileText,
  CheckCircle2,
  XCircle,
  Play,
  Flag,
  MessageSquare,
  UserPlus,
  Pencil,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Settings2,
  Shield,
  Globe,
  User,
  GitMerge,
  Layers,
} from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { apiFetch } from '../../lib/apiFetch';
import { useWalSSE, type WalEvent } from '../../hooks/useWalSSE';
import ErrorBanner from '../../components/ErrorBanner';

/* ─── Types ───────────────────────────────────────────────────────── */

interface ActivityActor {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface ActivityTarget {
  type: string;
  id: string;
}

interface ActivityItem {
  id: number;
  timestamp: string;
  activityType: string;
  rawEventType: string;
  actor: ActivityActor;
  target: ActivityTarget | null;
  description: string;
  workspaceId: string | null;
  specId: string | null;
  storyId: string | null;
  payload?: string | null;
}

interface ActivityResponse {
  items: ActivityItem[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

interface WalResponse {
  items: WalEvent[];
  total: number;
  hasMore: boolean;
  eventTypes: string[];
}

/* ─── Scope & Filter types ────────────────────────────────────────── */

type Scope = 'all' | 'workspace' | 'system' | 'user';
type TimeRange = '24h' | '7d' | '30d' | 'all';

interface TypeFilter {
  id: string;
  label: string;
}

const TYPE_FILTERS: TypeFilter[] = [
  { id: 'specs', label: 'Specs' },
  { id: 'runs', label: 'Runs' },
  { id: 'auth', label: 'Auth' },
  { id: 'config', label: 'Config' },
  { id: 'webhooks', label: 'Webhooks' },
];

const SCOPE_OPTIONS: { id: Scope; label: string; icon: typeof Globe }[] = [
  { id: 'all', label: 'All', icon: Globe },
  { id: 'workspace', label: 'Workspace', icon: Layers },
  { id: 'system', label: 'System', icon: Shield },
  { id: 'user', label: 'User', icon: User },
];

const TIME_OPTIONS: { id: TimeRange; label: string }[] = [
  { id: '24h', label: 'Last 24h' },
  { id: '7d', label: 'Last 7d' },
  { id: '30d', label: 'Last 30d' },
  { id: 'all', label: 'All time' },
];

/* ─── Event type classification ────────────────────────────────────── */

const SPEC_EVENTS = [
  'generate', 'spec_generated', 'spec_approved', 'spec_rejected', 'spec_forked',
  'story_edited', 'story_passed', 'story_failed', 'story_comment_added',
  'review_requested', 'review_approved', 'review_changes_requested',
];
const RUN_EVENTS = [
  'run_started', 'run_finished', 'run_failed', 'run_paused', 'run_resumed',
  'story_started', 'story_skipped', 'terminal_session_started', 'terminal_session_ended',
];
const AUTH_EVENTS = [
  'user_registered', 'team_created', 'team_invite_sent', 'team_invite_accepted',
];
const CONFIG_EVENTS = [
  'direction_update', 'context_file_changed',
];
const WEBHOOK_EVENTS = [
  'github_pr_merged', 'worktree_created', 'worktree_merged',
  'run_blocked',
];

function eventMatchesTypeFilter(eventType: string, filterId: string): boolean {
  switch (filterId) {
    case 'specs': return SPEC_EVENTS.includes(eventType);
    case 'runs': return RUN_EVENTS.includes(eventType);
    case 'auth': return AUTH_EVENTS.includes(eventType);
    case 'config': return CONFIG_EVENTS.includes(eventType);
    case 'webhooks': return WEBHOOK_EVENTS.includes(eventType);
    default: return true;
  }
}

/* System events (auth + config + worktree) */
const SYSTEM_EVENTS = [...AUTH_EVENTS, ...CONFIG_EVENTS, ...WEBHOOK_EVENTS];

/* ─── Helpers ────────────────────────────────────────────────────── */

const PAGE_SIZE = 50;

function activityIcon(type: string) {
  switch (type) {
    case 'spec_created':
    case 'generate':
    case 'spec_generated':
      return <FileText size={14} className="text-blue-400" />;
    case 'spec_approved':
    case 'review_approved':
      return <CheckCircle2 size={14} className="text-emerald-400" />;
    case 'spec_rejected':
    case 'review_changes_requested':
      return <XCircle size={14} className="text-red-400" />;
    case 'spec_edited':
    case 'spec_forked':
    case 'story_edited':
    case 'direction_update':
    case 'context_file_changed':
      return <Pencil size={14} className="text-amber-400" />;
    case 'run_triggered':
    case 'run_started':
      return <Play size={14} className="text-blue-400" />;
    case 'run_completed':
    case 'run_finished':
      return <Flag size={14} className="text-emerald-400" />;
    case 'run_failed':
      return <Flag size={14} className="text-red-400" />;
    case 'terminal_session_started':
    case 'terminal_session_ended':
      return <TerminalSquare size={14} className="text-cyan-400" />;
    case 'comment_added':
    case 'story_comment_added':
      return <MessageSquare size={14} className="text-purple-400" />;
    case 'member_joined':
    case 'team_invite_accepted':
    case 'user_registered':
      return <UserPlus size={14} className="text-teal-400" />;
    case 'worktree_created':
    case 'worktree_merged':
    case 'github_pr_merged':
      return <GitMerge size={14} className="text-teal-400" />;
    case 'team_created':
    case 'team_invite_sent':
      return <Settings2 size={14} className="text-violet-400" />;
    default:
      return <Clock size={14} className="text-muted" />;
  }
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

function relativeTime(ts: string): string {
  const now = Date.now();
  const then = new Date(ts + (ts.endsWith('Z') ? '' : 'Z')).getTime();
  const diff = now - then;

  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(then).toLocaleDateString();
}

function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatPayload(payload: string | null | undefined): string {
  if (!payload) return '{}';
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

function timeRangeToISO(range: TimeRange): string | null {
  if (range === 'all') return null;
  const now = new Date();
  switch (range) {
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    default: return null;
  }
}

/* ─── Merged item type ─────────────────────────────────────────────── */

interface FeedItem {
  id: number;
  timestamp: string;
  eventType: string;
  activityType: string;
  actor: { id: string; name: string; avatarUrl: string | null };
  description: string;
  target: ActivityTarget | null;
  workspaceId: string | null;
  specId: string | null;
  storyId: string | null;
  payload: string | null;
  isNew?: boolean;
}

/** Convert activity API response items to FeedItems */
function activityToFeedItems(items: ActivityItem[]): FeedItem[] {
  return items.map(item => ({
    id: item.id,
    timestamp: item.timestamp,
    eventType: item.rawEventType,
    activityType: item.activityType,
    actor: item.actor,
    description: item.description,
    target: item.target,
    workspaceId: item.workspaceId,
    specId: item.specId,
    storyId: item.storyId,
    payload: item.payload ?? null,
  }));
}

/** Convert raw WAL items to FeedItems (for system scope that needs raw events) */
function walToFeedItems(items: WalEvent[]): FeedItem[] {
  return items.map(item => ({
    id: item.id,
    timestamp: item.ts,
    eventType: item.event_type,
    activityType: item.event_type,
    actor: { id: item.actor, name: item.actor, avatarUrl: null },
    description: `${item.actor || 'system'} performed ${item.event_type.replace(/_/g, ' ')}`,
    target: item.spec_id ? { type: 'spec', id: item.spec_id } : null,
    workspaceId: item.workspace_id,
    specId: item.spec_id,
    storyId: item.story_id,
    payload: item.payload,
  }));
}

/* ─── Component ──────────────────────────────────────────────────── */

export function UnifiedActivitySection() {
  const { workspaceId } = useWorkspace();

  // State
  const [items, setItems] = useState<FeedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [scope, setScope] = useState<Scope>('all');
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Expanded item
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Real-time new item IDs for highlight animation
  const [newItemIds, setNewItemIds] = useState<Set<number>>(new Set());

  // Scroll container ref for infinite scroll
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track whether we've done initial load
  const initialLoadDone = useRef(false);

  const toggleType = (typeId: string) => {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  };

  const fetchData = useCallback(async (offset = 0, append = false) => {
    if (offset === 0) { setLoading(true); setError(null); }
    else setLoadingMore(true);

    try {
      // Use activity API for enriched data, WAL API as fallback for raw/system scope
      const fromDate = timeRangeToISO(timeRange);

      if (scope === 'system' || debouncedSearchQuery) {
        // Use WAL endpoint for system events or when searching (it has full-text search)
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
          sort: 'newest',
        });
        if (fromDate) params.set('from', fromDate);
        if (workspaceId && scope === 'workspace') params.set('workspace_id', workspaceId);
        if (debouncedSearchQuery) params.set('q', debouncedSearchQuery);

        // For system scope, filter to system event types server-side
        if (scope === 'system' && SYSTEM_EVENTS.length > 0) {
          // WAL API only supports single event_type filter, so we'll filter client-side
        }

        const data = await apiFetch<WalResponse>(`/api/wal?${params}`);
        let feedItems = walToFeedItems(data.items);

        // Client-side scope filtering for system events
        if (scope === 'system') {
          feedItems = feedItems.filter(item => SYSTEM_EVENTS.includes(item.eventType));
        }

        // Client-side type pill filtering
        if (activeTypes.size > 0) {
          feedItems = feedItems.filter(item =>
            Array.from(activeTypes).some(filterId => eventMatchesTypeFilter(item.eventType, filterId))
          );
        }

        setItems(prev => append ? [...prev, ...feedItems] : feedItems);
        setTotal(data.total);
        setHasMore(data.hasMore);
      } else {
        // Use enriched activity API
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        if (fromDate) params.set('from', fromDate);
        if (workspaceId && (scope === 'workspace' || scope === 'all')) {
          params.set('workspaceId', workspaceId);
        }
        // scope === 'user' — the activity API already returns the current user's actions
        // since auth is bypassed, this behaves same as 'all' for now

        const data = await apiFetch<ActivityResponse>(`/api/activity?${params}`);
        let feedItems = activityToFeedItems(data.items);

        // Client-side type pill filtering
        if (activeTypes.size > 0) {
          feedItems = feedItems.filter(item =>
            Array.from(activeTypes).some(filterId => eventMatchesTypeFilter(item.eventType, filterId))
          );
        }

        setItems(prev => append ? [...prev, ...feedItems] : feedItems);
        setTotal(data.total);
        setHasMore(data.hasMore);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load activity';
      if (!append) setError(msg);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      initialLoadDone.current = true;
    }
  }, [scope, activeTypes, timeRange, debouncedSearchQuery, workspaceId]);

  // Fetch on filter change
  useEffect(() => {
    fetchData(0, false);
  }, [fetchData]);

  // Real-time SSE updates: prepend new events at top
  useWalSSE(useCallback((event: WalEvent) => {
    if (!initialLoadDone.current) return;

    // Check if event matches current filters
    if (activeTypes.size > 0) {
      const matches = Array.from(activeTypes).some(filterId =>
        eventMatchesTypeFilter(event.event_type, filterId)
      );
      if (!matches) return;
    }
    if (scope === 'system' && !SYSTEM_EVENTS.includes(event.event_type)) return;
    if (scope === 'workspace' && event.workspace_id !== workspaceId) return;

    const newItem: FeedItem = {
      id: event.id,
      timestamp: event.ts,
      eventType: event.event_type,
      activityType: event.event_type,
      actor: { id: event.actor, name: event.actor, avatarUrl: null },
      description: `${event.actor || 'system'} performed ${event.event_type.replace(/_/g, ' ')}`,
      target: event.spec_id ? { type: 'spec', id: event.spec_id } : null,
      workspaceId: event.workspace_id,
      specId: event.spec_id,
      storyId: event.story_id,
      payload: event.payload,
      isNew: true,
    };

    setItems(prev => {
      // Deduplicate
      if (prev.some(item => item.id === event.id)) return prev;
      return [newItem, ...prev];
    });
    setTotal(prev => prev + 1);

    // Track for highlight animation
    setNewItemIds(prev => new Set(prev).add(event.id));
    setTimeout(() => {
      setNewItemIds(prev => {
        const next = new Set(prev);
        next.delete(event.id);
        return next;
      });
    }, 2000);
  }, [activeTypes, scope, workspaceId]));

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || !hasMore) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight - scrollTop - clientHeight < 200) {
      fetchData(items.length, true);
    }
  }, [fetchData, items.length, loadingMore, hasMore]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  return (
    <div className="flex flex-col h-full" role="main" aria-label="Activity feed">
      {/* Header */}
      <div className="shrink-0 space-y-3 mb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text)]">Activity</h2>
          <span className="text-xs text-muted">{total} event{total !== 1 ? 's' : ''}</span>
        </div>

        {/* Scope toggle */}
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Activity scope">
          {SCOPE_OPTIONS.map(opt => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                role="radio"
                aria-checked={scope === opt.id}
                onClick={() => setScope(opt.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full transition-colors ${
                  scope === opt.id
                    ? 'bg-accent text-white'
                    : 'bg-surface-100 text-muted hover:text-[var(--text)] hover:bg-surface-200'
                }`}
              >
                <Icon size={11} />
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Type filter pills + Time range */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Filter by type">
            {TYPE_FILTERS.map(f => (
              <button
                key={f.id}
                aria-pressed={activeTypes.has(f.id)}
                onClick={() => toggleType(f.id)}
                className={`px-2 py-0.5 text-[11px] rounded-full transition-colors ${
                  activeTypes.has(f.id)
                    ? 'bg-accent/20 text-accent border border-accent/30'
                    : 'bg-surface-100 text-muted hover:text-[var(--text)] border border-transparent'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="w-px h-4 bg-border" />

          {/* Time range radio */}
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Time range">
            {TIME_OPTIONS.map(opt => (
              <button
                key={opt.id}
                role="radio"
                aria-checked={timeRange === opt.id}
                onClick={() => setTimeRange(opt.id)}
                className={`px-2 py-0.5 text-[11px] rounded-full transition-colors ${
                  timeRange === opt.id
                    ? 'bg-surface-200 text-[var(--text)] font-medium'
                    : 'text-muted hover:text-[var(--text)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Search events..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            aria-label="Search activity events"
            className="w-full h-7 pl-8 pr-3 text-xs bg-bg border border-border rounded text-[var(--text)] placeholder:text-muted focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* Feed */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto -mx-1 px-1"
        aria-live="polite"
        aria-busy={loading}
      >
        {error && (
          <ErrorBanner
            message={error}
            onRetry={() => fetchData(0)}
            onDismiss={() => setError(null)}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center text-center max-w-sm px-4">
              <Clock size={40} className="text-muted/40 mb-3" />
              <h3 className="text-sm font-semibold text-[var(--text)] mb-1">No activity yet</h3>
              <p className="text-xs text-muted">
                Activity appears here as you generate specs, trigger runs, and manage workspaces.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-px">
            {items.map(item => (
              <FeedItemRow
                key={item.id}
                item={item}
                isExpanded={expandedId === item.id}
                isNew={newItemIds.has(item.id)}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
              />
            ))}

            {/* Loading more indicator */}
            {loadingMore && (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={16} className="animate-spin text-muted" />
              </div>
            )}

            {/* End of list */}
            {!hasMore && items.length > 0 && (
              <div className="text-center py-4 text-xs text-muted/60">
                End of activity
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Feed Item Row ──────────────────────────────────────────────── */

const FeedItemRow = memo(function FeedItemRow({
  item,
  isExpanded,
  isNew,
  onToggle,
}: {
  item: FeedItem;
  isExpanded: boolean;
  isNew: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`rounded transition-all duration-300 ${
        isNew ? 'bg-blue-500/8' : ''
      }`}
      style={isNew ? { animation: 'activityHighlight 2s ease-out forwards' } : undefined}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-surface-100 rounded transition-colors group"
        aria-expanded={isExpanded}
        aria-label={`${item.description}. ${relativeTime(item.timestamp)}. Click to ${isExpanded ? 'collapse' : 'expand'} details.`}
      >
        {/* Icon */}
        <div className="mt-0.5 shrink-0">
          {activityIcon(item.eventType)}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            {/* Avatar */}
            {item.actor.avatarUrl ? (
              <img
                src={item.actor.avatarUrl}
                alt={item.actor.name}
                loading="lazy"
                className="w-5 h-5 rounded-full shrink-0 mt-0.5"
              />
            ) : (
              <div className="w-5 h-5 rounded-full bg-border flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-[9px] font-medium text-muted">
                  {avatarInitials(item.actor.name)}
                </span>
              </div>
            )}

            <div className="flex-1 min-w-0">
              <p className="text-xs text-[var(--text)] leading-snug line-clamp-2">
                {item.description}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <time className="text-[11px] text-muted" dateTime={item.timestamp}>
                  {relativeTime(item.timestamp)}
                </time>
                <span className={`inline-block px-1.5 py-0 rounded-full text-[10px] font-medium ${eventTypeBadgeColor(item.eventType)}`}>
                  {item.eventType}
                </span>
                {item.target && (
                  <span className="text-[10px] text-muted/60 truncate">
                    {item.target.type}: {item.target.id}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Expand indicator */}
        <div className="mt-1 shrink-0 text-muted/50 group-hover:text-muted transition-colors">
          {isExpanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </div>
      </button>

      {/* Expanded payload */}
      {isExpanded && (
        <div className="px-3 pb-3 ml-[22px]">
          <div className="rounded bg-bg border border-border p-2.5 space-y-2">
            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <div>
                <span className="text-muted">Actor:</span>{' '}
                <span className="text-[var(--text)]">{item.actor.name}</span>
              </div>
              <div>
                <span className="text-muted">Event ID:</span>{' '}
                <span className="text-[var(--text)] font-mono">{item.id}</span>
              </div>
              {item.specId && (
                <div>
                  <span className="text-muted">Spec:</span>{' '}
                  <span className="text-[var(--text)]">{item.specId}</span>
                </div>
              )}
              {item.storyId && (
                <div>
                  <span className="text-muted">Story:</span>{' '}
                  <span className="text-[var(--text)]">{item.storyId}</span>
                </div>
              )}
              {item.workspaceId && (
                <div>
                  <span className="text-muted">Workspace:</span>{' '}
                  <span className="text-[var(--text)]">{item.workspaceId}</span>
                </div>
              )}
            </div>

            {/* Full payload */}
            {item.payload && (
              <div>
                <span className="text-[10px] text-muted uppercase tracking-wider">Payload</span>
                <pre className="mt-1 text-[10px] text-[var(--text)] font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto p-2 bg-panel rounded border border-border/50">
                  {formatPayload(item.payload)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
