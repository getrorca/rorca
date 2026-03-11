import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Wrench, FileText, Package, Search, Loader2, Download, AlertTriangle, Trash2, Check } from 'lucide-react';
import type { PanelId } from '../components/Sidebar';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWorkspace } from '../contexts/WorkspaceContext';

/* ─── Types ───────────────────────────────────────────────────── */

type MarketplaceTab = 'skills' | 'templates' | 'packs';
type SourceFilter = 'skills.sh' | 'github' | 'custom';

interface SkillResult {
  name: string;
  description: string;
  author: string;
  url: string;
}

interface SkillSearchResponse {
  results: SkillResult[];
  query: string;
  total: number;
}

interface InstalledSkill {
  name: string;
  description: string;
  source: string;
  filePath: string;
  category?: string;
  tags?: string[];
}

interface MarketplacePanelProps {
  onNavigate: (panel: PanelId) => void;
}

/* ─── Tab Definition ──────────────────────────────────────────── */

const TABS: { id: MarketplaceTab; label: string; icon: typeof Package }[] = [
  { id: 'skills', label: 'Skills', icon: Wrench },
  { id: 'templates', label: 'Templates', icon: FileText },
  { id: 'packs', label: 'Convention Packs', icon: Package },
];

const SOURCE_PILLS: { id: SourceFilter; label: string }[] = [
  { id: 'skills.sh', label: 'skills.sh' },
  { id: 'github', label: 'GitHub Repos' },
  { id: 'custom', label: 'Custom' },
];

/* ─── Category Inference ─────────────────────────────────────── */

const CATEGORY_COLORS: Record<string, string> = {
  frontend: 'bg-blue-500/15 text-blue-400',
  backend: 'bg-green-500/15 text-green-400',
  security: 'bg-red-500/15 text-red-400',
  devops: 'bg-purple-500/15 text-purple-400',
  database: 'bg-amber-500/15 text-amber-400',
  testing: 'bg-cyan-500/15 text-cyan-400',
  general: 'bg-zinc-500/15 text-zinc-400',
};

function inferCategory(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase();
  if (/react|vue|angular|svelte|css|tailwind|frontend|ui|component/.test(text)) return 'frontend';
  if (/express|fastify|nest|django|flask|api|server|backend|node/.test(text)) return 'backend';
  if (/security|auth|csrf|xss|owasp|encrypt|vulnerability/.test(text)) return 'security';
  if (/docker|k8s|kubernetes|ci|cd|deploy|terraform|aws|gcp|devops|infra/.test(text)) return 'devops';
  if (/sql|postgres|mysql|mongo|redis|database|prisma|drizzle/.test(text)) return 'database';
  if (/test|jest|vitest|playwright|cypress|testing|spec/.test(text)) return 'testing';
  return 'general';
}

/* ─── Component ───────────────────────────────────────────────── */

export default function MarketplacePanel({ onNavigate: _onNavigate }: MarketplacePanelProps) {
  const { workspaceId } = useWorkspace();
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('skills');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSource, setActiveSource] = useState<SourceFilter>('skills.sh');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const toast = useGlobalToast();

  // Skill search state
  const [skills, setSkills] = useState<SkillResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Installed skills state (shared between left + right panels)
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [installState, setInstallState] = useState<Record<string, 'installing' | 'done' | 'error'>>({});
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);

  // Installed names set for O(1) lookup
  const installedNames = useMemo(
    () => new Set(installedSkills.map(s => s.name.toLowerCase())),
    [installedSkills],
  );

  const isInstalled = useCallback(
    (name: string) => installedNames.has(name.toLowerCase()) || installState[name] === 'done',
    [installedNames, installState],
  );

  // Fetch installed skills
  const fetchInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const params = workspaceId ? `?workspaceId=${workspaceId}` : '';
      const data = await apiFetch<{ skills: InstalledSkill[] }>(`/api/skills${params}`);
      setInstalledSkills(data.skills);
    } catch { /* silent */ } finally {
      setLoadingInstalled(false);
    }
  }, [workspaceId]);

  // Fetch installed on mount
  useEffect(() => { fetchInstalled(); }, [fetchInstalled]);

  // Fetch skills from skills.sh on mount when tab is skills + source is skills.sh
  const fetchSkills = useCallback(async () => {
    if (activeTab !== 'skills' || activeSource !== 'skills.sh') return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<SkillSearchResponse>('/api/skills/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'skill', limit: 20 }),
      });
      setSkills(data.results);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch skills');
    } finally {
      setLoading(false);
    }
  }, [activeTab, activeSource]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  // Client-side filter
  const filteredSkills = searchQuery.trim()
    ? skills.filter((s) => {
        const q = searchQuery.toLowerCase();
        return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
      })
    : skills;

  // Install handler
  const handleInstall = async (skillName: string) => {
    setInstallState(s => ({ ...s, [skillName]: 'installing' }));
    try {
      await apiFetch('/api/skills/install-from-sh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skillName }),
      });
      setInstallState(s => ({ ...s, [skillName]: 'done' }));
      toast.show(`Installed "${skillName}" successfully`, 'success');
      await fetchInstalled();
    } catch (err: any) {
      setInstallState(s => ({ ...s, [skillName]: 'error' }));
      toast.show(err.message || `Failed to install "${skillName}"`, 'error');
    }
  };

  // Remove handler
  const handleRemove = async (skillName: string) => {
    setRemovingSkill(skillName);
    try {
      await apiFetch(`/api/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' });
      toast.show(`Skill "${skillName}" removed`, 'success');
      // Clear install state so the Install button re-enables in left panel
      setInstallState(s => {
        const next = { ...s };
        delete next[skillName];
        return next;
      });
      await fetchInstalled();
    } catch (err: any) {
      toast.show(err.message || `Failed to remove "${skillName}"`, 'error');
    } finally {
      setRemovingSkill(null);
    }
  };

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <h1 className="sr-only">Marketplace</h1>

      {/* Tab bar */}
      <div
        className="flex items-center border-b border-border bg-panel shrink-0"
        role="tablist"
        aria-label="Marketplace tabs"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={`marketplace-tabpanel-${tab.id}`}
              id={`marketplace-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors relative ${
                isActive
                  ? 'text-text border-b-2 border-accent'
                  : 'text-muted hover:text-text'
              }`}
            >
              <Icon size={13} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div
        className="flex-1 min-h-0 overflow-hidden flex flex-col"
        role="tabpanel"
        id={`marketplace-tabpanel-${activeTab}`}
        aria-labelledby={`marketplace-tab-${activeTab}`}
      >
        {/* Search bar */}
        <div className="px-4 pt-3 pb-2 shrink-0">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search skills, templates, or packs..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-md
                         text-text placeholder:text-muted
                         focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent
                         transition-colors"
            />
          </div>
        </div>

        {/* Source pills */}
        <div className="flex items-center gap-2 px-4 pb-3 shrink-0">
          {SOURCE_PILLS.map((source) => {
            const isActive = activeSource === source.id;
            return (
              <button
                key={source.id}
                onClick={() => setActiveSource(source.id)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                  isActive
                    ? 'bg-accent text-white'
                    : 'bg-surface border border-border text-muted hover:text-text hover:border-text/20'
                }`}
                aria-pressed={isActive}
              >
                {source.label}
              </button>
            );
          })}
        </div>

        {/* Split view: Discovery (60%) | Your Library (40%) */}
        <div className="flex-1 min-h-0 flex gap-0">
          {/* Left panel — Discovery Results */}
          <div className="w-[60%] border-r border-border overflow-y-auto p-4">
            <h2 className="text-sm font-semibold text-text mb-3">
              Discovery Results
              {!loading && filteredSkills.length > 0 && (
                <span className="ml-2 text-xs font-normal text-muted">({filteredSkills.length})</span>
              )}
            </h2>

            {/* Loading state */}
            {loading && (
              <div className="flex items-center justify-center h-32 text-muted text-xs">
                <Loader2 size={16} className="animate-spin mr-2" />
                Searching skills.sh...
              </div>
            )}

            {/* Error state */}
            {!loading && error && (
              <div className="flex items-center justify-center h-32 text-red-400 text-xs border border-dashed border-red-500/30 rounded-md gap-2">
                <AlertTriangle size={14} />
                {error}
              </div>
            )}

            {/* Empty state */}
            {!loading && !error && filteredSkills.length === 0 && (
              <div className="flex items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md">
                {searchQuery
                  ? `No skills matching "${searchQuery}"`
                  : 'No skills found'}
              </div>
            )}

            {/* Skills grid */}
            {!loading && !error && filteredSkills.length > 0 && (
              <div className="grid grid-cols-2 gap-4">
                {filteredSkills.map((skill) => {
                  const category = inferCategory(skill.name, skill.description);
                  const colorClass = CATEGORY_COLORS[category] || CATEGORY_COLORS.general;
                  const installed = isInstalled(skill.name);
                  const installing = installState[skill.name] === 'installing';
                  return (
                    <div
                      key={skill.name}
                      className={`flex flex-col gap-2 p-3 bg-surface border rounded-lg transition-colors ${
                        installed
                          ? 'border-green-500/25 bg-green-500/5'
                          : 'border-border hover:border-text/20'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-medium text-text truncate" title={skill.name}>
                          {skill.name}
                        </h3>
                        <span className={`shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full capitalize ${colorClass}`}>
                          {category}
                        </span>
                      </div>
                      <p className="text-xs text-muted line-clamp-2 min-h-[2rem]">
                        {skill.description
                          ? skill.description.slice(0, 100) + (skill.description.length > 100 ? '...' : '')
                          : 'No description available'}
                      </p>
                      {installed ? (
                        <span className="mt-auto flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-400">
                          <Check size={12} />
                          Installed
                        </span>
                      ) : (
                        <button
                          onClick={() => handleInstall(skill.name)}
                          disabled={installing}
                          className="mt-auto flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium
                                     bg-accent/10 text-accent border border-accent/20 rounded-md
                                     hover:bg-accent/20 transition-colors
                                     disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {installing ? (
                            <>
                              <Loader2 size={12} className="animate-spin" />
                              Installing...
                            </>
                          ) : (
                            <>
                              <Download size={12} />
                              Install
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right panel — Your Library */}
          <div className="w-[40%] overflow-y-auto p-4">
            <h2 className="text-sm font-semibold text-text mb-1">
              Your Library{' '}
              {!loadingInstalled && (
                <span className="text-xs font-normal text-muted">({installedSkills.length})</span>
              )}
              {loadingInstalled && <Loader2 size={12} className="inline animate-spin text-muted ml-1" />}
            </h2>
            <p className="text-xs text-muted mb-4">
              {installedSkills.length > 0
                ? 'Manage your installed skills'
                : 'Installed skills will appear here'}
            </p>

            {/* Loading state */}
            {loadingInstalled && installedSkills.length === 0 && (
              <div className="flex items-center justify-center h-32 text-muted text-xs">
                <Loader2 size={16} className="animate-spin mr-2" />
                Loading installed skills...
              </div>
            )}

            {/* Empty state */}
            {!loadingInstalled && installedSkills.length === 0 && (
              <div className="flex items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md">
                No skills installed yet
              </div>
            )}

            {/* Installed skills list */}
            {installedSkills.length > 0 && (
              <div className="space-y-2">
                {installedSkills.map((skill) => {
                  const category = inferCategory(skill.name, skill.description);
                  const colorClass = CATEGORY_COLORS[category] || CATEGORY_COLORS.general;
                  const isRemoving = removingSkill === skill.name;
                  return (
                    <div
                      key={skill.name}
                      className="flex items-start gap-2 p-2.5 rounded-lg border border-border bg-panel hover:border-border/80 transition-colors group"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-semibold text-text">{skill.name}</span>
                          <span className={`px-1 py-0.5 text-[10px] font-mono rounded capitalize ${colorClass}`}>
                            {category}
                          </span>
                        </div>
                        {skill.description && (
                          <p className="text-xs text-muted mt-0.5 line-clamp-2">{skill.description}</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleRemove(skill.name)}
                        disabled={isRemoving}
                        className="shrink-0 mt-0.5 text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all disabled:opacity-50"
                        title="Remove skill"
                      >
                        {isRemoving ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
