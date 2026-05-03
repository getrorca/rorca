/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../lib/apiFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'partial_failure' | 'cancelled' | 'queued';
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  retried_from_run_id: number | null;
  agent_type?: string;
  agent_model?: string | null;
  parallelism?: number;
  branch_name?: string | null;
  worktree_path?: string | null;
  queue_position?: number | null;
  queued_at?: string | null;
  triggered_via?: 'queue' | 'run_now';
  auto_worktree?: boolean;
}

interface RunsResponse {
  items: PipelineRun[];
  total: number;
  hasMore?: boolean;
}

// ─── Module-level singleton cache ───────────────────────────────────────────
// Ensures that no matter how many components call usePipelineRuns, only a
// single HTTP request is in-flight at any time per workspaceId, and only one
// polling interval is active.

interface CacheEntry {
  data: PipelineRun[];
  timestamp: number;
  inflight: Promise<PipelineRun[]> | null;
}

type Listener = () => void;

const cache = new Map<string, CacheEntry>();
const listeners = new Set<Listener>();
let activePollingWorkspaceId: string | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let pollingInterval = 10_000; // default, use the shortest requested

function notifyListeners() {
  listeners.forEach(fn => fn());
}

function getOrCreateEntry(workspaceId: string): CacheEntry {
  let entry = cache.get(workspaceId);
  if (!entry) {
    entry = { data: [], timestamp: 0, inflight: null };
    cache.set(workspaceId, entry);
  }
  return entry;
}

function fetchRuns(workspaceId: string): Promise<PipelineRun[]> {
  const entry = getOrCreateEntry(workspaceId);

  // Deduplicate: if a request is already in-flight, return the same promise
  if (entry.inflight) return entry.inflight;

  const promise = apiFetch<RunsResponse>(`/api/pipeline/runs?workspaceId=${workspaceId}`)
    .then((resp) => {
      entry.data = resp.items;
      entry.timestamp = Date.now();
      entry.inflight = null;
      notifyListeners();
      return resp.items;
    })
    .catch((err) => {
      entry.inflight = null;
      throw err;
    });

  entry.inflight = promise;
  return promise;
}

function startPolling(workspaceId: string, interval: number) {
  // If already polling for this workspace at the same or faster interval, no-op
  if (activePollingWorkspaceId === workspaceId && pollingInterval <= interval && pollingTimer) {
    return;
  }

  stopPolling();
  activePollingWorkspaceId = workspaceId;
  pollingInterval = interval;
  pollingTimer = setInterval(() => {
    fetchRuns(workspaceId).catch(() => {});
  }, interval);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  activePollingWorkspaceId = null;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Shared hook for fetching pipeline runs. Uses a module-level singleton cache
 * so that multiple subscribers (AppLayout badge, PipelineMonitorPanel) share
 * one in-flight request and one polling timer.
 *
 * @param workspaceId  Current workspace ID
 * @param interval     Polling interval in ms (default 10000). The shortest
 *                     requested interval wins across all mounted subscribers.
 */
export function usePipelineRuns(workspaceId: string | null, interval = 10_000) {
  const [runs, setRuns] = useState<PipelineRun[]>(() => {
    if (!workspaceId) return [];
    return getOrCreateEntry(workspaceId).data;
  });

  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  // Subscribe to cache updates
  useEffect(() => {
    if (!workspaceId) {
      setRuns([]);
      return;
    }

    const handler = () => {
      const entry = cache.get(workspaceId);
      if (entry) setRuns(entry.data);
    };

    listeners.add(handler);

    // Initial fetch
    fetchRuns(workspaceId).catch(() => {});

    // Start or adjust polling
    startPolling(workspaceId, interval);

    return () => {
      listeners.delete(handler);
      // Stop polling only if no subscribers remain
      if (listeners.size === 0) {
        stopPolling();
      }
    };
  }, [workspaceId, interval]);

  // Imperative refetch (for SSE-driven refreshes)
  const refetch = useCallback(() => {
    const wid = workspaceIdRef.current;
    if (wid) fetchRuns(wid).catch(() => {});
  }, []);

  return { runs, refetch };
}
