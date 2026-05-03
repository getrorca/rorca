/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useMemo } from 'react';
import { listTemplates, useTemplate } from '../api/templates';
import type { Template } from '../api/types';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface TemplatePickerModalProps {
  onClose: () => void;
  onSelect: (template: { brief: string; storyCount: number }) => void;
}

export default function TemplatePickerModal({ onClose, onSelect }: TemplatePickerModalProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    const controller = new AbortController();
    listTemplates({ signal: controller.signal })
      .then((res) => {
        setTemplates(res.items ?? []);
        setLoading(false);
      })
      .catch((_err) => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return templates;
    const q = search.toLowerCase();
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q),
    );
  }, [templates, search]);

  const handleSelect = async (tpl: Template) => {
    // Track usage (useTemplate is an API function, not a React hook)
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useTemplate(tpl.id).catch(() => {});
    onSelect({ brief: tpl.brief ?? '', storyCount: tpl.storyCount });
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Start from template"
    >
      <div
        ref={trapRef}
        className="bg-panel border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text">Start from Template</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-text transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-border shrink-0">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates..."
            autoFocus
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors"
          />
        </div>

        {/* Template list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {/* Blank slate option — always first */}
          <button
            onClick={() => onSelect({ brief: '', storyCount: 8 })}
            className="w-full text-left px-4 py-3 rounded border border-border hover:border-accent/50 hover:bg-accent/5 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-muted group-hover:text-accent transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span className="text-sm font-medium text-text">Blank slate</span>
            </div>
            <p className="text-xs text-muted mt-1 ml-6">Start with an empty brief</p>
          </button>

          {loading ? (
            <div className="text-center py-8 text-muted text-sm">Loading templates...</div>
          ) : templates.length === 0 ? (
            <div className="text-center py-8 text-muted text-sm">
              No templates yet — generate a spec and save it as a template
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-muted text-sm">
              No templates match &ldquo;{search}&rdquo;
            </div>
          ) : (
            filtered.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => handleSelect(tpl)}
                className="w-full text-left px-4 py-3 rounded border border-border hover:border-accent/50 hover:bg-accent/5 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text">{tpl.name}</span>
                  <span className="text-xs text-muted shrink-0 ml-2">
                    {tpl.storyCount} {tpl.storyCount === 1 ? 'story' : 'stories'}
                  </span>
                </div>
                {tpl.description && (
                  <p className="text-xs text-muted mt-1 line-clamp-2">{tpl.description}</p>
                )}
                <div className="flex items-center gap-3 mt-2 text-[11px] text-muted/70">
                  {tpl.lastUsedAt && (
                    <span>Last used {relativeDate(tpl.lastUsedAt)}</span>
                  )}
                  {!tpl.lastUsedAt && tpl.createdAt && (
                    <span>Created {relativeDate(tpl.createdAt)}</span>
                  )}
                  {(tpl.usageCount ?? 0) > 0 && (
                    <span>Used {tpl.usageCount}x</span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-5 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-muted hover:text-text border border-border rounded hover:bg-panel transition-colors"
          >
            Cancel <kbd className="ml-1 text-[10px] bg-bg px-1 py-0.5 rounded">Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
