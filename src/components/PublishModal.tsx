/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Loader2, Globe, ShieldCheck, Tag, Check, AlertCircle } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';

/* ─── Types ─────────────────────────────────────────────────────────── */

interface RedactionEntry {
  field: string;
  pattern: string;
  original_preview: string;
}

interface SanitizePreviewResult {
  sanitized: unknown;
  redactionCount: number;
  redactions: RedactionEntry[];
}

interface PublishResult {
  publicationId: string;
  redactionCount: number;
}

interface SpecDetail {
  [key: string]: unknown;
}

interface Props {
  specId: string;
  specName: string;
  workspaceId: string;
  specDetail: SpecDetail;
  onClose: () => void;
  onPublished: () => void;
}

/* ─── PublishModal ──────────────────────────────────────────────────── */

export default function PublishModal({
  specId,
  specName,
  workspaceId,
  specDetail,
  onClose,
  onPublished,
}: Props) {
  const toast = useGlobalToast();

  const [preview, setPreview] = useState<SanitizePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState('');

  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [description, setDescription] = useState('');

  const [publishState, setPublishState] = useState<'idle' | 'publishing' | 'done' | 'error'>('idle');
  const [publishError, setPublishError] = useState('');

  const tagInputRef = useRef<HTMLInputElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const publishBtnRef = useRef<HTMLButtonElement>(null);

  // Fetch sanitize preview on mount
  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError('');

    apiFetch<SanitizePreviewResult>('/api/marketplace/preview-sanitize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: specDetail }),
    })
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
          setPreviewLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreviewError(err instanceof Error ? err.message : 'Failed to preview sanitization');
          setPreviewLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [specDetail]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Focus first interactive element on mount
  useEffect(() => {
    tagInputRef.current?.focus();
  }, []);

  const handleAddTag = useCallback(() => {
    const trimmed = tagInput.trim().toLowerCase().replace(/\s+/g, '-');
    if (trimmed && !tags.includes(trimmed) && tags.length < 10) {
      setTags(prev => [...prev, trimmed]);
    }
    setTagInput('');
  }, [tagInput, tags]);

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAddTag();
    } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      setTags(prev => prev.slice(0, -1));
    }
  };

  const handleRemoveTag = (tag: string) => {
    setTags(prev => prev.filter(t => t !== tag));
  };

  const handlePublish = async () => {
    if (!preview) return;
    setPublishState('publishing');
    setPublishError('');
    try {
      await apiFetch<PublishResult>('/api/marketplace/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec_id: specId,
          workspace_id: workspaceId,
          description: description.trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
        }),
      });
      setPublishState('done');
      toast.show('Spec published to community', 'success');
      setTimeout(() => {
        onPublished();
        onClose();
      }, 800);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Failed to publish spec');
      setPublishState('error');
    }
  };

  const handlePublishKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && publishState === 'idle') {
      handlePublish();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-bg border border-border rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-accent" />
            <h2 id="publish-modal-title" className="text-sm font-semibold text-text">
              Publish to Community
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close publish modal"
            className="p-1 rounded text-muted hover:text-text hover:bg-panel transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Spec name */}
          <div>
            <p className="text-xs text-muted mb-1">Spec</p>
            <p className="text-sm font-mono text-text font-medium">{specName}</p>
          </div>

          {/* Sanitization preview */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <ShieldCheck size={13} className="text-accent" />
              <span className="text-xs font-medium text-text">Sanitization Preview</span>
            </div>

            {previewLoading && (
              <div className="flex items-center gap-2 py-3 text-xs text-muted">
                <Loader2 size={12} className="animate-spin" />
                Scanning for PII and secrets...
              </div>
            )}

            {previewError && (
              <div className="flex items-center gap-2 py-2 px-3 rounded border border-error/30 bg-error/10 text-xs text-error">
                <AlertCircle size={12} />
                {previewError}
              </div>
            )}

            {preview && !previewLoading && (
              <>
                {preview.redactionCount === 0 ? (
                  <div className="flex items-center gap-2 py-2 px-3 rounded border border-success/30 bg-success/10 text-xs text-success">
                    <Check size={12} />
                    No sensitive data found — spec is clean
                  </div>
                ) : (
                  <div className="rounded border border-warning/30 bg-warning/10 p-3 space-y-2">
                    <p className="text-xs font-medium text-warning">
                      {preview.redactionCount} item{preview.redactionCount !== 1 ? 's' : ''} will be scrubbed before publishing:
                    </p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {preview.redactions.map((r, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-muted font-mono">
                          <span className="shrink-0 px-1.5 py-0.5 rounded bg-warning/20 text-warning text-[10px]">
                            {r.pattern}
                          </span>
                          <span className="truncate">{r.field}</span>
                          <span className="shrink-0 text-muted/60">→ {r.original_preview}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Tags input */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Tag size={13} className="text-accent" />
              <label htmlFor="publish-tags" className="text-xs font-medium text-text">
                Tags <span className="text-muted font-normal">(optional, for discoverability)</span>
              </label>
            </div>
            <div className="flex flex-wrap gap-1 p-2 rounded border border-border bg-panel min-h-[36px] focus-within:border-accent/50 transition-colors">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent/15 text-accent border border-accent/20"
                >
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                    className="text-accent/70 hover:text-accent focus:outline-none"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                id="publish-tags"
                ref={tagInputRef}
                type="text"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={handleAddTag}
                placeholder={tags.length === 0 ? 'Type tag and press Enter...' : ''}
                className="flex-1 min-w-[120px] text-xs bg-transparent outline-none text-text placeholder:text-muted"
              />
            </div>
            <p className="text-[10px] text-muted mt-1">Press Enter or comma to add. Max 10 tags.</p>
          </div>

          {/* Description textarea */}
          <div>
            <label htmlFor="publish-description" className="text-xs font-medium text-text block mb-2">
              Description <span className="text-muted font-normal">(optional)</span>
            </label>
            <textarea
              id="publish-description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe what this spec builds and who it's useful for..."
              rows={3}
              className="w-full px-3 py-2 text-xs rounded border border-border bg-panel text-text resize-none placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>

          {/* Publish error */}
          {publishError && (
            <div className="flex items-center gap-2 py-2 px-3 rounded border border-error/30 bg-error/10 text-xs text-error">
              <AlertCircle size={12} />
              {publishError}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-4 border-t border-border shrink-0 flex gap-2">
          <button
            ref={publishBtnRef}
            onClick={handlePublish}
            onKeyDown={handlePublishKeyDown}
            disabled={publishState !== 'idle' || previewLoading || !!previewError}
            aria-label="Publish spec to community"
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            {publishState === 'publishing' ? (
              <><Loader2 size={14} className="animate-spin" /> Publishing...</>
            ) : publishState === 'done' ? (
              <><Check size={14} /> Published!</>
            ) : (
              <><Globe size={14} /> Publish</>
            )}
          </button>
          <button
            ref={cancelBtnRef}
            onClick={onClose}
            disabled={publishState === 'publishing'}
            className="px-4 py-2 rounded text-sm font-medium bg-panel border border-border text-muted hover:text-text transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
