import { useEffect, useState } from 'react';
import { useSidebarCollapsed } from './ResizableSidebar';
import { NavLink } from 'react-router-dom';
import {
  Wand2, Layers, Settings,
  Search, PlayCircle, Compass,
  BarChart3, Package, Bot,
} from 'lucide-react';
import WorkspaceSelector from './WorkspaceSelector';
import ThemeToggle from './ThemeToggle';
import NotificationBell from './NotificationBell';
import RorcaLogo from './RorcaLogo';
import { UserMenu } from './Shell';
import { PANEL_ROUTES } from '../routes';
import { useBreakpoint } from '../hooks/useBreakpoint';

// ULT-022: 5 primary panels + run-view + spec-review slide-over + terminal
export type PanelId =
  | 'specs' | 'runs' | 'terminal' | 'analytics' | 'direction' | 'settings' | 'marketplace'
  | 'run-view'
  | 'spec-review';

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
  { id: 'specs',       label: 'Specs',       icon: Layers },
  { id: 'runs',        label: 'Runs',        icon: PlayCircle },
  { id: 'terminal',    label: 'OpenCode',    icon: Bot },
  { id: 'marketplace', label: 'Marketplace', icon: Package },
  { id: 'analytics',   label: 'Analytics',   icon: BarChart3 },
  { id: 'direction',   label: 'Direction',   icon: Compass },
  { id: 'settings',    label: 'Settings',    icon: Settings },
];

// Items shown in mobile bottom tab bar — excludes Terminal (drawer is the mobile entry point)
const MOBILE_TAB_ITEMS: NavItem[] = SIDEBAR_ITEMS.filter(i => i.id !== 'terminal');

// ULT-022: Flat list matching the 5 sidebar items — CommandPalette uses NAV_ITEMS.
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'specs',
    label: 'Specs',
    items: [
      { id: 'specs', label: 'Specs', icon: Layers },
    ],
  },
  {
    id: 'runs',
    label: 'Runs',
    items: [
      { id: 'runs', label: 'Runs', icon: PlayCircle },
    ],
  },
  {
    id: 'terminal',
    label: 'OpenCode',
    items: [
      { id: 'terminal', label: 'OpenCode', icon: Bot },
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
    ],
  },
  {
    id: 'marketplace',
    label: 'Marketplace',
    items: [
      { id: 'marketplace', label: 'Marketplace', icon: Package },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      { id: 'settings', label: 'Settings', icon: Settings },
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
  const breakpoint = useBreakpoint();
  const [tabletExpanded, setTabletExpanded] = useState(false);
  const collapsed = useSidebarCollapsed();

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

  /** Renders a compact badge dot positioned over an icon (for rail / tab bar) */
  const renderIconBadge = (item: NavItem) => {
    if (item.id === 'specs' && queueCount > 0) {
      return (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-accent text-white text-[8px] font-bold px-0.5">
          {queueCount > 99 ? '99+' : queueCount}
        </span>
      );
    }
    if (item.id === 'runs' && activeRunCount > 0) {
      return (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-blue-500 text-white text-[8px] font-bold px-0.5 animate-pulse">
          {activeRunCount}
        </span>
      );
    }
    return null;
  };

  const sidebarContent = (
    <div className="flex flex-col h-full w-full bg-panel border-r border-border shrink-0 font-sans min-w-0">
      {/* Top Section: Logo, Workspace & Search — hidden when collapsed */}
      {collapsed ? (
        /* Collapsed logo — centered icon only */
        <div className="flex items-center justify-center h-12 border-b border-border shrink-0">
          <RorcaLogo size={20} variant="gradient" />
        </div>
      ) : (
        <div className="p-3 flex flex-col gap-1.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 px-1 mb-1">
            <RorcaLogo size={22} variant="gradient" />
            <span className="font-mono font-bold text-[var(--text)] text-sm tracking-tight">Rorca</span>
          </div>
          <WorkspaceSelector />

          <button
            onClick={() => window.dispatchEvent(new Event('rorca:toggle-drawer'))}
            className="flex items-center gap-2 px-2 py-1 rounded text-[13px] text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors min-h-[44px] sm:min-h-0"
            aria-label="Search (⌘K)"
          >
            <Search size={14} className="text-muted/70 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left truncate">Search...</span>
            <kbd className="text-[10px] font-mono text-muted/60 border border-border rounded px-1 shrink-0">⌘K</kbd>
          </button>
        </div>
      )}

      {/* Main Navigation — 5 items */}
      <div className="flex-1 overflow-y-auto pt-2 pb-4 min-h-0" role="list">
        <div className={collapsed ? 'flex flex-col items-center gap-1' : 'space-y-[1px]'}>
          {SIDEBAR_ITEMS.map((item) => {
            const Icon = item.icon;
            if (collapsed) {
              return (
                <NavLink
                  key={item.id}
                  to={PANEL_ROUTES[item.id]}
                  end={false}
                  role="listitem"
                  title={item.label}
                  aria-label={item.label}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(item.id);
                    onMobileClose?.();
                  }}
                  className={({ isActive }) =>
                    `relative flex items-center justify-center w-9 h-9 rounded transition-colors ${isActive
                      ? 'text-accent bg-surface-200'
                      : 'text-muted/70 hover:bg-surface-100 hover:text-[var(--text)]'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <span className="relative">
                      <Icon size={18} className={isActive ? 'text-accent' : undefined} />
                      {renderIconBadge(item)}
                    </span>
                  )}
                </NavLink>
              );
            }
            return (
              <NavLink
                key={item.id}
                to={PANEL_ROUTES[item.id]}
                end={false}
                role="listitem"
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
      <div className={`border-t border-border shrink-0 ${collapsed ? 'flex flex-col items-center gap-1 py-2' : 'px-3 py-2 flex items-center gap-1.5'}`}>
        <UserMenu onNavigate={onNavigate} />
        <NotificationBell onNavigate={onNavigate} />
        <ThemeToggle />
      </div>
    </div>
  );

  // Mobile: overlay sidebar + bottom tab bar
  if (mobileOpen && breakpoint === 'mobile') {
    return (
      <>
        <div className="fixed inset-0 bg-black/50 z-40" onClick={onMobileClose} />
        <nav aria-label="Main navigation" className="fixed top-0 left-0 bottom-0 z-50 animate-slideInLeft shadow-2xl w-[260px]">
          {sidebarContent}
        </nav>
      </>
    );
  }

  // ─── Mobile: bottom tab bar (5 icons + active indicator) ─────────────────
  if (breakpoint === 'mobile') {
    return (
      <nav aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-40 bg-panel border-t border-border flex items-center justify-around px-1 py-1 safe-area-bottom">
        {MOBILE_TAB_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.id}
              to={PANEL_ROUTES[item.id]}
              end={false}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(item.id);
              }}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center gap-0.5 min-w-[44px] min-h-[44px] px-2 py-1 rounded text-[10px] transition-colors relative
                ${isActive ? 'text-accent' : 'text-muted'}`
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon size={20} />
                    {renderIconBadge(item)}
                  </span>
                  <span className="truncate">{item.label}</span>
                  {isActive && (
                    <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full bg-accent" />
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
    );
  }

  // ─── Tablet: collapsed rail (48px, icons only), expandable on hover/click ─
  if (breakpoint === 'tablet') {
    return (
      <nav
        aria-label="Main navigation"
        className="h-full bg-panel border-r border-border flex flex-col shrink-0 transition-all duration-200"
        style={{ width: tabletExpanded ? 200 : 48 }}
        onMouseEnter={() => setTabletExpanded(true)}
        onMouseLeave={() => setTabletExpanded(false)}
      >
        {/* Logo */}
        <div className="flex items-center justify-center h-12 border-b border-border shrink-0">
          <RorcaLogo size={20} variant="gradient" />
          {tabletExpanded && (
            <span className="ml-2 font-mono font-bold text-[var(--text)] text-sm tracking-tight">Rorca</span>
          )}
        </div>

        {/* Nav items */}
        <div className="flex-1 overflow-y-auto pt-2 pb-4 min-h-0">
          <div className="space-y-1">
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
                  }}
                  title={tabletExpanded ? undefined : item.label}
                  className={({ isActive }) =>
                    `flex items-center gap-2 mx-1 rounded transition-colors relative min-h-[44px]
                    ${tabletExpanded ? 'px-3' : 'justify-center px-0'}
                    ${isActive
                      ? 'text-[var(--text)] bg-surface-200 font-medium'
                      : 'text-muted hover:bg-surface-100 hover:text-[var(--text)]'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className="relative shrink-0">
                        <Icon size={18} className={isActive ? 'text-accent' : 'text-muted/70'} />
                        {!tabletExpanded && renderIconBadge(item)}
                      </span>
                      {tabletExpanded && (
                        <>
                          <span className="truncate flex-1 text-[13px]">{item.label}</span>
                          {renderBadge(item)}
                        </>
                      )}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        </div>

        {/* Bottom: search trigger */}
        <div className="border-t border-border p-1 shrink-0 flex flex-col items-center gap-1">
          <button
            onClick={() => window.dispatchEvent(new Event('rorca:toggle-drawer'))}
            title="Search (⌘K)"
            aria-label="Search (⌘K)"
            className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors"
          >
            <Search size={18} aria-hidden="true" />
          </button>
        </div>
      </nav>
    );
  }

  // ─── Desktop: full sidebar (width controlled by ResizableSidebar parent) ──
  return (
    <nav aria-label="Main navigation" className="flex h-full">{sidebarContent}</nav>
  );
}
