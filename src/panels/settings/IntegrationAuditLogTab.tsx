/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { AlertCircle, RefreshCw, ChevronDown, ChevronRight, ChevronLeft } from 'lucide-react';
import { apiFetch } from '../../lib/apiFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: number;
  workspace_id: string;
  provider: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

interface AuditLogResponse {
  items: AuditEntry[];
  total: number;
  hasMore: boolean;
  page: number;
  pageSize: number;
}

const ACTION_LABELS: Record<string, string> = {
  token_created: 'Token Created',
  token_revoked: 'Token Revoked',
  token_refreshed: 'Token Refreshed',
  webhook_received: 'Webhook Received',
  webhook_processed: 'Webhook Processed',
  webhook_failed: 'Webhook Failed',
  api_call_made: 'API Call Made',
  api_call_failed: 'API Call Failed',
  integration_connected: 'Connected',
  integration_disconnected: 'Disconnected',
};

const ACTOR_LABELS: Record<string, string> = {
  user: 'User',
  system: 'System',
  webhook: 'Webhook',
};

const PROVIDER_OPTIONS = ['github', 'linear', 'vercel', 'slack'];
const ACTION_OPTIONS = [
  'integration_connected',
  'integration_disconnected',
  'token_created',
  'token_revoked',
  'token_refreshed',
  'webhook_received',
  'webhook_processed',
  'webhook_failed',
  'api_call_made',
  'api_call_failed',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function actionBadgeColor(action: string): string {
  if (action.includes('failed') || action.includes('revoked') || action === 'integration_disconnected') {
    return 'bg-red-500/10 text-red-400 border-red-500/20';
  }
  if (action.includes('connected') || action.includes('processed') || action.includes('created')) {
    return 'bg-green-500/10 text-green-400 border-green-500/20';
  }
  if (action.includes('received') || action.includes('refreshed')) {
    return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
  }
  return 'bg-surface-200 text-muted border-border';
}

// ─── Details viewer ───────────────────────────────────────────────────────────

function DetailsViewer({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details);
  if (entries.length === 0) {
    return <span className="text-muted/50 text-[11px]">—</span>;
  }

  return (
    <div className="space-y-0.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2 text-[11px]">
          <span className="text-muted/70 font-mono shrink-0">{key}:</span>
          <span className="text-[var(--text)] break-all font-mono">
            {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Expandable row ───────────────────────────────────────────────────────────

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Object.keys(entry.details).length > 0;

  return (
    <>
      <tr
        className="border-b border-border hover:bg-surface-50 cursor-pointer transition-colors"
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        <td className="px-3 py-2 text-[12px] text-muted whitespace-nowrap">
          {formatTimestamp(entry.created_at)}
        </td>
        <td className="px-3 py-2">
          <span className="text-[11px] font-medium capitalize text-[var(--text)]">
            {entry.provider}
          </span>
        </td>
        <td className="px-3 py-2">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${actionBadgeColor(entry.action)}`}>
            {ACTION_LABELS[entry.action] ?? entry.action}
          </span>
        </td>
        <td className="px-3 py-2 text-[12px] text-muted">
          {ACTOR_LABELS[entry.actor_type] ?? entry.actor_type}
          {entry.actor_id && <span className="text-muted/50 ml-1">({entry.actor_id.slice(0, 8)})</span>}
        </td>
        <td className="px-3 py-2 text-[12px]">
          {hasDetails ? (
            <button className="flex items-center gap-1 text-muted/70 hover:text-[var(--text)] transition-colors">
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="text-[11px]">{Object.keys(entry.details).length} fields</span>
            </button>
          ) : (
            <span className="text-muted/50 text-[11px]">—</span>
          )}
        </td>
      </tr>
      {expanded && hasDetails && (
        <tr className="border-b border-border">
          <td colSpan={5} className="px-6 py-3 bg-surface-50">
            <DetailsViewer details={entry.details} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Skeleton rows ────────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="border-b border-border animate-pulse">
          <td className="px-3 py-2"><div className="h-3 w-28 rounded bg-surface-200" /></td>
          <td className="px-3 py-2"><div className="h-3 w-14 rounded bg-surface-200" /></td>
          <td className="px-3 py-2"><div className="h-3 w-24 rounded bg-surface-200" /></td>
          <td className="px-3 py-2"><div className="h-3 w-16 rounded bg-surface-200" /></td>
          <td className="px-3 py-2"><div className="h-3 w-12 rounded bg-surface-200" /></td>
        </tr>
      ))}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function IntegrationAuditLogTab() {
  const { workspaceId } = useWorkspace();
  const [data, setData] = useState<AuditLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [provider, setProvider] = useState('');
  const [action, setAction] = useState('');
  const pageSize = 25;

  const fetchLog = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(pageSize) });
      if (provider) params.set('provider', provider);
      if (action) params.set('action', action);

      const result = await apiFetch<AuditLogResponse>(
        `/api/workspaces/${workspaceId}/integrations/audit-log?${params.toString()}`,
      );
      setData(result);
    } catch {
      setError('Unable to load audit log');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, page, provider, action]);

  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [provider, action]);

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-sm">
        No workspace selected.
      </div>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-base font-semibold text-[var(--text)]">Audit Log</h2>
        <p className="text-[12px] text-muted mt-0.5">
          All integration actions — connections, webhooks, token operations.
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="text-[12px] px-2.5 py-1.5 rounded border border-border bg-surface-50 text-[var(--text)] outline-none focus:border-accent"
        >
          <option value="">All providers</option>
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
          ))}
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="text-[12px] px-2.5 py-1.5 rounded border border-border bg-surface-50 text-[var(--text)] outline-none focus:border-accent"
        >
          <option value="">All actions</option>
          {ACTION_OPTIONS.map((a) => (
            <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
          ))}
        </select>
        <button
          onClick={fetchLog}
          className="ml-auto flex items-center gap-1.5 text-[12px] text-muted hover:text-[var(--text)] transition-colors"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle size={32} className="text-red-400 mb-3" />
          <p className="text-sm text-[var(--text)] font-medium mb-1">Unable to load audit log</p>
          <p className="text-[12px] text-muted mb-4">Check your connection and try again.</p>
          <button
            onClick={fetchLog}
            className="inline-flex items-center gap-2 text-[13px] font-medium px-3 py-1.5 rounded-lg bg-surface-200 text-[var(--text)] hover:bg-surface-300 transition-colors"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      {!error && (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-surface-50 border-b border-border">
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Timestamp</th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Provider</th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Action</th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Actor</th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Details</th>
              </tr>
            </thead>
            <tbody>
              {loading && <SkeletonRows />}
              {!loading && data && data.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-12 text-center">
                    <p className="text-sm text-muted">No integration activity yet</p>
                  </td>
                </tr>
              )}
              {!loading && data && data.items.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {!error && data && data.total > pageSize && (
        <div className="flex items-center justify-between mt-3 text-[12px] text-muted">
          <span>
            {data.total} entries · Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default IntegrationAuditLogTab;
