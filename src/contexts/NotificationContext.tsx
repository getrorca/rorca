/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '../lib/apiFetch';
import { useWalSSE } from '../hooks/useWalSSE';
import type { EntityRefV1 } from '../../shared/contracts/mission';

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  entity: EntityRefV1 | null;
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

const POLL_INTERVAL = 30_000; // 30s fallback poll — SSE handles real-time
const SSE_THROTTLE_MS = 5_000; // SSE events throttled to at most 1 refresh per 5s

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSseRefreshRef = useRef<number>(0); // timestamp of last SSE-triggered refresh

  const refreshUnreadCount = useCallback(async () => {
    try {
      const res = await apiFetch<UnreadCountResponse>('/api/notifications/unread-count');
      setUnreadCount(res.count);
    } catch {
      // Silently ignore — auth might not be active or rate limited
    }
  }, []);

  // Throttled version for SSE triggers — prevents rapid-fire 429s on event replay
  const refreshUnreadCountThrottled = useCallback(() => {
    const now = Date.now();
    if (now - lastSseRefreshRef.current < SSE_THROTTLE_MS) return;
    lastSseRefreshRef.current = now;
    void refreshUnreadCount();
  }, [refreshUnreadCount]);

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

  // SSE: subscribe to WAL events via shared singleton to detect new notifications
  const triggerTypes = new Set([
    'spec_approved', 'spec_rejected', 'run_finished',
    'run_failed', 'run_cancelled', 'review_requested', 'budget_alert',
  ]);
  useWalSSE((event) => {
    if (triggerTypes.has(event.event_type)) {
      refreshUnreadCountThrottled();
    }
  });

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
