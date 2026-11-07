/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { Bot, CheckCircle2, XCircle, Clock, AlertCircle, Plus, X, RefreshCw, ExternalLink } from 'lucide-react';
import { apiFetch } from '../../lib/apiFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { entityRoute } from '../../lib/entityRoutes';
import { MISSION_CONTRACT_VERSIONS } from '../../../shared/contracts/mission';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CiAutofixRun {
  id: number;
  headSha: string;
  branchName: string;
  checkRunName: string;
  annotationCount: number;
  agentType: string;
  status: 'triggered' | 'completed' | 'failed' | 'skipped';
  errorSummary: string | null;
  createdAt: string;
  finishedAt: string | null;
  runId: number | null;
}

interface CiAutofixConfig {
  enabled: boolean;
  checkPatterns: string[] | null;
  maxRetries: number;
  recentRuns: CiAutofixRun[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// ─── Run status badge ─────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CiAutofixRun['status'] }) {
  const map = {
    triggered: { icon: Clock, label: 'Running', cls: 'text-amber-400 bg-amber-400/10' },
    completed: { icon: CheckCircle2, label: 'Fixed', cls: 'text-green-400 bg-green-400/10' },
    failed: { icon: XCircle, label: 'Failed', cls: 'text-red-400 bg-red-400/10' },
    skipped: { icon: AlertCircle, label: 'Skipped', cls: 'text-muted bg-border/30' },
  };
  const { icon: Icon, label, cls } = map[status] ?? map.skipped;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}

// ─── Pattern chip ─────────────────────────────────────────────────────────────

function PatternChip({ value, onRemove }: { value: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/15 text-accent text-[12px] font-mono border border-accent/20">
      {value}
      <button
        type="button"
        onClick={onRemove}
        className="hover:text-red-400 transition-colors ml-0.5"
        aria-label={`Remove pattern ${value}`}
      >
        <X size={10} />
      </button>
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CiAutofixSettingsTab() {
  const { selectedWorkspace } = useWorkspace();
  const workspaceId = selectedWorkspace?.id;

  const [config, setConfig] = useState<CiAutofixConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Local editable state
  const [enabled, setEnabled] = useState(false);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [maxRetries, setMaxRetries] = useState(2);
  const [newPattern, setNewPattern] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<CiAutofixConfig>(`/api/workspaces/${workspaceId}/ci-autofix`);
      setConfig(data);
      setEnabled(data.enabled);
      setPatterns(data.checkPatterns ?? ['*']);
      setMaxRetries(data.maxRetries);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load CI autofix config');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/ci-autofix`, {
        method: 'PATCH',
        body: JSON.stringify({
          enabled,
          checkPatterns: patterns.length > 0 ? patterns : null,
          maxRetries,
        }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addPattern = () => {
    const val = newPattern.trim();
    if (!val || patterns.includes(val)) return;
    setPatterns(prev => [...prev, val]);
    setNewPattern('');
    setDirty(true);
  };

  const removePattern = (idx: number) => {
    setPatterns(prev => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted">
        <RefreshCw className="w-4 h-4 animate-spin mr-2" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div className="text-sm text-muted p-4">No workspace selected.</div>
    );
  }

  return (
    <div className="space-y-8 pb-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Bot size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-[var(--text)]">CI Autofix</h2>
        </div>
        <p className="text-sm text-muted leading-relaxed">
          Automatically fix CI failures. When a GitHub check run fails, Rorca generates a fix spec,
          runs it with your configured agent, and pushes the fix back to the source branch.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Enable toggle */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Status</h3>
        <label className="flex items-center justify-between p-4 rounded-lg border border-border bg-[var(--bg-subtle,var(--bg))] cursor-pointer hover:border-accent/30 transition-colors">
          <div>
            <div className="text-sm font-medium text-[var(--text)]">Enable CI Autofix</div>
            <div className="text-xs text-muted mt-0.5">
              Listens for <code className="font-mono bg-border/40 px-1 rounded">check_run</code> webhook events and triggers fix runs automatically
            </div>
          </div>
          <div className="relative flex items-center justify-center shrink-0 ml-4">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => { setEnabled(e.target.checked); setDirty(true); }}
              className="peer sr-only"
            />
            <div className="w-9 h-5 rounded-full bg-border peer-checked:bg-accent transition-colors" />
            <div className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
          </div>
        </label>

        {!enabled && config?.enabled === false && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-400/8 border border-amber-400/20 text-amber-400/90 text-xs">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            CI autofix is disabled. Enable it and make sure a GitHub webhook is configured to send <strong>check_run</strong> events to <code className="font-mono bg-black/20 px-1 rounded">/api/webhooks/github</code>.
          </div>
        )}
      </section>

      {/* Check patterns */}
      <section className="space-y-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Check Name Patterns</h3>
          <p className="text-xs text-muted mt-1">
            Glob patterns (micromatch) for which check run names trigger autofix. Use <code className="font-mono bg-border/40 px-1 rounded">*</code> to match all checks.
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5 min-h-[32px]">
          {patterns.map((p, i) => (
            <PatternChip key={i} value={p} onRemove={() => removePattern(i)} />
          ))}
          {patterns.length === 0 && (
            <span className="text-xs text-muted italic">No patterns — add one below (or use * for all)</span>
          )}
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addPattern()}
            placeholder="e.g.  typecheck  or  ci / *"
            className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-[var(--bg)] text-sm text-[var(--text)] placeholder:text-muted focus:outline-none focus:border-accent/60 font-mono"
          />
          <button
            type="button"
            onClick={addPattern}
            disabled={!newPattern.trim()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-sm text-muted hover:border-accent/40 hover:text-accent disabled:opacity-40 transition-colors"
          >
            <Plus size={13} />
            Add
          </button>
        </div>
      </section>

      {/* Max retries */}
      <section className="space-y-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Max Retries</h3>
          <p className="text-xs text-muted mt-1">
            How many autofix attempts per commit SHA before giving up. Prevents infinite fix loops.
          </p>
        </div>
        <div className="flex gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => { setMaxRetries(n); setDirty(true); }}
              className={`w-10 py-1.5 rounded text-sm font-medium border transition-colors ${
                maxRetries === n
                  ? 'bg-accent text-white border-accent'
                  : 'bg-[var(--bg)] text-muted border-border hover:border-accent/40 hover:text-[var(--text)]'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </section>

      {/* Save button */}
      {dirty && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60 transition-colors"
          >
            {saving && <RefreshCw size={13} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (config) {
                setEnabled(config.enabled);
                setPatterns(config.checkPatterns ?? ['*']);
                setMaxRetries(config.maxRetries);
                setDirty(false);
              }
            }}
            className="text-sm text-muted hover:text-[var(--text)] transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Webhook setup reminder */}
      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">GitHub Webhook</h3>
        <div className="p-4 rounded-lg border border-border bg-[var(--bg-subtle,var(--bg))] space-y-2 text-xs text-muted">
          <p>CI Autofix requires a GitHub webhook sending <strong className="text-[var(--text)]">check_run</strong> events:</p>
          <ol className="list-decimal list-inside space-y-1 ml-1">
            <li>Go to your GitHub repo → <strong className="text-[var(--text)]">Settings → Webhooks → Add webhook</strong></li>
            <li>Payload URL: <code className="font-mono bg-border/40 px-1 rounded text-[var(--text)]">http://your-rorca-host/api/webhooks/github</code></li>
            <li>Content type: <code className="font-mono bg-border/40 px-1 rounded">application/json</code></li>
            <li>Events: select <strong className="text-[var(--text)]">Check runs</strong></li>
          </ol>
          <a
            href="https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#check_run"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline mt-1"
          >
            GitHub webhook docs <ExternalLink size={11} />
          </a>
        </div>
      </section>

      {/* Recent runs */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Recent Autofix Runs</h3>
          <button
            type="button"
            onClick={load}
            className="text-muted hover:text-[var(--text)] transition-colors"
            aria-label="Refresh"
          >
            <RefreshCw size={13} />
          </button>
        </div>

        {config?.recentRuns.length === 0 ? (
          <div className="p-6 rounded-lg border border-border text-center text-sm text-muted">
            No autofix runs yet. Once CI checks start failing, Rorca will attempt fixes here.
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
            {config?.recentRuns.map((run) => (
              <div key={run.id} className="flex items-start gap-3 px-4 py-3 hover:bg-white/2 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-xs font-mono text-[var(--text)]">{shortSha(run.headSha)}</code>
                    <span className="text-xs text-muted truncate max-w-[160px]">{run.branchName}</span>
                    <StatusBadge status={run.status} />
                    <span className="text-[10px] text-muted/60 font-mono uppercase">{run.agentType}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted truncate">{run.checkRunName}</div>
                  {run.errorSummary && (
                    <div className="mt-1 text-[11px] text-red-400/80 line-clamp-1">{run.errorSummary}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-muted">{formatRelativeTime(run.createdAt)}</span>
                  {run.runId && (
                    <a
                      href={entityRoute({
                        schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
                        workspaceId,
                        kind: 'run',
                        id: String(run.runId),
                        label: `Run #${run.runId}`,
                      })}
                      className="text-[10px] text-accent hover:underline flex items-center gap-0.5"
                    >
                      Run <ExternalLink size={9} />
                    </a>
                  )}
                  <span className="text-[10px] text-muted/50">{run.annotationCount} error{run.annotationCount !== 1 ? 's' : ''}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
