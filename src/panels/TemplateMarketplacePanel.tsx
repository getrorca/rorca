import { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';

/* ─── Marketplace Tab Type ─────────────────────────────────────── */

type MarketplaceTab = 'templates' | 'packs' | 'skills';

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
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('packs');

  const TABS: { id: MarketplaceTab; label: string; icon: typeof Package }[] = [
    { id: 'packs', label: 'Convention Packs', icon: Package },
    { id: 'templates', label: 'Spec Templates', icon: FileText },
    { id: 'skills', label: 'Skills', icon: Wrench },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with tabs */}
      <div className="px-5 py-4 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text)] mb-3">Marketplace</h1>
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
        {activeTab === 'templates' && <TemplatesTab />}
        {activeTab === 'packs' && <PacksTab />}
        {activeTab === 'skills' && <SkillsTab />}
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
              <p>No convention packs found</p>
              <p className="text-xs mt-1">Add packs to the packs/ directory in Rorca&apos;s repo</p>
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
              This will remove L0 direction layers and pack skills from the database. Scaffold files already copied to your workspace will remain.
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
   SKILLS TAB
   ═══════════════════════════════════════════════════════════════════ */

function SkillsTab() {
  const { workspaceId } = useWorkspace();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    try {
      const params = workspaceId ? `?workspaceId=${workspaceId}` : '';
      const data = await apiFetch<{ skills: SkillSummary[] }>(`/api/skills${params}`);
      setSkills(data.skills);
    } catch (err) {
      console.error('Failed to fetch skills:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  const installedSkills = skills.filter(s => s.source === 'db' || s.source.startsWith('pack:'));
  const discoveredSkills = skills.filter(s => s.source !== 'db' && !s.source.startsWith('pack:'));

  return (
    <div className="flex-1 overflow-y-auto p-5">
      {/* Installed skills */}
      {installedSkills.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Check size={14} className="text-green-400" />
            <h2 className="text-sm font-medium text-green-400">Installed Skills</h2>
            <span className="text-xs text-muted">({installedSkills.length})</span>
          </div>
          <div className="grid gap-2">
            {installedSkills.map(skill => (
              <SkillCard key={skill.name} skill={skill} />
            ))}
          </div>
        </div>
      )}

      {/* Discovered skills */}
      {discoveredSkills.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Wrench size={14} className="text-accent" />
            <h2 className="text-sm font-medium text-[var(--text)]">Discovered Skills</h2>
            <span className="text-xs text-muted">({discoveredSkills.length})</span>
          </div>
          <div className="grid gap-2">
            {discoveredSkills.map(skill => (
              <SkillCard key={skill.name} skill={skill} />
            ))}
          </div>
        </div>
      )}

      {skills.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-muted text-sm">
          <Wrench size={32} className="mb-2 opacity-50" />
          <p>No skills found</p>
          <p className="text-xs mt-1">Install a convention pack or create skills in Workspace Settings &gt; Context</p>
        </div>
      )}

      {/* Tip */}
      <div className="mt-6 p-3 border border-border rounded bg-bg text-xs text-muted">
        <p className="font-medium text-[var(--text)] mb-1">Manage skills in Workspace Settings</p>
        <p>Go to Workspace Settings &gt; Context &gt; Skills to create, edit, import, and export skill files.</p>
      </div>
    </div>
  );
}

/* ─── Skill Card ───────────────────────────────────────────────── */

function SkillCard({ skill }: { skill: SkillSummary }) {
  const sourceLabel = skill.source.startsWith('pack:')
    ? skill.source.replace('pack:', '')
    : skill.source;

  return (
    <div className="p-3 rounded-lg border border-border bg-panel">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Wrench size={13} className="text-accent shrink-0" />
            <h3 className="text-sm font-medium text-[var(--text)] truncate">{skill.name}</h3>
          </div>
          {skill.description && (
            <p className="text-xs text-muted mt-0.5 ml-5 line-clamp-2">{skill.description}</p>
          )}
        </div>
        <span className={`shrink-0 ml-2 px-1.5 py-0.5 text-[10px] rounded ${
          skill.source.startsWith('pack:')
            ? 'bg-purple-500/20 text-purple-400'
            : skill.source === 'db'
              ? 'bg-green-500/20 text-green-400'
              : 'bg-border text-muted'
        }`}>
          {sourceLabel}
        </span>
      </div>
    </div>
  );
}
