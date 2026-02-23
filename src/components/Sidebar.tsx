import { Wand2, Layers, ListChecks, Activity, GitBranch, Archive, ArrowLeftRight, Github, Rss, Users, LayoutGrid, Coins, DollarSign, Zap, TrendingUp, BarChart3 } from 'lucide-react';

export type PanelId = 'forge' | 'stack' | 'team-direction' | 'queue' | 'pipeline' | 'worktrees' | 'compare' | 'archive' | 'github' | 'activity' | 'marketplace' | 'usage' | 'costs' | 'models' | 'velocity' | 'completion';

const NAV_ITEMS: { id: PanelId; label: string; icon: typeof Wand2 }[] = [
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
  { id: 'activity',        label: 'Activity Feed',       icon: Rss            },
  { id: 'github',          label: 'GitHub',              icon: Github         },
];

interface SidebarProps {
  activePanel: PanelId;
  onNavigate: (panel: PanelId) => void;
}

export default function Sidebar({ activePanel, onNavigate }: SidebarProps) {
  return (
    <nav className="w-14 bg-panel border-r border-border shrink-0 flex flex-col items-center pt-3 gap-1">
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
  );
}
