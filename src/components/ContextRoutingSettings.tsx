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

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Save, Loader2, Check, ChevronRight, ChevronDown,
  Folder, FolderOpen, FileText, Plus, Trash2, X,
  Code, Eye, Download, Upload, Wand2, Tag, AlertCircle,
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
  const [hasRorcaDir, setHasRorcaDir] = useState(false);

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
            Configure context routing rules. Skills are injected into story prompts based on directory path and tags.
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
}

function VisualEditor({
  config, skills, workspaceId, selectedPath,
  onSelectPath, onAddScope, onRemoveScope, onUpdateScope,
  onAddTag, onRemoveTag, onUpdateTag, onUpdateRouting,
}: VisualEditorProps) {
  return (
    <div className="space-y-6">
      {/* Global files */}
      <section>
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          Global Context Files
        </h3>
        <p className="text-xs text-muted mb-3">
          Always injected into every story prompt. Cannot be dropped by token budget.
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

      {/* Directory tree + scope rules (side by side) */}
      <section>
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          Scope Rules
        </h3>
        <p className="text-xs text-muted mb-3">
          Click a directory to create a scope rule. Matching story files inject the attached skills.
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
              Additive context injection based on story tags. Always combined with scope rules.
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
          Max tokens for injected context per story. Lowest-priority scoped files dropped first. Globals never dropped.
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
