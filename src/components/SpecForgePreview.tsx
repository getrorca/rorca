/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, Play, X, MinusCircle, PlusCircle, Check, Trash2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import TriggerPopover, { type TriggerOptions } from './TriggerPopover';
import { triggerPipeline, triggerReceiptRunId } from '../api/pipeline';
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
  // Use slug (filename) for API calls; fall back to specName for older responses
  const specSlug = spec.slug || spec.specName;
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
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

  // Approved specs dispatch only through the canonical preflight popover.
  const [showTriggerModal, setShowTriggerModal] = useState(false);
  const [triggering, setTriggering] = useState(false);

  // Reject confirmation
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  // Diagram expand
  const [showDiagram, setShowDiagram] = useState(false);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState('');

  const [approvingForDispatch, setApprovingForDispatch] = useState(false);

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

  const handleApprove = async (thenDispatch: boolean) => {
    if (approving) return;
    setApproving(true);
    setApprovingForDispatch(thenDispatch);
    try {
      await apiFetch(`/api/specs/${specSlug}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setApproved(true);
      if (thenDispatch) {
        setShowTriggerModal(true);
      } else {
        show('Spec approved — ready for governed dispatch', 'success');
        onReset?.();
      }
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Approval failed', 'error');
    } finally {
      setApproving(false);
      setApprovingForDispatch(false);
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

  const handleTriggerRun = async (
    autoWorktree: boolean,
    options?: TriggerOptions,
    queue = false,
  ) => {
    if (triggering) return;
    setTriggering(true);
    try {
      const res = await triggerPipeline({
        specPath: `forge/specs/approved/${specSlug}.json`,
        workspaceId,
        autoWorktree,
        autoMerge: options?.autoMerge,
        mergeStrategy: options?.mergeStrategy,
        forceSequential: options?.forceSequential,
        orchestrationMode: options?.orchestrationMode,
        parallelism: options?.parallelism,
        qualificationReceiptId: options?.qualificationReceiptId,
        rolloutCohort: options?.rolloutCohort,
        includeGraph: options?.includeGraph,
        terminal_mode: options?.terminal_mode,
        effortLevel: options?.effortLevel,
        thinkingEnabled: options?.thinkingEnabled,
        thinkingBudget: options?.thinkingBudget,
        reasoning: options?.reasoningOverride,
        agentOverride: options?.agentOverride,
        executionEnvironment: options?.executionEnvironment,
        queue,
      });
      const destinationRunId = triggerReceiptRunId(res);
      if (destinationRunId === null) throw new Error('Dispatch did not return a run identity');
      if ('conflict' in res) show('An active run already owns this workspace', 'error');
      else if ('queued' in res) show(`Queued at position #${res.position}`, 'success');
      else show('Spec approved — running now', 'success');
      setShowTriggerModal(false);
      onReset?.();
      onNavigateToRun?.(destinationRunId);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to dispatch run', 'error');
    } finally {
      setTriggering(false);
    }
  };

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
      <div className="relative flex items-center gap-3 pt-2 border-t border-border">
        {showTriggerModal && (
          <TriggerPopover
            loading={triggering}
            queueLoading={triggering}
            onTrigger={(autoWorktree, options) => void handleTriggerRun(autoWorktree, options)}
            onAddToQueue={(autoWorktree, options) => void handleTriggerRun(autoWorktree, options, true)}
            onClose={() => setShowTriggerModal(false)}
            onNavigate={onNavigate}
            specPath={`forge/specs/approved/${specSlug}.json`}
            workspaceId={workspaceId}
          />
        )}
        {/* Approval and dispatch are two durable steps. */}
        <button
          onClick={() => approved ? setShowTriggerModal(true) : void handleApprove(true)}
          disabled={approving || triggering}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            approving || triggering
              ? 'bg-accent/30 text-white/40 cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
          }`}
        >
          {approving && approvingForDispatch ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Approving...
            </>
          ) : (
            <>
              <Play size={14} />
              {approved ? 'Review Dispatch' : 'Approve & Review Dispatch'}
            </>
          )}
        </button>

        <button
          onClick={() => void handleApprove(false)}
          disabled={approved || approving || triggering}
          className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
            approved || approving || triggering
              ? 'border-border/50 text-muted/40 cursor-not-allowed'
              : 'border-border text-text hover:bg-accent/10 hover:border-accent/30 cursor-pointer'
          }`}
        >
          {approving && !approvingForDispatch ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" />
              Approving...
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Check size={14} />
              {approved ? 'Approved' : 'Approve'}
            </span>
          )}
        </button>
        {/* Reject — tertiary, text-only, red */}
        {showRejectConfirm ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleReject}
              disabled={approved || rejecting}
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
            disabled={approved}
            className="flex items-center gap-1 px-3 py-2.5 text-sm font-medium text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-40"
          >
            <Trash2 size={14} />
            Reject
          </button>
        )}
      </div>

    </div>
  );
}
