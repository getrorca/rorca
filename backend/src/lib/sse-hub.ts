/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
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
  ingest_key?: string | null;
  trust_provenance?: 'untrusted' | 'host';
  trusted_source?: 'execution-engine' | 'worker' | 'story-result' | null;
  canonical_run_id?: number | string | null;
  story_result_id?: number | string | null;
  event_identity_hash?: string | null;
  outbox_ready_at?: string | null;
  outbox_relayed_at?: string | null;
}

export const PI_NATIVE_WAL_EVENT_TYPES = [
  'pi_native_run_requested',
  'pi_native_run_pending',
] as const;

export type PiNativeWalEventType = typeof PI_NATIVE_WAL_EVENT_TYPES[number];

type Subscriber = (event: WalEvent) => void;
type DurableSubscriber = (event: WalEvent) => Promise<void>;
type TopicSubscriber<T = unknown> = (event: T) => void;

const subscribers = new Map<number, Subscriber>();
const durableSubscribers = new Map<number, DurableSubscriber>();
const topicSubscribers = new Map<string, Map<number, TopicSubscriber>>();
const recentlyBroadcastWalIds = new Set<number>();
const durablyAcceptedWalIds = new Set<number>();
const durableBroadcastsInFlight = new Map<number, Promise<void>>();
const MAX_RECENT_WAL_IDS = 2_048;
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

function rememberBounded(set: Set<number>, id: number): void {
  set.add(id);
  if (set.size > MAX_RECENT_WAL_IDS) {
    const oldest = set.values().next().value as number | undefined;
    if (oldest !== undefined) set.delete(oldest);
  }
}

function claimBroadcast(event: WalEvent): boolean {
  // The inserting route and PostgreSQL LISTEN/NOTIFY can observe the same row in
  // one process. Suppress that duplicate without hiding events inserted by a
  // different process (which arrive only through LISTEN here).
  if (!Number.isSafeInteger(event.id)) return true;
  if (recentlyBroadcastWalIds.has(event.id)) return false;
  rememberBounded(recentlyBroadcastWalIds, event.id);
  return true;
}

function broadcastVolatile(event: WalEvent): void {
  for (const fn of subscribers.values()) {
    try {
      fn(event);
    } catch {
      // subscriber threw — ignore to avoid breaking other subscribers
    }
  }
}

/** Broadcast to ordinary best-effort UI/telemetry subscribers. */
export function broadcastAll(event: WalEvent): void {
  if (!claimBroadcast(event)) return;
  broadcastVolatile(event);
}

/**
 * Broadcast and await durable acceptance subscribers. Trusted WAL relay calls
 * this before acknowledgement, so acknowledgement means durable projection
 * acceptance—not provider completion. A rejection leaves the outbox retryable.
 */
export async function broadcastAllDurably(event: WalEvent): Promise<void> {
  if (!Number.isSafeInteger(event.id)) {
    broadcastVolatile(event);
    await Promise.all([...durableSubscribers.values()].map(fn => fn(event)));
    return;
  }
  if (durablyAcceptedWalIds.has(event.id)) return;
  const existing = durableBroadcastsInFlight.get(event.id);
  if (existing) return existing;

  const shouldBroadcastVolatile = claimBroadcast(event);
  const durable = (async () => {
    if (shouldBroadcastVolatile) broadcastVolatile(event);
    await Promise.all([...durableSubscribers.values()].map(fn => fn(event)));
    rememberBounded(durablyAcceptedWalIds, event.id);
  })();
  durableBroadcastsInFlight.set(event.id, durable);
  try {
    await durable;
  } catch (error) {
    durablyAcceptedWalIds.delete(event.id);
    if (shouldBroadcastVolatile) recentlyBroadcastWalIds.delete(event.id);
    throw error;
  } finally {
    if (durableBroadcastsInFlight.get(event.id) === durable) {
      durableBroadcastsInFlight.delete(event.id);
    }
  }
}

export function subscribeDurable(fn: DurableSubscriber): () => void {
  const id = nextId++;
  durableSubscribers.set(id, fn);
  return () => { durableSubscribers.delete(id); };
}

/**
 * Register a subscriber callback for a named topic. Returns an unsubscribe function.
 */
export function subscribeTopic<T = unknown>(topic: string, fn: TopicSubscriber<T>): () => void {
  const id = nextId++;
  const bucket = topicSubscribers.get(topic) ?? new Map<number, TopicSubscriber>();
  bucket.set(id, fn as TopicSubscriber);
  topicSubscribers.set(topic, bucket);

  return () => {
    const current = topicSubscribers.get(topic);
    if (!current) return;
    current.delete(id);
    if (current.size === 0) {
      topicSubscribers.delete(topic);
    }
  };
}

/**
 * Broadcast a payload to all subscribers of a named topic.
 */
export function broadcastTopic<T = unknown>(topic: string, event: T): void {
  const bucket = topicSubscribers.get(topic);
  if (!bucket) return;

  for (const fn of bucket.values()) {
    try {
      (fn as TopicSubscriber<T>)(event);
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

export function durableSubscriberCount(): number {
  return durableSubscribers.size;
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

/**
 * Wire an Express SSE response to a named topic. Route handlers should use this
 * helper rather than writing topic events directly so all live updates flow
 * through the hub.
 */
export function attachTopicSSE<T = unknown>(topic: string, res: Response, eventName = 'message'): () => void {
  const unsubscribe = subscribeTopic<T>(topic, (event) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  return unsubscribe;
}
