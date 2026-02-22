import { useState, useEffect, useRef, useCallback } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useDirectionLayer } from '../hooks/useDirectionLayer';
import { apiFetch } from '../lib/apiFetch';
import BootstrapContextModal from '../components/BootstrapContextModal';

type LayerTab = 1 | 2 | 3;

const LAYER_LABELS: Record<LayerTab, string> = {
  1: 'L1 Global Brain',
  2: 'L2 Domain Profile',
  3: 'L3 Project Brief',
};

const BOOTSTRAP_DISMISSED_KEY = (id: string) => `bootstrapDismissed_${id}`;

export default function DirectionStackPanel() {
  const { workspaceId } = useWorkspace();
  const [activeTab, setActiveTab] = useState<LayerTab>(1);
  const [showBootstrap, setShowBootstrap] = useState(false);

  // L1/L2/L3 persisted layers
  const l1 = useDirectionLayer(workspaceId, 1);
  const l2 = useDirectionLayer(workspaceId, 2);
  const l3 = useDirectionLayer(workspaceId, 3);
  const layers = { 1: l1, 2: l2, 3: l3 } as const;
  const active = layers[activeTab];

  // First-run detection: show banner if all layers empty and not dismissed
  const allEmpty = !l1.content && !l2.content && !l3.content;
  const [bannerDismissed, setBannerDismissed] = useState(() =>
    workspaceId ? localStorage.getItem(BOOTSTRAP_DISMISSED_KEY(workspaceId)) === 'true' : false
  );
  const showFirstRunBanner = allEmpty && !bannerDismissed;

  const handleDismissBanner = () => {
    if (workspaceId) localStorage.setItem(BOOTSTRAP_DISMISSED_KEY(workspaceId), 'true');
    setBannerDismissed(true);
  };

  const handleBootstrapAccept = useCallback((yaml: string) => {
    active.setContent(yaml);
  }, [active]);

  // L4/L5 ephemeral (no save)
  const [l4, setL4] = useState('');
  const [l5, setL5] = useState('');

  // Synthesized preview
  const [synthesized, setSynthesized] = useState('');
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const synthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const synthesize = useCallback(() => {
    if (!workspaceId) return;
    setIsSynthesizing(true);
    apiFetch<{ synthesized: string }>('/api/direction/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        l4SpecBrief: l4,
        l5Annotations: l5,
      }),
    })
      .then((data) => setSynthesized(data.synthesized))
      .catch(console.error)
      .finally(() => setIsSynthesizing(false));
  }, [workspaceId, l4, l5]);

  // Debounced synthesize when any input changes
  useEffect(() => {
    if (synthTimerRef.current) clearTimeout(synthTimerRef.current);
    synthTimerRef.current = setTimeout(synthesize, 300);
    return () => {
      if (synthTimerRef.current) clearTimeout(synthTimerRef.current);
    };
  }, [l1.content, l2.content, l3.content, l4, l5, synthesize]);

  const handleCopy = () => {
    navigator.clipboard.writeText(synthesized).catch(console.error);
  };

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        Select a workspace to view the direction stack.
      </div>
    );
  }

  return (
    <div className="flex h-full gap-px bg-border">
      {/* Column 1: Layer editor tabs (L1/L2/L3) */}
      <div className="flex-1 flex flex-col bg-bg min-w-0">
        {/* Tab bar + Bootstrap button */}
        <div className="flex items-center border-b border-border">
          <div className="flex flex-1">
            {([1, 2, 3] as const).map((n) => (
              <button
                key={n}
                onClick={() => setActiveTab(n)}
                className={`flex-1 px-3 py-2 text-xs font-medium transition-colors relative ${
                  activeTab === n
                    ? 'text-text border-b-2 border-accent'
                    : 'text-muted hover:text-text'
                }`}
              >
                {LAYER_LABELS[n]}
                {layers[n].isDirty && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning ml-1.5 opacity-60" />
                )}
                {layers[n].isSaving && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent ml-1.5 animate-pulse" />
                )}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowBootstrap(true)}
            className="px-2.5 py-1.5 text-xs text-accent hover:text-[var(--accent-hover)] transition-colors whitespace-nowrap"
          >
            Bootstrap Context &#10022;
          </button>
        </div>

        {/* First-run banner */}
        {showFirstRunBanner && (
          <div className="flex items-center justify-between px-3 py-2.5 bg-accent/5 border-b border-accent/20">
            <div className="text-xs text-text">
              <span className="mr-1">&#10022;</span>
              This workspace has no context yet. Bootstrap your Direction Stack to get better specs.
            </div>
            <div className="flex items-center gap-2 ml-3 shrink-0">
              <button
                onClick={() => setShowBootstrap(true)}
                className="px-2.5 py-1 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors"
              >
                Bootstrap Context &rarr;
              </button>
              <button
                onClick={handleDismissBanner}
                className="text-xs text-muted hover:text-text transition-colors"
              >
                &#10005;
              </button>
            </div>
          </div>
        )}

        {/* Editor */}
        <textarea
          value={active.content}
          onChange={(e) => active.setContent(e.target.value)}
          className="flex-1 w-full p-3 font-mono text-sm bg-bg text-text border-none outline-none resize-none"
          placeholder={`Enter ${LAYER_LABELS[activeTab]} content...`}
          spellCheck={false}
        />
      </div>

      {/* Column 2: L4 Spec Brief + L5 Story Annotations (ephemeral) */}
      <div className="flex-1 flex flex-col bg-bg min-w-0">
        <div className="flex-1 flex flex-col border-b border-border">
          <label className="px-3 py-2 text-xs font-medium text-muted border-b border-border">
            Spec Brief (L4)
          </label>
          <textarea
            value={l4}
            onChange={(e) => setL4(e.target.value)}
            className="flex-1 w-full p-3 font-mono text-sm bg-bg text-text border-none outline-none resize-none"
            placeholder="Paste the spec brief here. This ephemeral layer feeds into the synthesized output but is not saved."
            spellCheck={false}
          />
        </div>
        <div className="flex-1 flex flex-col">
          <label className="px-3 py-2 text-xs font-medium text-muted border-b border-border">
            Story Annotations (L5)
          </label>
          <textarea
            value={l5}
            onChange={(e) => setL5(e.target.value)}
            className="flex-1 w-full p-3 font-mono text-sm bg-bg text-text border-none outline-none resize-none"
            placeholder="Per-story overrides and annotations. Ephemeral — not saved."
            spellCheck={false}
          />
        </div>
      </div>

      {/* Column 3: Synthesized preview (read-only) */}
      <div className="flex-1 flex flex-col bg-bg min-w-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted">
            Synthesized Output
            <span className="ml-2 text-muted opacity-60">
              {synthesized.length.toLocaleString()} chars
            </span>
          </span>
          <button
            onClick={handleCopy}
            className="px-2 py-1 text-xs text-muted hover:text-text transition-colors"
          >
            Copy
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {isSynthesizing ? (
            <div className="flex items-center gap-2 text-muted text-sm">
              <svg
                className="w-4 h-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Synthesizing...
            </div>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-sm text-text">
              {synthesized || <span className="text-muted">No output yet. Add content to layers above.</span>}
            </pre>
          )}
        </div>
      </div>

      {/* Bootstrap Context Modal */}
      {showBootstrap && workspaceId && (
        <BootstrapContextModal
          workspaceId={workspaceId}
          activeLayer={activeTab}
          onAccept={handleBootstrapAccept}
          onClose={() => setShowBootstrap(false)}
        />
      )}
    </div>
  );
}
