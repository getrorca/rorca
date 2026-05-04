/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useCallback } from 'react';
import { GripVertical, X, Plus, Layers, GitBranch } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

export interface QueueEntry {
  id: number;
  workspace_id: number;
  spec_id: string;
  spec_path: string;
  parallelism: number;
  auto_worktree: number;
  position: number;
  status: string;
  created_at: string;
  triggered_at: string | null;
  error_message: string | null;
}

function specDisplayName(specId: string): string {
  return specId.replace(/-/g, ' ');
}

interface RunQueueSectionProps {
  entries: QueueEntry[];
  onRefresh: () => void;
  onAddClick: () => void;
}

export default function RunQueueSection({ entries, onRefresh, onAddClick }: RunQueueSectionProps) {
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragSrcIdx = useRef<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [animatingOut, _setAnimatingOut] = useState<number | null>(null);

  const handleRemove = useCallback(async (entryId: number) => {
    setRemoving(entryId);
    try {
      await apiFetch(`/api/run-queue/${entryId}`, { method: 'DELETE' });
      onRefresh();
    } catch (err) {
      console.error('[RunQueue] Remove failed:', err);
    } finally {
      setRemoving(null);
    }
  }, [onRefresh]);

  const handleDragStart = useCallback((idx: number) => {
    dragSrcIdx.current = idx;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIdx(null);
  }, []);

  const handleDrop = useCallback(async (targetIdx: number) => {
    setDragOverIdx(null);
    const srcIdx = dragSrcIdx.current;
    dragSrcIdx.current = null;
    if (srcIdx === null || srcIdx === targetIdx) return;

    // Compute new order
    const reordered = [...entries];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(targetIdx, 0, moved);

    const orderedIds = reordered.map((e) => e.id);
    try {
      await apiFetch('/api/run-queue/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
      onRefresh();
    } catch (err) {
      console.error('[RunQueue] Reorder failed:', err);
    }
  }, [entries, onRefresh]);

  const handleDragEnd = useCallback(() => {
    dragSrcIdx.current = null;
    setDragOverIdx(null);
  }, []);

  // Triggered entries animate out
  const isAnimatingOut = (entry: QueueEntry) => animatingOut === entry.id;

  // Empty state
  if (entries.length === 0) {
    return (
      <div className="px-3 py-4 text-center">
        <p className="text-xs text-[var(--text-muted)] mb-2">
          Queue is empty — add specs to run sequentially
        </p>
        <button
          onClick={onAddClick}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add to Queue
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="divide-y divide-[var(--border)]">
        {entries.map((entry, idx) => (
          <div
            key={entry.id}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDragLeave={handleDragLeave}
            onDrop={() => handleDrop(idx)}
            onDragEnd={handleDragEnd}
            className={`flex items-center gap-1.5 px-2 py-1.5 text-xs transition-all ${
              dragOverIdx === idx ? 'border-t-2 border-[var(--accent)]' : ''
            } ${isAnimatingOut(entry) ? 'opacity-0 -translate-x-full' : ''} ${
              entry.status === 'triggering' ? 'opacity-60' : ''
            } hover:bg-[var(--surface)]`}
          >
            <GripVertical className="w-3 h-3 text-[var(--text-muted)] flex-shrink-0 cursor-grab opacity-40 hover:opacity-100" />
            <span className="text-[10px] text-[var(--text-muted)] w-4 flex-shrink-0 text-center font-mono">
              {idx + 1}
            </span>
            <span className="truncate flex-1 capitalize" title={entry.spec_id}>
              {specDisplayName(entry.spec_id)}
            </span>
            {entry.parallelism > 1 && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] font-medium rounded bg-blue-500/15 text-blue-400 border border-blue-500/25 flex-shrink-0">
                <Layers className="w-2.5 h-2.5" />
                {entry.parallelism}x
              </span>
            )}
            {entry.auto_worktree === 1 && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] font-medium rounded bg-purple-500/15 text-purple-400 border border-purple-500/25 flex-shrink-0">
                <GitBranch className="w-2.5 h-2.5" />
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleRemove(entry.id); }}
              disabled={removing === entry.id}
              className="p-0.5 rounded hover:bg-red-500/20 text-[var(--text-muted)] hover:text-red-400 transition-colors flex-shrink-0 disabled:opacity-50"
              title="Remove from queue"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="px-2 py-1.5 border-t border-[var(--border)]">
        <button
          onClick={onAddClick}
          className="w-full flex items-center justify-center gap-1 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] rounded transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add Spec
        </button>
      </div>
    </div>
  );
}
