import { useState, useEffect, useCallback } from 'react';
import { Layers, BookOpen, Users, Sparkles } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import DirectionStackPanel from './DirectionStackPanel';
import TeamDirectionPanel from './TeamDirectionPanel';
import MemoryPanel from './MemoryPanel';

// ULT-008: 3 tabs — Stack, Memory, Team

type DirectionTab = 'stack' | 'memory' | 'team';

const TABS: { id: DirectionTab; label: string; icon: typeof Layers }[] = [
  { id: 'stack', label: 'Stack', icon: Layers },
  { id: 'memory', label: 'Memory', icon: BookOpen },
  { id: 'team', label: 'Team', icon: Users },
];

type HealthLevel = 'green' | 'amber' | 'red';

function healthColor(level: HealthLevel): string {
  switch (level) {
    case 'green': return 'bg-emerald-500';
    case 'amber': return 'bg-amber-500';
    case 'red': return 'bg-red-500';
  }
}

function healthLabel(level: HealthLevel): string {
  switch (level) {
    case 'green': return 'Context health: good';
    case 'amber': return 'Context health: needs attention';
    case 'red': return 'Context health: incomplete';
  }
}

function scoreToLevel(score: number): HealthLevel {
  if (score >= 70) return 'green';
  if (score >= 40) return 'amber';
  return 'red';
}

export default function DirectionTabbedPanel() {
  const [activeTab, setActiveTab] = useState<DirectionTab>('stack');
  const { workspaceId } = useWorkspace();
  const [healthLevel, setHealthLevel] = useState<HealthLevel>('amber');
  const [healthScore, setHealthScore] = useState<number | null>(null);

  // Fetch workspace health score for the indicator
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ score: number }>(`/api/workspaces/${workspaceId}/health`)
      .then((data) => {
        setHealthScore(data.score);
        setHealthLevel(scoreToLevel(data.score));
      })
      .catch(() => {
        // If health endpoint fails, default to amber
        setHealthLevel('amber');
        setHealthScore(null);
      });
  }, [workspaceId]);

  // Synthesize memory from recent runs
  const [isSynthesizingMemory, setIsSynthesizingMemory] = useState(false);
  const handleSynthesizeMemory = useCallback(async () => {
    if (!workspaceId || isSynthesizingMemory) return;
    setIsSynthesizingMemory(true);
    try {
      await apiFetch('/api/memory/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      // Force Memory tab to refresh by switching to it
      setActiveTab('memory');
    } catch {
      // silently fail — Memory panel will show current state
    } finally {
      setIsSynthesizingMemory(false);
    }
  }, [workspaceId, isSynthesizingMemory]);

  return (
    <div className="flex flex-col h-full">
      <h1 className="sr-only">Direction</h1>
      {/* Tab bar with health indicator */}
      <div className="flex items-center border-b border-border bg-panel shrink-0" role="tablist" aria-label="Direction tabs">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={`direction-tabpanel-${tab.id}`}
              id={`direction-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors relative ${
                isActive
                  ? 'text-text border-b-2 border-accent'
                  : 'text-muted hover:text-text'
              }`}
            >
              <Icon size={13} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Auto-generate buttons per tab */}
        {activeTab === 'memory' && (
          <button
            onClick={handleSynthesizeMemory}
            disabled={isSynthesizingMemory}
            className="flex items-center gap-1 px-2.5 py-1 mr-2 text-[11px] font-medium text-accent hover:text-[var(--accent-hover)] transition-colors disabled:opacity-50 rounded"
            title="Generate memory entries from recent pipeline runs"
          >
            <Sparkles size={11} />
            {isSynthesizingMemory ? 'Synthesizing...' : 'Synthesize'}
          </button>
        )}

        {/* Context health indicator */}
        <div
          className="flex items-center gap-1.5 px-3 py-1"
          title={`${healthLabel(healthLevel)}${healthScore !== null ? ` (${healthScore}/100)` : ''}`}
        >
          <span className={`inline-block w-2 h-2 rounded-full ${healthColor(healthLevel)}`} />
          {healthScore !== null && (
            <span className="text-[10px] text-muted tabular-nums">{healthScore}</span>
          )}
        </div>
      </div>

      {/* Tab content */}
      <div
        className="flex-1 min-h-0 overflow-hidden"
        role="tabpanel"
        id={`direction-tabpanel-${activeTab}`}
        aria-labelledby={`direction-tab-${activeTab}`}
      >
        {activeTab === 'stack' && <DirectionStackPanel />}
        {activeTab === 'memory' && <MemoryPanel />}
        {activeTab === 'team' && <TeamDirectionPanel />}
      </div>
    </div>
  );
}
