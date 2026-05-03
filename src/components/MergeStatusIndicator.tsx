/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Clock, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { usePipelineSSE, type WalEvent } from '../hooks/usePipelineSSE';
import { apiFetch } from '../lib/apiFetch';

export type MergeStatus = 'pending' | 'merging' | 'merged' | 'failed';

interface MergeStatusIndicatorProps {
  runId: number;
  initialStatus: MergeStatus | null;
}

const STATUS_CONFIG: Record<MergeStatus, { icon: typeof Clock; color: string; label: string; spin?: boolean }> = {
  pending: { icon: Clock, color: 'text-gray-400', label: 'Merge pending' },
  merging: { icon: Loader2, color: 'text-amber-400', label: 'Merging', spin: true },
  merged:  { icon: CheckCircle, color: 'text-green-400', label: 'Merged' },
  failed:  { icon: XCircle, color: 'text-red-400', label: 'Merge failed' },
};

export default function MergeStatusIndicator({ runId, initialStatus }: MergeStatusIndicatorProps) {
  const [status, setStatus] = useState<MergeStatus>(initialStatus ?? 'pending');
  const [retrying, setRetrying] = useState(false);
  const processedCountRef = useRef(0);

  const events = usePipelineSSE(String(runId));

  // Process new SSE events via useEffect to avoid render-loop
  useEffect(() => {
    if (events.length <= processedCountRef.current) return;
    const newEvents = events.slice(processedCountRef.current);
    processedCountRef.current = events.length;
    for (const event of newEvents) {
      const newStatus = deriveStatus(event);
      if (newStatus) {
        setStatus(newStatus);
      }
    }
  }, [events]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await apiFetch(`/api/pipeline/runs/${runId}/retry-merge`, { method: 'POST' });
      setStatus('merging');
    } catch {
      // Keep failed state if retry request itself fails
    } finally {
      setRetrying(false);
    }
  }, [runId]);

  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <div data-testid="merge-status-indicator" className="flex items-center gap-2">
      <span
        data-testid={`merge-badge-${status}`}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.color}`}
        role="status"
        aria-label={config.label}
      >
        <Icon
          data-testid={`merge-icon-${status}`}
          className={`w-3.5 h-3.5 ${config.spin ? 'animate-spin' : ''}`}
        />
        {config.label}
      </span>

      {status === 'failed' && (
        <button
          data-testid="retry-merge-button"
          onClick={handleRetry}
          disabled={retrying}
          className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50"
        >
          {retrying ? 'Retrying...' : 'Retry Merge'}
        </button>
      )}
    </div>
  );
}

function deriveStatus(event: WalEvent): MergeStatus | null {
  switch (event.event_type) {
    case 'merge_started':
    case 'worktree_merge_started':
      return 'merging';
    case 'merge_completed':
    case 'worktree_merged':
      return 'merged';
    case 'merge_failed':
    case 'worktree_merge_failed':
      return 'failed';
    default:
      return null;
  }
}
