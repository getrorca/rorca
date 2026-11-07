/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * AgentsEditorSection — In-app AGENTS.md editor with role cards (CIE-006)
 *
 * Renders inside WorkspaceSettingsPanel as the "Agents" tab.
 * Shows role cards with name, owned paths, avoided paths, and rules.
 * Supports CRUD operations and echolocation generation.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Trash2, Save, Loader2, Wand2, FolderOpen,
  ShieldAlert, X, ChevronDown, ChevronUp,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentRole {
  name: string;
  owns: string[];
  avoids: string[];
  rules: string[];
}

interface AgentsResponse {
  roles: AgentRole[];
  raw: string;
  exists: boolean;
  path: string;
}

interface GenerateResponse {
  roles: AgentRole[];
  raw: string;
  generated: boolean;
}

interface SectionProps {
  workspaceId: string;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AgentsEditorSection({ workspaceId, showToast }: SectionProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [exists, setExists] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [expandedRole, setExpandedRole] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  const loadRoles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<AgentsResponse>(`/api/agents?workspaceId=${workspaceId}`);
      setRoles(data.roles);
      setExists(data.exists);
      setFilePath(data.path);
      setDirty(false);
    } catch {
      showToast('Failed to load AGENTS.md', 'error');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, showToast]);

  useEffect(() => { loadRoles(); }, [loadRoles]);

  const saveRoles = async () => {
    setSaving(true);
    try {
      await apiFetch<AgentsResponse>('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, roles }),
      });
      setExists(true);
      setDirty(false);
      showToast('AGENTS.md saved', 'success');
    } catch {
      showToast('Failed to save AGENTS.md', 'error');
    } finally {
      setSaving(false);
    }
  };

  const generateFromEcholocation = async () => {
    setGenerating(true);
    try {
      const data = await apiFetch<GenerateResponse>('/api/agents/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setRoles(data.roles);
      setDirty(true);
      showToast('Roles generated from directory structure', 'success');
    } catch {
      showToast('Failed to generate AGENTS.md', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const addRole = () => {
    setRoles(prev => [...prev, { name: 'New Agent', owns: [], avoids: [], rules: [] }]);
    setExpandedRole(roles.length);
    setDirty(true);
  };

  const removeRole = (index: number) => {
    setRoles(prev => prev.filter((_, i) => i !== index));
    setExpandedRole(null);
    setDirty(true);
  };

  const updateRole = (index: number, updates: Partial<AgentRole>) => {
    setRoles(prev => prev.map((r, i) => i === index ? { ...r, ...updates } : r));
    setDirty(true);
  };

  const addGlob = (index: number, field: 'owns' | 'avoids') => {
    setRoles(prev => prev.map((r, i) =>
      i === index ? { ...r, [field]: [...r[field], ''] } : r
    ));
    setDirty(true);
  };

  const updateGlob = (roleIndex: number, field: 'owns' | 'avoids', globIndex: number, value: string) => {
    setRoles(prev => prev.map((r, i) => {
      if (i !== roleIndex) return r;
      const updated = [...r[field]];
      updated[globIndex] = value;
      return { ...r, [field]: updated };
    }));
    setDirty(true);
  };

  const removeGlob = (roleIndex: number, field: 'owns' | 'avoids', globIndex: number) => {
    setRoles(prev => prev.map((r, i) => {
      if (i !== roleIndex) return r;
      return { ...r, [field]: r[field].filter((_, gi) => gi !== globIndex) };
    }));
    setDirty(true);
  };

  const addRule = (roleIndex: number) => {
    setRoles(prev => prev.map((r, i) =>
      i === roleIndex ? { ...r, rules: [...r.rules, ''] } : r
    ));
    setDirty(true);
  };

  const updateRule = (roleIndex: number, ruleIndex: number, value: string) => {
    setRoles(prev => prev.map((r, i) => {
      if (i !== roleIndex) return r;
      const updated = [...r.rules];
      updated[ruleIndex] = value;
      return { ...r, rules: updated };
    }));
    setDirty(true);
  };

  const removeRule = (roleIndex: number, ruleIndex: number) => {
    setRoles(prev => prev.map((r, i) => {
      if (i !== roleIndex) return r;
      return { ...r, rules: r.rules.filter((_, ri) => ri !== ruleIndex) };
    }));
    setDirty(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="animate-spin text-muted" size={20} />
        <span className="ml-2 text-sm text-muted">Loading AGENTS.md...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold text-[var(--text)]">Agent Roles (AGENTS.md)</h2>
        <p className="text-xs text-muted mt-1">
          Define agent roles with file ownership and behavioral rules. Roles are soft governance — injected into story prompts so agents know their boundaries.
        </p>
        {filePath && (
          <p className="text-xs text-muted mt-1 flex items-center gap-1">
            <FolderOpen size={12} />
            {filePath}
            {!exists && <span className="text-amber-500 ml-1">(not created yet)</span>}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={addRole}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90 transition-colors"
        >
          <Plus size={14} /> Add Role
        </button>
        <button
          onClick={generateFromEcholocation}
          disabled={generating}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-panel border border-border text-[var(--text)] hover:bg-bg transition-colors disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {generating ? 'Generating...' : 'Generate from Structure'}
        </button>
        {dirty && (
          <button
            onClick={saveRoles}
            disabled={saving}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50 ml-auto"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Saving...' : 'Save AGENTS.md'}
          </button>
        )}
      </div>

      {/* Role Cards */}
      {roles.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted border border-dashed border-border rounded-lg">
          <ShieldAlert size={24} className="mx-auto mb-2 opacity-50" />
          No roles defined. Click "Add Role" or "Generate from Structure" to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {roles.map((role, i) => (
            <RoleCard
              key={i}
              role={role}
              index={i}
              expanded={expandedRole === i}
              onToggle={() => setExpandedRole(expandedRole === i ? null : i)}
              onUpdate={(updates) => updateRole(i, updates)}
              onRemove={() => removeRole(i)}
              onAddGlob={(field) => addGlob(i, field)}
              onUpdateGlob={(field, gi, val) => updateGlob(i, field, gi, val)}
              onRemoveGlob={(field, gi) => removeGlob(i, field, gi)}
              onAddRule={() => addRule(i)}
              onUpdateRule={(ri, val) => updateRule(i, ri, val)}
              onRemoveRule={(ri) => removeRule(i, ri)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Role Card ───────────────────────────────────────────────────────────────

interface RoleCardProps {
  role: AgentRole;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (updates: Partial<AgentRole>) => void;
  onRemove: () => void;
  onAddGlob: (field: 'owns' | 'avoids') => void;
  onUpdateGlob: (field: 'owns' | 'avoids', gi: number, val: string) => void;
  onRemoveGlob: (field: 'owns' | 'avoids', gi: number) => void;
  onAddRule: () => void;
  onUpdateRule: (ri: number, val: string) => void;
  onRemoveRule: (ri: number) => void;
}

function RoleCard({
  role, expanded, onToggle, onUpdate, onRemove,
  onAddGlob, onUpdateGlob, onRemoveGlob,
  onAddRule, onUpdateRule, onRemoveRule,
}: RoleCardProps) {
  return (
    <div className="border border-border rounded-lg bg-panel overflow-hidden">
      {/* Header (always visible) */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg transition-colors"
        onClick={onToggle}
      >
        {expanded ? <ChevronDown size={16} className="text-muted" /> : <ChevronUp size={16} className="text-muted rotate-180" />}
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-[var(--text)]">{role.name || 'Unnamed Role'}</span>
          <div className="flex gap-3 mt-0.5 text-xs text-muted">
            <span>{role.owns.length} owned</span>
            <span>{role.avoids.length} avoided</span>
            <span>{role.rules.length} rules</span>
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="p-1 text-muted hover:text-red-400 transition-colors"
          title="Remove role"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted block mb-1">Role Name</label>
            <input
              type="text"
              value={role.name}
              onChange={e => onUpdate({ name: e.target.value })}
              className="w-full px-3 py-1.5 text-sm rounded border border-border bg-bg text-[var(--text)] focus:border-accent outline-none"
              placeholder="e.g. Frontend Agent"
            />
          </div>

          {/* Owns */}
          <GlobList
            label="Owned Paths"
            description="Glob patterns for files this role is responsible for"
            items={role.owns}
            onAdd={() => onAddGlob('owns')}
            onUpdate={(gi, val) => onUpdateGlob('owns', gi, val)}
            onRemove={(gi) => onRemoveGlob('owns', gi)}
            placeholder="e.g. src/components/**"
          />

          {/* Avoids */}
          <GlobList
            label="Avoided Paths"
            description="Glob patterns for files this role should NOT modify"
            items={role.avoids}
            onAdd={() => onAddGlob('avoids')}
            onUpdate={(gi, val) => onUpdateGlob('avoids', gi, val)}
            onRemove={(gi) => onRemoveGlob('avoids', gi)}
            placeholder="e.g. backend/**"
          />

          {/* Rules */}
          <div>
            <label className="text-xs font-medium text-muted block mb-1">Rules</label>
            <p className="text-xs text-muted mb-2">Behavioral constraints injected into the agent prompt</p>
            {role.rules.map((rule, ri) => (
              <div key={ri} className="flex gap-2 mb-1.5">
                <input
                  type="text"
                  value={rule}
                  onChange={e => onUpdateRule(ri, e.target.value)}
                  className="flex-1 px-3 py-1.5 text-sm rounded border border-border bg-bg text-[var(--text)] focus:border-accent outline-none"
                  placeholder="e.g. Never introduce new packages without listing alternatives"
                />
                <button
                  onClick={() => onRemoveRule(ri)}
                  className="p-1.5 text-muted hover:text-red-400 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              onClick={onAddRule}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 mt-1"
            >
              <Plus size={12} /> Add rule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GlobList ────────────────────────────────────────────────────────────────

interface GlobListProps {
  label: string;
  description: string;
  items: string[];
  onAdd: () => void;
  onUpdate: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  placeholder: string;
}

function GlobList({ label, description, items, onAdd, onUpdate, onRemove, placeholder }: GlobListProps) {
  return (
    <div>
      <label className="text-xs font-medium text-muted block mb-1">{label}</label>
      <p className="text-xs text-muted mb-2">{description}</p>
      {items.map((item, i) => (
        <div key={i} className="flex gap-2 mb-1.5">
          <input
            type="text"
            value={item}
            onChange={e => onUpdate(i, e.target.value)}
            className="flex-1 px-3 py-1.5 text-sm rounded border border-border bg-bg text-[var(--text)] focus:border-accent outline-none font-mono"
            placeholder={placeholder}
          />
          <button
            onClick={() => onRemove(i)}
            className="p-1.5 text-muted hover:text-red-400 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={onAdd}
        className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 mt-1"
      >
        <Plus size={12} /> Add pattern
      </button>
    </div>
  );
}
