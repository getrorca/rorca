/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { forgeSpecBatch, getForgeBatchStreamUrl } from '../api/specs';
import { titleToSlug, KEBAB_RE } from '../lib/slugify';

/* ─── Types ──────────────────────────────────────────────────────── */

interface BriefEntry {
  title: string;
  brief: string;
}

interface BatchItemStatus {
  index: number;
  status: 'queued' | 'generating' | 'completed' | 'failed';
  slug?: string;
  error?: string;
  title?: string;
}

interface BatchSnapshot {
  batchId: string;
  totalBriefs: number;
  items: BatchItemStatus[];
}

interface BatchSummary {
  completed: number;
  failed: number;
  total: number;
}

/* ─── Main Component ─────────────────────────────────────────────── */

export default function BatchForge() {
  const { workspaceId } = useWorkspace();

  // Brief entries
  const [entries, setEntries] = useState<BriefEntry[]>([{ title: '', brief: '' }]);
  const [parseError, setParseError] = useState<string | null>(null);

  // Batch state
  const [batchId, setBatchId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [items, setItems] = useState<BatchItemStatus[]>([]);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Bulk paste mode
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState('');

  const addEntry = useCallback(() => {
    setEntries(prev => [...prev, { title: '', brief: '' }]);
  }, []);

  const removeEntry = useCallback((index: number) => {
    setEntries(prev => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev);
  }, []);

  const updateEntry = useCallback((index: number, field: keyof BriefEntry, value: string) => {
    setEntries(prev => prev.map((e, i) => i === index ? { ...e, [field]: value } : e));
  }, []);

  const parseBulkText = useCallback(() => {
    setParseError(null);
    const text = bulkText.trim();
    if (!text) return;

    // Try JSON array first
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const valid = parsed.every((item: unknown) =>
          typeof item === 'object' && item !== null &&
          'title' in item && 'brief' in item &&
          typeof (item as BriefEntry).title === 'string' &&
          typeof (item as BriefEntry).brief === 'string'
        );
        if (valid) {
          setEntries(parsed.map((item: BriefEntry) => ({ title: item.title, brief: item.brief })));
          setBulkMode(false);
          return;
        }
      }
    } catch {
      // Not JSON — try line-based parsing
    }

    // Line-based: "title: brief" or "title | brief" per line
    const lines = text.split('\n').filter(l => l.trim());
    const parsed: BriefEntry[] = [];
    for (const line of lines) {
      const pipeMatch = line.match(/^(.+?)\s*\|\s*(.+)$/);
      const colonMatch = line.match(/^(.+?):\s*(.+)$/);
      const match = pipeMatch || colonMatch;
      if (match) {
        parsed.push({ title: match[1].trim(), brief: match[2].trim() });
      } else {
        setParseError(`Could not parse line: "${line.slice(0, 60)}...". Use "title | brief" or "title: brief" format, or paste a JSON array.`);
        return;
      }
    }
    if (parsed.length > 0) {
      setEntries(parsed);
      setBulkMode(false);
    }
  }, [bulkText]);

  const validEntries = entries.filter(e => e.title.trim() && e.brief.trim());
  const canSubmit = validEntries.length > 0 && !!workspaceId && !isSubmitting && !batchId;

  // Validate titles are kebab-case compatible
  const titleErrors = entries.map(e => {
    if (!e.title.trim()) return '';
    const slug = titleToSlug(e.title);
    if (!slug || !KEBAB_RE.test(slug)) return 'Title must produce a valid kebab-case slug';
    return '';
  });

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setSubmitError(null);
    setSummary(null);
    setItems([]);

    try {
      const preferredModel = (() => {
        try {
          const saved = localStorage.getItem('rorca:forge:model')?.trim();
          return saved || undefined;
        } catch {
          return undefined;
        }
      })();
      const preferredReasoning = (() => {
        if (!preferredModel) return undefined;
        try {
          const raw = localStorage.getItem(`rorca:reasoning:${preferredModel}`);
          if (!raw) return undefined;
          const parsed = JSON.parse(raw) as { enabled?: boolean; effort?: string };
          return parsed.enabled ? { enabled: true, ...(parsed.effort ? { effort: parsed.effort } : {}) } : undefined;
        } catch {
          return undefined;
        }
      })();

      const result = await forgeSpecBatch(
        validEntries.map(e => ({
          title: e.title.trim(),
          brief: e.brief.trim(),
          workspaceId,
          ...(preferredModel ? { model: preferredModel } : {}),
          ...(preferredReasoning ? { reasoning: preferredReasoning } : {}),
          postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
        })),
      );
      setBatchId(result.batchId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmitError(`Batch submission failed: ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Connect to SSE stream when batchId is set
  useEffect(() => {
    if (!batchId) return;

    const es = new EventSource(getForgeBatchStreamUrl(batchId));
    eventSourceRef.current = es;

    es.addEventListener('snapshot', (e) => {
      const data: BatchSnapshot = JSON.parse(e.data);
      setItems(data.items);
    });

    es.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data) as {
        briefIndex: number;
        status: string;
        slug?: string;
        error?: string;
      };
      setItems(prev => prev.map((item, i) =>
        i === data.briefIndex
          ? { ...item, status: data.status as BatchItemStatus['status'], slug: data.slug, error: data.error }
          : item
      ));
    });

    es.addEventListener('done', (e) => {
      const data = JSON.parse(e.data) as { summary: BatchSummary };
      setSummary(data.summary);
      es.close();
    });

    es.onerror = () => {
      // EventSource auto-reconnects; if batch is done it'll get a 404 and stop
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [batchId]);

  const handleReset = () => {
    setBatchId(null);
    setItems([]);
    setSummary(null);
    setSubmitError(null);
    setEntries([{ title: '', brief: '' }]);
  };

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        Select a workspace to use Batch Forge.
      </div>
    );
  }

  return (
    <div role="main" aria-label="Batch forge panel - generate multiple specs at once" className="flex flex-col md:flex-row h-full gap-px bg-border overflow-auto md:overflow-hidden">
      {/* Left pane: Brief entry form */}
      <div className="flex-1 flex flex-col bg-bg min-w-0">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto px-4 sm:px-6 py-6 space-y-6">

            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
                Briefs ({validEntries.length} valid)
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setBulkMode(!bulkMode)}
                  className="text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  {bulkMode ? 'Form mode' : 'Bulk paste'}
                </button>
                {!bulkMode && !batchId && (
                  <button
                    onClick={addEntry}
                    className="text-xs text-accent hover:text-accent-hover transition-colors"
                  >
                    + Add brief
                  </button>
                )}
              </div>
            </div>

            {bulkMode ? (
              <div className="space-y-3">
                <textarea
                  rows={12}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={'Paste briefs in one of these formats:\n\nJSON array:\n[{"title": "user-auth", "brief": "Build OAuth login..."}, ...]\n\nLine-based (title | brief):\nuser-auth | Build OAuth login flow\npayments | Integrate Stripe billing'}
                  className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-y font-mono"
                />
                {parseError && (
                  <div className="px-3 py-2 rounded border border-error/30 bg-error/5 text-xs text-error">
                    {parseError}
                  </div>
                )}
                <button
                  onClick={parseBulkText}
                  className="px-4 py-2 text-sm font-medium bg-accent text-white rounded hover:bg-accent-hover transition-colors"
                >
                  Parse briefs
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {entries.map((entry, i) => (
                  <div key={i} className="p-3 rounded border border-border bg-panel space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted">#{i + 1}</span>
                      {entries.length > 1 && !batchId && (
                        <button
                          onClick={() => removeEntry(i)}
                          aria-label={`Remove brief #${i + 1}`}
                          className="text-xs text-muted hover:text-error transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 rounded"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={entry.title}
                      onChange={(e) => updateEntry(i, 'title', e.target.value)}
                      placeholder="Spec title (kebab-case, e.g. user-auth-oauth)"
                      disabled={!!batchId}
                      className="w-full px-3 py-1.5 text-sm bg-bg border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent focus:ring-2 focus:ring-accent/50 transition-colors disabled:opacity-50"
                    />
                    {titleErrors[i] && (
                      <p className="text-xs text-error">{titleErrors[i]}</p>
                    )}
                    <textarea
                      rows={3}
                      value={entry.brief}
                      onChange={(e) => updateEntry(i, 'brief', e.target.value)}
                      placeholder="Describe what this spec builds..."
                      disabled={!!batchId}
                      className="w-full px-3 py-1.5 text-sm bg-bg border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-y font-mono disabled:opacity-50"
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Submit / Reset */}
            <div className="space-y-2">
              {!batchId ? (
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className={`w-full py-2.5 rounded text-sm font-medium transition-colors ${
                    canSubmit
                      ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
                      : 'bg-accent/30 text-white/40 cursor-not-allowed'
                  }`}
                >
                  {isSubmitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Submitting...
                    </span>
                  ) : (
                    `Generate ${validEntries.length} Spec${validEntries.length !== 1 ? 's' : ''}`
                  )}
                </button>
              ) : summary ? (
                <button
                  onClick={handleReset}
                  className="w-full py-2.5 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-border transition-colors"
                >
                  New Batch
                </button>
              ) : null}
              {submitError && (
                <div className="px-3 py-2 rounded border border-error/30 bg-error/5 text-xs text-error">
                  {submitError}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right pane: Progress */}
      <div aria-live="polite" className="flex-1 flex flex-col bg-bg min-w-0 border-t md:border-t-0">
        <BatchProgress items={items} summary={summary} entries={entries} />
      </div>
    </div>
  );
}

/* ─── Progress Panel ─────────────────────────────────────────────── */

function BatchProgress({
  items,
  summary,
  entries,
}: {
  items: BatchItemStatus[];
  summary: BatchSummary | null;
  entries: BriefEntry[];
}) {
  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        <div className="text-center space-y-2">
          <div className="text-2xl">&#9776;</div>
          <p>Add briefs on the left and click Generate.</p>
          <p className="text-xs text-muted/60">Each brief becomes its own spec with version history.</p>
        </div>
      </div>
    );
  }

  const completed = items.filter(i => i.status === 'completed').length;
  const failed = items.filter(i => i.status === 'failed').length;
  const generating = items.filter(i => i.status === 'generating').length;
  const total = items.length;

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            Progress
          </span>
          <span className="text-xs text-muted">
            {completed + failed} / {total}
            {summary && (
              <span className="ml-2">
                {summary.completed > 0 && <span className="text-green-400">{summary.completed} passed</span>}
                {summary.completed > 0 && summary.failed > 0 && <span className="text-muted"> / </span>}
                {summary.failed > 0 && <span className="text-error">{summary.failed} failed</span>}
              </span>
            )}
          </span>
        </div>
        {/* Progress bar */}
        <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
          <div className="h-full flex">
            {completed > 0 && (
              <div
                className="bg-green-500 transition-all duration-300"
                style={{ width: `${(completed / total) * 100}%` }}
              />
            )}
            {failed > 0 && (
              <div
                className="bg-error transition-all duration-300"
                style={{ width: `${(failed / total) * 100}%` }}
              />
            )}
            {generating > 0 && (
              <div
                className="bg-accent animate-pulse transition-all duration-300"
                style={{ width: `${(generating / total) * 100}%` }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Item list */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-3 space-y-2">
          {items.map((item, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 px-3 py-2 rounded border transition-colors ${
                item.status === 'completed' ? 'border-green-500/30 bg-green-500/5' :
                item.status === 'failed' ? 'border-error/30 bg-error/5' :
                item.status === 'generating' ? 'border-accent/30 bg-accent/5' :
                'border-border bg-panel'
              }`}
            >
              {/* Status icon */}
              <div className="shrink-0">
                {item.status === 'queued' && (
                  <div className="w-4 h-4 rounded-full border-2 border-muted/30" />
                )}
                {item.status === 'generating' && (
                  <svg className="w-4 h-4 animate-spin text-accent" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {item.status === 'completed' && (
                  <svg className="w-4 h-4 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {item.status === 'failed' && (
                  <svg className="w-4 h-4 text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text truncate">
                  {item.title || entries[i]?.title || `Brief #${i + 1}`}
                </div>
                {item.slug && (
                  <div className="text-xs text-muted truncate">{item.slug}</div>
                )}
                {item.error && (
                  <div className="text-xs text-error mt-0.5">{item.error}</div>
                )}
              </div>

              {/* Status badge */}
              <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                item.status === 'completed' ? 'bg-green-500/15 text-green-400' :
                item.status === 'failed' ? 'bg-error/15 text-error' :
                item.status === 'generating' ? 'bg-accent/15 text-accent' :
                'bg-muted/15 text-muted'
              }`}>
                {item.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
