import { useState, useRef, useEffect } from 'react';
import { Wrench, FileText, Package, Search } from 'lucide-react';
import type { PanelId } from '../components/Sidebar';

/* ─── Types ───────────────────────────────────────────────────── */

type MarketplaceTab = 'skills' | 'templates' | 'packs';
type SourceFilter = 'skills.sh' | 'github' | 'custom';

interface MarketplacePanelProps {
  onNavigate: (panel: PanelId) => void;
}

/* ─── Tab Definition ──────────────────────────────────────────── */

const TABS: { id: MarketplaceTab; label: string; icon: typeof Package }[] = [
  { id: 'skills', label: 'Skills', icon: Wrench },
  { id: 'templates', label: 'Templates', icon: FileText },
  { id: 'packs', label: 'Convention Packs', icon: Package },
];

const SOURCE_PILLS: { id: SourceFilter; label: string }[] = [
  { id: 'skills.sh', label: 'skills.sh' },
  { id: 'github', label: 'GitHub Repos' },
  { id: 'custom', label: 'Custom' },
];

/* ─── Component ───────────────────────────────────────────────── */

export default function MarketplacePanel({ onNavigate: _onNavigate }: MarketplacePanelProps) {
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('skills');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSource, setActiveSource] = useState<SourceFilter>('skills.sh');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

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
        className="flex-1 min-h-0 overflow-hidden flex flex-col"
        role="tabpanel"
        id={`marketplace-tabpanel-${activeTab}`}
        aria-labelledby={`marketplace-tab-${activeTab}`}
      >
        {/* Search bar */}
        <div className="px-4 pt-3 pb-2 shrink-0">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search skills, templates, or packs..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-surface border border-border rounded-md
                         text-text placeholder:text-muted
                         focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent
                         transition-colors"
            />
          </div>
        </div>

        {/* Source pills */}
        <div className="flex items-center gap-2 px-4 pb-3 shrink-0">
          {SOURCE_PILLS.map((source) => {
            const isActive = activeSource === source.id;
            return (
              <button
                key={source.id}
                onClick={() => setActiveSource(source.id)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                  isActive
                    ? 'bg-accent text-white'
                    : 'bg-surface border border-border text-muted hover:text-text hover:border-text/20'
                }`}
                aria-pressed={isActive}
              >
                {source.label}
              </button>
            );
          })}
        </div>

        {/* Split view: Discovery (60%) | Your Library (40%) */}
        <div className="flex-1 min-h-0 flex gap-0">
          {/* Left panel — Discovery Results */}
          <div className="w-[60%] border-r border-border overflow-y-auto p-4">
            <h2 className="text-sm font-semibold text-text mb-3">Discovery Results</h2>
            <div className="flex items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md">
              {searchQuery
                ? `Searching for "${searchQuery}" on ${activeSource}...`
                : 'Enter a search term to discover skills, templates, or packs'}
            </div>
          </div>

          {/* Right panel — Your Library */}
          <div className="w-[40%] overflow-y-auto p-4">
            <h2 className="text-sm font-semibold text-text mb-1">Your Library (0)</h2>
            <p className="text-xs text-muted mb-4">Installed skills will appear here</p>
            <div className="flex items-center justify-center h-32 text-muted text-xs border border-dashed border-border rounded-md">
              No skills installed yet
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
