import {
  Wand2, Layers, ListChecks, Activity, GitBranch, Archive, ArrowLeftRight,
  Github, Rss, Users, LayoutGrid, Coins, DollarSign, Zap, TrendingUp,
  BarChart3, HeartPulse, ScrollText, Calculator, Settings, Settings2,
  Plus, Hammer, X,
} from 'lucide-react';

export type PanelId = 'hub' | 'forge' | 'stack' | 'team-direction' | 'queue' | 'pipeline' | 'worktrees' | 'compare' | 'archive' | 'github' | 'activity' | 'audit-log' | 'marketplace' | 'usage' | 'costs' | 'models' | 'velocity' | 'completion' | 'health' | 'roi' | 'settings' | 'workspace-settings';

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

// ─── Minimal 4-icon nav ─────────────────────────────────────────────────────

type MinimalNavId = 'new' | 'hub' | 'forge' | 'settings';

interface MinimalNavItem {
  id: MinimalNavId;
  label: string;
  icon: typeof Plus;
  panel: PanelId;
}

const MINIMAL_NAV: MinimalNavItem[] = [
  { id: 'new',      label: 'New Spec',  icon: Plus,     panel: 'forge'    },
  { id: 'hub',      label: 'Hub',       icon: LayoutGrid, panel: 'hub'      },
  { id: 'forge',    label: 'Forge',     icon: Hammer,   panel: 'forge'    },
  { id: 'settings', label: 'Settings',  icon: Settings, panel: 'settings' },
];

/** Maps any PanelId to the MinimalNavId that should be highlighted */
function resolveActiveNav(panel: PanelId): MinimalNavId {
  switch (panel) {
    // Hub — hub screen, pipeline, monitoring, analytics, activity, health
    case 'hub':
    case 'pipeline':
    case 'worktrees':
    case 'compare':
    case 'usage':
    case 'costs':
    case 'models':
    case 'velocity':
    case 'completion':
    case 'health':
    case 'roi':
    case 'audit-log':
    case 'activity':
      return 'hub';
    // Settings — all settings panels
    case 'settings':
    case 'workspace-settings':
    case 'github':
    case 'stack':
    case 'team-direction':
      return 'settings';
    // Forge — spec authoring & review
    case 'forge':
    case 'queue':
    case 'archive':
    case 'marketplace':
    default:
      return 'forge';
  }
}

interface SidebarProps {
  activePanel: PanelId;
  onNavigate: (panel: PanelId) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Sidebar({ activePanel, onNavigate, mobileOpen, onMobileClose }: SidebarProps) {
  const activeNav = resolveActiveNav(activePanel);

  const handleClick = (item: MinimalNavItem) => {
    onNavigate(item.panel);
    onMobileClose?.();
  };

  const renderIcons = () => (
    <div className="flex flex-col items-center gap-1 pt-3">
      {MINIMAL_NAV.map((item) => {
        const isActive = item.id === activeNav && item.id !== 'new';
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            title={item.label}
            onClick={() => handleClick(item)}
            className={`relative w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
              isActive
                ? 'text-accent bg-accent/10'
                : 'text-muted hover:text-[var(--text)] hover:bg-bg'
            }`}
          >
            {isActive && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent rounded-r" />
            )}
            <Icon size={20} strokeWidth={1.5} />
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      {/* Desktop — always-visible 48px icon rail */}
      <nav className="hidden md:flex flex-col items-center w-12 bg-panel border-r border-border shrink-0">
        {renderIcons()}
      </nav>

      {/* Mobile drawer */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={onMobileClose}
          />
          <nav className="fixed top-0 left-0 bottom-0 w-14 bg-panel border-r border-border z-50 md:hidden flex flex-col items-center animate-slideInLeft">
            <div className="h-12 flex items-center justify-center border-b border-border w-full shrink-0">
              <button
                onClick={onMobileClose}
                className="w-10 h-10 flex items-center justify-center text-muted hover:text-[var(--text)] transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            {renderIcons()}
          </nav>
        </>
      )}
    </>
  );
}
