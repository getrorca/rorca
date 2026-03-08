import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Star,
  Loader2,
  FileText,
  User,
  TrendingUp,
  Filter,
  X,
  Package,
  Wrench,
  Download,
  GitFork,
  Trash2,
  Check,
  FolderTree,
  Users,
  BookOpen,
  Layers,
  ChevronRight,
  AlertTriangle,
  Search,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { renderMarkdown } from '../lib/renderMarkdown';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';

/* ─── Marketplace Tab Type ─────────────────────────────────────── */

type MarketplaceTab = 'skills' | 'starters';

/* ─── Shared Types ─────────────────────────────────────────────── */

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

/* ─── Pack Types ───────────────────────────────────────────────── */

interface CatalogPack {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  frameworks: string[];
  skills: string[];
  packPath: string;
  installed: boolean;
  hasPersonas: boolean;
  hasConventions: boolean;
  hasScaffold: boolean;
  hasAgentsMd: boolean;
}

interface InstalledPack {
  id: number;
  packName: string;
  packVersion: string;
  installedAt: string;
  packPath: string;
  forkedFrom: string | null;
  valid: boolean;
}

interface PackDetail {
  metadata: {
    name: string;
    version: string;
    description: string;
    author?: string;
    license?: string;
    compatibility: { node?: string; frameworks: string[] };
    dependencies: { name: string; version?: string }[];
    skills: string[];
  };
  directionLayers: { filename: string; preview: string }[];
  personas: string[];
  conventions: string[];
  scaffoldTree: string[];
  agentsMdPreview: string | null;
}

/* ─── Skill Types ──────────────────────────────────────────────── */

interface SkillSummary {
  name: string;
  description: string;
  source: string;
  filePath: string;
}

/* ─── Helpers ──────────────────────────────────────────────────── */

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

/* ─── Main Component ───────────────────────────────────────────── */

export default function TemplateMarketplacePanel() {
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('skills');

  const TABS: { id: MarketplaceTab; label: string; icon: typeof Package }[] = [
    { id: 'skills', label: 'Skills', icon: Wrench },
    { id: 'starters', label: 'Starters', icon: Package },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with tabs */}
      <div className="px-5 py-4 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text)] mb-1">Skills</h1>
        <p className="text-xs text-muted mb-3">Browse and install skills from the community to make your AI agents smarter.</p>
        <div className="flex items-center gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
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
        {activeTab === 'skills' && <SkillsTab />}
        {activeTab === 'starters' && <PacksTab />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TEMPLATES TAB — preserved from original TemplateMarketplacePanel
   ═══════════════════════════════════════════════════════════════════ */

function TemplatesTab() {
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
      const data = await apiFetch<{ items: TemplateSummary[]; total: number; hasMore: boolean; cursor?: string }>(`/api/templates?${params}`);
      setTemplates(data.items);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
    } finally {
      setLoading(false);
    }
  }, [scopeFilter]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
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
      {/* Scope filters */}
      <div className="px-5 py-3 border-b border-border shrink-0">
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
          <span className="ml-auto text-xs text-muted">{templates.length} template{templates.length !== 1 ? 's' : ''}</span>
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
            {featured.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp size={14} className="text-amber-400" />
                  <h2 className="text-sm font-medium text-amber-400">Featured</h2>
                </div>
                <div className="grid gap-3">
                  {featured.map(t => (
                    <TemplateCard key={t.id} template={t} featured selected={selectedId === t.id} onClick={() => setSelectedId(selectedId === t.id ? null : t.id)} />
                  ))}
                </div>
              </div>
            )}
            {regular.length > 0 && (
              <div>
                {featured.length > 0 && <h2 className="text-sm font-medium text-muted mb-3">All Templates</h2>}
                <div className="grid gap-3">
                  {regular.map(t => (
                    <TemplateCard key={t.id} template={t} selected={selectedId === t.id} onClick={() => setSelectedId(selectedId === t.id ? null : t.id)} />
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
                  {detail.description && <p className="text-sm text-muted mt-1">{detail.description}</p>}
                </div>
                <button onClick={() => setSelectedId(null)} className="text-muted hover:text-[var(--text)] transition-colors">
                  <X size={16} />
                </button>
              </div>
              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted">Your rating:</span>
                  {renderStars(detail.userRating ?? 0, !ratingLoading, handleRate)}
                </div>
                <span className="text-xs text-muted">
                  {detail.avgRating.toFixed(1)} avg ({detail.ratingCount} rating{detail.ratingCount !== 1 ? 's' : ''})
                </span>
              </div>
              <div className="mb-4">
                <h3 className="text-xs font-medium text-muted uppercase mb-1">Brief</h3>
                <p className="text-sm text-[var(--text)] bg-bg rounded p-3">{detail.brief}</p>
              </div>
              <div>
                <h3 className="text-xs font-medium text-muted uppercase mb-2">Stories ({detail.storyCount})</h3>
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

/* ─── Template Card ────────────────────────────────────────────── */

function TemplateCard({ template, featured, selected, onClick }: {
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
          {template.description && <p className="text-xs text-muted mt-0.5 line-clamp-2">{template.description}</p>}
        </div>
        {featured && <Star size={14} className="text-amber-400 fill-amber-400 shrink-0 ml-2 mt-0.5" />}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted">
        {template.authorName && (
          <span className="flex items-center gap-1"><User size={12} />{template.authorName}</span>
        )}
        <span className="flex items-center gap-1"><FileText size={12} />{template.storyCount} stories</span>
        <span className="flex items-center gap-1"><TrendingUp size={12} />{template.usageCount} uses</span>
        {template.ratingCount > 0 && (
          <span className="flex items-center gap-1">
            <Star size={12} className={template.avgRating >= 4.0 ? 'text-amber-400 fill-amber-400' : ''} />
            {template.avgRating.toFixed(1)}
            <span className="text-muted/60">({template.ratingCount})</span>
          </span>
        )}
        {template.teamId ? (
          <span className="ml-auto px-1.5 py-0.5 text-[10px] rounded bg-blue-500/20 text-blue-400">team</span>
        ) : (
          <span className="ml-auto px-1.5 py-0.5 text-[10px] rounded bg-border text-muted">personal</span>
        )}
      </div>
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CONVENTION PACKS TAB
   ═══════════════════════════════════════════════════════════════════ */

function PacksTab() {
  const { workspaceId } = useWorkspace();
  const [catalogPacks, setCatalogPacks] = useState<CatalogPack[]>([]);
  const [installedPacks, setInstalledPacks] = useState<InstalledPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPack, setSelectedPack] = useState<string | null>(null); // packPath
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);

  const fetchPacks = useCallback(async () => {
    setLoading(true);
    try {
      const params = workspaceId ? `?workspaceId=${workspaceId}` : '';
      const [catalogData, installedData] = await Promise.all([
        apiFetch<{ packs: CatalogPack[] }>(`/api/packs/catalog${params}`),
        workspaceId
          ? apiFetch<{ packs: InstalledPack[] }>(`/api/packs?workspaceId=${workspaceId}`)
          : Promise.resolve({ packs: [] as InstalledPack[] }),
      ]);
      setCatalogPacks(catalogData.packs);
      setInstalledPacks(installedData.packs);
    } catch (err) {
      console.error('Failed to fetch packs:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchPacks(); }, [fetchPacks]);

  // Fetch detail when pack is selected
  useEffect(() => {
    if (!selectedPack) { setDetail(null); return; }
    setDetailLoading(true);
    apiFetch<PackDetail>(`/api/packs/detail?packPath=${encodeURIComponent(selectedPack)}`)
      .then(setDetail)
      .catch(console.error)
      .finally(() => setDetailLoading(false));
  }, [selectedPack]);

  const handleInstall = async (pack: CatalogPack) => {
    if (!workspaceId || installing) return;
    setInstalling(pack.name);
    try {
      await apiFetch('/api/packs/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, packPath: pack.packPath }),
      });
      await fetchPacks();
    } catch (err) {
      console.error('Failed to install pack:', err);
    } finally {
      setInstalling(null);
    }
  };

  const handleFork = async (packName: string) => {
    if (!workspaceId || forking) return;
    setForking(packName);
    try {
      const newName = `${packName}-custom`;
      await apiFetch('/api/packs/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, sourcePack: packName, newName }),
      });
      await fetchPacks();
    } catch (err) {
      console.error('Failed to fork pack:', err);
    } finally {
      setForking(null);
    }
  };

  const handleUninstall = async (packName: string) => {
    if (!workspaceId || uninstalling) return;
    setUninstalling(packName);
    try {
      await apiFetch(`/api/packs/${encodeURIComponent(packName)}?workspaceId=${workspaceId}`, {
        method: 'DELETE',
      });
      setConfirmUninstall(null);
      await fetchPacks();
    } catch (err) {
      console.error('Failed to uninstall pack:', err);
    } finally {
      setUninstalling(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-5">
        {/* Installed packs section */}
        {installedPacks.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Check size={14} className="text-green-400" />
              <h2 className="text-sm font-medium text-green-400">Installed</h2>
              <span className="text-xs text-muted">({installedPacks.length})</span>
            </div>
            <div className="grid gap-3">
              {installedPacks.map(pack => (
                <div
                  key={pack.id}
                  className={`p-4 rounded-lg border transition-colors cursor-pointer ${
                    selectedPack === pack.packPath
                      ? 'border-accent bg-accent/10'
                      : 'border-green-500/20 bg-green-500/5 hover:border-green-500/40'
                  }`}
                  onClick={() => setSelectedPack(selectedPack === pack.packPath ? null : pack.packPath)}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium text-[var(--text)]">{pack.packName}</h3>
                        <span className="text-[10px] text-muted font-mono">v{pack.packVersion}</span>
                        {pack.forkedFrom && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-purple-500/20 text-purple-400">
                            forked from {pack.forkedFrom}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => handleFork(pack.packName)}
                        disabled={forking === pack.packName}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-accent border border-border rounded transition-colors"
                        title="Fork for customization"
                      >
                        {forking === pack.packName ? <Loader2 size={12} className="animate-spin" /> : <GitFork size={12} />}
                        Fork
                      </button>
                      <button
                        onClick={() => setConfirmUninstall(pack.packName)}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-red-500 border border-border rounded transition-colors"
                        title="Uninstall"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted">
                    <span>Installed {relativeDate(pack.installedAt)}</span>
                    {!pack.valid && (
                      <span className="text-amber-400 flex items-center gap-1">
                        <AlertTriangle size={11} /> Invalid pack.json
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Available packs catalog */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Package size={14} className="text-accent" />
            <h2 className="text-sm font-medium text-[var(--text)]">Available Packs</h2>
            <span className="text-xs text-muted">({catalogPacks.length})</span>
          </div>

          {catalogPacks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted text-sm">
              <Package size={32} className="mb-2 opacity-50" />
              <p>No starters found</p>
              <p className="text-xs mt-1">Starters are project setup bundles with direction layers, skills, and scaffold files</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {catalogPacks.map(pack => (
                <div
                  key={pack.name}
                  className={`p-4 rounded-lg border transition-colors cursor-pointer ${
                    selectedPack === pack.packPath
                      ? 'border-accent bg-accent/10'
                      : pack.installed
                        ? 'border-green-500/20 bg-green-500/5 hover:border-green-500/40'
                        : 'border-border bg-panel hover:border-zinc-600'
                  }`}
                  onClick={() => setSelectedPack(selectedPack === pack.packPath ? null : pack.packPath)}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium text-[var(--text)]">{pack.name}</h3>
                        <span className="text-[10px] text-muted font-mono">v{pack.version}</span>
                        {pack.installed && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-green-500/20 text-green-400">installed</span>
                        )}
                      </div>
                      {pack.description && (
                        <p className="text-xs text-muted mt-0.5 line-clamp-2">{pack.description}</p>
                      )}
                    </div>
                    {!pack.installed && workspaceId && (
                      <div className="shrink-0 ml-2" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => handleInstall(pack)}
                          disabled={installing === pack.name}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
                        >
                          {installing === pack.name ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Download size={12} />
                          )}
                          Install
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Metadata badges */}
                  <div className="flex items-center gap-2 text-xs text-muted flex-wrap">
                    {pack.author && (
                      <span className="flex items-center gap-1"><User size={11} />{pack.author}</span>
                    )}
                    {pack.frameworks.length > 0 && (
                      <span className="flex items-center gap-1">
                        {pack.frameworks.slice(0, 3).map(f => (
                          <span key={f} className="px-1.5 py-0.5 text-[10px] rounded bg-blue-500/15 text-blue-400">{f}</span>
                        ))}
                        {pack.frameworks.length > 3 && (
                          <span className="text-[10px] text-muted">+{pack.frameworks.length - 3}</span>
                        )}
                      </span>
                    )}
                    {pack.hasPersonas && (
                      <span className="flex items-center gap-1"><Users size={11} />personas</span>
                    )}
                    {pack.hasConventions && (
                      <span className="flex items-center gap-1"><BookOpen size={11} />conventions</span>
                    )}
                    {pack.hasScaffold && (
                      <span className="flex items-center gap-1"><FolderTree size={11} />scaffold</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Pack detail drawer */}
      {selectedPack && (
        <div className="border-t border-border bg-panel shrink-0 max-h-[45%] overflow-y-auto">
          {detailLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 size={20} className="animate-spin text-muted" />
            </div>
          ) : detail ? (
            <PackDetailView detail={detail} onClose={() => setSelectedPack(null)} />
          ) : null}
        </div>
      )}

      {/* Uninstall confirmation dialog */}
      {confirmUninstall && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-panel border border-border rounded-lg p-4 w-96 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
                <Trash2 size={16} className="text-red-500" />
                Uninstall Pack
              </h3>
              <button onClick={() => setConfirmUninstall(null)} className="text-muted hover:text-[var(--text)]">
                <X size={16} />
              </button>
            </div>
            <p className="text-sm text-[var(--text)] mb-2">
              Uninstall <code className="bg-bg px-1 py-0.5 rounded font-mono">{confirmUninstall}</code>?
            </p>
            <p className="text-xs text-muted mb-4">
              This will remove pack direction layers and skills from the database. Scaffold files already copied to your workspace will remain.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmUninstall(null)}
                className="px-3 py-1.5 text-xs text-muted hover:text-[var(--text)] rounded border border-border"
              >
                Cancel
              </button>
              <button
                onClick={() => handleUninstall(confirmUninstall)}
                disabled={uninstalling === confirmUninstall}
                className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {uninstalling === confirmUninstall ? <Loader2 size={12} className="animate-spin" /> : 'Uninstall'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Pack Detail View ─────────────────────────────────────────── */

function PackDetailView({ detail, onClose }: { detail: PackDetail; onClose: () => void }) {
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  const toggleSection = (section: string) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  return (
    <div className="p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-[var(--text)]">{detail.metadata.name}</h2>
            <span className="text-xs text-muted font-mono">v{detail.metadata.version}</span>
          </div>
          {detail.metadata.description && (
            <p className="text-sm text-muted mt-1">{detail.metadata.description}</p>
          )}
        </div>
        <button onClick={onClose} className="text-muted hover:text-[var(--text)] transition-colors">
          <X size={16} />
        </button>
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-3 mb-4 text-xs text-muted flex-wrap">
        {detail.metadata.author && (
          <span className="flex items-center gap-1"><User size={12} />{detail.metadata.author}</span>
        )}
        {detail.metadata.license && (
          <span className="px-1.5 py-0.5 rounded bg-bg">{detail.metadata.license}</span>
        )}
        {detail.metadata.compatibility.frameworks.map(f => (
          <span key={f} className="px-1.5 py-0.5 text-[10px] rounded bg-blue-500/15 text-blue-400">{f}</span>
        ))}
      </div>

      {/* Expandable sections */}
      <div className="space-y-1">
        {/* Direction Layers */}
        {detail.directionLayers.length > 0 && (
          <DetailSection
            title="Direction Layers"
            icon={<Layers size={13} />}
            count={detail.directionLayers.length}
            expanded={expandedSection === 'direction'}
            onToggle={() => toggleSection('direction')}
          >
            <div className="space-y-2">
              {detail.directionLayers.map(layer => (
                <div key={layer.filename} className="bg-bg rounded p-2.5">
                  <span className="text-xs font-mono text-accent">{layer.filename}</span>
                  <p className="text-xs text-muted mt-1 whitespace-pre-wrap line-clamp-4">{layer.preview}</p>
                </div>
              ))}
            </div>
          </DetailSection>
        )}

        {/* Personas */}
        {detail.personas.length > 0 && (
          <DetailSection
            title="Personas"
            icon={<Users size={13} />}
            count={detail.personas.length}
            expanded={expandedSection === 'personas'}
            onToggle={() => toggleSection('personas')}
          >
            <div className="grid grid-cols-2 gap-1.5">
              {detail.personas.map(p => (
                <span key={p} className="text-xs font-mono text-[var(--text)] bg-bg rounded px-2 py-1 truncate">{p}</span>
              ))}
            </div>
          </DetailSection>
        )}

        {/* Conventions */}
        {detail.conventions.length > 0 && (
          <DetailSection
            title="Conventions"
            icon={<BookOpen size={13} />}
            count={detail.conventions.length}
            expanded={expandedSection === 'conventions'}
            onToggle={() => toggleSection('conventions')}
          >
            <div className="flex flex-wrap gap-1.5">
              {detail.conventions.map(c => (
                <span key={c} className="px-2 py-1 text-xs font-mono rounded bg-purple-500/10 text-purple-400">
                  {c.replace('.md', '')}
                </span>
              ))}
            </div>
          </DetailSection>
        )}

        {/* Scaffold */}
        {detail.scaffoldTree.length > 0 && (
          <DetailSection
            title="Scaffold Files"
            icon={<FolderTree size={13} />}
            count={detail.scaffoldTree.length}
            expanded={expandedSection === 'scaffold'}
            onToggle={() => toggleSection('scaffold')}
          >
            <div className="bg-bg rounded p-2.5 max-h-40 overflow-y-auto">
              {detail.scaffoldTree.map(f => (
                <div key={f} className={`text-xs font-mono py-0.5 ${f.endsWith('/') ? 'text-accent' : 'text-muted'}`}>
                  {f}
                </div>
              ))}
            </div>
          </DetailSection>
        )}

        {/* Skills */}
        {detail.metadata.skills.length > 0 && (
          <DetailSection
            title="Skills"
            icon={<Wrench size={13} />}
            count={detail.metadata.skills.length}
            expanded={expandedSection === 'skills'}
            onToggle={() => toggleSection('skills')}
          >
            <div className="flex flex-wrap gap-1.5">
              {detail.metadata.skills.map(s => (
                <span key={s} className="px-2 py-1 text-xs font-mono rounded bg-green-500/10 text-green-400">{s}</span>
              ))}
            </div>
          </DetailSection>
        )}

        {/* Dependencies */}
        {detail.metadata.dependencies.length > 0 && (
          <DetailSection
            title="Dependencies"
            icon={<Package size={13} />}
            count={detail.metadata.dependencies.length}
            expanded={expandedSection === 'deps'}
            onToggle={() => toggleSection('deps')}
          >
            <div className="flex flex-wrap gap-1.5">
              {detail.metadata.dependencies.map(d => (
                <span key={d.name} className="px-2 py-1 text-xs font-mono rounded bg-bg text-[var(--text)]">
                  {d.name}{d.version ? `@${d.version}` : ''}
                </span>
              ))}
            </div>
          </DetailSection>
        )}
      </div>
    </div>
  );
}

/* ─── Detail Section (collapsible) ─────────────────────────────── */

function DetailSection({ title, icon, count, expanded, onToggle, children }: {
  title: string;
  icon: React.ReactNode;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--text)] hover:bg-bg transition-colors"
      >
        <ChevronRight size={12} className={`text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="text-muted">{icon}</span>
        {title}
        <span className="text-muted ml-auto">{count}</span>
      </button>
      {expanded && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SKILLS TAB — search-engine-style skills.sh browser
   ═══════════════════════════════════════════════════════════════════ */

type SkillCategory = 'All' | 'Frontend' | 'Backend' | 'Testing' | 'DevOps' | 'Security' | 'Database';

const SKILL_CATEGORY_KEYWORDS: Record<Exclude<SkillCategory, 'All'>, string[]> = {
  Frontend: ['react', 'vue', 'angular', 'svelte', 'css', 'tailwind', 'frontend', 'ui', 'component', 'next', 'nuxt', 'astro'],
  Backend: ['node', 'express', 'api', 'server', 'backend', 'rest', 'graphql', 'fastify', 'nest', 'hono'],
  Testing: ['test', 'jest', 'vitest', 'playwright', 'cypress', 'testing', 'coverage', 'e2e', 'unit', 'qa'],
  DevOps: ['docker', 'ci', 'cd', 'deploy', 'kubernetes', 'terraform', 'aws', 'gcp', 'azure', 'devops', 'pipeline', 'github-actions'],
  Security: ['security', 'auth', 'oauth', 'jwt', 'encryption', 'vulnerability', 'cors', 'csrf', 'xss', 'sanitize'],
  Database: ['database', 'sql', 'postgres', 'mysql', 'sqlite', 'prisma', 'drizzle', 'redis', 'mongo', 'migration', 'schema'],
};

const SKILL_CATEGORIES: SkillCategory[] = ['All', 'Frontend', 'Backend', 'Testing', 'DevOps', 'Security', 'Database'];

function skillMatchesCategory(skill: { name: string; description?: string | null }, category: SkillCategory): boolean {
  if (category === 'All') return true;
  const keywords = SKILL_CATEGORY_KEYWORDS[category];
  const haystack = `${skill.name} ${skill.description ?? ''}`.toLowerCase();
  return keywords.some(kw => haystack.includes(kw));
}

interface SkillSearchResult {
  name: string;
  description: string;
  author: string;
  url: string;
}

interface SkillSuggestion {
  skill: string;         // e.g. "react.md"
  triggeredBy: string[]; // stack items that triggered this
  installed: boolean;
}

function SkillsTab() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();
  const [activeCategory, setActiveCategory] = useState<SkillCategory>('All');

  // Installed / discovered skills (local)
  const [installedSkills, setInstalledSkills] = useState<SkillSummary[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);

  // Suggestions from echolocation
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(true);

  // Search
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Per-skill install state: name → 'installing' | 'done' | 'error'
  const [installState, setInstallState] = useState<Record<string, 'installing' | 'done' | 'error'>>({});

  // Batch install state
  const [batchInstalling, setBatchInstalling] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Fetch installed skills ──────────────────────────────────────
  const fetchInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const params = workspaceId ? `?workspaceId=${workspaceId}` : '';
      const data = await apiFetch<{ skills: SkillSummary[] }>(`/api/skills${params}`);
      setInstalledSkills(data.skills);
    } catch { /* silent */ } finally {
      setLoadingInstalled(false);
    }
  }, [workspaceId]);

  // ── Fetch stack-based suggestions ──────────────────────────────
  const fetchSuggestions = useCallback(async () => {
    setLoadingSuggestions(true);
    try {
      const params = workspaceId ? `?workspaceId=${workspaceId}` : '';
      const data = await apiFetch<{ suggestions: SkillSuggestion[] }>(`/api/skills/suggestions${params}`);
      setSuggestions(data.suggestions ?? []);
    } catch { /* silent */ } finally {
      setLoadingSuggestions(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchInstalled();
    fetchSuggestions();
  }, [fetchInstalled, fetchSuggestions]);

  // ── Debounced search ────────────────────────────────────────────
  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current);
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setHasSearched(false);
      setSearchError(null);
      return;
    }
    searchRef.current = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const data = await apiFetch<{ results: SkillSearchResult[]; total: number }>(
          '/api/skills/search',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, limit: 30 }) },
        );
        setSearchResults(data.results ?? []);
        setHasSearched(true);
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : 'Search failed');
        setSearchResults([]);
        setHasSearched(true);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => { if (searchRef.current) clearTimeout(searchRef.current); };
  }, [query]);

  // ── Install a skill from skills.sh ─────────────────────────────
  const installSkill = useCallback(async (skillName: string) => {
    setInstallState(s => ({ ...s, [skillName]: 'installing' }));
    try {
      await apiFetch('/api/skills/install-from-sh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skillName, workspaceId }),
      });
      setInstallState(s => ({ ...s, [skillName]: 'done' }));
      await fetchInstalled();
    } catch {
      setInstallState(s => ({ ...s, [skillName]: 'error' }));
    }
  }, [workspaceId, fetchInstalled]);

  // ── Remove a skill ─────────────────────────────────────────────
  const removeSkill = useCallback(async (skillName: string) => {
    try {
      await apiFetch(`/api/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' });
      await fetchInstalled();
    } catch { /* silent */ }
  }, [fetchInstalled]);

  const installedNames = new Set(installedSkills.map(s => s.name.toLowerCase()));

  const isInstalled = (name: string) =>
    installedNames.has(name.toLowerCase()) || installState[name] === 'done';

  // Uninstalled suggestions for the banner
  const uninstalledSuggestions = suggestions.filter(s => {
    const name = s.skill.replace(/\.md$/, '');
    return !s.installed && !isInstalled(name);
  });

  // Unique tech names across all suggestions
  const detectedTechs = [...new Set(suggestions.flatMap(s => s.triggeredBy))];

  // ── Batch install all recommended ────────────────────────────────
  const installAllRecommended = useCallback(async () => {
    const toInstall = uninstalledSuggestions.map(s => s.skill.replace(/\.md$/, ''));
    if (toInstall.length === 0 || batchInstalling) return;

    setBatchInstalling(true);
    setBatchProgress({ current: 0, total: toInstall.length });
    let failCount = 0;

    for (let i = 0; i < toInstall.length; i++) {
      const name = toInstall[i];
      setBatchProgress({ current: i + 1, total: toInstall.length });
      setInstallState(s => ({ ...s, [name]: 'installing' }));
      try {
        await apiFetch('/api/skills/install-from-sh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, workspaceId }),
        });
        setInstallState(s => ({ ...s, [name]: 'done' }));
      } catch {
        setInstallState(s => ({ ...s, [name]: 'error' }));
        toast.show(`Failed to install skill "${name}"`, 'error');
        failCount++;
      }
    }

    await Promise.all([fetchInstalled(), fetchSuggestions()]);
    setBatchInstalling(false);

    if (failCount === 0) {
      toast.show(`All ${toInstall.length} skills installed`, 'success');
    } else {
      toast.show(`${toInstall.length - failCount} of ${toInstall.length} skills installed`, 'success');
    }
  }, [uninstalledSuggestions, batchInstalling, workspaceId, fetchInstalled, fetchSuggestions, toast]);

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0">

      {/* ── Search bar ── */}
      <div className="px-5 pt-5 pb-4 border-b border-border shrink-0">
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            {searching
              ? <Loader2 size={15} className="animate-spin text-muted" />
              : <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            }
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search skills.sh — react, testing, stripe, sqlite…"
            className="w-full pl-9 pr-9 py-2.5 text-sm bg-bg border border-border rounded-lg text-[var(--text)] placeholder:text-muted/50 outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
            autoFocus
          />
          {query && (
            <button
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-[var(--text)] transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {query && !searching && (
          <p className="mt-1.5 text-xs text-muted/60">
            {hasSearched && searchResults.length > 0
              ? `${searchResults.length} results from skills.sh`
              : hasSearched && !searchError
                ? 'No results found'
                : ''}
          </p>
        )}
      </div>

      {/* ── Category filter chips (shown when not searching) ── */}
      {!query.trim() && (
        <div className="px-5 py-2 shrink-0 overflow-x-auto border-b border-border/50">
          <div className="flex items-center gap-1.5">
            {SKILL_CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1 text-xs rounded-full whitespace-nowrap transition-colors ${
                  activeCategory === cat
                    ? 'bg-accent text-white'
                    : 'bg-surface-100 text-muted hover:text-[var(--text)]'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">

        {/* ── Search results ── */}
        {query.trim() ? (
          <div>
            {searchError && (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5 text-red-400 text-sm">
                <AlertTriangle size={14} className="shrink-0" />
                <span>{searchError}</span>
              </div>
            )}
            {!searchError && hasSearched && searchResults.length === 0 && !searching && (
              <div className="py-12 text-center text-muted text-sm">
                <Wrench size={28} className="mx-auto mb-2 opacity-40" />
                <p>No skills found for "{query}"</p>
              </div>
            )}
            {searchResults.length > 0 && (
              <div className="space-y-2">
                {searchResults.map(result => (
                  <SkillRegistryCard
                    key={result.name}
                    name={result.name}
                    description={result.description}
                    author={result.author}
                    badge={null}
                    installed={isInstalled(result.name)}
                    installing={installState[result.name] === 'installing'}
                    installError={installState[result.name] === 'error'}
                    onInstall={() => installSkill(result.name)}
                    onRemove={() => removeSkill(result.name)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ── Install All Recommended banner ── */}
            {!loadingSuggestions && uninstalledSuggestions.length > 0 && (
              <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text)]">
                      {batchInstalling
                        ? `Installing ${batchProgress.current} of ${batchProgress.total}…`
                        : `${uninstalledSuggestions.length} skill${uninstalledSuggestions.length !== 1 ? 's' : ''} recommended for your stack`
                      }
                    </p>
                    {detectedTechs.length > 0 && !batchInstalling && (
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        {detectedTechs.slice(0, 8).map(tech => (
                          <span key={tech} className="px-1.5 py-0.5 text-[10px] rounded bg-accent/10 text-accent font-medium">
                            {tech}
                          </span>
                        ))}
                        {detectedTechs.length > 8 && (
                          <span className="text-[10px] text-muted">+{detectedTechs.length - 8}</span>
                        )}
                      </div>
                    )}
                    {batchInstalling && (
                      <div className="mt-2 h-1 w-full rounded-full bg-border overflow-hidden">
                        <div
                          className="h-full bg-accent rounded-full transition-all duration-300"
                          style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={installAllRecommended}
                    disabled={batchInstalling}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded transition-colors disabled:opacity-50"
                  >
                    {batchInstalling
                      ? <Loader2 size={13} className="animate-spin" />
                      : <Download size={13} />
                    }
                    {batchInstalling ? 'Installing…' : 'Install All'}
                  </button>
                </div>
              </div>
            )}

            {/* ── Suggested for your stack ── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp size={13} className="text-accent" />
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Suggested for your stack</h2>
                {loadingSuggestions && <Loader2 size={12} className="animate-spin text-muted" />}
              </div>
              {!loadingSuggestions && suggestions.length === 0 && (
                <p className="text-xs text-muted/60 py-2">No stack detected — open a workspace with a package.json to get suggestions.</p>
              )}
              {suggestions.length > 0 && (
                <div className="space-y-2">
                  {suggestions.map(s => {
                    const name = s.skill.replace(/\.md$/, '');
                    return (
                      <SkillRegistryCard
                        key={name}
                        name={name}
                        description={`Detected via: ${s.triggeredBy.join(', ')}`}
                        author=""
                        badge="suggested"
                        installed={s.installed || isInstalled(name)}
                        installing={installState[name] === 'installing'}
                        installError={installState[name] === 'error'}
                        onInstall={() => installSkill(name)}
                        onRemove={() => removeSkill(name)}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Installed skills ── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Check size={13} className="text-green-400" />
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Installed</h2>
                {loadingInstalled
                  ? <Loader2 size={12} className="animate-spin text-muted" />
                  : <span className="text-xs text-muted/60">({installedSkills.length})</span>
                }
              </div>
              {!loadingInstalled && installedSkills.length === 0 && (
                <p className="text-xs text-muted/60 py-2">No skills installed yet. Search above to install from skills.sh.</p>
              )}
              {installedSkills.filter(s => skillMatchesCategory(s, activeCategory)).length > 0 && (
                <div className="space-y-2">
                  {installedSkills.filter(s => skillMatchesCategory(s, activeCategory)).map(skill => (
                    <SkillRegistryCard
                      key={skill.name}
                      name={skill.name}
                      description={skill.description}
                      author=""
                      badge={skill.source.startsWith('pack:') ? skill.source.replace('pack:', '') : skill.source}
                      installed={true}
                      installing={false}
                      installError={false}
                      onInstall={() => {}}
                      onRemove={() => removeSkill(skill.name)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Skill Registry Card ──────────────────────────────────────── */

interface SkillContentCache {
  content: string;
  wordCount: number;
  estimatedTokens: number;
}

function SkillRegistryCard({
  name, description, author, badge,
  installed, installing, installError,
  onInstall, onRemove,
}: {
  name: string;
  description: string;
  author: string;
  badge: string | null;
  installed: boolean;
  installing: boolean;
  installError: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentCache, setContentCache] = useState<SkillContentCache | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !contentCache && !contentLoading) {
      setContentLoading(true);
      setContentError(null);
      // Installed: fetch from local content endpoint. Uninstalled: preview from skills.sh
      const url = installed
        ? `/api/skills/${encodeURIComponent(name)}/content`
        : `/api/skills/preview?query=${encodeURIComponent(name)}`;
      apiFetch<{ content: string; wordCount: number; estimatedTokens: number }>(url)
        .then(data => setContentCache({ content: data.content, wordCount: data.wordCount, estimatedTokens: data.estimatedTokens }))
        .catch(err => setContentError(err instanceof Error ? err.message : 'Failed to load preview'))
        .finally(() => setContentLoading(false));
    }
  };

  return (
    <div className={`rounded-lg border transition-colors ${
      installed ? 'border-green-500/25 bg-green-500/5' : 'border-border bg-panel hover:border-border/80'
    }`}>
      <div className="flex items-start gap-3 p-3">
        <button onClick={handleToggle} className="mt-0.5 shrink-0 text-muted hover:text-[var(--text)] transition-colors">
          <ChevronRight size={14} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        <Wrench size={14} className={`mt-0.5 shrink-0 ${installed ? 'text-green-400' : 'text-accent/70'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--text)]">{name}</span>
            {badge && (
              <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
                badge === 'suggested'
                  ? 'bg-accent/15 text-accent'
                  : badge === 'skills.sh' || badge === 'db'
                    ? 'bg-green-500/15 text-green-400'
                    : 'bg-border text-muted'
              }`}>{badge}</span>
            )}
            {author && <span className="text-[11px] text-muted/50">{author}</span>}
          </div>
          {description && (
            <p className="text-xs text-muted mt-0.5 line-clamp-2">{description}</p>
          )}
        </div>
        <div className="shrink-0">
          {installed ? (
            <button
              onClick={onRemove}
              className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
              title="Remove skill"
            >
              <Trash2 size={12} />
            </button>
          ) : installing ? (
            <div className="flex items-center gap-1 px-2 py-1 text-xs text-muted">
              <Loader2 size={12} className="animate-spin" />
              <span>Installing…</span>
            </div>
          ) : installError ? (
            <button
              onClick={onInstall}
              className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded transition-colors"
            >
              <AlertTriangle size={12} />
              <span>Retry</span>
            </button>
          ) : (
            <button
              onClick={onInstall}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded transition-colors"
            >
              <Download size={12} />
              <span>Install</span>
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0">
          {contentLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={16} className="animate-spin text-muted" />
            </div>
          ) : contentError ? (
            <div className="p-3 rounded bg-red-500/5 border border-red-500/20 text-xs text-red-400">
              {contentError}
            </div>
          ) : contentCache ? (
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <p className="text-[11px] text-muted">
                  {contentCache.wordCount.toLocaleString()} words · ~{contentCache.estimatedTokens.toLocaleString()} tokens
                </p>
                {!installed && (
                  <span className="text-[10px] text-accent/70 bg-accent/10 px-1.5 py-0.5 rounded">preview from skills.sh</span>
                )}
              </div>
              <div
                className="prose prose-invert prose-sm max-h-64 overflow-y-auto rounded bg-bg p-3"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(contentCache.content) }}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
