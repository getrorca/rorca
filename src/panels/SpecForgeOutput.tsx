import { useState, useEffect, useRef, useCallback } from 'react';
import { Wand2, ChevronDown, ChevronRight, Copy, Check, RefreshCw, Save, ExternalLink } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { StoryCard } from '../components/StoryCard';
import type { Story } from '../components/StoryCard';

/* ─── Types ───────────────────────────────────────────────────────── */

export type { Story };

export interface GeneratedSpec {
  specName: string;
  stories: Story[];
  diagram?: string;
  diagramType?: 'mermaid-flowchart' | 'mermaid-sequence' | 'ascii';
  savedPath?: string;
  generatedAt: string;
  contextUsed?: string;
}

type Tab = 'stories' | 'diagram' | 'save' | 'context';

/* ─── Main Component ──────────────────────────────────────────────── */

export default function SpecForgeOutput({ spec, onOpenTemplatePicker }: { spec: GeneratedSpec | null; onOpenTemplatePicker?: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>('stories');

  if (!spec) {
    return <EmptyState onOpenTemplatePicker={onOpenTemplatePicker} />;
  }

  const tabs: { id: Tab; label: string; badge?: string }[] = [
    { id: 'stories', label: 'Stories', badge: `${spec.stories.length}` },
    { id: 'diagram', label: 'Diagram' },
    { id: 'save', label: 'Save' },
    { id: 'context', label: 'Context Used' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'text-text border-accent'
                : 'text-muted hover:text-text border-transparent'
            }`}
          >
            {tab.label}
            {tab.badge && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-accent/15 text-accent">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'stories' && <StoriesTab stories={spec.stories} />}
        {activeTab === 'diagram' && (
          <DiagramTab
            diagram={spec.diagram}
            diagramType={spec.diagramType}
            specName={spec.specName}
          />
        )}
        {activeTab === 'save' && <SaveTab spec={spec} />}
        {activeTab === 'context' && <ContextTab context={spec.contextUsed} />}
      </div>
    </div>
  );
}

/* ─── Empty State ─────────────────────────────────────────────────── */

function EmptyState({ onOpenTemplatePicker }: { onOpenTemplatePicker?: () => void }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-border rounded-lg max-w-xs text-center">
        <Wand2 size={64} className="text-muted/40" strokeWidth={1.2} />
        <div>
          <p className="text-sm font-medium text-text mb-1">
            Write a brief and hit Generate
          </p>
          <p className="text-xs text-muted">Your generated spec will appear here</p>
        </div>
        {onOpenTemplatePicker && (
          <button
            onClick={onOpenTemplatePicker}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            Start from template &rarr;
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Stories Tab ─────────────────────────────────────────────────── */

function StoriesTab({ stories }: { stories: Story[] }) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const allStoryIds = new Set(stories.map(s => s.id));

  const rawJson = JSON.stringify(stories, null, 2);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(rawJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [rawJson]);

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">
          {stories.length} {stories.length === 1 ? 'story' : 'stories'}
        </span>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-xs text-muted hover:text-text transition-colors"
        >
          {showRaw ? 'Card view' : 'Raw JSON'}
        </button>
      </div>

      {showRaw ? (
        <div className="relative">
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1.5 rounded bg-panel border border-border text-muted hover:text-text transition-colors"
            title="Copy JSON"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre">
            {rawJson}
          </pre>
        </div>
      ) : (
        <div className="space-y-2">
          {stories.map((story) => (
            <StoryCard key={story.id} story={story} allStoryIds={allStoryIds} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Diagram Tab ─────────────────────────────────────────────────── */

function DiagramTab({
  diagram,
  diagramType,
  specName,
}: {
  diagram?: string;
  diagramType?: GeneratedSpec['diagramType'];
  specName: string;
}) {
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState('');
  const [renderError, setRenderError] = useState('');

  const isMermaid = diagramType === 'mermaid-flowchart' || diagramType === 'mermaid-sequence';

  // Render mermaid diagram
  useEffect(() => {
    if (!diagram || !isMermaid || !mermaidRef.current) return;

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
        const { svg } = await mermaid.render(id, diagram);
        if (!cancelled) {
          setSvgContent(svg);
          setRenderError('');
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : 'Failed to render diagram');
          setSvgContent('');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [diagram, isMermaid]);

  const handleCopy = useCallback(async () => {
    if (!diagram) return;
    await navigator.clipboard.writeText(diagram);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [diagram]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await apiFetch('/api/specs/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specName, diagramOnly: true }),
      });
    } catch (err) {
      console.error('Regenerate diagram failed:', err);
    } finally {
      setRegenerating(false);
    }
  };

  if (!diagram) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No diagram was generated. Enable &quot;Include diagram&quot; and regenerate.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">
          {isMermaid ? 'Mermaid' : 'ASCII'} diagram
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-text border border-border rounded transition-colors"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            Copy source
          </button>
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-text border border-border rounded transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={regenerating ? 'animate-spin' : ''} />
            Regenerate
          </button>
        </div>
      </div>

      {/* Rendered diagram */}
      {isMermaid ? (
        <div className="border border-border rounded bg-panel p-4 overflow-x-auto">
          {renderError ? (
            <div className="text-sm text-error">
              <p className="font-medium mb-1">Render error</p>
              <pre className="text-xs font-mono whitespace-pre-wrap">{renderError}</pre>
            </div>
          ) : (
            <div ref={mermaidRef} dangerouslySetInnerHTML={{ __html: svgContent }} />
          )}
        </div>
      ) : (
        <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre">
          {diagram}
        </pre>
      )}

      {/* Collapsible raw source (for mermaid only) */}
      {isMermaid && (
        <div>
          <button
            onClick={() => setShowSource(!showSource)}
            className="flex items-center gap-1 text-xs text-muted hover:text-text transition-colors"
          >
            {showSource ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Mermaid source
          </button>
          {showSource && (
            <pre className="mt-2 p-3 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre">
              {diagram}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Save Tab ────────────────────────────────────────────────────── */

function SaveTab({ spec }: { spec: GeneratedSpec }) {
  const { workspaceId, workspaces } = useWorkspace();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState(spec.savedPath || '');
  const [error, setError] = useState('');
  const [copiedJson, setCopiedJson] = useState(false);

  const destPath = workspace
    ? `${workspace.git_path}/specs/${spec.specName}.json`
    : `specs/${spec.specName}.json`;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await apiFetch<{ path: string }>(`/api/specs/${spec.specName}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setSavedPath(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyJson = useCallback(async () => {
    const prdJson = JSON.stringify(
      { specName: spec.specName, stories: spec.stories, generatedAt: spec.generatedAt },
      null,
      2
    );
    await navigator.clipboard.writeText(prdJson);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  }, [spec]);

  return (
    <div className="p-4 space-y-6">
      {/* Destination path */}
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
          Target Workspace
        </h4>
        <span className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-accent/10 text-accent border border-accent/20">
          {workspace?.name ?? 'No workspace'}
        </span>
      </section>

      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
          Spec File Destination
        </h4>
        <code className="block px-3 py-2 text-xs font-mono bg-panel border border-border rounded text-muted break-all">
          {destPath}
        </code>
      </section>

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving || !!savedPath}
        className={`w-full flex items-center justify-center gap-2 py-2.5 rounded text-sm font-medium transition-colors ${
          savedPath
            ? 'bg-success/15 text-success border border-success/30 cursor-default'
            : saving
              ? 'bg-accent/30 text-white/40 cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
        }`}
      >
        <Save size={14} />
        {savedPath ? 'Saved' : saving ? 'Saving...' : 'Save Spec to Workspace'}
      </button>

      {error && (
        <p className="text-xs text-error">{error}</p>
      )}

      {/* Success banner */}
      {savedPath && (
        <div className="p-3 bg-success/10 border border-success/20 rounded">
          <p className="text-xs text-success font-medium mb-1">Spec saved successfully</p>
          <code className="block px-2 py-1.5 text-xs font-mono bg-panel border border-border rounded text-text break-all">
            {savedPath}
          </code>
        </div>
      )}

      {/* Copy PRD JSON */}
      <section className="pt-2 border-t border-border">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
          Export
        </h4>
        <button
          onClick={handleCopyJson}
          className="flex items-center gap-2 px-3 py-2 text-xs text-muted hover:text-text border border-border rounded transition-colors"
        >
          {copiedJson ? <Check size={12} /> : <Copy size={12} />}
          Copy PRD JSON
        </button>
      </section>

      {/* Ralph stub */}
      <section className="pt-2 border-t border-border">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
          Run in Ralph Loop
        </h4>
        <button
          disabled
          className="flex items-center gap-2 px-3 py-2 text-xs text-muted/50 border border-border/50 rounded cursor-not-allowed"
        >
          <ExternalLink size={12} />
          Connect to Pipeline Monitor
        </button>
        <p className="mt-1.5 text-[10px] text-muted/50">Coming in Phase 3</p>
      </section>
    </div>
  );
}

/* ─── Context Used Tab ────────────────────────────────────────────── */

function ContextTab({ context }: { context?: string }) {
  const [expanded, setExpanded] = useState(false);

  if (!context) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No context data available for this generation.
      </div>
    );
  }

  const charCount = context.length;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Synthesized Direction Stack
        </h4>
        <span className="text-[10px] text-muted font-mono">
          {charCount.toLocaleString()} chars
        </span>
      </div>

      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-muted hover:text-text transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? 'Hide full context' : 'Show full context'}
      </button>

      {expanded && (
        <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre-wrap max-h-[70vh] overflow-y-auto">
          {context}
        </pre>
      )}
    </div>
  );
}
