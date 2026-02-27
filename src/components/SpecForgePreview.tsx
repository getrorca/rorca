import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, RefreshCw, PenLine, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import type { Story } from './StoryCard';

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
}

export default function SpecForgePreview({
  spec,
  workspaceId,
  onRegenerate,
  onEditBrief,
  isRegenerating,
}: SpecForgePreviewProps) {
  const { show } = useGlobalToast();
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [expandedStories, setExpandedStories] = useState<Set<string>>(new Set());

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
      show('Spec approved and queued for execution', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Approval failed';
      show(message, 'error');
    } finally {
      setApproving(false);
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
        <button
          onClick={handleApprove}
          disabled={approving || approved}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded text-sm font-medium transition-colors ${
            approved
              ? 'bg-success/15 text-success border border-success/30 cursor-default'
              : approving
                ? 'bg-accent/30 text-white/40 cursor-not-allowed'
                : 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
          }`}
        >
          {approving && <Loader2 size={14} className="animate-spin" />}
          {approved ? 'Approved & Queued' : approving ? 'Approving...' : 'Approve & Queue'}
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
      </div>
    </div>
  );
}
