import { useState, useCallback } from 'react';
import { Layers, BookOpen, SlidersHorizontal, Users } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import DirectionStackPanel from './DirectionStackPanel';
import TeamDirectionPanel from './TeamDirectionPanel';
import MemoryPanel from './MemoryPanel';
import ContextRoutingSettings from '../components/ContextRoutingSettings';

type DirectionTab = 'direction' | 'team' | 'memory' | 'rules';

const TABS: { id: DirectionTab; label: string; icon: typeof Layers }[] = [
  { id: 'direction', label: 'Direction', icon: Layers },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'memory', label: 'Memory', icon: BookOpen },
  { id: 'rules', label: 'Rules', icon: SlidersHorizontal },
];

export default function DirectionTabbedPanel() {
  const [activeTab, setActiveTab] = useState<DirectionTab>('direction');
  const { workspaceId } = useWorkspace();
  const { show } = useGlobalToast();
  const showToast = useCallback((message: string, type?: 'success' | 'error') => {
    show(message, type ?? 'success');
  }, [show]);

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
        {activeTab === 'direction' && <DirectionStackPanel />}
        {activeTab === 'team' && <TeamDirectionPanel />}
        {activeTab === 'memory' && <MemoryPanel />}
        {activeTab === 'rules' && workspaceId && <ContextRoutingSettings workspaceId={workspaceId} showToast={showToast} />}
      </div>
    </div>
  );
}
