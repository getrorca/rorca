/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import type { Response } from 'express';

export interface WalEvent {
  id: number;
  ts: string;
  event_type: string;
  workspace_id: string | null;
  spec_id: string | null;
  story_id: string | null;
  actor: string;
  payload: string | null;
}

type Subscriber = (event: WalEvent) => void;

const subscribers = new Map<number, Subscriber>();
let nextId = 1;

/**
 * Register a subscriber callback. Returns an unsubscribe function.
 */
export function subscribe(fn: Subscriber): () => void {
  const id = nextId++;
  subscribers.set(id, fn);
  return () => {
    subscribers.delete(id);
  };
}

/**
 * Broadcast a WAL event to all current subscribers.
 */
export function broadcastAll(event: WalEvent): void {
  for (const fn of subscribers.values()) {
    try {
      fn(event);
    } catch {
      // subscriber threw — ignore to avoid breaking other subscribers
    }
  }
}

/**
 * Current number of active subscribers (useful for leak detection in tests).
 */
export function subscriberCount(): number {
  return subscribers.size;
}

/**
 * Wire an Express SSE response to the hub. Returns cleanup function.
 */
export function attachSSE(res: Response): () => void {
  const unsubscribe = subscribe((event) => {
    res.write(`event: wal_event\ndata: ${JSON.stringify(event)}\n\n`);
  });
  return unsubscribe;
}
