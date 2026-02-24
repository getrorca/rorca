import { useState, useEffect, useCallback } from 'react';
import { Github, Link2, Unlink, Loader2, CheckCircle2, AlertCircle, Webhook, FileText, RotateCcw, Download } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch, BASE_URL, getAccessToken } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GithubStatus {
  connected: boolean;
  repoOwner?: string;
  repoName?: string;
  webhookId?: number;
  lastWebhookAt?: string | null;
  connectedAt?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GitHubSettingsPanel() {
  const { workspaceId } = useWorkspace();

  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Connect form
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Disconnect
  const [disconnectToken, setDisconnectToken] = useState('');
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  // PR template
  const [prTemplate, setPrTemplate] = useState('');
  const [prTemplateSaving, setPrTemplateSaving] = useState(false);
  const [prTemplateSaved, setPrTemplateSaved] = useState(false);
  const [prTemplateLoaded, setPrTemplateLoaded] = useState(false);

  // ─── Fetch status ────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await apiFetch<GithubStatus>(`/api/workspaces/${workspaceId}/github`);
      setStatus(data);
    } catch (err: any) {
      console.error('[GitHubSettings] Fetch error:', err);
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // ─── Fetch PR template ─────────────────────────────────────────────────

  useEffect(() => {
    if (!workspaceId || prTemplateLoaded) return;
    apiFetch<{ workspace: { pr_template: string | null } }>(`/api/workspaces/${workspaceId}`)
      .then(data => {
        setPrTemplate(data.workspace.pr_template ?? '');
        setPrTemplateLoaded(true);
      })
      .catch(() => {
        setPrTemplateLoaded(true);
      });
  }, [workspaceId, prTemplateLoaded]);

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
      // Silently fail
    } finally {
      setPrTemplateSaving(false);
    }
  }

  // ─── Connect ─────────────────────────────────────────────────────────────

  async function handleConnect() {
    if (!workspaceId || !repoOwner.trim() || !repoName.trim() || !githubToken.trim()) return;

    setConnecting(true);
    setConnectError(null);
    try {
      const data = await apiFetch<GithubStatus>(`/api/workspaces/${workspaceId}/github/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoOwner: repoOwner.trim(),
          repoName: repoName.trim(),
          githubToken: githubToken.trim(),
        }),
      });
      setStatus(data);
      setRepoOwner('');
      setRepoName('');
      setGithubToken('');
    } catch (err: any) {
      setConnectError(err.message || 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  }

  // ─── Disconnect ──────────────────────────────────────────────────────────

  async function handleDisconnect() {
    if (!workspaceId || !disconnectToken.trim()) return;

    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await apiFetch<GithubStatus>(`/api/workspaces/${workspaceId}/github/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: disconnectToken.trim() }),
      });
      setStatus({ connected: false });
      setShowDisconnect(false);
      setDisconnectToken('');
    } catch (err: any) {
      setDisconnectError(err.message || 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
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
    <div className="h-full overflow-y-auto p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <Github size={24} strokeWidth={1.5} />
        <h1 className="text-lg font-semibold">GitHub Integration</h1>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading connection status...
        </div>
      ) : status?.connected ? (
        /* ─── Connected State ─────────────────────────────────────────── */
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 size={18} className="text-emerald-400" />
              <span className="text-sm font-medium text-emerald-400">Connected</span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
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
                  {status.lastWebhookAt
                    ? new Date(status.lastWebhookAt + 'Z').toLocaleString()
                    : 'None yet'}
                </p>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 text-xs text-muted">
              <Webhook size={14} />
              Events: push, pull_request, issues
            </div>
          </div>

          {/* Disconnect */}
          {!showDisconnect ? (
            <button
              onClick={() => setShowDisconnect(true)}
              className="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 transition-colors"
            >
              <Unlink size={14} /> Disconnect
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
                  onChange={(e) => setDisconnectToken(e.target.value)}
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
        /* ─── Disconnected State — Connect Form ───────────────────────── */
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-panel p-4 space-y-3">
            <p className="text-sm text-muted">
              Connect a GitHub repository to receive push, pull_request, and issue events via webhook.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-muted">
                Repo owner
                <input
                  type="text"
                  value={repoOwner}
                  onChange={(e) => setRepoOwner(e.target.value)}
                  placeholder="octocat"
                  className="mt-1 w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
                />
              </label>
              <label className="block text-xs text-muted">
                Repo name
                <input
                  type="text"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
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
                onChange={(e) => setGithubToken(e.target.value)}
                placeholder="ghp_..."
                className="mt-1 w-full px-3 py-1.5 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent"
              />
            </label>

            <p className="text-xs text-muted">
              The token is only used to create the webhook and is not stored. A webhook secret is generated and stored encrypted.
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
        </div>
      )}

      {/* ─── GitHub Actions YAML ─────────────────────────────────────── */}
      <div className="mt-8 border-t border-border pt-6">
        <div className="flex items-center gap-2 mb-3">
          <Download size={18} />
          <h2 className="text-sm font-semibold">GitHub Actions Workflow</h2>
        </div>
        <p className="text-xs text-muted mb-3">
          Download a GitHub Actions workflow that triggers Rorcha pipeline runs on push to main.
          Place the file at <code className="bg-surface px-1 rounded">.github/workflows/rorcha-pipeline.yml</code> in your repository.
        </p>
        <p className="text-xs text-muted mb-3">
          Required repository secrets:{' '}
          <code className="bg-surface px-1 rounded">RORCHA_API_URL</code>,{' '}
          <code className="bg-surface px-1 rounded">RORCHA_API_TOKEN</code>,{' '}
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
              a.download = 'rorcha-pipeline.yml';
              a.click();
              URL.revokeObjectURL(url);
            } catch (err: any) {
              console.error('[GitHubSettings] YAML download error:', err);
            }
          }}
          className="px-4 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity flex items-center gap-1.5"
        >
          <Download size={14} />
          Download Actions YAML
        </button>
      </div>

      {/* ─── PR Template ──────────────────────────────────────────────── */}
      <div className="mt-8 border-t border-border pt-6">
        <div className="flex items-center gap-2 mb-3">
          <FileText size={18} />
          <h2 className="text-sm font-semibold">PR Description Template</h2>
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
          onChange={(e) => { setPrTemplate(e.target.value); setPrTemplateSaved(false); }}
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
      </div>
    </div>
  );
}
