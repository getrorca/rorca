import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Wand2, Layers, Activity, Archive, Settings,
  Search, LayoutDashboard, Store,
  GitBranch, ArrowLeftRight,
  Github, Rss, Users, Coins, DollarSign, Zap, TrendingUp,
  BarChart3, HeartPulse, ScrollText, Calculator, BookOpen,
} from 'lucide-react';
import WorkspaceSelector from './WorkspaceSelector';
import ThemeToggle from './ThemeToggle';
import NotificationBell from './NotificationBell';
import RorcaLogo from './RorcaLogo';
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

// ─── Sidebar top-level items (6 flat links, each a unique destination) ───────

const SIDEBAR_ITEMS: NavItem[] = [
  { id: 'hub', label: 'Overview', icon: LayoutDashboard },
  { id: 'forge', label: 'Spec', icon: Wand2 },
  { id: 'archive', label: 'Wake', icon: Archive },
  { id: 'pipeline', label: 'Dive', icon: Activity },
  { id: 'marketplace', label: 'Skills', icon: Store },
  { id: 'stack', label: 'Direction', icon: Layers },
  { id: 'usage', label: 'Analytics', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

// Full panel list for CommandPalette deep-linking — kept so ⌘K can reach every panel.
// Each PanelId appears exactly ONCE. Sidebar items are the primary navigation;
// items here that aren't in SIDEBAR_ITEMS are only reachable via Command Palette.
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'specs',
    label: 'Specs',
    items: [
      { id: 'forge', label: 'Spec', icon: Wand2 },
      { id: 'archive', label: 'Wake', icon: Archive },
      { id: 'marketplace', label: 'Skills', icon: Store },
    ],
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    items: [
      { id: 'pipeline', label: 'Dive', icon: Activity },
      { id: 'worktrees', label: 'Worktrees', icon: GitBranch },
      { id: 'compare', label: 'Compare Runs', icon: ArrowLeftRight },
    ],
  },
  {
    id: 'direction',
    label: 'Direction',
    items: [
      { id: 'stack', label: 'Direction', icon: Layers },
      { id: 'team-direction', label: 'Team Direction', icon: Users },
      { id: 'memory', label: 'Memory Ledger', icon: BookOpen },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      { id: 'settings', label: 'Settings', icon: Settings },
      // Analytics & System accessible via Settings sub-tabs and Command Palette
      { id: 'usage', label: 'Token Usage', icon: Coins },
      { id: 'costs', label: 'Cost Breakdown', icon: DollarSign },
      { id: 'models', label: 'Model Comparison', icon: Zap },
      { id: 'velocity', label: 'Velocity Chart', icon: TrendingUp },
      { id: 'completion', label: 'Completion Rates', icon: BarChart3 },
      { id: 'roi', label: 'ROI Calculator', icon: Calculator },
      { id: 'finops', label: 'FinOps', icon: DollarSign },
      { id: 'health', label: 'Health', icon: HeartPulse },
      { id: 'audit-log', label: 'Audit Log', icon: ScrollText },
      { id: 'activity', label: 'Activity Feed', icon: Rss },
      { id: 'github', label: 'GitHub', icon: Github },
    ],
  },
];

// Flat list for backward compat (used by CommandPalette, etc.)
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

interface SidebarProps {
  onNavigate: (panel: PanelId) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  queueCount?: number;
}

export default function Sidebar({ onNavigate, mobileOpen, onMobileClose }: SidebarProps) {
  // Map toggle drawer event to Command Palette trigger for backwards compat
  useEffect(() => {
    const handler = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    };
    window.addEventListener('rorca:toggle-drawer', handler);
    return () => window.removeEventListener('rorca:toggle-drawer', handler);
  }, []);

  const sidebarContent = (
    <div className="flex flex-col h-full w-full bg-panel border-r border-border shrink-0 font-sans min-w-0">
      {/* Top Section: Logo, Workspace & Search */}
      <div className="p-3 flex flex-col gap-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 px-1 mb-1">
          <RorcaLogo size={22} variant="gradient" />
          <span className="font-mono font-bold text-[var(--text)] text-sm tracking-tight">rorca</span>
        </div>
        <WorkspaceSelector />

        <button
          onClick={() => window.dispatchEvent(new Event('rorca:toggle-drawer'))}
          className="flex items-center gap-2 px-2 py-1 rounded text-[13px] text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors"
        >
          <Search size={14} className="text-muted/70 shrink-0" />
          <span className="flex-1 text-left truncate">Search...</span>
          <span className="text-[10px] font-mono text-muted/60 border border-border rounded px-1 shrink-0">⌘K</span>
        </button>
      </div>

      {/* Main Navigation */}
      <div className="flex-1 overflow-y-auto pt-2 pb-4 min-h-0">
        <div className="space-y-[1px]">
          {SIDEBAR_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.id}
                to={PANEL_ROUTES[item.id]}
                end={item.id === 'hub'}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(item.id);
                  onMobileClose?.();
                }}
                className={({ isActive }) => `w-[calc(100%-16px)] flex items-center gap-2 px-3 mx-2 py-1.5 rounded text-[13px] transition-colors ${isActive
                  ? 'text-[var(--text)] bg-surface-200 font-medium'
                  : 'text-muted hover:bg-surface-100 hover:text-[var(--text)]'
                  }`}
              >
                {({ isActive }) => (
                  <>
                    <Icon size={14} className={isActive ? 'text-accent' : 'text-muted/70'} />
                    <span className="truncate">{item.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
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
