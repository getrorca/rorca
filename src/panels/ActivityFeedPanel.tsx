import { useState, useEffect, useCallback } from 'react';
import {
  Clock,
  FileText,
  CheckCircle2,
  XCircle,
  Play,
  Flag,
  MessageSquare,
  UserPlus,
  Pencil,
  ChevronDown,
  Filter,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import AppHeader from '../components/AppHeader';
import ErrorBanner from '../components/ErrorBanner';

/* ─── Types ───────────────────────────────────────────────────────── */

interface ActivityActor {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface ActivityTarget {
  type: string; // 'spec' | 'run' | 'story'
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
}

interface ActivityResponse {
  items: ActivityItem[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

type ActivityTypeFilter = 'all' | 'spec_created' | 'spec_approved' | 'spec_rejected' | 'spec_edited' | 'run_triggered' | 'run_completed' | 'comment_added' | 'member_joined';

/* ─── Constants ──────────────────────────────────────────────────── */

const PAGE_SIZE = 30;

const TYPE_FILTERS: { id: ActivityTypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'spec_created', label: 'Created' },
  { id: 'spec_approved', label: 'Approved' },
  { id: 'spec_rejected', label: 'Rejected' },
  { id: 'spec_edited', label: 'Edited' },
  { id: 'run_triggered', label: 'Runs' },
  { id: 'run_completed', label: 'Completed' },
  { id: 'comment_added', label: 'Comments' },
  { id: 'member_joined', label: 'Members' },
];

/* ─── Helpers ────────────────────────────────────────────────────── */

function activityIcon(type: string) {
  switch (type) {
    case 'spec_created': return <FileText size={16} className="text-blue-400" />;
    case 'spec_approved': return <CheckCircle2 size={16} className="text-emerald-400" />;
    case 'spec_rejected': return <XCircle size={16} className="text-red-400" />;
    case 'spec_edited': return <Pencil size={16} className="text-amber-400" />;
    case 'run_triggered': return <Play size={16} className="text-blue-400" />;
    case 'run_completed': return <Flag size={16} className="text-emerald-400" />;
    case 'comment_added': return <MessageSquare size={16} className="text-purple-400" />;
    case 'member_joined': return <UserPlus size={16} className="text-teal-400" />;
    default: return <Clock size={16} className="text-muted" />;
  }
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

/** Group items by date for section headers */
function groupByDate(items: ActivityItem[]): { date: string; items: ActivityItem[] }[] {
  const groups: { date: string; items: ActivityItem[] }[] = [];
  let currentDate = '';

  for (const item of items) {
    const d = new Date(item.timestamp + (item.timestamp.endsWith('Z') ? '' : 'Z'));
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    if (dateStr !== currentDate) {
      currentDate = dateStr;
      groups.push({ date: dateStr, items: [] });
    }
    groups[groups.length - 1].items.push(item);
  }

  return groups;
}

/* ─── Component ──────────────────────────────────────────────────── */

export default function ActivityFeedPanel() {
  const { workspaceId } = useWorkspace();

  const [items, setItems] = useState<ActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<ActivityTypeFilter>('all');

  const fetchActivity = useCallback(async (offset = 0, append = false) => {
    if (offset === 0) { setLoading(true); setError(null); }
    else setLoadingMore(true);

    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (workspaceId) params.set('workspaceId', workspaceId);

      const data = await apiFetch<ActivityResponse>(`/api/activity?${params}`);
      setItems(prev => append ? [...prev, ...data.items] : data.items);
      setTotal(data.total);
      setHasMore(data.hasMore);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load activity feed';
      if (!append) setError(msg);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [typeFilter, workspaceId]);

  useEffect(() => {
    fetchActivity(0, false);
  }, [fetchActivity]);

  // Auto-refresh every 15 seconds
  useEffect(() => {
    const interval = setInterval(() => fetchActivity(0, false), 15_000);
    return () => clearInterval(interval);
  }, [fetchActivity]);

  const dateGroups = groupByDate(items);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg" role="main" aria-label="Activity Feed panel">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">
              {workspaceId ? 'Workspace' : 'Global'}
            </span>
            <ChevronRight size={14} className="text-muted" aria-hidden="true" />
            <span className="text-sm text-muted flex items-center gap-1.5">
              Activity Feed
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface text-muted" aria-label={`${total} total activities`}>
                {total}
              </span>
            </span>
          </div>
        }
        actions={
          <div
            className="flex items-center gap-1.5 flex-wrap flex-1 max-w-full overflow-x-auto no-scrollbar pb-1 pt-1 pr-2"
            role="group"
            aria-label="Filter activity by type"
            aria-live="polite"
          >
            <Filter size={14} className="text-muted mr-1 md:hidden" aria-hidden="true" />
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setTypeFilter(f.id)}
                aria-pressed={typeFilter === f.id}
                className={`px-2.5 py-1 text-xs whitespace-nowrap rounded-full transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${typeFilter === f.id
                  ? 'bg-accent text-white'
                  : 'bg-surface text-muted hover:text-[var(--text)]'
                  }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      />

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto px-5 py-4" aria-live="polite" aria-busy={loading}>
        {error && <ErrorBanner message={error} onRetry={() => fetchActivity(0)} onDismiss={() => setError(null)} />}
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={24} className="animate-spin text-muted" aria-label="Loading activity feed" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <div className="flex flex-col items-center text-center max-w-md px-6">
              <Clock size={48} className="text-[var(--text-muted)] opacity-40 mb-4" />
              <h3 className="text-lg font-semibold text-[var(--text)] mb-2">No activity yet</h3>
              <p className="text-sm text-[var(--text-muted)]">
                Activity appears here as you generate specs, trigger pipeline runs, and approve stories.
              </p>
            </div>
          </div>
        ) : (
          <>
            {dateGroups.map(group => (
              <div key={group.date} className="mb-6">
                {/* Date header */}
                <div className="sticky top-0 bg-bg z-10 pb-2 mb-2">
                  <span className="text-xs font-medium text-muted uppercase tracking-wide">
                    {group.date}
                  </span>
                </div>

                {/* Timeline items */}
                <ol className="relative pl-6" aria-label={`Activities on ${group.date}`}>
                  {/* Vertical timeline line */}
                  <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" aria-hidden="true" />

                  {group.items.map(item => (
                    <li key={item.id} className="relative flex items-start gap-3 mb-4 group">
                      {/* Timeline dot */}
                      <div className="absolute left-[-13px] top-1 w-[22px] h-[22px] rounded-full bg-panel border border-border flex items-center justify-center z-10" aria-hidden="true">
                        {activityIcon(item.activityType)}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0 ml-3">
                        <div className="flex items-start gap-2">
                          {/* Avatar */}
                          {item.actor.avatarUrl ? (
                            <img
                              src={item.actor.avatarUrl}
                              alt={item.actor.name}
                              className="w-6 h-6 rounded-full shrink-0 mt-0.5"
                            />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-border flex items-center justify-center shrink-0 mt-0.5" aria-hidden="true">
                              <span className="text-[10px] font-medium text-muted">
                                {avatarInitials(item.actor.name)}
                              </span>
                            </div>
                          )}

                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-[var(--text)] leading-snug">
                              {item.description}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <time className="text-xs text-muted" dateTime={item.timestamp}>
                                {relativeTime(item.timestamp)}
                              </time>
                              {item.target && (
                                <span className="text-xs text-muted/60">
                                  {item.target.type === 'spec' && `spec: ${item.target.id}`}
                                  {item.target.type === 'run' && `run #${item.target.id}`}
                                  {item.target.type === 'story' && `story: ${item.target.id}`}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ))}

            {/* Load more */}
            {hasMore && (
              <div className="flex justify-center py-4">
                <button
                  onClick={() => fetchActivity(items.length, true)}
                  disabled={loadingMore}
                  aria-label="Load more activity items"
                  className="flex items-center gap-2 px-4 py-2 text-sm rounded bg-bg text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50 ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
                >
                  {loadingMore ? (
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <ChevronDown size={14} aria-hidden="true" />
                  )}
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
