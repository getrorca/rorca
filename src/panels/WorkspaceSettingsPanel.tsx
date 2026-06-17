/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, type ComponentType } from 'react';
import {
  Settings2, Layers, Variable, Play, Webhook,
  Save, Loader2, Check, FolderOpen, Plus, Trash2, X, Users, Route, FileText, Wrench,
  Package, Info,
  type LucideIcon,
} from 'lucide-react';
import { Github } from '../components/icons/GithubIcon';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import AgentsEditorSection from '../components/AgentsEditorSection';
import ContextRoutingSettings from '../components/ContextRoutingSettings';
import ContextFilesEditor from '../components/ContextFilesEditor';
import SkillsManager from '../components/SkillsManager';

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

const TABS: { id: WsSettingsTab; label: string; icon: LucideIcon | ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'general',   label: 'General',           icon: Settings2 },
  { id: 'direction', label: 'Direction',           icon: Layers    },
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
  const { show: showToast } = useGlobalToast();

  if (!workspaceId) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        Select a workspace to manage settings.
      </div>
    );
  }

  return (
    <div
      role="main"
      aria-label="Workspace Settings"
      className="h-full flex flex-col overflow-hidden"
    >
      <div className="p-4 sm:p-6 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text)]">Workspace Settings</h1>
        <p className="text-xs text-muted mt-1">Manage direction, connections, environment, and pipeline configuration</p>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Tab sidebar (desktop) */}
        <nav
          role="tablist"
          aria-label="Workspace settings sections"
          aria-orientation="vertical"
          className="w-48 shrink-0 border-r border-border bg-panel p-2 hidden sm:block"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`ws-tab-panel-${id}`}
              id={`ws-tab-${id}`}
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
        <div
          role="tablist"
          aria-label="Workspace settings sections"
          className="sm:hidden flex border-b border-border bg-panel shrink-0 overflow-x-auto"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`ws-tab-panel-${id}`}
              id={`ws-tab-mobile-${id}`}
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
        <div
          id={`ws-tab-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`ws-tab-${activeTab}`}
          className="flex-1 overflow-y-auto p-4 sm:p-6"
        >
          {activeTab === 'general'   && <WsGeneralSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'direction' && <WsDirectionSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'context'   && <WsContextSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'github'    && <WsGithubSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'env-vars'  && <WsEnvVarsSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'pipeline'  && <WsPipelineSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'hooks'     && <WsHooksSection workspaceId={workspaceId} showToast={showToast} />}
          {activeTab === 'agents'    && <AgentsEditorSection workspaceId={workspaceId} showToast={showToast} />}
        </div>
      </div>

    </div>
  );
}

// ─── Section Props ───────────────────────────────────────────────────────────

export interface WsSectionProps {
  workspaceId: string;
  showToast: (message: string, type?: 'success' | 'error' | 'warning' | 'info') => void;
}

// ─── Context Section (Library | Files | Routing | Skills) ───────────────────

type ContextSubTab = 'library' | 'files' | 'routing' | 'skills';

export function WsContextSection({ workspaceId, showToast }: WsSectionProps) {
  const [subTab, setSubTab] = useState<ContextSubTab>('library');

  const tabClass = (id: ContextSubTab) => `flex items-center gap-1.5 px-3 py-2 text-sm transition-colors border-b-2 ${
    subTab === id
      ? 'text-accent border-accent'
      : 'text-muted hover:text-[var(--text)] border-transparent'
  }`;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-accent/20 bg-gradient-to-br from-accent/10 via-panel to-panel p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-accent">
              <Route size={12} />
              Runtime context library
            </div>
            <h2 className="mt-3 text-lg font-semibold text-[var(--text)]">
              Markdown files Rorca injects during spec execution
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Add product docs, architecture notes, conventions, or decision records as context files,
              then route them globally, by path, or by tag. Rorca includes the matched files at runtime
              when drafting specs and running stories, and shows what was used in preview and inspector views.
            </p>
          </div>
          <div className="grid min-w-[260px] gap-2 text-xs text-muted sm:grid-cols-3 lg:grid-cols-1">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-50 px-3 py-2">
              <FileText size={14} className="text-accent" />
              1. Add files
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-50 px-3 py-2">
              <Route size={14} className="text-accent" />
              2. Route context
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-50 px-3 py-2">
              <Play size={14} className="text-accent" />
              3. Used at runtime
            </div>
          </div>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Workspace context sections"
        className="flex gap-1 overflow-x-auto border-b border-border -mt-1"
      >
        <button role="tab" aria-selected={subTab === 'library'} onClick={() => setSubTab('library')} className={tabClass('library')}>
          <Layers size={14} />
          Library
        </button>
        <button role="tab" aria-selected={subTab === 'files'} onClick={() => setSubTab('files')} className={tabClass('files')}>
          <FileText size={14} />
          Files
        </button>
        <button role="tab" aria-selected={subTab === 'routing'} onClick={() => setSubTab('routing')} className={tabClass('routing')}>
          <Route size={14} />
          Routing
        </button>
        <button role="tab" aria-selected={subTab === 'skills'} onClick={() => setSubTab('skills')} className={tabClass('skills')}>
          <Wrench size={14} />
          Skills
        </button>
      </div>

      {subTab === 'library' && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-xl border border-border bg-panel p-4">
            <h3 className="text-sm font-semibold text-[var(--text)]">How runtime context works</h3>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <button
                type="button"
                onClick={() => setSubTab('files')}
                className="rounded-lg border border-border bg-surface-50 p-4 text-left transition-colors hover:border-accent/40 hover:bg-surface-100"
              >
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <FileText size={17} />
                </div>
                <div className="text-sm font-medium text-[var(--text)]">Add Markdown files</div>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Manage human-authored docs like product principles, architecture notes, and team conventions.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setSubTab('routing')}
                className="rounded-lg border border-border bg-surface-50 p-4 text-left transition-colors hover:border-accent/40 hover:bg-surface-100"
              >
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Route size={17} />
                </div>
                <div className="text-sm font-medium text-[var(--text)]">Choose when they apply</div>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Route files globally, for matching code paths, or for stories with specific tags.
                </p>
              </button>
              <div className="rounded-lg border border-border bg-surface-50 p-4">
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Play size={17} />
                </div>
                <div className="text-sm font-medium text-[var(--text)]">Injected during execution</div>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Rorca assembles the matched files into each spec/run context packet and records what was used.
                </p>
              </div>
            </div>
          </div>

          <aside className="rounded-xl border border-border bg-panel p-4">
            <h3 className="text-sm font-semibold text-[var(--text)]">Context channels</h3>
            <div className="mt-3 space-y-2 text-xs text-muted">
              <div className="flex items-start gap-2 rounded-lg bg-surface-50 p-3">
                <Check size={14} className="mt-0.5 text-emerald-400" />
                <span><strong className="text-[var(--text)]">Context files</strong> are source docs selected for runtime prompts.</span>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-surface-50 p-3">
                <Check size={14} className="mt-0.5 text-emerald-400" />
                <span><strong className="text-[var(--text)]">Skills</strong> remain reusable implementation guidance files.</span>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-surface-50 p-3">
                <Check size={14} className="mt-0.5 text-emerald-400" />
                <span><strong className="text-[var(--text)]">Memory</strong> is learned and reviewed; docs are not auto-memorized by default.</span>
              </div>
            </div>
          </aside>
        </div>
      )}
      {subTab === 'files' && <ContextFilesEditor workspaceId={workspaceId} showToast={showToast} />}
      {subTab === 'routing' && <ContextRoutingSettings workspaceId={workspaceId} showToast={showToast} />}
      {subTab === 'skills' && <SkillsManager workspaceId={workspaceId} showToast={showToast} />}
    </div>
  );
}

// ─── General Section ─────────────────────────────────────────────────────────

export function WsGeneralSection({ workspaceId, showToast }: WsSectionProps) {
  const { refreshWorkspaces } = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

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
            <label htmlFor="ws-label" className="block text-xs text-muted mb-1">Label</label>
            <input
              id="ws-label"
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
          </div>

          <div>
            <label htmlFor="ws-path" className="block text-xs text-muted mb-1">Path</label>
            <div className="flex gap-2">
              <input
                id="ws-path"
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
            <p className="text-xs text-muted mt-1">Where this project lives on your computer</p>
          </div>

          <div>
            <label htmlFor="ws-domains" className="block text-xs text-muted mb-1">Project Type</label>
            <input
              id="ws-domains"
              type="text"
              value={domains}
              onChange={e => setDomains(e.target.value)}
              placeholder="saas, fintech"
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
            <p className="text-xs text-muted mt-1">What kind of project is this? (e.g., saas, marketing-site, api, cli)</p>
          </div>

          <div>
            <label htmlFor="ws-default-model" className="block text-xs text-muted mb-1">Default Model</label>
            <select
              id="ws-default-model"
              value={defaultModel}
              onChange={e => setDefaultModel(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Model used when generating specs for this workspace</p>
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

          {/* Advanced toggle with Workspace ID */}
          <div className="pt-2 border-t border-border mt-2">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-muted hover:text-[var(--text)] transition-colors"
            >
              {showAdvanced ? 'Hide' : 'Show'} Advanced
            </button>
            {showAdvanced && (
              <div className="mt-3">
                <label className="block text-xs text-muted mb-1">Workspace ID</label>
                <input
                  type="text"
                  value={workspaceId}
                  disabled
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded opacity-60 cursor-not-allowed font-mono"
                />
                <p className="text-xs text-muted mt-1">Auto-generated identifier. Used in API calls and file paths.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Direction Section ──────────────────────────────────────────────────────

export function WsDirectionSection({ workspaceId, showToast }: WsSectionProps) {
  const [loading, setLoading] = useState(true);
  const [layers, setLayers] = useState<DirectionLayers | null>(null);
  const [activeLayer, setActiveLayer] = useState<1 | 2 | 3>(3);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activePack, setActivePack] = useState<{ packName: string; packVersion: string } | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ layers: DirectionLayers }>(`/api/direction/all?workspaceId=${workspaceId}`),
      apiFetch<{ packs: Array<{ packName: string; packVersion: string }> }>(`/api/packs?workspaceId=${workspaceId}`),
    ]).then(([dirData, packData]) => {
      setLayers(dirData.layers);
      setContent(dirData.layers.l3?.content ?? '');
      setActivePack(packData.packs.length > 0 ? packData.packs[0] : null);
    })
      .catch(() => showToast('Failed to load direction', 'error'))
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
      const layerNames = { 1: 'Standards', 2: 'Conventions', 3: 'Project' } as const;
      showToast(`${layerNames[activeLayer]} direction saved`);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading direction...</div>;
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* Active Convention Pack */}
      <div className="p-3 border border-border rounded bg-bg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package size={14} className={activePack ? 'text-green-400' : 'text-muted'} />
            <span className="text-xs font-medium text-[var(--text)]">Convention Pack</span>
          </div>
          {activePack ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-accent">{activePack.packName}</span>
              <span className="text-[10px] text-muted">v{activePack.packVersion}</span>
            </div>
          ) : (
            <span className="text-xs text-muted">None installed</span>
          )}
        </div>
        <p className="text-[11px] text-muted mt-1">
          {activePack
            ? 'Pack provides default conventions for your project. Your own settings always take priority.'
            : 'Install a pack from Marketplace to add base conventions.'}
        </p>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-2">Direction</h2>
        <p className="text-xs text-muted">Customize the instructions given to the AI when working on this project. Project-specific settings take priority over general ones.</p>
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
            {n === 1 ? 'Standards' : n === 2 ? 'Conventions' : 'Project'}
          </button>
        ))}
      </div>

      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        rows={16}
        spellCheck={false}
        className="w-full px-3 py-2 text-sm font-mono bg-bg border border-border rounded focus:border-accent outline-none resize-y"
        placeholder={`Enter content for ${activeLayer === 1 ? 'Standards' : activeLayer === 2 ? 'Conventions' : 'Project'}...`}
      />

      <button
        onClick={saveLayer}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? 'Saved' : `Save ${activeLayer === 1 ? 'Standards' : activeLayer === 2 ? 'Conventions' : 'Project'}`}
      </button>
    </div>
  );
}

// ─── GitHub Section ──────────────────────────────────────────────────────────

export function WsGithubSection({ workspaceId, showToast }: WsSectionProps) {
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

export function WsEnvVarsSection({ workspaceId, showToast }: WsSectionProps) {
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
          <label htmlFor="env-var-key" className="block text-xs text-muted mb-1">Key</label>
          <input
            id="env-var-key"
            type="text"
            value={newKey}
            onChange={e => setNewKey(e.target.value.toUpperCase())}
            placeholder="VARIABLE_NAME"
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
            onKeyDown={e => e.key === 'Enter' && addVar()}
          />
        </div>
        <div className="flex-1">
          <label htmlFor="env-var-value" className="block text-xs text-muted mb-1">Value</label>
          <input
            id="env-var-value"
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

export function WsPipelineSection({ workspaceId, showToast }: WsSectionProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [autoWorktree, setAutoWorktree] = useState(true);
  const [storyTimeout, setStoryTimeout] = useState(45);
  const [maxRetries, setMaxRetries] = useState(0);
  const [mergeStrategy, setMergeStrategy] = useState<'direct' | 'pr' | 'draft-pr' | 'branch-only'>('direct');

  // Worker-level concurrency settings
  const [queueMaxConcurrent, setQueueMaxConcurrent] = useState(1);
  const [runNowMaxConcurrent, setRunNowMaxConcurrent] = useState(3);
  const [savingWorker, setSavingWorker] = useState(false);
  const [savedWorker, setSavedWorker] = useState(false);

  useEffect(() => {
    // Fetch workspace pipeline config
    apiFetch<{ config: { autoWorktree: boolean; storyTimeoutMin: number; maxRetries: number; mergeStrategy?: string } }>(`/api/workspaces/${workspaceId}/pipeline-config`)
      .then(data => {
        setAutoWorktree(data.config.autoWorktree ?? true);
        setStoryTimeout(data.config.storyTimeoutMin ?? 45);
        setMaxRetries(data.config.maxRetries ?? 0);
        if (data.config.mergeStrategy) setMergeStrategy(data.config.mergeStrategy as any);
      })
      .catch(() => { /* Use defaults */ })
      .finally(() => setLoading(false));

    // Fetch worker concurrency settings
    apiFetch<{ queue_max_concurrent: number; run_now_max_concurrent: number }>('/api/settings/worker')
      .then(data => {
        setQueueMaxConcurrent(data.queue_max_concurrent ?? 1);
        setRunNowMaxConcurrent(data.run_now_max_concurrent ?? 3);
      })
      .catch(() => { /* Use defaults */ });
  }, [workspaceId]);

  const savePipeline = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/pipeline-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoWorktree, storyTimeoutMin: storyTimeout, maxRetries, mergeStrategy }),
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

  const saveWorkerSettings = async () => {
    // Client-side validation
    const qVal = Math.max(1, Math.min(5, queueMaxConcurrent));
    const rVal = Math.max(1, Math.min(10, runNowMaxConcurrent));
    setQueueMaxConcurrent(qVal);
    setRunNowMaxConcurrent(rVal);

    setSavingWorker(true);
    setSavedWorker(false);
    try {
      await apiFetch('/api/settings/worker', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue_max_concurrent: qVal, run_now_max_concurrent: rVal }),
      });
      setSavedWorker(true);
      showToast('Worker concurrency settings saved');
      setTimeout(() => setSavedWorker(false), 2000);
    } catch {
      showToast('Failed to save worker settings', 'error');
    } finally {
      setSavingWorker(false);
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
            <ToggleSwitch checked={autoWorktree} onChange={() => setAutoWorktree(!autoWorktree)} label="Auto-create worktree" />
          </div>

          <div className="border-t border-border pt-5">
            <label htmlFor="pipeline-story-timeout" className="block text-xs text-muted mb-1">Story Timeout (minutes)</label>
            <input
              id="pipeline-story-timeout"
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
            <label htmlFor="pipeline-max-retries" className="block text-xs text-muted mb-1">Max Retries per Story</label>
            <input
              id="pipeline-max-retries"
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
            <label htmlFor="pipeline-merge-strategy" className="block text-xs text-muted mb-1">Merge Strategy</label>
            <select
              id="pipeline-merge-strategy"
              value={mergeStrategy}
              onChange={e => setMergeStrategy(e.target.value as any)}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            >
              <option value="direct">Direct merge to main + push</option>
              <option value="pr">Create Pull Request (CI-gated)</option>
              <option value="draft-pr">Create Draft Pull Request</option>
              <option value="branch-only">Push branch only (manual control)</option>
            </select>
            <p className="text-xs text-muted mt-1">
              {mergeStrategy === 'direct' && 'Maximum velocity — merges worktree to main and pushes immediately after all stories pass'}
              {mergeStrategy === 'pr' && 'CI-gated — pushes branch and creates a PR for review and CI checks before merge'}
              {mergeStrategy === 'draft-pr' && 'Review-first — creates a draft PR so you can review AI output before marking ready'}
              {mergeStrategy === 'branch-only' && 'Manual control — pushes branch to remote but takes no further action'}
            </p>
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

      {/* Worker Concurrency Settings */}
      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Worker Concurrency</h2>

        <div className="space-y-5">
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label htmlFor="queue-max-concurrent" className="block text-xs text-muted">Queue Concurrency</label>
              <span title="Controls how many queued pipeline runs the worker processes at the same time. Queued runs are triggered via the UI or API and wait in a FIFO queue. Sequential (1) is recommended to avoid merge conflicts on the same branch.">
                <Info size={12} className="text-muted cursor-help" />
              </span>
            </div>
            <input
              id="queue-max-concurrent"
              type="number"
              min={1}
              max={5}
              value={queueMaxConcurrent}
              onChange={e => {
                const v = Number(e.target.value);
                if (v >= 1 && v <= 5) setQueueMaxConcurrent(v);
              }}
              className="w-32 px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
            <p className="text-xs text-muted mt-1">Sequential queuing recommended (default: 1, range: 1–5)</p>
          </div>

          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label htmlFor="run-now-max-concurrent" className="block text-xs text-muted">Parallel Run Concurrency</label>
              <span title="Controls how many 'Run Now' (immediate) pipeline runs can execute in parallel. Each parallel run uses a separate git worktree for isolation — worktrees must be enabled for values above 1.">
                <Info size={12} className="text-muted cursor-help" />
              </span>
            </div>
            <input
              id="run-now-max-concurrent"
              type="number"
              min={1}
              max={10}
              value={runNowMaxConcurrent}
              onChange={e => {
                const v = Number(e.target.value);
                if (v >= 1 && v <= 10) setRunNowMaxConcurrent(v);
              }}
              className="w-32 px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
            <p className="text-xs text-muted mt-1">Requires worktrees (default: 3, range: 1–10)</p>
          </div>
        </div>

        <button
          onClick={saveWorkerSettings}
          disabled={savingWorker}
          className="flex items-center gap-2 px-4 py-2 mt-5 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {savingWorker ? <Loader2 size={14} className="animate-spin" /> : savedWorker ? <Check size={14} /> : <Save size={14} />}
          {savedWorker ? 'Saved' : 'Save Worker Settings'}
        </button>
      </div>
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

export function WsHooksSection({ workspaceId, showToast }: WsSectionProps) {
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
            <label htmlFor="hook-event" className="block text-xs text-muted mb-1">Event</label>
            <select
              id="hook-event"
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
            <label htmlFor="hook-command" className="block text-xs text-muted mb-1">Shell Command</label>
            <input
              id="hook-command"
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
                  <ToggleSwitch checked={!!h.enabled} onChange={() => toggleHook(h)} label={`Toggle hook: ${h.event_type}`} />
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

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(); } }}
      className={`relative w-9 h-5 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
        checked ? 'bg-accent' : 'bg-border'
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-switch-knob transition-transform ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}
