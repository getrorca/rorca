/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState } from 'react';
import { Bell, Settings } from 'lucide-react';
import { useNotifications, type Notification } from '../contexts/NotificationContext';
import type { PanelId } from './Sidebar';
import NotificationPreferences from './NotificationPreferences';

/** Map notification link paths to panel IDs */
function linkToPanelId(link: string | null): PanelId | null {
  if (!link) return null;
  if (link.startsWith('/specs/')) return 'specs';
  if (link.startsWith('/pipeline/')) return 'runs';
  if (link.includes('/budget')) return 'analytics';
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
  const [showPrefs, setShowPrefs] = useState(false);
  const {
    unreadCount,
    notifications,
    loading,
    fetchNotifications,
    markRead,
    markAllRead,
  } = useNotifications();

  const handleOpen = () => {
    if (!open) fetchNotifications();
    setOpen(!open);
  };

  const handleClickNotification = (n: Notification) => {
    if (!n.readAt) markRead(n.id);
    const panelId = linkToPanelId(n.link);
    if (panelId && onNavigate) onNavigate(panelId);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={handleOpen}
        className="relative flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 text-[10px] font-bold leading-4 text-white bg-red-500 rounded-full flex items-center justify-center" aria-live="polite" aria-atomic="true">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed inset-x-3 top-14 sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-1 sm:w-80 max-h-96 bg-panel border border-border rounded shadow-lg z-50 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-sm font-medium text-[var(--text)]">Notifications</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="text-xs text-accent hover:underline"
                  >
                    Mark all read
                  </button>
                )}
                <button
                  onClick={() => { setOpen(false); setShowPrefs(true); }}
                  className="text-muted hover:text-[var(--text)] transition-colors"
                  title="Notification settings"
                  aria-label="Notification settings"
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
