/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useDeferredValue, useMemo } from 'react';
import {
  Link2, Unlink, Loader2, CheckCircle2, AlertCircle,
  Webhook, FileText, RotateCcw, Download, Shield, ExternalLink,
  RefreshCw, GitPullRequest, Users, X, Plus, Zap, KeyRound,
  RadioTower, GitBranch, Activity, Lock, Copy,
} from 'lucide-react';
import { Github } from '../components/icons/GithubIcon';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch, BASE_URL, getAccessToken } from '../lib/apiFetch';

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
  'spec.brief': 'Add GitHub integration with auto-PR creation and PR description templates.',
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
  webhookId?: number;
  webhookUrl?: string;
  lastWebhookAt?: string | null;
  connectedAt?: string;
  autoPr?: {
    enabled: boolean;
    targetBranch: string;
    reviewers: string[];
  };
}

interface GithubAccount {
  connected: boolean;
  username?: string;
  avatarUrl?: string;
  connectedAt?: string;
  scopes?: string[];
  source?: 'workspace-api-key' | 'workspace-oauth' | 'legacy-global' | 'env';
}

interface GithubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  htmlUrl?: string;
  badgeUrl?: string;
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

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'repo': 'Full control of private repositories',
  'user:email': 'Access user email addresses',
  'user': 'Read user profile data',
  'read:user': 'Read user profile data',
  'admin:repo_hook': 'Full control of repository hooks',
  'write:repo_hook': 'Write repository hooks',
  'read:repo_hook': 'Read repository hooks',
  'admin:org': 'Full control of organizations',
  'read:org': 'Read organization membership',
  'workflow': 'Update GitHub Actions workflows',
  'write:packages': 'Upload packages',
  'read:packages': 'Download packages',
  'delete:packages': 'Delete packages',
};

const REQUIRED_CAPABILITIES = [
  { key: 'repo', label: 'Repository access', scopes: ['repo'] },
  { key: 'admin:repo_hook', label: 'Webhook management', scopes: ['admin:repo_hook', 'write:repo_hook'] },
  { key: 'workflow', label: 'Workflow dispatch', scopes: ['workflow'] },
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

  // Workspace repo connection
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // OAuth account
  const [account, setAccount] = useState<GithubAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);

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

  // Auto-PR
  const [autoPrEnabled, setAutoPrEnabled] = useState(false);
  const [autoPrBranch, setAutoPrBranch] = useState('main');
  const [autoPrReviewers, setAutoPrReviewers] = useState<string[]>([]);
  const [newReviewer, setNewReviewer] = useState('');
  const [savingAutoPr, setSavingAutoPr] = useState(false);
  const [savedAutoPr, setSavedAutoPr] = useState(false);

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

  // Workflow dispatch config (US-026)
  const [workflowEnabled, setWorkflowEnabled] = useState(false);
  const [workflowId, setWorkflowId] = useState('');
  const [workflowRef, setWorkflowRef] = useState('main');
  const [workflowInputsRaw, setWorkflowInputsRaw] = useState('{}');
  const [workflowConfigLoaded, setWorkflowConfigLoaded] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [savedWorkflow, setSavedWorkflow] = useState(false);
  const [workflowInputsError, setWorkflowInputsError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<GithubWorkflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);

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
      if (data.autoPr) {
        setAutoPrEnabled(data.autoPr.enabled);
        setAutoPrBranch(data.autoPr.targetBranch);
        setAutoPrReviewers(data.autoPr.reviewers);
      }
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

  useEffect(() => { fetchStatus(); fetchAccount(); }, [fetchStatus, fetchAccount]);

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

  // ─── Fetch workflow config (US-026) ──────────────────────────────────────

  useEffect(() => {
    if (!workspaceId || workflowConfigLoaded) return;
    apiFetch<{ workflowConfig: { enabled?: boolean; workflow_id?: string; ref?: string; inputs?: Record<string, string> } | null }>(
      `/api/workspaces/${workspaceId}/github/workflow-config`
    )
      .then(data => {
        const cfg = data.workflowConfig;
        if (cfg) {
          setWorkflowEnabled(cfg.enabled ?? false);
          setWorkflowId(cfg.workflow_id ?? '');
          setWorkflowRef(cfg.ref ?? 'main');
          setWorkflowInputsRaw(cfg.inputs && Object.keys(cfg.inputs).length > 0
            ? JSON.stringify(cfg.inputs, null, 2)
            : '{}');
        }
        setWorkflowConfigLoaded(true);
      })
      .catch(() => { setWorkflowConfigLoaded(true); });
  }, [workspaceId, workflowConfigLoaded]);

  const fetchWorkflows = useCallback(async () => {
    if (!workspaceId || !status?.connected) return;
    setWorkflowsLoading(true);
    setWorkflowsError(null);
    try {
      const data = await apiFetch<{ workflows: GithubWorkflow[] }>(`/api/workspaces/${workspaceId}/github/workflows`);
      setWorkflows(data.workflows || []);
    } catch (err: unknown) {
      setWorkflowsError(err instanceof Error ? err.message : 'Failed to load workflows');
      setWorkflows([]);
    } finally {
      setWorkflowsLoading(false);
    }
  }, [workspaceId, status?.connected]);

  useEffect(() => {
    if (status?.connected) fetchWorkflows();
  }, [status?.connected, fetchWorkflows]);

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
  const webhookIsLocal = isLocalWebhookUrl(webhookUrl);
  const credentialOk = !!account?.connected;
  const repoOk = !!status?.connected;
  const webhookOk = !!status?.connected && !!status.webhookId && !webhookIsLocal;
  const workflowOk = repoOk && workflowEnabled && !!workflowId.trim();
  const autoPrOk = repoOk && autoPrEnabled;
  const missingCapabilities = useMemo(() => {
    if (!account?.connected || !account.scopes?.length) return [];
    return REQUIRED_CAPABILITIES.filter(capability => !hasAnyScope(account.scopes, capability.scopes));
  }, [account?.connected, account?.scopes]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  async function handleConnect() {
    if (!workspaceId || !repoOwner.trim() || !repoName.trim() || !githubToken.trim()) return;
    setConnecting(true);
    setConnectError(null);
    setConnectSuccess(false);
    try {
      const data = await apiFetch<GithubStatus & { error?: string; manualSetupUrl?: string }>(
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
      await apiFetch(`/api/workspaces/${workspaceId}/github/disconnect`, {
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
      await apiFetch(`/api/workspaces/${workspaceId}/github/webhook-ping`, { method: 'POST' });
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
      await apiFetch<{ disconnected: boolean }>(`/api/workspaces/${workspaceId}/github`, {
        method: 'DELETE',
      });
      setAccount({ connected: false });
      setStatus({ connected: false });
      setShowFullDisconnect(false);
      // Re-fetch to confirm server state
      fetchAccount();
      fetchStatus();
    } catch (err: unknown) {
      setFullDisconnectError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setFullDisconnecting(false);
    }
  }

  async function handleSaveAutoPr() {
    if (!workspaceId || savingAutoPr) return;
    setSavingAutoPr(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/github/auto-pr`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: autoPrEnabled, targetBranch: autoPrBranch, reviewers: autoPrReviewers }),
      });
      setSavedAutoPr(true);
      setTimeout(() => setSavedAutoPr(false), 2000);
    } catch {
      // silent
    } finally {
      setSavingAutoPr(false);
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

  function addReviewer() {
    const r = newReviewer.trim();
    if (r && !autoPrReviewers.includes(r)) {
      setAutoPrReviewers([...autoPrReviewers, r]);
      setNewReviewer('');
    }
  }

  async function handleSaveWorkflowConfig() {
    if (!workspaceId || savingWorkflow) return;
    // Validate inputs JSON
    let inputs: Record<string, string> = {};
    if (workflowInputsRaw.trim() && workflowInputsRaw.trim() !== '{}') {
      try {
        inputs = JSON.parse(workflowInputsRaw);
        setWorkflowInputsError(null);
      } catch {
        setWorkflowInputsError('Invalid JSON in inputs field');
        return;
      }
    }
    setSavingWorkflow(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/github/workflow-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: workflowEnabled,
          workflow_id: workflowId.trim(),
          ref: workflowRef.trim() || 'main',
          inputs,
        }),
      });
      setSavedWorkflow(true);
      setTimeout(() => setSavedWorkflow(false), 2000);
    } catch {
      // silent
    } finally {
      setSavingWorkflow(false);
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
              Connect local Rorca to a GitHub repository, then monitor credential health, webhook delivery, workflow dispatch, and auto-PR readiness from one place.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill ok={credentialOk} label={credentialOk ? 'Credential connected' : 'Credential missing'} />
            <StatusPill ok={repoOk} label={repoOk ? 'Repository connected' : 'Repository disconnected'} />
            <StatusPill ok={webhookOk} warn={repoOk && !webhookOk} label={webhookOk ? 'Webhook reachable' : repoOk ? 'Webhook needs public URL' : 'Webhook locked'} />
            <StatusPill ok={workflowOk} label={workflowOk ? 'Workflow enabled' : 'Workflow idle'} />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-5">
          {[
            { icon: KeyRound, title: 'Credential', value: credentialOk ? account?.username ? `@${account.username}` : 'Connected' : 'Add PAT', tone: credentialOk ? 'text-emerald-300' : 'text-muted' },
            { icon: Github, title: 'Repository', value: repoOk ? `${status?.repoOwner}/${status?.repoName}` : 'Not connected', tone: repoOk ? 'text-emerald-300' : 'text-muted' },
            { icon: RadioTower, title: 'Webhook', value: repoOk ? timeAgo(status?.lastWebhookAt) : 'Locked', tone: webhookOk ? 'text-emerald-300' : repoOk ? 'text-amber-300' : 'text-muted' },
            { icon: GitBranch, title: 'Workflow', value: workflowOk ? workflowId : workflowsLoading ? 'Loading…' : `${workflows.length} discovered`, tone: workflowOk ? 'text-emerald-300' : 'text-muted' },
            { icon: GitPullRequest, title: 'Auto PR', value: autoPrOk ? `to ${autoPrBranch}` : 'Disabled', tone: autoPrOk ? 'text-emerald-300' : 'text-muted' },
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
                  ? `Stored locally and encrypted for this workspace${account.source ? ` · Source: ${account.source}` : ''}.`
                  : 'Paste a PAT in the repository form below. Rorca stores it locally and encrypted for this workspace.'}
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
                {!showOAuthDisconnect ? (
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
                )}
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
                  <span className="text-muted">Webhook ID</span>
                  <p className="font-mono text-[var(--text)]">#{status.webhookId}</p>
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

              {status.webhookId ? (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Webhook size={14} />
                    Events: push, pull_request, issues, check_run
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
                      <button
                        onClick={handlePingWebhook}
                        disabled={pingingWebhook}
                        className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {pingingWebhook ? <Loader2 size={12} className="animate-spin" /> : <RadioTower size={12} />}
                        Ping webhook
                      </button>
                      {status.repoOwner && status.repoName && (
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
              Connect the repository Rorca should watch and operate on. This unlocks webhook health, workflow discovery, PR templates, and auto-PR settings.
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
                Stored locally and encrypted for this workspace. Required capabilities: repo, admin/write repo hook, and workflow for dispatch.
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

      {/* ─── Section 3: Auto-PR Settings ──────────────────────────────── */}
      {status?.connected ? (
        <section className="border-t border-border pt-6">
          <div className="flex items-center gap-2 mb-4">
            <GitPullRequest size={20} strokeWidth={1.5} />
            <h2 className="text-base font-semibold text-[var(--text)]">Auto-PR Settings</h2>
          </div>

          <div className="rounded-lg border border-border bg-panel p-4 space-y-4">
            {/* Enable toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <button
                type="button"
                role="switch"
                aria-checked={autoPrEnabled}
                onClick={() => setAutoPrEnabled(!autoPrEnabled)}
                onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setAutoPrEnabled(!autoPrEnabled); } }}
                aria-label="Automatically create pull requests on run completion"
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                  autoPrEnabled ? 'bg-accent' : 'bg-border'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-switch-knob shadow-sm transition-transform ${
                    autoPrEnabled ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
              <span className="text-sm text-[var(--text)]">
                Automatically create pull requests on run completion
              </span>
            </label>

            {autoPrEnabled && (
              <>
                {/* Target branch */}
                <label className="block text-xs text-muted">
                  Target branch
                  <input
                    type="text"
                    value={autoPrBranch}
                    onChange={e => setAutoPrBranch(e.target.value)}
                    placeholder="main"
                    className="mt-1 w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                  />
                </label>

                {/* Reviewers */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Users size={14} className="text-muted" />
                    <span className="text-xs font-medium text-muted">Reviewers</span>
                  </div>

                  {autoPrReviewers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {autoPrReviewers.map(r => (
                        <span
                          key={r}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-accent/10 text-accent"
                        >
                          @{r}
                          <button
                            onClick={() => setAutoPrReviewers(autoPrReviewers.filter(x => x !== r))}
                            className="hover:text-red-400 transition-colors"
                          >
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newReviewer}
                      onChange={e => setNewReviewer(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addReviewer(); } }}
                      placeholder="GitHub username"
                      className="flex-1 px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                    />
                    <button
                      onClick={addReviewer}
                      disabled={!newReviewer.trim()}
                      className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      <Plus size={12} /> Add
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Save button */}
            <button
              onClick={handleSaveAutoPr}
              disabled={savingAutoPr}
              className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-1.5"
            >
              {savingAutoPr ? <Loader2 size={14} className="animate-spin" /> : null}
              {savedAutoPr ? 'Saved!' : 'Save Auto-PR Settings'}
            </button>
          </div>
        </section>
      ) : (
        <section className="border-t border-border pt-6">
          <div className="flex items-center gap-2 mb-4">
            <GitPullRequest size={20} strokeWidth={1.5} />
            <h2 className="text-base font-semibold text-[var(--text)]">Auto-PR Settings</h2>
          </div>
          <LockedPanel
            title="Connect a repository to enable Auto-PRs"
            message="Rorca needs repository metadata and a GitHub credential before it can create pull requests after successful runs."
          />
        </section>
      )}

      {/* ─── Section 4: GitHub Actions YAML ───────────────────────────── */}
      <section className="border-t border-border pt-6">
        <div className="flex items-center gap-2 mb-3">
          <Download size={18} />
          <h2 className="text-sm font-semibold text-[var(--text)]">GitHub Actions Workflow</h2>
        </div>
        <p className="text-xs text-muted mb-3">
          Download a GitHub Actions workflow that triggers Rorca pipeline runs on push to main.
          Place the file at <code className="bg-surface px-1 rounded">.github/workflows/rorca-pipeline.yml</code> in your repository.
        </p>
        <p className="text-xs text-muted mb-3">
          Required repository secrets:{' '}
          <code className="bg-surface px-1 rounded">RORCA_API_URL</code>,{' '}
          <code className="bg-surface px-1 rounded">RORCA_API_TOKEN</code>,{' '}
          <code className="bg-surface px-1 rounded">WORKSPACE_ID</code>
        </p>
        <button
          onClick={async () => {
            if (!workspaceId) return;
            try {
              const token = await getAccessToken();
              const res = await fetch(`${BASE_URL}/api/workspaces/${workspaceId}/github/actions-yaml`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {},
              });
              if (!res.ok) throw new Error(`${res.status}`);
              const text = await res.text();
              const blob = new Blob([text], { type: 'application/x-yaml' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'rorca-pipeline.yml';
              a.click();
              URL.revokeObjectURL(url);
            } catch (err) {
              console.error('[GitHubSettings] YAML download error:', err);
            }
          }}
          className="px-4 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity flex items-center gap-1.5"
        >
          <Download size={14} />
          Download Actions YAML
        </button>
      </section>

      {/* ─── Section 5: Workflow Dispatch (US-026) ───────────────────── */}
      <section className="border-t border-border pt-6 pb-6">
        <div className="flex items-center gap-2 mb-3">
          <Zap size={18} />
          <h2 className="text-sm font-semibold text-[var(--text)]">Workflows</h2>
        </div>

        {!status?.connected ? (
          <LockedPanel
            title="Connect a repository to enable workflows"
            message="Rorca will discover GitHub Actions workflows from the connected repo and let you choose a workflow_dispatch target."
          />
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted">
              Automatically trigger a GitHub Actions workflow when a pipeline run completes successfully.
              The workflow must have a <code className="bg-surface px-1 rounded">workflow_dispatch</code> trigger.
              Requires the <code className="bg-surface px-1 rounded">workflow</code> PAT scope.
            </p>

            {/* Enable toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <div
                role="switch"
                aria-checked={workflowEnabled}
                tabIndex={0}
                onClick={() => setWorkflowEnabled(v => !v)}
                onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') setWorkflowEnabled(v => !v); }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 ${workflowEnabled ? 'bg-accent' : 'bg-border'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${workflowEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-sm text-[var(--text)]">Enable workflow dispatch on run completion</span>
            </label>

            {workflowEnabled && (
              <div className="space-y-3 pl-0">
                {/* Workflow file */}
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="block text-xs font-medium text-muted">Workflow</label>
                    <button
                      type="button"
                      onClick={fetchWorkflows}
                      disabled={workflowsLoading}
                      className="text-xs text-muted hover:text-[var(--text)] transition-colors flex items-center gap-1 disabled:opacity-50"
                    >
                      {workflowsLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      Refresh
                    </button>
                  </div>
                  {workflows.length > 0 ? (
                    <select
                      value={workflowId}
                      onChange={e => setWorkflowId(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                    >
                      <option value="">Select workflow…</option>
                      {workflows.map(workflow => (
                        <option key={workflow.id} value={workflow.path || String(workflow.id)}>
                          {workflow.name} · {workflow.path} · {workflow.state}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={workflowId}
                      onChange={e => setWorkflowId(e.target.value)}
                      placeholder="deploy.yml"
                      className="w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                    />
                  )}
                  {workflowsError ? (
                    <p className="text-[11px] text-amber-300 mt-1">{workflowsError}. You can still enter a workflow filename manually.</p>
                  ) : (
                    <p className="text-[11px] text-muted mt-1">
                      Choose a discovered workflow, or enter a filename/numeric ID manually if discovery is unavailable.
                    </p>
                  )}
                  {workflowId && workflows.find(w => (w.path || String(w.id)) === workflowId)?.htmlUrl && (
                    <a
                      href={workflows.find(w => (w.path || String(w.id)) === workflowId)?.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                    >
                      <ExternalLink size={11} /> Open workflow in GitHub
                    </a>
                  )}
                </div>

                {/* Branch ref */}
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Branch / ref</label>
                  <input
                    type="text"
                    value={workflowRef}
                    onChange={e => setWorkflowRef(e.target.value)}
                    placeholder="main"
                    className="w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                  />
                  <p className="text-[11px] text-muted mt-1">Branch or tag to run the workflow on.</p>
                </div>

                {/* Inputs */}
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Inputs (JSON)</label>
                  <textarea
                    value={workflowInputsRaw}
                    onChange={e => { setWorkflowInputsRaw(e.target.value); setWorkflowInputsError(null); }}
                    rows={4}
                    placeholder='{}'
                    className={`w-full px-3 py-2 rounded bg-bg border text-sm font-mono text-[var(--text)] focus:outline-none resize-y ${workflowInputsError ? 'border-red-500' : 'border-border focus:border-accent'}`}
                  />
                  {workflowInputsError && (
                    <p className="text-[11px] text-red-400 mt-1">{workflowInputsError}</p>
                  )}
                  <p className="text-[11px] text-muted mt-1">
                    Optional key-value pairs passed as workflow inputs. Must be valid JSON object.
                  </p>
                </div>
              </div>
            )}

            {!workflowEnabled && !workflowId && (
              <p className="text-xs text-muted italic">
                No workflow configured — add a GitHub Actions workflow to trigger on run completion.
              </p>
            )}

            <button
              onClick={handleSaveWorkflowConfig}
              disabled={savingWorkflow}
              className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-1.5"
            >
              {savingWorkflow ? <Loader2 size={14} className="animate-spin" /> : null}
              {savedWorkflow ? 'Saved!' : 'Save Workflow Config'}
            </button>
          </div>
        )}
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
            Customize the PR description used by auto-PR creation. Unrecognized variables are left as-is.
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
