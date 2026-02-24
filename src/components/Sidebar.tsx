import { Wand2, Layers, ListChecks, Activity, GitBranch, Archive, ArrowLeftRight, Github, Rss, Users, LayoutGrid, Coins, DollarSign, Zap, TrendingUp, BarChart3, HeartPulse, ScrollText, X } from 'lucide-react';

export type PanelId = 'forge' | 'stack' | 'team-direction' | 'queue' | 'pipeline' | 'worktrees' | 'compare' | 'archive' | 'github' | 'activity' | 'audit-log' | 'marketplace' | 'usage' | 'costs' | 'models' | 'velocity' | 'completion' | 'health';

export const NAV_ITEMS: { id: PanelId; label: string; icon: typeof Wand2 }[] = [
  { id: 'forge',           label: 'Spec Forge',         icon: Wand2          },
  { id: 'stack',           label: 'Direction Stack',     icon: Layers         },
  { id: 'team-direction',  label: 'Team Direction',      icon: Users          },
  { id: 'queue',           label: 'Review Queue',        icon: ListChecks     },
  { id: 'pipeline',        label: 'Pipeline Monitor',    icon: Activity       },
  { id: 'worktrees',       label: 'Worktree Manager',    icon: GitBranch      },
  { id: 'compare',         label: 'Compare Runs',        icon: ArrowLeftRight },
  { id: 'archive',         label: 'Archive',             icon: Archive        },
  { id: 'marketplace',     label: 'Template Marketplace', icon: LayoutGrid     },
  { id: 'usage',           label: 'Token Usage',          icon: Coins          },
  { id: 'costs',           label: 'Cost Breakdown',       icon: DollarSign     },
  { id: 'models',          label: 'Model Comparison',     icon: Zap            },
  { id: 'velocity',        label: 'Velocity Chart',       icon: TrendingUp     },
  { id: 'completion',      label: 'Completion Rates',     icon: BarChart3      },
  { id: 'health',           label: 'Health',               icon: HeartPulse     },
  { id: 'audit-log',       label: 'Audit Log',            icon: ScrollText     },
  { id: 'activity',        label: 'Activity Feed',       icon: Rss            },
  { id: 'github',          label: 'GitHub',              icon: Github         },
];

interface SidebarProps {
  activePanel: PanelId;
  onNavigate: (panel: PanelId) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Sidebar({ activePanel, onNavigate, mobileOpen, onMobileClose }: SidebarProps) {
  const handleNav = (id: PanelId) => {
    onNavigate(id);
    onMobileClose?.();
  };

  // Desktop: icon-only sidebar (hidden below md)
  // Mobile: slide-out drawer overlay
  return (
    <>
      {/* Desktop sidebar — hidden on mobile */}
      <nav className="hidden md:flex w-14 bg-panel border-r border-border shrink-0 flex-col items-center pt-3 gap-1">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const isActive = activePanel === id;
          return (
            <button
              key={id}
              title={label}
              onClick={() => onNavigate(id)}
              className={`relative w-14 h-12 flex items-center justify-center transition-colors ${
                isActive
                  ? 'text-accent'
                  : 'text-muted hover:text-[var(--text)]'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent rounded-r" />
              )}
              <Icon size={20} strokeWidth={1.5} />
            </button>
          );
        })}
      </nav>

      {/* Mobile drawer overlay — only visible when mobileOpen */}
      {mobileOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={onMobileClose}
          />

          {/* Drawer */}
          <nav className="fixed top-0 left-0 bottom-0 w-64 bg-panel border-r border-border z-50 md:hidden flex flex-col animate-slideInLeft overflow-y-auto">
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

            {/* Nav items with labels */}
            <div className="flex-1 py-2">
              {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
                const isActive = activePanel === id;
                return (
                  <button
                    key={id}
                    onClick={() => handleNav(id)}
                    className={`relative w-full h-11 flex items-center gap-3 px-4 transition-colors ${
                      isActive
                        ? 'text-accent bg-accent/10'
                        : 'text-muted hover:text-[var(--text)] hover:bg-bg'
                    }`}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent rounded-r" />
                    )}
                    <Icon size={18} strokeWidth={1.5} />
                    <span className="text-sm">{label}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </>
      )}
    </>
  );
}
