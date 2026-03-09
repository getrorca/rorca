import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Wand2, Layers, Activity, Settings,
  Search, PlayCircle, Compass,
  GitBranch, ArrowLeftRight,
  Github, Rss, Users,
  BarChart3, ScrollText, BookOpen, Store,
} from 'lucide-react';
import WorkspaceSelector from './WorkspaceSelector';
import ThemeToggle from './ThemeToggle';
import NotificationBell from './NotificationBell';
import RorcaLogo from './RorcaLogo';
import { UserMenu } from './Shell';
import { PANEL_ROUTES } from '../routes';

// Primary panels shown in sidebar + legacy aliases that still compile everywhere
export type PanelId =
  | 'specs' | 'runs' | 'analytics' | 'direction' | 'settings'
  // Run sub-view (RunViewPanel)
  | 'run-view'
  // Legacy aliases — kept so consuming components compile without changes
  | 'hub' | 'forge' | 'stack' | 'team-direction' | 'queue' | 'pipeline'
  | 'worktrees' | 'compare' | 'archive' | 'github' | 'activity'
  | 'audit-log' | 'marketplace' | 'usage' | 'costs' | 'models'
  | 'velocity' | 'completion' | 'health' | 'roi' | 'finops'
  | 'workspace-settings' | 'spec-review' | 'memory';

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

// ─── ULT-006: 5-item sidebar ────────────────────────────────────────────────

const SIDEBAR_ITEMS: NavItem[] = [
  { id: 'specs',     label: 'Specs',     icon: Layers },
  { id: 'runs',      label: 'Runs',      icon: PlayCircle },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'direction', label: 'Direction', icon: Compass },
  { id: 'settings',  label: 'Settings',  icon: Settings },
];

// Full panel list for CommandPalette deep-linking — kept so ⌘K can reach every panel.
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'specs',
    label: 'Specs',
    items: [
      { id: 'specs', label: 'Specs', icon: Layers },
      { id: 'marketplace', label: 'Skills Marketplace', icon: Store },
    ],
  },
  {
    id: 'runs',
    label: 'Runs',
    items: [
      { id: 'runs', label: 'Runs', icon: PlayCircle },
      { id: 'worktrees', label: 'Worktrees', icon: GitBranch },
      { id: 'compare', label: 'Compare Runs', icon: ArrowLeftRight },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    id: 'direction',
    label: 'Direction',
    items: [
      { id: 'direction', label: 'Direction', icon: Compass },
      { id: 'team-direction', label: 'Team Direction', icon: Users },
      { id: 'memory', label: 'Memory Ledger', icon: BookOpen },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      { id: 'settings', label: 'Settings', icon: Settings },
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
  activeRunCount?: number;
  healthColor?: 'green' | 'amber' | 'red' | null;
}

export default function Sidebar({ onNavigate, mobileOpen, onMobileClose, queueCount = 0, activeRunCount = 0, healthColor }: SidebarProps) {
  // Map toggle drawer event to Command Palette trigger for backwards compat
  useEffect(() => {
    const handler = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    };
    window.addEventListener('rorca:toggle-drawer', handler);
    return () => window.removeEventListener('rorca:toggle-drawer', handler);
  }, []);

  const renderBadge = (item: NavItem) => {
    if (item.id === 'specs' && queueCount > 0) {
      return (
        <span className="ml-auto shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-accent text-white text-[10px] font-bold px-1">
          {queueCount > 99 ? '99+' : queueCount}
        </span>
      );
    }
    if (item.id === 'runs' && activeRunCount > 0) {
      return (
        <span className="ml-auto shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-blue-500 text-white text-[10px] font-bold px-1 animate-pulse">
          {activeRunCount}
        </span>
      );
    }
    if (item.id === 'direction' && healthColor) {
      const colorMap = { green: 'bg-emerald-400', amber: 'bg-amber-400', red: 'bg-red-400' };
      return <span className={`ml-auto shrink-0 w-2 h-2 rounded-full ${colorMap[healthColor]}`} />;
    }
    return null;
  };

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

      {/* Main Navigation — 5 items */}
      <div className="flex-1 overflow-y-auto pt-2 pb-4 min-h-0">
        <div className="space-y-[1px]">
          {SIDEBAR_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.id}
                to={PANEL_ROUTES[item.id]}
                end={false}
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
                    <span className="truncate flex-1">{item.label}</span>
                    {renderBadge(item)}
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

  // Mobile: overlay sidebar + bottom tab bar
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
  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden md:flex h-full">{sidebarContent}</div>
      {/* Mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-panel border-t border-border flex items-center justify-around px-1 py-1 safe-area-bottom">
        {SIDEBAR_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className="flex flex-col items-center gap-0.5 px-2 py-1 rounded text-[10px] text-muted hover:text-[var(--text)] transition-colors relative"
            >
              <Icon size={18} />
              <span className="truncate">{item.label}</span>
              {item.id === 'specs' && queueCount > 0 && (
                <span className="absolute -top-0.5 right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-accent text-white text-[8px] font-bold px-0.5">
                  {queueCount > 99 ? '99+' : queueCount}
                </span>
              )}
              {item.id === 'runs' && activeRunCount > 0 && (
                <span className="absolute -top-0.5 right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-blue-500 text-white text-[8px] font-bold px-0.5 animate-pulse">
                  {activeRunCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}
