import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, RefreshCw, PenLine, Loader2, Play, X, GitBranch, ExternalLink } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import type { Story } from './StoryCard';
import type { PanelId } from './Sidebar';

export interface GeneratedSpecPreview {
  specName: string;
  stories: Story[];
  diagram?: string;
  diagramType?: 'mermaid-flowchart' | 'mermaid-sequence' | 'ascii';
  savedPath?: string;
  generatedAt: string;
  contextUsed?: string;
}

interface SpecForgePreviewProps {
  spec: GeneratedSpecPreview;
  workspaceId: string;
  onRegenerate: () => void;
  onEditBrief: () => void;
  isRegenerating?: boolean;
  onNavigate?: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
}

export default function SpecForgePreview({
  spec,
  workspaceId,
  onRegenerate,
  onEditBrief,
  isRegenerating,
  onNavigate,
  onNavigateToRun,
}: SpecForgePreviewProps) {
  const { show } = useGlobalToast();
  const { workspaces } = useWorkspace();
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [expandedStories, setExpandedStories] = useState<Set<string>>(new Set());

  // Trigger run modal state
  const [showTriggerModal, setShowTriggerModal] = useState(false);
  const [triggerWorkspaceId, setTriggerWorkspaceId] = useState(workspaceId);
  const [autoWorktree, setAutoWorktree] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const toggleStory = useCallback((id: string) => {
    setExpandedStories(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleApprove = async () => {
    if (approving || approved) return;
    setApproving(true);
    try {
      await apiFetch(`/api/specs/${spec.specName}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setApproved(true);
      show('Spec approved — ready to run', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Approval failed';
      show(message, 'error');
    } finally {
      setApproving(false);
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
        show('Pipeline triggered successfully', 'success');
        setShowTriggerModal(false);
        // Navigate to Run View if we got a runId
        if (res.runId && onNavigateToRun) {
          onNavigateToRun(res.runId);
        } else if (onNavigate) {
          onNavigate('pipeline');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to trigger run';
      show(message, 'error');
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Summary banner */}
      <div className="flex items-center justify-between px-4 py-3 bg-success/5 border border-success/20 rounded-lg">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={16} className="text-success" />
          <span className="text-sm font-medium text-text">
            Generated {spec.stories.length} {spec.stories.length === 1 ? 'story' : 'stories'}
          </span>
        </div>
        <span className="text-xs text-muted font-mono">{spec.specName}</span>
      </div>

      {/* Story cards */}
      <div className="space-y-2">
        {spec.stories.map((story) => {
          const isExpanded = expandedStories.has(story.id);
          return (
            <div
              key={story.id}
              className="border border-border rounded bg-panel"
            >
              {/* Card header */}
              <button
                onClick={() => toggleStory(story.id)}
                className="w-full px-3 py-2.5 flex items-start gap-2 text-left"
              >
                <span className="shrink-0 mt-0.5 text-muted">
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-accent/15 text-accent mt-0.5">
                  {story.id}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text truncate">
                    {story.title}
                  </div>
                  {story.description && !isExpanded && (
                    <p className="text-xs text-muted mt-0.5 line-clamp-1">
                      {story.description}
                    </p>
                  )}
                </div>
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-panel border border-border text-muted mt-0.5">
                  {story.acceptanceCriteria.length} AC
                </span>
              </button>

              {/* Expanded content */}
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

      {/* Action buttons */}
      <div className="flex items-center gap-3 pt-2">
        {!approved ? (
          <>
            <button
              onClick={handleApprove}
              disabled={approving}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded text-sm font-medium transition-colors ${
                approving
                  ? 'bg-accent/30 text-white/40 cursor-not-allowed'
                  : 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
              }`}
            >
              {approving && <Loader2 size={14} className="animate-spin" />}
              {approving ? 'Approving...' : 'Approve & Queue'}
            </button>

            <button
              onClick={onRegenerate}
              disabled={isRegenerating}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded text-sm font-medium text-muted hover:text-text border border-border hover:border-border-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={isRegenerating ? 'animate-spin' : ''} />
              Regenerate
            </button>

            <button
              onClick={onEditBrief}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded text-sm font-medium text-muted hover:text-text border border-border hover:border-border-hover transition-colors"
            >
              <PenLine size={14} />
              Edit Brief
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                setTriggerWorkspaceId(workspaceId);
                setShowTriggerModal(true);
              }}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded text-sm font-medium bg-accent text-white hover:bg-accent-hover cursor-pointer transition-colors"
            >
              <Play size={14} />
              Trigger Run
            </button>

            {onNavigate && (
              <button
                onClick={() => onNavigate('queue')}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded text-sm font-medium text-muted hover:text-text border border-border hover:border-border-hover transition-colors"
              >
                <ExternalLink size={14} />
                View in Queue
              </button>
            )}
          </>
        )}
      </div>

      {/* Trigger Run Modal */}
      {showTriggerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowTriggerModal(false)}>
          <div
            className="bg-bg border border-border rounded-lg shadow-xl w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h3 className="text-sm font-semibold text-text">Trigger Pipeline Run</h3>
                <p className="text-xs text-muted mt-0.5 font-mono">{spec.specName}</p>
              </div>
              <button
                onClick={() => setShowTriggerModal(false)}
                className="p-1 text-muted hover:text-text rounded transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal body */}
            <div className="px-5 py-4 space-y-4">
              {/* Workspace selector */}
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

              {/* Auto-worktree toggle */}
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

              {/* Spec summary */}
              <div className="px-3 py-2 bg-panel/50 border border-border/50 rounded text-xs text-muted">
                {spec.stories.length} {spec.stories.length === 1 ? 'story' : 'stories'} will be executed sequentially
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
              <button
                onClick={() => setShowTriggerModal(false)}
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
