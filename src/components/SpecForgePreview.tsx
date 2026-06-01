/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, Play, X, GitBranch, MinusCircle, PlusCircle, Check, Trash2, AlertTriangle, Clock } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import type { Story } from './StoryCard';
import type { PanelId } from './Sidebar';
import type { ContextUsed } from '../panels/SpecForgeOutput';

export interface GeneratedSpecPreview {
  slug?: string;
  specName: string;
  stories: Story[];
  diagram?: string;
  diagramType?: 'mermaid-flowchart' | 'mermaid-sequence' | 'ascii';
  savedPath?: string;
  generatedAt: string;
  contextUsed?: ContextUsed;
}

export interface ModelSuggestion {
  storyId: string;
  suggestedModel: string;
  reason: string;
  confidence: number;
}

interface SpecForgePreviewProps {
  spec: GeneratedSpecPreview;
  workspaceId: string;
  onRegenerate: () => void;
  onEditBrief: () => void;
  isRegenerating?: boolean;
  onNavigate?: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
  onReset?: () => void;
  modelSuggestions?: ModelSuggestion[] | null;
  onModelAccepted?: (storyId: string, model: string) => void;
}

export default function SpecForgePreview({
  spec,
  workspaceId,
  onRegenerate: _onRegenerate,
  onEditBrief: _onEditBrief,
  isRegenerating: _isRegenerating,
  onNavigate,
  onNavigateToRun,
  onReset,
  modelSuggestions,
  onModelAccepted,
}: SpecForgePreviewProps) {
  const { show } = useGlobalToast();
  const { workspaces } = useWorkspace();
  // Use slug (filename) for API calls; fall back to specName for older responses
  const specSlug = spec.slug || spec.specName;
  const [approving, setApproving] = useState(false);
  const [expandedStories, setExpandedStories] = useState<Set<string>>(new Set());

  // Model suggestion local state: track dismissed and accepted suggestions
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [acceptedModels, setAcceptedModels] = useState<Map<string, string>>(new Map());
  const [showAcceptAllConfirm, setShowAcceptAllConfirm] = useState(false);

  const pendingSuggestions = (modelSuggestions ?? []).filter(
    s => !dismissedSuggestions.has(s.storyId) && !acceptedModels.has(s.storyId)
  );

  const handleAcceptModel = useCallback((storyId: string, model: string) => {
    setAcceptedModels(prev => new Map(prev).set(storyId, model));
    onModelAccepted?.(storyId, model);
  }, [onModelAccepted]);

  const handleDismissModel = useCallback((storyId: string) => {
    setDismissedSuggestions(prev => new Set(prev).add(storyId));
  }, []);

  const handleAcceptAll = useCallback(() => {
    for (const s of pendingSuggestions) {
      setAcceptedModels(prev => new Map(prev).set(s.storyId, s.suggestedModel));
      onModelAccepted?.(s.storyId, s.suggestedModel);
    }
    setShowAcceptAllConfirm(false);
  }, [pendingSuggestions, onModelAccepted]);

  // Editable spec name
  const [editingName, setEditingName] = useState(false);
  const [editedName, setEditedName] = useState(spec.specName);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Trigger run modal state
  const [showTriggerModal, setShowTriggerModal] = useState(false);
  const [triggerWorkspaceId, setTriggerWorkspaceId] = useState(workspaceId);
  const [autoWorktree, setAutoWorktree] = useState(false);
  const [triggering, setTriggering] = useState(false);

  // Reject confirmation
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  // Diagram expand
  const [showDiagram, setShowDiagram] = useState(false);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState('');

  // "Approve & Run" flow: approve first, then show trigger modal
  const [approveAndRunMode, setApproveAndRunMode] = useState(false);

  // "Approve & Queue" flow
  const [queuingRun, setQueuingRun] = useState(false);

  // Excluded stories tracking
  const [excludedIds, setExcludedIds] = useState<Set<string>>(
    () => new Set(spec.stories.filter(s => s.excluded).map(s => s.id))
  );

  const excludedCount = excludedIds.size;
  const activeCount = spec.stories.length - excludedCount;

  // Focus name input when editing starts
  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  // Render mermaid when diagram is shown
  const isMermaid = spec.diagramType === 'mermaid-flowchart' || spec.diagramType === 'mermaid-sequence';
  useEffect(() => {
    if (!showDiagram || !spec.diagram || !isMermaid) return;
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          themeVariables: {
            primaryColor: '#6366f1',
            primaryTextColor: '#fafafa',
            primaryBorderColor: '#3f3f46',
            lineColor: '#a1a1aa',
            secondaryColor: '#1c1c21',
            tertiaryColor: '#0f0f11',
          },
        });
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, spec.diagram!);
        if (!cancelled) setSvgContent(svg);
      } catch {
        if (!cancelled) setSvgContent('');
      }
    })();
    return () => { cancelled = true; };
  }, [showDiagram, spec.diagram, isMermaid]);

  const toggleStory = useCallback((id: string) => {
    setExpandedStories(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleExclude = useCallback(async (storyId: string) => {
    const willExclude = !excludedIds.has(storyId);
    setExcludedIds(prev => {
      const next = new Set(prev);
      if (willExclude) next.add(storyId);
      else next.delete(storyId);
      return next;
    });
    try {
      await apiFetch(`/api/specs/${specSlug}/stories/${storyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, excluded: willExclude }),
      });
    } catch {
      setExcludedIds(prev => {
        const next = new Set(prev);
        if (willExclude) next.delete(storyId);
        else next.add(storyId);
        return next;
      });
      show('Failed to update story exclusion', 'error');
    }
  }, [excludedIds, specSlug, workspaceId, show]);

  const handleApprove = async (thenRun: boolean) => {
    if (approving) return;
    setApproving(true);
    try {
      await apiFetch(`/api/specs/${specSlug}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (thenRun) {
        setApproveAndRunMode(true);
        setTriggerWorkspaceId(workspaceId);
        setShowTriggerModal(true);
      } else {
        show('Spec approved — ready to run from Pipeline', 'success');
        onReset?.();
      }
    } catch (err) {
      show(err instanceof Error ? err.message : 'Approval failed', 'error');
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    setRejecting(true);
    try {
      await apiFetch(`/api/specs/${specSlug}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      show('Spec rejected', 'success');
      onReset?.();
    } catch (err) {
      show(err instanceof Error ? err.message : 'Rejection failed', 'error');
    } finally {
      setRejecting(false);
      setShowRejectConfirm(false);
    }
  };

  const handleTriggerRun = async () => {
    setTriggering(true);
    try {
      const res = await apiFetch<{ ok?: boolean; conflict?: boolean; activeRunId?: number; runId?: number }>(
        '/api/pipeline/trigger',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            specPath: `forge/specs/approved/${specSlug}.json`,
            workspaceId: triggerWorkspaceId,
            autoWorktree,
          }),
        },
      );
      if (res.conflict) {
        show('A run is already active — use worktree mode or wait for it to finish', 'error');
      } else {
        show('Spec approved — running now', 'success');
        setShowTriggerModal(false);
        onReset?.();
        if (res.runId && onNavigateToRun) {
          onNavigateToRun(res.runId);
        } else if (onNavigate) {
          onNavigate('runs');
        }
      }
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to trigger run', 'error');
    } finally {
      setTriggering(false);
    }
  };

  const handleApproveAndQueue = useCallback(async () => {
    if (approving || queuingRun) return;
    // Step 1: approve (without triggering run)
    setApproving(true);
    try {
      await apiFetch(`/api/specs/${specSlug}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
    } catch (err) {
      show(err instanceof Error ? err.message : 'Approval failed', 'error');
      setApproving(false);
      return;
    }
    setApproving(false);
    // Step 2: trigger with queue: true
    setQueuingRun(true);
    try {
      const res = await apiFetch<{ ok?: boolean; queued?: boolean; conflict?: boolean; runId?: number; position?: number }>(
        '/api/pipeline/trigger',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            specPath: `forge/specs/approved/${specSlug}.json`,
            workspaceId: triggerWorkspaceId,
            queue: true,
          }),
        },
      );
      if (res.queued) {
        show(`Queued at position #${res.position}`, 'success');
        onReset?.();
      } else {
        // Queue was empty — ran immediately
        show('Spec approved — running now', 'success');
        onReset?.();
        if (res.runId && onNavigateToRun) {
          onNavigateToRun(res.runId);
        } else if (onNavigate) {
          onNavigate('runs');
        }
      }
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to queue run', 'error');
    } finally {
      setQueuingRun(false);
    }
  }, [approving, queuingRun, specSlug, workspaceId, triggerWorkspaceId, show, onReset, onNavigateToRun, onNavigate]);

  const handleNameBlur = () => {
    setEditingName(false);
    // Name editing is cosmetic for now — the spec is identified by specName from generation
  };

  return (
    <div className="space-y-4">
      {/* Spec header: editable name + story count badge */}
      <div className="flex items-center gap-3">
        <CheckCircle2 size={16} className="text-success shrink-0" />
        {editingName ? (
          <input
            ref={nameInputRef}
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={(e) => { if (e.key === 'Enter') handleNameBlur(); }}
            className="flex-1 text-sm font-semibold text-text bg-transparent border-b border-accent outline-none py-0.5"
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="flex-1 text-left text-sm font-semibold text-text hover:text-accent transition-colors truncate"
            title="Click to edit spec name"
          >
            {editedName}
          </button>
        )}
        <span className="shrink-0 px-2 py-0.5 text-xs font-semibold rounded-full bg-accent/15 text-accent">
          {activeCount} {activeCount === 1 ? 'story' : 'stories'}
          {excludedCount > 0 && (
            <span className="text-warning ml-1">({excludedCount} excluded)</span>
          )}
        </span>
      </div>

      {/* Accept All Models button */}
      {pendingSuggestions.length > 0 && (
        <div className="flex items-center gap-2">
          {showAcceptAllConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Apply model suggestions to {pendingSuggestions.length} {pendingSuggestions.length === 1 ? 'story' : 'stories'}?</span>
              <button
                onClick={handleAcceptAll}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded transition-colors"
              >
                <Check size={10} />
                Confirm
              </button>
              <button
                onClick={() => setShowAcceptAllConfirm(false)}
                className="text-[11px] text-muted hover:text-text transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAcceptAllConfirm(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-text border border-border rounded hover:bg-accent/10 hover:border-accent/30 transition-colors"
            >
              <Check size={10} />
              Accept All Models ({pendingSuggestions.length})
            </button>
          )}
        </div>
      )}

      {/* Story cards */}
      <div className="space-y-2">
        {spec.stories.map((story) => {
          const isExpanded = expandedStories.has(story.id);
          const isExcluded = excludedIds.has(story.id);
          const storySkills = story.suggestedSkills ?? [];
          const storySuggestion = pendingSuggestions.find(s => s.storyId === story.id);
          const storyAcceptedModel = acceptedModels.get(story.id) ?? story.model;
          return (
            <div
              key={story.id}
              className={`border rounded bg-panel transition-opacity ${
                isExcluded ? 'border-border/50 opacity-50' : 'border-border'
              }`}
            >
              <div className="w-full px-3 py-2.5 flex items-start gap-2">
                <button
                  onClick={() => toggleStory(story.id)}
                  className="shrink-0 mt-0.5 text-muted"
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded mt-0.5 ${
                  isExcluded ? 'bg-muted/15 text-muted' : 'bg-accent/15 text-accent'
                }`}>
                  {story.id}
                </span>
                <button
                  onClick={() => toggleStory(story.id)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className={`text-sm font-semibold truncate ${
                    isExcluded ? 'text-muted line-through' : 'text-text'
                  }`}>
                    {story.title}
                  </div>
                  {story.description && !isExpanded && (
                    <p className="text-xs text-muted mt-0.5 line-clamp-2">
                      {story.description}
                    </p>
                  )}
                </button>
                {/* Accepted model badge */}
                {storyAcceptedModel && !storySuggestion && (
                  <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono rounded bg-accent/15 text-accent mt-0.5">
                    {storyAcceptedModel}
                  </span>
                )}
                {isExcluded && (
                  <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-muted/15 text-muted mt-0.5">
                    EXCLUDED
                  </span>
                )}
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-panel border border-border text-muted mt-0.5">
                  {story.acceptanceCriteria.length} AC
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggleExclude(story.id); }}
                  title={isExcluded ? 'Include in run' : 'Exclude from run'}
                  className={`shrink-0 mt-0.5 transition-colors ${
                    isExcluded
                      ? 'text-muted hover:text-success'
                      : 'text-muted/40 hover:text-warning'
                  }`}
                >
                  {isExcluded ? <PlusCircle size={14} /> : <MinusCircle size={14} />}
                </button>
              </div>

              {/* Skill badges + model suggestion row */}
              {(storySkills.length > 0 || storySuggestion) && !isExcluded && (
                <div className="px-3 pb-2 pt-0 ml-6 space-y-1.5">
                  {/* Skill badges */}
                  {storySkills.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {storySkills.map((skill) => (
                        <span
                          key={skill.name}
                          title={skill.reason}
                          className={`px-1.5 py-0.5 text-[10px] font-mono rounded cursor-default ${
                            skill.relevance >= 8
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : skill.relevance >= 5
                                ? 'bg-blue-500/10 text-blue-400'
                                : 'bg-gray-500/10 text-gray-400'
                          }`}
                        >
                          {skill.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Model suggestion */}
                  {storySuggestion && (
                    <div className="flex items-center gap-1.5">
                      {storySuggestion.confidence < 0.6 && (
                        <AlertTriangle size={10} className="text-amber-500 shrink-0" />
                      )}
                      <span className="text-[11px] text-muted/80">
                        Suggested: {storySuggestion.suggestedModel}
                      </span>
                      <button
                        onClick={() => handleAcceptModel(storySuggestion.storyId, storySuggestion.suggestedModel)}
                        title="Accept model suggestion"
                        className="text-emerald-500 hover:bg-emerald-500/10 rounded px-1 transition-colors"
                      >
                        <Check size={10} />
                      </button>
                      <button
                        onClick={() => handleDismissModel(storySuggestion.storyId)}
                        title="Dismiss suggestion"
                        className="text-muted hover:bg-red-500/10 rounded px-1 transition-colors"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {isExpanded && (
                <div className="px-3 pb-3 pt-0 ml-6 border-t border-border/50">
                  {story.description && (
                    <p className="text-xs text-muted mt-2 mb-2">
                      {story.description}
                    </p>
                  )}
                  {story.acceptanceCriteria.length > 0 && (
                    <div className="mt-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                        Acceptance Criteria
                      </span>
                      <ul className="mt-1 space-y-1 ml-4">
                        {story.acceptanceCriteria.map((ac, i) => (
                          <li key={i} className="text-xs text-muted list-disc">
                            {ac}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(story.dependsOn ?? story.dependencies ?? []).length > 0 && (
                    <div className="mt-2 text-xs text-muted">
                      <span className="font-medium">Depends on:</span>{' '}
                      {(story.dependsOn ?? story.dependencies ?? []).join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* View diagram link */}
      {spec.diagram && (
        <div>
          <button
            onClick={() => setShowDiagram(v => !v)}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          >
            {showDiagram ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {showDiagram ? 'Hide diagram' : 'View diagram'}
          </button>
          {showDiagram && (
            <div className="mt-2 border border-border rounded bg-panel p-4 overflow-x-auto">
              {isMermaid && svgContent ? (
                <div ref={mermaidRef} dangerouslySetInnerHTML={{ __html: svgContent }} />
              ) : (
                <pre className="text-xs font-mono text-text whitespace-pre">
                  {spec.diagram}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-3 pt-2 border-t border-border">
        {/* Approve & Run — primary */}
        <button
          onClick={() => handleApprove(true)}
          disabled={approving}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            approving
              ? 'bg-accent/30 text-white/40 cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
          }`}
        >
          {approving && approveAndRunMode ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Approving...
            </>
          ) : (
            <>
              <Play size={14} />
              Approve & Run
            </>
          )}
        </button>

        {/* Approve — secondary */}
        <button
          onClick={() => handleApprove(false)}
          disabled={approving}
          className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
            approving
              ? 'border-border/50 text-muted/40 cursor-not-allowed'
              : 'border-border text-text hover:bg-accent/10 hover:border-accent/30 cursor-pointer'
          }`}
        >
          {approving && !approveAndRunMode ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" />
              Approving...
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Check size={14} />
              Approve
            </span>
          )}
        </button>

        {/* Approve & Queue — secondary */}
        <button
          onClick={handleApproveAndQueue}
          disabled={approving || triggering || queuingRun || rejecting}
          className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
            approving || triggering || queuingRun || rejecting
              ? 'border-border/50 text-muted/40 cursor-not-allowed'
              : 'border-border text-text hover:bg-surface-200 cursor-pointer'
          }`}
        >
          {queuingRun ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" />
              Queueing...
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Clock size={14} />
              Approve &amp; Queue
            </span>
          )}
        </button>

        {/* Reject — tertiary, text-only, red */}
        {showRejectConfirm ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleReject}
              disabled={rejecting}
              className="flex items-center gap-1 px-3 py-2.5 text-sm font-medium text-red-400 hover:text-red-300 transition-colors"
            >
              {rejecting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Confirm
            </button>
            <button
              onClick={() => setShowRejectConfirm(false)}
              className="text-xs text-muted hover:text-text transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowRejectConfirm(true)}
            className="flex items-center gap-1 px-3 py-2.5 text-sm font-medium text-red-400/60 hover:text-red-400 transition-colors"
          >
            <Trash2 size={14} />
            Reject
          </button>
        )}
      </div>

      {/* Trigger Run Modal (shown after Approve & Run succeeds) */}
      {showTriggerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setShowTriggerModal(false); setApproveAndRunMode(false); }}>
          <div
            className="bg-bg border border-border rounded-lg shadow-xl w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h3 className="text-sm font-semibold text-text">Run Pipeline</h3>
                <p className="text-xs text-muted mt-0.5 font-mono">{spec.specName}</p>
              </div>
              <button
                onClick={() => { setShowTriggerModal(false); setApproveAndRunMode(false); }}
                className="p-1 text-muted hover:text-text rounded transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Workspace</label>
                <select
                  value={triggerWorkspaceId}
                  onChange={(e) => setTriggerWorkspaceId(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors appearance-none cursor-pointer"
                >
                  {workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name || ws.id}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoWorktree}
                  onChange={(e) => setAutoWorktree(e.target.checked)}
                  className="w-4 h-4 rounded border-border bg-panel accent-accent"
                />
                <div>
                  <div className="flex items-center gap-1.5">
                    <GitBranch size={13} className="text-muted" />
                    <span className="text-sm text-text">Run in worktree</span>
                  </div>
                  <p className="text-xs text-muted mt-0.5">
                    Creates an isolated branch — avoids conflicts with active work
                  </p>
                </div>
              </label>

              <div className="px-3 py-2 bg-panel/50 border border-border/50 rounded text-xs text-muted">
                {activeCount} {activeCount === 1 ? 'story' : 'stories'} will be executed sequentially
                {excludedCount > 0 && (
                  <span className="text-warning"> ({excludedCount} excluded)</span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
              <button
                onClick={() => { setShowTriggerModal(false); setApproveAndRunMode(false); }}
                className="px-4 py-2 text-sm font-medium text-muted hover:text-text rounded border border-border hover:border-border-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleTriggerRun}
                disabled={triggering}
                className={`flex items-center gap-2 px-5 py-2 rounded text-sm font-medium transition-colors ${
                  triggering
                    ? 'bg-accent/30 text-white/40 cursor-not-allowed'
                    : 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
                }`}
              >
                {triggering ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Triggering...
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    Confirm & Run
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
