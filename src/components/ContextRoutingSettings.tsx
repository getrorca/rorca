/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ContextRoutingSettings.tsx — CIE-010: Visual editor for .rorca/config.json routing.
 *
 * Features:
 * - Directory tree browser (lazy-loaded, expandable)
 * - Click directory → sidebar shows injected skills for that path
 * - Add/remove skills via dropdown
 * - Priority slider per scope rule (1-100)
 * - Tag rules: tag input + skill attachment
 * - Token budget slider with live preview
 * - Save button writes to .rorca/config.json
 * - JSON editor tab with schema validation + inline errors
 * - "Eject to Config" button for new workspaces
 * - Import/export config as JSON
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Save, Loader2, Check, ChevronRight, ChevronDown,
  Folder, FolderOpen, FileText, Plus, Trash2, X,
  Code, Eye, Download, Upload, Wand2, Tag, AlertCircle,
  Boxes, Layers,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

interface RoutingScope {
  path: string;
  inject: string[];
  priority: number;
  managed: 'rorca' | 'manual' | 'hybrid';
}

interface RoutingTag {
  tag: string;
  inject: string[];
}

interface RoutingConfig {
  global: string[];
  scopes: RoutingScope[];
  tags: RoutingTag[];
  tokenBudget: number;
}

interface RorcaConfig {
  version: number;
  routing: RoutingConfig;
  context: Record<string, unknown>;
  teleology: Record<string, unknown>;
  orchestration: Record<string, unknown>;
  execution: Record<string, unknown>;
}

interface DirEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
}

interface SkillFile {
  filename: string;
  name: string;
  description: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface ValidationError {
  path: string;
  message: string;
}

// CIE-017: Monorepo types
interface MonorepoStackItem {
  name: string;
  version?: string;
  source: string;
}

interface MonorepoApp {
  path: string;
  name: string;
  stack: MonorepoStackItem[];
  inferredSkills: string[];
}

interface MonorepoScope {
  path: string;
  inject: string[];
  priority: number;
  managed: 'rorca' | 'manual' | 'hybrid';
}

interface MonorepoDiscoveryResult {
  tool: string | null;
  apps: MonorepoApp[];
  scopes: MonorepoScope[];
  agentsMd: string;
  applied: boolean;
  scopesAdded?: number;
}

interface Props {
  workspaceId: string;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

type ViewMode = 'visual' | 'json';

// ─── Main Component ─────────────────────────────────────────────────────────

export default function ContextRoutingSettings({ workspaceId, showToast }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('visual');

  // Config state
  const [config, setConfig] = useState<RorcaConfig | null>(null);
  const [originalConfig, setOriginalConfig] = useState<RorcaConfig | null>(null);
  const [configExists, setConfigExists] = useState(false);
  const [_hasRorcaDir, setHasRorcaDir] = useState(false);

  // Skills
  const [skills, setSkills] = useState<SkillFile[]>([]);

  // JSON editor
  const [rawJson, setRawJson] = useState('');
  const [jsonErrors, setJsonErrors] = useState<ValidationError[]>([]);

  // Directory tree selection
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Load config + skills
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [configData, skillsData] = await Promise.all([
        apiFetch<{ config: RorcaConfig; configExists: boolean; hasRorcaDir: boolean }>(
          `/api/workspaces/${workspaceId}/rorca-config`
        ),
        apiFetch<{ skills: SkillFile[]; hasRorcaDir: boolean }>(
          `/api/workspaces/${workspaceId}/skills`
        ),
      ]);

      setConfig(configData.config);
      setOriginalConfig(structuredClone(configData.config));
      setConfigExists(configData.configExists);
      setHasRorcaDir(configData.hasRorcaDir);
      setSkills(skillsData.skills);

      // Load raw JSON for editor tab
      const rawData = await apiFetch<{ raw: string; exists: boolean }>(
        `/api/workspaces/${workspaceId}/rorca-config/raw`
      );
      setRawJson(rawData.raw);
      setJsonErrors([]);
    } catch {
      showToast('Failed to load routing config', 'error');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, showToast]);

  useEffect(() => { loadData(); }, [loadData]);

  // Dirty check
  const isDirty = config && originalConfig
    ? JSON.stringify(config) !== JSON.stringify(originalConfig)
    : false;

  // Save (visual mode)
  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    setSaved(false);
    try {
      const result = await apiFetch<{ config: RorcaConfig; configExists: boolean }>(
        `/api/workspaces/${workspaceId}/rorca-config`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config }),
        }
      );
      setConfig(result.config);
      setOriginalConfig(structuredClone(result.config));
      setConfigExists(result.configExists);

      // Sync raw JSON
      const rawData = await apiFetch<{ raw: string }>(
        `/api/workspaces/${workspaceId}/rorca-config/raw`
      );
      setRawJson(rawData.raw);
      setJsonErrors([]);

      setSaved(true);
      showToast('Routing config saved');
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Save (JSON mode)
  const saveRawJson = async () => {
    setSaving(true);
    setSaved(false);
    setJsonErrors([]);
    try {
      const result = await apiFetch<{ config: RorcaConfig; configExists: boolean }>(
        `/api/workspaces/${workspaceId}/rorca-config/raw`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: rawJson }),
        }
      );
      setConfig(result.config);
      setOriginalConfig(structuredClone(result.config));
      setConfigExists(result.configExists);
      setSaved(true);
      showToast('Config saved from JSON editor');
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      if (err instanceof Error) {
        try {
          const errData = JSON.parse(err.message);
          if (errData.details) {
            setJsonErrors(errData.details);
          }
        } catch {
          showToast(err.message, 'error');
        }
      }
    } finally {
      setSaving(false);
    }
  };

  // Eject to config
  const ejectConfig = async () => {
    try {
      const result = await apiFetch<{ config: RorcaConfig; configExists: boolean; ejected: boolean }>(
        `/api/workspaces/${workspaceId}/rorca-config/eject`,
        { method: 'POST' }
      );
      setConfig(result.config);
      setOriginalConfig(structuredClone(result.config));
      setConfigExists(result.configExists);
      setHasRorcaDir(true);
      // Refresh raw
      const rawData = await apiFetch<{ raw: string }>(
        `/api/workspaces/${workspaceId}/rorca-config/raw`
      );
      setRawJson(rawData.raw);
      showToast(result.ejected ? 'Config ejected — .rorca/config.json created' : 'Config already exists');
    } catch {
      showToast('Failed to eject config', 'error');
    }
  };

  // Export
  const exportConfig = () => {
    const blob = new Blob([rawJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rorca-config.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import
  const importConfig = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        JSON.parse(text); // Validate it's JSON
        setRawJson(text);
        setViewMode('json');
        showToast('Config imported — review and save');
      } catch {
        showToast('Invalid JSON file', 'error');
      }
    };
    input.click();
  };

  // Routing helpers
  const updateRouting = (patch: Partial<RoutingConfig>) => {
    if (!config) return;
    setConfig({ ...config, routing: { ...config.routing, ...patch } });
  };

  const addScope = (dirPath: string) => {
    if (!config) return;
    const exists = config.routing.scopes.some(s => s.path === dirPath + '/**');
    if (exists) return;
    const newScope: RoutingScope = {
      path: dirPath + '/**',
      inject: [],
      priority: 50,
      managed: 'manual',
    };
    updateRouting({ scopes: [...config.routing.scopes, newScope] });
  };

  const removeScope = (idx: number) => {
    if (!config) return;
    updateRouting({ scopes: config.routing.scopes.filter((_, i) => i !== idx) });
  };

  const updateScope = (idx: number, patch: Partial<RoutingScope>) => {
    if (!config) return;
    const scopes = config.routing.scopes.map((s, i) => i === idx ? { ...s, ...patch } : s);
    updateRouting({ scopes });
  };

  const addTag = () => {
    if (!config) return;
    updateRouting({ tags: [...config.routing.tags, { tag: '', inject: [] }] });
  };

  const removeTag = (idx: number) => {
    if (!config) return;
    updateRouting({ tags: config.routing.tags.filter((_, i) => i !== idx) });
  };

  const updateTag = (idx: number, patch: Partial<RoutingTag>) => {
    if (!config) return;
    const tags = config.routing.tags.map((t, i) => i === idx ? { ...t, ...patch } : t);
    updateRouting({ tags });
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted text-sm">
        <Loader2 size={16} className="animate-spin" /> Loading context routing config...
      </div>
    );
  }

  if (!config) {
    return <div className="text-sm text-muted">Failed to load config.</div>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Rules Engine</h2>
          <p className="text-xs text-muted mt-0.5">
            Control which skills the AI uses for different parts of your project.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex items-center border border-border rounded overflow-hidden">
            <button
              onClick={() => setViewMode('visual')}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors ${
                viewMode === 'visual'
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:text-[var(--text)]'
              }`}
            >
              <Eye size={12} /> Visual
            </button>
            <button
              onClick={() => setViewMode('json')}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs border-l border-border transition-colors ${
                viewMode === 'json'
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:text-[var(--text)]'
              }`}
            >
              <Code size={12} /> JSON
            </button>
          </div>
          {/* Import/Export */}
          <button
            onClick={importConfig}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted hover:text-[var(--text)] border border-border rounded transition-colors"
            title="Import config"
          >
            <Upload size={12} /> Import
          </button>
          <button
            onClick={exportConfig}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted hover:text-[var(--text)] border border-border rounded transition-colors"
            title="Export config"
          >
            <Download size={12} /> Export
          </button>
        </div>
      </div>

      {/* Eject banner for workspaces without config */}
      {!configExists && (
        <div className="flex items-center justify-between px-4 py-3 border border-dashed border-accent/40 rounded bg-accent/5">
          <div className="text-sm text-[var(--text)]">
            No <code className="text-xs bg-bg px-1 py-0.5 rounded font-mono">.rorca/config.json</code> found.
            Eject to generate a default config with all advanced options.
          </div>
          <button
            onClick={ejectConfig}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors shrink-0 ml-4"
          >
            <Wand2 size={12} /> Eject to Config
          </button>
        </div>
      )}

      {viewMode === 'visual' ? (
        <VisualEditor
          config={config}
          skills={skills}
          workspaceId={workspaceId}
          selectedPath={selectedPath}
          onSelectPath={setSelectedPath}
          onAddScope={addScope}
          onRemoveScope={removeScope}
          onUpdateScope={updateScope}
          onAddTag={addTag}
          onRemoveTag={removeTag}
          onUpdateTag={updateTag}
          onUpdateRouting={updateRouting}
          showToast={showToast}
          onScopesApplied={loadData}
        />
      ) : (
        <JsonEditor
          rawJson={rawJson}
          setRawJson={setRawJson}
          errors={jsonErrors}
        />
      )}

      {/* Save button */}
      <div className="flex items-center gap-3 pt-2 border-t border-border">
        <button
          onClick={viewMode === 'visual' ? saveConfig : saveRawJson}
          disabled={saving || (viewMode === 'visual' && !isDirty)}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
          {saved ? 'Saved' : 'Save Config'}
        </button>
        {isDirty && viewMode === 'visual' && (
          <span className="text-xs text-warning">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}

// ─── Visual Editor ──────────────────────────────────────────────────────────

interface VisualEditorProps {
  config: RorcaConfig;
  skills: SkillFile[];
  workspaceId: string;
  selectedPath: string | null;
  onSelectPath: (p: string | null) => void;
  onAddScope: (dirPath: string) => void;
  onRemoveScope: (idx: number) => void;
  onUpdateScope: (idx: number, patch: Partial<RoutingScope>) => void;
  onAddTag: () => void;
  onRemoveTag: (idx: number) => void;
  onUpdateTag: (idx: number, patch: Partial<RoutingTag>) => void;
  onUpdateRouting: (patch: Partial<RoutingConfig>) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
  onScopesApplied: () => void;
}

function VisualEditor({
  config, skills, workspaceId, selectedPath,
  onSelectPath, onAddScope, onRemoveScope, onUpdateScope,
  onAddTag, onRemoveTag, onUpdateTag, onUpdateRouting,
  showToast, onScopesApplied,
}: VisualEditorProps) {
  return (
    <div className="space-y-6">
      {/* Global files */}
      <section>
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          Global Context Files
        </h3>
        <p className="text-xs text-muted mb-3">
          Always included when the AI works on any story. These are never skipped.
        </p>
        <div className="flex flex-wrap gap-2">
          {config.routing.global.map((f, i) => (
            <span key={i} className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-bg border border-border rounded font-mono">
              <FileText size={12} className="text-muted" />
              {f}
            </span>
          ))}
        </div>
      </section>

      {/* CIE-017: Monorepo Discovery */}
      <MonorepoDiscoveryPanel
        workspaceId={workspaceId}
        showToast={showToast}
        onScopesApplied={onScopesApplied}
      />

      {/* Directory tree + scope rules (side by side) */}
      <section>
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          Scope Rules
        </h3>
        <p className="text-xs text-muted mb-3">
          Click a directory to create a rule. When a story touches files in that directory, the attached skills are automatically included.
        </p>

        <div className="flex gap-4 min-h-[300px]">
          {/* Directory tree */}
          <div className="w-64 shrink-0 border border-border rounded overflow-y-auto bg-bg p-2">
            <DirectoryTree
              workspaceId={workspaceId}
              selectedPath={selectedPath}
              onSelect={(p) => {
                onSelectPath(p);
                onAddScope(p);
              }}
            />
          </div>

          {/* Scope rules list */}
          <div className="flex-1 space-y-3 min-w-0">
            {config.routing.scopes.length === 0 ? (
              <div className="text-sm text-muted py-8 text-center border border-dashed border-border rounded">
                No scope rules. Click a directory on the left to add one.
              </div>
            ) : (
              config.routing.scopes.map((scope, idx) => (
                <ScopeRuleCard
                  key={idx}
                  scope={scope}
                  skills={skills}
                  isSelected={selectedPath !== null && scope.path.startsWith(selectedPath)}
                  onUpdate={(patch) => onUpdateScope(idx, patch)}
                  onRemove={() => onRemoveScope(idx)}
                />
              ))
            )}
          </div>
        </div>
      </section>

      {/* Tag rules */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
              Tag Rules
            </h3>
            <p className="text-xs text-muted mt-1">
              Extra skills added when a story has a matching tag. These are combined with directory rules above.
            </p>
          </div>
          <button
            onClick={onAddTag}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors"
          >
            <Plus size={12} /> Add Tag Rule
          </button>
        </div>

        {config.routing.tags.length === 0 ? (
          <div className="text-sm text-muted py-6 text-center border border-dashed border-border rounded">
            No tag rules configured.
          </div>
        ) : (
          <div className="space-y-2">
            {config.routing.tags.map((tag, idx) => (
              <TagRuleCard
                key={idx}
                tag={tag}
                skills={skills}
                onUpdate={(patch) => onUpdateTag(idx, patch)}
                onRemove={() => onRemoveTag(idx)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Token budget */}
      <section>
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          Token Budget
        </h3>
        <p className="text-xs text-muted mb-3">
          Maximum amount of context the AI receives per story. When the limit is reached, lower-priority skills are dropped first. Global files are never dropped.
        </p>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={1000}
            max={200000}
            step={1000}
            value={config.routing.tokenBudget}
            onChange={e => onUpdateRouting({ tokenBudget: Number(e.target.value) })}
            className="flex-1 accent-[var(--accent)]"
          />
          <div className="w-28 text-right">
            <span className="text-sm font-mono text-[var(--text)]">
              {config.routing.tokenBudget.toLocaleString()}
            </span>
            <span className="text-xs text-muted ml-1">tokens</span>
          </div>
        </div>
        <div className="flex justify-between text-xs text-muted mt-1">
          <span>1,000</span>
          <span>200,000</span>
        </div>
      </section>
    </div>
  );
}

// ─── Directory Tree ─────────────────────────────────────────────────────────

interface TreeNodeData {
  name: string;
  path: string;
  type: 'directory' | 'file';
  loaded?: boolean;
  children?: TreeNodeData[];
}

function DirectoryTree({
  workspaceId,
  selectedPath,
  onSelect,
}: {
  workspaceId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [roots, setRoots] = useState<TreeNodeData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ entries: DirEntry[] }>(
      `/api/workspaces/${workspaceId}/directory-tree`
    ).then(data => {
      setRoots(
        data.entries
          .filter(e => e.type === 'directory')
          .map(e => ({ ...e, loaded: false, children: [] }))
      );
    }).catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId]);

  if (loading) {
    return <div className="text-xs text-muted flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Loading...</div>;
  }

  if (roots.length === 0) {
    return <div className="text-xs text-muted">No directories found.</div>;
  }

  return (
    <div className="text-xs">
      {roots.map(node => (
        <TreeNode
          key={node.path}
          node={node}
          workspaceId={workspaceId}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={0}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  workspaceId,
  selectedPath,
  onSelect,
  depth,
}: {
  node: TreeNodeData;
  workspaceId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeNodeData[]>(node.children || []);
  const [loaded, setLoaded] = useState(node.loaded || false);

  const toggle = async () => {
    if (!expanded && !loaded) {
      try {
        const data = await apiFetch<{ entries: DirEntry[] }>(
          `/api/workspaces/${workspaceId}/directory-tree?dirPath=${encodeURIComponent(node.path)}`
        );
        const dirs = data.entries
          .filter(e => e.type === 'directory')
          .map(e => ({ ...e, loaded: false, children: [] }));
        setChildren(dirs);
        setLoaded(true);
      } catch { /* ignore */ }
    }
    setExpanded(!expanded);
  };

  const isSelected = selectedPath === node.path;

  return (
    <div>
      <button
        onClick={() => { toggle(); onSelect(node.path); }}
        className={`w-full flex items-center gap-1 py-1 px-1 rounded text-left transition-colors hover:bg-surface-100 ${
          isSelected ? 'bg-accent/10 text-accent' : 'text-[var(--text)]'
        }`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {expanded
          ? <ChevronDown size={12} className="text-muted shrink-0" />
          : <ChevronRight size={12} className="text-muted shrink-0" />}
        {expanded
          ? <FolderOpen size={12} className="text-accent shrink-0" />
          : <Folder size={12} className="text-muted shrink-0" />}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded && children.map(child => (
        <TreeNode
          key={child.path}
          node={child}
          workspaceId={workspaceId}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

// ─── Scope Rule Card ────────────────────────────────────────────────────────

function ScopeRuleCard({
  scope,
  skills,
  isSelected,
  onUpdate,
  onRemove,
}: {
  scope: RoutingScope;
  skills: SkillFile[];
  isSelected: boolean;
  onUpdate: (patch: Partial<RoutingScope>) => void;
  onRemove: () => void;
}) {
  const [showSkillPicker, setShowSkillPicker] = useState(false);

  const addSkill = (skillName: string) => {
    if (!scope.inject.includes(skillName)) {
      onUpdate({ inject: [...scope.inject, skillName] });
    }
    setShowSkillPicker(false);
  };

  const removeSkill = (skillName: string) => {
    onUpdate({ inject: scope.inject.filter(s => s !== skillName) });
  };

  const availableSkills = skills.filter(s => !scope.inject.includes(s.filename));

  return (
    <div className={`border rounded p-3 space-y-3 transition-colors ${
      isSelected ? 'border-accent bg-accent/5' : 'border-border bg-bg'
    }`}>
      {/* Path */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Folder size={14} className="text-accent shrink-0" />
          <input
            type="text"
            value={scope.path}
            onChange={e => onUpdate({ path: e.target.value })}
            className="text-sm font-mono bg-transparent border-none outline-none text-[var(--text)] min-w-0 flex-1"
            placeholder="src/components/**"
          />
        </div>
        <button
          onClick={onRemove}
          className="p-1 text-muted hover:text-red-500 transition-colors shrink-0"
          title="Remove scope rule"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Skills */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs text-muted">Injected skills:</span>
          <button
            onClick={() => setShowSkillPicker(!showSkillPicker)}
            className="flex items-center gap-0.5 text-xs text-accent hover:text-accent/80 transition-colors"
          >
            <Plus size={10} /> Add
          </button>
        </div>

        {scope.inject.length === 0 ? (
          <span className="text-xs text-muted italic">No skills attached</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {scope.inject.map(s => (
              <span key={s} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-panel border border-border rounded font-mono">
                {s}
                <button onClick={() => removeSkill(s)} className="text-muted hover:text-red-500 transition-colors">
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {showSkillPicker && (
          <div className="mt-2 border border-border rounded bg-panel p-2 max-h-32 overflow-y-auto">
            {availableSkills.length === 0 ? (
              <span className="text-xs text-muted">No more skills available. Add .md files to .rorca/skills/</span>
            ) : (
              availableSkills.map(s => (
                <button
                  key={s.filename}
                  onClick={() => addSkill(s.filename)}
                  className="w-full text-left px-2 py-1 text-xs hover:bg-surface-100 rounded transition-colors flex items-center gap-2"
                >
                  <FileText size={12} className="text-muted" />
                  <span className="font-mono">{s.filename}</span>
                  <span className="text-muted truncate ml-auto">{s.description}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Priority slider */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted w-14 shrink-0">Priority:</span>
        <input
          type="range"
          min={1}
          max={100}
          value={scope.priority}
          onChange={e => onUpdate({ priority: Number(e.target.value) })}
          className="flex-1 accent-[var(--accent)]"
        />
        <span className="text-xs font-mono text-[var(--text)] w-8 text-right">{scope.priority}</span>
      </div>
    </div>
  );
}

// ─── Tag Rule Card ──────────────────────────────────────────────────────────

function TagRuleCard({
  tag,
  skills,
  onUpdate,
  onRemove,
}: {
  tag: RoutingTag;
  skills: SkillFile[];
  onUpdate: (patch: Partial<RoutingTag>) => void;
  onRemove: () => void;
}) {
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const availableSkills = skills.filter(s => !tag.inject.includes(s.filename));

  const addSkill = (skillName: string) => {
    if (!tag.inject.includes(skillName)) {
      onUpdate({ inject: [...tag.inject, skillName] });
    }
    setShowSkillPicker(false);
  };

  const removeSkill = (skillName: string) => {
    onUpdate({ inject: tag.inject.filter(s => s !== skillName) });
  };

  return (
    <div className="flex items-start gap-3 border border-border rounded p-3 bg-bg">
      <Tag size={14} className="text-accent mt-0.5 shrink-0" />

      <div className="flex-1 min-w-0 space-y-2">
        {/* Tag name input */}
        <input
          type="text"
          value={tag.tag}
          onChange={e => onUpdate({ tag: e.target.value })}
          placeholder="e.g. auth, payments, frontend"
          className="w-full px-2 py-1 text-sm bg-transparent border border-border rounded focus:border-accent outline-none font-mono"
        />

        {/* Skills */}
        <div className="flex items-center gap-2 flex-wrap">
          {tag.inject.map(s => (
            <span key={s} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-panel border border-border rounded font-mono">
              {s}
              <button onClick={() => removeSkill(s)} className="text-muted hover:text-red-500 transition-colors">
                <X size={10} />
              </button>
            </span>
          ))}
          <button
            onClick={() => setShowSkillPicker(!showSkillPicker)}
            className="flex items-center gap-0.5 text-xs text-accent hover:text-accent/80 transition-colors"
          >
            <Plus size={10} /> Add skill
          </button>
        </div>

        {showSkillPicker && (
          <div className="border border-border rounded bg-panel p-2 max-h-32 overflow-y-auto">
            {availableSkills.length === 0 ? (
              <span className="text-xs text-muted">No more skills available</span>
            ) : (
              availableSkills.map(s => (
                <button
                  key={s.filename}
                  onClick={() => addSkill(s.filename)}
                  className="w-full text-left px-2 py-1 text-xs hover:bg-surface-100 rounded transition-colors flex items-center gap-2"
                >
                  <FileText size={12} className="text-muted" />
                  <span className="font-mono">{s.filename}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <button
        onClick={onRemove}
        className="p-1 text-muted hover:text-red-500 transition-colors shrink-0"
        title="Remove tag rule"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ─── CIE-017: Monorepo Discovery Panel ──────────────────────────────────────

/** Group apps by their parent directory (apps/, packages/, etc.) for tree rendering. */
function groupAppsByParent(apps: MonorepoApp[]): Map<string, MonorepoApp[]> {
  const groups = new Map<string, MonorepoApp[]>();
  for (const app of apps) {
    const parts = app.path.split('/');
    const parent = parts.length > 1 ? parts[0] : '.';
    const existing = groups.get(parent) ?? [];
    existing.push(app);
    groups.set(parent, existing);
  }
  return groups;
}

function MonorepoDiscoveryPanel({
  workspaceId,
  showToast,
  onScopesApplied,
}: {
  workspaceId: string;
  showToast: (message: string, type?: 'success' | 'error') => void;
  onScopesApplied: () => void;
}) {
  const [discovering, setDiscovering] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<MonorepoDiscoveryResult | null>(null);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showAgentsMd, setShowAgentsMd] = useState(false);

  const discover = async () => {
    setDiscovering(true);
    setResult(null);
    try {
      const data = await apiFetch<MonorepoDiscoveryResult>(
        `/api/workspaces/${workspaceId}/monorepo/discover`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'preview' }) }
      );
      setResult(data);
      if (data.apps.length > 0) {
        setExpandedApps(new Set(data.apps.map(a => a.path)));
        const groups = groupAppsByParent(data.apps);
        setExpandedGroups(new Set(groups.keys()));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Discovery failed';
      if (msg.toLowerCase().includes('no monorepo') || msg.toLowerCase().includes('not a monorepo')) {
        showToast('No monorepo structure detected in this workspace.', 'success');
      } else {
        showToast(msg, 'error');
      }
    } finally {
      setDiscovering(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      const data = await apiFetch<MonorepoDiscoveryResult>(
        `/api/workspaces/${workspaceId}/monorepo/discover`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'apply' }) }
      );
      setResult(data);
      showToast(`Applied ${data.scopesAdded ?? 0} new scope rules + CLAUDE.md monorepo section`);
      onScopesApplied();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Apply failed';
      showToast(msg, 'error');
    } finally {
      setApplying(false);
    }
  };

  const toggleApp = (appPath: string) => {
    setExpandedApps(prev => {
      const next = new Set(prev);
      if (next.has(appPath)) next.delete(appPath);
      else next.add(appPath);
      return next;
    });
  };

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const appGroups = result ? groupAppsByParent(result.apps) : new Map<string, MonorepoApp[]>();

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
            <Boxes size={12} /> Monorepo Discovery
          </h3>
          <p className="text-xs text-muted mt-1">
            Auto-detect apps and stacks in your monorepo, and set up per-app rules and context files.
          </p>
        </div>
        <button
          onClick={discover}
          disabled={discovering}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {discovering ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          {discovering ? 'Scanning...' : 'Discover'}
        </button>
      </div>

      {result && result.apps.length > 0 && (
        <div className="border border-border rounded bg-bg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-panel">
            <div className="flex items-center gap-2 text-xs">
              <Layers size={12} className="text-accent" />
              <span className="text-[var(--text)] font-medium">
                {result.apps.length} app{result.apps.length !== 1 ? 's' : ''} in {appGroups.size} director{appGroups.size !== 1 ? 'ies' : 'y'}
              </span>
              {result.tool && (
                <span className="px-1.5 py-0.5 bg-accent/10 text-accent rounded font-mono text-[10px]">
                  {result.tool}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAgentsMd(!showAgentsMd)}
                className={`text-xs px-2 py-1 rounded transition-colors ${
                  showAgentsMd ? 'bg-accent/10 text-accent' : 'text-muted hover:text-[var(--text)]'
                }`}
              >
                AGENTS.md
              </button>
              {!result.applied && (
                <button
                  onClick={apply}
                  disabled={applying}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition-colors"
                >
                  {applying ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
                  Apply Scopes
                </button>
              )}
              {result.applied && (
                <span className="flex items-center gap-1 text-xs text-green-500">
                  <Check size={10} /> Applied
                </span>
              )}
            </div>
          </div>

          {/* Monorepo tree */}
          {!showAgentsMd ? (
            <div className="p-2">
              {/* Root node */}
              <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted">
                <Folder size={12} className="text-muted" />
                <span className="font-mono">/</span>
                {result.tool && <span className="text-[10px] text-muted italic ml-1">({result.tool})</span>}
              </div>

              {/* Group directories */}
              {[...appGroups.entries()].map(([group, apps], groupIdx) => {
                const isGroupExpanded = expandedGroups.has(group);
                const isLastGroup = groupIdx === appGroups.size - 1;

                return (
                  <div key={group} className="ml-2">
                    {/* Tree connector + group folder */}
                    <button
                      onClick={() => toggleGroup(group)}
                      className="w-full flex items-center gap-1 px-2 py-1 text-left hover:bg-surface-100 rounded transition-colors"
                    >
                      <span className="text-border text-xs font-mono w-4 text-center shrink-0">
                        {isLastGroup ? '└' : '├'}
                      </span>
                      {isGroupExpanded
                        ? <ChevronDown size={10} className="text-muted shrink-0" />
                        : <ChevronRight size={10} className="text-muted shrink-0" />
                      }
                      <FolderOpen size={12} className="text-accent shrink-0" />
                      <span className="text-xs font-mono text-[var(--text)] font-medium">{group}/</span>
                      <span className="text-[10px] text-muted ml-1">
                        {apps.length} app{apps.length !== 1 ? 's' : ''}
                      </span>
                    </button>

                    {/* App children */}
                    {isGroupExpanded && apps.map((app, appIdx) => {
                      const appName = app.path.split('/').slice(1).join('/') || app.path;
                      const isAppExpanded = expandedApps.has(app.path);
                      const isLastApp = appIdx === apps.length - 1;

                      return (
                        <div key={app.path} className="ml-6">
                          {/* App node */}
                          <button
                            onClick={() => toggleApp(app.path)}
                            className="w-full flex items-center gap-1 px-2 py-1 text-left hover:bg-surface-100 rounded transition-colors"
                          >
                            <span className="text-border text-xs font-mono w-4 text-center shrink-0">
                              {isLastApp ? '└' : '├'}
                            </span>
                            {isAppExpanded
                              ? <ChevronDown size={10} className="text-muted shrink-0" />
                              : <ChevronRight size={10} className="text-muted shrink-0" />
                            }
                            <Folder size={12} className="text-accent shrink-0" />
                            <span className="text-xs font-mono text-[var(--text)]">{appName}</span>
                            <span className="text-[10px] text-muted ml-1">({app.name})</span>
                            <span className="ml-auto flex items-center gap-1">
                              {app.stack.slice(0, 3).map(s => (
                                <span key={s.name} className="px-1 py-0.5 text-[9px] bg-panel border border-border rounded">
                                  {s.name}
                                </span>
                              ))}
                              {app.stack.length > 3 && (
                                <span className="text-[9px] text-muted">+{app.stack.length - 3}</span>
                              )}
                            </span>
                          </button>

                          {/* App details (expanded) */}
                          {isAppExpanded && (
                            <div className={`ml-10 pb-2 pt-1 space-y-2 ${!isLastApp ? 'border-l border-border' : ''}`}>
                              {/* Stack */}
                              {app.stack.length > 0 && (
                                <div className="pl-3">
                                  <span className="text-[10px] text-muted uppercase tracking-wider">Stack:</span>
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {app.stack.map(s => (
                                      <span key={s.name} className="px-1.5 py-0.5 text-[10px] bg-panel border border-border rounded">
                                        {s.name}
                                        {s.version && <span className="text-muted ml-0.5">v{s.version}</span>}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Inferred skills */}
                              {app.inferredSkills.length > 0 && (
                                <div className="pl-3">
                                  <span className="text-[10px] text-muted uppercase tracking-wider">Inferred skills:</span>
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {app.inferredSkills.map(s => (
                                      <span key={s} className="px-1.5 py-0.5 text-[10px] bg-accent/10 text-accent border border-accent/20 rounded font-mono">
                                        {s}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Scope rule preview */}
                              <div className="pl-3">
                                <span className="text-[10px] text-muted uppercase tracking-wider">Scope rule:</span>
                                <div className="mt-1 px-2 py-1.5 bg-panel border border-border rounded text-[10px] font-mono text-muted">
                                  <span className="text-[var(--text)]">{app.path}/**</span>
                                  {' → '}
                                  {app.inferredSkills.length > 0
                                    ? app.inferredSkills.map(s => `.rorca/skills/${s}`).join(', ')
                                    : '(no skills to inject)'
                                  }
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            /* AGENTS.md preview */
            <div className="p-3">
              <pre className="text-[11px] font-mono text-muted bg-panel border border-border rounded p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                {result.agentsMd}
              </pre>
            </div>
          )}
        </div>
      )}

      {result && result.apps.length === 0 && (
        <div className="text-xs text-muted py-4 text-center border border-dashed border-border rounded">
          No monorepo structure detected. Expected: turbo.json, nx.json, pnpm-workspace.yaml,
          or apps/packages directories with package.json files.
        </div>
      )}
    </section>
  );
}

// ─── JSON Editor ────────────────────────────────────────────────────────────

function JsonEditor({
  rawJson,
  setRawJson,
  errors,
}: {
  rawJson: string;
  setRawJson: (v: string) => void;
  errors: ValidationError[];
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Edit <code className="bg-bg px-1 py-0.5 rounded font-mono">.rorca/config.json</code> directly.
        Schema validation runs on save.
      </p>

      {errors.length > 0 && (
        <div className="border border-red-500/30 bg-red-500/5 rounded p-3 space-y-1">
          {errors.map((e, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <AlertCircle size={12} className="text-red-500 mt-0.5 shrink-0" />
              <span className="text-red-400">
                {e.path && <code className="font-mono mr-1">{e.path}:</code>}
                {e.message}
              </span>
            </div>
          ))}
        </div>
      )}

      <textarea
        value={rawJson}
        onChange={e => setRawJson(e.target.value)}
        rows={24}
        spellCheck={false}
        className="w-full px-4 py-3 text-sm font-mono bg-bg border border-border rounded focus:border-accent outline-none resize-y leading-relaxed"
        placeholder='{ "version": 1, "routing": { ... } }'
      />
    </div>
  );
}
