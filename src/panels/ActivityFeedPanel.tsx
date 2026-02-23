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
  Loader2,
  ChevronDown,
  Filter,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';

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
  limit: number;
  offset: number;
  hasMore: boolean;
}

type ActivityTypeFilter = 'all' | 'spec_created' | 'spec_approved' | 'spec_rejected' | 'spec_edited' | 'run_triggered' | 'run_completed' | 'comment_added' | 'member_joined';

/* ─── Constants ──────────────────────────────────────────────────── */

const PAGE_SIZE = 30;

const TYPE_FILTERS: { id: ActivityTypeFilter; label: string }[] = [
  { id: 'all',           label: 'All' },
  { id: 'spec_created',  label: 'Created' },
  { id: 'spec_approved', label: 'Approved' },
  { id: 'spec_rejected', label: 'Rejected' },
  { id: 'spec_edited',   label: 'Edited' },
  { id: 'run_triggered', label: 'Runs' },
  { id: 'run_completed', label: 'Completed' },
  { id: 'comment_added', label: 'Comments' },
  { id: 'member_joined', label: 'Members' },
];

/* ─── Helpers ────────────────────────────────────────────────────── */

function activityIcon(type: string) {
  switch (type) {
    case 'spec_created':  return <FileText size={16} className="text-blue-400" />;
    case 'spec_approved': return <CheckCircle2 size={16} className="text-emerald-400" />;
    case 'spec_rejected': return <XCircle size={16} className="text-red-400" />;
    case 'spec_edited':   return <Pencil size={16} className="text-amber-400" />;
    case 'run_triggered': return <Play size={16} className="text-blue-400" />;
    case 'run_completed': return <Flag size={16} className="text-emerald-400" />;
    case 'comment_added': return <MessageSquare size={16} className="text-purple-400" />;
    case 'member_joined': return <UserPlus size={16} className="text-teal-400" />;
    default:              return <Clock size={16} className="text-muted" />;
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
  const [typeFilter, setTypeFilter] = useState<ActivityTypeFilter>('all');

  const fetchActivity = useCallback(async (offset = 0, append = false) => {
    if (offset === 0) setLoading(true);
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
    } catch (err) {
      console.error('Failed to fetch activity:', err);
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-[var(--text)]">Activity Feed</h1>
          <span className="text-xs text-muted">{total} event{total !== 1 ? 's' : ''}</span>
        </div>

        {/* Type filters */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter size={14} className="text-muted mr-1" />
          {TYPE_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setTypeFilter(f.id)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                typeFilter === f.id
                  ? 'bg-accent text-white'
                  : 'bg-bg text-muted hover:text-[var(--text)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={24} className="animate-spin text-muted" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted text-sm">
            <Clock size={32} className="mb-2 opacity-50" />
            <p>No activity yet</p>
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
                <div className="relative pl-6">
                  {/* Vertical timeline line */}
                  <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />

                  {group.items.map(item => (
                    <div key={item.id} className="relative flex items-start gap-3 mb-4 group">
                      {/* Timeline dot */}
                      <div className="absolute left-[-13px] top-1 w-[22px] h-[22px] rounded-full bg-panel border border-border flex items-center justify-center z-10">
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
                            <div className="w-6 h-6 rounded-full bg-border flex items-center justify-center shrink-0 mt-0.5">
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
                              <span className="text-xs text-muted">
                                {relativeTime(item.timestamp)}
                              </span>
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
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Load more */}
            {hasMore && (
              <div className="flex justify-center py-4">
                <button
                  onClick={() => fetchActivity(items.length, true)}
                  disabled={loadingMore}
                  className="flex items-center gap-2 px-4 py-2 text-sm rounded bg-bg text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50"
                >
                  {loadingMore ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <ChevronDown size={14} />
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
