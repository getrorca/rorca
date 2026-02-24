import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '../lib/apiFetch';

export interface Notification {
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

interface NotificationContextValue {
  /** Current unread notification count */
  unreadCount: number;
  /** Loaded notifications (fetched on demand) */
  notifications: Notification[];
  /** Whether notifications are currently loading */
  loading: boolean;
  /** Fetch the full notification list */
  fetchNotifications: () => Promise<void>;
  /** Refresh just the unread count (lightweight) */
  refreshUnreadCount: () => Promise<void>;
  /** Mark a single notification as read */
  markRead: (id: string) => Promise<void>;
  /** Mark all notifications as read */
  markAllRead: () => Promise<void>;
}

const NotificationCtx = createContext<NotificationContextValue | null>(null);

const POLL_INTERVAL = 10_000; // 10s fallback poll

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  const refreshUnreadCount = useCallback(async () => {
    try {
      const res = await apiFetch<UnreadCountResponse>('/api/notifications/unread-count');
      setUnreadCount(res.count);
    } catch {
      // Silently ignore — auth might not be active
    }
  }, []);

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

  const markRead = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
      setNotifications((prev) =>
        prev.map((n) => n.id === id ? { ...n, readAt: new Date().toISOString() } : n),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // ignore
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST' });
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })),
      );
      setUnreadCount(0);
    } catch {
      // ignore
    }
  }, []);

  // SSE: subscribe to WAL events to detect new notifications in real-time
  useEffect(() => {
    const base = import.meta.env.VITE_API_URL || 'http://localhost:3030';
    const es = new EventSource(`${base}/api/pipeline/stream`);
    sseRef.current = es;

    es.addEventListener('wal_event', (e) => {
      try {
        const data = JSON.parse(e.data);
        // Notification-triggering events — refresh count when these arrive
        const triggerTypes = new Set([
          'spec_approved', 'spec_rejected', 'run_finished',
          'run_failed', 'review_requested', 'budget_alert',
        ]);
        if (triggerTypes.has(data.event_type)) {
          refreshUnreadCount();
        }
      } catch {
        // ignore parse errors
      }
    });

    es.onerror = () => {
      // SSE disconnected — polling fallback still active
    };

    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [refreshUnreadCount]);

  // Fallback polling for unread count
  useEffect(() => {
    refreshUnreadCount();
    pollRef.current = setInterval(refreshUnreadCount, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshUnreadCount]);

  return (
    <NotificationCtx.Provider value={{
      unreadCount,
      notifications,
      loading,
      fetchNotifications,
      refreshUnreadCount,
      markRead,
      markAllRead,
    }}>
      {children}
    </NotificationCtx.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationCtx);
  if (!ctx) throw new Error('useNotifications must be inside NotificationProvider');
  return ctx;
}
