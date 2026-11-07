/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertTriangle, RefreshCw,
  Loader2, WifiOff, TrendingUp, TrendingDown, Minus,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { apiFetch } from '../lib/apiFetch';
import { useWalSSE } from '../hooks/useWalSSE';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface PickupLatency {
  avgSeconds: number | null;
  p50Seconds: number | null;
  p95Seconds: number | null;
  maxSeconds: number | null;
  sampleCount: number;
  status: 'healthy' | 'degraded' | 'critical';
}

interface QueueRow {
  name: string;
  pending: number;
  active: number;
  failed: number;
}

export interface WorkerHealth {
  workerActive: boolean;
  workerPid: number | null;
  queueHealth: 'healthy' | 'degraded' | 'critical';
  queueStats: {
    pending: number;
    active: number;
    failed: number;
    completed24h: number;
    failedInLast24h: number;
    pickupLatency: PickupLatency | null;
    queues: QueueRow[];
  };
}

export type QueueDisplayStatus = 'healthy' | 'idle' | 'degraded' | 'critical' | 'offline' | 'unknown' | 'unavailable';

interface HistorySnapshot {
  capturedAt: string;
  pending: number;
  active: number;
  failed: number;
  completed: number;
}

interface HealthHistory {
  snapshots: HistorySnapshot[];
  interval: string;
  totalSnapshots: number;
  windowHours: number;
}

interface ChartPoint {
  time: string;
  pending: number;
  completed: number;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function formatLatency(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  return `${seconds.toFixed(2)}s`;
}

export function deriveQueueDisplayStatus(health: WorkerHealth | null): QueueDisplayStatus {
  if (!health || typeof health.workerActive !== 'boolean') return 'unknown';
  if (!health.workerActive) return 'offline';
  if (!health.queueStats || !['healthy', 'degraded', 'critical'].includes(health.queueHealth)) return 'unknown';
  if (health.queueHealth === 'critical') return 'critical';
  if (health.queueHealth === 'degraded') return 'degraded';
  const { pending, active, failed, failedInLast24h } = health.queueStats;
  if (![pending, active, failed, failedInLast24h].every(Number.isFinite)) return 'unknown';
  return pending === 0 && active === 0 && failed === 0 && failedInLast24h === 0 ? 'idle' : 'healthy';
}

function latencyStatus(pickupLatency: PickupLatency | null): 'healthy' | 'degraded' | 'critical' | undefined {
  return pickupLatency?.status;
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ─── Sub-components ──────────────────────────────────────────────────────── */

function StatusDot({ health }: { health: QueueDisplayStatus }) {
  const cls =
    health === 'offline' || health === 'unavailable' || health === 'critical'
      ? 'bg-red-500 animate-pulse'
      : health === 'unknown' || health === 'degraded'
        ? 'bg-amber-500'
        : health === 'idle'
          ? 'bg-slate-400'
          : 'bg-green-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

function HealthLabel({ health }: { health: QueueDisplayStatus }) {
  const cls =
    health === 'offline' || health === 'unavailable' || health === 'critical'
      ? 'text-red-400'
      : health === 'unknown' || health === 'degraded'
        ? 'text-amber-400'
        : health === 'idle'
          ? 'text-muted'
          : 'text-green-400';
  return <span className={`font-medium capitalize ${cls}`}>{health}</span>;
}
function QueueUnavailableState({
  status,
  message,
  onRetry,
}: {
  status: 'unknown' | 'unavailable';
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="bg-panel border border-red-500/30 rounded-lg p-4">
      <div className="flex items-center gap-2 text-sm">
        <StatusDot health={status} />
        <HealthLabel health={status} />
        <span className="text-muted">{message}</span>
        <button onClick={onRetry} className="ml-auto text-xs text-accent hover:underline flex items-center gap-1">
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    </div>
  );
}

/* ─── Trend indicator (compare current p95 vs 1h-ago snapshot) ────────────── */

function LatencyTrend({
  currentP95,
  history,
}: {
  currentP95: number | null;
  history: HistorySnapshot[];
}) {
  if (currentP95 === null || history.length === 0) return null;

  // Find snapshot ~1h ago
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const older = history.filter(s => new Date(s.capturedAt).getTime() <= oneHourAgo);
  if (older.length === 0) return null;

  // We use 'completed' as a proxy — not a direct p95, just directional trend
  // Actually we can compare pending depth as a rough proxy
  const oldest = older[older.length - 1];
  const latest = history[history.length - 1];

  const prevPending = oldest.pending;
  const curPending = latest.pending;

  if (curPending > prevPending + 1) {
    return (
      <span className="flex items-center gap-0.5 text-amber-400 text-xs">
        <TrendingUp size={12} />
        <span>queue growing</span>
      </span>
    );
  }
  if (curPending < prevPending - 1) {
    return (
      <span className="flex items-center gap-0.5 text-green-400 text-xs">
        <TrendingDown size={12} />
        <span>queue draining</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-0.5 text-muted text-xs">
      <Minus size={12} />
      <span>stable</span>
    </span>
  );
}

/* ─── Main component ──────────────────────────────────────────────────────── */

export default function QueueHealthPanel() {
  const navigate = useNavigate();

  const [health, setHealth] = useState<WorkerHealth | null>(null);
  const [historyData, setHistoryData] = useState<HealthHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Fetch worker health ─────────────────────────────────────────────────── */
  const fetchHealth = useCallback(async () => {
    try {
      const data = await apiFetch<WorkerHealth>('/api/pipeline/worker/health');
      const state = deriveQueueDisplayStatus(data);
      if (state === 'unknown') {
        setHealth(null);
        setError('unknown');
        setExpanded(true);
        return;
      }
      setHealth(data);
      setError(null);
      setLastRefreshed(new Date());

      // Auto-expand whenever the queue is not actively healthy or idle.
      if (!['healthy', 'idle'].includes(state)) {
        setExpanded(true);
      }
    } catch {
      setHealth(null);
      setError('unavailable');
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const data = await apiFetch<HealthHistory>('/api/pipeline/queue/health-history?hours=24');
      setHistoryData(data);
      setHistoryError(null);
    } catch (error) {
      setHistoryData(null);
      setHistoryError(error instanceof Error ? error.message : 'Queue history request failed');
    }
  }, []);

  /* ── Poll every 30s ──────────────────────────────────────────────────────── */
  useEffect(() => {
    fetchHealth();
    fetchHistory();

    intervalRef.current = setInterval(() => {
      fetchHealth();
      fetchHistory();
    }, 30_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchHealth, fetchHistory]);

  /* ── React immediately to queue_failed_jobs_detected SSE events ─────────── */
  useWalSSE((event) => {
    if (event.event_type === 'queue_failed_jobs_detected') {
      fetchHealth();
      setExpanded(true);
    }
  });

  /* ── Derived chart data ──────────────────────────────────────────────────── */
  const chartData: ChartPoint[] = (historyData?.snapshots ?? []).map(s => ({
    time: formatTime(s.capturedAt),
    pending: s.pending,
    completed: s.completed,
  }));

  /* ── Render: loading state ───────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted text-xs py-2">
        <Loader2 size={12} className="animate-spin" />
        Loading queue health…
      </div>
    );
  }

  /* ── Render: unavailable or unknown contract ─────────────────────────────── */
  if (error === 'unavailable' || (!health && error !== 'unknown')) {
    return (
      <QueueUnavailableState
        status="unavailable"
        message="Queue health unavailable — the health request failed, so no status or zero metrics are shown."
        onRetry={() => { setLoading(true); void fetchHealth(); }}
      />
    );
  }
  if (error === 'unknown' || !health) {
    return (
      <QueueUnavailableState
        status="unknown"
        message="Queue health unknown — the worker response did not satisfy the health contract."
        onRetry={() => { setLoading(true); void fetchHealth(); }}
      />
    );
  }

  const { queueHealth, queueStats } = health;
  const { pending, active, failed, completed24h, failedInLast24h, pickupLatency, queues } = queueStats;
  const displayStatus = deriveQueueDisplayStatus(health);
  const isIdle = displayStatus === 'idle';

  /* ── Render: idle collapsed state ───────────────────────────────────────── */
  if (isIdle && !expanded) {
    return (
      <div className="bg-panel border border-border rounded-lg px-4 py-2.5">
        <button
          onClick={() => setExpanded(true)}
          className="w-full flex items-center gap-2 text-sm"
        >
          <StatusDot health={displayStatus} />
          <span className="text-muted">Queue:</span>
          <HealthLabel health={displayStatus} />
          <span className="ml-auto text-muted text-xs flex items-center gap-1">
            <ChevronRight size={12} />
          </span>
        </button>
      </div>
    );
  }

  /* ── Render: full widget ─────────────────────────────────────────────────── */
  return (
    <div className="bg-panel border border-border rounded-lg overflow-hidden">
      {/* ── Status bar ─────────────────────────────────────────────────────── */}
      <div className="px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Collapse toggle */}
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-2 text-sm"
          >
            <StatusDot health={displayStatus} />
            <span className="text-muted">Queue:</span>
            <HealthLabel health={displayStatus} />
            {expanded ? <ChevronDown size={12} className="text-muted" /> : <ChevronRight size={12} className="text-muted" />}
          </button>

          {/* Stat pills */}
          <div className="flex items-center gap-1.5 flex-wrap ml-2">
            <StatPill label={`${pending} pending`} />
            <StatPill label={`${active} active`} />
            <StatPill
              label={`${failedInLast24h} failed (24h)`}
              variant={failedInLast24h > 0 ? 'warn' : 'default'}
            />
            <StatPill label={`${completed24h} completed (24h)`} variant="ok" />
          </div>

          {/* Refresh */}
          <button
            onClick={() => { fetchHealth(); fetchHistory(); }}
            className="ml-auto text-muted hover:text-[var(--text)] flex items-center gap-1 text-xs"
          >
            <RefreshCw size={12} />
            {lastRefreshed && (
              <span>{lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            )}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Status combines the worker heartbeat with queue backlog and failures. Idle requires an active worker and no pending, active, failed, or recently failed jobs.
        </p>
        {displayStatus === 'offline' && (
          <div role="alert" className="mt-2 flex items-center gap-2 text-xs bg-red-500/10 border border-red-500/30 rounded px-3 py-1.5">
            <WifiOff size={13} className="text-red-400 shrink-0" />
            <span className="text-red-300">Worker heartbeat is inactive; queue processing is offline even though queue statistics remain reachable.</span>
          </div>
        )}

        {/* Critical banner */}
        {queueHealth === 'critical' && displayStatus === 'critical' && (
          <div className="mt-2 flex items-center gap-2 text-xs bg-amber-500/10 border border-amber-500/30 rounded px-3 py-1.5">
            <AlertTriangle size={13} className="text-amber-400 animate-pulse shrink-0" />
            <span className="text-amber-300">
              {failed > 0
                ? `Queue alert: ${failed} job${failed === 1 ? '' : 's'} currently failed`
                : `Queue alert: ${failedInLast24h} failure${failedInLast24h === 1 ? '' : 's'} in the last 24 hours`}
            </span>
          </div>
        )}
      </div>

      {/* ── Expanded body ─────────────────────────────────────────────────── */}
      {expanded && (
        <div className="p-4 space-y-4">
          {/* Per-queue breakdown table */}
          {queues.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
                Per-queue breakdown
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted border-b border-border">
                      <th className="text-left pb-1.5 pr-4 font-medium">Queue</th>
                      <th className="text-right pb-1.5 px-3 font-medium">Pending</th>
                      <th className="text-right pb-1.5 px-3 font-medium">Active</th>
                      <th className="text-right pb-1.5 pl-3 font-medium">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queues.map(q => (
                      <tr key={q.name} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-4 font-mono text-[11px] text-muted">{q.name}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{q.pending}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{q.active}</td>
                        <td className={`py-1.5 pl-3 text-right tabular-nums ${q.failed > 0 ? 'text-amber-400 font-medium' : ''}`}>
                          {q.failed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pickup latency card */}
          <div>
            <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
              Pickup latency
            </h4>
            {pickupLatency && pickupLatency.sampleCount > 0 ? (
              <div className="bg-panel-alt border border-border rounded p-3">
                <div className="flex items-center gap-4 flex-wrap">
                  <LatencyStat label="Avg" value={formatLatency(pickupLatency.avgSeconds)} />
                  <LatencyStat label="P50" value={formatLatency(pickupLatency.p50Seconds)} />
                  <LatencyStat
                    label="P95"
                    value={formatLatency(pickupLatency.p95Seconds)}
                    status={latencyStatus(pickupLatency)}
                  />
                  <div className="ml-auto flex items-center gap-2">
                    <LatencyTrend
                      currentP95={pickupLatency.p95Seconds}
                      history={historyData?.snapshots ?? []}
                    />
                    <span className="text-muted text-xs">
                      {pickupLatency.sampleCount} sample{pickupLatency.sampleCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted italic">No pickup latency data yet (requires completed jobs)</p>
            )}
          </div>

          {historyError && (
            <div role="alert" className="text-xs text-amber-300">
              Queue history unavailable: {historyError}. No throughput trend is shown.
            </div>
          )}
          {/* Throughput chart */}
          {chartData.length > 1 && (
            <div>
              <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
                Throughput — last 24h
              </h4>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--panel)',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                        fontSize: '11px',
                      }}
                    />
                    <Legend
                      iconSize={8}
                      wrapperStyle={{ fontSize: '11px' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="pending"
                      name="Pending jobs"
                      stroke="#f59e0b"
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{ r: 3 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="completed"
                      name="Completed jobs"
                      stroke="#10b981"
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Failed jobs drill-down */}
          {failedInLast24h > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate('/settings/system')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 transition-colors"
              >
                <AlertTriangle size={12} />
                {failedInLast24h} failed job{failedInLast24h !== 1 ? 's' : ''} — view dead-letter queue
              </button>
            </div>
          )}

          {/* Failed DLQ depth note */}
          {failed > 0 && (
            <div className="text-xs text-muted">
              <span className="text-amber-400 font-medium">{failed}</span> job{failed !== 1 ? 's' : ''} currently in failed state
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Tiny helper components ──────────────────────────────────────────────── */

function StatPill({
  label,
  variant = 'default',
}: {
  label: string;
  variant?: 'default' | 'warn' | 'ok';
}) {
  const cls =
    variant === 'warn'
      ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
      : variant === 'ok'
        ? 'bg-green-500/10 text-green-400 border-green-500/20'
        : 'bg-surface-100 text-muted border-border';
  return (
    <span className={`px-2 py-0.5 rounded border text-xs tabular-nums ${cls}`}>
      {label}
    </span>
  );
}

function LatencyStat({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: 'healthy' | 'degraded' | 'critical';
}) {
  const valCls =
    status === 'critical'
      ? 'text-red-400'
      : status === 'degraded'
        ? 'text-amber-400'
        : 'text-[var(--text)]';
  return (
    <div className="flex flex-col items-center min-w-[48px]">
      <span className="text-[10px] text-muted uppercase tracking-wide">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${valCls}`}>{value}</span>
    </div>
  );
}
