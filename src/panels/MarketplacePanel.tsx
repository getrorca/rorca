import { useState } from 'react';
import { Wrench, FileText, Package } from 'lucide-react';
import type { PanelId } from '../components/Sidebar';

/* ─── Types ───────────────────────────────────────────────────── */

type MarketplaceTab = 'skills' | 'templates' | 'packs';

interface MarketplacePanelProps {
  onNavigate: (panel: PanelId) => void;
}

/* ─── Tab Definition ──────────────────────────────────────────── */

const TABS: { id: MarketplaceTab; label: string; icon: typeof Package }[] = [
  { id: 'skills', label: 'Skills', icon: Wrench },
  { id: 'templates', label: 'Templates', icon: FileText },
  { id: 'packs', label: 'Convention Packs', icon: Package },
];

/* ─── Component ───────────────────────────────────────────────── */

export default function MarketplacePanel({ onNavigate: _onNavigate }: MarketplacePanelProps) {
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('skills');

  return (
    <div className="flex flex-col h-full">
      <h1 className="sr-only">Marketplace</h1>

      {/* Tab bar */}
      <div
        className="flex items-center border-b border-border bg-panel shrink-0"
        role="tablist"
        aria-label="Marketplace tabs"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={`marketplace-tabpanel-${tab.id}`}
              id={`marketplace-tab-${tab.id}`}
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
      </div>

      {/* Tab content */}
      <div
        className="flex-1 min-h-0 overflow-hidden"
        role="tabpanel"
        id={`marketplace-tabpanel-${activeTab}`}
        aria-labelledby={`marketplace-tab-${activeTab}`}
      >
        {activeTab === 'skills' && (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            Skills content coming soon
          </div>
        )}
        {activeTab === 'templates' && (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            Templates content coming soon
          </div>
        )}
        {activeTab === 'packs' && (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            Convention Packs content coming soon
          </div>
        )}
      </div>
    </div>
  );
}
