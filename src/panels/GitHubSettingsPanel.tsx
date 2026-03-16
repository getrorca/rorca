import { useState, useEffect, useCallback } from 'react';
import {
  Github, Link2, Unlink, Loader2, CheckCircle2, AlertCircle,
  Webhook, FileText, RotateCcw, Download, Shield, ExternalLink,
  RefreshCw, GitPullRequest, Users, X, Plus, UserCheck, FolderGit2, Tag,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch, BASE_URL, getAccessToken } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReviewConfig {
  defaultReviewers?: string[];
  teamReviewers?: string[];
  rules?: ConditionalRule[];
  pathRules?: PathRule[];
}

interface ConditionalRule {
  condition: { field: 'tag' | 'persona'; matches: string };
  reviewers?: string[];
  teamReviewers?: string[];
}

interface PathRule {
  pattern: string;
  reviewers?: string[];
  teamReviewers?: string[];
}

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
  reviewConfig?: ReviewConfig;
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

  // Disconnect (webhook)
  const [disconnectToken, setDisconnectToken] = useState('');
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  // OAuth disconnect
  const [disconnectingOAuth, setDisconnectingOAuth] = useState(false);
  const [showOAuthDisconnect, setShowOAuthDisconnect] = useState(false);

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

  // Review Requests config
  const [rcDefaultReviewers, setRcDefaultReviewers] = useState<string[]>([]);
  const [rcTeamReviewers, setRcTeamReviewers] = useState<string[]>([]);
  const [rcRules, setRcRules] = useState<ConditionalRule[]>([]);
  const [rcPathRules, setRcPathRules] = useState<PathRule[]>([]);
  const [newDefaultReviewer, setNewDefaultReviewer] = useState('');
  const [newTeamReviewer, setNewTeamReviewer] = useState('');
  const [savingReviewConfig, setSavingReviewConfig] = useState(false);
  const [savedReviewConfig, setSavedReviewConfig] = useState(false);

  // PR template
  const [prTemplate, setPrTemplate] = useState('');
  const [prTemplateSaving, setPrTemplateSaving] = useState(false);
  const [prTemplateSaved, setPrTemplateSaved] = useState(false);
  const [prTemplateLoaded, setPrTemplateLoaded] = useState(false);

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
      if (data.reviewConfig) {
        setRcDefaultReviewers(data.reviewConfig.defaultReviewers ?? []);
        setRcTeamReviewers(data.reviewConfig.teamReviewers ?? []);
        setRcRules(data.reviewConfig.rules ?? []);
        setRcPathRules(data.reviewConfig.pathRules ?? []);
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

  // ─── Fetch PR template ───────────────────────────────────────────────────

  useEffect(() => {
    if (!workspaceId || prTemplateLoaded) return;
    apiFetch<{ workspace: { pr_template: string | null } }>(`/api/workspaces/${workspaceId}`)
      .then(data => {
        setPrTemplate(data.workspace.pr_template ?? '');
        setPrTemplateLoaded(true);
      })
      .catch(() => { setPrTemplateLoaded(true); });
  }, [workspaceId, prTemplateLoaded]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  async function handleConnect() {
    if (!workspaceId || !repoOwner.trim() || !repoName.trim() || !githubToken.trim()) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const data = await apiFetch<GithubStatus>(`/api/workspaces/${workspaceId}/github/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoOwner: repoOwner.trim(), repoName: repoName.trim(), githubToken: githubToken.trim() }),
      });
      setStatus(data);
      setRepoOwner('');
      setRepoName('');
      setGithubToken('');
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
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/github/disconnect-oauth`, { method: 'POST' });
      setAccount({ connected: false });
      setShowOAuthDisconnect(false);
    } catch {
      // silent
    } finally {
      setDisconnectingOAuth(false);
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
      await apiFetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr_template: prTemplate || null }),
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

  // ─── Review Config handlers ──────────────────────────────────────────────

  const isValidUsername = (u: string) => /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(u);

  function addDefaultReviewer() {
    const r = newDefaultReviewer.trim().replace(/^@/, '');
    if (r && isValidUsername(r) && !rcDefaultReviewers.includes(r)) {
      setRcDefaultReviewers([...rcDefaultReviewers, r]);
      setNewDefaultReviewer('');
    }
  }

  function addTeamReviewer() {
    const t = newTeamReviewer.trim().replace(/^@/, '');
    if (t && !rcTeamReviewers.includes(t)) {
      setRcTeamReviewers([...rcTeamReviewers, t]);
      setNewTeamReviewer('');
    }
  }

  function addConditionalRule() {
    setRcRules([...rcRules, { condition: { field: 'tag', matches: '' }, reviewers: [], teamReviewers: [] }]);
  }

  function updateRule(idx: number, patch: Partial<ConditionalRule>) {
    setRcRules(rcRules.map((r, i) => i === idx ? { ...r, ...patch } : r));
  }

  function removeRule(idx: number) {
    setRcRules(rcRules.filter((_, i) => i !== idx));
  }

  function addPathRule() {
    setRcPathRules([...rcPathRules, { pattern: '', reviewers: [], teamReviewers: [] }]);
  }

  function updatePathRule(idx: number, patch: Partial<PathRule>) {
    setRcPathRules(rcPathRules.map((r, i) => i === idx ? { ...r, ...patch } : r));
  }

  function removePathRule(idx: number) {
    setRcPathRules(rcPathRules.filter((_, i) => i !== idx));
  }

  async function handleSaveReviewConfig() {
    if (!workspaceId || savingReviewConfig) return;
    setSavingReviewConfig(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/github/review-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultReviewers: rcDefaultReviewers,
          teamReviewers: rcTeamReviewers,
          rules: rcRules.filter(r => r.condition.matches.trim()),
          pathRules: rcPathRules.filter(r => r.pattern.trim()),
        }),
      });
      setSavedReviewConfig(true);
      setTimeout(() => setSavedReviewConfig(false), 2000);
    } catch {
      // silent
    } finally {
      setSavingReviewConfig(false);
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
                  Connected {account.connectedAt ? new Date(account.connectedAt + 'Z').toLocaleDateString() : ''}
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
                      onClick={() => setShowOAuthDisconnect(false)}
                      className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>

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
              No GitHub account connected. Use OAuth to connect your GitHub account.
            </p>
            <a
              href={`${BASE_URL}/api/auth/github`}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded bg-surface-200 text-text hover:bg-border transition-colors"
            >
              <Github size={16} />
              Connect with GitHub
              <ExternalLink size={12} />
            </a>
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
                    {status.connectedAt ? new Date(status.connectedAt + 'Z').toLocaleDateString() : '-'}
                  </p>
                </div>
                <div>
                  <span className="text-muted">Last webhook</span>
                  <p className="text-[var(--text)]">
                    {status.lastWebhookAt ? new Date(status.lastWebhookAt + 'Z').toLocaleString() : 'None yet'}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                <Webhook size={14} />
                Events: push, pull_request, issues
              </div>
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
              Connect a GitHub repository to receive push, pull_request, and issue events via webhook.
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
              {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
              Connect GitHub
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

      {/* ─── Section 4: Review Requests ────────────────────────────────── */}
      {status?.connected && (
        <section className="border-t border-border pt-6">
          <div className="flex items-center gap-2 mb-4">
            <UserCheck size={20} strokeWidth={1.5} />
            <h2 className="text-base font-semibold text-[var(--text)]">Review Requests</h2>
          </div>

          <div className="rounded-lg border border-border bg-panel p-4 space-y-5">
            {/* Default reviewers */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Users size={14} className="text-muted" />
                <span className="text-xs font-medium text-muted">Default Reviewers (GitHub usernames)</span>
              </div>
              <p className="text-xs text-muted mb-2">
                These reviewers are requested on every PR created by a pipeline run.
              </p>

              {rcDefaultReviewers.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {rcDefaultReviewers.map(r => (
                    <span key={r} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-accent/10 text-accent">
                      @{r}
                      <button onClick={() => setRcDefaultReviewers(rcDefaultReviewers.filter(x => x !== r))} className="hover:text-red-400 transition-colors">
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newDefaultReviewer}
                  onChange={e => setNewDefaultReviewer(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDefaultReviewer(); } }}
                  placeholder="GitHub username"
                  className="flex-1 px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                />
                <button
                  onClick={addDefaultReviewer}
                  disabled={!newDefaultReviewer.trim()}
                  className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  <Plus size={12} /> Add
                </button>
              </div>
            </div>

            {/* Team reviewers */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Users size={14} className="text-muted" />
                <span className="text-xs font-medium text-muted">Team Reviewers (GitHub team slugs)</span>
              </div>
              <p className="text-xs text-muted mb-2">
                Team slugs (e.g. <code className="bg-bg px-1 rounded">frontend-team</code>) to request on every PR.
              </p>

              {rcTeamReviewers.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {rcTeamReviewers.map(t => (
                    <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-blue-500/10 text-blue-400">
                      @{t}
                      <button onClick={() => setRcTeamReviewers(rcTeamReviewers.filter(x => x !== t))} className="hover:text-red-400 transition-colors">
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTeamReviewer}
                  onChange={e => setNewTeamReviewer(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTeamReviewer(); } }}
                  placeholder="team-slug"
                  className="flex-1 px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                />
                <button
                  onClick={addTeamReviewer}
                  disabled={!newTeamReviewer.trim()}
                  className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  <Plus size={12} /> Add
                </button>
              </div>
            </div>

            {/* Conditional rules */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <Tag size={14} className="text-muted" />
                  <span className="text-xs font-medium text-muted">Conditional Rules</span>
                </div>
                <button onClick={addConditionalRule} className="px-2 py-1 text-xs rounded border border-border hover:bg-bg transition-colors flex items-center gap-1">
                  <Plus size={10} /> Add Rule
                </button>
              </div>
              <p className="text-xs text-muted mb-2">
                Add reviewers when a spec has matching tags or story personas.
              </p>

              {rcRules.length === 0 && (
                <p className="text-xs text-muted italic">No conditional rules configured.</p>
              )}

              <div className="space-y-2">
                {rcRules.map((rule, idx) => (
                  <div key={idx} className="rounded border border-border bg-bg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted whitespace-nowrap">If</span>
                      <select
                        value={rule.condition.field}
                        onChange={e => updateRule(idx, { condition: { ...rule.condition, field: e.target.value as 'tag' | 'persona' } })}
                        className="px-2 py-1 text-xs rounded bg-panel border border-border text-[var(--text)] focus:outline-none focus:border-accent"
                      >
                        <option value="tag">spec tag</option>
                        <option value="persona">story persona</option>
                      </select>
                      <span className="text-xs text-muted">matches</span>
                      <input
                        type="text"
                        value={rule.condition.matches}
                        onChange={e => updateRule(idx, { condition: { ...rule.condition, matches: e.target.value } })}
                        placeholder={rule.condition.field === 'tag' ? 'security' : 'backend'}
                        className="flex-1 px-2 py-1 text-xs rounded bg-panel border border-border font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                      />
                      <button onClick={() => removeRule(idx)} className="text-red-400 hover:text-red-300 transition-colors p-1">
                        <X size={12} />
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={(rule.reviewers ?? []).join(', ')}
                        onChange={e => updateRule(idx, { reviewers: e.target.value.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean) })}
                        placeholder="Reviewers: user1, user2"
                        className="flex-1 px-2 py-1 text-xs rounded bg-panel border border-border font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                      />
                      <input
                        type="text"
                        value={(rule.teamReviewers ?? []).join(', ')}
                        onChange={e => updateRule(idx, { teamReviewers: e.target.value.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean) })}
                        placeholder="Teams: security-team"
                        className="flex-1 px-2 py-1 text-xs rounded bg-panel border border-border font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* CODEOWNERS-style path rules */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <FolderGit2 size={14} className="text-muted" />
                  <span className="text-xs font-medium text-muted">Path Rules (CODEOWNERS-style)</span>
                </div>
                <button onClick={addPathRule} className="px-2 py-1 text-xs rounded border border-border hover:bg-bg transition-colors flex items-center gap-1">
                  <Plus size={10} /> Add Rule
                </button>
              </div>
              <p className="text-xs text-muted mb-2">
                If changed files match a glob pattern, add specific reviewers.
              </p>

              {rcPathRules.length === 0 && (
                <p className="text-xs text-muted italic">No path rules configured.</p>
              )}

              <div className="space-y-2">
                {rcPathRules.map((rule, idx) => (
                  <div key={idx} className="rounded border border-border bg-bg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted whitespace-nowrap">Pattern</span>
                      <input
                        type="text"
                        value={rule.pattern}
                        onChange={e => updatePathRule(idx, { pattern: e.target.value })}
                        placeholder="src/security/**"
                        className="flex-1 px-2 py-1 text-xs rounded bg-panel border border-border font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                      />
                      <button onClick={() => removePathRule(idx)} className="text-red-400 hover:text-red-300 transition-colors p-1">
                        <X size={12} />
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={(rule.reviewers ?? []).join(', ')}
                        onChange={e => updatePathRule(idx, { reviewers: e.target.value.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean) })}
                        placeholder="Reviewers: user1, user2"
                        className="flex-1 px-2 py-1 text-xs rounded bg-panel border border-border font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                      />
                      <input
                        type="text"
                        value={(rule.teamReviewers ?? []).join(', ')}
                        onChange={e => updatePathRule(idx, { teamReviewers: e.target.value.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean) })}
                        placeholder="Teams: infra-team"
                        className="flex-1 px-2 py-1 text-xs rounded bg-panel border border-border font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Empty state */}
            {rcDefaultReviewers.length === 0 && rcTeamReviewers.length === 0 && rcRules.length === 0 && rcPathRules.length === 0 && (
              <p className="text-xs text-muted italic border-t border-border pt-3">
                No default reviewers configured. PRs will be created without review requests.
              </p>
            )}

            {/* Save button */}
            <button
              onClick={handleSaveReviewConfig}
              disabled={savingReviewConfig}
              className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-1.5"
            >
              {savingReviewConfig ? <Loader2 size={14} className="animate-spin" /> : null}
              {savedReviewConfig ? 'Saved!' : 'Save Review Config'}
            </button>
          </div>
        </section>
      )}

      {/* ─── Section 6: GitHub Actions YAML ───────────────────────────── */}
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
              const token = getAccessToken();
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

      {/* ─── Section 7: PR Template ───────────────────────────────────── */}
      <section className="border-t border-border pt-6 pb-6">
        <div className="flex items-center gap-2 mb-3">
          <FileText size={18} />
          <h2 className="text-sm font-semibold text-[var(--text)]">PR Description Template</h2>
        </div>
        <p className="text-xs text-muted mb-3">
          Customize the PR description generated by "Copy PR Body" on story cards.
          Use <code className="bg-surface px-1 rounded">{'{{storyId}}'}</code>,{' '}
          <code className="bg-surface px-1 rounded">{'{{storyTitle}}'}</code>,{' '}
          <code className="bg-surface px-1 rounded">{'{{storyDescription}}'}</code>,{' '}
          <code className="bg-surface px-1 rounded">{'{{acceptanceCriteriaChecklist}}'}</code>,{' '}
          <code className="bg-surface px-1 rounded">{'{{dependencyList}}'}</code>,{' '}
          <code className="bg-surface px-1 rounded">{'{{specId}}'}</code>,{' '}
          <code className="bg-surface px-1 rounded">{'{{specLink}}'}</code>.
          Wrap optional sections with <code className="bg-surface px-1 rounded">{'{{#if dependencies}}...{{/if}}'}</code>.
        </p>
        <textarea
          value={prTemplate}
          onChange={e => { setPrTemplate(e.target.value); setPrTemplateSaved(false); }}
          placeholder="Leave empty to use the default template"
          rows={12}
          className="w-full px-3 py-2 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent resize-y"
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleSavePrTemplate}
            disabled={prTemplateSaving}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-1.5"
          >
            {prTemplateSaving ? <Loader2 size={14} className="animate-spin" /> : null}
            {prTemplateSaved ? 'Saved!' : 'Save Template'}
          </button>
          <button
            onClick={() => { setPrTemplate(''); setPrTemplateSaved(false); }}
            className="px-3 py-1.5 text-sm rounded border border-border hover:bg-panel transition-colors flex items-center gap-1.5 text-muted"
            title="Reset to default template"
          >
            <RotateCcw size={12} />
            Reset to Default
          </button>
        </div>
      </section>
    </div>
  );
}
