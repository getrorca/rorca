import { useState } from 'react';
import { ChevronDown, ChevronRight, MinusCircle, PlusCircle, CheckCircle2, Pencil, AlertTriangle } from 'lucide-react';

export interface Story {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
  dependsOn?: string[];
  complexity?: number;
  passes?: boolean;
  excluded?: boolean;
}

function getReadinessWarnings(story: Story, allStoryIds?: Set<string>): string[] {
  const warnings: string[] = [];
  if (story.acceptanceCriteria.length < 3) {
    warnings.push(`Only ${story.acceptanceCriteria.length} acceptance criteria (needs 3+)`);
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
}: {
  story: Story;
  onToggleExclude?: () => void;
  onEdit?: () => void;
  allStoryIds?: Set<string>;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const isDone = story.passes === true;
  const isDeferred = story.excluded === true && !isDone;
  const warnings = getReadinessWarnings(story, allStoryIds);
  const isNotReady = warnings.length > 0 && !isDone;

  return (
    <div className={`border rounded bg-panel transition-opacity ${
      selected ? 'border-accent ring-1 ring-accent/30' : isDeferred ? 'border-border/50 opacity-50' : isNotReady ? 'border-warning/40' : 'border-border'
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
          <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded mt-0.5 ${
            isDone
              ? 'bg-success/15 text-success'
              : isDeferred
              ? 'bg-muted/15 text-muted'
              : 'bg-accent/15 text-accent'
          }`}>
            {story.id}
          </span>
          {story.complexity != null && (
            <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded mt-0.5 ${
              story.complexity <= 2
                ? 'bg-success/15 text-success'
                : story.complexity === 3
                ? 'bg-warning/15 text-warning'
                : 'bg-error/15 text-error'
            }`}>
              C{story.complexity}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-semibold truncate ${
                isDeferred ? 'text-muted line-through' : 'text-text'
              }`}>
                {story.title}
              </span>
              {isDone && (
                <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-success/15 text-success">
                  <CheckCircle2 size={9} />
                  DONE
                </span>
              )}
              {isDeferred && (
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-muted/15 text-muted">
                  DEFERRED
                </span>
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

        {story.acceptanceCriteria.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-2 text-xs text-muted hover:text-text transition-colors"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Acceptance criteria ({story.acceptanceCriteria.length})
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0">
          <ul className="space-y-1 ml-5">
            {story.acceptanceCriteria.map((ac, i) => (
              <li key={i} className="text-xs text-muted list-disc">
                {ac}
              </li>
            ))}
          </ul>
          {story.dependencies && story.dependencies.length > 0 && (
            <div className="mt-2 text-xs text-muted">
              <span className="font-medium">Depends on:</span>{' '}
              {story.dependencies.join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
