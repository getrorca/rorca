/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useCallback, useEffect } from 'react';
import { Check, X, Sparkles, Loader2, Eye, EyeOff, Plus, Trash2, Timer } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import type { Story } from './StoryCard';

interface InlineStoryEditorProps {
  story: Story;
  specId: string;
  workspaceId: string;
  onSave: (updated: Story) => void;
  onCancel: () => void;
  /** Use PATCH (pending-only) instead of PUT. Default: false (PUT). */
  usePatch?: boolean;
  /** Called when the user has unsaved edits (true) or reverts to saved state (false). */
  onDirtyChange?: (dirty: boolean) => void;
}

export function InlineStoryEditor({
  story,
  specId,
  workspaceId,
  onSave,
  onCancel,
  usePatch = false,
  onDirtyChange,
}: InlineStoryEditorProps) {
  const [title, setTitle] = useState(story.title);
  const [description, setDescription] = useState(story.description ?? '');
  const [criteria, setCriteria] = useState<string[]>([...story.acceptanceCriteria]);
  const [complexity, setComplexity] = useState<number | undefined>(story.complexity);
  const [timeoutMinutes, setTimeoutMinutes] = useState<number>(story.timeoutMinutes ?? 45);
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [showInstructions, setShowInstructions] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');

  // Track dirty state for unsaved changes confirmation
  const isDirty = title !== story.title
    || description !== (story.description ?? '')
    || JSON.stringify(criteria.filter(c => c.trim())) !== JSON.stringify(story.acceptanceCriteria);

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      const body = usePatch
        ? { workspaceId, title, description, acceptanceCriteria: criteria.filter(c => c.trim()) }
        : {
            workspaceId,
            title,
            description,
            acceptanceCriteria: criteria.filter(c => c.trim()),
            ...(complexity != null ? { complexity } : {}),
            timeoutMinutes,
          };
      const res = await apiFetch<{ ok: boolean; story: Story; version: number }>(
        `/api/specs/${specId}/stories/${story.id}`,
        {
          method: usePatch ? 'PATCH' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (res.ok) {
        onSave(res.story);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [specId, story.id, workspaceId, title, description, criteria, complexity, timeoutMinutes, usePatch, onSave]);

  const handleRewrite = useCallback(async () => {
    setRewriting(true);
    setError('');
    try {
      const res = await apiFetch<{
        ok: boolean;
        rewritten: { title: string; description: string; acceptanceCriteria: string[] };
      }>(
        `/api/specs/${specId}/stories/${story.id}/rewrite`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            instructions: instructions || undefined,
          }),
        }
      );
      if (res.ok) {
        setTitle(res.rewritten.title);
        setDescription(res.rewritten.description);
        setCriteria(res.rewritten.acceptanceCriteria);
        setShowInstructions(false);
        setInstructions('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rewrite failed');
    } finally {
      setRewriting(false);
    }
  }, [specId, story.id, workspaceId, instructions]);

  const updateCriterion = (index: number, value: string) => {
    setCriteria(prev => prev.map((c, i) => i === index ? value : c));
  };

  const removeCriterion = (index: number) => {
    setCriteria(prev => prev.filter((_, i) => i !== index));
  };

  const addCriterion = () => {
    setCriteria(prev => [...prev, '']);
  };

  return (
    <div className="border border-accent/40 rounded bg-panel p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-accent/15 text-accent">
          {story.id}
        </span>
        <span className="text-[10px] text-muted">Editing story</span>
      </div>

      {/* Title */}
      <div>
        <label className="text-xs font-medium text-muted block mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="w-full px-2 py-1.5 text-sm rounded border border-border bg-bg text-text focus:outline-none focus:border-accent"
        />
      </div>

      {/* Description with Markdown preview toggle */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-muted">Description</label>
          <button
            onClick={() => setPreview(!preview)}
            className="flex items-center gap-1 text-[10px] text-muted hover:text-text transition-colors"
          >
            {preview ? <EyeOff size={10} /> : <Eye size={10} />}
            {preview ? 'Edit' : 'Preview'}
          </button>
        </div>
        {preview ? (
          <div
            className="w-full px-2 py-1.5 text-sm rounded border border-border bg-bg text-text min-h-[80px] prose prose-sm prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: simpleMarkdown(description) }}
          />
        ) : (
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={4}
            className="w-full px-2 py-1.5 text-sm rounded border border-border bg-bg text-text resize-none focus:outline-none focus:border-accent font-mono"
            placeholder="Story description (Markdown supported)"
          />
        )}
      </div>

      {/* Acceptance Criteria */}
      <div>
        <label className="text-xs font-medium text-muted block mb-1">
          Acceptance Criteria ({criteria.filter(c => c.trim()).length})
        </label>
        <div className="space-y-1.5">
          {criteria.map((ac, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className="shrink-0 mt-2 text-[10px] text-muted font-mono">{i + 1}.</span>
              <input
                type="text"
                value={ac}
                onChange={e => updateCriterion(i, e.target.value)}
                className="flex-1 px-2 py-1 text-xs rounded border border-border bg-bg text-text focus:outline-none focus:border-accent"
              />
              <button
                onClick={() => removeCriterion(i)}
                className="shrink-0 mt-0.5 p-1 text-muted/40 hover:text-error transition-colors"
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={addCriterion}
            className="flex items-center gap-1 text-xs text-muted hover:text-accent transition-colors"
          >
            <Plus size={12} />
            Add criterion
          </button>
        </div>
      </div>

      {/* Complexity */}
      <div>
        <label className="text-xs font-medium text-muted block mb-1">Complexity (1-5)</label>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map(v => (
            <button
              key={v}
              onClick={() => setComplexity(v)}
              className={`w-8 h-8 rounded text-xs font-semibold transition-colors ${
                complexity === v
                  ? v <= 2 ? 'bg-success/20 text-success border border-success/40'
                    : v === 3 ? 'bg-warning/20 text-warning border border-warning/40'
                    : 'bg-error/20 text-error border border-error/40'
                  : 'bg-panel border border-border text-muted hover:text-text'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Timeout */}
      <div>
        <label className="text-xs font-medium text-muted flex items-center gap-1 mb-1">
          <Timer size={11} />
          Timeout (minutes)
        </label>
        <input
          type="number"
          min={5}
          max={240}
          value={timeoutMinutes}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v)) setTimeoutMinutes(Math.max(5, Math.min(240, v)));
          }}
          className="w-24 px-2 py-1.5 text-sm rounded border border-border bg-bg text-text focus:outline-none focus:border-accent"
        />
        <span className="ml-2 text-[10px] text-muted">5–240 min (default 90)</span>
      </div>

      {/* AI Rewrite section */}
      <div className="border-t border-border pt-3">
        {showInstructions ? (
          <div className="space-y-2">
            <textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={2}
              placeholder="Describe how to rewrite this story..."
              className="w-full px-2 py-1.5 text-xs rounded border border-border bg-bg text-text resize-none focus:outline-none focus:border-accent placeholder:text-muted"
            />
            <div className="flex gap-2">
              <button
                onClick={handleRewrite}
                disabled={rewriting}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {rewriting ? (
                  <><Loader2 size={12} className="animate-spin" /> Rewriting...</>
                ) : (
                  <><Sparkles size={12} /> Rewrite</>
                )}
              </button>
              <button
                onClick={() => { setShowInstructions(false); setInstructions(''); }}
                className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowInstructions(true)}
            disabled={rewriting}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-accent transition-colors"
          >
            <Sparkles size={12} />
            Rewrite with AI
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-xs text-error">{error}</p>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving || rewriting || !title.trim()}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-success text-white hover:opacity-90 transition-opacity disabled:opacity-60"
        >
          {saving ? (
            <><Loader2 size={12} className="animate-spin" /> Saving...</>
          ) : (
            <><Check size={12} /> Save Changes</>
          )}
        </button>
        <button
          onClick={onCancel}
          disabled={saving || rewriting}
          className="px-4 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text transition-colors disabled:opacity-60"
        >
          <X size={12} className="inline mr-1" />
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Minimal Markdown→HTML for preview (bold, italic, code, lists, links) */
function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 bg-panel rounded text-xs">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-accent underline" target="_blank" rel="noopener">$1</a>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/\n/g, '<br />');
}
