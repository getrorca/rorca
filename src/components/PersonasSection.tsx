/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PersonasSection.tsx — CA-016: Personas management UI for Settings panel.
 *
 * Features:
 * - Lists all discovered personas grouped by category (collapsible sections)
 * - Each persona card shows: name, category badge, description, trigger glob patterns
 * - Click to edit opens Monaco editor for the persona markdown file
 * - Add Persona button creates a new .md file with template frontmatter
 * - Enable/disable toggle per persona (stored in .rorca/config.json personas.disabled[])
 * - Category filter dropdown
 */

import { useState, useEffect, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import {
  ChevronDown, ChevronRight, Plus, Save, Loader2, X,
  Check, AlertTriangle, FileText, Filter,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';

// ─── Types ──────────────────────────────────────────────────────────────────

type PersonaCategory = 'primary' | 'adversarial' | 'specialist' | 'review';

interface PersonaEntry {
  name: string;
  category: PersonaCategory;
  description: string;
  triggers: string[];
  reviewPriority: number;
  filePath: string;
  relativePath: string;
  enabled: boolean;
}

interface PersonasResponse {
  personas: Record<string, PersonaEntry[]>;
  warnings: Array<{ filePath: string; reason: string }>;
  totalCount: number;
  disabledCount: number;
}

const CATEGORY_META: Record<PersonaCategory, { label: string; color: string; bg: string; border: string }> = {
  primary: { label: 'Primary', color: 'text-blue-400', bg: 'bg-blue-500/15', border: 'border-blue-500/20' },
  adversarial: { label: 'Adversarial', color: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-500/20' },
  specialist: { label: 'Specialist', color: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/20' },
  review: { label: 'Review', color: 'text-amber-400', bg: 'bg-amber-500/15', border: 'border-amber-500/20' },
};

const ALL_CATEGORIES: PersonaCategory[] = ['primary', 'adversarial', 'specialist', 'review'];

// ─── Component ──────────────────────────────────────────────────────────────

export default function PersonasSection() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();

  const [personas, setPersonas] = useState<Record<string, PersonaEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<PersonaCategory | 'all'>('all');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Editor state
  const [editingPersona, setEditingPersona] = useState<PersonaEntry | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Add persona dialog
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newCategory, setNewCategory] = useState<PersonaCategory>('specialist');
  const [creating, setCreating] = useState(false);

  // Toggling
  const [togglingName, setTogglingName] = useState<string | null>(null);

  const fetchPersonas = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ workspaceId });
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      const data = await apiFetch<PersonasResponse>(`/api/personas?${params}`);
      setPersonas(data.personas);
    } catch (err) {
      toast.show(`Failed to load personas: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, categoryFilter, toast]);

  useEffect(() => { fetchPersonas(); }, [fetchPersonas]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleTogglePersona = async (persona: PersonaEntry) => {
    setTogglingName(persona.name);
    try {
      await apiFetch('/api/personas/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          personaName: persona.name,
          enabled: !persona.enabled,
        }),
      });
      // Update local state
      setPersonas(prev => {
        const next = { ...prev };
        for (const cat of Object.keys(next)) {
          next[cat] = next[cat].map(p =>
            p.name === persona.name ? { ...p, enabled: !p.enabled } : p,
          );
        }
        return next;
      });
      toast.show(`${persona.name} ${persona.enabled ? 'disabled' : 'enabled'}`, 'success');
    } catch (err) {
      toast.show(`Failed to toggle: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setTogglingName(null);
    }
  };

  const handleEditPersona = async (persona: PersonaEntry) => {
    try {
      const data = await apiFetch<{ content: string }>(
        `/api/personas/read?workspaceId=${workspaceId}&filePath=${encodeURIComponent(persona.relativePath)}`,
      );
      setEditorContent(data.content);
      setEditingPersona(persona);
      setEditorDirty(false);
    } catch (err) {
      toast.show(`Failed to read persona file: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleSaveEditor = async () => {
    if (!editingPersona) return;
    setSaving(true);
    try {
      await apiFetch('/api/personas/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          filePath: editingPersona.relativePath,
          content: editorContent,
        }),
      });
      setEditorDirty(false);
      toast.show('Persona saved', 'success');
      fetchPersonas();
    } catch (err) {
      toast.show(`Failed to save: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCreatePersona = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await apiFetch('/api/personas/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name: newName.trim(),
          description: newDescription.trim() || undefined,
          category: newCategory,
        }),
      });
      toast.show(`Persona "${newName}" created`, 'success');
      setShowAddDialog(false);
      setNewName('');
      setNewDescription('');
      setNewCategory('specialist');
      fetchPersonas();
    } catch (err) {
      toast.show(`Failed to create: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCreating(false);
    }
  };

  const visibleCategories = categoryFilter === 'all'
    ? ALL_CATEGORIES
    : [categoryFilter];

  // ─── Editor View ────────────────────────────────────────────────────────

  if (editingPersona) {
    return (
      <div className="max-w-4xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setEditingPersona(null)}
              className="p-1 rounded hover:bg-surface-100 text-muted"
            >
              <X size={16} />
            </button>
            <div>
              <h2 className="text-sm font-medium text-[var(--text)]">
                {editingPersona.name}
              </h2>
              <p className="text-xs text-muted">{editingPersona.relativePath}</p>
            </div>
            <CategoryBadge category={editingPersona.category} />
          </div>
          <button
            onClick={handleSaveEditor}
            disabled={!editorDirty || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        {editorDirty && (
          <div className="flex items-center gap-2 px-3 py-2 rounded bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle size={12} className="text-amber-400" />
            <span className="text-xs text-amber-400">Unsaved changes</span>
          </div>
        )}

        {/* Monaco Editor */}
        <div className="border border-border rounded overflow-hidden">
          <Editor
            height="500px"
            language="markdown"
            theme="vs-dark"
            value={editorContent}
            onChange={(value) => {
              setEditorContent(value ?? '');
              setEditorDirty(true);
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              padding: { top: 12 },
            }}
          />
        </div>
      </div>
    );
  }

  // ─── List View ──────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--text)]">Agent Personas</h2>
          <p className="text-xs text-muted mt-0.5">
            Specialized agent identities for stories and review passes. Personas are markdown files in <code className="text-[11px] bg-surface-100 px-1 py-0.5 rounded">.rorca/personas/</code>.
          </p>
        </div>
        <button
          onClick={() => setShowAddDialog(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
        >
          <Plus size={12} />
          Add Persona
        </button>
      </div>

      {/* Category Filter */}
      <div className="flex items-center gap-2">
        <Filter size={12} className="text-muted" />
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value as PersonaCategory | 'all')}
          className="text-xs bg-bg border border-border rounded px-2 py-1 text-[var(--text)]"
        >
          <option value="all">All categories</option>
          {ALL_CATEGORIES.map(cat => (
            <option key={cat} value={cat}>{CATEGORY_META[cat].label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      ) : (
        <div className="space-y-3">
          {visibleCategories.map(cat => {
            const items = personas[cat] ?? [];
            const isCollapsed = collapsedCategories.has(cat);
            const meta = CATEGORY_META[cat];

            return (
              <div key={cat} className="border border-border rounded bg-bg">
                {/* Category header */}
                <button
                  onClick={() => toggleCategory(cat)}
                  className="w-full flex items-center justify-between px-3 py-2 hover:bg-surface-100 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {isCollapsed ? <ChevronRight size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
                    <span className={`text-xs font-semibold uppercase tracking-wider ${meta.color}`}>
                      {meta.label}
                    </span>
                    <span className="text-[10px] text-muted">({items.length})</span>
                  </div>
                </button>

                {/* Persona cards */}
                {!isCollapsed && (
                  <div className="border-t border-border divide-y divide-border">
                    {items.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-muted text-center">
                        No {meta.label.toLowerCase()} personas discovered
                      </div>
                    ) : (
                      items.map(persona => (
                        <PersonaCard
                          key={persona.name}
                          persona={persona}
                          onEdit={() => handleEditPersona(persona)}
                          onToggle={() => handleTogglePersona(persona)}
                          toggling={togglingName === persona.name}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Persona Dialog */}
      {showAddDialog && (
        <AddPersonaDialog
          name={newName}
          description={newDescription}
          category={newCategory}
          creating={creating}
          onNameChange={setNewName}
          onDescriptionChange={setNewDescription}
          onCategoryChange={setNewCategory}
          onClose={() => setShowAddDialog(false)}
          onCreate={handleCreatePersona}
        />
      )}
    </div>
  );
}

// ─── Sub-Components ─────────────────────────────────────────────────────────

function CategoryBadge({ category }: { category: PersonaCategory }) {
  const meta = CATEGORY_META[category];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.bg} ${meta.color} border ${meta.border}`}>
      {meta.label}
    </span>
  );
}

function PersonaCard({
  persona,
  onEdit,
  onToggle,
  toggling,
}: {
  persona: PersonaEntry;
  onEdit: () => void;
  onToggle: () => void;
  toggling: boolean;
}) {
  return (
    <div className={`px-3 py-2.5 flex items-start gap-3 group ${!persona.enabled ? 'opacity-50' : ''}`}>
      {/* Toggle */}
      <button
        onClick={e => { e.stopPropagation(); onToggle(); }}
        disabled={toggling}
        className="mt-0.5 shrink-0"
        title={persona.enabled ? 'Disable persona' : 'Enable persona'}
      >
        <div className={`w-7 h-4 rounded-full relative transition-colors ${persona.enabled ? 'bg-accent' : 'bg-surface-200'}`}>
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-switch-knob transition-transform ${persona.enabled ? 'left-3.5' : 'left-0.5'}`} />
        </div>
      </button>

      {/* Content — clickable to edit */}
      <button
        onClick={onEdit}
        className="flex-1 text-left min-w-0"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text)] truncate">{persona.name}</span>
          <CategoryBadge category={persona.category} />
        </div>
        <p className="text-xs text-muted mt-0.5 line-clamp-2">{persona.description}</p>
        {persona.triggers.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {persona.triggers.map((t, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-surface-100 text-muted border border-border">
                <FileText size={9} />
                {t}
              </span>
            ))}
          </div>
        )}
      </button>
    </div>
  );
}

function AddPersonaDialog({
  name,
  description,
  category,
  creating,
  onNameChange,
  onDescriptionChange,
  onCategoryChange,
  onClose,
  onCreate,
}: {
  name: string;
  description: string;
  category: PersonaCategory;
  creating: boolean;
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onCategoryChange: (v: PersonaCategory) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-panel border border-border rounded-lg shadow-lg w-full max-w-md p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text)]">New Persona</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-100 text-muted">
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => onNameChange(e.target.value)}
              placeholder="e.g. frontend, security, qa"
              className="w-full px-2.5 py-1.5 text-sm bg-bg border border-border rounded text-[var(--text)] placeholder:text-muted/50 focus:outline-none focus:border-accent"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={e => onDescriptionChange(e.target.value)}
              placeholder="Brief description of this persona's role"
              className="w-full px-2.5 py-1.5 text-sm bg-bg border border-border rounded text-[var(--text)] placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">Category</label>
            <select
              value={category}
              onChange={e => onCategoryChange(e.target.value as PersonaCategory)}
              className="w-full px-2.5 py-1.5 text-sm bg-bg border border-border rounded text-[var(--text)] focus:outline-none focus:border-accent"
            >
              {ALL_CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{CATEGORY_META[cat].label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium rounded border border-border text-muted hover:bg-surface-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onCreate}
            disabled={!name.trim() || creating}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
