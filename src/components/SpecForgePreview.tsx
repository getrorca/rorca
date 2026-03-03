import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, Play, X, GitBranch, MinusCircle, PlusCircle, Check, Trash2, Layers, CheckCircle, XCircle } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import type { Story } from './StoryCard';
import type { PanelId } from './Sidebar';
import type { ContextUsed } from '../panels/SpecForgeOutput';

export interface GeneratedSpecPreview {
  specName: string;
  stories: Story[];
  diagram?: string;
  diagramType?: 'mermaid-flowchart' | 'mermaid-sequence' | 'ascii';
  savedPath?: string;
  generatedAt: string;
  contextUsed?: ContextUsed;
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
}

export default function SpecForgePreview({
  spec,
  workspaceId,
  onRegenerate,
  onEditBrief,
  isRegenerating,
  onNavigate,
  onNavigateToRun,
  onReset,
}: SpecForgePreviewProps) {
  const { show } = useGlobalToast();
  const { workspaces } = useWorkspace();
  const [approving, setApproving] = useState(false);
  const [expandedStories, setExpandedStories] = useState<Set<string>>(new Set());

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
  // Context info expand
  const [showContext, setShowContext] = useState(false);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState('');

  // "Approve & Run" flow: approve first, then show trigger modal
  const [approveAndRunMode, setApproveAndRunMode] = useState(false);

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
      await apiFetch(`/api/specs/${spec.specName}/stories/${storyId}`, {
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
  }, [excludedIds, spec.specName, workspaceId, show]);

  const handleApprove = async (thenRun: boolean) => {
    if (approving) return;
    setApproving(true);
    try {
      await apiFetch(`/api/specs/${spec.specName}/approve`, {
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
      await apiFetch(`/api/specs/${spec.specName}/reject`, {
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
            specPath: `forge/specs/approved/${spec.specName}.json`,
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
          onNavigate('pipeline');
        }
      }
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to trigger run', 'error');
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

      {/* Story cards */}
      <div className="space-y-2">
        {spec.stories.map((story) => {
          const isExpanded = expandedStories.has(story.id);
          const isExcluded = excludedIds.has(story.id);
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

      {/* Context info */}
      <div>
        {spec.contextUsed ? (() => {
          const m = spec.contextUsed!.meta;
          const hasDirection = m.standards || m.conventions || m.project;
          return (
            <>
              <button
                onClick={() => setShowContext(v => !v)}
                className={`flex items-center gap-1.5 text-xs transition-colors ${
                  hasDirection
                    ? 'text-muted hover:text-accent'
                    : 'text-warning/70 hover:text-warning'
                }`}
              >
                <Layers size={12} />
                {showContext ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {hasDirection
                  ? `Context injected (${m.totalTokens.toLocaleString()} tokens)`
                  : 'No direction configured — set up direction to improve spec quality'
                }
              </button>
              {showContext && (
                <div className="mt-2 border border-border rounded bg-panel p-3 space-y-3">
                  <div className="flex flex-wrap gap-3">
                    {([
                      ['Standards (L1)', m.standards],
                      ['Conventions (L2)', m.conventions],
                      ['Project (L3)', m.project],
                      ['Schema', m.schema],
                      ['Memory', m.memory],
                    ] as [string, boolean][]).map(([label, active]) => (
                      <span key={label} className="flex items-center gap-1 text-xs">
                        {active
                          ? <CheckCircle size={12} className="text-success" />
                          : <XCircle size={12} className="text-muted/40" />
                        }
                        <span className={active ? 'text-text' : 'text-muted/40'}>{label}</span>
                      </span>
                    ))}
                  </div>
                  {!hasDirection && (
                    <button
                      onClick={() => onNavigate?.('stack')}
                      className="text-xs text-accent hover:text-accent-hover transition-colors"
                    >
                      Configure Direction Stack
                    </button>
                  )}
                  <details className="group">
                    <summary className="text-xs text-muted hover:text-accent cursor-pointer select-none transition-colors">
                      Show full context text
                    </summary>
                    <pre className="mt-2 text-[11px] font-mono text-muted bg-bg/50 rounded p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                      {spec.contextUsed!.text}
                    </pre>
                  </details>
                </div>
              )}
            </>
          );
        })() : (
          <button
            onClick={() => onNavigate?.('stack')}
            className="flex items-center gap-1.5 text-xs text-warning/70 hover:text-warning transition-colors"
          >
            <Layers size={12} />
            No context injected — set up direction to improve spec quality
          </button>
        )}
      </div>

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
