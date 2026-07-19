/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
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

export const PI_NATIVE_WAL_EVENT_TYPES = [
  'pi_native_run_requested',
  'pi_native_run_pending',
] as const;

export type PiNativeWalEventType = typeof PI_NATIVE_WAL_EVENT_TYPES[number];

type Subscriber = (event: WalEvent) => void;
type TopicSubscriber<T = unknown> = (event: T) => void;

const subscribers = new Map<number, Subscriber>();
const topicSubscribers = new Map<string, Map<number, TopicSubscriber>>();
const recentlyBroadcastWalIds = new Set<number>();
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

/**
 * Broadcast a WAL event to all current subscribers.
 */
export function broadcastAll(event: WalEvent): void {
  // The inserting route and PostgreSQL LISTEN/NOTIFY can observe the same row in
  // one process. Suppress that duplicate without hiding events inserted by a
  // different process (which arrive only through LISTEN here).
  if (Number.isSafeInteger(event.id)) {
    if (recentlyBroadcastWalIds.has(event.id)) return;
    recentlyBroadcastWalIds.add(event.id);
    if (recentlyBroadcastWalIds.size > MAX_RECENT_WAL_IDS) {
      const oldest = recentlyBroadcastWalIds.values().next().value as number | undefined;
      if (oldest !== undefined) recentlyBroadcastWalIds.delete(oldest);
    }
  }

  for (const fn of subscribers.values()) {
    try {
      fn(event);
    } catch {
      // subscriber threw — ignore to avoid breaking other subscribers
    }
  }
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
    if (!canWriteSse(res)) return;
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  return unsubscribe;
}

export interface SseFrame {
  event?: string;
  data?: string;
  id?: string;
  retryMs?: number;
  comment?: string;
}

export interface BoundedTopicSseSink {
  send(frame: SseFrame, lastConfirmedCursor?: string | null): boolean;
  end(frame?: SseFrame): void;
  close(): void;
}

interface SinkEnvelope {
  frame: SseFrame;
  lastConfirmedCursor: string | null;
  deliver: (accepted: boolean) => void;
}

function canWriteSse(res: Response): boolean {
  return !res.destroyed && !res.writableEnded && (res.socket === null || res.socket.writable);
}

function formatSseFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.retryMs !== undefined) lines.push(`retry: ${Math.max(0, Math.floor(frame.retryMs))}`);
  if (frame.comment !== undefined) lines.push(`: ${frame.comment.replace(/[\r\n]/g, ' ')}`);
  if (frame.id !== undefined) lines.push(`id: ${frame.id.replace(/[\r\n]/g, '')}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event.replace(/[\r\n]/g, '')}`);
  if (frame.data !== undefined) {
    for (const line of frame.data.split(/\r?\n/)) lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * Per-response bounded publisher. Every live frame traverses the hub's exact
 * topic filter before touching the socket. A high-water-mark refusal causes one
 * bounded cursor-preserving retry frame and an immediate disconnect; callers
 * never queue another frame or wait on an overlapping drain promise.
 */
export function createBoundedTopicSseSink(res: Response, retryMs = 1_000): BoundedTopicSseSink {
  const topic = `response-sse:${randomUUID()}`;
  let closed = false;
  const unsubscribe = subscribeTopic<SinkEnvelope>(topic, ({ frame, lastConfirmedCursor, deliver }) => {
    if (closed || !canWriteSse(res)) {
      deliver(false);
      return;
    }
    const accepted = res.write(formatSseFrame(frame));
    if (!accepted) {
      // One final bounded frame communicates the last cursor known to have been
      // admitted before pressure. No ID is attached, so reconnect semantics are
      // governed by the last complete chunk event the client actually parsed.
      if (canWriteSse(res)) {
        res.write(formatSseFrame({
          retryMs,
          event: 'stream_disconnect',
          data: JSON.stringify({ retryable: true, reason: 'backpressure', cursor: lastConfirmedCursor }),
        }));
      }
      closed = true;
      unsubscribe();
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    deliver(accepted);
  });

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
  };

  return {
    send(frame, lastConfirmedCursor = null): boolean {
      if (closed || !canWriteSse(res)) return false;
      let delivered = false;
      let accepted = false;
      broadcastTopic<SinkEnvelope>(topic, {
        frame,
        lastConfirmedCursor,
        deliver(result) {
          delivered = true;
          accepted = result;
        },
      });
      return delivered && accepted;
    },
    end(frame): void {
      if (frame && !closed) this.send(frame);
      close();
      if (!res.writableEnded && !res.destroyed) res.end();
    },
    close,
  };
}
