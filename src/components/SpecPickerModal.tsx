/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect } from 'react';
import { X, Search, FileText } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface ApprovedSpec {
  id: string;
  specName: string;
  storyCount: number;
  generatedAt: string;
  approvedAt?: string;
}

interface SpecPickerModalProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onSelect: (spec: ApprovedSpec) => void;
}

export default function SpecPickerModal({ workspaceId, open, onClose, onSelect }: SpecPickerModalProps) {
  const [specs, setSpecs] = useState<ApprovedSpec[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const trapRef = useFocusTrap<HTMLDivElement>(open, undefined, { onEscape: onClose });

  useEffect(() => {
    if (!open || !workspaceId) return;
    setLoading(true);
    apiFetch<{ items: ApprovedSpec[] }>(`/api/specs?workspaceId=${workspaceId}&status=approved`)
      .then((data) => setSpecs(data.items))
      .catch(() => setSpecs([]))
      .finally(() => setLoading(false));
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  if (!open) return null;

  const filtered = search
    ? specs.filter(
        (s) =>
          s.specName.toLowerCase().includes(search.toLowerCase()) ||
          s.id.toLowerCase().includes(search.toLowerCase()),
      )
    : specs;

  return (
    <div
      ref={trapRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="spec-picker-title"
    >
      <div className="absolute inset-0 bg-[var(--backdrop)]" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md max-h-[70vh] bg-[var(--bg)] border border-[var(--border)] rounded-lg shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h3 id="spec-picker-title" className="text-sm font-medium">Add Spec to Queue</h3>
          <button
            onClick={onClose}
            type="button"
            aria-label="Close spec picker"
            className="p-1 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-[var(--border)]">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search approved specs..."
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-[var(--surface)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-muted)]"
              autoFocus
            />
          </div>
        </div>

        {/* Spec list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-[var(--text-muted)] text-sm">
              Loading specs...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-[var(--text-muted)] text-sm">
              {specs.length === 0 ? 'No approved specs found' : 'No matches'}
            </div>
          ) : (
            filtered.map((spec) => (
              <button
                key={spec.id}
                onClick={() => onSelect(spec)}
                className="w-full text-left px-4 py-2.5 hover:bg-[var(--surface)] border-b border-[var(--border)] transition-colors"
              >
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0" />
                  <span className="text-sm font-medium truncate capitalize">
                    {spec.specName.replace(/-/g, ' ')}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 pl-5.5 text-xs text-[var(--text-muted)]">
                  <span>{spec.storyCount} stories</span>
                  {spec.approvedAt && (
                    <span>
                      Approved {new Date(spec.approvedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
