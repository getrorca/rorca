/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { Activity, AlertTriangle, CheckCircle2, XCircle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { apiFetch } from '../../lib/apiFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TrendPoint {
  rate_limit_remaining: number | null;
  rate_limit_max: number | null;
  error_rate: number;
  checked_at: string;
}

interface IntegrationHealth {
  provider: string;
  status: 'healthy' | 'degraded' | 'disconnected';
  error_rate: number;
  rate_limit_remaining: number | null;
  rate_limit_max: number | null;
  consecutive_failures: number;
  last_success: string | null;
  webhook_success_rate: number;
  last_error: string | null;
  checked_at: string;
  trend: TrendPoint[];
}

interface HealthResponse {
  integrations: IntegrationHealth[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    github: 'GitHub',
    linear: 'Linear',
    vercel: 'Vercel',
    slack: 'Slack',
  };
  return labels[provider] ?? provider;
}

// ─── Status indicator ─────────────────────────────────────────────────────────

function StatusDot({ status, checking }: { status: 'healthy' | 'degraded' | 'disconnected'; checking?: boolean }) {
  const colorMap = {
    healthy: 'bg-green-500',
    degraded: 'bg-amber-500',
    disconnected: 'bg-red-500',
  };

  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${colorMap[status]} ${checking ? 'animate-pulse' : ''}`}
      aria-label={`Status: ${status}`}
    />
  );
}

function StatusBadge({ status }: { status: 'healthy' | 'degraded' | 'disconnected' }) {
  if (status === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/10 text-green-400 border border-green-500/20">
        <CheckCircle2 size={10} />
        Healthy
      </span>
    );
  }
  if (status === 'degraded') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
        <AlertTriangle size={10} />
        Degraded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
      <XCircle size={10} />
      Disconnected
    </span>
  );
}

// ─── Rate limit chart ─────────────────────────────────────────────────────────

function RateLimitChart({ trend }: { trend: TrendPoint[] }) {
  if (trend.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center text-[11px] text-muted italic">
        No trend data available yet
      </div>
    );
  }

  const chartData = trend.map((t) => ({
    time: formatTime(t.checked_at),
    remaining: t.rate_limit_remaining ?? 0,
    max: t.rate_limit_max ?? 5000,
  }));

  return (
    <div className="h-32">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <XAxis
            dataKey="time"
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--surface-100)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              fontSize: '11px',
            }}
          />
          <Line
            type="monotone"
            dataKey="remaining"
            stroke="#22c55e"
            strokeWidth={1.5}
            dot={false}
            name="Remaining"
          />
          <Line
            type="monotone"
            dataKey="max"
            stroke="var(--border)"
            strokeWidth={1}
            strokeDasharray="4 4"
            dot={false}
            name="Max"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Integration health row ──────────────────────────────────────────────────

function IntegrationHealthRow({ health, checking }: { health: IntegrationHealth; checking: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const rateLimitPct = health.rate_limit_max && health.rate_limit_remaining !== null
    ? Math.round((health.rate_limit_remaining / health.rate_limit_max) * 100)
    : null;

  return (
    <div className="border border-border rounded-lg bg-surface-50 overflow-hidden">
      {/* Summary row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-surface-100/50 transition-colors"
      >
        <StatusDot status={health.status} checking={checking} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text)]">{providerLabel(health.provider)}</span>
            <StatusBadge status={health.status} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted">
            {health.last_success && (
              <span>Last success: {formatRelativeTime(health.last_success)}</span>
            )}
            {rateLimitPct !== null && (
              <span>Rate limit: {health.rate_limit_remaining}/{health.rate_limit_max} ({rateLimitPct}%)</span>
            )}
            <span>Error rate: {(health.error_rate * 100).toFixed(1)}%</span>
          </div>
        </div>
        {expanded ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
      </button>

      {/* Expandable detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-border pt-3 space-y-4">
              {/* Stats grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-wider mb-0.5">Error Rate (24h)</div>
                  <div className="text-sm font-mono text-[var(--text)]">{(health.error_rate * 100).toFixed(1)}%</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-wider mb-0.5">Rate Limit</div>
                  <div className="text-sm font-mono text-[var(--text)]">
                    {health.rate_limit_remaining !== null ? `${health.rate_limit_remaining} / ${health.rate_limit_max}` : 'N/A'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-wider mb-0.5">Consecutive Failures</div>
                  <div className="text-sm font-mono text-[var(--text)]">{health.consecutive_failures}</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-wider mb-0.5">Webhook Success</div>
                  <div className="text-sm font-mono text-[var(--text)]">{(health.webhook_success_rate * 100).toFixed(0)}%</div>
                </div>
              </div>

              {/* Rate limit trend chart */}
              <div>
                <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Rate Limit Trend (24h)</div>
                <RateLimitChart trend={health.trend} />
              </div>

              {/* Recent errors */}
              {health.last_error && (
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-wider mb-1">Last Error</div>
                  <div className="text-[11px] font-mono text-red-400 bg-red-500/5 border border-red-500/10 rounded px-2 py-1.5 break-all">
                    {health.last_error}
                  </div>
                  {health.checked_at && (
                    <div className="text-[10px] text-muted mt-1">
                      Checked {formatRelativeTime(health.checked_at)}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyHealthState() {
  return (
    <div className="border border-border rounded-lg bg-surface-50 p-6 flex items-center gap-3">
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-400" />
      <p className="text-[12px] text-muted italic">
        No health data — waiting for first check
      </p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function IntegrationHealthDashboard() {
  const { workspaceId } = useWorkspace();
  const [data, setData] = useState<IntegrationHealth[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHealth = useCallback(async (isRefresh = false) => {
    if (!workspaceId) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const resp = await apiFetch<HealthResponse>(
        `/api/workspaces/${workspaceId}/integrations/health`,
      );
      setData(resp.integrations);
    } catch {
      setError('Unable to load integration health data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchHealth();
    // Auto-refresh every 60 seconds
    const interval = setInterval(() => fetchHealth(true), 60_000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  if (!workspaceId) return null;

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-muted" />
          <h3 className="text-sm font-semibold text-[var(--text)]">Integration Health</h3>
        </div>
        <button
          onClick={() => fetchHealth(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-[11px] text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading && !data && (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="border border-border rounded-lg bg-surface-50 p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full bg-surface-200" />
                <div className="flex-1">
                  <div className="h-4 w-20 rounded bg-surface-200 mb-1" />
                  <div className="h-3 w-48 rounded bg-surface-100" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="border border-red-500/20 rounded-lg bg-red-500/5 p-4 text-center">
          <p className="text-[12px] text-red-400">{error}</p>
          <button
            onClick={() => fetchHealth()}
            className="mt-2 text-[11px] text-muted hover:text-[var(--text)] transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && data && data.length === 0 && <EmptyHealthState />}

      {!loading && !error && data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((health) => (
            <IntegrationHealthRow
              key={health.provider}
              health={health}
              checking={refreshing}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default IntegrationHealthDashboard;
