/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, type FormEvent } from 'react';
import { apiFetch } from '../lib/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface AddWorkspaceModalProps {
  onClose: () => void;
  onSuccess: (workspace: { id: string; name: string; git_path: string; needsBootstrap?: boolean }) => void;
}

export default function AddWorkspaceModal({ onClose, onSuccess }: AddWorkspaceModalProps) {
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [domains, setDomains] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!label.trim()) errs.label = 'Label is required';
    else if (label.length > 64) errs.label = 'Label must be 64 characters or fewer';
    if (!path.trim()) errs.path = 'Path is required';
    else if (!path.startsWith('/')) errs.path = 'Path must be an absolute path (start with /)';
    return errs;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setSubmitting(true);

    const id = label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const domainList = domains
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    try {
      const res = await apiFetch<{ workspace: { id: string; label: string; path: string; domains: string[] }; needsBootstrap?: boolean }>(
        '/api/workspaces',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label: label.trim(), path: path.trim(), domains: domainList }),
        },
      );
      onSuccess({ id: res.workspace.id, name: res.workspace.label, git_path: res.workspace.path, needsBootstrap: res.needsBootstrap });
    } catch (err: any) {
      const msg = err.message || 'Failed to create workspace';
      if (msg.includes('Path does not exist')) {
        setErrors({ path: 'Path does not exist on filesystem' });
      } else if (msg.includes('already exists')) {
        setErrors({ label: 'A workspace with this name already exists' });
      } else {
        setErrors({ label: msg });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add workspace"
    >
      <div
        ref={trapRef}
        className="bg-panel border border-border rounded-lg shadow-xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">Add Workspace</h2>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Label */}
          <div>
            <label htmlFor="ws-label" className="block text-sm font-medium mb-1">
              Label
            </label>
            <input
              id="ws-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={64}
              placeholder="CashflowAI"
              className="w-full px-3 py-2 rounded border border-border bg-bg text-sm focus:border-accent"
            />
            {errors.label && <p className="text-red-500 text-xs mt-1">{errors.label}</p>}
          </div>

          {/* Path */}
          <div>
            <label htmlFor="ws-path" className="block text-sm font-medium mb-1">
              Path
            </label>
            <input
              id="ws-path"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/me/my-project"
              className="w-full px-3 py-2 rounded border border-border bg-bg text-sm font-mono focus:border-accent"
            />
            {errors.path && <p className="text-red-500 text-xs mt-1">{errors.path}</p>}
          </div>

          {/* Domains */}
          <div>
            <label htmlFor="ws-domains" className="block text-sm font-medium mb-1">
              Domains
            </label>
            <input
              id="ws-domains"
              type="text"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="fintech, react, typescript"
              className="w-full px-3 py-2 rounded border border-border bg-bg text-sm focus:border-accent"
            />
            <p className="text-xs text-muted mt-1">Comma-separated tags</p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded border border-border hover:bg-bg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
