import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface Story {
  id: string;
  title: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
}

export function StoryCard({ story }: { story: Story }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded bg-panel">
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-accent/15 text-accent mt-0.5">
            {story.id}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text truncate">{story.title}</span>
              {story.dependencies && story.dependencies.length > 0 && (
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-warning/15 text-warning">
                  depends
                </span>
              )}
            </div>
          </div>
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
