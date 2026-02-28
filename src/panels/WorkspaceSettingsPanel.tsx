import { useState, useEffect, useCallback } from 'react';
import {
  Settings2, Layers, Github, Variable, Play, Webhook,
  Save, Loader2, Check, FolderOpen, Plus, Trash2, X, Users, Route, FileText,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { useToast, ToastContainer } from '../components/Toast';
import AgentsEditorSection from '../components/AgentsEditorSection';
import ContextRoutingSettings from '../components/ContextRoutingSettings';
import ContextFilesEditor from '../components/ContextFilesEditor';

// ─── Types ───────────────────────────────────────────────────────────────────

type WsSettingsTab = 'general' | 'direction' | 'context' | 'github' | 'env-vars' | 'pipeline' | 'hooks' | 'agents';

interface WorkspaceDetail {
  id: string;
  label: string;
  path: string;
  domains: string[];
  pr_template: string | null;
}

interface DirectionLayers {
  l1: { content: string | null };
  l2: { content: string | null };
  l3: { content: string | null; preferredModel: string | null };
}

interface ModelOption {
  id: string;
  label: string;
}

interface GithubStatus {
  connected: boolean;
  repoOwner?: string;
  repoName?: string;
  webhookId?: number;
  connectedAt?: string;
}

const TABS: { id: WsSettingsTab; label: string; icon: typeof Settings2 }[] = [
  { id: 'general',   label: 'General',           icon: Settings2 },
  { id: 'direction', label: 'Direction Stack',    icon: Layers    },
  { id: 'context',   label: 'Workspace Context',  icon: Route     },
  { id: 'github',    label: 'GitHub',             icon: Github    },
  { id: 'env-vars',  label: 'Env Vars',           icon: Variable  },
  { id: 'pipeline',  label: 'Pipeline',           icon: Play      },
  { id: 'hooks',     label: 'Hooks',              icon: Webhook   },
  { id: 'agents',    label: 'Agents',             icon: Users     },
];

// ─── Component ───────────────────────────────────────────────────────────────

export default function WorkspaceSettingsPanel() {
  const [activeTab, setActiveTab] = useState<WsSettingsTab>('general');
  const { workspaceId } = useWorkspace();
  const { toasts, show: showToast, dismiss } = useToast();

  if (!workspaceId) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        Select a workspace to manage settings.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 sm:p-6 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text)]">Workspace Settings</h1>
        <p className="text-xs text-muted mt-1">Manage direction stack, connections, environment, and pipeline configuration</p>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Tab sidebar (desktop) */}
        <nav className="w-48 shrink-0 border-r border-border bg-panel p-2 hidden sm:block">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === id
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:text-[var(--text)] hover:bg-bg'
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        {/* Mobile tab bar */}
        <div className="sm:hidden flex border-b border-border bg-panel shrink-0 overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center justify-center gap-1 py-2 px-3 text-xs whitespace-nowrap transition-colors ${
                activeTab === id
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-muted'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {activeTab === 'general'   && <GeneralSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'direction' && <DirectionSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'context'   && <ContextSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'github'    && <GithubSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'env-vars'  && <EnvVarsSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'pipeline'  && <PipelineSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'hooks'     && <HooksSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'agents'    && <AgentsEditorSection workspaceId={workspaceId} showToast={showToast} />}
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

// ─── Section Props ───────────────────────────────────────────────────────────

interface SectionProps {
  workspaceId: string;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

// ─── Context Section (sub-tabs: Routing | Files) ────────────────────────────

function ContextSection({ workspaceId, showToast }: SectionProps) {
  const [subTab, setSubTab] = useState<'routing' | 'files'>('routing');

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <div className="flex gap-1 border-b border-border -mt-2 mb-4">
        <button
          onClick={() => setSubTab('routing')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm transition-colors border-b-2 ${
            subTab === 'routing'
              ? 'text-accent border-accent'
              : 'text-muted hover:text-[var(--text)] border-transparent'
          }`}
        >
          <Route size={14} />
          Routing
        </button>
        <button
          onClick={() => setSubTab('files')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm transition-colors border-b-2 ${
            subTab === 'files'
              ? 'text-accent border-accent'
              : 'text-muted hover:text-[var(--text)] border-transparent'
          }`}
        >
          <FileText size={14} />
          Files
        </button>
      </div>

      {subTab === 'routing' && <ContextRoutingSettings workspaceId={workspaceId} showToast={showToast} />}
      {subTab === 'files' && <ContextFilesEditor workspaceId={workspaceId} showToast={showToast} />}
    </div>
  );
}

// ─── General Section ─────────────────────────────────────────────────────────

function GeneralSection({ workspaceId, showToast }: SectionProps) {
  const { refreshWorkspaces } = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [original, setOriginal] = useState<WorkspaceDetail | null>(null);
  const [label, setLabel] = useState('');
  const [wsPath, setWsPath] = useState('');
  const [domains, setDomains] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [originalModel, setOriginalModel] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ workspace: WorkspaceDetail }>(`/api/workspaces/${workspaceId}`),
      apiFetch<{ contentYaml: string; preferredModel: string | null }>(`/api/direction?layer=3&workspaceId=${workspaceId}`),
      apiFetch<{ models: ModelOption[]; defaultModel: string }>(`/api/direction/models?workspaceId=${workspaceId}`),
    ]).then(([wsData, l3Data, modelData]) => {
      const ws = wsData.workspace;
      setOriginal(ws);
      setLabel(ws.label);
      setWsPath(ws.path);
      setDomains(ws.domains.join(', '));
      setDefaultModel(l3Data.preferredModel ?? modelData.defaultModel);
      setOriginalModel(l3Data.preferredModel ?? modelData.defaultModel);
      setModels(modelData.models);
    }).catch(() => setError('Failed to load workspace'))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const hasChanges = original && (
    label !== original.label ||
    wsPath !== original.path ||
    domains !== original.domains.join(', ') ||
    defaultModel !== originalModel
  );

  const saveGeneral = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const parsedDomains = domains.split(',').map(d => d.trim()).filter(Boolean);
      await apiFetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, path: wsPath, domains: parsedDomains }),
      });

      // Save preferred model via direction L3
      if (defaultModel !== originalModel) {
        const l3Res = await apiFetch<{ contentYaml: string }>(`/api/direction?layer=3&workspaceId=${workspaceId}`);
        await apiFetch('/api/direction', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            layer: 3,
            workspaceId,
            contentYaml: l3Res.contentYaml || 'stack: project',
            preferredModel: defaultModel,
          }),
        });
        setOriginalModel(defaultModel);
      }

      setOriginal({ id: workspaceId, label, path: wsPath, domains: domains.split(',').map(d => d.trim()).filter(Boolean), pr_template: original?.pr_template ?? null });
      await refreshWorkspaces();
      setSaved(true);
      showToast('Workspace settings saved');
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading workspace...</div>;
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">General</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">Workspace ID</label>
            <input
              type="text"
              value={workspaceId}
              disabled
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded opacity-60 cursor-not-allowed font-mono"
            />
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Label</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Path</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={wsPath}
                onChange={e => setWsPath(e.target.value)}
                className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
              />
              <button
                type="button"
                className="p-2 text-muted hover:text-[var(--text)] border border-border rounded transition-colors"
                title="Browse filesystem"
                tabIndex={-1}
              >
                <FolderOpen size={16} />
              </button>
            </div>
            <p className="text-xs text-muted mt-1">Absolute path to the project workspace. Must exist on filesystem.</p>
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Domains</label>
            <input
              type="text"
              value={domains}
              onChange={e => setDomains(e.target.value)}
              placeholder="saas, fintech"
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
            <p className="text-xs text-muted mt-1">Comma-separated domain tags for L2 direction matching</p>
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Default Model</label>
            <select
              value={defaultModel}
              onChange={e => setDefaultModel(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Default LLM model for spec generation in this workspace</p>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            onClick={saveGeneral}
            disabled={saving || !hasChanges}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? 'Saved' : 'Save General'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Direction Stack Section ─────────────────────────────────────────────────

function DirectionSection({ workspaceId, showToast }: SectionProps) {
  const [loading, setLoading] = useState(true);
  const [layers, setLayers] = useState<DirectionLayers | null>(null);
  const [activeLayer, setActiveLayer] = useState<1 | 2 | 3>(3);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiFetch<{ layers: DirectionLayers }>(`/api/direction/all?workspaceId=${workspaceId}`)
      .then(data => {
        setLayers(data.layers);
        setContent(data.layers.l3?.content ?? '');
      })
      .catch(() => showToast('Failed to load direction stack', 'error'))
      .finally(() => setLoading(false));
  }, [workspaceId, showToast]);

  useEffect(() => {
    if (!layers) return;
    if (activeLayer === 1) setContent(layers.l1?.content ?? '');
    else if (activeLayer === 2) setContent(layers.l2?.content ?? '');
    else setContent(layers.l3?.content ?? '');
  }, [activeLayer, layers]);

  const saveLayer = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await apiFetch('/api/direction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layer: activeLayer,
          workspaceId: activeLayer >= 2 ? workspaceId : undefined,
          contentYaml: content,
        }),
      });
      if (layers) {
        const key = `l${activeLayer}` as keyof DirectionLayers;
        setLayers({ ...layers, [key]: { ...layers[key], content } });
      }
      setSaved(true);
      showToast(`L${activeLayer} direction saved`);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading direction stack...</div>;
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-2">Direction Stack</h2>
        <p className="text-xs text-muted">Edit the 5-layer context cascade. L1 is global, L2 is domain-scoped, L3 is project-scoped. L4/L5 are per-request.</p>
      </div>

      <div className="flex gap-2">
        {([1, 2, 3] as const).map(n => (
          <button
            key={n}
            onClick={() => setActiveLayer(n)}
            className={`px-3 py-1.5 text-xs rounded border transition-colors ${
              activeLayer === n
                ? 'bg-accent/10 border-accent text-accent'
                : 'border-border text-muted hover:text-[var(--text)] hover:border-accent/50'
            }`}
          >
            L{n} — {n === 1 ? 'Global' : n === 2 ? 'Domain' : 'Project'}
          </button>
        ))}
      </div>

      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        rows={16}
        spellCheck={false}
        className="w-full px-3 py-2 text-sm font-mono bg-bg border border-border rounded focus:border-accent outline-none resize-y"
        placeholder={`Enter YAML content for L${activeLayer}...`}
      />

      <button
        onClick={saveLayer}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? 'Saved' : `Save L${activeLayer}`}
      </button>
    </div>
  );
}

// ─── GitHub Section ──────────────────────────────────────────────────────────

function GithubSection({ workspaceId, showToast }: SectionProps) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [prTemplate, setPrTemplate] = useState('');
  const [prTemplateSaving, setPrTemplateSaving] = useState(false);
  const [prTemplateSaved, setPrTemplateSaved] = useState(false);
  const [originalPrTemplate, setOriginalPrTemplate] = useState('');

  const fetchStatus = useCallback(async () => {
    try {
      const [ghData, wsData] = await Promise.all([
        apiFetch<GithubStatus>(`/api/github/status?workspaceId=${workspaceId}`),
        apiFetch<{ workspace: WorkspaceDetail }>(`/api/workspaces/${workspaceId}`),
      ]);
      setStatus(ghData);
      setPrTemplate(wsData.workspace.pr_template ?? '');
      setOriginalPrTemplate(wsData.workspace.pr_template ?? '');
    } catch {
      // GitHub may not be configured
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const savePrTemplate = async () => {
    setPrTemplateSaving(true);
    setPrTemplateSaved(false);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr_template: prTemplate || null }),
      });
      setOriginalPrTemplate(prTemplate);
      setPrTemplateSaved(true);
      showToast('PR template saved');
      setTimeout(() => setPrTemplateSaved(false), 2000);
    } catch {
      showToast('Failed to save PR template', 'error');
    } finally {
      setPrTemplateSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading GitHub status...</div>;
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">GitHub Connection</h2>
        {status?.connected ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-[var(--text)]">
              Connected to <span className="font-mono text-accent">{status.repoOwner}/{status.repoName}</span>
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="w-2 h-2 rounded-full bg-border" />
            Not connected — configure in the <span className="text-accent">GitHub panel</span>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-2">PR Template</h2>
        <p className="text-xs text-muted mb-3">Markdown template for auto-generated pull requests. Uses {'{title}'}, {'{summary}'}, {'{stories}'} placeholders.</p>
        <textarea
          value={prTemplate}
          onChange={e => setPrTemplate(e.target.value)}
          rows={10}
          spellCheck={false}
          className="w-full px-3 py-2 text-sm font-mono bg-bg border border-border rounded focus:border-accent outline-none resize-y"
          placeholder="## Summary&#10;{summary}&#10;&#10;## Stories&#10;{stories}"
        />
        <button
          onClick={savePrTemplate}
          disabled={prTemplateSaving || prTemplate === originalPrTemplate}
          className="mt-3 flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {prTemplateSaving ? <Loader2 size={14} className="animate-spin" /> : prTemplateSaved ? <Check size={14} /> : <Save size={14} />}
          {prTemplateSaved ? 'Saved' : 'Save Template'}
        </button>
      </div>
    </div>
  );
}

// ─── Env Vars Section ────────────────────────────────────────────────────────

interface EnvVar {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
}

function EnvVarsSection({ workspaceId, showToast }: SectionProps) {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const fetchVars = useCallback(async () => {
    try {
      const data = await apiFetch<{ envVars: EnvVar[] }>(`/api/workspaces/${workspaceId}/env-vars`);
      setVars(data.envVars ?? []);
    } catch {
      setVars([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchVars(); }, [fetchVars]);

  const addVar = async () => {
    if (!newKey.trim()) return;
    setAdding(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/env-vars`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: newKey.trim(), value: newValue, isSecret: true }),
      });
      setNewKey('');
      setNewValue('');
      showToast('Variable added');
      fetchVars();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to add variable', 'error');
    } finally {
      setAdding(false);
    }
  };

  const removeVar = async (key: string) => {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/env-vars/${encodeURIComponent(key)}`, { method: 'DELETE' });
      setVars(prev => prev.filter(v => v.key !== key));
      showToast('Variable removed');
    } catch {
      showToast('Failed to remove variable', 'error');
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading environment variables...</div>;
  }

  return (
    <div className="max-w-lg space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)]">Environment Variables</h2>
        <p className="text-xs text-muted mt-0.5">Variables injected into pipeline runs for this workspace. Changes are saved immediately.</p>
      </div>

      {/* Add form */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className="block text-xs text-muted mb-1">Key</label>
          <input
            type="text"
            value={newKey}
            onChange={e => setNewKey(e.target.value.toUpperCase())}
            placeholder="VARIABLE_NAME"
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
            onKeyDown={e => e.key === 'Enter' && addVar()}
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-muted mb-1">Value</label>
          <input
            type="text"
            value={newValue}
            onChange={e => setNewValue(e.target.value)}
            placeholder="value"
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
            onKeyDown={e => e.key === 'Enter' && addVar()}
          />
        </div>
        <button
          onClick={addVar}
          disabled={!newKey.trim() || adding}
          className="flex items-center gap-1 px-3 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
        </button>
      </div>

      {/* Var list */}
      {vars.length === 0 ? (
        <div className="text-sm text-muted py-8 text-center border border-dashed border-border rounded">
          No environment variables configured for this workspace.
        </div>
      ) : (
        <div className="space-y-2">
          {vars.map(v => (
            <div key={v.id} className="flex items-center justify-between px-4 py-2.5 border border-border rounded bg-bg">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm font-mono text-accent">{v.key}</span>
                <span className="text-xs text-muted font-mono">=</span>
                <span className="text-sm font-mono text-[var(--text)] truncate">{v.value}</span>
              </div>
              <button
                onClick={() => removeVar(v.key)}
                className="p-1.5 text-muted hover:text-red-500 transition-colors shrink-0"
                title="Remove variable"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Pipeline Section ────────────────────────────────────────────────────────

function PipelineSection({ workspaceId, showToast }: SectionProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [autoWorktree, setAutoWorktree] = useState(true);
  const [storyTimeout, setStoryTimeout] = useState(45);
  const [maxRetries, setMaxRetries] = useState(0);

  useEffect(() => {
    apiFetch<{ config: { autoWorktree: boolean; storyTimeoutMin: number; maxRetries: number } }>(`/api/workspaces/${workspaceId}/pipeline-config`)
      .then(data => {
        setAutoWorktree(data.config.autoWorktree ?? true);
        setStoryTimeout(data.config.storyTimeoutMin ?? 45);
        setMaxRetries(data.config.maxRetries ?? 0);
      })
      .catch(() => { /* Use defaults */ })
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const savePipeline = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/pipeline-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoWorktree, storyTimeoutMin: storyTimeout, maxRetries }),
      });
      setSaved(true);
      showToast('Pipeline configuration saved');
      setTimeout(() => setSaved(false), 2000);
    } catch {
      showToast('Failed to save pipeline configuration', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading pipeline config...</div>;
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Pipeline Configuration</h2>

        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--text)]">Auto-create worktree</p>
              <p className="text-xs text-muted mt-0.5">Run each pipeline in an isolated git worktree branch</p>
            </div>
            <ToggleSwitch checked={autoWorktree} onChange={() => setAutoWorktree(!autoWorktree)} />
          </div>

          <div className="border-t border-border pt-5">
            <label className="block text-xs text-muted mb-1">Story Timeout (minutes)</label>
            <input
              type="number"
              min={1}
              max={120}
              value={storyTimeout}
              onChange={e => setStoryTimeout(Number(e.target.value))}
              className="w-32 px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
            <p className="text-xs text-muted mt-1">Max time allowed per story before timeout (default: 45 min)</p>
          </div>

          <div className="border-t border-border pt-5">
            <label className="block text-xs text-muted mb-1">Max Retries per Story</label>
            <input
              type="number"
              min={0}
              max={5}
              value={maxRetries}
              onChange={e => setMaxRetries(Number(e.target.value))}
              className="w-32 px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
            <p className="text-xs text-muted mt-1">Number of retry attempts for failed stories (0 = no retries)</p>
          </div>

          <div className="border-t border-border pt-5">
            <label className="block text-xs text-muted mb-1">Execution Mode</label>
            <p className="text-sm text-[var(--text)]">Auto-orchestrated</p>
            <p className="text-xs text-muted mt-1">Sequential or wave-parallel is auto-selected based on the spec's dependency graph</p>
          </div>
        </div>
      </div>

      <button
        onClick={savePipeline}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? 'Saved' : 'Save Pipeline Config'}
      </button>
    </div>
  );
}

// ─── Hooks Section ───────────────────────────────────────────────────────────

interface AgentHook {
  id: number;
  workspace_id: string;
  event_type: string;
  command: string;
  enabled: number;
  timeout_seconds: number;
  created_at: string;
}

const HOOK_EVENTS = [
  { value: 'on_generate',    label: 'Spec Generated' },
  { value: 'on_approve',     label: 'Spec Approved' },
  { value: 'on_reject',      label: 'Spec Rejected' },
  { value: 'on_run_start',   label: 'Run Started' },
  { value: 'on_run_complete', label: 'Run Complete' },
  { value: 'on_story_pass',  label: 'Story Passed' },
  { value: 'on_story_fail',  label: 'Story Failed' },
];

function HooksSection({ workspaceId, showToast }: SectionProps) {
  const [hooks, setHooks] = useState<AgentHook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newEvent, setNewEvent] = useState('on_run_complete');
  const [newCommand, setNewCommand] = useState('');

  const fetchHooks = useCallback(async () => {
    try {
      const data = await apiFetch<{ hooks: AgentHook[] }>(`/api/workspaces/${workspaceId}/agent-hooks`);
      setHooks(data.hooks ?? []);
    } catch {
      setHooks([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchHooks(); }, [fetchHooks]);

  const addHook = async () => {
    if (!newCommand.trim()) return;
    setAdding(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/agent-hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: newEvent, command: newCommand.trim(), enabled: true }),
      });
      setNewCommand('');
      setShowAdd(false);
      showToast('Hook added');
      fetchHooks();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to add hook', 'error');
    } finally {
      setAdding(false);
    }
  };

  const removeHook = async (id: number) => {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/agent-hooks/${id}`, { method: 'DELETE' });
      setHooks(prev => prev.filter(h => h.id !== id));
      showToast('Hook removed');
    } catch {
      showToast('Failed to remove hook', 'error');
    }
  };

  const toggleHook = async (hook: AgentHook) => {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/agent-hooks/${hook.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !hook.enabled }),
      });
      setHooks(prev => prev.map(h => h.id === hook.id ? { ...h, enabled: h.enabled ? 0 : 1 } : h));
    } catch {
      showToast('Failed to toggle hook', 'error');
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading hooks...</div>;
  }

  return (
    <div className="max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Hooks</h2>
          <p className="text-xs text-muted mt-0.5">Shell commands triggered on pipeline events (e.g. Slack notifications, deploys)</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors"
        >
          <Plus size={14} /> Add Hook
        </button>
      </div>

      {showAdd && (
        <div className="border border-border rounded p-4 space-y-3 bg-bg">
          <div>
            <label className="block text-xs text-muted mb-1">Event</label>
            <select
              value={newEvent}
              onChange={e => setNewEvent(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-panel border border-border rounded focus:border-accent outline-none"
            >
              {HOOK_EVENTS.map(e => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Shell Command</label>
            <input
              type="text"
              value={newCommand}
              onChange={e => setNewCommand(e.target.value)}
              placeholder="e.g. curl -X POST https://hooks.slack.com/..."
              className="w-full px-3 py-2 text-sm bg-panel border border-border rounded focus:border-accent outline-none font-mono"
              onKeyDown={e => e.key === 'Enter' && addHook()}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={addHook}
              disabled={!newCommand.trim() || adding}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 text-sm text-muted hover:text-[var(--text)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {hooks.length === 0 && !showAdd ? (
        <div className="text-sm text-muted py-8 text-center border border-dashed border-border rounded">
          No hooks configured. Add one to trigger actions on pipeline events.
        </div>
      ) : (
        <div className="space-y-2">
          {hooks.map(h => {
            const eventLabel = HOOK_EVENTS.find(e => e.value === h.event_type)?.label ?? h.event_type;
            return (
              <div key={h.id} className={`flex items-center justify-between px-4 py-3 border border-border rounded bg-bg ${!h.enabled ? 'opacity-50' : ''}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-accent/10 text-accent">{eventLabel}</span>
                  </div>
                  <p className="text-sm font-mono text-[var(--text)] mt-1 truncate">{h.command}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <ToggleSwitch checked={!!h.enabled} onChange={() => toggleHook(h)} />
                  <button
                    onClick={() => removeHook(h.id)}
                    className="p-1.5 text-muted hover:text-red-500 transition-colors"
                    title="Remove hook"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Toggle Switch ───────────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-border'
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}
