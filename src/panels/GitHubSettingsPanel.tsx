/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useDeferredValue, useRef } from 'react';
import {
  Link2, Unlink, Loader2, CheckCircle2, AlertCircle,
  Webhook, FileText, RotateCcw, Shield, ExternalLink,
  RefreshCw, KeyRound, RadioTower, Lock, Copy,
} from 'lucide-react';
import { Github } from '../components/icons/GithubIcon';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import {
  apiFetch,
  apiFetchProviderMutation,
  clearOperatorCapability,
  hasOperatorCapability,
  onOperatorCapabilityLocked,
  setOperatorCapability,
  BASE_URL,
} from '../lib/apiFetch';
import AutonomousDeliverySettings from '../components/AutonomousDeliverySettings';

// ─── PR Template (duplicated from backend/src/lib/github/pr-template.ts) ──────

const DEFAULT_PR_TEMPLATE = `## Summary

{{spec.brief}}

## Stories

{{run.storiesPassed}}/{{run.storiesTotal}} stories passed

| Outcome | Count |
|---------|-------|
| ✅ Passed | {{run.storiesPassed}} |
| ❌ Failed | {{run.storiesFailed}} |
| ⏭ Skipped | {{run.storiesSkipped}} |

## Changes

\`\`\`
{{run.diffStats}}
\`\`\`

## Token Usage

| Metric | Value |
|--------|-------|
| Input tokens | {{run.tokensInput}} |
| Output tokens | {{run.tokensOutput}} |
| Total tokens | {{run.tokensTotal}} |
| Estimated cost | {{run.costUsd}} |

## Run Details

| Field | Value |
|-------|-------|
| Run ID | {{run.id}} |
| Duration | {{run.duration}} |
| Agent | {{run.agentType}} |
| Model | {{run.model}} |
| Spec | {{spec.title}} |

---
*Generated automatically by [Rorca](https://rorca.app)*`;

const SAMPLE_DATA: Record<string, string> = {
  'spec.title': 'rorca-go-to-market-v1',
  'spec.brief': 'Add repository-scoped GitHub integration and immutable per-run PR release templates.',
  'run.id': '42',
  'run.storiesPassed': '8',
  'run.storiesTotal': '10',
  'run.storiesFailed': '1',
  'run.storiesSkipped': '1',
  'run.tokensInput': '125,000',
  'run.tokensOutput': '18,000',
  'run.tokensTotal': '143,000',
  'run.costUsd': '$1.43',
  'run.duration': '12m 34s',
  'run.agentType': 'claude',
  'run.model': 'claude-opus-4-6',
  'run.diffStats': '12 files changed, 487 insertions(+), 23 deletions(-)',
};

function renderPreview(template: string): string {
  const tpl = template.trim() ? template : DEFAULT_PR_TEMPLATE;
  return tpl.replace(/\{\{([^}]+)\}\}/g, (match: string, key: string) => {
    const trimmed = key.trim();
    return Object.prototype.hasOwnProperty.call(SAMPLE_DATA, trimmed)
      ? SAMPLE_DATA[trimmed]
      : match;
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface GithubStatus {
  connected: boolean;
  repoOwner?: string;
  repoName?: string;
  webhookId?: number | null;
  installationId?: number;
  repositoryId?: number;
  credentialSource?: 'github-app-installation' | 'pat-oauth-fallback' | null;
  webhookUrl?: string;
  webhookConfigured?: boolean;
  signedDeliveryObserved?: boolean;
  lastWebhookAt?: string | null;
  connectedAt?: string | null;
}

interface GithubAccount {
  connected: boolean;
  username?: string;
  avatarUrl?: string;
  connectedAt?: string | null;
  scopes?: string[];
  source?: 'github-app-installation' | 'workspace-pat' | 'workspace-oauth' | 'legacy-global';
  installationId?: number;
  repositoryId?: number;
  repository?: string;
  nextAction?: string | null;
}

interface GithubAppState {
  configured: boolean;
  connected?: boolean;
  credentialReady?: boolean;
  source?: 'github-app-installation';
  registration?: { appId: number; appSlug: string } | null;
  app?: { id: number; slug: string };
  installation?: { id: number; accountId: number; account: string; type: string; status: string };
  repository?: { id: number; owner: string; name: string };
  binding?: { id: string; status: string; lastValidatedAt: string | null; lastWebhookAt: string | null; validationErrorCode: string | null };
  webhookHealth?: { configured: boolean; signedDeliveryObserved: boolean; lastWebhookAt: string | null };
  capabilities?: Record<'repository' | 'actions' | 'pulls' | 'contents' | 'statuses' | 'checks' | 'issues' | 'webhooks', boolean>;
  permissions?: Record<string, string>;
  events?: string[];
  nextAction: string | null;
}

interface GithubAppSetupResult {
  mode: 'manifest' | 'bounded-import';
  state?: string;
  expiresAt?: string;
  createUrl?: string;
  manifest?: Record<string, unknown>;
  nextAction: string;
}

interface PrTemplatePreviewResult {
  rendered: string;
  source: 'latest-run' | 'sample';
  run: {
    id?: number;
    status?: string | null;
    title?: string;
    storiesPassed?: number;
    storiesTotal?: number;
  } | null;
}

interface TestResult {
  valid: boolean;
  username?: string;
  error?: string;
}

// ─── Scope descriptions ─────────────────────────────────────────────────────

const REQUIRED_CAPABILITIES = [
  { key: 'repo', label: 'Repository access', scopes: ['repo'] },
  { key: 'admin:repo_hook', label: 'Webhook management', scopes: ['admin:repo_hook', 'write:repo_hook'] },
];

const PR_TEMPLATE_VARIABLES = [
  '{{spec.title}}', '{{spec.brief}}',
  '{{run.storiesPassed}}', '{{run.storiesTotal}}',
  '{{run.storiesFailed}}', '{{run.storiesSkipped}}',
  '{{run.tokensInput}}', '{{run.tokensOutput}}', '{{run.tokensTotal}}',
  '{{run.costUsd}}', '{{run.duration}}',
  '{{run.agentType}}', '{{run.model}}',
  '{{run.id}}', '{{run.diffStats}}',
];

function hasAnyScope(scopes: string[] | undefined, candidates: string[]): boolean {
  return !!scopes?.some(scope => candidates.includes(scope));
}

function isLocalWebhookUrl(url?: string): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname) || parsed.hostname.endsWith('.local');
  } catch {
    return true;
  }
}

function timeAgo(value?: string | null): string {
  if (!value) return 'Never received';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return 'Unknown';
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatusPill({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
  const color = ok
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : warn
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      : 'border-border bg-bg text-muted';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${color}`}>
      {ok ? <CheckCircle2 size={12} /> : warn ? <AlertCircle size={12} /> : <Lock size={12} />}
      {label}
    </span>
  );
}

function LockedPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-panel/50 p-4 text-sm text-muted">
      <div className="flex items-center gap-2 text-[var(--text)] mb-1">
        <Lock size={14} />
        <span className="font-medium">{title}</span>
      </div>
      {message}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GitHubSettingsPanel() {
  const { workspaceId } = useWorkspace();
  const { show: showToast } = useGlobalToast();
  const capabilityInputRef = useRef<HTMLInputElement>(null);
  const [providerChangesUnlocked, setProviderChangesUnlocked] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);

  useEffect(() => {
    // A provider capability is scoped to this visible Settings visit only.
    clearOperatorCapability();
    setProviderChangesUnlocked(false);
    const lockForNavigation = () => clearOperatorCapability();
    const unsubscribe = onOperatorCapabilityLocked(() => setProviderChangesUnlocked(false));
    window.addEventListener('hashchange', lockForNavigation);
    window.addEventListener('pagehide', lockForNavigation);
    return () => {
      unsubscribe();
      window.removeEventListener('hashchange', lockForNavigation);
      window.removeEventListener('pagehide', lockForNavigation);
      clearOperatorCapability();
    };
  }, [workspaceId]);

  function handleUnlockProviderChanges() {
    const capability = capabilityInputRef.current?.value ?? '';
    try {
      setOperatorCapability(capability);
      if (capabilityInputRef.current) capabilityInputRef.current.value = '';
      setProviderChangesUnlocked(hasOperatorCapability());
      setCapabilityError(null);
    } catch (error) {
      setProviderChangesUnlocked(false);
      setCapabilityError(error instanceof Error ? error.message : 'Enter a valid operator capability');
    }
  }

  function handleLockProviderChanges() {
    clearOperatorCapability();
    if (capabilityInputRef.current) capabilityInputRef.current.value = '';
    setProviderChangesUnlocked(false);
    setCapabilityError(null);
  }

  // Workspace repo connection
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // OAuth account
  const [account, setAccount] = useState<GithubAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);

  // Repository-scoped GitHub App
  const [appState, setAppState] = useState<GithubAppState | null>(null);
  const [appLoading, setAppLoading] = useState(true);
  const [appSetup, setAppSetup] = useState<GithubAppSetupResult | null>(null);
  const [appActionError, setAppActionError] = useState<string | null>(null);
  const [appActionLoading, setAppActionLoading] = useState(false);
  const [installationId, setInstallationId] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [appRepoOwner, setAppRepoOwner] = useState('');
  const [appRepoName, setAppRepoName] = useState('');
  const [replacementReason, setReplacementReason] = useState('');
  const [importAppId, setImportAppId] = useState('');
  const [importAppSlug, setImportAppSlug] = useState('');
  const [importClientId, setImportClientId] = useState('');
  const [importPrivateKey, setImportPrivateKey] = useState('');
  const [importWebhookSecret, setImportWebhookSecret] = useState('');

  // Connect form
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState(false);

  // Disconnect (webhook — legacy per-section)
  const [disconnectToken, setDisconnectToken] = useState('');
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  // OAuth disconnect (legacy per-section)
  const [disconnectingOAuth, setDisconnectingOAuth] = useState(false);
  const [showOAuthDisconnect, setShowOAuthDisconnect] = useState(false);
  const [oauthDisconnectError, setOauthDisconnectError] = useState<string | null>(null);

  // Full disconnect (unified — DELETE /api/workspaces/:id/github)
  const [showFullDisconnect, setShowFullDisconnect] = useState(false);
  const [fullDisconnecting, setFullDisconnecting] = useState(false);
  const [fullDisconnectError, setFullDisconnectError] = useState<string | null>(null);

  // Test connection
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // PR template
  const [prTemplate, setPrTemplate] = useState('');
  const [prTemplateSaving, setPrTemplateSaving] = useState(false);
  const [prTemplateSaved, setPrTemplateSaved] = useState(false);
  const [prTemplateLoaded, setPrTemplateLoaded] = useState(false);
  const [prTemplatePreviewVisible, setPrTemplatePreviewVisible] = useState(false);
  const [prTemplatePreview, setPrTemplatePreview] = useState<PrTemplatePreviewResult | null>(null);
  const [prTemplatePreviewLoading, setPrTemplatePreviewLoading] = useState(false);
  const [prTemplatePreviewError, setPrTemplatePreviewError] = useState<string | null>(null);
  // Deferred so the preview update doesn't block keystrokes
  const deferredPrTemplate = useDeferredValue(prTemplate);
  const previewText = prTemplatePreview?.rendered ?? renderPreview(deferredPrTemplate);

  // Webhook health
  const [pingingWebhook, setPingingWebhook] = useState(false);
  const [webhookPingResult, setWebhookPingResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [webhookUrlCopied, setWebhookUrlCopied] = useState(false);

  // ─── Fetch workspace connection status ─────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await apiFetch<GithubStatus>(`/api/workspaces/${workspaceId}/github`);
      setStatus(data);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // ─── Fetch OAuth account ─────────────────────────────────────────────────

  const fetchAccount = useCallback(async () => {
    if (!workspaceId) return;
    setAccountLoading(true);
    try {
      const data = await apiFetch<GithubAccount>(`/api/workspaces/${workspaceId}/github/account`);
      setAccount(data);
    } catch {
      setAccount({ connected: false });
    } finally {
      setAccountLoading(false);
    }
  }, [workspaceId]);

  const fetchAppState = useCallback(async () => {
    if (!workspaceId) return;
    setAppLoading(true);
    try {
      setAppState(await apiFetch<GithubAppState>(`/api/workspaces/${workspaceId}/github/app`));
    } catch (err: unknown) {
      setAppState({ configured: false, nextAction: 'GitHub App diagnostics are unavailable.' });
      setAppActionError(err instanceof Error ? err.message : 'Failed to load GitHub App state');
    } finally {
      setAppLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchStatus(); fetchAccount(); fetchAppState(); }, [fetchStatus, fetchAccount, fetchAppState]);

  // ─── Fetch PR template from rorca-config ────────────────────────────────

  useEffect(() => {
    if (!workspaceId || prTemplateLoaded) return;
    apiFetch<{ config: { github?: { prTemplate?: string } } }>(`/api/workspaces/${workspaceId}/rorca-config`)
      .then(data => {
        setPrTemplate(data.config.github?.prTemplate ?? '');
        setPrTemplateLoaded(true);
      })
      .catch(() => { setPrTemplateLoaded(true); });
  }, [workspaceId, prTemplateLoaded]);

  useEffect(() => {
    if (!workspaceId || !prTemplatePreviewVisible || !prTemplateLoaded) return;
    let cancelled = false;
    setPrTemplatePreviewLoading(true);
    setPrTemplatePreviewError(null);
    apiFetch<PrTemplatePreviewResult>(`/api/workspaces/${workspaceId}/github/pr-template-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: deferredPrTemplate }),
    })
      .then(data => { if (!cancelled) setPrTemplatePreview(data); })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPrTemplatePreview(null);
          setPrTemplatePreviewError(err instanceof Error ? err.message : 'Using local sample preview');
        }
      })
      .finally(() => { if (!cancelled) setPrTemplatePreviewLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, prTemplatePreviewVisible, prTemplateLoaded, deferredPrTemplate]);

  const webhookUrl = status?.webhookUrl ?? `${BASE_URL}/api/webhooks/github`;
  const callbackParams = new URLSearchParams(window.location.search);
  const appCallbackReady = callbackParams.get('github_app_setup') === 'callback'
    && Boolean(callbackParams.get('state')) && Boolean(callbackParams.get('code'));
  const appCapabilitiesReady = Boolean(appState?.credentialReady ?? appState?.connected) && Boolean(appState?.capabilities
    && Object.values(appState.capabilities).every(Boolean));
  const appWebhookObserved = Boolean(appState?.webhookHealth?.signedDeliveryObserved);
  const appCanBindOrReplace = Boolean(
    (!appState?.configured && appState?.registration)
    || (appState?.configured && !appCapabilitiesReady && appState?.app),
  );
  const registeredAppSlug = appState?.registration?.appSlug ?? appState?.app?.slug;
  const webhookIsLocal = isLocalWebhookUrl(webhookUrl);
  const credentialOk = !!account?.connected;
  const repoOk = !!status?.connected;
  const usesGithubApp = appState?.source === 'github-app-installation'
    || status?.credentialSource === 'github-app-installation';
  const webhookConfigured = !webhookIsLocal
    && (usesGithubApp ? Boolean(appState?.webhookHealth?.configured ?? status?.webhookConfigured) : Boolean(status?.webhookId));
  const webhookOk = !!status?.connected && webhookConfigured
    && (usesGithubApp
      ? Boolean(appWebhookObserved || status?.signedDeliveryObserved)
      : Boolean(status?.signedDeliveryObserved ?? status?.lastWebhookAt));
  // ─── Handlers ────────────────────────────────────────────────────────────

  async function handleStartAppSetup() {
    if (!workspaceId) return;
    setAppActionLoading(true);
    setAppActionError(null);
    try {
      setAppSetup(await apiFetch<GithubAppSetupResult>(`/api/workspaces/${workspaceId}/github/app/setup/start`, { method: 'POST' }));
    } catch (err: unknown) {
      setAppActionError(err instanceof Error ? err.message : 'Failed to prepare GitHub App setup');
    } finally {
      setAppActionLoading(false);
    }
  }

  async function handleExchangeAppManifest() {
    if (!workspaceId) return;
    const params = new URLSearchParams(window.location.search);
    const state = params.get('state');
    const code = params.get('code');
    if (!state || !code) return;
    setAppActionLoading(true);
    setAppActionError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${workspaceId}/github/app/setup/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, code }),
      });
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
      await fetchAppState();
    } catch (err: unknown) {
      setAppActionError(err instanceof Error ? err.message : 'GitHub App manifest exchange failed');
    } finally {
      setAppActionLoading(false);
    }
  }

  async function handleImportApp() {
    if (!workspaceId) return;
    setAppActionLoading(true);
    setAppActionError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${workspaceId}/github/app/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: Number(importAppId), appSlug: importAppSlug.trim(), clientId: importClientId.trim() || undefined,
          privateKeyPem: importPrivateKey, webhookSecret: importWebhookSecret }),
      });
      setImportPrivateKey('');
      setImportWebhookSecret('');
      setAppSetup(null);
      await fetchAppState();
    } catch (err: unknown) {
      setAppActionError(err instanceof Error ? err.message : 'GitHub App import failed');
    } finally {
      setAppActionLoading(false);
    }
  }

  async function handleRevalidateAppBinding() {
    if (!workspaceId) return;
    setAppActionLoading(true);
    setAppActionError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${workspaceId}/github/app/revalidate`, { method: 'POST' });
      await Promise.all([fetchAppState(), fetchStatus(), fetchAccount()]);
    } catch (err: unknown) {
      setAppActionError(err instanceof Error ? err.message : 'Failed to revalidate App binding');
    } finally {
      setAppActionLoading(false);
    }
  }

  async function handleBindAppRepository() {
    if (!workspaceId) return;
    setAppActionLoading(true);
    setAppActionError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${workspaceId}/github/app/bind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: Number(installationId), repositoryId: Number(repositoryId), repoOwner: appRepoOwner.trim(), repoName: appRepoName.trim(),
          replacementReason: appState?.configured ? replacementReason.trim() : undefined }),
      });
      setReplacementReason('');
      await Promise.all([fetchAppState(), fetchStatus(), fetchAccount()]);
    } catch (err: unknown) {
      setAppActionError(err instanceof Error ? err.message : 'Failed to bind App installation');
    } finally {
      setAppActionLoading(false);
    }
  }

  async function handleConnect() {
    if (!workspaceId || !repoOwner.trim() || !repoName.trim() || !githubToken.trim()) return;
    setConnecting(true);
    setConnectError(null);
    setConnectSuccess(false);
    try {
      const data = await apiFetchProviderMutation<GithubStatus & { error?: string; manualSetupUrl?: string }>(
        `/api/workspaces/${workspaceId}/github/connect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoOwner: repoOwner.trim(), repoName: repoName.trim(), githubToken: githubToken.trim() }),
        },
      );
      setStatus(data);
      setRepoOwner('');
      setRepoName('');
      setGithubToken('');

      if (data.error) {
        // Degraded success — connection saved but webhook failed
        setConnectError(data.error + (data.manualSetupUrl ? ` — Set up manually: ${data.manualSetupUrl}` : ''));
      } else {
        // Full success — show green checkmark for 3 seconds
        setConnectSuccess(true);
        setTimeout(() => setConnectSuccess(false), 3000);
      }
    } catch (err: unknown) {
      setConnectError(err instanceof Error ? err.message : 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!workspaceId || !disconnectToken.trim()) return;
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${workspaceId}/github/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: disconnectToken.trim() }),
      });
      setStatus({ connected: false });
      setShowDisconnect(false);
      setDisconnectToken('');
    } catch (err: unknown) {
      setDisconnectError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleTestConnection() {
    if (!workspaceId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiFetch<TestResult>(`/api/workspaces/${workspaceId}/github/test-connection`, {
        method: 'POST',
      });
      setTestResult(result);
      fetchAccount();
    } catch {
      setTestResult({ valid: false, error: 'Request failed' });
    } finally {
      setTesting(false);
    }
  }

  async function handleCopyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setWebhookUrlCopied(true);
      setTimeout(() => setWebhookUrlCopied(false), 1600);
    } catch {
      setWebhookUrlCopied(false);
    }
  }

  async function handlePingWebhook() {
    if (!workspaceId || !status?.webhookId) return;
    setPingingWebhook(true);
    setWebhookPingResult(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${workspaceId}/github/webhook-ping`, { method: 'POST' });
      setWebhookPingResult({ ok: true, message: 'Ping sent — GitHub should deliver a ping event shortly.' });
      fetchStatus();
    } catch (err: unknown) {
      setWebhookPingResult({ ok: false, message: err instanceof Error ? err.message : 'Webhook ping failed' });
    } finally {
      setPingingWebhook(false);
    }
  }

  async function handleDisconnectOAuth() {
    if (!workspaceId) return;
    setDisconnectingOAuth(true);
    setOauthDisconnectError(null);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/github/disconnect-oauth`, { method: 'POST' });
      setAccount({ connected: false });
      setShowOAuthDisconnect(false);
      // Re-fetch to confirm server state
      fetchAccount();
    } catch (err: unknown) {
      setOauthDisconnectError(err instanceof Error ? err.message : 'Failed to disconnect GitHub account');
    } finally {
      setDisconnectingOAuth(false);
    }
  }

  async function handleFullDisconnect() {
    if (!workspaceId) return;
    setFullDisconnecting(true);
    setFullDisconnectError(null);
    try {
      await apiFetchProviderMutation<{ disconnected: boolean }>(`/api/workspaces/${workspaceId}/github`, {
        method: 'DELETE',
      });
      setAccount({ connected: false });
      setStatus({ connected: false });
      setShowFullDisconnect(false);
      // Re-fetch every authority surface to avoid stale App state.
      await Promise.all([fetchAccount(), fetchStatus(), fetchAppState()]);
    } catch (err: unknown) {
      setFullDisconnectError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setFullDisconnecting(false);
    }
  }

  async function handleSavePrTemplate() {
    if (!workspaceId || prTemplateSaving) return;
    setPrTemplateSaving(true);
    try {
      // Read-merge-write to avoid clobbering other config sections
      const current = await apiFetch<{ config: Record<string, unknown> }>(`/api/workspaces/${workspaceId}/rorca-config`);
      const merged = {
        ...current.config,
        github: {
          ...(typeof current.config.github === 'object' && current.config.github !== null ? current.config.github : {}),
          prTemplate: prTemplate || undefined,
        },
      };
      await apiFetch(`/api/workspaces/${workspaceId}/rorca-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: merged }),
      });
      setPrTemplateSaved(true);
      setTimeout(() => setPrTemplateSaved(false), 2000);
    } catch {
      // silent
    } finally {
      setPrTemplateSaving(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Select a workspace first.
      </div>
    );
  }

  return (
    <div
      role="main"
      aria-label="GitHub Settings"
      className="h-full overflow-y-auto max-w-5xl mx-auto space-y-6 px-4 pb-10 sm:px-0"
    >
      <section className="rounded-2xl border border-border bg-panel/80 p-4 shadow-xl shadow-black/10 overflow-hidden relative">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Github size={22} strokeWidth={1.5} />
              <h1 className="text-xl font-semibold text-[var(--text)]">GitHub Integration</h1>
            </div>
            <p className="max-w-2xl text-sm text-muted">
              Connect local Rorca to one exact GitHub repository and inspect credential, webhook, and immutable release diagnostics. PR creation is selected per run; workflow/deployment actuation is disabled.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill ok={credentialOk} label={credentialOk ? 'Credential connected' : 'Credential missing'} />
            <StatusPill ok={repoOk} label={repoOk ? 'Repository connected' : 'Repository disconnected'} />
            <StatusPill ok={webhookOk} warn={repoOk && webhookConfigured && !webhookOk}
              label={webhookOk ? 'Signed webhook observed' : webhookConfigured ? 'Webhook configured; no delivery observed' : repoOk ? 'Webhook needs configuration' : 'Webhook locked'} />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
          {[
            { icon: KeyRound, title: 'Credential', value: credentialOk ? account?.username ? `@${account.username}` : 'Connected' : 'Add PAT', tone: credentialOk ? 'text-emerald-300' : 'text-muted' },
            { icon: Github, title: 'Repository', value: repoOk ? `${status?.repoOwner}/${status?.repoName}` : 'Not connected', tone: repoOk ? 'text-emerald-300' : 'text-muted' },
            { icon: RadioTower, title: 'Webhook', value: repoOk ? timeAgo(status?.lastWebhookAt) : 'Locked', tone: webhookOk ? 'text-emerald-300' : repoOk ? 'text-amber-300' : 'text-muted' },
          ].map(item => {
            const Icon = item.icon;
            return (
              <div key={item.title} className="rounded-xl border border-border bg-bg/60 p-2.5">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Icon size={14} />
                  {item.title}
                </div>
                <div className={`mt-1.5 truncate text-sm font-medium ${item.tone}`}>{item.value}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-4 space-y-3" aria-labelledby="github-operator-capability-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Lock size={16} />
              <h2 id="github-operator-capability-heading" className="text-sm font-semibold text-[var(--text)]">Provider changes lock</h2>
              <StatusPill
                ok={providerChangesUnlocked}
                label={providerChangesUnlocked ? 'Unlocked for this visit' : 'Locked'}
              />
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted">
              Read-only GitHub diagnostics stay available while locked. Enter the local operator capability only when you intend to change provider or release authority. The value is retained in memory only, attached only to approved provider-mutation requests, and cleared on navigation, rejection, sign-out, or explicit lock.
            </p>
          </div>
          {providerChangesUnlocked && (
            <button type="button" onClick={handleLockProviderChanges}
              className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-bg">
              <Lock size={12} />Lock provider changes
            </button>
          )}
        </div>
        {!providerChangesUnlocked && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-xs text-muted">Local operator capability
              <input
                ref={capabilityInputRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleUnlockProviderChanges();
                  }
                }}
                className="mt-1 w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-[var(--text)] focus:outline-none focus:border-accent"
              />
            </label>
            <button type="button" onClick={handleUnlockProviderChanges}
              className="inline-flex items-center justify-center gap-1.5 rounded bg-accent px-3 py-2 text-xs text-white">
              <KeyRound size={12} />Unlock provider changes
            </button>
          </div>
        )}
        {capabilityError && <p role="alert" className="text-xs text-red-400">{capabilityError}</p>}
      </section>

      <section className="rounded-lg border border-border bg-panel p-4 space-y-4" aria-labelledby="github-app-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Shield size={18} />
              <h2 id="github-app-heading" className="text-sm font-semibold text-[var(--text)]">Repository-scoped GitHub App</h2>
              {appLoading ? <Loader2 size={13} className="animate-spin text-muted" /> : (
                <StatusPill ok={appCapabilitiesReady} label={appCapabilitiesReady ? 'Credential ready' : appState?.configured ? 'Credential needs revalidation' : 'App not bound'} warn={Boolean(appState?.configured && !appCapabilitiesReady)} />
              )}
            </div>
            <p className="mt-1 text-xs text-muted">
              Preferred credential source. Installation tokens are short-lived and minted for only the immutable repository binding; PAT/OAuth remains an explicit fallback only when no App binding exists.
            </p>
          </div>
          {!appState?.configured && !appState?.registration && (
            <button type="button" onClick={handleStartAppSetup} disabled={appActionLoading}
              className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-bg disabled:opacity-50">
              {appActionLoading ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
              Prepare App setup
            </button>
          )}
        </div>

        {appState?.configured && appState.app && appState.installation && appState.repository && (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-bg/50 p-3 text-xs sm:grid-cols-3">
            <div><span className="text-muted">Source</span><p className="mt-1 font-medium text-[var(--text)]">GitHub App · {appState.app.slug}</p></div>
            <div><span className="text-muted">Installation</span><p className="mt-1 font-mono text-[var(--text)]">#{appState.installation.id} · {appState.installation.account}</p></div>
            <div><span className="text-muted">Repository binding</span><p className="mt-1 font-mono text-[var(--text)]">{appState.repository.owner}/{appState.repository.name} · #{appState.repository.id}</p></div>
          </div>
        )}

        {appState?.webhookHealth && (
          <div className="flex flex-wrap gap-2" aria-label="GitHub App webhook health">
            <StatusPill ok={appState.webhookHealth.configured} label={appState.webhookHealth.configured ? 'Provider hook configured' : 'Provider hook not configured'} />
            <StatusPill ok={appState.webhookHealth.signedDeliveryObserved} warn={appState.webhookHealth.configured && !appState.webhookHealth.signedDeliveryObserved}
              label={appState.webhookHealth.signedDeliveryObserved ? 'Signed delivery observed' : 'Awaiting signed delivery'} />
            <span className="self-center text-xs text-muted">Last signed delivery: {timeAgo(appState.webhookHealth.lastWebhookAt)}</span>
          </div>
        )}

        {appState?.capabilities && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted">Capability diagnostics (credential readiness)</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(appState.capabilities).map(([name, available]) => (
                <span key={name} className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${available ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
                  {available ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}{name}
                </span>
              ))}
            </div>
          </div>
        )}

        {appCanBindOrReplace && registeredAppSlug && (
          <div className="space-y-3 rounded-lg border border-border bg-bg/50 p-3">
            <p className="text-xs text-muted">Registered App: <span className="font-medium text-[var(--text)]">{registeredAppSlug}</span>. Enter identities copied from the selected-repository installation; the server verifies all four against GitHub before {appState?.configured ? 'audit-replacing' : 'binding'}.</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: 'Installation ID', value: installationId, set: setInstallationId, placeholder: '12345678' },
                { label: 'Repository ID', value: repositoryId, set: setRepositoryId, placeholder: '987654321' },
                { label: 'Owner', value: appRepoOwner, set: setAppRepoOwner, placeholder: 'owner' },
                { label: 'Repository', value: appRepoName, set: setAppRepoName, placeholder: 'repo' },
              ].map(field => (
                <label key={field.label} className="text-xs text-muted">{field.label}
                  <input value={field.value} onChange={event => field.set(event.target.value)} placeholder={field.placeholder}
                    className="mt-1 w-full rounded border border-border bg-panel px-2.5 py-1.5 font-mono text-xs text-[var(--text)] focus:outline-none focus:border-accent" />
                </label>
              ))}
            </div>
            {appState?.configured && (
              <label className="block text-xs text-muted">Audited replacement reason
                <input value={replacementReason} onChange={event => setReplacementReason(event.target.value)} placeholder="Why this immutable binding is being replaced"
                  className="mt-1 w-full rounded border border-border bg-panel px-2.5 py-1.5 text-xs text-[var(--text)] focus:outline-none focus:border-accent" />
              </label>
            )}
            <button type="button" onClick={handleBindAppRepository}
              disabled={appActionLoading || !installationId || !repositoryId || !appRepoOwner.trim() || !appRepoName.trim()
                || Boolean(appState?.configured && replacementReason.trim().length < 8)}
              className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">
              {appActionLoading ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}{appState?.configured ? 'Verify and audit-replace exact repository' : 'Verify and bind exact repository'}
            </button>
          </div>
        )}

        {appCallbackReady && (
          <button type="button" onClick={handleExchangeAppManifest} disabled={appActionLoading}
            className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">
            {appActionLoading ? <Loader2 size={12} className="animate-spin" /> : <Shield size={12} />}Complete one-time App registration
          </button>
        )}

        {appSetup?.mode === 'manifest' && appSetup.manifest && appSetup.createUrl && (
          <form action={appSetup.createUrl} method="post" target="_blank" rel="noopener noreferrer" className="rounded-lg border border-border bg-bg/50 p-3 space-y-2">
            <input type="hidden" name="manifest" value={JSON.stringify(appSetup.manifest)} />
            <p className="text-xs text-muted">{appSetup.nextAction} State expires {appSetup.expiresAt ? new Date(appSetup.expiresAt).toLocaleTimeString() : 'soon'}.</p>
            <button type="submit" className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-panel">
              <ExternalLink size={12} />Continue to GitHub
            </button>
          </form>
        )}
        {appSetup?.mode === 'bounded-import' && (
          <fieldset className="space-y-3 rounded border border-amber-500/30 bg-amber-500/10 p-3">
            <legend className="px-1 text-xs font-medium text-amber-200">One-time bounded App import</legend>
            <p className="text-xs text-amber-200">{appSetup.nextAction} Values are sent once to the authenticated vault endpoint and are not rendered again.</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="text-xs text-muted">App ID<input value={importAppId} onChange={e => setImportAppId(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded border border-border bg-panel px-2 py-1.5 text-[var(--text)]" /></label>
              <label className="text-xs text-muted">App slug<input value={importAppSlug} onChange={e => setImportAppSlug(e.target.value)} className="mt-1 w-full rounded border border-border bg-panel px-2 py-1.5 text-[var(--text)]" /></label>
              <label className="text-xs text-muted">Client ID (optional)<input value={importClientId} onChange={e => setImportClientId(e.target.value)} className="mt-1 w-full rounded border border-border bg-panel px-2 py-1.5 text-[var(--text)]" /></label>
            </div>
            <label className="block text-xs text-muted">Private key PEM<textarea value={importPrivateKey} onChange={e => setImportPrivateKey(e.target.value)} rows={5} autoComplete="off" spellCheck={false} className="mt-1 w-full rounded border border-border bg-panel px-2 py-1.5 font-mono text-[var(--text)]" /></label>
            <label className="block text-xs text-muted">Webhook secret<input type="password" value={importWebhookSecret} onChange={e => setImportWebhookSecret(e.target.value)} autoComplete="new-password" className="mt-1 w-full rounded border border-border bg-panel px-2 py-1.5 text-[var(--text)]" /></label>
            <button type="button" onClick={handleImportApp} disabled={appActionLoading || !importAppId || !importAppSlug.trim() || !importPrivateKey || importWebhookSecret.length < 16}
              className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">
              {appActionLoading ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}Verify and vault once
            </button>
          </fieldset>
        )}
        {appState?.configured && !appState.connected && (
          <button type="button" onClick={handleRevalidateAppBinding} disabled={appActionLoading}
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-bg disabled:opacity-50">
            {appActionLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}Revalidate immutable binding
          </button>
        )}
        {(appState?.nextAction || appActionError) && (
          <div role={appActionError ? 'alert' : 'status'} aria-live="polite" className={`flex items-start gap-2 text-xs ${appActionError ? 'text-red-400' : 'text-amber-300'}`}>
            <AlertCircle size={13} className="mt-0.5 shrink-0" />{appActionError || appState?.nextAction}
          </div>
        )}
      </section>

      <AutonomousDeliverySettings
        workspaceId={workspaceId}
        connected={Boolean(account?.connected && status?.connected)}
        showToast={showToast}
      />

      {/* ─── Section 1: Workspace GitHub Credential ───────────────────── */}
      <section className="rounded-lg border border-border bg-panel px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <Github size={18} strokeWidth={1.5} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-[var(--text)]">GitHub Credential</h2>
                {accountLoading ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    <Loader2 size={12} className="animate-spin" /> Loading
                  </span>
                ) : account?.connected ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                    <CheckCircle2 size={11} /> @{account.username}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-muted">
                    <Lock size={11} /> Not configured
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">
                {account?.connected
                  ? account.source === 'github-app-installation'
                    ? 'Source: repository-scoped GitHub App installation. Short-lived tokens are never persisted.'
                    : `Stored locally and encrypted for this workspace${account.source ? ` · Source: ${account.source}` : ''}.`
                  : 'Preferred: bind the GitHub App above. PAT remains an explicit encrypted migration fallback.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {account?.connected ? (
              <>
                <button
                  onClick={handleTestConnection}
                  disabled={testing}
                  className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {testing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Validate
                </button>
                {account.source !== 'github-app-installation' && (!showOAuthDisconnect ? (
                  <button
                    onClick={() => setShowOAuthDisconnect(true)}
                    className="px-2.5 py-1.5 text-xs rounded text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-colors flex items-center gap-1.5"
                  >
                    <Unlink size={12} />
                    Disconnect
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={handleDisconnectOAuth}
                      disabled={disconnectingOAuth}
                      className="px-2.5 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
                    >
                      {disconnectingOAuth ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
                    </button>
                    <button
                      onClick={() => { setShowOAuthDisconnect(false); setOauthDisconnectError(null); }}
                      className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </>
            ) : (
              REQUIRED_CAPABILITIES.map(capability => (
                <span key={capability.key} className="inline-flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 text-xs text-muted">
                  <Shield size={11} />
                  {capability.label}
                </span>
              ))
            )}
          </div>
        </div>

        {oauthDisconnectError && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
            <AlertCircle size={12} />
            {oauthDisconnectError}
          </div>
        )}
        {testResult && (
          <div className={`mt-2 flex items-center gap-1.5 text-xs ${testResult.valid ? 'text-emerald-400' : 'text-red-400'}`}>
            {testResult.valid ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
            {testResult.valid ? `Token valid (${testResult.username})` : `Token invalid: ${testResult.error}`}
          </div>
        )}
        {account?.connected && account.scopes && account.scopes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
            {REQUIRED_CAPABILITIES.map(capability => {
              const ok = hasAnyScope(account.scopes, capability.scopes);
              return (
                <span key={capability.key} className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
                  {ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                  {capability.label}
                </span>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Section 2: Workspace Repository ──────────────────────────── */}
      <section className="pt-2">
        <div className="flex items-center gap-2 mb-4">
          <Webhook size={20} strokeWidth={1.5} />
          <h2 className="text-base font-semibold text-[var(--text)]">Workspace Repository</h2>
        </div>

        <div aria-live="polite" aria-atomic="true">
        {loading ? (
          <div className="flex items-center gap-2 text-muted text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading connection status...
          </div>
        ) : status?.connected ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 size={18} className="text-emerald-400" />
                <span className="text-sm font-medium text-emerald-400">Connected</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted">Repository</span>
                  <p className="font-mono text-[var(--text)]">{status.repoOwner}/{status.repoName}</p>
                </div>
                <div>
                  <span className="text-muted">{usesGithubApp ? 'Installation ID' : 'Webhook ID'}</span>
                  <p className="font-mono text-[var(--text)]">#{usesGithubApp ? status.installationId : status.webhookId}</p>
                </div>
                <div>
                  <span className="text-muted">Connected</span>
                  <p className="text-[var(--text)]">
                    {status.connectedAt ? new Date(status.connectedAt).toLocaleDateString() : '-'}
                  </p>
                </div>
                <div>
                  <span className="text-muted">Last webhook</span>
                  <p className="text-[var(--text)]">
                    {status.lastWebhookAt ? new Date(status.lastWebhookAt).toLocaleString() : 'None yet'}
                  </p>
                </div>
              </div>

              {status.webhookId || usesGithubApp ? (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Webhook size={14} />
                    Events: push, pull_request, issues, check_run · signed ping accepted for setup health
                  </div>
                  <div className="rounded-lg border border-border bg-bg/50 p-3 space-y-2">
                    <div className="space-y-1.5 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted">Webhook URL</span>
                        <button
                          type="button"
                          onClick={handleCopyWebhookUrl}
                          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted transition-colors hover:text-[var(--text)] hover:bg-bg"
                        >
                          <Copy size={11} />
                          {webhookUrlCopied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <code className="block rounded border border-border bg-panel/80 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--text)] break-all">
                        {webhookUrl}
                      </code>
                    </div>
                    {webhookIsLocal && (
                      <div className="flex items-start gap-2 text-xs text-amber-300">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span>Current URL looks local. Rorca does not bundle ngrok/localtunnel; set <code className="bg-bg px-1 rounded">RORCA_API_URL</code> to a public tunnel/host so GitHub can deliver events.</span>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {status.webhookId && (
                        <button
                          onClick={handlePingWebhook}
                          disabled={pingingWebhook}
                          className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {pingingWebhook ? <Loader2 size={12} className="animate-spin" /> : <RadioTower size={12} />}
                          Ping webhook
                        </button>
                      )}
                      {usesGithubApp ? (
                        <span className="text-xs text-muted">
                          App webhook health is shown in the diagnostics above. Manage provider settings from the owning account&apos;s GitHub App settings.
                        </span>
                      ) : status.repoOwner && status.repoName
                        && typeof status.webhookId === 'number'
                        && Number.isSafeInteger(status.webhookId)
                        && status.webhookId > 0 && (
                        <a
                          href={`https://github.com/${status.repoOwner}/${status.repoName}/settings/hooks/${status.webhookId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors flex items-center gap-1.5"
                        >
                          <ExternalLink size={12} />
                          Open in GitHub
                        </a>
                      )}
                      <span className="text-xs text-muted">Last event: {timeAgo(status.lastWebhookAt)}</span>
                    </div>
                    {webhookPingResult && (
                      <div className={`flex items-center gap-1.5 text-xs ${webhookPingResult.ok ? 'text-emerald-300' : 'text-red-400'}`}>
                        {webhookPingResult.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                        {webhookPingResult.message}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2.5 py-1.5">
                  <AlertCircle size={14} />
                  Webhook not configured — push events disabled
                </div>
              )}
            </div>

            {/* Disconnect webhook */}
            {!showDisconnect ? (
              <button
                onClick={() => setShowDisconnect(true)}
                className="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 transition-colors"
              >
                <Unlink size={14} /> Disconnect Repository
              </button>
            ) : (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
                <p className="text-sm text-red-400">
                  This will remove the webhook from GitHub and clear the connection.
                </p>
                <label className="block text-xs text-muted">
                  GitHub token (needs admin:repo_hook scope)
                  <input
                    type="password"
                    value={disconnectToken}
                    onChange={e => setDisconnectToken(e.target.value)}
                    placeholder="ghp_..."
                    className="mt-1 w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                  />
                </label>
                {disconnectError && (
                  <div className="flex items-center gap-1.5 text-xs text-red-400">
                    <AlertCircle size={12} /> {disconnectError}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleDisconnect}
                    disabled={disconnecting || !disconnectToken.trim()}
                    className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                  >
                    {disconnecting ? <Loader2 size={14} className="animate-spin" /> : <Unlink size={14} />}
                    Confirm Disconnect
                  </button>
                  <button
                    onClick={() => { setShowDisconnect(false); setDisconnectError(null); setDisconnectToken(''); }}
                    className="px-3 py-1.5 text-sm rounded border border-border hover:bg-panel transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-panel p-4 space-y-3">
            <p className="text-sm text-muted">
              Connect the exact repository Rorca should observe and use only through immutable per-run release intents. This unlocks webhook health and PR template previews.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-xs text-muted">
                Repo owner
                <input
                  type="text"
                  value={repoOwner}
                  onChange={e => setRepoOwner(e.target.value)}
                  placeholder="octocat"
                  className="mt-1 w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                />
              </label>
              <label className="block text-xs text-muted">
                Repo name
                <input
                  type="text"
                  value={repoName}
                  onChange={e => setRepoName(e.target.value)}
                  placeholder="my-project"
                  className="mt-1 w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                />
              </label>
            </div>

            <label className="block text-xs text-muted">
              GitHub personal access token
              <input
                type="password"
                value={githubToken}
                onChange={e => setGithubToken(e.target.value)}
                placeholder="ghp_..."
                className="mt-1 w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
              />
            </label>

            <div className="rounded-lg border border-border bg-bg/50 p-3 space-y-2">
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted">Webhook URL</span>
                  <button
                    type="button"
                    onClick={handleCopyWebhookUrl}
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted transition-colors hover:text-[var(--text)] hover:bg-bg"
                  >
                    <Copy size={11} />
                    {webhookUrlCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <code className="block rounded border border-border bg-panel/80 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--text)] break-all">
                  {webhookUrl}
                </code>
              </div>
              {webhookIsLocal && (
                <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-300">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    GitHub cannot deliver webhooks to localhost. Rorca does not bundle ngrok/localtunnel; set <code className="bg-bg px-1 rounded">RORCA_API_URL</code> to a public ngrok, Cloudflare Tunnel, localtunnel, or hosted URL before relying on inbound events.
                  </span>
                </div>
              )}
              <p className="text-xs text-muted">
                Stored locally and encrypted for this workspace. Required legacy fallback capabilities: repository access and webhook administration. Workflow dispatch is not supported.
              </p>
            </div>

            {connectError && (
              <div className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle size={12} /> {connectError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleConnect}
                disabled={connecting || !repoOwner.trim() || !repoName.trim() || !githubToken.trim()}
                className="px-4 py-2 text-sm rounded bg-accent text-white hover:opacity-90 disabled:cursor-not-allowed disabled:bg-border disabled:text-muted disabled:hover:opacity-100 transition-colors flex items-center gap-1.5"
              >
                {connecting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Configuring GitHub webhook...
                  </>
                ) : connectSuccess ? (
                  <>
                    <CheckCircle2 size={14} className="text-emerald-300" />
                    Webhook registered
                  </>
                ) : (
                  <>
                    <Link2 size={14} />
                    Connect GitHub
                  </>
                )}
              </button>
              {(!repoOwner.trim() || !repoName.trim() || !githubToken.trim()) && (
                <span className="text-xs text-muted">Enter owner, repo, and PAT to continue.</span>
              )}
            </div>
          </div>
        )}
        </div>
      </section>

      <section className="border-t border-border pt-6 pb-6" aria-labelledby="github-release-behavior-heading">
        <div className="flex items-center gap-2 mb-3">
          <Shield size={18} />
          <h2 id="github-release-behavior-heading" className="text-sm font-semibold text-[var(--text)]">Release behavior</h2>
        </div>
        <div className="rounded-lg border border-border bg-panel p-4 space-y-2 text-xs text-muted">
          <p>Repository-level Auto-PR and workflow-dispatch settings are retired. Rorca does not generate or dispatch autonomous GitHub Actions workflows.</p>
          <p>Choose <code className="bg-bg px-1 rounded">pr</code>, <code className="bg-bg px-1 rounded">draft-pr</code>, <code className="bg-bg px-1 rounded">branch-only</code>, or <code className="bg-bg px-1 rounded">direct</code> on each pipeline run. The chosen strategy, exact SHA, base branch, and repository identity are frozen in that run&apos;s immutable release intent.</p>
        </div>
      </section>

      {/* ─── Section 6: PR Template ───────────────────────────────────── */}
      <section className="border-t border-border pt-6 pb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText size={18} />
            <h2 className="text-sm font-semibold text-[var(--text)]">PR Description Template</h2>
          </div>
          <button
            onClick={() => setPrTemplatePreviewVisible(v => !v)}
            disabled={!status?.connected}
            className="text-xs text-muted hover:text-[var(--text)] transition-colors border border-border rounded px-2 py-1 disabled:opacity-50 disabled:hover:text-muted"
          >
            {prTemplatePreviewVisible ? 'Hide Preview' : 'Preview latest run'}
          </button>
        </div>

        <div className="mb-3 space-y-2">
          <p className="text-xs text-muted">
            Customize the PR description used when a run explicitly selects the immutable <code className="bg-bg px-1 rounded">pr</code> or <code className="bg-bg px-1 rounded">draft-pr</code> release strategy. Unrecognized variables are left as-is.
          </p>
          <details className="rounded-lg border border-border bg-panel/50 px-3 py-2 text-xs text-muted">
            <summary className="cursor-pointer select-none text-[var(--text)]">Supported template variables</summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PR_TEMPLATE_VARIABLES.map(variable => (
                <code key={variable} className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {variable}
                </code>
              ))}
            </div>
          </details>
        </div>

        {!status?.connected ? (
          <LockedPanel
            title="Connect a repository to preview PR templates"
            message="Once a repository is connected, Rorca previews templates with the latest local spec/run data when available and falls back to sample data otherwise."
          />
        ) : !prTemplateLoaded ? (
          /* Loading skeleton */
          <div className="space-y-2 mb-3" aria-busy="true" aria-label="Loading PR template">
            {[80, 60, 90, 70, 50].map((w, i) => (
              <div
                key={i}
                className="h-3 rounded bg-border animate-pulse"
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
        ) : (
          <div className={`${prTemplatePreviewVisible ? 'grid grid-cols-2 gap-3' : 'block'}`}>
            {/* Editor */}
            <div>
              <label className="block text-xs text-muted mb-1">Template</label>
              <textarea
                value={prTemplate}
                onChange={e => { setPrTemplate(e.target.value); setPrTemplateSaved(false); }}
                placeholder="Leave empty to use the default template"
                rows={16}
                className="w-full px-3 py-2 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent resize-y"
              />
            </div>

            {/* Live preview */}
            {prTemplatePreviewVisible && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-muted">
                    Preview ({prTemplatePreview?.source === 'latest-run' ? 'latest run' : 'sample fallback'})
                  </label>
                </div>
                {prTemplatePreviewError && (
                  <p className="mb-1 text-[11px] text-amber-300">{prTemplatePreviewError}</p>
                )}
                {prTemplatePreview?.run && (
                  <p className="mb-1 text-[11px] text-muted">
                    Latest run: {prTemplatePreview.run.title || `Run #${prTemplatePreview.run.id}`} · {prTemplatePreview.run.storiesPassed ?? 0}/{prTemplatePreview.run.storiesTotal ?? 0} stories passed
                  </p>
                )}
                {deferredPrTemplate !== prTemplate || prTemplatePreviewLoading ? (
                  /* Skeleton while deferred/server value is stale */
                  <div className="rounded bg-bg border border-border p-3 space-y-2 h-[calc(16*1.5rem+0.5rem)] overflow-auto" aria-busy="true" aria-label="Preview loading">
                    {[90, 70, 80, 60, 75, 55, 85, 65].map((w, i) => (
                      <div key={i} className="h-3 rounded bg-border animate-pulse" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                ) : (
                  <pre className="rounded bg-bg border border-border p-3 text-xs font-mono text-[var(--text)] overflow-auto whitespace-pre-wrap h-[calc(16*1.5rem+0.5rem)]">
                    {previewText}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleSavePrTemplate}
            disabled={prTemplateSaving || !prTemplateLoaded || !status?.connected}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 disabled:cursor-not-allowed disabled:bg-border disabled:text-muted disabled:hover:opacity-100 transition-colors flex items-center gap-1.5"
          >
            {prTemplateSaving ? <Loader2 size={14} className="animate-spin" /> : null}
            {prTemplateSaved ? 'Saved!' : 'Save Template'}
          </button>
          <button
            onClick={() => { setPrTemplate(''); setPrTemplateSaved(false); }}
            disabled={!prTemplateLoaded || !status?.connected}
            className="px-3 py-1.5 text-sm rounded border border-border hover:bg-panel transition-colors flex items-center gap-1.5 text-muted disabled:cursor-not-allowed disabled:opacity-50"
            title="Reset to default template"
          >
            <RotateCcw size={12} />
            Reset to Default
          </button>
        </div>
      </section>

      {/* ─── Section 6: Full Disconnect ──────────────────────────────── */}
      {(account?.connected || status?.connected) && (
        <section className="border-t border-border pt-6 pb-8">
          <div className="flex items-center gap-2 mb-3">
            <Unlink size={18} className="text-red-400" />
            <h2 className="text-sm font-semibold text-red-400">Disconnect GitHub</h2>
          </div>
          <p className="text-xs text-muted mb-4">
            Remove all GitHub integration data from this workspace. Pipeline runs will continue but without GitHub features.
          </p>

          {!showFullDisconnect ? (
            <button
              onClick={() => setShowFullDisconnect(true)}
              className="px-4 py-2 text-sm rounded text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-colors flex items-center gap-1.5"
            >
              <Unlink size={14} />
              Disconnect GitHub
            </button>
          ) : (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
              <p className="text-sm text-red-400 font-medium">Are you sure?</p>
              <p className="text-xs text-muted">
                This will remove the stored GitHub credential, repo webhook wiring, and GitHub-specific workspace settings.
                Pipeline runs will continue but without GitHub integration.
              </p>

              {fullDisconnectError && (
                <div className="flex items-center gap-1.5 text-xs text-red-400">
                  <AlertCircle size={12} /> {fullDisconnectError}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleFullDisconnect}
                  disabled={fullDisconnecting}
                  className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                >
                  {fullDisconnecting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Disconnecting...
                    </>
                  ) : (
                    <>
                      <Unlink size={14} />
                      Confirm Disconnect
                    </>
                  )}
                </button>
                <button
                  onClick={() => { setShowFullDisconnect(false); setFullDisconnectError(null); }}
                  disabled={fullDisconnecting}
                  className="px-3 py-1.5 text-sm rounded border border-border hover:bg-panel transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

    </div>
  );
}
