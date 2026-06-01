/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, AlertCircle, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { Github } from '../../components/icons/GithubIcon';
import { apiFetch } from '../../lib/apiFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const IntegrationHealthDashboard = lazy(() => import('./IntegrationHealthDashboard'));

// ─── Types ────────────────────────────────────────────────────────────────────

type IntegrationStatusKind = 'connected' | 'disconnected' | 'error' | 'coming_soon';

interface IntegrationStatus {
  provider: string;
  status: IntegrationStatusKind;
  connectedAt: string | null;
  username: string | null;
  avatarUrl: string | null;
  orgName: string | null;
}

// ─── Provider metadata ────────────────────────────────────────────────────────

interface ProviderMeta {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: React.ComponentType<any>;
  configTab: string;
}

function LinearIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} fill="currentColor" aria-hidden="true">
      <path d="M1.225 61.523c-.222-.949.907-1.546 1.596-.857l36.513 36.513c.689.689.091 1.819-.857 1.596C20.051 94.452 5.548 79.948 1.225 61.523ZM.002 46.889c-.018.312.092.618.287.852L52.26 99.713c.234.195.54.304.851.287C58.578 99.694 64.216 98.547 69.4 96.5c.333-.128.566-.434.575-.797.01-.363-.207-.7-.535-.851L3.874 1.602C1.586 8.5.205 17.46.002 46.889ZM7.473 22.652L77.323 92.5c.267.267.648.375 1.01.283 3.992-1.02 7.79-2.523 11.339-4.457.396-.215.609-.663.523-1.104-.086-.44-.434-.785-.88-.857L4.64 17.965c-.44-.072-.89.127-1.105.523-1.934 3.549-3.436 7.347-4.457 11.34-.092.362 0 .742.267 1.009l8.128-8.185ZM51.55 1.902L98.098 48.45c.32.32.413.803.233 1.218C96.566 52.816 94.516 56.2 91.17 59.547L40.453 8.83c3.347-3.347 6.731-5.396 9.879-7.162.415-.18.898-.086 1.218.234Z"/>
    </svg>
  );
}

function VercelIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 76 65" className={className} fill="currentColor" aria-hidden="true">
      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
    </svg>
  );
}

function SlackIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  );
}

const PROVIDERS: Record<string, ProviderMeta> = {
  github: {
    name: 'GitHub',
    description: 'Issue → spec import, auto PR on completion, commit status checks per story.',
    icon: Github,
    configTab: 'github',
  },
  linear: {
    name: 'Linear',
    description: 'Import Linear issues as specs, sync story progress, auto-update parent issues.',
    icon: LinearIcon,
    configTab: 'linear',
  },
  vercel: {
    name: 'Vercel',
    description: 'Auto-deploy on run completion, preview URLs in Run View, production promote.',
    icon: VercelIcon,
    configTab: 'vercel',
  },
  slack: {
    name: 'Slack',
    description: 'Run notifications, spec approval via interactive buttons, failure alerts.',
    icon: SlackIcon,
    configTab: 'slack',
  },
};

const PROVIDER_ORDER = ['github', 'linear', 'vercel', 'slack'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Skeleton card ────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-border bg-surface-50 p-5 animate-pulse">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-surface-200" />
        <div className="flex-1">
          <div className="h-4 w-24 rounded bg-surface-200 mb-1.5" />
          <div className="h-3 w-40 rounded bg-surface-100" />
        </div>
        <div className="h-5 w-20 rounded-full bg-surface-200" />
      </div>
      <div className="h-3 w-full rounded bg-surface-100 mb-1.5" />
      <div className="h-3 w-3/4 rounded bg-surface-100" />
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: IntegrationStatusKind }) {
  if (status === 'connected') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/10 text-green-400 border border-green-500/20">
        <CheckCircle2 size={10} />
        Connected
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
        <XCircle size={10} />
        Error
      </span>
    );
  }
  if (status === 'coming_soon') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-surface-200 text-muted border border-border">
        <Clock size={10} />
        Coming Soon
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-surface-100 text-muted/70 border border-border">
      Disconnected
    </span>
  );
}

// ─── Integration card ─────────────────────────────────────────────────────────

interface IntegrationCardProps {
  integration: IntegrationStatus;
  meta: ProviderMeta;
  onConfigure: (tab: string) => void;
}

function IntegrationCard({ integration, meta, onConfigure }: IntegrationCardProps) {
  const { status, connectedAt, username, avatarUrl, orgName } = integration;
  const Icon = meta.icon;
  const isComingSoon = status === 'coming_soon';
  const isConnected = status === 'connected';

  return (
    <div
      className={`rounded-lg border p-5 transition-colors ${
        isComingSoon
          ? 'border-border bg-surface-50 opacity-50 pointer-events-none select-none'
          : isConnected
          ? 'border-accent/30 bg-surface-50 hover:border-accent/50'
          : 'border-border bg-surface-50 hover:border-border/80'
      }`}
    >
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-lg border border-border bg-surface-100 flex items-center justify-center shrink-0">
          <Icon size={20} className="text-[var(--text)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-[var(--text)]">{meta.name}</h3>
            <StatusBadge status={status} />
          </div>
          {isConnected && (
            <div className="flex items-center gap-2 mt-1">
              {avatarUrl && (
                <img
                  src={avatarUrl}
                  alt={username ?? 'avatar'}
                  className="w-4 h-4 rounded-full"
                />
              )}
              <span className="text-[11px] text-muted truncate">
                {orgName ? `${orgName}` : ''}
                {orgName && username ? ' · ' : ''}
                {username ? `@${username}` : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-[12px] text-muted leading-relaxed mb-4">{meta.description}</p>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2">
        <div>
          {isConnected && connectedAt && (
            <span className="text-[11px] text-muted/60">
              Last synced {formatRelativeTime(connectedAt)}
            </span>
          )}
        </div>
        {!isComingSoon && (
          <button
            onClick={() => onConfigure(meta.configTab)}
            className={`text-[12px] font-medium px-3 py-1.5 rounded transition-colors ${
              isConnected
                ? 'bg-surface-200 text-[var(--text)] hover:bg-surface-300'
                : 'bg-accent text-white hover:bg-accent/90'
            }`}
          >
            {isConnected ? 'Configure' : 'Connect'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onConnectGitHub }: { onConnectGitHub: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center mb-4">
      <div className="w-14 h-14 rounded-2xl bg-surface-100 border border-border flex items-center justify-center mb-4">
        <Github size={24} className="text-muted/60" />
      </div>
      <h3 className="text-sm font-semibold text-[var(--text)] mb-1">Connect your first integration</h3>
      <p className="text-[12px] text-muted max-w-xs mb-5">
        Start with GitHub — the launch integration. Connect a repo to enable issue → spec import and auto PR on run completion.
      </p>
      <button
        onClick={onConnectGitHub}
        className="inline-flex items-center gap-2 text-[13px] font-medium px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
      >
        <Github size={14} />
        Connect GitHub
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function IntegrationsHubTab() {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();

  const [integrations, setIntegrations] = useState<IntegrationStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchIntegrations = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setFetchError(null);
    try {
      const data = await apiFetch<IntegrationStatus[]>(
        `/api/workspaces/${workspaceId}/integrations`,
      );
      setIntegrations(data);
    } catch {
      setFetchError('Unable to load integrations — check your connection.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  const handleConfigure = useCallback(
    (tab: string) => {
      navigate(`/settings/${tab}`);
    },
    [navigate],
  );

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-48 text-muted text-sm">
        No workspace selected.
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <div className="mb-6">
          <h2 className="text-base font-semibold text-[var(--text)]">Integrations</h2>
          <p className="text-[12px] text-muted mt-0.5">Connect Rorca to your tools and services.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {PROVIDER_ORDER.map((p) => <SkeletonCard key={p} />)}
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div>
        <div className="mb-6">
          <h2 className="text-base font-semibold text-[var(--text)]">Integrations</h2>
          <p className="text-[12px] text-muted mt-0.5">Connect Rorca to your tools and services.</p>
        </div>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle size={32} className="text-red-400 mb-3" />
          <p className="text-sm text-[var(--text)] font-medium mb-1">Unable to load integrations</p>
          <p className="text-[12px] text-muted mb-4">Check your connection and try again.</p>
          <button
            onClick={fetchIntegrations}
            className="inline-flex items-center gap-2 text-[13px] font-medium px-3 py-1.5 rounded-lg bg-surface-200 text-[var(--text)] hover:bg-surface-300 transition-colors"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  const list = integrations ?? [];
  const byProvider = Object.fromEntries(list.map((i) => [i.provider, i]));
  const hasConnected = list.some((i) => i.status === 'connected');

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-base font-semibold text-[var(--text)]">Integrations</h2>
        <p className="text-[12px] text-muted mt-0.5">Connect Rorca to your tools and services.</p>
      </div>

      {!hasConnected && (
        <EmptyState onConnectGitHub={() => handleConfigure('github')} />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {PROVIDER_ORDER.map((provider) => {
          const integration: IntegrationStatus = byProvider[provider] ?? {
            provider,
            status: 'disconnected' as IntegrationStatusKind,
            connectedAt: null,
            username: null,
            avatarUrl: null,
            orgName: null,
          };
          const meta = PROVIDERS[provider];
          if (!meta) return null;
          return (
            <IntegrationCard
              key={provider}
              integration={integration}
              meta={meta}
              onConfigure={handleConfigure}
            />
          );
        })}
      </div>

      {/* Integration Health Dashboard */}
      <Suspense fallback={null}>
        <IntegrationHealthDashboard />
      </Suspense>
    </div>
  );
}

export default IntegrationsHubTab;
