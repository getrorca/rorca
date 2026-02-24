import { useState, useEffect, useCallback, useRef } from 'react';
import { Bell, Settings } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import type { PanelId } from './Sidebar';
import NotificationPreferences from './NotificationPreferences';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsResponse {
  items: Notification[];
  unreadCount: number;
  total: number;
  hasMore: boolean;
  cursor?: string;
}

interface UnreadCountResponse {
  count: number;
}

/** Map notification link paths to panel IDs */
function linkToPanelId(link: string | null): PanelId | null {
  if (!link) return null;
  if (link.startsWith('/specs/')) return 'queue';
  if (link.startsWith('/pipeline/')) return 'pipeline';
  if (link.includes('/budget')) return 'costs';
  return null;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr + 'Z').getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface NotificationBellProps {
  onNavigate?: (panel: PanelId) => void;
}

export default function NotificationBell({ onNavigate }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll unread count every 10s
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await apiFetch<UnreadCountResponse>('/api/notifications/unread-count');
      setUnreadCount(res.count);
    } catch {
      // silently ignore — auth might not be active
    }
  }, []);

  useEffect(() => {
    fetchUnreadCount();
    intervalRef.current = setInterval(fetchUnreadCount, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchUnreadCount]);

  // Fetch full list when dropdown opens
  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<NotificationsResponse>('/api/notifications?limit=20');
      setNotifications(res.items);
      setUnreadCount(res.unreadCount);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpen = () => {
    if (!open) fetchNotifications();
    setOpen(!open);
  };

  const handleMarkRead = async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
      setNotifications(prev =>
        prev.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n)
      );
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch {
      // ignore
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST' });
      setNotifications(prev => prev.map(n => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
      setUnreadCount(0);
    } catch {
      // ignore
    }
  };

  const handleClickNotification = (n: Notification) => {
    if (!n.readAt) handleMarkRead(n.id);
    const panelId = linkToPanelId(n.link);
    if (panelId && onNavigate) onNavigate(panelId);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={handleOpen}
        className="relative flex items-center justify-center w-8 h-8 rounded text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 text-[10px] font-bold leading-4 text-white bg-red-500 rounded-full flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-80 max-h-96 bg-panel border border-border rounded shadow-lg z-50 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-sm font-medium text-[var(--text)]">Notifications</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="text-xs text-accent hover:underline"
                  >
                    Mark all read
                  </button>
                )}
                <button
                  onClick={() => { setOpen(false); setShowPrefs(true); }}
                  className="text-muted hover:text-[var(--text)] transition-colors"
                  title="Notification settings"
                >
                  <Settings size={14} />
                </button>
              </div>
            </div>

            {/* List */}
            <div className="overflow-y-auto flex-1">
              {loading && notifications.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted">Loading...</div>
              )}
              {!loading && notifications.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted">No notifications yet</div>
              )}
              {notifications.map(n => (
                <button
                  key={n.id}
                  onClick={() => handleClickNotification(n)}
                  className={`w-full text-left px-3 py-2.5 border-b border-border last:border-b-0 hover:bg-bg transition-colors ${
                    !n.readAt ? 'bg-accent/5' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!n.readAt && (
                      <span className="mt-1.5 w-2 h-2 rounded-full bg-accent shrink-0" />
                    )}
                    <div className={`flex-1 min-w-0 ${n.readAt ? 'ml-4' : ''}`}>
                      <p className="text-sm text-[var(--text)] font-medium truncate">{n.title}</p>
                      <p className="text-xs text-muted mt-0.5 line-clamp-2">{n.body}</p>
                      <p className="text-[10px] text-muted mt-1">{timeAgo(n.createdAt)}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {showPrefs && (
        <NotificationPreferences onClose={() => setShowPrefs(false)} />
      )}
    </div>
  );
}
