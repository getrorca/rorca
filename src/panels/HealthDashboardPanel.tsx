/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { HeartPulse, Database, Clock, Cpu, HardDrive, FileText, RefreshCw, AlertTriangle, CheckCircle, ShieldCheck, ChevronDown, ChevronRight, Loader2, Network, Braces, Search, Zap } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { BASE_URL, apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';

interface HealthBasic {
  status: string;
  version: string;
  uptime: number;
  db_connected: boolean;
  active_runs: number;
  authRequired?: boolean;
}

interface HealthDetailed extends HealthBasic {
  db_size: number;
  pending_specs_count: number;
  memory_usage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  last_backup_at: string | null;
}

interface HistoryPoint {
  time: string;
  timestamp: number;
  status: string;
  uptime: number;
  heapUsed: number;
  activeRuns: number;
  dbConnected: boolean;
}

interface SemanticStats {
  graphAvailable: boolean;
  vertices: number;
  edges: number;
  embeddings: { total: number; specs: number; stories: number; memories: number };
  searchMode: 'hybrid' | 'keyword-only';
}

interface DriftViolation {
  file: string;
  line: number;
  convention: string;
  description: string;
  severity: 'warning' | 'error';
}

interface DriftReport {
  violations: DriftViolation[];
  score: number;
  conventionsChecked: number;
  filesSampled: number;
  checkedAt: string;
}

interface DriftReportResponse {
  id: number;
  workspaceId: string;
  triggerType: string;
  report: DriftReport;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function HealthDashboardPanel() {
  const { workspaceId } = useWorkspace();
  const [health, setHealth] = useState<HealthDetailed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [pollInterval, setPollInterval] = useState(30);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drift report state
  const [driftReport, setDriftReport] = useState<DriftReport | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftExpanded, setDriftExpanded] = useState(false);

  // SW-009: Semantic engine state
  const [semantic, setSemantic] = useState<SemanticStats | null>(null);
  const [backfilling, setBackfilling] = useState(false);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/health/detailed`);
      const data = await res.json() as HealthDetailed;
      setHealth(data);
      setError(null);

      setHistory(prev => {
        const point: HistoryPoint = {
          time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
          timestamp: Date.now(),
          status: data.status,
          uptime: data.uptime,
          heapUsed: data.memory_usage.heapUsed,
          activeRuns: data.active_runs,
          dbConnected: data.db_connected,
        };
        const updated = [...prev, point];
        // Keep last 60 data points
        return updated.slice(-60);
      });
    } catch (err: any) {
      setError(err.message || 'Health check failed');
      setHistory(prev => {
        const point: HistoryPoint = {
          time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
          timestamp: Date.now(),
          status: 'unreachable',
          uptime: 0,
          heapUsed: 0,
          activeRuns: 0,
          dbConnected: false,
        };
        return [...prev, point].slice(-60);
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    timerRef.current = setInterval(fetchHealth, pollInterval * 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchHealth, pollInterval]);

  // Fetch latest drift report on mount and when workspace changes
  const fetchDriftReport = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<DriftReportResponse>(`/api/conventions/drift/${workspaceId}`);
      setDriftReport(data.report);
    } catch {
      // No report yet — not an error
      setDriftReport(null);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchDriftReport();
  }, [fetchDriftReport]);

  // Run drift check manually
  const runDriftCheck = useCallback(async () => {
    if (!workspaceId) return;
    setDriftLoading(true);
    try {
      const data = await apiFetch<{ ok: boolean; report: DriftReport }>('/api/conventions/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setDriftReport(data.report);
      setDriftExpanded(true);
    } catch {
      // Error handled silently — user sees no report update
    } finally {
      setDriftLoading(false);
    }
  }, [workspaceId]);

  // SW-009: Fetch semantic stats from workspace health endpoint
  const fetchSemantic = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<{ semantic?: SemanticStats }>(`/api/workspaces/${workspaceId}/health`);
      if (data.semantic) setSemantic(data.semantic);
    } catch {
      // Non-fatal — semantic stats just won't show
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchSemantic();
  }, [fetchSemantic]);

  const handleBackfill = useCallback(async () => {
    if (!workspaceId) return;
    setBackfilling(true);
    try {
      await apiFetch('/api/admin/embed-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      // Re-fetch after a short delay to show updated counts
      setTimeout(() => fetchSemantic(), 2000);
    } catch {
      // Error handled silently
    } finally {
      setBackfilling(false);
    }
  }, [workspaceId, fetchSemantic]);

  const statusColor = health?.status === 'healthy' ? 'text-green-400' : health?.status === 'degraded' ? 'text-yellow-400' : 'text-red-400';
  const statusBg = health?.status === 'healthy' ? 'bg-green-500/10 border-green-500/30' : health?.status === 'degraded' ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-red-500/10 border-red-500/30';

  return (
    <div
      role="main"
      aria-label="Health Dashboard"
      className="p-6 max-w-6xl mx-auto space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <HeartPulse size={24} className="text-accent" />
          <h1 className="text-xl font-bold">Health Dashboard</h1>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={pollInterval}
            onChange={e => setPollInterval(Number(e.target.value))}
            aria-label="Poll interval"
            className="bg-panel border border-border rounded px-2 py-1 text-sm"
          >
            <option value={10}>10s</option>
            <option value={30}>30s</option>
            <option value={60}>60s</option>
          </select>
          <button
            onClick={fetchHealth}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 text-accent rounded text-sm hover:bg-accent/20 transition-colors"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
          <AlertTriangle size={16} />
          Backend unreachable: {error}
        </div>
      )}

      {loading && !health ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-muted text-sm flex items-center gap-2">
            <Loader2 size={16} className="animate-spin" />
            Loading health data...
          </div>
        </div>
      ) : health ? (
        <>
          {/* Status banner */}
          <div className={`flex items-center gap-3 p-4 rounded-lg border ${statusBg}`}>
            {health.status === 'healthy' ? (
              <CheckCircle size={20} className="text-green-400" />
            ) : (
              <AlertTriangle size={20} className="text-yellow-400" />
            )}
            <div>
              <span className={`font-semibold text-lg ${statusColor}`}>
                {health.status.charAt(0).toUpperCase() + health.status.slice(1)}
              </span>
              <span className="text-muted text-sm ml-3">v{health.version}</span>
              {health.authRequired && (
                <span className="inline-flex items-center gap-1 ml-3 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                  <ShieldCheck size={12} />
                  Auth Enforced
                </span>
              )}
            </div>
          </div>

          {/* Metric cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <MetricCard
              icon={<Clock size={16} />}
              label="Uptime"
              value={formatUptime(health.uptime)}
            />
            <MetricCard
              icon={<Database size={16} />}
              label="DB Connected"
              value={health.db_connected ? 'Yes' : 'No'}
              valueClass={health.db_connected ? 'text-green-400' : 'text-red-400'}
            />
            <MetricCard
              icon={<HeartPulse size={16} />}
              label="Active Runs"
              value={String(health.active_runs)}
            />
            <MetricCard
              icon={<HardDrive size={16} />}
              label="DB Size"
              value={formatBytes(health.db_size)}
            />
            <MetricCard
              icon={<FileText size={16} />}
              label="Pending Specs"
              value={String(health.pending_specs_count)}
            />
            <MetricCard
              icon={<Cpu size={16} />}
              label="Heap Used"
              value={formatBytes(health.memory_usage.heapUsed)}
            />
          </div>

          {/* Memory detail */}
          <div className="bg-panel border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3">Memory Usage</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-muted">RSS:</span>{' '}
                <span>{formatBytes(health.memory_usage.rss)}</span>
              </div>
              <div>
                <span className="text-muted">Heap Total:</span>{' '}
                <span>{formatBytes(health.memory_usage.heapTotal)}</span>
              </div>
              <div>
                <span className="text-muted">Heap Used:</span>{' '}
                <span>{formatBytes(health.memory_usage.heapUsed)}</span>
              </div>
              <div>
                <span className="text-muted">External:</span>{' '}
                <span>{formatBytes(health.memory_usage.external)}</span>
              </div>
            </div>
            {/* Heap usage bar */}
            <div className="mt-3">
              <div className="flex justify-between text-xs text-muted mb-1">
                <span>Heap Utilization</span>
                <span>{((health.memory_usage.heapUsed / health.memory_usage.heapTotal) * 100).toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-bg rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all"
                  style={{ width: `${(health.memory_usage.heapUsed / health.memory_usage.heapTotal) * 100}%` }}
                />
              </div>
            </div>
          </div>

          {/* Last backup */}
          <div className="bg-panel border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-2">Backup Status</h2>
            <p className="text-sm">
              {health.last_backup_at ? (
                <>
                  <span className="text-green-400">Last backup:</span>{' '}
                  {formatRelativeTime(health.last_backup_at)}{' '}
                  <span className="text-muted">({new Date(health.last_backup_at).toLocaleString()})</span>
                </>
              ) : (
                <span className="text-yellow-400">No backups found</span>
              )}
            </p>
          </div>

          {/* SW-009: Semantic Engine */}
          {workspaceId && semantic && (
            <div className="bg-panel border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Network size={16} className="text-accent" />
                  <h2 className="text-sm font-semibold">Semantic Engine</h2>
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    semantic.searchMode === 'hybrid'
                      ? 'bg-green-500/15 text-green-400'
                      : 'bg-amber-500/15 text-amber-400'
                  }`}>
                    {semantic.searchMode === 'hybrid' ? 'Hybrid' : 'Keyword-only'}
                  </span>
                </div>
                {semantic.embeddings.total === 0 && (
                  <button
                    onClick={handleBackfill}
                    disabled={backfilling}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 text-accent rounded text-sm hover:bg-accent/20 transition-colors disabled:opacity-60"
                  >
                    {backfilling ? (
                      <><Loader2 size={14} className="animate-spin" /> Backfilling...</>
                    ) : (
                      <><Zap size={14} /> Backfill Now</>
                    )}
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                {/* Graph stats */}
                <div>
                  <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
                    <Braces size={12} />
                    Graph
                  </div>
                  {semantic.graphAvailable ? (
                    <span className="font-medium">
                      {semantic.vertices} nodes, {semantic.edges} edges
                    </span>
                  ) : (
                    <span className="text-muted">Not available</span>
                  )}
                </div>

                {/* Embedding total */}
                <div>
                  <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
                    <Database size={12} />
                    Embeddings
                  </div>
                  {semantic.embeddings.total > 0 ? (
                    <span className="font-medium">{semantic.embeddings.total} vectors</span>
                  ) : (
                    <span className="text-muted">No embeddings</span>
                  )}
                </div>

                {/* Breakdown */}
                <div>
                  <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
                    <FileText size={12} />
                    Breakdown
                  </div>
                  {semantic.embeddings.total > 0 ? (
                    <span className="font-medium text-xs">
                      {semantic.embeddings.specs} specs, {semantic.embeddings.stories} stories, {semantic.embeddings.memories} memories
                    </span>
                  ) : (
                    <span className="text-muted">&mdash;</span>
                  )}
                </div>

                {/* Search mode */}
                <div>
                  <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
                    <Search size={12} />
                    Search Mode
                  </div>
                  <span className={`font-medium ${
                    semantic.searchMode === 'hybrid' ? 'text-green-400' : 'text-amber-400'
                  }`}>
                    {semantic.searchMode === 'hybrid' ? 'Hybrid (vector + keyword)' : 'Keyword-only'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Convention Compliance */}
          {workspaceId && (
            <div className="bg-panel border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={16} className={
                    driftReport
                      ? driftReport.score >= 80 ? 'text-green-400' : driftReport.score >= 50 ? 'text-yellow-400' : 'text-red-400'
                      : 'text-muted'
                  } />
                  <h2 className="text-sm font-semibold">Convention Compliance</h2>
                  {driftReport && (
                    <span
                      aria-label={`Convention compliance: ${driftReport.score}%`}
                      className={`text-xs font-medium tabular-nums px-1.5 py-0.5 rounded ${
                        driftReport.score >= 80 ? 'bg-green-500/15 text-green-400' :
                        driftReport.score >= 50 ? 'bg-yellow-500/15 text-yellow-400' :
                        'bg-red-500/15 text-red-400'
                      }`}
                    >
                      {driftReport.score}%
                    </span>
                  )}
                </div>
                <button
                  onClick={runDriftCheck}
                  disabled={driftLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 text-accent rounded text-sm hover:bg-accent/20 transition-colors disabled:opacity-60"
                >
                  {driftLoading ? (
                    <><Loader2 size={14} className="animate-spin" /> Checking...</>
                  ) : (
                    <><RefreshCw size={14} /> Run Check</>
                  )}
                </button>
              </div>

              {driftReport ? (
                <>
                  {/* Summary row */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-3">
                    <div>
                      <span className="text-muted">Total Violations:</span>{' '}
                      <span className="font-medium">{driftReport.violations.length}</span>
                    </div>
                    <div>
                      <span className="text-muted">Errors:</span>{' '}
                      <span className="font-medium text-red-400">
                        {driftReport.violations.filter(v => v.severity === 'error').length}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted">Warnings:</span>{' '}
                      <span className="font-medium text-yellow-400">
                        {driftReport.violations.filter(v => v.severity === 'warning').length}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted">Last checked:</span>{' '}
                      <span>{formatRelativeTime(driftReport.checkedAt)}</span>
                    </div>
                  </div>

                  {/* Compliance bar */}
                  <div className="mb-3">
                    <div className="flex justify-between text-xs text-muted mb-1">
                      <span>Compliance Score</span>
                      <span>{driftReport.score}% ({driftReport.conventionsChecked} conventions, {driftReport.filesSampled} files sampled)</span>
                    </div>
                    <div className="h-2 bg-bg rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          driftReport.score >= 80 ? 'bg-green-500' : driftReport.score >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${driftReport.score}%` }}
                      />
                    </div>
                  </div>

                  {/* Expandable violation list */}
                  {driftReport.violations.length > 0 && (
                    <div>
                      <button
                        onClick={() => setDriftExpanded(!driftExpanded)}
                        className="flex items-center gap-1.5 text-xs text-muted hover:text-[var(--text)] transition-colors"
                      >
                        {driftExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {driftReport.violations.length} violation{driftReport.violations.length !== 1 ? 's' : ''} found
                      </button>

                      {driftExpanded && (
                        <ul
                          role="list"
                          aria-label="Convention violations"
                          className="mt-2 space-y-1 max-h-64 overflow-y-auto"
                        >
                          {driftReport.violations.map((v, i) => (
                            <li
                              key={i}
                              role="listitem"
                              className="flex items-start gap-2 p-2 rounded bg-bg/50 text-sm"
                            >
                              <span className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                v.severity === 'error'
                                  ? 'bg-red-500/20 text-red-400'
                                  : 'bg-yellow-500/20 text-yellow-400'
                              }`}>
                                {v.severity}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="font-mono text-muted truncate">{v.file}:{v.line}</span>
                                  <span className="text-accent shrink-0">{v.convention}</span>
                                </div>
                                <p className="text-xs text-muted mt-0.5">{v.description}</p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {driftReport.violations.length === 0 && (
                    <div className="flex items-center gap-2 text-sm text-green-400">
                      <CheckCircle size={14} />
                      No violations found — code matches declared conventions.
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted">
                  No drift report yet. Click &quot;Run Check&quot; to scan for convention violations.
                </p>
              )}
            </div>
          )}

          {/* Uptime history chart */}
          {history.length > 1 && (
            <div className="bg-panel border border-border rounded-lg p-4">
              <h2 className="text-sm font-semibold mb-3">Uptime History</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Status timeline */}
                <div>
                  <h3 className="text-xs text-muted mb-2">Health Status</h3>
                  <div className="flex gap-1 flex-wrap">
                    {history.map((p, i) => (
                      <div
                        key={i}
                        title={`${p.time}: ${p.status}`}
                        className={`w-3 h-6 rounded-sm ${
                          p.status === 'healthy' ? 'bg-green-500' :
                          p.status === 'degraded' ? 'bg-yellow-500' :
                          'bg-red-500'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="flex gap-4 mt-2 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-sm bg-green-500 inline-block" /> Healthy
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-sm bg-yellow-500 inline-block" /> Degraded
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-sm bg-red-500 inline-block" /> Unreachable
                    </span>
                  </div>
                </div>

                {/* Memory trend */}
                <div>
                  <h3 className="text-xs text-muted mb-2">Heap Memory (MB)</h3>
                  <ResponsiveContainer width="100%" height={120}>
                    <LineChart data={history}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="time" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                        tickFormatter={v => (v / (1024 * 1024)).toFixed(0)}
                      />
                      <Tooltip
                        contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12 }}
                        formatter={(value) => [`${formatBytes(value as number)}`, 'Heap Used']}
                        labelFormatter={label => `Time: ${label}`}
                      />
                      <Line
                        type="monotone"
                        dataKey="heapUsed"
                        stroke="var(--accent)"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* Health check log (recent checks table) */}
          {history.length > 0 && (
            <div className="bg-panel border border-border rounded-lg p-4">
              <h2 className="text-sm font-semibold mb-3">Recent Checks</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted text-left border-b border-border">
                      <th className="pb-2 pr-4">Time</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">DB</th>
                      <th className="pb-2 pr-4">Runs</th>
                      <th className="pb-2">Heap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...history].reverse().slice(0, 10).map((p, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-1.5 pr-4 text-muted">{p.time}</td>
                        <td className="py-1.5 pr-4">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${
                            p.status === 'healthy' ? 'bg-green-500/20 text-green-400' :
                            p.status === 'degraded' ? 'bg-yellow-500/20 text-yellow-400' :
                            'bg-red-500/20 text-red-400'
                          }`}>
                            {p.status}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4">
                          {p.dbConnected ? (
                            <CheckCircle size={14} className="text-green-400" />
                          ) : (
                            <AlertTriangle size={14} className="text-red-400" />
                          )}
                        </td>
                        <td className="py-1.5 pr-4">{p.activeRuns}</td>
                        <td className="py-1.5">{p.heapUsed > 0 ? formatBytes(p.heapUsed) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center py-16">
          <div className="flex flex-col items-center text-center max-w-md px-6">
            <HeartPulse size={48} className="text-[var(--text-muted)] opacity-40 mb-4" />
            <h3 className="text-lg font-semibold text-[var(--text)] mb-2">Health data unavailable</h3>
            <p className="text-sm text-[var(--text-muted)]">
              Unable to load workspace health data. Make sure a workspace is selected and the backend is running.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, valueClass }: { icon: React.ReactNode; label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-panel border border-border rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-lg font-semibold ${valueClass || ''}`}>{value}</div>
    </div>
  );
}
