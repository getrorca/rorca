import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search,
  X,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Archive,
  Download,
  Copy,
  Check,
  ChevronRight,
  Play,
  GitBranch,
  Loader2,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { StoryCard } from '../components/StoryCard';
import type { Story } from '../components/StoryCard';
import type { PanelId } from '../components/Sidebar';

/* ─── Types ───────────────────────────────────────────────────────── */

type SpecStatus = 'pending' | 'approved' | 'rejected';
type StatusFilter = 'all' | SpecStatus;
type PreviewTab = 'stories' | 'diagram' | 'json';

interface ArchiveSpec {
  id: string;
  specName: string;
  storyCount: number;
  status: SpecStatus;
  generatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectReason?: string;
  storyTitles: string[];
}

interface ArchiveResponse {
  specs: ArchiveSpec[];
  total: number;
  hasMore: boolean;
}

interface SpecDetail {
  title?: string;
  userStories?: Story[];
  stories?: Story[];
  diagrams?: Record<string, { mermaid?: string; ascii?: string }>;
  [key: string]: unknown;
}

/* ─── Constants ──────────────────────────────────────────────────── */

const PAGE_SIZE = 20;

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];

const STATUS_CONFIG: Record<SpecStatus, { label: string; icon: typeof CheckCircle2; className: string; dotClass: string }> = {
  approved: {
    label: 'APPROVED',
    icon: CheckCircle2,
    className: 'bg-success/15 text-success border-success/30',
    dotClass: 'bg-success',
  },
  pending: {
    label: 'PENDING',
    icon: AlertCircle,
    className: 'bg-warning/15 text-warning border-warning/30',
    dotClass: 'bg-warning',
  },
  rejected: {
    label: 'REJECTED',
    icon: XCircle,
    className: 'bg-error/15 text-error border-error/30',
    dotClass: 'bg-error',
  },
};

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function extractDiagramText(spec: SpecDetail): { text: string; type: 'mermaid' | 'ascii' } | null {
  if (!spec.diagrams) return null;
  for (const value of Object.values(spec.diagrams)) {
    if (typeof value === 'object' && value !== null) {
      if (value.mermaid) return { text: value.mermaid, type: 'mermaid' };
      if (value.ascii) return { text: value.ascii, type: 'ascii' };
    }
  }
  return null;
}

/* ─── Main Component ──────────────────────────────────────────────── */

export default function ArchivePanel({ onNavigate }: { onNavigate: (panel: PanelId) => void }) {
  const { workspaceId } = useWorkspace();

  const [specs, setSpecs] = useState<ArchiveSpec[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [specDetail, setSpecDetail] = useState<SpecDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // ─── Debounce search ────────────────────────────────────────────
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchText);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchText]);

  // ─── Fetch specs ────────────────────────────────────────────────
  const fetchSpecs = useCallback(async (offset = 0, append = false) => {
    if (!workspaceId) return;
    if (!append) setLoading(true);
    else setLoadingMore(true);
    setError('');

    try {
      const params = new URLSearchParams({
        workspaceId,
        status: statusFilter,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (debouncedSearch) params.set('q', debouncedSearch);

      const res = await apiFetch<ArchiveResponse>(`/api/specs/archive?${params}`);
      if (append) {
        setSpecs(prev => [...prev, ...res.specs]);
      } else {
        setSpecs(res.specs);
      }
      setTotal(res.total);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load specs');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [workspaceId, statusFilter, debouncedSearch]);

  useEffect(() => {
    setSelectedId(null);
    setSpecDetail(null);
    fetchSpecs(0, false);
  }, [fetchSpecs]);

  // ─── Fetch detail when selected ─────────────────────────────────
  useEffect(() => {
    if (!selectedId || !workspaceId) {
      setSpecDetail(null);
      return;
    }

    const selected = specs.find(s => s.id === selectedId);
    if (selected?.status === 'rejected') {
      setSpecDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    apiFetch<SpecDetail>(`/api/specs/${selectedId}?workspaceId=${workspaceId}`)
      .then(detail => {
        if (!cancelled) setSpecDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setSpecDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, workspaceId, specs]);

  // ─── Load more handler ─────────────────────────────────────────
  const handleLoadMore = () => {
    fetchSpecs(specs.length, true);
  };

  // ─── No workspace ──────────────────────────────────────────────
  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Select a workspace to view the spec archive
      </div>
    );
  }

  // ─── Error state ───────────────────────────────────────────────
  if (error && !loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-error mb-2">{error}</p>
          <button
            onClick={() => fetchSpecs()}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const selectedSpec = specs.find(s => s.id === selectedId);

  return (
    <div className="flex h-full overflow-hidden">
      {/* ─── Left: Search + Results ──────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Search bar (sticky) */}
        <div className="px-4 py-3 border-b border-border shrink-0 space-y-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="Search specs by name, story, or keyword..."
              className="w-full pl-9 pr-8 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 focus:outline-none focus:border-accent transition-colors"
            />
            {searchText && (
              <button
                onClick={() => setSearchText('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-text transition-colors"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Status filter pills */}
          <div className="flex gap-1.5">
            {STATUS_FILTERS.map(f => (
              <button
                key={f.id}
                onClick={() => setStatusFilter(f.id)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                  statusFilter === f.id
                    ? 'bg-accent text-white'
                    : 'bg-panel border border-border text-muted hover:text-text'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted text-sm">
              Loading specs...
            </div>
          ) : specs.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-border rounded-lg max-w-xs text-center">
                <Archive size={64} className="text-muted/40" strokeWidth={1.2} />
                <div>
                  {debouncedSearch ? (
                    <>
                      <p className="text-sm font-medium text-text mb-1">
                        No specs match &ldquo;{debouncedSearch}&rdquo;
                      </p>
                      <p className="text-xs text-muted">Try a different keyword</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-text mb-1">
                        No specs generated yet
                      </p>
                      <p className="text-xs text-muted">
                        Create your first in Spec Forge
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div>
              {specs.map(spec => {
                const cfg = STATUS_CONFIG[spec.status];
                const Icon = cfg.icon;
                return (
                  <button
                    key={spec.id}
                    onClick={() => setSelectedId(spec.id === selectedId ? null : spec.id)}
                    className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${
                      spec.id === selectedId ? 'bg-accent/10' : 'hover:bg-panel'
                    }`}
                  >
                    {/* Row 1: status badge + date + story count */}
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border ${cfg.className}`}>
                          <Icon size={10} />
                          {cfg.label}
                        </span>
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent">
                          {spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted flex items-center gap-1">
                          <Clock size={10} />
                          {formatDate(spec.generatedAt)}
                        </span>
                        <ChevronRight
                          size={14}
                          className={`shrink-0 text-muted transition-transform ${
                            spec.id === selectedId ? 'rotate-90' : ''
                          }`}
                        />
                      </div>
                    </div>

                    {/* Row 2: spec name */}
                    <div className="text-sm font-mono font-semibold text-text truncate mb-1">
                      {spec.specName}
                    </div>

                    {/* Row 3: first 2 story titles */}
                    {spec.storyTitles.length > 0 && (
                      <div className="space-y-0.5">
                        {spec.storyTitles.slice(0, 2).map((title, i) => (
                          <p key={i} className="text-xs text-muted truncate">
                            {spec.storyTitles.length > 0 ? `US-${String(i + 1).padStart(3, '0')}: ` : ''}{title}
                          </p>
                        ))}
                      </div>
                    )}

                    {/* Reject reason (if rejected) */}
                    {spec.status === 'rejected' && spec.rejectReason && (
                      <p className="text-xs text-error/70 mt-1 truncate">
                        Reason: {spec.rejectReason}
                      </p>
                    )}
                  </button>
                );
              })}

              {/* Pagination footer */}
              <div className="px-4 py-3 border-b border-border text-center">
                <p className="text-xs text-muted mb-2">
                  Showing {specs.length} of {total} specs
                </p>
                {hasMore && (
                  <button
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    className="px-4 py-1.5 text-xs font-medium rounded bg-panel border border-border text-text hover:bg-accent/10 transition-colors disabled:opacity-50"
                  >
                    {loadingMore ? 'Loading...' : 'Load more'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Right: Preview Drawer (desktop) ───────────────────── */}
      {selectedId && (
        <SpecPreviewDrawer
          specId={selectedId}
          summary={selectedSpec ?? null}
          detail={specDetail}
          detailLoading={detailLoading}
          onClose={() => { setSelectedId(null); setSpecDetail(null); }}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

/* ─── Spec Preview Drawer ──────────────────────────────────────────── */

type RunState = 'idle' | 'triggering' | 'conflict' | 'success' | 'error';

function SpecPreviewDrawer({
  specId,
  summary,
  detail,
  detailLoading,
  onClose,
  onNavigate,
}: {
  specId: string;
  summary: ArchiveSpec | null;
  detail: SpecDetail | null;
  detailLoading: boolean;
  onClose: () => void;
  onNavigate: (panel: PanelId) => void;
}) {
  const { workspaceId } = useWorkspace();
  const [activeTab, setActiveTab] = useState<PreviewTab>('stories');
  const [runState, setRunState] = useState<RunState>('idle');
  const [runError, setRunError] = useState('');

  const handleRun = async (autoWorktree = false) => {
    if (!workspaceId || !summary) return;
    setRunState('triggering');
    setRunError('');
    try {
      const res = await apiFetch<{ ok?: boolean; conflict?: boolean; activeRunId?: number; runId?: number }>(
        '/api/pipeline/trigger',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            specPath: `ralph/specs/approved/${summary.id}.json`,
            workspaceId,
            autoWorktree,
          }),
        }
      );
      if (res.conflict) {
        setRunState('conflict');
      } else {
        setRunState('success');
        setTimeout(() => onNavigate('pipeline'), 1200);
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to trigger run');
      setRunState('error');
    }
  };

  // Reset tab when spec changes
  useEffect(() => {
    setActiveTab('stories');
  }, [specId]);

  const stories = detail?.userStories ?? detail?.stories ?? [];
  const diagram = detail ? extractDiagramText(detail) : null;

  const tabs: { id: PreviewTab; label: string; badge?: string }[] = [
    { id: 'stories', label: 'Stories', badge: `${stories.length}` },
    { id: 'diagram', label: 'Diagram' },
    { id: 'json', label: 'Raw JSON' },
  ];

  const handleExportJson = () => {
    if (!detail) return;
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${specId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cfg = summary ? STATUS_CONFIG[summary.status] : null;

  return (
    <>
      {/* Backdrop (click to close) */}
      <div
        className="fixed inset-0 z-40 bg-black/20 xl:hidden"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-[480px] max-w-full bg-bg border-l border-border flex flex-col shadow-2xl animate-[slideInRight_200ms_ease-out]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 min-w-0">
              {cfg && (
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border shrink-0 ${cfg.className}`}>
                  {cfg.label}
                </span>
              )}
              <h3 className="text-base font-mono font-semibold text-text truncate">
                {summary?.specName ?? specId}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded text-muted hover:text-text hover:bg-panel transition-colors shrink-0"
            >
              <X size={16} />
            </button>
          </div>
          {summary && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Clock size={10} />
                {formatDate(summary.generatedAt)}
              </span>
              <span>{summary.storyCount} {summary.storyCount === 1 ? 'story' : 'stories'}</span>
            </div>
          )}
        </div>

        {/* Content */}
        {summary?.status === 'rejected' ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center p-8">
              <XCircle size={48} className="text-error/30 mx-auto mb-3" />
              <p className="text-sm text-muted mb-1">This spec was rejected</p>
              {summary.rejectReason && (
                <p className="text-xs text-error/70 mt-2">Reason: {summary.rejectReason}</p>
              )}
              <p className="text-xs text-muted mt-3">
                The spec file was removed. Only metadata remains in the event log.
              </p>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center text-muted text-sm">
            Loading spec...
          </div>
        ) : !detail ? (
          <div className="flex-1 flex items-center justify-center text-muted text-sm">
            Failed to load spec detail
          </div>
        ) : (
          <>
            {/* Tab strip */}
            <div className="flex border-b border-border shrink-0">
              {tabs.map(tab => (
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
                  {tab.badge && tab.badge !== '0' && (
                    <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-accent/15 text-accent">
                      {tab.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto">
              {activeTab === 'stories' && <StoriesTab stories={stories} />}
              {activeTab === 'diagram' && <DiagramTab diagram={diagram} />}
              {activeTab === 'json' && <JsonTab spec={detail} />}
            </div>
          </>
        )}

        {/* Footer actions */}
        {detail && summary?.status !== 'rejected' && (
          <div className="px-4 py-3 border-t border-border shrink-0 bg-bg space-y-2">
            {/* Run in Pipeline button — approved specs only */}
            {summary?.status === 'approved' && (
              <div>
                {runState === 'conflict' ? (
                  <div className="rounded border border-warning/30 bg-warning/10 p-3 space-y-2">
                    <p className="text-xs text-warning font-medium">Active run in progress. Run in a new worktree?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRun(true)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90 transition-opacity"
                      >
                        <GitBranch size={12} />
                        Run in worktree
                      </button>
                      <button
                        onClick={() => setRunState('idle')}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : runState === 'success' ? (
                  <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30">
                    <Check size={14} />
                    Switching to Pipeline Monitor...
                  </div>
                ) : (
                  <button
                    onClick={() => handleRun(false)}
                    disabled={runState === 'triggering'}
                    className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-60"
                  >
                    {runState === 'triggering' ? (
                      <><Loader2 size={14} className="animate-spin" /> Starting run...</>
                    ) : (
                      <><Play size={14} /> Run in Pipeline</>
                    )}
                  </button>
                )}
                {runState === 'error' && (
                  <p className="text-xs text-error mt-1">{runError}</p>
                )}
              </div>
            )}

            <button
              onClick={handleExportJson}
              className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors"
            >
              <Download size={14} />
              Export JSON
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Stories Tab ──────────────────────────────────────────────────── */

function StoriesTab({ stories }: { stories: Story[] }) {
  if (stories.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No stories found in this spec
      </div>
    );
  }

  return (
    <div className="p-4 space-y-2">
      <span className="text-xs text-muted">
        {stories.length} {stories.length === 1 ? 'story' : 'stories'}
      </span>
      {stories.map(story => (
        <StoryCard key={story.id} story={story} />
      ))}
    </div>
  );
}

/* ─── Diagram Tab ─────────────────────────────────────────────────── */

function DiagramTab({
  diagram,
}: {
  diagram: { text: string; type: 'mermaid' | 'ascii' } | null;
}) {
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState('');
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    if (!diagram || diagram.type !== 'mermaid' || !mermaidRef.current) return;
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
        const id = `mermaid-archive-${Date.now()}`;
        const { svg } = await mermaid.render(id, diagram.text);
        if (!cancelled) {
          setSvgContent(svg);
          setRenderError('');
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : 'Failed to render');
          setSvgContent('');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [diagram]);

  if (!diagram) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No diagram available for this spec
      </div>
    );
  }

  if (diagram.type === 'ascii') {
    return (
      <div className="p-4">
        <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre">
          {diagram.text}
        </pre>
      </div>
    );
  }

  return (
    <div className="p-4">
      {renderError ? (
        <div className="text-sm text-error">
          <p className="font-medium mb-1">Render error</p>
          <pre className="text-xs font-mono whitespace-pre-wrap">{renderError}</pre>
        </div>
      ) : (
        <div
          ref={mermaidRef}
          className="border border-border rounded bg-panel p-4 overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      )}
    </div>
  );
}

/* ─── Raw JSON Tab ────────────────────────────────────────────────── */

function JsonTab({ spec }: { spec: SpecDetail }) {
  const [copied, setCopied] = useState(false);
  const rawJson = JSON.stringify(spec, null, 2);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(rawJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [rawJson]);

  return (
    <div className="p-4">
      <div className="relative">
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded bg-panel border border-border text-muted hover:text-text transition-colors z-10"
          title="Copy JSON"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre max-h-[70vh] overflow-y-auto">
          {rawJson}
        </pre>
      </div>
    </div>
  );
}
