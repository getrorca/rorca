/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../../lib/apiFetch';

interface ByteMetric {
  labels: { byte_class: string; component: string };
  bytes: number;
}
interface PtyHealth {
  status: 'healthy' | 'degraded';
  schema: { supported: boolean; diagnostic: string };
  controls: Record<string, boolean>;
  byteMetrics: ByteMetric[];
  retainedReplayBytes?: number;
  checkpointAgeMs?: number | null;
  replayLatencyMs?: number | null;
  transcriptLagMs?: number | null;
  archiveIntegrity?: { completeSegments: number; missingSegments: number; corruptSegments: number };
  storageBytes?: Record<string, number>;
  capturedAt: string;
}

function formatBytes(value: number | undefined): string {
  if (!value) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** exponent)).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}
function formatDuration(value: number | null | undefined): string {
  if (value == null) return 'Unavailable';
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
}

export default function PtyRecoverySettingsTab() {
  const [health, setHealth] = useState<PtyHealth | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setHealth(await apiFetch<PtyHealth>('/api/pty-operations/health', { silent: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'PTY recovery health is unavailable.');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const dryRunRetention = async () => {
    setBusy(true);
    try {
      const result = await apiFetch<{ pruned: Record<string, number> }>('/api/pty-operations/retention', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true }), silent: true,
      });
      setDrill(`Retention dry run: ${Object.entries(result.pruned).map(([key, count]) => `${key} ${count}`).join(', ')}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Retention dry run failed.'); }
    finally { setBusy(false); }
  };
  const simulateRollback = async () => {
    setBusy(true);
    try {
      const result = await apiFetch<{ expectedPresentation: string; mutationPerformed: boolean }>('/api/pty-operations/rollback/simulate', {
        method: 'POST', silent: true,
      });
      setDrill(`Rollback simulation: ${result.expectedPresentation}; mutation performed: ${String(result.mutationPerformed)}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Rollback simulation failed.'); }
    finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="pty-recovery-heading" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="pty-recovery-heading" className="text-lg font-semibold text-[var(--text)]">PTY recovery operations</h2>
          <p className="mt-1 text-sm text-muted">Content-free health, independent retention, and non-destructive rollback evidence.</p>
        </div>
        <button onClick={() => void refresh()} disabled={busy} className="inline-flex items-center gap-2 rounded border border-border bg-panel px-3 py-2 text-sm text-[var(--text)] hover:bg-surface-100 disabled:opacity-50">
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <div role="alert" className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger"><AlertTriangle size={15} className="mr-2 inline" />{error}</div>}
      {health && (
        <>
          <div className="rounded border border-border bg-panel p-4">
            <div className="flex items-center gap-2 font-medium text-[var(--text)]"><ShieldCheck size={16} />{health.status === 'healthy' ? 'Healthy' : 'Degraded'}</div>
            <p className="mt-1 text-xs text-muted">{health.schema.diagnostic}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <span className="text-xs text-muted">Checkpoint age <strong className="block text-sm text-[var(--text)]">{formatDuration(health.checkpointAgeMs)}</strong></span>
              <span className="text-xs text-muted">Replay latency <strong className="block text-sm text-[var(--text)]">{formatDuration(health.replayLatencyMs)}</strong></span>
              <span className="text-xs text-muted">Transcript lag <strong className="block text-sm text-[var(--text)]">{formatDuration(health.transcriptLagMs)}</strong></span>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {health.byteMetrics.map(metric => <div key={metric.labels.byte_class} className="rounded border border-border bg-panel p-3"><span className="text-xs uppercase tracking-wide text-muted">{metric.labels.byte_class}</span><strong className="block text-lg text-[var(--text)]">{formatBytes(metric.bytes)}</strong></div>)}
            <div className="rounded border border-border bg-panel p-3"><span className="text-xs uppercase tracking-wide text-muted">retained replay</span><strong className="block text-lg text-[var(--text)]">{formatBytes(health.retainedReplayBytes)}</strong></div>
          </div>
          <div className="rounded border border-border bg-panel p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--text)]"><Database size={15} />Feature controls (request-time)</div>
            <dl className="mt-2 grid gap-2 sm:grid-cols-3">{Object.entries(health.controls).map(([name, enabled]) => <div key={name}><dt className="text-xs text-muted">{name}</dt><dd className="text-sm text-[var(--text)]">{enabled ? 'Enabled' : 'Disabled'}</dd></div>)}</dl>
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void dryRunRetention()} disabled={busy} className="rounded bg-accent px-3 py-2 text-sm font-medium text-[var(--accent-contrast)] disabled:opacity-50">Retention dry run</button>
        <button onClick={() => void simulateRollback()} disabled={busy} className="rounded border border-border bg-panel px-3 py-2 text-sm text-[var(--text)] disabled:opacity-50">Simulate legacy rollback</button>
      </div>
      {drill && <p role="status" className="rounded bg-surface-100 p-3 text-sm text-muted">{drill}</p>}
    </section>
  );
}
