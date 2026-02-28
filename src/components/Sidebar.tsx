import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useHotkeys, type HotkeyBinding } from '../hooks/useHotkeys';
import {
  Wand2, Layers, ListChecks, Activity, GitBranch, Archive, ArrowLeftRight,
  Github, Rss, Users, LayoutGrid, Coins, DollarSign, Zap, TrendingUp,
  BarChart3, HeartPulse, ScrollText, Calculator, Settings, Settings2,
  Plus, X, Search, ChevronDown, BookOpen,
} from 'lucide-react';
import WorkspaceSelector from './WorkspaceSelector';
import ThemeToggle from './ThemeToggle';
import NotificationBell from './NotificationBell';
import { UserMenu } from './Shell';
import { PANEL_ROUTES } from '../routes';

export type PanelId = 'hub' | 'forge' | 'stack' | 'team-direction' | 'queue' | 'pipeline' | 'worktrees' | 'compare' | 'archive' | 'github' | 'activity' | 'audit-log' | 'marketplace' | 'usage' | 'costs' | 'models' | 'velocity' | 'completion' | 'health' | 'roi' | 'finops' | 'settings' | 'workspace-settings' | 'spec-review' | 'memory';

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

// Kept for CommandPalette and other consumers that need the full panel list
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'specs',
    label: 'Specs',
    items: [
      { id: 'forge', label: 'Forge', icon: Wand2 },
      { id: 'queue', label: 'Review Queue', icon: ListChecks },
      { id: 'archive', label: 'Archive', icon: Archive },
      { id: 'marketplace', label: 'Templates', icon: LayoutGrid },
    ],
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    items: [
      { id: 'pipeline', label: 'Monitor', icon: Activity },
      { id: 'worktrees', label: 'Worktrees', icon: GitBranch },
      { id: 'compare', label: 'Compare Runs', icon: ArrowLeftRight },
    ],
  },
  {
    id: 'direction',
    label: 'Direction',
    items: [
      { id: 'stack', label: 'Direction Stack', icon: Layers },
      { id: 'team-direction', label: 'Team Direction', icon: Users },
      { id: 'memory', label: 'Memory Ledger', icon: BookOpen },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { id: 'usage', label: 'Token Usage', icon: Coins },
      { id: 'costs', label: 'Cost Breakdown', icon: DollarSign },
      { id: 'models', label: 'Model Comparison', icon: Zap },
      { id: 'velocity', label: 'Velocity Chart', icon: TrendingUp },
      { id: 'completion', label: 'Completion Rates', icon: BarChart3 },
      { id: 'roi', label: 'ROI Calculator', icon: Calculator },
      { id: 'finops', label: 'FinOps', icon: DollarSign },
      { id: 'health', label: 'Health', icon: HeartPulse },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'audit-log', label: 'Audit Log', icon: ScrollText },
      { id: 'activity', label: 'Activity Feed', icon: Rss },
      { id: 'github', label: 'GitHub', icon: Github },
      { id: 'workspace-settings', label: 'Workspace Settings', icon: Settings2 },
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

// Flat list for backward compat (used by CommandPalette, etc.)
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

// ─── Section collapse persistence ────────────────────────────────────────────

const COLLAPSED_KEY = 'rorca:sidebar-collapsed-sections';

function getCollapsedSections(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* noop */ }
  return new Set();
}

function persistCollapsedSections(sections: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...sections]));
  } catch { /* noop */ }
}

// ─── Minimal 5-icon nav (kept for resolveActiveNav compat) ───────────────────

type MinimalNavId = 'search' | 'hub' | 'forge' | 'pipeline' | 'settings';

/** Maps any PanelId to the MinimalNavId that should be highlighted */
function resolveActiveNav(panel: PanelId): MinimalNavId {
  switch (panel) {
    case 'hub': case 'queue': return 'hub';
    case 'pipeline': case 'worktrees': case 'compare': return 'pipeline';
    case 'settings': case 'workspace-settings': case 'github': case 'stack':
    case 'team-direction': case 'usage': case 'costs': case 'models':
    case 'velocity': case 'completion': case 'health': case 'roi':
    case 'audit-log': case 'activity': return 'settings';
    case 'forge': case 'archive': case 'marketplace': case 'spec-review':
    default: return 'forge';
  }
}

interface SidebarProps {
  onNavigate: (panel: PanelId) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  queueCount?: number;
}

export default function Sidebar({ onNavigate, mobileOpen, onMobileClose, queueCount = 0 }: SidebarProps) {
  const [collapsedSections, setCollapsedSections] = useState(getCollapsedSections);

  // Map toggle drawer event to Command Palette trigger for backwards compat
  useEffect(() => {
    const handler = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    };
    window.addEventListener('rorca:toggle-drawer', handler);
    return () => window.removeEventListener('rorca:toggle-drawer', handler);
  }, []);

  const toggleSection = (sectionId: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      persistCollapsedSections(next);
      return next;
    });
  };

  // Expand standard nav sections with collapsible headers
  const renderNavSection = (section: NavSection) => {
    const isCollapsed = collapsedSections.has(section.id);

    return (
      <div key={section.id} className="mb-1">
        {/* Collapsible section header */}
        <button
          onClick={() => toggleSection(section.id)}
          className="w-full flex items-center justify-between px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted/70 hover:text-muted transition-colors cursor-pointer select-none group"
        >
          <span>{section.label}</span>
          <ChevronDown
            size={12}
            className={`text-muted/50 group-hover:text-muted transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`}
          />
        </button>

        {/* Collapsible items container */}
        <div
          className="overflow-hidden transition-all duration-200 ease-out"
          style={{
            maxHeight: isCollapsed ? 0 : `${section.items.length * 32 + 8}px`,
            opacity: isCollapsed ? 0 : 1,
          }}
        >
          <div className="space-y-[1px] pb-1">
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={PANEL_ROUTES[item.id]}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(item.id);
                    onMobileClose?.();
                  }}
                  className={({ isActive }) => `w-[calc(100%-16px)] flex items-center gap-2 px-3 mx-2 py-1 rounded text-[13px] transition-colors ${isActive
                    ? 'text-[var(--text)] bg-surface-200 font-medium'
                    : 'text-muted hover:bg-surface-100 hover:text-[var(--text)]'
                    }`}
                >
                  {({ isActive }) => (
                    <>
                      <Icon size={14} className={isActive ? 'text-accent' : 'text-muted/70'} />
                      <span className="truncate">{item.label}</span>
                      {item.id === 'queue' && queueCount > 0 && (
                        <span className="ml-auto min-w-[16px] h-4 flex items-center justify-center px-1 text-[10px] font-bold rounded-full bg-accent text-white leading-none">
                          {queueCount > 99 ? '99+' : queueCount}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const sidebarContent = (
    <div className="flex flex-col h-full w-full bg-panel border-r border-border shrink-0 font-sans min-w-0">
      {/* Top Section: Workspace & Primary Actions */}
      <div className="p-3 flex flex-col gap-1.5 border-b border-border shrink-0">
        <WorkspaceSelector />

        <button
          onClick={() => window.dispatchEvent(new Event('rorca:toggle-drawer'))}
          className="flex items-center gap-2 px-2 py-1 rounded text-[13px] text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors"
        >
          <Search size={14} className="text-muted/70 shrink-0" />
          <span className="flex-1 text-left truncate">Search...</span>
          <span className="text-[10px] font-mono text-muted/60 border border-border rounded px-1 shrink-0">⌘K</span>
        </button>

        <NavLink
          to={PANEL_ROUTES.forge}
          onClick={(e) => { e.preventDefault(); onNavigate('forge'); }}
          className="flex items-center gap-2 px-2 py-1 rounded text-[13px] text-accent hover:bg-accent/10 transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-accent"
        >
          <Plus size={14} className="shrink-0" />
          <span className="font-medium truncate">New Spec</span>
          <span className="ml-auto text-[10px] font-mono text-accent/50 border border-accent/20 rounded px-1 shrink-0">C</span>
        </NavLink>
      </div>

      {/* Main Navigation Sections */}
      <div className="flex-1 overflow-y-auto pt-2 pb-4 min-h-0">
        {NAV_SECTIONS.map(renderNavSection)}
      </div>

      {/* Bottom Section: Compact Controls */}
      <div className="px-3 py-2 border-t border-border flex items-center gap-1.5 shrink-0">
        <UserMenu onNavigate={onNavigate} />
        <NotificationBell onNavigate={onNavigate} />
        <ThemeToggle />
      </div>
    </div>
  );

  // If mobile is open, wrap the content in the overlay layout
  if (mobileOpen) {
    return (
      <>
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={onMobileClose} />
        <nav className="fixed top-0 left-0 bottom-0 z-50 animate-slideInLeft shadow-2xl md:hidden w-[260px]">
          {sidebarContent}
        </nav>
      </>
    );
  }

  // Desktop render — width is controlled by ResizableSidebar parent
  return sidebarContent;
}
