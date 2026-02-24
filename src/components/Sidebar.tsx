import { useState, useEffect, useCallback } from 'react';
import {
  Wand2, Layers, ListChecks, Activity, GitBranch, Archive, ArrowLeftRight,
  Github, Rss, Users, LayoutGrid, Coins, DollarSign, Zap, TrendingUp,
  BarChart3, HeartPulse, ScrollText, Calculator, Settings, Settings2,
  X, ChevronDown, ChevronRight, PanelLeftClose, PanelLeft, Plus, Play, Command,
  ChevronsUpDown, FolderGit2,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import AddWorkspaceModal from './AddWorkspaceModal';
import { apiFetch } from '../lib/apiFetch';

export type PanelId = 'forge' | 'stack' | 'team-direction' | 'queue' | 'pipeline' | 'worktrees' | 'compare' | 'archive' | 'github' | 'activity' | 'audit-log' | 'marketplace' | 'usage' | 'costs' | 'models' | 'velocity' | 'completion' | 'health' | 'roi' | 'settings' | 'workspace-settings';

interface NavItem {
  id: PanelId;
  label: string;
  icon: typeof Wand2;
}

interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'specs',
    label: 'Specs',
    items: [
      { id: 'forge',       label: 'Forge',              icon: Wand2      },
      { id: 'queue',       label: 'Review Queue',       icon: ListChecks },
      { id: 'archive',     label: 'Archive',            icon: Archive    },
      { id: 'marketplace', label: 'Templates',          icon: LayoutGrid },
    ],
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    items: [
      { id: 'pipeline',   label: 'Monitor',            icon: Activity       },
      { id: 'worktrees',  label: 'Worktrees',          icon: GitBranch      },
      { id: 'compare',    label: 'Compare Runs',       icon: ArrowLeftRight },
    ],
  },
  {
    id: 'direction',
    label: 'Direction',
    items: [
      { id: 'stack',           label: 'Direction Stack',   icon: Layers },
      { id: 'team-direction',  label: 'Team Direction',    icon: Users  },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { id: 'usage',      label: 'Token Usage',        icon: Coins      },
      { id: 'costs',      label: 'Cost Breakdown',     icon: DollarSign },
      { id: 'models',     label: 'Model Comparison',   icon: Zap        },
      { id: 'velocity',   label: 'Velocity Chart',     icon: TrendingUp },
      { id: 'completion', label: 'Completion Rates',   icon: BarChart3  },
      { id: 'roi',        label: 'ROI Calculator',     icon: Calculator },
      { id: 'health',     label: 'Health',             icon: HeartPulse },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'audit-log',          label: 'Audit Log',           icon: ScrollText },
      { id: 'activity',           label: 'Activity Feed',       icon: Rss        },
      { id: 'github',             label: 'GitHub',              icon: Github     },
      { id: 'workspace-settings', label: 'Workspace Settings',  icon: Settings2  },
      { id: 'settings',           label: 'Settings',            icon: Settings   },
    ],
  },
];

// Flat list for backward compat (used by CommandPalette, etc.)
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

const LS_COLLAPSED_KEY = 'rorcha_sidebar_collapsed';
const LS_SECTIONS_KEY = 'rorcha_sidebar_sections';

function loadCollapsed(): boolean {
  try { return localStorage.getItem(LS_COLLAPSED_KEY) === '1'; } catch { return false; }
}

function loadSectionState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_SECTIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ─── Badge counts ────────────────────────────────────────────────────────────

interface BadgeCounts {
  pendingSpecs: number;
  activeRuns: number;
}

function useBadgeCounts(workspaceId: string | null): BadgeCounts {
  const [counts, setCounts] = useState<BadgeCounts>({ pendingSpecs: 0, activeRuns: 0 });

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;

    const fetchCounts = () => {
      apiFetch<{ pending_specs_count?: number; active_runs?: number }>('/api/health')
        .then((data) => {
          if (cancelled) return;
          setCounts({
            pendingSpecs: data.pending_specs_count ?? 0,
            activeRuns: data.active_runs ?? 0,
          });
        })
        .catch(() => {});
    };

    fetchCounts();
    const interval = setInterval(fetchCounts, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [workspaceId]);

  return counts;
}

// ─── Workspace Switcher (sidebar-embedded) ──────────────────────────────────

function SidebarWorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { workspaceId, setWorkspaceId, workspaces, addWorkspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const selected = workspaces.find((w) => w.id === workspaceId);

  if (collapsed) {
    return (
      <div className="px-1.5 py-2 border-b border-border">
        <button
          onClick={() => setOpen(!open)}
          className="w-full h-9 flex items-center justify-center rounded text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
          title={selected?.name ?? 'Switch workspace'}
        >
          <FolderGit2 size={18} strokeWidth={1.5} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute left-12 top-2 w-52 bg-panel border border-border rounded shadow-lg z-50">
              <div className="px-3 py-1.5 text-xs text-muted font-medium border-b border-border">Workspaces</div>
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={() => { setWorkspaceId(w.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-bg transition-colors ${
                    w.id === workspaceId ? 'text-accent' : 'text-[var(--text)]'
                  }`}
                >
                  {w.name}
                </button>
              ))}
              <div className="border-t border-border" />
              <button
                onClick={() => { setOpen(false); setShowAddModal(true); }}
                className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg transition-colors"
              >
                + Add Workspace
              </button>
            </div>
          </>
        )}
        {showAddModal && (
          <AddWorkspaceModal
            onClose={() => setShowAddModal(false)}
            onSuccess={(ws) => { addWorkspace(ws); setShowAddModal(false); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-border">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm bg-bg border border-border hover:border-accent transition-colors"
      >
        <FolderGit2 size={14} className="text-muted shrink-0" />
        <span className="truncate flex-1 text-left text-[var(--text)]">{selected?.name ?? 'Select workspace'}</span>
        <ChevronsUpDown size={14} className="text-muted shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-3 right-3 mt-1 bg-panel border border-border rounded shadow-lg z-50" style={{ width: 'calc(100% - 24px)', maxWidth: '220px' }}>
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => { setWorkspaceId(w.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-bg transition-colors ${
                  w.id === workspaceId ? 'text-accent' : 'text-[var(--text)]'
                }`}
              >
                {w.name}
              </button>
            ))}
            {workspaces.length > 0 && <div className="border-t border-border" />}
            <button
              onClick={() => { setOpen(false); setShowAddModal(true); }}
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg transition-colors"
            >
              + Add Workspace
            </button>
          </div>
        </>
      )}

      {showAddModal && (
        <AddWorkspaceModal
          onClose={() => setShowAddModal(false)}
          onSuccess={(ws) => { addWorkspace(ws); setShowAddModal(false); }}
        />
      )}
    </div>
  );
}

// ─── Quick Actions ───────────────────────────────────────────────────────────

interface QuickActionsProps {
  collapsed: boolean;
  onNavigate: (panel: PanelId) => void;
  onTriggerRun?: () => void;
  onCommandPalette?: () => void;
}

function QuickActions({ collapsed, onNavigate, onTriggerRun, onCommandPalette }: QuickActionsProps) {
  const actions = [
    { label: 'New Spec',         icon: Plus,    onClick: () => onNavigate('forge') },
    { label: 'Trigger Run',      icon: Play,    onClick: onTriggerRun ?? (() => onNavigate('pipeline')) },
    { label: 'Command Palette',  icon: Command, onClick: onCommandPalette },
  ];

  if (collapsed) {
    return (
      <div className="px-1.5 py-2 border-t border-border flex flex-col gap-1">
        {actions.map(({ label, icon: Icon, onClick }) => (
          <button
            key={label}
            title={label}
            onClick={onClick}
            className="w-full h-9 flex items-center justify-center rounded text-muted hover:text-accent hover:bg-accent/10 transition-colors"
          >
            <Icon size={16} strokeWidth={1.5} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-t border-border flex flex-col gap-1">
      {actions.map(({ label, icon: Icon, onClick }) => (
        <button
          key={label}
          onClick={onClick}
          className="w-full h-8 flex items-center gap-2 px-2 rounded text-xs text-muted hover:text-accent hover:bg-accent/10 transition-colors"
        >
          <Icon size={14} strokeWidth={1.5} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Section Badge ───────────────────────────────────────────────────────────

function SectionBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto px-1.5 py-0.5 text-[10px] leading-none font-medium rounded-full bg-accent/15 text-accent">
      {count > 99 ? '99+' : count}
    </span>
  );
}

// ─── Main Sidebar ────────────────────────────────────────────────────────────

interface SidebarProps {
  activePanel: PanelId;
  onNavigate: (panel: PanelId) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  onCommandPalette?: () => void;
}

export default function Sidebar({ activePanel, onNavigate, mobileOpen, onMobileClose, onCommandPalette }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    const saved = loadSectionState();
    // Default all sections open
    const defaults: Record<string, boolean> = {};
    for (const section of NAV_SECTIONS) defaults[section.id] = true;
    return { ...defaults, ...saved };
  });
  const { workspaceId } = useWorkspace();
  const badgeCounts = useBadgeCounts(workspaceId);

  // Persist collapsed state
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_COLLAPSED_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  // Persist section open/closed state
  const toggleSection = useCallback((sectionId: string) => {
    setOpenSections((prev) => {
      const next = { ...prev, [sectionId]: !prev[sectionId] };
      try { localStorage.setItem(LS_SECTIONS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const handleNav = (id: PanelId) => {
    onNavigate(id);
    onMobileClose?.();
  };

  // Find which section the active panel belongs to
  const activeSectionId = NAV_SECTIONS.find((s) => s.items.some((item) => item.id === activePanel))?.id;

  // Badge count per section
  const sectionBadge = (sectionId: string): number => {
    switch (sectionId) {
      case 'specs': return badgeCounts.pendingSpecs;
      case 'pipeline': return badgeCounts.activeRuns;
      default: return 0;
    }
  };

  // ─── Expanded nav content (shared between desktop expanded and mobile) ─────

  const renderExpandedNav = () => (
    <>
      <SidebarWorkspaceSwitcher collapsed={false} />

      <div className="flex-1 overflow-y-auto py-1">
        {NAV_SECTIONS.map((section) => {
          const isOpen = openSections[section.id] ?? true;
          const badge = sectionBadge(section.id);
          const sectionHasActive = section.id === activeSectionId;

          return (
            <div key={section.id} className="mb-0.5">
              {/* Section header */}
              <button
                onClick={() => toggleSection(section.id)}
                className={`w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors ${
                  sectionHasActive ? 'text-accent' : 'text-muted hover:text-[var(--text)]'
                }`}
              >
                {isOpen
                  ? <ChevronDown size={12} strokeWidth={2} />
                  : <ChevronRight size={12} strokeWidth={2} />
                }
                <span>{section.label}</span>
                <SectionBadge count={badge} />
              </button>

              {/* Section items */}
              {isOpen && (
                <div className="pb-1">
                  {section.items.map(({ id, label, icon: Icon }) => {
                    const isActive = activePanel === id;
                    return (
                      <button
                        key={id}
                        onClick={() => handleNav(id)}
                        className={`relative w-full h-9 flex items-center gap-2.5 pl-7 pr-3 transition-colors ${
                          isActive
                            ? 'text-accent bg-accent/10'
                            : 'text-muted hover:text-[var(--text)] hover:bg-bg'
                        }`}
                      >
                        {isActive && (
                          <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent rounded-r" />
                        )}
                        <Icon size={16} strokeWidth={1.5} />
                        <span className="text-sm truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <QuickActions collapsed={false} onNavigate={handleNav} onCommandPalette={onCommandPalette} />

      {/* Collapse toggle */}
      <div className="px-3 py-2 border-t border-border">
        <button
          onClick={toggleCollapsed}
          className="w-full h-8 flex items-center gap-2 px-2 rounded text-xs text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
          title="Collapse sidebar"
        >
          <PanelLeftClose size={14} strokeWidth={1.5} />
          <span>Collapse</span>
        </button>
      </div>
    </>
  );

  // ─── Collapsed nav content (icon-only) ─────────────────────────────────────

  const renderCollapsedNav = () => (
    <>
      <SidebarWorkspaceSwitcher collapsed />

      <div className="flex-1 overflow-y-auto py-1 flex flex-col items-center gap-0.5">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="w-full flex flex-col items-center">
            {/* Section divider (thin line between groups) */}
            <div className="w-6 border-t border-border my-1" />
            {section.items.map(({ id, label, icon: Icon }) => {
              const isActive = activePanel === id;
              return (
                <button
                  key={id}
                  title={label}
                  onClick={() => onNavigate(id)}
                  className={`relative w-11 h-9 flex items-center justify-center rounded transition-colors ${
                    isActive
                      ? 'text-accent bg-accent/10'
                      : 'text-muted hover:text-[var(--text)] hover:bg-bg'
                  }`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent rounded-r" />
                  )}
                  <Icon size={18} strokeWidth={1.5} />
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <QuickActions collapsed onNavigate={handleNav} onCommandPalette={onCommandPalette} />

      {/* Expand toggle */}
      <div className="px-1.5 py-2 border-t border-border">
        <button
          onClick={toggleCollapsed}
          className="w-full h-9 flex items-center justify-center rounded text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
          title="Expand sidebar"
        >
          <PanelLeft size={16} strokeWidth={1.5} />
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <nav
        className={`hidden md:flex flex-col bg-panel border-r border-border shrink-0 transition-[width] duration-200 ${
          collapsed ? 'w-14' : 'w-56'
        }`}
      >
        {collapsed ? renderCollapsedNav() : renderExpandedNav()}
      </nav>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={onMobileClose}
          />
          <nav className="fixed top-0 left-0 bottom-0 w-64 bg-panel border-r border-border z-50 md:hidden flex flex-col animate-slideInLeft">
            {/* Drawer header */}
            <div className="h-12 flex items-center justify-between px-4 border-b border-border shrink-0">
              <span className="font-mono font-bold text-accent text-sm tracking-tight">rorcha</span>
              <button
                onClick={onMobileClose}
                className="w-11 h-11 flex items-center justify-center text-muted hover:text-[var(--text)] transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {renderExpandedNav()}
          </nav>
        </>
      )}
    </>
  );
}
