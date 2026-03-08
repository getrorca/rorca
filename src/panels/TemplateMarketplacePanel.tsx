import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search,
  Download,
  GitFork,
  TrendingUp,
  User,
  X,
  Loader2,
  Tag,
  BookOpen,
  Trash2,
  Globe,
  CheckCircle,
  AlertTriangle,
  ChevronRight,
  FileText,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { useAppNavigate } from '../routes';


/* ─── Tab type ─────────────────────────────────────────────────── */

type MarketplaceTab = 'discover' | 'my-published' | 'popular';

/* ─── API Types ────────────────────────────────────────────────── */

interface Publication {
  id: string;
  spec_id: string;
  title: string;
  description: string;
  tags: string[];
  download_count: number;
  source: string;
  created_at: string;
  snippet?: string;
}

interface PublicationDetail extends Publication {
  sanitized_spec_json: {
    userStories?: { id: string; title: string; description: string }[];
    [key: string]: unknown;
  };
  redaction_count: number;
}

/* ─── Helpers ──────────────────────────────────────────────────── */

function relativeDate(ts: string): string {
  const now = Date.now();
  const then = new Date(ts.endsWith('Z') ? ts : ts + 'Z').getTime();
  const diff = now - then;
  if (diff < 86_400_000) return 'today';
  if (diff < 172_800_000) return 'yesterday';
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(then).toLocaleDateString();
}

/* ─── Spec Card ────────────────────────────────────────────────── */

interface SpecCardProps {
  pub: Publication;
  selected: boolean;
  onSelect: () => void;
  onFork?: () => void;
}

function SpecCard({ pub, selected, onSelect, onFork }: SpecCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`View details for ${pub.title}`}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`relative flex flex-col gap-2 p-4 rounded-lg border cursor-pointer transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        selected
          ? 'border-accent bg-accent/5'
          : 'border-border bg-panel hover:border-accent/50 hover:bg-accent/5'
      }`}
    >
      {/* Title + downloads */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--text)] leading-tight line-clamp-2 flex-1">
          {pub.title}
        </h3>
        <div
          className="flex items-center gap-1 text-xs text-muted shrink-0"
          aria-label={`${pub.download_count} forks`}
        >
          <Download size={11} />
          <span>{pub.download_count}</span>
        </div>
      </div>

      {/* Description — 2 lines max */}
      {pub.description && (
        <p className="text-xs text-muted line-clamp-2 leading-relaxed">{pub.description}</p>
      )}

      {/* Tags */}
      {pub.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {pub.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-bg text-muted border border-border"
            >
              <Tag size={9} />
              {tag}
            </span>
          ))}
          {pub.tags.length > 4 && (
            <span className="text-[10px] text-muted">+{pub.tags.length - 4}</span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-auto pt-1">
        <span className="text-[10px] text-muted">{relativeDate(pub.created_at)}</span>
        {onFork && (
          <button
            aria-label={`Fork ${pub.title}`}
            onClick={(e) => { e.stopPropagation(); onFork(); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            <GitFork size={11} />
            Fork
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Detail Slide-Over ────────────────────────────────────────── */

interface DetailPanelProps {
  pub: Publication;
  onClose: () => void;
  onFork: (pub: Publication) => void;
}

function DetailPanel({ pub, onClose, onFork }: DetailPanelProps) {
  const [detail, setDetail] = useState<PublicationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    apiFetch<PublicationDetail>(`/api/marketplace/${pub.id}`)
      .then(setDetail)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [pub.id]);

  const stories = detail?.sanitized_spec_json?.userStories ?? [];

  return (
    <div className="border-t border-border bg-panel shrink-0 max-h-[55%] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="text-accent shrink-0" />
          <span className="text-sm font-semibold text-[var(--text)] truncate">{pub.title}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            aria-label="View sanitized JSON"
            onClick={() => setShowJson((s) => !s)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              showJson ? 'border-accent text-accent bg-accent/5' : 'border-border text-muted hover:text-[var(--text)]'
            }`}
          >
            {showJson ? 'Stories' : 'JSON'}
          </button>
          <button
            aria-label="Fork this spec"
            onClick={() => onFork(pub)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-accent text-white hover:bg-accent/80 transition-colors"
          >
            <GitFork size={12} />
            Fork
          </button>
          <button
            aria-label="Close detail panel"
            onClick={onClose}
            className="p-1 rounded text-muted hover:text-[var(--text)] transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-24">
            <Loader2 size={18} className="animate-spin text-muted" />
          </div>
        ) : detail === null ? (
          <p className="text-xs text-muted text-center">Failed to load details.</p>
        ) : showJson ? (
          <pre className="text-[10px] text-muted font-mono overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(detail.sanitized_spec_json, null, 2)}
          </pre>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Meta */}
            <div className="flex flex-wrap gap-3 text-xs text-muted">
              <span className="flex items-center gap-1"><Download size={11} />{detail.download_count} forks</span>
              <span className="flex items-center gap-1"><BookOpen size={11} />{stories.length} stories</span>
              {detail.redaction_count > 0 && (
                <span className="flex items-center gap-1 text-amber-500">
                  <CheckCircle size={11} />{detail.redaction_count} PII redacted
                </span>
              )}
            </div>

            {/* Description */}
            {detail.description && (
              <p className="text-xs text-muted leading-relaxed">{detail.description}</p>
            )}

            {/* Tags */}
            {detail.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {detail.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] bg-bg text-muted border border-border"
                  >
                    <Tag size={9} />
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {/* Stories */}
            {stories.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-[var(--text)] mb-2">
                  User Stories ({stories.length})
                </h4>
                <div className="flex flex-col gap-1.5">
                  {stories.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-start gap-2 px-3 py-2 rounded bg-bg border border-border text-xs"
                    >
                      <ChevronRight size={12} className="text-muted mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <span className="font-medium text-[var(--text)]">{s.title}</span>
                        {s.description && (
                          <p className="text-muted mt-0.5 line-clamp-2">{s.description}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Fork Confirmation Dialog ─────────────────────────────────── */

interface ForkDialogProps {
  pub: Publication;
  workspaceId: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}

function ForkDialog({ pub, workspaceId, onConfirm, onCancel, loading }: ForkDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Fork ${pub.title}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full p-5">
        <div className="flex items-center gap-2 mb-3">
          <GitFork size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-[var(--text)]">Fork spec?</h3>
        </div>
        <p className="text-xs text-muted mb-4 leading-relaxed">
          <span className="font-medium text-[var(--text)]">{pub.title}</span> will be copied into
          your active workspace as a pending spec. You can review and edit it before running.
        </p>
        {!workspaceId && (
          <div className="flex items-center gap-2 mb-4 p-2 rounded bg-amber-500/10 border border-amber-500/30 text-xs text-amber-600">
            <AlertTriangle size={12} />
            No workspace selected. Select a workspace first.
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            aria-label="Cancel fork"
            onClick={onCancel}
            disabled={loading}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            aria-label="Confirm fork"
            onClick={onConfirm}
            disabled={loading || !workspaceId}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <GitFork size={12} />}
            Fork & Review
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Unpublish Confirmation Dialog ────────────────────────────── */

interface UnpublishDialogProps {
  pub: Publication;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}

function UnpublishDialog({ pub, onConfirm, onCancel, loading }: UnpublishDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Unpublish ${pub.title}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full p-5">
        <div className="flex items-center gap-2 mb-3">
          <Trash2 size={16} className="text-red-500" />
          <h3 className="text-sm font-semibold text-[var(--text)]">Unpublish spec?</h3>
        </div>
        <p className="text-xs text-muted mb-4 leading-relaxed">
          <span className="font-medium text-[var(--text)]">{pub.title}</span> will be removed from
          the community marketplace. This cannot be undone.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            aria-label="Cancel unpublish"
            onClick={onCancel}
            disabled={loading}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            aria-label="Confirm unpublish"
            onClick={onConfirm}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            Unpublish
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Empty State ──────────────────────────────────────────────── */

function EmptyState({ icon: Icon, message }: { icon: typeof Globe; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
      <div className="p-3 rounded-full bg-bg border border-border">
        <Icon size={20} className="text-muted" />
      </div>
      <p className="text-xs text-muted max-w-[200px] leading-relaxed">{message}</p>
    </div>
  );
}

/* ─── Discover Tab ─────────────────────────────────────────────── */

function DiscoverTab() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();
  const navigate = useAppNavigate();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPub, setSelectedPub] = useState<Publication | null>(null);
  const [forkTarget, setForkTarget] = useState<Publication | null>(null);
  const [forking, setForking] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, limit: '30' });
      const data = await apiFetch<{ items: Publication[]; total: number }>(
        `/api/marketplace/search?${params}`
      );
      setResults(data.items);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    doSearch('');
  }, [doSearch]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  const handleFork = async () => {
    if (!forkTarget || !workspaceId) return;
    setForking(true);
    try {
      await apiFetch<{ specId: string; path: string }>(
        `/api/marketplace/${forkTarget.id}/fork`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId }),
        }
      );
      setForkTarget(null);
      toast.show(`Forked "${forkTarget.title}" — check Review Queue`, 'success');
      navigate('queue');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fork failed';
      toast.show(msg, 'error');
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Search bar */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            aria-label="Search community specs"
            placeholder="Search community specs..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-xs rounded-lg bg-bg border border-border text-[var(--text)] placeholder:text-muted focus:outline-none focus:border-accent"
          />
          {loading && (
            <Loader2 size={12} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted" />
          )}
        </div>
      </div>

      {/* Results + detail */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto p-4">
          {!loading && results.length === 0 ? (
            <EmptyState
              icon={Globe}
              message="Search for community specs or browse popular ones"
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {results.map((pub) => (
                <SpecCard
                  key={pub.id}
                  pub={pub}
                  selected={selectedPub?.id === pub.id}
                  onSelect={() => setSelectedPub((s) => (s?.id === pub.id ? null : pub))}
                  onFork={() => setForkTarget(pub)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail slide-over */}
        {selectedPub && (
          <DetailPanel
            pub={selectedPub}
            onClose={() => setSelectedPub(null)}
            onFork={setForkTarget}
          />
        )}
      </div>

      {/* Fork dialog */}
      {forkTarget && (
        <ForkDialog
          pub={forkTarget}
          workspaceId={workspaceId}
          onConfirm={handleFork}
          onCancel={() => setForkTarget(null)}
          loading={forking}
        />
      )}
    </div>
  );
}

/* ─── My Published Tab ─────────────────────────────────────────── */

function MyPublishedTab() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();
  const navigate = useAppNavigate();

  const [items, setItems] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPub, setSelectedPub] = useState<Publication | null>(null);
  const [unpublishTarget, setUnpublishTarget] = useState<Publication | null>(null);
  const [unpublishing, setUnpublishing] = useState(false);
  const [forkTarget, setForkTarget] = useState<Publication | null>(null);
  const [forking, setForking] = useState(false);

  const fetchMy = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ items: Publication[]; total: number }>('/api/marketplace/my');
      setItems(data.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMy(); }, [fetchMy]);

  const handleUnpublish = async () => {
    if (!unpublishTarget) return;
    setUnpublishing(true);
    try {
      await apiFetch(`/api/marketplace/${unpublishTarget.id}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((p) => p.id !== unpublishTarget.id));
      if (selectedPub?.id === unpublishTarget.id) setSelectedPub(null);
      toast.show(`"${unpublishTarget.title}" unpublished`, 'success');
      setUnpublishTarget(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unpublish failed';
      toast.show(msg, 'error');
    } finally {
      setUnpublishing(false);
    }
  };

  const handleFork = async () => {
    if (!forkTarget || !workspaceId) return;
    setForking(true);
    try {
      await apiFetch<{ specId: string; path: string }>(
        `/api/marketplace/${forkTarget.id}/fork`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId }),
        }
      );
      setForkTarget(null);
      toast.show(`Forked "${forkTarget.title}" — check Review Queue`, 'success');
      navigate('queue');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fork failed';
      toast.show(msg, 'error');
    } finally {
      setForking(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={18} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <EmptyState
              icon={User}
              message="You haven't published any specs yet"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((pub) => (
                <div
                  key={pub.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`View details for ${pub.title}`}
                  onClick={() => setSelectedPub((s) => (s?.id === pub.id ? null : pub))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedPub((s) => (s?.id === pub.id ? null : pub));
                    }
                  }}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    selectedPub?.id === pub.id
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-panel hover:border-accent/30'
                  }`}
                >
                  <FileText size={14} className="text-accent shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--text)] truncate">{pub.title}</p>
                    <div className="flex items-center gap-3 mt-0.5 text-[10px] text-muted">
                      <span>Published {relativeDate(pub.created_at)}</span>
                      <span className="flex items-center gap-1">
                        <Download size={9} />
                        {pub.download_count} forks
                      </span>
                    </div>
                  </div>
                  <button
                    aria-label={`Unpublish ${pub.title}`}
                    onClick={(e) => { e.stopPropagation(); setUnpublishTarget(pub); }}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-muted hover:text-red-500 hover:border-red-500/30 transition-colors"
                  >
                    <Trash2 size={11} />
                    Unpublish
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detail slide-over */}
        {selectedPub && (
          <DetailPanel
            pub={selectedPub}
            onClose={() => setSelectedPub(null)}
            onFork={setForkTarget}
          />
        )}
      </div>

      {/* Dialogs */}
      {unpublishTarget && (
        <UnpublishDialog
          pub={unpublishTarget}
          onConfirm={handleUnpublish}
          onCancel={() => setUnpublishTarget(null)}
          loading={unpublishing}
        />
      )}
      {forkTarget && (
        <ForkDialog
          pub={forkTarget}
          workspaceId={workspaceId}
          onConfirm={handleFork}
          onCancel={() => setForkTarget(null)}
          loading={forking}
        />
      )}
    </div>
  );
}

/* ─── Popular Tab ──────────────────────────────────────────────── */

function PopularTab() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();
  const navigate = useAppNavigate();

  const [items, setItems] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPub, setSelectedPub] = useState<Publication | null>(null);
  const [forkTarget, setForkTarget] = useState<Publication | null>(null);
  const [forking, setForking] = useState(false);

  useEffect(() => {
    apiFetch<{ items: Publication[]; total: number }>('/api/marketplace/popular')
      .then((d) => setItems(d.items))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleFork = async () => {
    if (!forkTarget || !workspaceId) return;
    setForking(true);
    try {
      await apiFetch<{ specId: string; path: string }>(
        `/api/marketplace/${forkTarget.id}/fork`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId }),
        }
      );
      setForkTarget(null);
      toast.show(`Forked "${forkTarget.title}" — check Review Queue`, 'success');
      navigate('queue');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fork failed';
      toast.show(msg, 'error');
    } finally {
      setForking(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={18} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <EmptyState
              icon={TrendingUp}
              message="No community specs published yet"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((pub, idx) => (
                <div
                  key={pub.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`View details for ${pub.title}, ranked #${idx + 1}`}
                  onClick={() => setSelectedPub((s) => (s?.id === pub.id ? null : pub))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedPub((s) => (s?.id === pub.id ? null : pub));
                    }
                  }}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    selectedPub?.id === pub.id
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-panel hover:border-accent/30'
                  }`}
                >
                  {/* Rank badge */}
                  <div
                    aria-hidden="true"
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                      idx === 0
                        ? 'bg-amber-400/20 text-amber-500'
                        : idx === 1
                        ? 'bg-zinc-400/20 text-zinc-500'
                        : idx === 2
                        ? 'bg-orange-400/20 text-orange-500'
                        : 'bg-bg text-muted border border-border'
                    }`}
                  >
                    {idx + 1}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--text)] truncate">{pub.title}</p>
                    {pub.description && (
                      <p className="text-[10px] text-muted truncate mt-0.5">{pub.description}</p>
                    )}
                  </div>

                  {/* Download count */}
                  <div
                    className="flex items-center gap-1 text-xs text-muted shrink-0"
                    aria-label={`${pub.download_count} forks`}
                  >
                    <Download size={11} />
                    <span>{pub.download_count}</span>
                  </div>

                  <button
                    aria-label={`Fork ${pub.title}`}
                    onClick={(e) => { e.stopPropagation(); setForkTarget(pub); }}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                  >
                    <GitFork size={11} />
                    Fork
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detail slide-over */}
        {selectedPub && (
          <DetailPanel
            pub={selectedPub}
            onClose={() => setSelectedPub(null)}
            onFork={setForkTarget}
          />
        )}
      </div>

      {/* Fork dialog */}
      {forkTarget && (
        <ForkDialog
          pub={forkTarget}
          workspaceId={workspaceId}
          onConfirm={handleFork}
          onCancel={() => setForkTarget(null)}
          loading={forking}
        />
      )}
    </div>
  );
}

/* ─── Main Export ──────────────────────────────────────────────── */

const TABS: { id: MarketplaceTab; label: string; icon: typeof Globe }[] = [
  { id: 'discover', label: 'Discover', icon: Search },
  { id: 'my-published', label: 'My Published', icon: User },
  { id: 'popular', label: 'Popular', icon: TrendingUp },
];

export default function TemplateMarketplacePanel() {
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('discover');

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text)] mb-1">Marketplace</h1>
        <p className="text-xs text-muted mb-3">
          Discover, publish, and fork community specs. Fork any spec into your workspace to run it as-is or customize it.
        </p>
        <div className="flex items-center gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-label={`${label} tab`}
              aria-selected={activeTab === id}
              role="tab"
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full transition-colors ${
                activeTab === id
                  ? 'bg-accent text-white'
                  : 'bg-bg text-muted hover:text-[var(--text)]'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'discover' && <DiscoverTab />}
        {activeTab === 'my-published' && <MyPublishedTab />}
        {activeTab === 'popular' && <PopularTab />}
      </div>
    </div>
  );
}
