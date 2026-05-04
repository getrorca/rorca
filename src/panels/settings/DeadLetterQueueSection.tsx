/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../lib/apiFetch';
import { useGlobalToast } from '../../contexts/ToastContext';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface FailedJob {
  jobId: string;
  queueName: string;
  state: string;
  failedAt: string | null;
  retryCount: number;
  retryLimit: number;
  errorOutput: {
    message?: string;
    stack?: string;
    [key: string]: unknown;
  } | null;
  data: Record<string, unknown>;
  runId: number | null;
  runStatus: string | null;
  specPath: string | null;
}

interface FailedJobsResponse {
  items: FailedJob[];
  total: number;
  page: number;
  pageSize: number;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

const QUEUE_FILTER_OPTIONS = ['All', 'pipeline:run', 'pipeline:retry', 'pipeline:cancel', 'pipeline:cron'];
const TIME_FILTER_OPTIONS = [
  { label: 'Last 1h', hours: 1 },
  { label: 'Last 6h', hours: 6 },
  { label: 'Last 24h', hours: 24 },
  { label: 'Last 7d', hours: 168 },
  { label: 'All', hours: null },
];

/* ─── Confirm Modal ───────────────────────────────────────────────────────── */

function ConfirmModal({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
        <h3 className="text-sm font-semibold text-primary mb-2">{title}</h3>
        <p className="text-xs text-muted mb-6">{message}</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted hover:text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded bg-red-500 hover:bg-red-600 text-white transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Job Row ─────────────────────────────────────────────────────────────── */

function JobRow({
  job,
  discarded,
  onRetry,
  onDiscard,
}: {
  job: FailedJob;
  discarded: boolean;
  onRetry: (jobId: string) => Promise<void>;
  onDiscard: (jobId: string) => void;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const shortId = job.jobId.slice(0, 8);
  const errorMsg = job.errorOutput?.message ?? job.errorOutput?.stack ?? '(no error output)';
  const truncatedError = errorMsg.length > 100 ? errorMsg.slice(0, 100) + '…' : errorMsg;

  const escapedStack = job.errorOutput?.stack
    ? escapeHtml(job.errorOutput.stack)
    : job.errorOutput?.message
    ? escapeHtml(job.errorOutput.message)
    : null;

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetry(job.jobId);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <tr
        className={`border-b border-border hover:bg-surface-hover cursor-pointer transition-colors ${discarded ? 'opacity-40' : ''}`}
        onClick={() => setExpanded((p) => !p)}
      >
        {/* Job ID */}
        <td className="px-3 py-2 text-xs font-mono text-muted" title={job.jobId}>
          {shortId}
        </td>
        {/* Queue */}
        <td className="px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
            {job.queueName}
          </span>
        </td>
        {/* Failed At */}
        <td className="px-3 py-2 text-xs text-muted whitespace-nowrap" title={job.failedAt ?? undefined}>
          {relativeTime(job.failedAt)}
        </td>
        {/* Retries */}
        <td className="px-3 py-2 text-xs text-muted font-mono">
          {job.retryCount}/{job.retryLimit}
        </td>
        {/* Error */}
        <td className="px-3 py-2 text-xs text-muted max-w-xs">
          <span className="truncate block">{truncatedError}</span>
        </td>
        {/* Run */}
        <td className="px-3 py-2 text-xs">
          {job.runId ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/runs/${job.runId}`);
              }}
              className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
            >
              Run #{job.runId}
              <ExternalLink className="w-3 h-3" />
            </button>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        {/* Actions */}
        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleRetry}
              disabled={retrying || discarded}
              className="px-2 py-1 text-[10px] rounded bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {retrying ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Retry'}
            </button>
            <button
              onClick={() => onDiscard(job.jobId)}
              disabled={discarded}
              className="px-2 py-1 text-[10px] rounded bg-surface text-muted border border-border hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Discard
            </button>
          </div>
        </td>
        {/* Expand */}
        <td className="px-3 py-2 text-muted">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr className="border-b border-border bg-surface-hover/50">
          <td colSpan={8} className="px-4 py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Error stack */}
              <div>
                <p className="text-[10px] font-semibold text-muted uppercase tracking-wide mb-1.5">
                  Stack Trace
                </p>
                <pre
                  className="text-[10px] text-muted bg-surface border border-border rounded p-2 overflow-auto max-h-48 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: escapedStack ?? '(no stack trace)' }}
                />
              </div>

              {/* Job data payload */}
              <div>
                <p className="text-[10px] font-semibold text-muted uppercase tracking-wide mb-1.5">
                  Job Payload
                </p>
                <pre className="text-[10px] text-muted bg-surface border border-border rounded p-2 overflow-auto max-h-48 leading-relaxed">
                  {JSON.stringify(job.data, null, 2)}
                </pre>
              </div>

              {/* Timing */}
              <div className="md:col-span-2">
                <p className="text-[10px] font-semibold text-muted uppercase tracking-wide mb-1.5">
                  Timing
                </p>
                <div className="flex flex-wrap gap-4 text-xs text-muted">
                  <span>
                    <span className="text-[10px] uppercase tracking-wide mr-1">Retries consumed:</span>
                    {job.retryCount} of {job.retryLimit}
                  </span>
                  {job.failedAt && (
                    <span>
                      <span className="text-[10px] uppercase tracking-wide mr-1">Failed at:</span>
                      {new Date(job.failedAt).toLocaleString()}
                    </span>
                  )}
                  {job.runStatus && (
                    <span>
                      <span className="text-[10px] uppercase tracking-wide mr-1">Run status:</span>
                      {job.runStatus}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ─── Main Section ────────────────────────────────────────────────────────── */

export function DeadLetterQueueSection() {
  const { show } = useGlobalToast();
  const [jobs, setJobs] = useState<FailedJob[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [discardedIds, setDiscardedIds] = useState<Set<string>>(new Set());
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [queueFilter, setQueueFilter] = useState('All');
  const [timeFilter, setTimeFilter] = useState<number | null>(null);
  const [confirmModal, setConfirmModal] = useState<null | 'retryAll' | 'discardAll'>(null);
  const [retryAllRunning, setRetryAllRunning] = useState(false);

  const PAGE_SIZE = 50;
  const abortRef = useRef<AbortController | null>(null);

  const fetchJobs = useCallback(
    async (pg = 1, silent = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (!silent) setLoading(true);
      try {
        const data = await apiFetch<FailedJobsResponse>(
          `/api/pipeline/queue/failed-jobs?page=${pg}&pageSize=${PAGE_SIZE}`,
          { signal: controller.signal } as RequestInit,
        );
        setJobs(data.items);
        setTotal(data.total);
        setPage(pg);
        setLastRefreshed(new Date());
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'AbortError') {
          // apiFetch handles error toasts automatically
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchJobs(1);
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchJobs]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchJobs(page, false);
  };

  const handleRetry = useCallback(
    async (jobId: string) => {
      await apiFetch(`/api/pipeline/queue/failed-jobs/${jobId}/retry`, { method: 'POST' });
      setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
      setTotal((t) => Math.max(0, t - 1));
      show('Job requeued successfully', 'success');
    },
    [show],
  );

  const handleDiscard = useCallback((jobId: string) => {
    setDiscardedIds((prev) => new Set(prev).add(jobId));
  }, []);

  // Filter logic
  const filteredJobs = jobs.filter((j) => {
    if (!showDiscarded && discardedIds.has(j.jobId)) return false;
    if (queueFilter !== 'All' && j.queueName !== queueFilter) return false;
    if (timeFilter !== null && j.failedAt) {
      const cutoff = Date.now() - timeFilter * 3_600_000;
      if (new Date(j.failedAt).getTime() < cutoff) return false;
    }
    return true;
  });

  const visibleJobs = filteredJobs.filter((j) => showDiscarded || !discardedIds.has(j.jobId));
  const retryableJobs = visibleJobs.filter((j) => !discardedIds.has(j.jobId));

  const handleRetryAll = async () => {
    setConfirmModal(null);
    setRetryAllRunning(true);
    let succeeded = 0;
    for (const job of retryableJobs) {
      try {
        await apiFetch(`/api/pipeline/queue/failed-jobs/${job.jobId}/retry`, { method: 'POST' });
        setJobs((prev) => prev.filter((j) => j.jobId !== job.jobId));
        setTotal((t) => Math.max(0, t - 1));
        succeeded++;
      } catch {
        // individual errors show via apiFetch
      }
      // 500ms delay between retries
      await new Promise((r) => setTimeout(r, 500));
    }
    setRetryAllRunning(false);
    if (succeeded > 0) show(`${succeeded} job${succeeded !== 1 ? 's' : ''} requeued`, 'success');
  };

  const handleDiscardAll = () => {
    setConfirmModal(null);
    const ids = new Set(discardedIds);
    for (const j of retryableJobs) ids.add(j.jobId);
    setDiscardedIds(ids);
  };

  // Summary counts (last 24h / last 1h from full jobs list)
  const now = Date.now();
  const last24h = jobs.filter((j) => j.failedAt && now - new Date(j.failedAt).getTime() < 86_400_000).length;
  const last1h = jobs.filter((j) => j.failedAt && now - new Date(j.failedAt).getTime() < 3_600_000).length;

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-primary">Dead-letter Queue</h2>
          <p className="text-xs text-muted mt-0.5">
            Failed pg-boss jobs — retry or discard stuck pipeline work
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading || refreshing}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border text-muted hover:text-primary hover:border-primary/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Summary row */}
      {!loading && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted bg-surface border border-border rounded-lg px-4 py-3">
          <span className="font-medium text-primary">{total} failed job{total !== 1 ? 's' : ''}</span>
          <span>·</span>
          <span>{last24h} in last 24h</span>
          <span>·</span>
          <span>{last1h} in last hour</span>
          {lastRefreshed && (
            <>
              <span className="ml-auto">Last refreshed {relativeTime(lastRefreshed.toISOString())}</span>
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {!loading && total === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted">
          <CheckCircle2 className="w-10 h-10 text-green-400" />
          <p className="text-sm font-medium text-primary">Queue is healthy — no failed jobs</p>
          <p className="text-xs">All pipeline jobs completed successfully.</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12 text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-xs">Loading failed jobs…</span>
        </div>
      )}

      {/* Table */}
      {!loading && total > 0 && (
        <>
          {/* Filter controls */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Queue filter */}
            <div className="flex items-center gap-1">
              <label className="text-[10px] uppercase tracking-wide text-muted">Queue</label>
              <select
                value={queueFilter}
                onChange={(e) => setQueueFilter(e.target.value)}
                className="text-xs bg-surface border border-border rounded px-2 py-1 text-primary"
              >
                {QUEUE_FILTER_OPTIONS.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </div>

            {/* Time filter */}
            <div className="flex items-center gap-1">
              <label className="text-[10px] uppercase tracking-wide text-muted">Time</label>
              <select
                value={timeFilter ?? 'all'}
                onChange={(e) => setTimeFilter(e.target.value === 'all' ? null : Number(e.target.value))}
                className="text-xs bg-surface border border-border rounded px-2 py-1 text-primary"
              >
                {TIME_FILTER_OPTIONS.map((t) => (
                  <option key={t.label} value={t.hours ?? 'all'}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Show discarded toggle */}
            {discardedIds.size > 0 && (
              <button
                onClick={() => setShowDiscarded((p) => !p)}
                className="text-xs text-muted hover:text-primary transition-colors ml-1"
              >
                {showDiscarded ? 'Hide' : 'Show'} discarded ({discardedIds.size})
              </button>
            )}

            {/* Bulk actions */}
            <div className="flex items-center gap-1.5 ml-auto">
              {retryAllRunning && (
                <span className="text-xs text-muted flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Retrying…
                </span>
              )}
              <button
                onClick={() => setConfirmModal('retryAll')}
                disabled={retryAllRunning || retryableJobs.length === 0}
                className="px-2.5 py-1.5 text-xs rounded bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Retry All ({retryableJobs.length})
              </button>
              <button
                onClick={() => setConfirmModal('discardAll')}
                disabled={retryableJobs.length === 0}
                className="px-2.5 py-1.5 text-xs rounded bg-surface text-muted border border-border hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Discard All
              </button>
            </div>
          </div>

          {/* Alert if visible jobs filtered down to zero */}
          {visibleJobs.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-muted py-4">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              No jobs match current filters.
            </div>
          )}

          {/* Table */}
          {visibleJobs.length > 0 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-surface-hover">
                      <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-muted font-medium">
                        Job ID
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-muted font-medium">
                        Queue
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-muted font-medium">
                        Failed At
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-muted font-medium">
                        Retries
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-muted font-medium">
                        Error
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-muted font-medium">
                        Run
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-muted font-medium">
                        Actions
                      </th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleJobs.map((job) => (
                      <JobRow
                        key={job.jobId}
                        job={job}
                        discarded={discardedIds.has(job.jobId)}
                        onRetry={handleRetry}
                        onDiscard={handleDiscard}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between text-xs text-muted pt-1">
              <span>
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => fetchJobs(page - 1)}
                  disabled={page <= 1 || loading}
                  className="px-2 py-1 rounded border border-border hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Prev
                </button>
                <button
                  onClick={() => fetchJobs(page + 1)}
                  disabled={page * PAGE_SIZE >= total || loading}
                  className="px-2 py-1 rounded border border-border hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Confirm modals */}
      {confirmModal === 'retryAll' && (
        <ConfirmModal
          title={`Retry ${retryableJobs.length} failed job${retryableJobs.length !== 1 ? 's' : ''}?`}
          message={`This will re-enqueue ${retryableJobs.length} job${retryableJobs.length !== 1 ? 's' : ''} with a 500ms delay between each. Queues: ${[...new Set(retryableJobs.map((j) => j.queueName))].join(', ')}`}
          confirmLabel="Retry All"
          onConfirm={handleRetryAll}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      {confirmModal === 'discardAll' && (
        <ConfirmModal
          title={`Discard ${retryableJobs.length} job${retryableJobs.length !== 1 ? 's' : ''}?`}
          message="Jobs will be hidden from this list. They remain in the pg-boss archive and are not deleted from the database."
          confirmLabel="Discard All"
          onConfirm={handleDiscardAll}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </section>
  );
}

export default DeadLetterQueueSection;
