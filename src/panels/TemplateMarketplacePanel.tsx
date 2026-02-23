import { useState, useEffect, useCallback } from 'react';
import {
  Star,
  Loader2,
  FileText,
  User,
  TrendingUp,
  Filter,
  ChevronDown,
  ChevronUp,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

/* ─── Types ───────────────────────────────────────────────────────── */

interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  sourceSpecId: string;
  storyCount: number;
  createdAt: string;
  teamId: string | null;
  authorId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  usageCount: number;
  avgRating: number;
  ratingCount: number;
}

interface TemplateDetail extends TemplateSummary {
  brief: string;
  storyStructure: { id: string; title: string; description: string }[];
  directionLayers: Record<string, unknown> | null;
  userRating: number | null;
}

type ScopeFilter = 'all' | 'personal' | 'team';

/* ─── Helpers ────────────────────────────────────────────────────── */

function renderStars(rating: number, interactive: boolean = false, onRate?: (n: number) => void) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          onClick={interactive && onRate ? () => onRate(n) : undefined}
          disabled={!interactive}
          className={`${interactive ? 'cursor-pointer hover:scale-110' : 'cursor-default'} transition-transform`}
        >
          <Star
            size={14}
            className={n <= Math.round(rating) ? 'text-amber-400 fill-amber-400' : 'text-muted'}
          />
        </button>
      ))}
    </div>
  );
}

function relativeDate(ts: string): string {
  const now = Date.now();
  const then = new Date(ts + (ts.endsWith('Z') ? '' : 'Z')).getTime();
  const diff = now - then;

  if (diff < 86_400_000) return 'today';
  if (diff < 172_800_000) return 'yesterday';
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(then).toLocaleDateString();
}

/* ─── Component ──────────────────────────────────────────────────── */

export default function TemplateMarketplacePanel() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [ratingLoading, setRatingLoading] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ scope: scopeFilter });
      const data = await apiFetch<{ templates: TemplateSummary[] }>(`/api/templates?${params}`);
      setTemplates(data.templates);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
    } finally {
      setLoading(false);
    }
  }, [scopeFilter]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  // Fetch detail when a template is selected
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    apiFetch<TemplateDetail>(`/api/templates/${selectedId}`)
      .then(setDetail)
      .catch(console.error)
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  const handleRate = async (rating: number) => {
    if (!selectedId || !detail) return;
    setRatingLoading(true);
    try {
      const result = await apiFetch<{ avgRating: number; ratingCount: number; userRating: number }>(
        `/api/templates/${selectedId}/rate`,
        { method: 'POST', body: JSON.stringify({ rating }), headers: { 'Content-Type': 'application/json' } }
      );
      setDetail(prev => prev ? { ...prev, avgRating: result.avgRating, ratingCount: result.ratingCount, userRating: result.userRating } : prev);
      // Also update in list
      setTemplates(prev => prev.map(t => t.id === selectedId ? { ...t, avgRating: result.avgRating, ratingCount: result.ratingCount } : t));
    } catch (err) {
      console.error('Failed to rate template:', err);
    } finally {
      setRatingLoading(false);
    }
  };

  const featured = templates.filter(t => t.avgRating >= 4.0);
  const regular = templates.filter(t => t.avgRating < 4.0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-[var(--text)]">Template Marketplace</h1>
          <span className="text-xs text-muted">{templates.length} template{templates.length !== 1 ? 's' : ''}</span>
        </div>

        {/* Scope filters */}
        <div className="flex items-center gap-1.5">
          <Filter size={14} className="text-muted mr-1" />
          {(['all', 'personal', 'team'] as ScopeFilter[]).map(scope => (
            <button
              key={scope}
              onClick={() => setScopeFilter(scope)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors capitalize ${
                scopeFilter === scope
                  ? 'bg-accent text-white'
                  : 'bg-bg text-muted hover:text-[var(--text)]'
              }`}
            >
              {scope}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={24} className="animate-spin text-muted" />
          </div>
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted text-sm">
            <FileText size={32} className="mb-2 opacity-50" />
            <p>No templates found</p>
          </div>
        ) : (
          <div className="p-5">
            {/* Featured section */}
            {featured.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp size={14} className="text-amber-400" />
                  <h2 className="text-sm font-medium text-amber-400">Featured</h2>
                </div>
                <div className="grid gap-3">
                  {featured.map(t => (
                    <TemplateCard
                      key={t.id}
                      template={t}
                      featured
                      selected={selectedId === t.id}
                      onClick={() => setSelectedId(selectedId === t.id ? null : t.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Regular section */}
            {regular.length > 0 && (
              <div>
                {featured.length > 0 && (
                  <h2 className="text-sm font-medium text-muted mb-3">All Templates</h2>
                )}
                <div className="grid gap-3">
                  {regular.map(t => (
                    <TemplateCard
                      key={t.id}
                      template={t}
                      selected={selectedId === t.id}
                      onClick={() => setSelectedId(selectedId === t.id ? null : t.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {selectedId && (
        <div className="border-t border-border bg-panel shrink-0 max-h-[40%] overflow-y-auto">
          {detailLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 size={20} className="animate-spin text-muted" />
            </div>
          ) : detail ? (
            <div className="p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h2 className="text-base font-semibold text-[var(--text)]">{detail.name}</h2>
                  {detail.description && (
                    <p className="text-sm text-muted mt-1">{detail.description}</p>
                  )}
                </div>
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-muted hover:text-[var(--text)] transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Rating */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted">Your rating:</span>
                  {renderStars(detail.userRating ?? 0, !ratingLoading, handleRate)}
                </div>
                <span className="text-xs text-muted">
                  {detail.avgRating.toFixed(1)} avg ({detail.ratingCount} rating{detail.ratingCount !== 1 ? 's' : ''})
                </span>
              </div>

              {/* Brief */}
              <div className="mb-4">
                <h3 className="text-xs font-medium text-muted uppercase mb-1">Brief</h3>
                <p className="text-sm text-[var(--text)] bg-bg rounded p-3">{detail.brief}</p>
              </div>

              {/* Story structure */}
              <div>
                <h3 className="text-xs font-medium text-muted uppercase mb-2">
                  Stories ({detail.storyCount})
                </h3>
                <div className="space-y-1.5">
                  {detail.storyStructure.map(story => (
                    <div key={story.id} className="flex items-start gap-2 text-sm">
                      <span className="text-muted font-mono text-xs shrink-0 mt-0.5">{story.id}</span>
                      <span className="text-[var(--text)]">{story.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ─── Template Card ──────────────────────────────────────────────── */

function TemplateCard({
  template,
  featured,
  selected,
  onClick,
}: {
  template: TemplateSummary;
  featured?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-lg border transition-colors ${
        selected
          ? 'border-accent bg-accent/10'
          : featured
            ? 'border-amber-500/30 bg-amber-500/5 hover:border-amber-500/50'
            : 'border-border bg-panel hover:border-zinc-600'
      }`}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-[var(--text)] truncate">{template.name}</h3>
          {template.description && (
            <p className="text-xs text-muted mt-0.5 line-clamp-2">{template.description}</p>
          )}
        </div>
        {featured && (
          <Star size={14} className="text-amber-400 fill-amber-400 shrink-0 ml-2 mt-0.5" />
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-muted">
        {/* Author */}
        {template.authorName && (
          <span className="flex items-center gap-1">
            <User size={12} />
            {template.authorName}
          </span>
        )}

        {/* Story count */}
        <span className="flex items-center gap-1">
          <FileText size={12} />
          {template.storyCount} stories
        </span>

        {/* Usage */}
        <span className="flex items-center gap-1">
          <TrendingUp size={12} />
          {template.usageCount} uses
        </span>

        {/* Rating */}
        {template.ratingCount > 0 && (
          <span className="flex items-center gap-1">
            <Star size={12} className={template.avgRating >= 4.0 ? 'text-amber-400 fill-amber-400' : ''} />
            {template.avgRating.toFixed(1)}
            <span className="text-muted/60">({template.ratingCount})</span>
          </span>
        )}

        {/* Scope badge */}
        {template.teamId ? (
          <span className="ml-auto px-1.5 py-0.5 text-[10px] rounded bg-blue-500/20 text-blue-400">team</span>
        ) : (
          <span className="ml-auto px-1.5 py-0.5 text-[10px] rounded bg-border text-muted">personal</span>
        )}
      </div>
    </button>
  );
}
