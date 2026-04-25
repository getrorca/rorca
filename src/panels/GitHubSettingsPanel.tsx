import { useState, useEffect, useCallback, useDeferredValue } from 'react';
import {
  Github, Link2, Unlink, Loader2, CheckCircle2, AlertCircle,
  Webhook, FileText, RotateCcw, Download, Shield, ExternalLink,
  RefreshCw, GitPullRequest, Users, X, Plus, Zap, Bot, ScrollText,
} from 'lucide-react';
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
  // Deferred so the preview update doesn't block keystrokes
  const deferredPrTemplate = useDeferredValue(prTemplate);
  const previewText = renderPreview(deferredPrTemplate);

  // Workflow dispatch config (US-026)
  const [workflowEnabled, setWorkflowEnabled] = useState(false);
  const [workflowId, setWorkflowId] = useState('');
  const [workflowRef, setWorkflowRef] = useState('main');
  const [workflowInputsRaw, setWorkflowInputsRaw] = useState('{}');
  const [workflowConfigLoaded, setWorkflowConfigLoaded] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [savedWorkflow, setSavedWorkflow] = useState(false);
  const [workflowInputsError, setWorkflowInputsError] = useState<string | null>(null);

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
    } catch {
      setTestResult({ valid: false, error: 'Request failed' });
    } finally {
      setTesting(false);
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
          workflowConfig: {
            enabled: workflowEnabled,
            workflow_id: workflowId.trim(),
            ref: workflowRef.trim() || 'main',
            inputs,
          },
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
      className="h-full overflow-y-auto max-w-2xl mx-auto space-y-8 px-4 sm:px-0"
    >
      {/* ─── Section 1: OAuth Account ─────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Github size={20} strokeWidth={1.5} />
          <h2 className="text-base font-semibold text-[var(--text)]">GitHub Account</h2>
        </div>

        {accountLoading ? (
          <div className="flex items-center gap-2 text-muted text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading account...
          </div>
        ) : account?.connected ? (
          <div className="rounded-lg border border-border bg-panel p-4 space-y-4">
            {/* Account info row */}
            <div className="flex items-center gap-3">
              <img
                src={account.avatarUrl}
                alt={account.username}
                loading="lazy"
                className="w-10 h-10 rounded-full border border-border"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text)] truncate">
                  @{account.username}
                </p>
                <p className="text-xs text-muted">
                  Connected {account.connectedAt ? new Date(account.connectedAt).toLocaleDateString() : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTestConnection}
                  disabled={testing}
                  className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {testing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Test
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
              </div>
            </div>

            {/* OAuth disconnect error */}
            {oauthDisconnectError && (
              <div className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle size={12} />
                {oauthDisconnectError}
              </div>
            )}

            {/* Test result */}
            {testResult && (
              <div className={`flex items-center gap-1.5 text-xs ${testResult.valid ? 'text-emerald-400' : 'text-red-400'}`}>
                {testResult.valid ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {testResult.valid ? `Token valid (${testResult.username})` : `Token invalid: ${testResult.error}`}
              </div>
            )}

            {/* Scopes */}
            {account.scopes && account.scopes.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Shield size={14} className="text-muted" />
                  <span className="text-xs font-medium text-muted">Granted Scopes</span>
                </div>
                <div className="space-y-1">
                  {account.scopes.map(scope => (
                    <div key={scope} className="flex items-center gap-2 text-xs">
                      <code className="px-1.5 py-0.5 rounded bg-bg border border-border text-[var(--text)] font-mono">
                        {scope}
                      </code>
                      <span className="text-muted">
                        {SCOPE_DESCRIPTIONS[scope] || 'Access granted'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-panel p-4">
            <p className="text-sm text-muted mb-3">
              No GitHub account connected. Workspace GitHub integration is configured separately from user sign-in.
            </p>
          </div>
        )}
      </section>

      {/* ─── Section 2: Workspace Repository ──────────────────────────── */}
      <section className="border-t border-border pt-6">
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
                <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                  <Webhook size={14} />
                  Events: push, pull_request, issues, check_run
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
              Connect a GitHub repository to receive push, pull_request, issue, and check_run events via webhook.
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
              GitHub personal access token (needs admin:repo_hook scope)
              <input
                type="password"
                value={githubToken}
                onChange={e => setGithubToken(e.target.value)}
                placeholder="ghp_..."
                className="mt-1 w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
              />
            </label>

            <p className="text-xs text-muted">
              The token is only used to create the webhook and is not stored.
            </p>

            {connectError && (
              <div className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle size={12} /> {connectError}
              </div>
            )}

            <button
              onClick={handleConnect}
              disabled={connecting || !repoOwner.trim() || !repoName.trim() || !githubToken.trim()}
              className="px-4 py-2 text-sm rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-1.5"
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
          </div>
        )}
        </div>
      </section>

      {/* ─── Section 3: Auto-PR Settings ──────────────────────────────── */}
      {status?.connected && (
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
          <p className="text-xs text-muted">
            No workflow configured — add a GitHub Actions workflow to trigger on run completion.
            Connect a repository above to enable this feature.
          </p>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted">
              Automatically trigger a GitHub Actions workflow when a pipeline run completes successfully.
              The workflow must have a <code className="bg-surface px-1 rounded">workflow_dispatch</code> trigger.
              Requires the <code className="bg-surface px-1 rounded">workflow</code> OAuth scope.
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
                  <label className="block text-xs font-medium text-muted mb-1">Workflow filename</label>
                  <input
                    type="text"
                    value={workflowId}
                    onChange={e => setWorkflowId(e.target.value)}
                    placeholder="deploy.yml"
                    className="w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                  />
                  <p className="text-[11px] text-muted mt-1">
                    Filename of the workflow (e.g. <code className="bg-surface px-1 rounded">deploy.yml</code>) or numeric workflow ID.
                  </p>
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

      {/* ── CI Autofix ───────────────────────────────────────────────────────── */}
      <CiAutofixSection workspaceId={workspaceId} />

      {/* ─── Section 6: PR Template ───────────────────────────────────── */}
      <section className="border-t border-border pt-6 pb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText size={18} />
            <h2 className="text-sm font-semibold text-[var(--text)]">PR Description Template</h2>
          </div>
          <button
            onClick={() => setPrTemplatePreviewVisible(v => !v)}
            className="text-xs text-muted hover:text-[var(--text)] transition-colors border border-border rounded px-2 py-1"
          >
            {prTemplatePreviewVisible ? 'Hide Preview' : 'Show Preview'}
          </button>
        </div>

        <p className="text-xs text-muted mb-3">
          Customize the PR description used by auto-PR creation (US-028).
          Supported variables:{' '}
          {[
            '{{spec.title}}', '{{spec.brief}}',
            '{{run.storiesPassed}}', '{{run.storiesTotal}}',
            '{{run.storiesFailed}}', '{{run.storiesSkipped}}',
            '{{run.tokensInput}}', '{{run.tokensOutput}}', '{{run.tokensTotal}}',
            '{{run.costUsd}}', '{{run.duration}}',
            '{{run.agentType}}', '{{run.model}}',
            '{{run.id}}', '{{run.diffStats}}',
          ].map((v, i) => (
            <span key={v}>
              <code className="bg-surface px-1 rounded">{v}</code>
              {i < 14 ? ', ' : ''}
            </span>
          ))}
          . Unrecognized variables are left as-is.
        </p>

        {!prTemplateLoaded ? (
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
                  <label className="block text-xs text-muted">Preview (sample data)</label>
                </div>
                {deferredPrTemplate !== prTemplate ? (
                  /* Skeleton while deferred value is stale */
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
            disabled={prTemplateSaving || !prTemplateLoaded}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-1.5"
          >
            {prTemplateSaving ? <Loader2 size={14} className="animate-spin" /> : null}
            {prTemplateSaved ? 'Saved!' : 'Save Template'}
          </button>
          <button
            onClick={() => { setPrTemplate(''); setPrTemplateSaved(false); }}
            disabled={!prTemplateLoaded}
            className="px-3 py-1.5 text-sm rounded border border-border hover:bg-panel transition-colors flex items-center gap-1.5 text-muted disabled:opacity-50"
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
                This will revoke the OAuth token and remove all GitHub-specific data.
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

// ─── CI Autofix section (embedded in GitHub settings) ────────────────────────

interface CiAutofixRun {
  id: number;
  headSha: string;
  branchName: string;
  checkRunName: string;
  annotationCount: number;
  agentType: string;
  status: 'triggered' | 'completed' | 'failed' | 'skipped';
  errorSummary: string | null;
  createdAt: string;
  finishedAt: string | null;
  runId: number | null;
}

interface CiAutofixConfig {
  enabled: boolean;
  checkPatterns: string[] | null;
  maxRetries: number;
  recentRuns: CiAutofixRun[];
}

function shortSha(sha: string) { return sha.slice(0, 7); }

function ciRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function CiStatusBadge({ status }: { status: CiAutofixRun['status'] }) {
  const map = {
    triggered: { icon: Loader2, label: 'Running',  cls: 'text-amber-400 bg-amber-400/10', spin: true },
    completed: { icon: CheckCircle2, label: 'Fixed', cls: 'text-green-400 bg-green-400/10', spin: false },
    failed:    { icon: AlertCircle,  label: 'Failed', cls: 'text-red-400 bg-red-400/10', spin: false },
    skipped:   { icon: AlertCircle,  label: 'Skipped', cls: 'text-muted bg-border/30', spin: false },
  };
  const { icon: Icon, label, cls, spin } = map[status] ?? map.skipped;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>
      <Icon size={11} className={spin ? 'animate-spin' : ''} />
      {label}
    </span>
  );
}

function CiAutofixSection({ workspaceId }: { workspaceId: string | null }) {
  const [config, setConfig] = useState<CiAutofixConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [maxRetries, setMaxRetries] = useState(2);
  const [newPattern, setNewPattern] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<CiAutofixConfig>(`/api/workspaces/${workspaceId}/ci-autofix`);
      setConfig(data);
      setEnabled(data.enabled);
      setPatterns(data.checkPatterns ?? ['*']);
      setMaxRetries(data.maxRetries);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!workspaceId || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/ci-autofix`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled, checkPatterns: patterns.length > 0 ? patterns : null, maxRetries }),
      });
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addPattern = () => {
    const val = newPattern.trim();
    if (!val || patterns.includes(val)) return;
    setPatterns(p => [...p, val]);
    setNewPattern('');
    setDirty(true);
  };

  if (!workspaceId) return null;

  return (
    <>
      <hr className="border-border my-2" />

      <section className="space-y-5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-accent shrink-0" />
          <h2 className="text-sm font-semibold text-[var(--text)]">CI Autofix</h2>
        </div>
        <p className="text-xs text-muted -mt-3 leading-relaxed">
          When a GitHub check run fails, Rorca auto-generates a fix spec, runs it with your configured agent, and pushes the fix back to the source branch.
        </p>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-muted text-sm">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {/* Enable toggle */}
            <label className="flex items-center justify-between p-3 rounded-lg border border-border cursor-pointer hover:border-accent/30 transition-colors">
              <div>
                <div className="text-sm font-medium text-[var(--text)]">Enable CI Autofix</div>
                <div className="text-xs text-muted mt-0.5">
                  Triggers on <code className="font-mono bg-border/40 px-1 rounded text-[10px]">check_run</code> webhook failures
                </div>
              </div>
              <div className="relative flex items-center justify-center shrink-0 ml-4">
                <input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); setDirty(true); }} className="peer sr-only" />
                <div className="w-9 h-5 rounded-full bg-border peer-checked:bg-accent transition-colors" />
                <div className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
              </div>
            </label>

            {/* Check patterns */}
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted uppercase tracking-wider">Check Name Patterns</div>
              <p className="text-xs text-muted">Glob patterns (micromatch) — which check names trigger autofix. Use <code className="font-mono bg-border/40 px-1 rounded">*</code> for all.</p>
              <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                {patterns.map((p, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/15 text-accent text-[12px] font-mono border border-accent/20">
                    {p}
                    <button type="button" onClick={() => { setPatterns(prev => prev.filter((_, j) => j !== i)); setDirty(true); }} className="hover:text-red-400 transition-colors">
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {patterns.length === 0 && <span className="text-xs text-muted/60 italic">No patterns</span>}
              </div>
              <div className="flex gap-2">
                <input
                  type="text" value={newPattern} onChange={e => setNewPattern(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addPattern()}
                  placeholder="e.g.  typecheck  or  ci / *"
                  className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-[var(--bg)] text-sm text-[var(--text)] placeholder:text-muted focus:outline-none focus:border-accent/60 font-mono"
                />
                <button type="button" onClick={addPattern} disabled={!newPattern.trim()}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-sm text-muted hover:border-accent/40 hover:text-accent disabled:opacity-40 transition-colors">
                  <Plus size={13} /> Add
                </button>
              </div>
            </div>

            {/* Max retries */}
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted uppercase tracking-wider">Max Retries per SHA</div>
              <div className="flex gap-1.5">
                {[1,2,3,4,5].map(n => (
                  <button key={n} type="button" onClick={() => { setMaxRetries(n); setDirty(true); }}
                    className={`w-10 py-1.5 rounded text-sm font-medium border transition-colors ${maxRetries === n ? 'bg-accent text-white border-accent' : 'bg-[var(--bg)] text-muted border-border hover:border-accent/40 hover:text-[var(--text)]'}`}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Save */}
            {saved && <p className="text-xs text-green-400">Saved</p>}
            {dirty && (
              <div className="flex items-center gap-3">
                <button type="button" onClick={save} disabled={saving}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60 transition-colors">
                  {saving && <RefreshCw size={13} className="animate-spin" />}
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => { if (config) { setEnabled(config.enabled); setPatterns(config.checkPatterns ?? ['*']); setMaxRetries(config.maxRetries); setDirty(false); } }}
                  className="text-sm text-muted hover:text-[var(--text)] transition-colors">Cancel</button>
              </div>
            )}

            {/* Recent runs */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
                  <ScrollText size={12} /> Recent Autofix Runs
                </div>
                <button type="button" onClick={load} className="text-muted hover:text-[var(--text)] transition-colors" aria-label="Refresh">
                  <RefreshCw size={12} />
                </button>
              </div>
              {(config?.recentRuns?.length ?? 0) === 0 ? (
                <div className="p-4 rounded-lg border border-border text-center text-xs text-muted">
                  No autofix runs yet. Rorca will attempt fixes here once CI checks start failing.
                </div>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                  {(config?.recentRuns ?? []).map(run => (
                    <div key={run.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-white/2 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className="text-xs font-mono text-[var(--text)]">{shortSha(run.headSha)}</code>
                          <span className="text-xs text-muted truncate max-w-[140px]">{run.branchName}</span>
                          <CiStatusBadge status={run.status} />
                          <span className="text-[10px] text-muted/60 font-mono uppercase">{run.agentType}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted truncate">{run.checkRunName}</div>
                        {run.errorSummary && <div className="mt-0.5 text-[11px] text-red-400/80 line-clamp-1">{run.errorSummary}</div>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 text-[10px] text-muted">
                        <span>{ciRelativeTime(run.createdAt)}</span>
                        {run.runId && <a href={`/runs/${run.runId}`} className="text-accent hover:underline flex items-center gap-0.5">Run <ExternalLink size={9} /></a>}
                        <span className="text-muted/50">{run.annotationCount}err</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
