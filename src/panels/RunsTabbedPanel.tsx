import { useState } from 'react';
import { Activity, GitBranch, ArrowLeftRight } from 'lucide-react';
import type { PanelId } from '../components/Sidebar';
import PipelineMonitorPanel from './PipelineMonitorPanel';
import WorktreesPanel from './WorktreesPanel';
import CompareRunsPanel from './CompareRunsPanel';

type RunsTab = 'active' | 'worktrees' | 'compare';

const TABS: { id: RunsTab; label: string; icon: typeof Activity }[] = [
  { id: 'active', label: 'Active', icon: Activity },
  { id: 'worktrees', label: 'Worktrees', icon: GitBranch },
  { id: 'compare', label: 'Compare', icon: ArrowLeftRight },
];

interface RunsTabbedPanelProps {
  onNavigate: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
}

export default function RunsTabbedPanel({ onNavigate, onNavigateToRun }: RunsTabbedPanelProps) {
  const [activeTab, setActiveTab] = useState<RunsTab>('active');

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-panel shrink-0">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors relative ${
                isActive
                  ? 'text-text border-b-2 border-accent'
                  : 'text-muted hover:text-text'
              }`}
            >
              <Icon size={13} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'active' && <PipelineMonitorPanel onNavigateToRun={onNavigateToRun} />}
        {activeTab === 'worktrees' && <WorktreesPanel />}
        {activeTab === 'compare' && <CompareRunsPanel onBack={() => setActiveTab('active')} />}
      </div>
    </div>
  );
}
