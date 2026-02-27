import { useState, useEffect, useRef } from 'react';
import { Play, Minus, Plus, GitBranch, Loader2, ListPlus } from 'lucide-react';

interface TriggerPopoverProps {
  /** Default parallelism from workspace settings */
  defaultParallelism?: number;
  /** Whether a trigger is currently in progress */
  loading?: boolean;
  /** Called when user clicks Run Now */
  onTrigger: (parallelism: number, autoWorktree: boolean) => void;
  /** Called when user clicks Add to Queue */
  onAddToQueue?: (parallelism: number, autoWorktree: boolean) => void;
  /** Whether Add to Queue action is loading */
  queueLoading?: boolean;
  /** Called when popover is dismissed */
  onClose: () => void;
}

export default function TriggerPopover({
  defaultParallelism = 1,
  loading = false,
  onTrigger,
  onAddToQueue,
  queueLoading = false,
  onClose,
}: TriggerPopoverProps) {
  const [parallelism, setParallelism] = useState(defaultParallelism);
  const [autoWorktree, setAutoWorktree] = useState(defaultParallelism > 1);
  const ref = useRef<HTMLDivElement>(null);

  // Auto-check worktrees when parallelism > 1
  useEffect(() => {
    if (parallelism > 1) setAutoWorktree(true);
  }, [parallelism]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const decrement = () => setParallelism((p) => Math.max(1, p - 1));
  const increment = () => setParallelism((p) => Math.min(10, p + 1));

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-border bg-panel shadow-lg z-50 p-3 space-y-3"
    >
      {/* Parallelism stepper */}
      <div>
        <label className="block text-xs text-muted mb-1.5">Parallelism</label>
        <div className="flex items-center gap-2">
          <button
            onClick={decrement}
            disabled={parallelism <= 1}
            className="p-1 rounded border border-border hover:bg-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Minus size={14} />
          </button>
          <span className="w-8 text-center text-sm font-semibold text-[var(--text)] tabular-nums">
            {parallelism}
          </span>
          <button
            onClick={increment}
            disabled={parallelism >= 10}
            className="p-1 rounded border border-border hover:bg-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Plus size={14} />
          </button>
          <span className="text-[10px] text-muted ml-1">
            {parallelism === 1 ? 'sequential' : `${parallelism} parallel`}
          </span>
        </div>
      </div>

      {/* Use worktrees checkbox */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={autoWorktree}
          onChange={(e) => {
            // Don't allow unchecking when parallelism > 1
            if (parallelism > 1) return;
            setAutoWorktree(e.target.checked);
          }}
          disabled={parallelism > 1}
          className="rounded border-border accent-[var(--accent)]"
        />
        <span className="text-xs text-[var(--text)] flex items-center gap-1">
          <GitBranch size={12} className="text-muted" />
          Use worktrees
        </span>
        {parallelism > 1 && (
          <span className="text-[10px] text-muted">(required for parallel)</span>
        )}
      </label>

      {/* Action buttons */}
      <div className="space-y-2">
        {/* Run Now — primary */}
        <button
          onClick={() => onTrigger(parallelism, autoWorktree)}
          disabled={loading || queueLoading}
          className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-accent text-white hover:opacity-90 disabled:opacity-60 transition-opacity"
        >
          {loading ? (
            <><Loader2 size={14} className="animate-spin" /> Starting run...</>
          ) : (
            <><Play size={14} /> Run Now</>
          )}
        </button>

        {/* Add to Queue — secondary */}
        {onAddToQueue && (
          <button
            onClick={() => onAddToQueue(parallelism, autoWorktree)}
            disabled={loading || queueLoading}
            title="Will run after the active spec completes"
            className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium border border-border text-[var(--text)] hover:bg-bg disabled:opacity-60 transition-colors"
          >
            {queueLoading ? (
              <><Loader2 size={14} className="animate-spin" /> Adding to queue...</>
            ) : (
              <><ListPlus size={14} /> Add to Queue</>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
