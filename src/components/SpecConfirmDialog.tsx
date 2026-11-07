/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, XCircle, Play, Hammer } from 'lucide-react';
import { modLabel } from '../hooks/useHotkeys';
import { useFocusTrap } from '../hooks/useFocusTrap';

/* ─── Types ───────────────────────────────────────────────────────── */

type DialogMode = 'approve' | 'reject' | 'post-approve';

interface SpecConfirmDialogProps {
  mode: DialogMode;
  specName: string;
  loading?: boolean;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
  /** Post-approve: navigate to forge */
  onGoToForge?: () => void;
  /** Post-approve: trigger pipeline run */
  onTriggerRun?: () => void;
}

/* ─── Component ───────────────────────────────────────────────────── */

export function SpecConfirmDialog({
  mode,
  specName,
  loading,
  onConfirm,
  onCancel,
  onGoToForge,
  onTriggerRun,
}: SpecConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true, undefined, { onEscape: onCancel });
  const mod = modLabel();

  // Focus textarea on reject mode
  useEffect(() => {
    if (mode === 'reject' && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [mode]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (mode === 'approve' && e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
      // Confirm reject with Enter (when not in textarea, or Cmd+Enter in textarea)
      if (mode === 'reject' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onConfirm(reason);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, onConfirm, reason]);

  return (
    <div
      ref={trapRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="spec-confirm-title"
    >
      <div
        className="bg-bg border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Approve confirmation ──────────────────────────────── */}
        {mode === 'approve' && (
          <>
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-success/15 flex items-center justify-center">
                  <CheckCircle2 size={20} className="text-success" />
                </div>
                <div>
                  <h3 id="spec-confirm-title" className="text-base font-semibold text-text">Approve Spec</h3>
                  <p className="text-xs text-muted">Move to approved/ directory</p>
                </div>
              </div>
              <p className="text-sm text-muted">
                Approve <span className="font-mono text-text">{specName}</span>? This
                will move it to the approved directory, ready for pipeline execution.
              </p>
            </div>
            <div className="px-6 pb-6 flex items-center gap-2">
              <button
                onClick={() => onConfirm()}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors disabled:opacity-50"
              >
                <CheckCircle2 size={14} />
                Approve
                <kbd className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded bg-[var(--kbd-bg)] font-mono">
                  ↵
                </kbd>
              </button>
              <button
                onClick={onCancel}
                className="px-4 py-2.5 rounded-lg text-sm font-medium text-muted border border-border hover:text-text transition-colors"
              >
                Cancel
                <kbd className="ml-1.5 px-1 py-0.5 text-[10px] rounded bg-panel border border-border font-mono">
                  esc
                </kbd>
              </button>
            </div>
          </>
        )}

        {/* ─── Reject confirmation ───────────────────────────────── */}
        {mode === 'reject' && (
          <>
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-error/15 flex items-center justify-center">
                  <XCircle size={20} className="text-error" />
                </div>
                <div>
                  <h3 id="spec-confirm-title" className="text-base font-semibold text-text">Reject Spec</h3>
                  <p className="text-xs text-muted">Delete and record rejection</p>
                </div>
              </div>
              <p className="text-sm text-muted mb-3">
                Reject <span className="font-mono text-text">{specName}</span>? This
                will delete the spec and record the rejection in the audit log.
              </p>
              <textarea
                ref={textareaRef}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for rejection (optional)"
                className="w-full px-3 py-2 text-sm bg-panel border border-border rounded-lg text-text placeholder:text-muted/50 resize-none focus:outline-none focus:border-accent"
                rows={3}
              />
            </div>
            <div className="px-6 pb-6 flex items-center gap-2">
              <button
                onClick={() => onConfirm(reason)}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium bg-error text-white hover:bg-error/90 transition-colors disabled:opacity-50"
              >
                <XCircle size={14} />
                Reject
                <kbd className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded bg-[var(--kbd-bg)] font-mono">
                  {mod}↵
                </kbd>
              </button>
              <button
                onClick={onCancel}
                className="px-4 py-2.5 rounded-lg text-sm font-medium text-muted border border-border hover:text-text transition-colors"
              >
                Cancel
                <kbd className="ml-1.5 px-1 py-0.5 text-[10px] rounded bg-panel border border-border font-mono">
                  esc
                </kbd>
              </button>
            </div>
          </>
        )}

        {/* ─── Post-approve prompt ───────────────────────────────── */}
        {mode === 'post-approve' && (
          <>
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-success/15 flex items-center justify-center">
                  <CheckCircle2 size={20} className="text-success" />
                </div>
                <div>
                  <h3 id="spec-confirm-title" className="text-base font-semibold text-text">Spec Approved</h3>
                  <p className="text-xs text-muted">
                    <span className="font-mono">{specName}</span> is ready
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted">What would you like to do next?</p>
            </div>
            <div className="px-6 pb-6 flex flex-col gap-2">
              <button
                onClick={onTriggerRun}
                className="flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
              >
                <Play size={14} />
                Trigger Pipeline Run
              </button>
              <button
                onClick={onGoToForge}
                className="flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium text-text border border-border hover:bg-panel transition-colors"
              >
                <Hammer size={14} />
                Go to Forge
              </button>
              <button
                onClick={onCancel}
                className="py-2 text-xs text-muted hover:text-text transition-colors"
              >
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
