/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ContextFilesEditor.tsx — CIE-011: Full editor for context/intent files.
 *
 * Features:
 * - File list: CLAUDE.md, AGENTS.md, all skill files, MEMORY.md
 * - Monaco editor inline (Markdown syntax)
 * - Word count + estimated token count in editor header
 * - Diff view toggle (git diff vs last committed version)
 * - Managed-by badges: rorca (warning banner), manual (free edit), hybrid (diff accept/reject)
 * - Save writes to filesystem (triggers chokidar echo suppression)
 * - Unsaved changes indicator + ⌘S keyboard shortcut
 * - New skill file creation with template
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import {
  FileText, Save, Loader2, Check, Plus, AlertTriangle,
  GitCompare, X, FilePlus,
  Shield, Pencil, RefreshCw,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ContextFile {
  relativePath: string;
  role: string;
  managed: 'rorca' | 'manual' | 'hybrid';
  exists: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
}

interface FileContent {
  content: string;
  wordCount: number;
  estimatedTokens: number;
  sizeBytes: number;
  modifiedAt: string;
}

interface DiffData {
  diff: string;
  committedContent: string | null;
  hasChanges: boolean;
  isTracked: boolean;
}

interface Props {
  workspaceId: string;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

// ─── Managed Badge ──────────────────────────────────────────────────────────

function ManagedBadge({ managed }: { managed: string }) {
  switch (managed) {
    case 'rorca':
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
          <Shield size={10} />
          Managed
        </span>
      );
    case 'hybrid':
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/20">
          <RefreshCw size={10} />
          Hybrid
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
          <Pencil size={10} />
          Manual
        </span>
      );
  }
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    context: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
    governance: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
    memory: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20',
    skill: 'bg-green-500/15 text-green-400 border-green-500/20',
    template: 'bg-pink-500/15 text-pink-400 border-pink-500/20',
  };
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium border ${colors[role] ?? 'bg-gray-500/15 text-gray-400 border-gray-500/20'}`}>
      {role}
    </span>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function ContextFilesEditor({ workspaceId, showToast }: Props) {
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<ContextFile | null>(null);

  // Editor state
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [fileLoading, setFileLoading] = useState(false);

  // Diff state
  const [showDiff, setShowDiff] = useState(false);
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // New skill dialog
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [creating, setCreating] = useState(false);
  const newSkillDialogRef = useFocusTrap<HTMLDivElement>(showNewSkill, undefined, {
    onEscape: creating ? undefined : () => {
      setShowNewSkill(false);
      setNewSkillName('');
    },
  });

  const editorRef = useRef<unknown>(null);

  const isDirty = content !== originalContent;

  // ─── Load file list ─────────────────────────────────────────────────

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ files: ContextFile[] }>(
        `/api/workspaces/${workspaceId}/context-files`
      );
      setFiles(data.files);
    } catch {
      showToast('Failed to load context files', 'error');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, showToast]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // ─── Load file content ──────────────────────────────────────────────

  const openFile = useCallback(async (file: ContextFile) => {
    if (!file.exists) {
      showToast(`${file.relativePath} does not exist yet`, 'error');
      return;
    }
    setFileLoading(true);
    setSelectedFile(file);
    setShowDiff(false);
    setDiffData(null);
    try {
      const data = await apiFetch<FileContent>(
        `/api/workspaces/${workspaceId}/context-files/read?filePath=${encodeURIComponent(file.relativePath)}`
      );
      setContent(data.content);
      setOriginalContent(data.content);
      setWordCount(data.wordCount);
      setTokenCount(data.estimatedTokens);
    } catch {
      showToast(`Failed to read ${file.relativePath}`, 'error');
      setSelectedFile(null);
    } finally {
      setFileLoading(false);
    }
  }, [workspaceId, showToast]);

  // ─── Save ───────────────────────────────────────────────────────────

  const saveFile = useCallback(async () => {
    if (!selectedFile || saving) return;
    setSaving(true);
    setSaveState('saving');
    try {
      const data = await apiFetch<{ saved: boolean; wordCount: number; estimatedTokens: number }>(
        `/api/workspaces/${workspaceId}/context-files/write`,
        { method: 'PUT', body: JSON.stringify({ filePath: selectedFile.relativePath, content }) }
      );
      setOriginalContent(content);
      setWordCount(data.wordCount);
      setTokenCount(data.estimatedTokens);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 1500);
      showToast(`Saved ${selectedFile.relativePath}`, 'success');
      // Refresh file list to update sizes
      loadFiles();
    } catch {
      showToast(`Failed to save ${selectedFile.relativePath}`, 'error');
      setSaveState('idle');
    } finally {
      setSaving(false);
    }
  }, [selectedFile, saving, workspaceId, content, showToast, loadFiles]);

  // ─── ⌘S keyboard shortcut ──────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && selectedFile) {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveFile, selectedFile]);

  // ─── Diff toggle ───────────────────────────────────────────────────

  const toggleDiff = useCallback(async () => {
    if (!selectedFile) return;
    if (showDiff) {
      setShowDiff(false);
      return;
    }
    setDiffLoading(true);
    try {
      const data = await apiFetch<DiffData>(
        `/api/workspaces/${workspaceId}/context-files/diff?filePath=${encodeURIComponent(selectedFile.relativePath)}`
      );
      setDiffData(data);
      setShowDiff(true);
    } catch {
      showToast('Failed to load diff', 'error');
    } finally {
      setDiffLoading(false);
    }
  }, [selectedFile, showDiff, workspaceId, showToast]);

  // ─── Create skill ─────────────────────────────────────────────────

  const createSkill = useCallback(async () => {
    if (!newSkillName.trim() || creating) return;
    setCreating(true);
    try {
      await apiFetch<{ created: boolean; relativePath: string }>(
        `/api/workspaces/${workspaceId}/context-files/create-skill`,
        { method: 'POST', body: JSON.stringify({ filename: newSkillName.trim() }) }
      );
      showToast(`Created .rorca/skills/${newSkillName.trim()}.md`, 'success');
      setShowNewSkill(false);
      setNewSkillName('');
      await loadFiles();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create skill file';
      showToast(msg, 'error');
    } finally {
      setCreating(false);
    }
  }, [newSkillName, creating, workspaceId, showToast, loadFiles]);

  // ─── Editor change handler ────────────────────────────────────────

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value === undefined) return;
    setContent(value);
    // Estimate counts inline
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
    <div className="flex flex-col h-full min-h-0" style={{ height: 'calc(100vh - 180px)' }}>
      <div className="flex gap-4 min-h-0 flex-1">
        {/* ─── File List Sidebar ─────────────────────────────────── */}
        <div className="w-56 shrink-0 border border-border rounded bg-panel flex flex-col min-h-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-muted uppercase tracking-wider">Files</span>
            <button
              onClick={() => setShowNewSkill(true)}
              className="p-1 rounded hover:bg-bg text-muted hover:text-accent transition-colors"
              title="New skill file"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-1">
            {files.map(file => (
              <button
                key={file.relativePath}
                onClick={() => openFile(file)}
                className={`w-full flex items-start gap-2 px-2 py-1.5 rounded text-left transition-colors ${
                  selectedFile?.relativePath === file.relativePath
                    ? 'bg-accent/10 text-accent'
                    : file.exists
                      ? 'text-[var(--text)] hover:bg-bg'
                      : 'text-muted/50 cursor-not-allowed'
                }`}
                disabled={!file.exists}
              >
                <FileText size={14} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono truncate">{file.relativePath}</div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <ManagedBadge managed={file.managed} />
                    <RoleBadge role={file.role} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ─── Editor Area ───────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 border border-border rounded bg-panel">
          {!selectedFile ? (
            <div className="flex-1 flex items-center justify-center text-muted text-sm">
              <div className="text-center space-y-2">
                <FileText size={32} className="mx-auto opacity-40" />
                <p>Select a file to edit</p>
                <p className="text-xs">CLAUDE.md, AGENTS.md, skills, MEMORY.md</p>
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
                    {selectedFile.relativePath}
                  </span>
                  {isDirty && (
                    <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                  )}
                  <ManagedBadge managed={selectedFile.managed} />
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {/* Stats */}
                  <span className="text-xs text-muted">
                    {wordCount.toLocaleString()} words
                  </span>
                  <span className="text-xs text-muted">
                    ~{tokenCount.toLocaleString()} tokens
                  </span>

                  {/* Diff toggle */}
                  <button
                    onClick={toggleDiff}
                    disabled={diffLoading}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                      showDiff
                        ? 'bg-accent/15 text-accent border border-accent/30'
                        : 'bg-bg text-muted hover:text-[var(--text)] border border-border'
                    }`}
                    title="Toggle diff view"
                  >
                    {diffLoading ? <Loader2 size={12} className="animate-spin" /> : <GitCompare size={12} />}
                    Diff
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

              {/* Managed-by banner */}
              {selectedFile.managed === 'rorca' && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-400">
                  <AlertTriangle size={12} />
                  <span>Managed by Rorca — edits may be overwritten on next sync</span>
                </div>
              )}
              {selectedFile.managed === 'hybrid' && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 border-b border-blue-500/20 text-xs text-blue-400">
                  <RefreshCw size={12} />
                  <span>Hybrid — Rorca may propose changes. Review diffs before syncing.</span>
                </div>
              )}

              {/* Editor / Diff */}
              <div className="flex-1 min-h-0">
                {showDiff && diffData ? (
                  <DiffEditor
                    original={diffData.committedContent ?? ''}
                    modified={content}
                    language="markdown"
                    theme="vs-dark"
                    options={{
                      readOnly: false,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbers: 'on',
                      wordWrap: 'on',
                      scrollBeyondLastLine: false,
                    }}
                    onMount={(editor) => { editorRef.current = editor; }}
                  />
                ) : (
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
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ─── New Skill Dialog ─────────────────────────────────────── */}
      {showNewSkill && (
        <div className="fixed inset-0 bg-[var(--backdrop)] flex items-center justify-center z-50">
          <div ref={newSkillDialogRef} role="dialog" aria-modal="true" aria-labelledby="new-skill-title" className="bg-panel border border-border rounded-lg p-4 w-96 max-w-[calc(100%-2rem)] shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 id="new-skill-title" className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
                <FilePlus size={16} />
                New Skill File
              </h3>
              <button type="button" aria-label="Close new skill dialog" onClick={() => { setShowNewSkill(false); setNewSkillName(''); }} className="text-muted hover:text-[var(--text)]">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-muted mb-3">
              Creates <code className="bg-bg px-1 py-0.5 rounded font-mono">.rorca/skills/&lt;name&gt;.md</code> with a starter template.
            </p>
            <input
              value={newSkillName}
              onChange={e => setNewSkillName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createSkill(); }}
              placeholder="my-skill-name"
              autoFocus
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => { setShowNewSkill(false); setNewSkillName(''); }}
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
    </div>
  );
}
