/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, type FormEvent } from 'react';
import { CheckCircle2, Cloud, Database, Server, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { graphModeLabel } from './GraphCapabilityNotice';
import {
  defaultDatabaseSetupGuidance,
  getDatabaseModeGuide,
  type DatabaseSetupGuidance,
  type DbMode,
} from '../lib/databaseSetup';

interface AddWorkspaceModalProps {
  onClose: () => void;
  onSuccess: (workspace: { id: string; name: string; git_path: string; needsBootstrap?: boolean }) => void;
}

interface HealthResponse {
  databaseSetup?: DatabaseSetupGuidance;
  databaseCapability?: {
    dbMode: DbMode;
  };
}

const MODE_ICON: Record<DbMode, typeof Server> = {
  native: Server,
  docker: Database,
  byop: Cloud,
};

export default function AddWorkspaceModal({ onClose, onSuccess }: AddWorkspaceModalProps) {
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [domains, setDomains] = useState('');
  const [dbMode, setDbMode] = useState<DbMode>('native');
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [databaseSetup, setDatabaseSetup] = useState<DatabaseSetupGuidance>(defaultDatabaseSetupGuidance);
  const [modeTouched, setModeTouched] = useState(false);
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

  useEffect(() => {
    apiFetch<HealthResponse>('/api/health', { silent: true })
      .then((data) => {
        const setup = data.databaseSetup ?? defaultDatabaseSetupGuidance;
        setDatabaseSetup(setup);
        if (!modeTouched) {
          setDbMode(data.databaseSetup?.selectedMode ?? data.databaseCapability?.dbMode ?? setup.selectedMode);
        }
      })
      .catch(() => {
        // Keep fallback guidance for first-run/offline states.
      });
  }, [modeTouched]);

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!label.trim()) errs.label = 'Label is required';
    else if (label.length > 64) errs.label = 'Label must be 64 characters or fewer';
    if (!path.trim()) errs.path = 'Path is required';
    else if (!path.startsWith('/')) errs.path = 'Path must be an absolute path (start with /)';
    if (dbMode === 'byop' && !databaseUrl.trim()) errs.databaseUrl = 'DATABASE_URL is required for BYOP mode';
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
          body: JSON.stringify({
            id,
            label: label.trim(),
            path: path.trim(),
            domains: domainList,
            dbMode,
            databaseUrl: dbMode === 'byop' ? databaseUrl.trim() : undefined,
          }),
        },
      );
      onSuccess({ id: res.workspace.id, name: res.workspace.label, git_path: res.workspace.path, needsBootstrap: res.needsBootstrap });
    } catch (err: any) {
      const msg = err.message || 'Failed to create workspace';
      if (msg.includes('Path does not exist')) {
        setErrors({ path: 'Path does not exist on filesystem' });
      } else if (msg.includes('already exists')) {
        setErrors({ label: 'A workspace with this name already exists' });
      } else if (msg.toLowerCase().includes('database_url') || msg.toLowerCase().includes('postgres') || msg.toLowerCase().includes('pgvector')) {
        setErrors({ databaseUrl: msg });
      } else {
        setErrors({ label: msg });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const selectedGuide = getDatabaseModeGuide(databaseSetup, dbMode);

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
        className="bg-panel border border-border rounded-lg shadow-xl w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-1">Add Workspace</h2>
        <p className="text-sm text-muted mb-4">
          Choose how Rorca should talk to Postgres before onboarding runs any bootstrap or BYOP validation.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="rounded-lg border border-accent/20 bg-accent/5 p-4 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-medium text-primary">1. Choose your database mode</p>
                <p className="text-xs text-muted mt-1">{databaseSetup.selectionNote}</p>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2.5 py-1 text-[11px] font-medium text-muted">
                <ShieldCheck className="h-3.5 w-3.5 text-accent" />
                {databaseSetup.validationFlow}
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {databaseSetup.modes.map((option) => {
                const Icon = MODE_ICON[option.mode];
                const selected = dbMode === option.mode;
                return (
                  <button
                    key={option.mode}
                    type="button"
                    onClick={() => {
                      setDbMode(option.mode);
                      setModeTouched(true);
                      setErrors((current) => ({ ...current, databaseUrl: '' }));
                    }}
                    className={`rounded-lg border p-4 text-left transition-colors ${selected ? 'border-accent bg-accent/10' : 'border-border bg-bg hover:border-accent/40'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-primary">
                        <Icon className="h-4 w-4" />
                      </div>
                      {selected && <CheckCircle2 className="h-4 w-4 text-accent shrink-0" />}
                    </div>
                    <p className="mt-3 text-sm font-semibold text-primary">{option.label}</p>
                    <p className="mt-1 text-xs text-muted">{option.summary}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${option.graphExpectation === 'full' ? 'bg-success/10 text-success border border-success/20' : 'bg-warning/10 text-warning border border-warning/20'}`}>
                        {graphModeLabel(option.graphExpectation)} expected
                      </span>
                      {databaseSetup.selectedMode === option.mode && (
                        <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
                          Current default
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.4fr,1fr]">
              <div className="rounded-lg border border-border bg-bg p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-sm font-medium text-primary">{selectedGuide.label}</p>
                    <p className="text-xs text-muted mt-1">{selectedGuide.graphSummary}</p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${selectedGuide.graphExpectation === 'full' ? 'bg-success/10 text-success border border-success/20' : 'bg-warning/10 text-warning border border-warning/20'}`}>
                    {graphModeLabel(selectedGuide.graphExpectation)}
                  </span>
                </div>
                <ol className="mt-3 space-y-2 text-xs text-muted list-decimal pl-4">
                  {selectedGuide.startupGuide.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Tradeoffs</p>
                    <ul className="mt-1 space-y-1 text-xs text-muted">
                      {selectedGuide.tradeoffs.map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Best for</p>
                    <ul className="mt-1 space-y-1 text-xs text-muted">
                      {selectedGuide.bestFor.map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-bg p-4">
                <p className="text-sm font-medium text-primary">Full Graph vs Graph Lite</p>
                <div className="mt-3 space-y-3">
                  {databaseSetup.graphModes.map((entry) => (
                    <div key={entry.mode} className="rounded-lg border border-border bg-surface p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-primary">{entry.label}</p>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${entry.mode === 'full' ? 'bg-success/10 text-success border border-success/20' : 'bg-warning/10 text-warning border border-warning/20'}`}>
                          {entry.mode === 'full' ? 'AGE required' : 'Fallback mode'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted">{entry.summary}</p>
                      <ul className="mt-2 space-y-1 text-xs text-muted">
                        {entry.tradeoffs.map((item) => (
                          <li key={item}>• {item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
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
          </div>

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

          {dbMode === 'byop' && (
            <div className="rounded-lg border border-border bg-bg p-4">
              <label htmlFor="ws-database-url" className="block text-sm font-medium mb-1">
                Secure DATABASE_URL input
              </label>
              <textarea
                id="ws-database-url"
                value={databaseUrl}
                onChange={(e) => setDatabaseUrl(e.target.value)}
                placeholder="postgres://postgres:password@db.example.supabase.co:5432/postgres?sslmode=require"
                rows={4}
                spellCheck={false}
                autoComplete="off"
                className="w-full px-3 py-2 rounded border border-border bg-surface text-sm font-mono focus:border-accent resize-y"
              />
              <p className="text-xs text-muted mt-2">{databaseSetup.byop.secretSafeInput}</p>
              <p className="text-xs text-muted mt-1">
                Validation on save: {databaseSetup.byop.validationChecks.join(' · ')}
              </p>
              <p className="text-xs text-muted mt-1">
                Common providers: {databaseSetup.byop.examples.join(', ')}
              </p>
              {errors.databaseUrl && <p className="text-red-500 text-xs mt-2">{errors.databaseUrl}</p>}
            </div>
          )}

          <div className="rounded-lg border border-border bg-bg px-4 py-3 text-xs text-muted">
            Rorca will not start hidden local DB bootstrap or hosted connection validation until you submit this form.
          </div>

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
