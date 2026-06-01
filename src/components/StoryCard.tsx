/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, MinusCircle, PlusCircle, CheckCircle2, Circle, Pencil, AlertTriangle, Timer, GitPullRequest, GitCommit, GitBranch, ClipboardCopy, Check, MessageSquare, Sparkles, X, CheckCheck, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { AssigneeDropdown } from './AssigneeDropdown';
import type { Assignee } from './AssigneeDropdown';
import { HelpTooltip } from './HelpTooltip';

export interface Story {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
  dependsOn?: string[];
  complexity?: number;
  timeoutMinutes?: number;
  passes?: boolean;
  excluded?: boolean;
  mergedVia?: string;
  suggestedSkills?: Array<{ name: string; relevance: number; reason: string }>;
  /** Per-story execution model override (e.g. 'claude-opus-4-6'). */
  model?: string;
}

interface CriteriaSuggestion {
  criterion: string;
  rationale: string;
}

interface StoryCommit {
  id: number;
  story_id: string;
  spec_id: string;
  commit_sha: string;
  commit_message: string;
  author: string;
  pushed_at: string;
}

function getReadinessWarnings(story: Story, allStoryIds?: Set<string>): string[] {
  const warnings: string[] = [];
  if ((story.acceptanceCriteria ?? []).length < 3) {
    warnings.push(`Only ${(story.acceptanceCriteria ?? []).length} acceptance criteria (needs 3+)`);
  }
  if (allStoryIds) {
    const deps = story.dependsOn ?? story.dependencies ?? [];
    const unresolved = deps.filter(d => !allStoryIds.has(d));
    if (unresolved.length > 0) {
      warnings.push(`Unresolved dependencies: ${unresolved.join(', ')}`);
    }
  }
  return warnings;
}

export function StoryCard({
  story,
  onToggleExclude,
  onEdit,
  allStoryIds,
  selected,
  onToggleSelect,
  specId,
  workspaceId,
  commentCount,
  onOpenComments,
  assignee,
  onAssignStory,
  onCriteriaAccepted,
  modified,
  rightSlot,
}: {
  story: Story;
  onToggleExclude?: () => void;
  onEdit?: () => void;
  allStoryIds?: Set<string>;
  selected?: boolean;
  onToggleSelect?: () => void;
  specId?: string;
  workspaceId?: string;
  commentCount?: number;
  onOpenComments?: () => void;
  assignee?: Assignee | null;
  onAssignStory?: (userId: string | null) => Promise<void>;
  onCriteriaAccepted?: () => void;
  /** Show a 'Modified' badge when this story has been edited */
  modified?: boolean;
  /** Optional slot rendered inline in the header row, between the title area and the edit button */
  rightSlot?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [commitsExpanded, setCommitsExpanded] = useState(false);
  const [commits, setCommits] = useState<StoryCommit[]>([]);
  const [commitsLoaded, setCommitsLoaded] = useState(false);
  const [branchName, setBranchName] = useState<string | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [prBodyCopied, setPrBodyCopied] = useState(false);
  const [prBodyLoading, setPrBodyLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<CriteriaSuggestion[]>([]);
  const [acceptedIndices, setAcceptedIndices] = useState<Set<number>>(new Set());
  const [enhanceLoading, setEnhanceLoading] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const [acceptingAll, setAcceptingAll] = useState(false);

  const isDone = story.passes === true;
  const isDeferred = story.excluded === true && !isDone;
  const warnings = getReadinessWarnings(story, allStoryIds);
  const isNotReady = warnings.length > 0 && !isDone;

  const canShowCommits = !!(specId && workspaceId);
  const canCreateBranch = !!(specId && workspaceId && !isDone);

  const handleCreateBranch = async () => {
    if (!specId || !workspaceId || branchLoading) return;
    setBranchLoading(true);
    try {
      const data = await apiFetch<{ branchName: string; checkoutCommand: string }>(
        `/api/specs/${specId}/stories/${story.id}/branch`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) }
      );
      setBranchName(data.branchName);
    } catch (err: any) {
      // 409 means branch already exists — parse branchName from error body
      const msg = err?.message || '';
      try {
        const body = JSON.parse(msg.slice(msg.indexOf('{')));
        if (body.branchName) {
          setBranchName(body.branchName);
        }
      } catch {
        // Not parseable, ignore
      }
    } finally {
      setBranchLoading(false);
    }
  };

  const handleCopyPrBody = async () => {
    if (!specId || !workspaceId || prBodyLoading) return;
    setPrBodyLoading(true);
    try {
      const data = await apiFetch<{ body: string }>(
        `/api/specs/${specId}/stories/${story.id}/pr-body`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) }
      );
      await navigator.clipboard.writeText(data.body);
      setPrBodyCopied(true);
      setTimeout(() => setPrBodyCopied(false), 2000);
    } catch {
      // Silently fail — button returns to default state
    } finally {
      setPrBodyLoading(false);
    }
  };

  const canEnhance = !!(specId && workspaceId && !isDone);
  const ac = story.acceptanceCriteria ?? [];
  const hasFewCriteria = ac.length < 3;

  const handleEnhanceCriteria = async () => {
    if (!specId || !workspaceId || enhanceLoading) return;
    setEnhanceLoading(true);
    setEnhanceError(null);
    setSuggestions([]);
    setAcceptedIndices(new Set());
    try {
      const data = await apiFetch<{ suggestions: CriteriaSuggestion[] }>(
        `/api/specs/${specId}/stories/${story.id}/enhance-criteria`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) }
      );
      setSuggestions(data.suggestions);
      if (!expanded) setExpanded(true);
    } catch (err: any) {
      setEnhanceError(err?.message || 'Failed to generate suggestions');
    } finally {
      setEnhanceLoading(false);
    }
  };

  const handleAcceptSingle = async (idx: number) => {
    if (!specId || !workspaceId) return;
    const criterion = suggestions[idx]?.criterion;
    if (!criterion) return;
    try {
      await apiFetch(
        `/api/specs/${specId}/stories/${story.id}/accept-criteria`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, criteria: [criterion] }) }
      );
      setAcceptedIndices(prev => new Set([...prev, idx]));
      onCriteriaAccepted?.();
    } catch {
      // silent
    }
  };

  const handleAcceptAll = async () => {
    if (!specId || !workspaceId || acceptingAll) return;
    const remaining = suggestions.filter((_, i) => !acceptedIndices.has(i)).map(s => s.criterion);
    if (remaining.length === 0) return;
    setAcceptingAll(true);
    try {
      await apiFetch(
        `/api/specs/${specId}/stories/${story.id}/accept-criteria`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, criteria: remaining }) }
      );
      setAcceptedIndices(new Set(suggestions.map((_, i) => i)));
      onCriteriaAccepted?.();
    } catch {
      // silent
    } finally {
      setAcceptingAll(false);
    }
  };

  const handleDismissAll = () => {
    setSuggestions([]);
    setAcceptedIndices(new Set());
  };

  useEffect(() => {
    if (!commitsExpanded || commitsLoaded || !specId || !workspaceId) return;
    apiFetch<{ commits: StoryCommit[] }>(
      `/api/specs/${specId}/stories/${story.id}/commits?workspaceId=${workspaceId}`
    ).then(data => {
      setCommits(data.commits);
      setCommitsLoaded(true);
    }).catch(() => {
      setCommitsLoaded(true);
    });
  }, [commitsExpanded, commitsLoaded, specId, workspaceId, story.id]);

  return (
    <div className={`border rounded bg-panel transition-opacity ${
      selected ? 'border-accent ring-1 ring-accent/30' : isDeferred ? 'border-border/50 opacity-50' : isDone ? 'border-border/50 opacity-50' : isNotReady ? 'border-warning/40' : 'border-border'
    }`}>
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={selected ?? false}
              onChange={onToggleSelect}
              className="shrink-0 mt-1 w-3.5 h-3.5 rounded border-border accent-accent cursor-pointer"
            />
          )}
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded mt-0.5 bg-muted/15 text-muted">
            {story.id}
          </span>
          {story.complexity != null && (
            <span className={`shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded mt-0.5 ${
              story.complexity <= 2
                ? 'bg-success/15 text-success'
                : story.complexity === 3
                ? 'bg-warning/15 text-warning'
                : 'bg-error/15 text-error'
            }`}>
              C{story.complexity}
              <HelpTooltip helpKey="complexity-score" size={10} />
            </span>
          )}
          {story.timeoutMinutes != null && story.timeoutMinutes !== 45 && (
            <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded mt-0.5 bg-muted/15 text-muted" title={`Timeout: ${story.timeoutMinutes} minutes`}>
              <Timer size={9} />
              {story.timeoutMinutes}m
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isDone ? (
                <CheckCircle2 size={14} className="shrink-0 text-muted/60" />
              ) : isDeferred ? (
                <MinusCircle size={14} className="shrink-0 text-muted/40" />
              ) : (
                <Circle size={14} className="shrink-0 text-muted/40" />
              )}
              <span className={`text-sm font-semibold truncate ${
                isDeferred ? 'text-muted line-through' : isDone ? 'text-muted' : 'text-text'
              }`}>
                {story.title}
              </span>
              {modified && (
                <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent">
                  <Pencil size={9} />
                  Modified
                </span>
              )}
              {story.mergedVia && (
                <a
                  href={story.mergedVia}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Passed via PR merge"
                  className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                  onClick={e => e.stopPropagation()}
                >
                  <GitPullRequest size={9} />
                  PR
                </a>
              )}
              {isDeferred && (
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-muted/15 text-muted">
                  DEFERRED
                </span>
              )}
              {(commentCount ?? 0) > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenComments?.(); }}
                  className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                  title={`${commentCount} unresolved comment${commentCount === 1 ? '' : 's'}`}
                >
                  <MessageSquare size={9} />
                  {commentCount}
                </button>
              )}
              {story.dependencies && story.dependencies.length > 0 && (
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-warning/15 text-warning">
                  depends
                </span>
              )}
              {isNotReady && (
                <span
                  className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/15 text-warning cursor-help"
                  title={warnings.join('\n')}
                >
                  <AlertTriangle size={9} />
                  NOT READY
                </span>
              )}
            </div>
          </div>
          {/* Assignee */}
          {onAssignStory && workspaceId && (
            <div className="shrink-0 mt-0.5">
              <AssigneeDropdown
                assignee={assignee}
                onAssign={onAssignStory}
                workspaceId={workspaceId}
                size="sm"
              />
            </div>
          )}
          {/* Right slot (e.g. ModelBadge) */}
          {rightSlot && <div className="shrink-0 mt-0.5">{rightSlot}</div>}
          {/* Edit button */}
          {onEdit && (
            <button
              onClick={onEdit}
              title="Edit story"
              className="shrink-0 mt-0.5 text-muted/40 hover:text-accent transition-colors"
            >
              <Pencil size={14} />
            </button>
          )}
          {/* Defer / Include toggle — only when not already passed */}
          {!isDone && onToggleExclude && (
            <button
              onClick={onToggleExclude}
              title={isDeferred ? 'Include in next run' : 'Defer (skip next run)'}
              className={`shrink-0 mt-0.5 transition-colors ${
                isDeferred
                  ? 'text-muted hover:text-success'
                  : 'text-muted/40 hover:text-warning'
              }`}
            >
              {isDeferred ? <PlusCircle size={14} /> : <MinusCircle size={14} />}
            </button>
          )}
        </div>

        {ac.length > 0 && (
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-xs text-muted hover:text-text transition-colors"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Acceptance criteria ({ac.length})
            </button>
            {canEnhance && hasFewCriteria && suggestions.length === 0 && (
              <button
                onClick={handleEnhanceCriteria}
                disabled={enhanceLoading}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning hover:bg-warning/25 transition-colors disabled:opacity-50"
                title="This story has fewer than 3 criteria — enhance with AI"
              >
                {enhanceLoading ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                Suggest more
              </button>
            )}
          </div>
        )}

        {canEnhance && ac.length === 0 && suggestions.length === 0 && (
          <button
            onClick={handleEnhanceCriteria}
            disabled={enhanceLoading}
            className="flex items-center gap-1 mt-2 text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning hover:bg-warning/25 transition-colors disabled:opacity-50"
            title="No acceptance criteria — generate with AI"
          >
            {enhanceLoading ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
            Suggest criteria
          </button>
        )}

        {canShowCommits && (
          <button
            onClick={() => setCommitsExpanded(!commitsExpanded)}
            className="flex items-center gap-1 mt-1 text-xs text-muted hover:text-text transition-colors"
          >
            {commitsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <GitCommit size={11} />
            Commits{commitsLoaded ? ` (${commits.length})` : ''}
          </button>
        )}

        {canCreateBranch && !branchName && (
          <button
            onClick={handleCreateBranch}
            disabled={branchLoading}
            className="flex items-center gap-1 mt-1 text-xs text-muted hover:text-accent transition-colors disabled:opacity-50"
          >
            <GitBranch size={11} />
            {branchLoading ? 'Creating...' : 'Create Branch'}
          </button>
        )}

        {branchName && (
          <div className="flex items-center gap-1.5 mt-1">
            <GitBranch size={11} className="shrink-0 text-accent" />
            <code className="text-[10px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded truncate">
              {branchName}
            </code>
          </div>
        )}

        {canShowCommits && (
          <button
            onClick={handleCopyPrBody}
            disabled={prBodyLoading}
            className={`flex items-center gap-1 mt-1 text-xs transition-colors disabled:opacity-50 ${
              prBodyCopied ? 'text-success' : 'text-muted hover:text-accent'
            }`}
            title="Copy PR description to clipboard"
          >
            {prBodyCopied ? <Check size={11} /> : <ClipboardCopy size={11} />}
            {prBodyLoading ? 'Copying...' : prBodyCopied ? 'Copied!' : 'Copy PR Body'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0">
          <ul className="space-y-1 ml-5">
            {ac.map((ac, i) => (
              <li key={i} className="text-xs text-muted list-disc">
                {ac}
              </li>
            ))}
          </ul>

          {/* Enhance button (inline, for stories with >=3 criteria) */}
          {canEnhance && !hasFewCriteria && suggestions.length === 0 && (
            <button
              onClick={handleEnhanceCriteria}
              disabled={enhanceLoading}
              className="flex items-center gap-1 mt-2 text-xs text-muted hover:text-accent transition-colors disabled:opacity-50"
            >
              {enhanceLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              {enhanceLoading ? 'Generating suggestions...' : 'Suggest more criteria'}
            </button>
          )}

          {/* Loading indicator */}
          {enhanceLoading && (
            <div className="flex items-center gap-1.5 mt-2 text-xs text-muted">
              <Loader2 size={11} className="animate-spin" />
              Analyzing story and generating criteria...
            </div>
          )}

          {/* Error message */}
          {enhanceError && (
            <div className="mt-2 text-xs text-error">
              {enhanceError}
            </div>
          )}

          {/* Suggestions panel */}
          {suggestions.length > 0 && (
            <div className="mt-3 border border-accent/30 rounded bg-accent/5 p-2">
              <div className="flex items-center justify-between mb-2">
                <span className="flex items-center gap-1 text-xs font-medium text-accent">
                  <Sparkles size={11} />
                  AI Suggestions ({suggestions.length - acceptedIndices.size} remaining)
                </span>
                <div className="flex items-center gap-1.5">
                  {acceptedIndices.size < suggestions.length && (
                    <button
                      onClick={handleAcceptAll}
                      disabled={acceptingAll}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-success/15 text-success hover:bg-success/25 transition-colors disabled:opacity-50"
                    >
                      {acceptingAll ? <Loader2 size={9} className="animate-spin" /> : <CheckCheck size={9} />}
                      Accept all
                    </button>
                  )}
                  <button
                    onClick={handleDismissAll}
                    className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-muted/15 text-muted hover:bg-muted/25 transition-colors"
                  >
                    <X size={9} />
                    Dismiss
                  </button>
                </div>
              </div>
              <ul className="space-y-2">
                {suggestions.map((s, i) => {
                  const isAccepted = acceptedIndices.has(i);
                  return (
                    <li key={i} className={`text-xs rounded p-1.5 ${isAccepted ? 'bg-success/10' : 'bg-surface'}`}>
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className={`${isAccepted ? 'text-success' : 'text-text'}`}>
                            {s.criterion}
                          </div>
                          <div className="text-[10px] text-muted mt-0.5 italic">
                            {s.rationale}
                          </div>
                        </div>
                        {!isAccepted && (
                          <button
                            onClick={() => handleAcceptSingle(i)}
                            className="shrink-0 mt-0.5 flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-success/15 text-success hover:bg-success/25 transition-colors"
                          >
                            <Check size={9} />
                            Accept
                          </button>
                        )}
                        {isAccepted && (
                          <span className="shrink-0 mt-0.5 flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-success/15 text-success">
                            <CheckCircle2 size={9} />
                            Added
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {(() => {
            const deps = story.dependsOn ?? story.dependencies ?? [];
            return deps.length > 0 ? (
              <div className="mt-2 flex items-center gap-1.5 flex-wrap text-xs">
                <span className="text-muted font-medium">Depends on:</span>
                {deps.map((d) => (
                  <span
                    key={d}
                    className={`px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded ${
                      allStoryIds?.has(d)
                        ? 'bg-accent/10 text-accent'
                        : 'bg-error/10 text-error'
                    }`}
                  >
                    {d}
                    {allStoryIds && !allStoryIds.has(d) && ' (missing)'}
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-[11px] text-muted/60">No dependencies</div>
            );
          })()}
        </div>
      )}

      {commitsExpanded && (
        <div className="px-3 pb-3 pt-0">
          {!commitsLoaded ? (
            <div className="text-xs text-muted">Loading...</div>
          ) : commits.length === 0 ? (
            <div className="text-xs text-muted">No linked commits</div>
          ) : (
            <div className="space-y-1.5">
              {commits.map(c => (
                <div key={c.id} className="flex items-start gap-2 text-xs">
                  <code className="shrink-0 px-1 py-0.5 rounded bg-surface text-accent font-mono text-[10px]">
                    {c.commit_sha.slice(0, 7)}
                  </code>
                  <span className="text-text truncate flex-1" title={c.commit_message}>
                    {c.commit_message.split('\n')[0]}
                  </span>
                  <span className="shrink-0 text-muted">{c.author}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
