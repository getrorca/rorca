/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Loader2, Brain, BookOpen, GitBranch, AlertCircle } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import DependencyGraph from './DependencyGraph';

/* ─── Types ───────────────────────────────────────────────────────── */

interface KnowledgeGraphMemory {
  id: string;
  category: string;
  relationship: string;
  storyId: string;
}

interface KnowledgeGraphConvention {
  name: string;
  source: string;
  relationship: string;
  filePath: string;
}

interface KnowledgeGraphRelatedStory {
  id: string;
  specId: string;
  title: string;
  relationship: string;
}

interface KnowledgeGraphResponse {
  available: boolean;
  memories: KnowledgeGraphMemory[];
  conventions: KnowledgeGraphConvention[];
  relatedStories: KnowledgeGraphRelatedStory[];
}

type GraphSubTab = 'dependencies' | 'knowledge';

/* ─── Collapsible Section ─────────────────────────────────────────── */

function CollapsibleSection({ title, icon: Icon, count, children }: {
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: React.ComponentType<any>;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-text hover:bg-panel/50 transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Icon size={14} className="text-muted" />
        <span>{title}</span>
        <span className="ml-auto px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-accent/15 text-accent">
          {count}
        </span>
      </button>
      {open && <div className="border-t border-border">{children}</div>}
    </div>
  );
}

/* ─── Knowledge Graph Content ─────────────────────────────────────── */

function KnowledgeGraphContent({ specId }: { specId: string }) {
  const [data, setData] = useState<KnowledgeGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await apiFetch<KnowledgeGraphResponse>(`/api/specs/${specId}/knowledge-graph`);
      setData(resp);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load knowledge graph');
    } finally {
      setLoading(false);
    }
  }, [specId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted text-sm">
        <Loader2 size={16} className="animate-spin mr-2" />Loading knowledge graph...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12 text-error text-sm">
        <AlertCircle size={16} className="mr-2" />{error}
      </div>
    );
  }

  if (!data?.available) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted">
        <AlertCircle size={32} className="mb-3 opacity-40" />
        <p className="text-sm font-medium">Knowledge graph not available</p>
        <p className="text-xs mt-1 opacity-70">Apache AGE extension is required for knowledge graph features.</p>
      </div>
    );
  }

  const hasData = data.memories.length > 0 || data.conventions.length > 0 || data.relatedStories.length > 0;

  if (!hasData) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted">
        <Brain size={32} className="mb-3 opacity-40" />
        <p className="text-sm font-medium">No graph data yet</p>
        <p className="text-xs mt-1 opacity-70">Run this spec to populate the knowledge graph.</p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      {data.memories.length > 0 && (
        <CollapsibleSection title="Memories" icon={Brain} count={data.memories.length}>
          <ul className="divide-y divide-border">
            {data.memories.map((m, i) => (
              <li key={`${m.id}-${i}`} className="px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-text">{m.id}</span>
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-panel border border-border text-muted">
                    {m.relationship}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-muted">
                  <span>Category: {m.category}</span>
                  <span>&#183;</span>
                  <span>Story: {m.storyId}</span>
                </div>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}

      {data.conventions.length > 0 && (
        <CollapsibleSection title="Conventions" icon={BookOpen} count={data.conventions.length}>
          <ul className="divide-y divide-border">
            {data.conventions.map((c, i) => (
              <li key={`${c.name}-${i}`} className="px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-text">{c.name}</span>
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-panel border border-border text-muted">
                    {c.relationship}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-muted">
                  {c.source && <><span>Source: {c.source}</span><span>&#183;</span></>}
                  <span className="font-mono truncate">{c.filePath}</span>
                </div>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}

      {data.relatedStories.length > 0 && (
        <CollapsibleSection title="Related Stories" icon={GitBranch} count={data.relatedStories.length}>
          <ul className="divide-y divide-border">
            {data.relatedStories.map((s, i) => (
              <li key={`${s.id}-${i}`} className="px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-text">{s.title || s.id}</span>
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-panel border border-border text-muted">
                    {s.relationship}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-muted">
                  <span>Spec: {s.specId}</span>
                  <span>&#183;</span>
                  <span>{s.id}</span>
                </div>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}
    </div>
  );
}

/* ─── Graph Tab with Sub-Tabs ─────────────────────────────────────── */

export function GraphTabWithSubTabs({ specId, workspaceId }: { specId: string; workspaceId: string }) {
  const [subTab, setSubTab] = useState<GraphSubTab>('dependencies');

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab switcher */}
      <div className="flex border-b border-border shrink-0 px-3 pt-2">
        <button
          onClick={() => setSubTab('dependencies')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
            subTab === 'dependencies'
              ? 'text-text border-accent'
              : 'text-muted hover:text-text border-transparent'
          }`}
        >
          Dependencies
        </button>
        <button
          onClick={() => setSubTab('knowledge')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
            subTab === 'knowledge'
              ? 'text-text border-accent'
              : 'text-muted hover:text-text border-transparent'
          }`}
        >
          Knowledge Graph
        </button>
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 overflow-y-auto">
        {subTab === 'dependencies' && <DependencyGraph specId={specId} workspaceId={workspaceId} />}
        {subTab === 'knowledge' && <KnowledgeGraphContent specId={specId} />}
      </div>
    </div>
  );
}
