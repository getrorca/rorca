/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Wrench, FileText, Package, Search, Loader2, Download, AlertTriangle, Trash2, Check, TrendingUp, X, ExternalLink } from 'lucide-react';
import type { PanelId } from '../components/Sidebar';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { renderMarkdown } from '../lib/renderMarkdown';

/* ─── Types ───────────────────────────────────────────────────── */

type MarketplaceTab = 'skills' | 'templates' | 'packs';
type SourceFilter = 'skills.sh' | 'github' | 'custom';

interface SkillResult {
  name: string;
  description: string;
  author: string;
  url: string;
  installs?: number;
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

interface GitHubSkillResult {
  name: string;
  description: string;
  path: string;
  installed: boolean;
}

interface GitHubBrowseResponse {
  repo: string;
  branch: string;
  skills: GitHubSkillResult[];
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

/* ─── Skill Preview Modal ─────────────────────────────────────── */

interface SkillPreviewState {
  name: string;
  installed: boolean;
  source?: string;
  category?: string;
}

function SkillPreviewModal({
  skill,
  workspaceId,
  onClose,
  onInstall,
  onUninstall,
}: {
  skill: SkillPreviewState;
  workspaceId: string | null;
  onClose: () => void;
  onInstall: (name: string) => Promise<void>;
  onUninstall: (name: string) => Promise<void>;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [estimatedTokens, setEstimatedTokens] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [isInstalled, setIsInstalled] = useState(skill.installed);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = isInstalled
      ? `/api/skills/${encodeURIComponent(skill.name)}/content${workspaceId ? '?workspaceId=' + workspaceId : ''}`
      : `/api/skills/preview?query=${encodeURIComponent(skill.name)}`;
    apiFetch<{ content: string; wordCount: number; estimatedTokens: number }>(url)
      .then(data => {
        if (cancelled) return;
        setContent(data.content);
        setWordCount(data.wordCount);
        setEstimatedTokens(data.estimatedTokens);
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skill.name, isInstalled, workspaceId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const category = skill.category ?? inferCategory(skill.name, '');
  const colorClass = CATEGORY_COLORS[category] ?? 'bg-zinc-500/15 text-zinc-400';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-panel border border-border rounded-xl shadow-2xl w-[700px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-border shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <Wrench size={16} className={isInstalled ? 'text-green-400' : 'text-accent'} />
              <h2 className="text-base font-semibold text-text">{skill.name}</h2>
              <span className={`px-2 py-0.5 text-[10px] rounded-full font-medium capitalize ${colorClass}`}>{category}</span>
              {isInstalled
                ? <span className="px-2 py-0.5 text-[10px] rounded-full font-medium bg-green-500/15 text-green-400">Installed</span>
                : <span className="px-2 py-0.5 text-[10px] rounded-full font-medium bg-zinc-500/15 text-zinc-400">Not Installed</span>
              }
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-xs text-muted">
              {skill.source && (
                <span className="flex items-center gap-1"><ExternalLink size={10} />{skill.source}</span>
              )}
              {!loading && content && (
                <span>{wordCount.toLocaleString()} words · ~{estimatedTokens.toLocaleString()} tokens</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text transition-colors p-1 -mr-1 -mt-1">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-muted mr-2" />
              <span className="text-sm text-muted">Loading skill content…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center py-12 text-center">
              <AlertTriangle size={24} className="text-red-400 mb-2" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          ) : content ? (
            <div
              className="prose prose-sm prose-invert max-w-none text-text"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted hover:text-text rounded border border-border transition-colors"
          >
            Close
          </button>
          {isInstalled ? (
            <button
              onClick={async () => { setActionLoading(true); await onUninstall(skill.name); setActionLoading(false); onClose(); }}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 border border-red-500/30 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Uninstall
            </button>
          ) : (
            <button
              onClick={async () => { setActionLoading(true); await onInstall(skill.name); setIsInstalled(true); setActionLoading(false); }}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
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

  // GitHub browse state
  const [githubRepoUrl, setGithubRepoUrl] = useState('');
  const [githubSkills, setGithubSkills] = useState<GitHubSkillResult[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);

  // Custom install state
  const [customContent, setCustomContent] = useState('');
  const [customName, setCustomName] = useState('');
  const [customInstalling, setCustomInstalling] = useState(false);

  // Preview modal state
  const [previewSkill, setPreviewSkill] = useState<SkillPreviewState | null>(null);

  const openPreview = useCallback((name: string, installed: boolean, source?: string, category?: string) => {
    setPreviewSkill({ name, installed, source, category });
  }, []);

  // Export installed skills as JSON
  const handleExportSkills = useCallback(() => {
    const exported = installedSkills.map((skill) => ({
      name: skill.name,
      category: inferCategory(skill.name, skill.description),
      installedAt: null, // not tracked by API
    }));
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const filename = `rorca-skills-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.show('Skills exported successfully', 'success');
  }, [installedSkills, toast]);

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

  // Debounced live search for skills.sh + workspace suggestions fallback
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (activeTab !== 'skills' || activeSource !== 'skills.sh') {
      setSkills([]);
      setError(null);
      return;
    }

    clearTimeout(debounceRef.current ?? undefined);

    const trimmed = searchQuery.trim();

    if (trimmed) {
      setLoading(true);
      debounceRef.current = setTimeout(async () => {
        try {
          const data = await apiFetch<SkillSearchResponse>('/api/skills/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: trimmed, limit: 20 }),
          });
          setSkills(data.results);
          setError(null);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : 'Failed to search skills');
        } finally {
          setLoading(false);
        }
      }, 300);
    } else {
      // No query — fetch top skills leaderboard
      setLoading(true);
      apiFetch<SkillSearchResponse>('/api/skills/top')
        .then((data) => {
          setSkills(data.results);
          setError(null);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to fetch top skills');
        })
        .finally(() => {
          setLoading(false);
        });
    }

    return () => clearTimeout(debounceRef.current ?? undefined);
  }, [searchQuery, activeTab, activeSource]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => clearTimeout(debounceRef.current ?? undefined);
  }, []);

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

  // GitHub browse handler
  const handleBrowseGitHub = useCallback(async () => {
    const url = githubRepoUrl.trim();
    if (!url) return;
    setGithubLoading(true);
    setGithubError(null);
    try {
      const data = await apiFetch<GitHubBrowseResponse>('/api/skills/browse-github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: url }),
      });
      setGithubSkills(data.skills);
    } catch (err: unknown) {
      setGithubError(err instanceof Error ? err.message : 'Failed to browse repository');
    } finally {
      setGithubLoading(false);
    }
  }, [githubRepoUrl]);

  // Install from GitHub handler
  const handleInstallFromGitHub = useCallback(async (skill: GitHubSkillResult) => {
    setInstallState(s => ({ ...s, [skill.name]: 'installing' }));
    try {
      await apiFetch('/api/skills/install-from-github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: githubRepoUrl.trim(), skillPath: skill.path, workspaceId }),
      });
      setInstallState(s => ({ ...s, [skill.name]: 'done' }));
      toast.show(`Skill "${skill.name}" installed`, 'success');
      setGithubSkills(prev => prev.map(s => s.name === skill.name ? { ...s, installed: true } : s));
      await fetchInstalled();
    } catch {
      setInstallState(s => ({ ...s, [skill.name]: 'error' }));
      toast.show(`Failed to install "${skill.name}"`, 'error');
    }
  }, [githubRepoUrl, workspaceId, fetchInstalled, toast]);

  // Custom install handler
  const handleInstallCustom = useCallback(async () => {
    const name = customName.trim();
    const content = customContent.trim();
    if (!name || !content) return;
    setCustomInstalling(true);
    try {
      await apiFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content, source: 'user' }),
      });
      toast.show(`Skill "${name}" installed`, 'success');
      setCustomContent('');
      setCustomName('');
      await fetchInstalled();
    } catch (err: unknown) {
      toast.show(err instanceof Error ? err.message : 'Install failed', 'error');
    } finally {
      setCustomInstalling(false);
    }
  }, [customName, customContent, fetchInstalled, toast]);

  // Reset source-specific state when switching activeSource
  useEffect(() => {
    if (activeSource === 'github') {
      setGithubSkills([]);
      setGithubError(null);
    } else if (activeSource === 'custom') {
      setCustomContent('');
      setCustomName('');
    }
  }, [activeSource]);

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
        {/* Search bar + Source pills — only for skills tab */}
        {activeTab === 'skills' && (
          <>
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
                  placeholder="Search skills.sh..."
                  className="w-full pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-md
                             text-text placeholder:text-muted
                             focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent
                             transition-colors"
                />
              </div>
            </div>

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
          </>
        )}

        {/* Split view: Discovery (60%) | Your Library (40%) */}
        <div className="flex-1 min-h-0 flex gap-0">
          {/* Left panel — Discovery / Browse */}
          <div className="w-[60%] border-r border-border overflow-y-auto p-4">
            {/* skills.sh source */}
            {activeTab === 'skills' && activeSource === 'skills.sh' && (
              <>
                <h2 className="text-sm font-semibold text-text mb-3">
                  {searchQuery.trim() ? 'Search Results' : 'Top Skills'}
                  {!loading && skills.length > 0 && (
                    <span className="ml-2 text-xs font-normal text-muted">({skills.length})</span>
                  )}
                </h2>

                {loading && (
                  <div className="flex items-center justify-center h-32 text-muted text-xs">
                    <Loader2 size={16} className="animate-spin mr-2" />
                    {searchQuery.trim() ? 'Searching skills.sh...' : 'Loading top skills...'}
                  </div>
                )}

                {!loading && error && (
                  <div className="flex items-center justify-center h-32 text-red-400 text-xs border border-dashed border-red-500/30 rounded-md gap-2">
                    <AlertTriangle size={14} />
                    {error}
                  </div>
                )}

                {!loading && !error && skills.length === 0 && (
                  <div className="flex items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md">
                    {searchQuery
                      ? `No skills matching "${searchQuery}"`
                      : 'No top skills available'}
                  </div>
                )}

                {!loading && !error && skills.length > 0 && (
                  <div className="grid grid-cols-2 gap-4">
                    {skills.map((skill) => {
                      const category = inferCategory(skill.name, skill.description);
                      const colorClass = CATEGORY_COLORS[category] || CATEGORY_COLORS.general;
                      const installed = isInstalled(skill.name);
                      const installing = installState[skill.name] === 'installing';
                      return (
                        <div
                          key={skill.name}
                          onClick={() => openPreview(skill.name, installed, skill.url, inferCategory(skill.name, skill.description))}
                          className={`flex flex-col gap-2 p-3 bg-surface border rounded-lg transition-colors cursor-pointer ${
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
                          {!searchQuery.trim() && skill.installs != null && skill.installs > 0 && (
                            <span className="inline-flex items-center gap-1 self-start px-2 py-0.5 text-[10px] font-medium text-purple-400 bg-purple-500/10 border border-purple-500/20 rounded-full">
                              <TrendingUp size={10} />
                              {new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(skill.installs)} installs
                            </span>
                          )}
                          {installed ? (
                            <span className="mt-auto flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-400">
                              <Check size={12} />
                              Installed
                            </span>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleInstall(skill.name); }}
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
              </>
            )}

            {/* GitHub source */}
            {activeTab === 'skills' && activeSource === 'github' && (
              <>
                <h2 className="text-sm font-semibold text-text mb-3">Browse GitHub Repository</h2>

                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="text"
                    value={githubRepoUrl}
                    onChange={(e) => setGithubRepoUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleBrowseGitHub()}
                    placeholder="https://github.com/owner/repo or owner/repo"
                    className="flex-1 px-3 py-2 text-sm bg-surface border border-border rounded-md
                               text-text placeholder:text-muted
                               focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent
                               transition-colors"
                  />
                  <button
                    onClick={handleBrowseGitHub}
                    disabled={githubLoading || !githubRepoUrl.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium
                               bg-accent text-white rounded-md hover:bg-accent/90
                               transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {githubLoading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                    Browse
                  </button>
                </div>

                {githubError && (
                  <div className="flex items-center gap-2 p-3 rounded-md border border-red-500/30 bg-red-500/5 text-red-400 text-xs mb-4">
                    <AlertTriangle size={14} className="shrink-0" />
                    <span>{githubError}</span>
                  </div>
                )}

                {githubLoading && (
                  <div className="flex items-center justify-center h-32 text-muted text-xs">
                    <Loader2 size={16} className="animate-spin mr-2" />
                    Browsing repository...
                  </div>
                )}

                {!githubLoading && githubSkills.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted mb-2">
                      {githubSkills.length} skill{githubSkills.length !== 1 ? 's' : ''} found
                    </p>
                    {githubSkills.map((skill) => {
                      const installed = skill.installed || isInstalled(skill.name) || installState[skill.name] === 'done';
                      const installing = installState[skill.name] === 'installing';
                      const errored = installState[skill.name] === 'error';
                      return (
                        <div
                          key={skill.path}
                          className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                            installed ? 'border-green-500/25 bg-green-500/5' : 'border-border bg-surface'
                          }`}
                        >
                          <Wrench size={14} className={`mt-0.5 shrink-0 ${installed ? 'text-green-400' : 'text-accent/70'}`} />
                          <div className="min-w-0 flex-1">
                            <span className="text-sm font-medium text-text">{skill.name}</span>
                            {skill.description && <p className="text-xs text-muted mt-0.5 line-clamp-2">{skill.description}</p>}
                            <p className="text-[10px] text-muted/50 font-mono mt-0.5">{skill.path}</p>
                          </div>
                          <div className="shrink-0">
                            {installed ? (
                              <span className="flex items-center gap-1 px-2 py-1 text-xs text-green-400">
                                <Check size={12} /> Installed
                              </span>
                            ) : installing ? (
                              <div className="flex items-center gap-1 px-2 py-1 text-xs text-muted">
                                <Loader2 size={12} className="animate-spin" /> Installing...
                              </div>
                            ) : errored ? (
                              <button
                                onClick={() => handleInstallFromGitHub(skill)}
                                className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded transition-colors"
                              >
                                <AlertTriangle size={12} /> Retry
                              </button>
                            ) : (
                              <button
                                onClick={() => handleInstallFromGitHub(skill)}
                                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded transition-colors"
                              >
                                <Download size={12} /> Install
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!githubLoading && !githubError && githubSkills.length === 0 && !githubRepoUrl.trim() && (
                  <div className="flex flex-col items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md gap-2">
                    <Wrench size={24} className="opacity-40" />
                    Enter a GitHub repo URL to browse for skills
                  </div>
                )}
              </>
            )}

            {/* Custom source */}
            {activeTab === 'skills' && activeSource === 'custom' && (
              <>
                <h2 className="text-sm font-semibold text-text mb-3">Install Custom Skill</h2>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Skill Name</label>
                    <input
                      type="text"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder="my-skill"
                      className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-md
                                 text-text placeholder:text-muted
                                 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent
                                 transition-colors"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">SKILL.md Content</label>
                    <textarea
                      value={customContent}
                      onChange={(e) => setCustomContent(e.target.value)}
                      rows={10}
                      placeholder="Paste your SKILL.md content here..."
                      className="w-full px-3 py-2 text-sm font-mono bg-surface border border-border rounded-md
                                 text-text placeholder:text-muted
                                 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent
                                 transition-colors resize-y"
                    />
                  </div>

                  <button
                    onClick={handleInstallCustom}
                    disabled={customInstalling || !customName.trim() || !customContent.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium
                               bg-accent text-white rounded-md hover:bg-accent/90
                               transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {customInstalling ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    Install
                  </button>
                </div>
              </>
            )}

            {activeTab === 'templates' && (
              <>
                <h2 className="text-sm font-semibold text-text mb-3">Browse Templates</h2>
                <div className="flex flex-col items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md gap-2">
                  <FileText size={24} className="opacity-40" />
                  Templates marketplace coming soon
                </div>
              </>
            )}

            {activeTab === 'packs' && (
              <>
                <h2 className="text-sm font-semibold text-text mb-3">Browse Convention Packs</h2>
                <div className="flex flex-col items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md gap-2">
                  <Package size={24} className="opacity-40" />
                  Convention packs marketplace coming soon
                </div>
              </>
            )}
          </div>

          {/* Right panel — Your Library / Your Items */}
          <div className="w-[40%] overflow-y-auto p-4">
            {activeTab === 'skills' && (
              <>
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-sm font-semibold text-text">
                    Your Library{' '}
                    {!loadingInstalled && (
                      <span className="text-xs font-normal text-muted">({installedSkills.length})</span>
                    )}
                    {loadingInstalled && <Loader2 size={12} className="inline animate-spin text-muted ml-1" />}
                  </h2>
                  <button
                    onClick={handleExportSkills}
                    disabled={installedSkills.length === 0}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-text rounded-md hover:bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted"
                    title="Export skills as JSON"
                  >
                    <Download size={12} />
                    Export
                  </button>
                </div>
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
                          onClick={() => openPreview(skill.name, true, skill.source, inferCategory(skill.name, skill.description))}
                          className="flex items-start gap-2 p-2.5 rounded-lg border border-border bg-panel hover:border-border/80 transition-colors group cursor-pointer"
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
                            onClick={(e) => { e.stopPropagation(); handleRemove(skill.name); }}
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
              </>
            )}

            {activeTab === 'templates' && (
              <>
                <h2 className="text-sm font-semibold text-text mb-1">
                  Your Templates <span className="text-xs font-normal text-muted">(0)</span>
                </h2>
                <p className="text-xs text-muted mb-4">
                  Saved templates will appear here
                </p>
                <div className="flex items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md">
                  No templates saved yet
                </div>
              </>
            )}

            {activeTab === 'packs' && (
              <>
                <h2 className="text-sm font-semibold text-text mb-1">
                  Your Packs <span className="text-xs font-normal text-muted">(0)</span>
                </h2>
                <p className="text-xs text-muted mb-4">
                  Installed packs will appear here
                </p>
                <div className="flex items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md">
                  No packs installed yet
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Skill Preview Modal */}
      {previewSkill && (
        <SkillPreviewModal
          skill={previewSkill}
          workspaceId={workspaceId ?? null}
          onClose={() => setPreviewSkill(null)}
          onInstall={handleInstall}
          onUninstall={handleRemove}
        />
      )}
    </div>
  );
}
