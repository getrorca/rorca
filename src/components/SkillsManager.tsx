/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SkillsManager.tsx — CIE-013: Full management of .rorca/skills/ skill files.
 *
 * Features:
 * - Lists all .rorca/skills/*.md files with name, word count, assigned scopes/tags
 * - Create new skill: name input + template selector
 * - Edit skill: opens inline editor (Monaco)
 * - Delete skill: warns if assigned to active scope/tag rules
 * - Skill usage indicator: injection count from recent runs
 * - Import skill from URL
 * - Export skill as .md file
 * - Skill preview: render Markdown alongside editor
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import {
  FileText, Save, Loader2, Check, Plus, Trash2, X,
  Download, Upload, Eye, EyeOff, Tag, FolderTree,
  AlertTriangle, BarChart2, ExternalLink,
  FilePlus,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { renderMarkdown } from '../lib/renderMarkdown';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SkillFile {
  filename: string;
  name: string;
  description: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface SkillAssignment {
  scopes: string[];
  tags: string[];
}

interface SkillTemplate {
  id: string;
  label: string;
}

interface Props {
  workspaceId: string;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function SkillsManager({ workspaceId, showToast }: Props) {
  const [skills, setSkills] = useState<SkillFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<SkillFile | null>(null);

  // Editor state
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [fileLoading, setFileLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Assignments & usage
  const [assignments, setAssignments] = useState<Record<string, SkillAssignment>>({});
  const [usage, setUsage] = useState<Record<string, number>>({});

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('blank');
  const [templates, setTemplates] = useState<SkillTemplate[]>([]);
  const [creating, setCreating] = useState(false);

  // Import dialog
  const [showImport, setShowImport] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importFilename, setImportFilename] = useState('');
  const [importing, setImporting] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<SkillFile | null>(null);
  const [deleteWarnings, setDeleteWarnings] = useState<{ activeScopes: string[]; activeTags: string[] } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const editorRef = useRef<unknown>(null);
  const isDirty = content !== originalContent;

  // ─── Load Skills ──────────────────────────────────────────────────

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const [skillsData, assignData, usageData] = await Promise.all([
        apiFetch<{ skills: SkillFile[] }>(`/api/workspaces/${workspaceId}/skills`),
        apiFetch<{ assignments: Record<string, SkillAssignment> }>(`/api/workspaces/${workspaceId}/context-files/skill-assignments`),
        apiFetch<{ usage: Record<string, number> }>(`/api/workspaces/${workspaceId}/context-files/skill-usage?runs=10`),
      ]);
      setSkills(skillsData.skills);
      setAssignments(assignData.assignments);
      setUsage(usageData.usage);
    } catch {
      showToast('Failed to load skills', 'error');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, showToast]);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  // ─── Load Templates ───────────────────────────────────────────────

  useEffect(() => {
    apiFetch<{ templates: SkillTemplate[] }>(`/api/workspaces/${workspaceId}/context-files/skill-templates`)
      .then(data => setTemplates(data.templates))
      .catch(() => { /* use defaults */ });
  }, [workspaceId]);

  // ─── Open Skill ───────────────────────────────────────────────────

  const openSkill = useCallback(async (skill: SkillFile) => {
    setFileLoading(true);
    setSelectedSkill(skill);
    setShowPreview(false);
    try {
      const data = await apiFetch<{ content: string; wordCount: number; estimatedTokens: number }>(
        `/api/workspaces/${workspaceId}/context-files/read?filePath=${encodeURIComponent(`.rorca/skills/${skill.filename}`)}`
      );
      setContent(data.content);
      setOriginalContent(data.content);
      setWordCount(data.wordCount);
      setTokenCount(data.estimatedTokens);
    } catch {
      showToast(`Failed to read ${skill.filename}`, 'error');
      setSelectedSkill(null);
    } finally {
      setFileLoading(false);
    }
  }, [workspaceId, showToast]);

  // ─── Save ─────────────────────────────────────────────────────────

  const saveFile = useCallback(async () => {
    if (!selectedSkill || saving) return;
    setSaving(true);
    setSaveState('saving');
    try {
      const data = await apiFetch<{ saved: boolean; wordCount: number; estimatedTokens: number }>(
        `/api/workspaces/${workspaceId}/context-files/write`,
        { method: 'PUT', body: JSON.stringify({ filePath: `.rorca/skills/${selectedSkill.filename}`, content }) }
      );
      setOriginalContent(content);
      setWordCount(data.wordCount);
      setTokenCount(data.estimatedTokens);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 1500);
      showToast(`Saved ${selectedSkill.filename}`, 'success');
      loadSkills();
    } catch {
      showToast(`Failed to save ${selectedSkill.filename}`, 'error');
      setSaveState('idle');
    } finally {
      setSaving(false);
    }
  }, [selectedSkill, saving, workspaceId, content, showToast, loadSkills]);

  // ─── ⌘S keyboard shortcut ────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && selectedSkill) {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveFile, selectedSkill]);

  // ─── Create Skill ────────────────────────────────────────────────

  const createSkill = useCallback(async () => {
    if (!newSkillName.trim() || creating) return;
    setCreating(true);
    try {
      await apiFetch<{ created: boolean; relativePath: string }>(
        `/api/workspaces/${workspaceId}/context-files/create-skill`,
        { method: 'POST', body: JSON.stringify({ filename: newSkillName.trim(), template: selectedTemplate }) }
      );
      showToast(`Created ${newSkillName.trim()}.md`, 'success');
      setShowCreate(false);
      setNewSkillName('');
      setSelectedTemplate('blank');
      await loadSkills();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create skill';
      showToast(msg, 'error');
    } finally {
      setCreating(false);
    }
  }, [newSkillName, creating, workspaceId, selectedTemplate, showToast, loadSkills]);

  // ─── Delete Skill ────────────────────────────────────────────────

  const confirmDelete = useCallback((skill: SkillFile) => {
    const relPath = `.rorca/skills/${skill.filename}`;
    const assign = assignments[relPath];
    if (assign && (assign.scopes.length > 0 || assign.tags.length > 0)) {
      setDeleteWarnings({ activeScopes: assign.scopes, activeTags: assign.tags });
    } else {
      setDeleteWarnings(null);
    }
    setDeleteTarget(skill);
  }, [assignments]);

  const executeDelete = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await apiFetch(
        `/api/workspaces/${workspaceId}/context-files/delete-skill`,
        { method: 'DELETE', body: JSON.stringify({ filename: deleteTarget.name }) }
      );
      showToast(`Deleted ${deleteTarget.filename}`, 'success');
      if (selectedSkill?.filename === deleteTarget.filename) {
        setSelectedSkill(null);
        setContent('');
        setOriginalContent('');
      }
      setDeleteTarget(null);
      setDeleteWarnings(null);
      await loadSkills();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete skill';
      showToast(msg, 'error');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, workspaceId, showToast, selectedSkill, loadSkills]);

  // ─── Import from URL ─────────────────────────────────────────────

  const importSkill = useCallback(async () => {
    if (!importUrl.trim() || !importFilename.trim() || importing) return;
    setImporting(true);
    try {
      await apiFetch<{ created: boolean }>(
        `/api/workspaces/${workspaceId}/context-files/import-skill`,
        { method: 'POST', body: JSON.stringify({ url: importUrl.trim(), filename: importFilename.trim() }) }
      );
      showToast(`Imported ${importFilename.trim()}.md`, 'success');
      setShowImport(false);
      setImportUrl('');
      setImportFilename('');
      await loadSkills();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to import skill';
      showToast(msg, 'error');
    } finally {
      setImporting(false);
    }
  }, [importUrl, importFilename, importing, workspaceId, showToast, loadSkills]);

  // ─── Export Skill ────────────────────────────────────────────────

  const exportSkill = useCallback((skill: SkillFile) => {
    const url = `/api/workspaces/${workspaceId}/context-files/export-skill?filename=${encodeURIComponent(skill.name)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = skill.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [workspaceId]);

  // ─── Editor change ───────────────────────────────────────────────

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value === undefined) return;
    setContent(value);
    setWordCount(value.split(/\s+/).filter((w: string) => w.length > 0).length);
    setTokenCount(Math.ceil(value.length / 4));
  }, []);

  // ─── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ height: 'calc(100vh - 220px)' }}>
      <div className="flex gap-4 min-h-0 flex-1">
        {/* ─── Skill List Sidebar ─────────────────────────────────── */}
        <div className="w-64 shrink-0 border border-border rounded bg-panel flex flex-col min-h-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-muted uppercase tracking-wider">Skills</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowImport(true)}
                className="p-1 rounded hover:bg-bg text-muted hover:text-accent transition-colors"
                title="Import from URL"
              >
                <Upload size={14} />
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="p-1 rounded hover:bg-bg text-muted hover:text-accent transition-colors"
                title="New skill file"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-1">
            {skills.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted text-center px-4">
                <FileText size={24} className="opacity-40 mb-2" />
                <p className="text-xs">No skill files yet.</p>
                <p className="text-xs mt-1">Create one to define agent behavior for specific domains.</p>
              </div>
            ) : (
              skills.map(skill => {
                const relPath = `.rorca/skills/${skill.filename}`;
                const assign = assignments[relPath];
                const usageCount = usage[relPath] ?? 0;
                const isSelected = selectedSkill?.filename === skill.filename;

                return (
                  <div
                    key={skill.filename}
                    className={`group flex flex-col gap-1 px-2 py-2 rounded cursor-pointer transition-colors ${
                      isSelected ? 'bg-accent/10' : 'hover:bg-bg'
                    }`}
                    onClick={() => openSkill(skill)}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <FileText size={13} className={`shrink-0 ${isSelected ? 'text-accent' : 'text-muted'}`} />
                        <span className={`text-xs font-mono truncate ${isSelected ? 'text-accent' : 'text-[var(--text)]'}`}>
                          {skill.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); exportSkill(skill); }}
                          className="p-0.5 rounded text-muted hover:text-accent transition-colors"
                          title="Export"
                        >
                          <Download size={11} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); confirmDelete(skill); }}
                          className="p-0.5 rounded text-muted hover:text-red-500 transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>

                    {/* Metadata row */}
                    <div className="flex items-center gap-1.5 pl-5">
                      <span className="text-[10px] text-muted">
                        {Math.ceil(skill.sizeBytes / 4).toLocaleString()}w
                      </span>
                      {usageCount > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400" title={`Injected in ${usageCount} stories (last 10 runs)`}>
                          <BarChart2 size={9} />
                          {usageCount}
                        </span>
                      )}
                      {assign && assign.scopes.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-blue-400" title={`Scopes: ${assign.scopes.join(', ')}`}>
                          <FolderTree size={9} />
                          {assign.scopes.length}
                        </span>
                      )}
                      {assign && assign.tags.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-purple-400" title={`Tags: ${assign.tags.join(', ')}`}>
                          <Tag size={9} />
                          {assign.tags.length}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ─── Editor / Preview Area ───────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 border border-border rounded bg-panel">
          {!selectedSkill ? (
            <div className="flex-1 flex items-center justify-center text-muted text-sm">
              <div className="text-center space-y-2">
                <FilePlus size={32} className="mx-auto opacity-40" />
                <p>Select a skill to edit</p>
                <p className="text-xs">Or create a new one from a template</p>
              </div>
            </div>
          ) : fileLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin text-muted" />
            </div>
          ) : (
            <>
              {/* Editor header */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-mono text-[var(--text)] truncate">
                    {selectedSkill.filename}
                  </span>
                  {isDirty && (
                    <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                  )}
                  <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium border bg-green-500/15 text-green-400 border-green-500/20">
                    skill
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-muted">{wordCount.toLocaleString()} words</span>
                  <span className="text-xs text-muted">~{tokenCount.toLocaleString()} tokens</span>

                  {/* Preview toggle */}
                  <button
                    onClick={() => setShowPreview(!showPreview)}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                      showPreview
                        ? 'bg-accent/15 text-accent border border-accent/30'
                        : 'bg-bg text-muted hover:text-[var(--text)] border border-border'
                    }`}
                    title="Toggle preview"
                  >
                    {showPreview ? <EyeOff size={12} /> : <Eye size={12} />}
                    Preview
                  </button>

                  {/* Save */}
                  <button
                    onClick={saveFile}
                    disabled={!isDirty || saving}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                      isDirty
                        ? 'bg-accent text-white hover:bg-accent/90'
                        : 'bg-bg text-muted border border-border cursor-not-allowed'
                    }`}
                    title="Save (⌘S)"
                  >
                    {saveState === 'saving' ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : saveState === 'saved' ? (
                      <Check size={12} />
                    ) : (
                      <Save size={12} />
                    )}
                    {saveState === 'saved' ? 'Saved' : 'Save'}
                  </button>
                </div>
              </div>

              {/* Scope/Tag assignments banner */}
              {(() => {
                const relPath = `.rorca/skills/${selectedSkill.filename}`;
                const assign = assignments[relPath];
                const usageCount = usage[relPath] ?? 0;
                if (!assign && usageCount === 0) return null;
                return (
                  <div className="flex items-center gap-3 px-3 py-1.5 bg-bg/50 border-b border-border text-xs">
                    {assign && assign.scopes.length > 0 && (
                      <span className="flex items-center gap-1 text-blue-400">
                        <FolderTree size={11} />
                        Scopes: {assign.scopes.map(s => <code key={s} className="bg-blue-500/10 px-1 rounded ml-0.5">{s}</code>)}
                      </span>
                    )}
                    {assign && assign.tags.length > 0 && (
                      <span className="flex items-center gap-1 text-purple-400">
                        <Tag size={11} />
                        Tags: {assign.tags.map(t => <code key={t} className="bg-purple-500/10 px-1 rounded ml-0.5">{t}</code>)}
                      </span>
                    )}
                    {usageCount > 0 && (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <BarChart2 size={11} />
                        Injected {usageCount} times (last 10 runs)
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Editor + Preview split */}
              <div className="flex-1 flex min-h-0">
                {/* Editor pane */}
                <div className={`${showPreview ? 'w-1/2 border-r border-border' : 'flex-1'} min-h-0`}>
                  <Editor
                    value={content}
                    language="markdown"
                    theme="vs-dark"
                    onChange={handleEditorChange}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbers: 'on',
                      wordWrap: 'on',
                      scrollBeyondLastLine: false,
                      tabSize: 2,
                      renderLineHighlight: 'line',
                      overviewRulerLanes: 0,
                      hideCursorInOverviewRuler: true,
                      padding: { top: 8, bottom: 8 },
                    }}
                    onMount={(editor) => { editorRef.current = editor; }}
                  />
                </div>

                {/* Preview pane */}
                {showPreview && (
                  <div className="w-1/2 overflow-y-auto p-4 skill-preview">
                    <div
                      className="prose prose-invert prose-sm max-w-none"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ─── Create Skill Dialog ──────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-panel border border-border rounded-lg p-4 w-[420px] shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
                <FilePlus size={16} />
                New Skill File
              </h3>
              <button onClick={() => { setShowCreate(false); setNewSkillName(''); }} className="text-muted hover:text-[var(--text)]">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-muted mb-3">
              Creates <code className="bg-bg px-1 py-0.5 rounded font-mono">.rorca/skills/&lt;name&gt;.md</code> with starter content.
            </p>

            {/* Name input */}
            <div className="mb-3">
              <label className="block text-xs text-muted mb-1">Skill Name</label>
              <input
                value={newSkillName}
                onChange={e => setNewSkillName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createSkill(); }}
                placeholder="my-skill-name"
                autoFocus
                className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
              />
            </div>

            {/* Template selector */}
            <div className="mb-3">
              <label className="block text-xs text-muted mb-1">Template</label>
              <div className="grid grid-cols-3 gap-1.5">
                {templates.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTemplate(t.id)}
                    className={`px-2 py-1.5 text-xs rounded border transition-colors ${
                      selectedTemplate === t.id
                        ? 'bg-accent/10 border-accent text-accent'
                        : 'border-border text-muted hover:text-[var(--text)] hover:border-accent/50'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowCreate(false); setNewSkillName(''); }}
                className="px-3 py-1.5 text-xs text-muted hover:text-[var(--text)] rounded border border-border"
              >
                Cancel
              </button>
              <button
                onClick={createSkill}
                disabled={!newSkillName.trim() || creating}
                className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50"
              >
                {creating ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Import Dialog ───────────────────────────────────────── */}
      {showImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-panel border border-border rounded-lg p-4 w-[420px] shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
                <ExternalLink size={16} />
                Import Skill from URL
              </h3>
              <button onClick={() => { setShowImport(false); setImportUrl(''); setImportFilename(''); }} className="text-muted hover:text-[var(--text)]">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-muted mb-3">
              Fetches a Markdown file from a URL and saves it as a skill.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-muted mb-1">URL</label>
                <input
                  value={importUrl}
                  onChange={e => setImportUrl(e.target.value)}
                  placeholder="https://raw.githubusercontent.com/.../skill.md"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Save As</label>
                <input
                  value={importFilename}
                  onChange={e => setImportFilename(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') importSkill(); }}
                  placeholder="imported-skill"
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowImport(false); setImportUrl(''); setImportFilename(''); }}
                className="px-3 py-1.5 text-xs text-muted hover:text-[var(--text)] rounded border border-border"
              >
                Cancel
              </button>
              <button
                onClick={importSkill}
                disabled={!importUrl.trim() || !importFilename.trim() || importing}
                className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50"
              >
                {importing ? <Loader2 size={12} className="animate-spin" /> : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Delete Confirmation Dialog ──────────────────────────── */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-panel border border-border rounded-lg p-4 w-96 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
                <Trash2 size={16} className="text-red-500" />
                Delete Skill
              </h3>
              <button onClick={() => { setDeleteTarget(null); setDeleteWarnings(null); }} className="text-muted hover:text-[var(--text)]">
                <X size={16} />
              </button>
            </div>

            <p className="text-sm text-[var(--text)] mb-2">
              Delete <code className="bg-bg px-1 py-0.5 rounded font-mono">{deleteTarget.filename}</code>?
            </p>

            {deleteWarnings && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded p-2.5 mb-3">
                <div className="flex items-start gap-2 text-xs text-amber-400">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium mb-1">This skill is actively assigned:</p>
                    {deleteWarnings.activeScopes.length > 0 && (
                      <p>Scopes: {deleteWarnings.activeScopes.map(s => <code key={s} className="bg-amber-500/10 px-1 rounded ml-0.5">{s}</code>)}</p>
                    )}
                    {deleteWarnings.activeTags.length > 0 && (
                      <p className="mt-0.5">Tags: {deleteWarnings.activeTags.map(t => <code key={t} className="bg-amber-500/10 px-1 rounded ml-0.5">{t}</code>)}</p>
                    )}
                    <p className="mt-1">Update routing config after deletion to remove broken references.</p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setDeleteTarget(null); setDeleteWarnings(null); }}
                className="px-3 py-1.5 text-xs text-muted hover:text-[var(--text)] rounded border border-border"
              >
                Cancel
              </button>
              <button
                onClick={executeDelete}
                disabled={deleting}
                className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
