/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Clock,
  ChevronRight,
  RotateCcw,
  Loader2,
  Check,
  AlertCircle,
  Plus,
  Minus,
  Edit3,
  Equal,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

/* ─── Types ───────────────────────────────────────────────────────── */

interface VersionInfo {
  version: number;
  status: string;
  rejectionReason?: string;
  createdAt: string;
  title: string;
  storyCount: number;
}

interface FieldDelta {
  field: string;
  old: unknown;
  new: unknown;
  added?: string[];
  removed?: string[];
}

interface StoryDiff {
  id: string;
  changeType: 'added' | 'removed' | 'modified' | 'unchanged';
  story?: { id: string; title: string; description: string; acceptanceCriteria: string[] };
  deltas?: FieldDelta[];
}

interface DiffResult {
  specSlug: string;
  v1: { version: number; status: string; createdAt: string };
  v2: { version: number; status: string; createdAt: string };
  diff: {
    titleChanged: boolean;
    oldTitle?: string;
    newTitle?: string;
    stories: StoryDiff[];
    summary: { added: number; removed: number; modified: number; unchanged: number };
  };
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-warning/15 text-warning border-warning/30',
  approved: 'bg-success/15 text-success border-success/30',
  rejected: 'bg-error/15 text-error border-error/30',
};

/* ─── Main Component ──────────────────────────────────────────────── */

export function SpecVersionHistory({
  specId,
  workspaceId,
}: {
  specId: string;
  workspaceId: string;
}) {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Diff state
  const [selectedV1, setSelectedV1] = useState<number | null>(null);
  const [selectedV2, setSelectedV2] = useState<number | null>(null);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Restore state
  const [restoring, setRestoring] = useState<number | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<number | null>(null);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<{ items: VersionInfo[]; total: number; hasMore: boolean; cursor?: string }>(
        `/api/specs/${specId}/versions?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      setVersions(res.items);
      // Auto-select latest two versions for diff
      if (res.items.length >= 2) {
        const sorted = [...res.items].sort((a, b) => b.version - a.version);
        setSelectedV1(sorted[1].version);
        setSelectedV2(sorted[0].version);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load versions');
    } finally {
      setLoading(false);
    }
  }, [specId, workspaceId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  // Fetch diff when both versions are selected
  useEffect(() => {
    if (selectedV1 == null || selectedV2 == null || selectedV1 === selectedV2) {
      setDiffResult(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    apiFetch<DiffResult>(`/api/specs/${specId}/diff?workspaceId=${encodeURIComponent(workspaceId)}&v1=${selectedV1}&v2=${selectedV2}`)
      .then(res => { if (!cancelled) setDiffResult(res); })
      .catch(() => { if (!cancelled) setDiffResult(null); })
      .finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [specId, workspaceId, selectedV1, selectedV2]);

  const handleRestore = async (version: number) => {
    setRestoring(version);
    try {
      await apiFetch(`/api/specs/${specId}/versions/${version}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setRestoreSuccess(version);
      setTimeout(() => setRestoreSuccess(null), 3000);
      // Refresh versions list
      await fetchVersions();
    } catch {
      // Silently handle — user can retry
    } finally {
      setRestoring(null);
    }
  };

  const handleSelectVersion = (version: number) => {
    if (selectedV1 == null) {
      setSelectedV1(version);
    } else if (selectedV2 == null) {
      // Ensure v1 < v2
      if (version < selectedV1) {
        setSelectedV2(selectedV1);
        setSelectedV1(version);
      } else {
        setSelectedV2(version);
      }
    } else {
      // Reset: start new selection
      setSelectedV1(version);
      setSelectedV2(null);
      setDiffResult(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted text-sm">
        <Loader2 size={16} className="animate-spin mr-2" />
        Loading version history...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-error mb-2">{error}</p>
          <button onClick={fetchVersions} className="text-xs text-accent hover:text-accent-hover transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted text-sm">
        <AlertCircle size={16} className="mr-2" />
        No version history available for this spec
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Version List */}
      <div className="p-4 space-y-2 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-text uppercase tracking-wide">
            Version History
          </h4>
          <span className="text-[10px] text-muted">{versions.length} versions</span>
        </div>
        <p className="text-[10px] text-muted mb-2">
          Click two versions to compare. The older version will be shown on the left.
        </p>

        <div className="space-y-1 max-h-48 overflow-y-auto">
          {[...versions].reverse().map(v => {
            const isSelected = v.version === selectedV1 || v.version === selectedV2;
            const isV1 = v.version === selectedV1;
            const isV2 = v.version === selectedV2;
            return (
              <div
                key={v.version}
                onClick={() => handleSelectVersion(v.version)}
                className={`flex items-center gap-3 px-3 py-2 rounded border cursor-pointer transition-colors ${
                  isSelected
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-accent/50 hover:bg-panel'
                }`}
              >
                {/* Version badge */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {isV1 && (
                    <span className="w-4 h-4 rounded-full bg-accent/20 text-accent text-[9px] font-bold flex items-center justify-center">
                      A
                    </span>
                  )}
                  {isV2 && (
                    <span className="w-4 h-4 rounded-full bg-accent text-white text-[9px] font-bold flex items-center justify-center">
                      B
                    </span>
                  )}
                  {!isSelected && <span className="w-4 h-4" />}
                  <span className="text-xs font-mono font-semibold text-text">v{v.version}</span>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 text-[9px] font-semibold rounded border ${STATUS_STYLES[v.status] ?? 'bg-muted/15 text-muted border-muted/30'}`}>
                      {v.status.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-muted">{v.storyCount} stories</span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Clock size={9} className="text-muted" />
                    <span className="text-[10px] text-muted">{formatDateTime(v.createdAt)}</span>
                  </div>
                </div>

                {/* Restore button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRestore(v.version);
                  }}
                  disabled={restoring != null}
                  className="shrink-0 p-1 rounded text-muted hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-50"
                  title={`Restore version ${v.version}`}
                >
                  {restoring === v.version ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : restoreSuccess === v.version ? (
                    <Check size={12} className="text-success" />
                  ) : (
                    <RotateCcw size={12} />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Diff View */}
      <div className="flex-1 overflow-y-auto">
        {selectedV1 != null && selectedV2 != null && selectedV1 !== selectedV2 ? (
          diffLoading ? (
            <div className="flex items-center justify-center h-48 text-muted text-sm">
              <Loader2 size={16} className="animate-spin mr-2" />
              Computing diff...
            </div>
          ) : diffResult ? (
            <DiffView diff={diffResult} />
          ) : (
            <div className="flex items-center justify-center h-48 text-muted text-sm">
              Failed to load diff
            </div>
          )
        ) : (
          <div className="flex items-center justify-center h-48 text-muted text-sm">
            <ChevronRight size={14} className="mr-1" />
            Select two versions above to compare
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Diff View ───────────────────────────────────────────────────── */

function DiffView({ diff }: { diff: DiffResult }) {
  const { v1, v2, diff: d } = diff;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 text-xs font-mono rounded bg-accent/20 text-accent">
            v{v1.version}
          </span>
          <ChevronRight size={12} className="text-muted" />
          <span className="px-2 py-0.5 text-xs font-mono rounded bg-accent text-white">
            v{v2.version}
          </span>
        </div>
        <DiffSummaryBadges summary={d.summary} />
      </div>

      {/* Title change */}
      {d.titleChanged && (
        <div className="rounded border border-warning/30 bg-warning/5 p-3">
          <p className="text-[10px] font-semibold text-warning uppercase tracking-wide mb-1">
            Spec Title Changed
          </p>
          <div className="flex flex-col gap-1">
            <div className="flex items-start gap-2">
              <Minus size={10} className="text-error mt-0.5 shrink-0" />
              <span className="text-xs text-error/80 line-through">{d.oldTitle}</span>
            </div>
            <div className="flex items-start gap-2">
              <Plus size={10} className="text-success mt-0.5 shrink-0" />
              <span className="text-xs text-success">{d.newTitle}</span>
            </div>
          </div>
        </div>
      )}

      {/* Story diffs */}
      <div className="space-y-2">
        {d.stories
          .filter(s => s.changeType !== 'unchanged')
          .map(story => (
            <StoryDiffCard key={story.id} story={story} />
          ))}

        {/* Unchanged count */}
        {d.summary.unchanged > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded border border-border bg-panel/50 text-muted">
            <Equal size={12} />
            <span className="text-xs">{d.summary.unchanged} unchanged {d.summary.unchanged === 1 ? 'story' : 'stories'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Summary Badges ──────────────────────────────────────────────── */

function DiffSummaryBadges({ summary }: { summary: { added: number; removed: number; modified: number; unchanged: number } }) {
  return (
    <div className="flex items-center gap-1.5">
      {summary.added > 0 && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-success/15 text-success border border-success/30">
          <Plus size={9} />
          {summary.added}
        </span>
      )}
      {summary.removed > 0 && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-error/15 text-error border border-error/30">
          <Minus size={9} />
          {summary.removed}
        </span>
      )}
      {summary.modified > 0 && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/15 text-warning border border-warning/30">
          <Edit3 size={9} />
          {summary.modified}
        </span>
      )}
    </div>
  );
}

/* ─── Story Diff Card ─────────────────────────────────────────────── */

function StoryDiffCard({ story }: { story: StoryDiff }) {
  const [expanded, setExpanded] = useState(story.changeType === 'modified');

  const borderClass =
    story.changeType === 'added' ? 'border-success/40 bg-success/5' :
    story.changeType === 'removed' ? 'border-error/40 bg-error/5' :
    story.changeType === 'modified' ? 'border-warning/40 bg-warning/5' :
    'border-border';

  const iconConfig =
    story.changeType === 'added' ? { icon: Plus, className: 'text-success' } :
    story.changeType === 'removed' ? { icon: Minus, className: 'text-error' } :
    story.changeType === 'modified' ? { icon: Edit3, className: 'text-warning' } :
    { icon: Equal, className: 'text-muted' };

  const Icon = iconConfig.icon;

  return (
    <div className={`rounded border ${borderClass} overflow-hidden`}>
      {/* Card header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <Icon size={12} className={iconConfig.className} />
        <span className="text-xs font-mono font-semibold text-text">{story.id}</span>
        {story.story && (
          <span className="text-xs text-muted truncate flex-1">{story.story.title}</span>
        )}
        <span className={`px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded ${
          story.changeType === 'added' ? 'bg-success/15 text-success' :
          story.changeType === 'removed' ? 'bg-error/15 text-error' :
          'bg-warning/15 text-warning'
        }`}>
          {story.changeType}
        </span>
        <ChevronRight
          size={12}
          className={`text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border/50">
          {/* Added story: show full content */}
          {story.changeType === 'added' && story.story && (
            <div className="mt-2 space-y-1.5">
              <p className="text-xs font-medium text-success">{story.story.title}</p>
              <p className="text-[11px] text-text/70">{story.story.description}</p>
              {story.story.acceptanceCriteria?.length > 0 && (
                <ul className="space-y-0.5 ml-3">
                  {story.story.acceptanceCriteria.map((ac, i) => (
                    <li key={i} className="text-[11px] text-success/80 list-disc">{ac}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Removed story: show full content */}
          {story.changeType === 'removed' && story.story && (
            <div className="mt-2 space-y-1.5">
              <p className="text-xs font-medium text-error line-through">{story.story.title}</p>
              <p className="text-[11px] text-text/50 line-through">{story.story.description}</p>
              {story.story.acceptanceCriteria?.length > 0 && (
                <ul className="space-y-0.5 ml-3">
                  {story.story.acceptanceCriteria.map((ac, i) => (
                    <li key={i} className="text-[11px] text-error/60 list-disc line-through">{ac}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Modified story: show per-field diffs */}
          {story.changeType === 'modified' && story.deltas && (
            <div className="mt-2 space-y-3">
              {story.deltas.map((delta, i) => (
                <FieldDeltaView key={i} delta={delta} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Field Delta View ────────────────────────────────────────────── */

function FieldDeltaView({ delta }: { delta: FieldDelta }) {
  const fieldLabel =
    delta.field === 'acceptanceCriteria' ? 'Acceptance Criteria' :
    delta.field === 'dependsOn' ? 'Dependencies' :
    delta.field.charAt(0).toUpperCase() + delta.field.slice(1);

  return (
    <div className="space-y-1">
      <p className="text-[10px] font-semibold text-warning uppercase tracking-wide">{fieldLabel}</p>

      {delta.field === 'acceptanceCriteria' ? (
        <AcceptanceCriteriaDiff delta={delta} />
      ) : delta.field === 'dependsOn' ? (
        <DependencyDiff delta={delta} />
      ) : (
        <TextDiff oldText={String(delta.old ?? '')} newText={String(delta.new ?? '')} />
      )}
    </div>
  );
}

/* ─── Text Diff (title, description) ─────────────────────────────── */

function TextDiff({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <div className="space-y-1 rounded bg-bg/50 p-2">
      <div className="flex items-start gap-2">
        <Minus size={10} className="text-error mt-0.5 shrink-0" />
        <span className="text-[11px] text-error/80 break-words">{highlightDiff(oldText, newText, 'old')}</span>
      </div>
      <div className="flex items-start gap-2">
        <Plus size={10} className="text-success mt-0.5 shrink-0" />
        <span className="text-[11px] text-success break-words">{highlightDiff(oldText, newText, 'new')}</span>
      </div>
    </div>
  );
}

/** Simple word-level diff highlighting */
function highlightDiff(oldText: string, newText: string, side: 'old' | 'new'): React.ReactNode {
  const oldWords = oldText.split(/\s+/);
  const newWords = newText.split(/\s+/);

  if (side === 'old') {
    const newSet = new Set(newWords);
    return oldWords.map((word, i) => {
      const changed = !newSet.has(word);
      return (
        <span key={i}>
          {i > 0 && ' '}
          {changed ? <mark className="bg-error/20 text-error rounded px-0.5">{word}</mark> : word}
        </span>
      );
    });
  } else {
    const oldSet = new Set(oldWords);
    return newWords.map((word, i) => {
      const changed = !oldSet.has(word);
      return (
        <span key={i}>
          {i > 0 && ' '}
          {changed ? <mark className="bg-success/20 text-success rounded px-0.5">{word}</mark> : word}
        </span>
      );
    });
  }
}

/* ─── Acceptance Criteria Diff ────────────────────────────────────── */

function AcceptanceCriteriaDiff({ delta }: { delta: FieldDelta }) {
  const _oldAc = (delta.old as string[]) ?? [];
  const newAc = (delta.new as string[]) ?? [];
  const added = delta.added ?? [];
  const removed = delta.removed ?? [];
  const unchanged = newAc.filter(ac => !added.includes(ac));

  return (
    <div className="space-y-0.5 rounded bg-bg/50 p-2">
      {removed.map((ac, i) => (
        <div key={`r-${i}`} className="flex items-start gap-2">
          <Minus size={10} className="text-error mt-0.5 shrink-0" />
          <span className="text-[11px] text-error/80 line-through">{ac}</span>
        </div>
      ))}
      {unchanged.map((ac, i) => (
        <div key={`u-${i}`} className="flex items-start gap-2">
          <span className="w-[10px] shrink-0" />
          <span className="text-[11px] text-muted">{ac}</span>
        </div>
      ))}
      {added.map((ac, i) => (
        <div key={`a-${i}`} className="flex items-start gap-2">
          <Plus size={10} className="text-success mt-0.5 shrink-0" />
          <span className="text-[11px] text-success">{ac}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Dependency Diff ─────────────────────────────────────────────── */

function DependencyDiff({ delta }: { delta: FieldDelta }) {
  const oldDeps = (delta.old as string[]) ?? [];
  const newDeps = (delta.new as string[]) ?? [];
  const added = newDeps.filter(d => !oldDeps.includes(d));
  const removed = oldDeps.filter(d => !newDeps.includes(d));
  const unchanged = newDeps.filter(d => oldDeps.includes(d));

  return (
    <div className="flex flex-wrap gap-1 rounded bg-bg/50 p-2">
      {removed.map((d, i) => (
        <span key={`r-${i}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border border-error/30 bg-error/10 text-error line-through font-mono">
          <Minus size={8} />
          {d}
        </span>
      ))}
      {unchanged.map((d, i) => (
        <span key={`u-${i}`} className="px-1.5 py-0.5 text-[10px] rounded border border-border bg-panel text-muted font-mono">
          {d}
        </span>
      ))}
      {added.map((d, i) => (
        <span key={`a-${i}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border border-success/30 bg-success/10 text-success font-mono">
          <Plus size={8} />
          {d}
        </span>
      ))}
    </div>
  );
}
