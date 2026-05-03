/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type { ApiOptions, Notification } from './types';

export function getUnreadCount(opts?: ApiOptions): Promise<{ count: number }> {
  return apiFetch('/api/notifications/unread-count', { signal: opts?.signal });
}

export function listNotifications(
  params?: { limit?: number; cursor?: string },
  opts?: ApiOptions,
): Promise<{ items: Notification[]; unreadCount: number; total: number; hasMore: boolean; cursor?: string }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.cursor) qs.set('cursor', params.cursor);
  const query = qs.toString();
  return apiFetch(`/api/notifications${query ? `?${query}` : ''}`, { signal: opts?.signal });
}

export function markRead(id: string, opts?: ApiOptions): Promise<void> {
  return apiFetch(`/api/notifications/${id}/read`, {
    method: 'POST',
    signal: opts?.signal,
  });
}

export function markAllRead(opts?: ApiOptions): Promise<void> {
  return apiFetch('/api/notifications/read-all', {
    method: 'POST',
    signal: opts?.signal,
  });
}

export function getPreferences(
  opts?: ApiOptions,
): Promise<Record<string, unknown>> {
  return apiFetch('/api/notifications/preferences', { signal: opts?.signal });
}

export function updatePreferences(
  body: Record<string, unknown>,
  opts?: ApiOptions,
): Promise<void> {
  return apiFetch('/api/notifications/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}
