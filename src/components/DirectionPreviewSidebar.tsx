/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { DirectionSidebarSkeleton } from './Skeleton';

interface LayerData {
  content: string | null;
  source?: string;
  teamOverride?: string | null;
  preferredModel?: string | null;
}

interface DirectionAllResponse {
  layers: {
    l1: LayerData;
    l2: LayerData;
    l3: LayerData;
  };
}

const LAYER_LABELS: Record<string, { label: string; description: string }> = {
  l1: { label: 'Standards', description: 'Engineering principles, preferred libraries' },
  l2: { label: 'Conventions', description: 'Framework and domain conventions' },
  l3: { label: 'Project', description: 'Stack, architecture, key constraints' },
};

export default function DirectionPreviewSidebar({ onNavigateToStack }: { onNavigateToStack?: () => void }) {
  const { workspaceId } = useWorkspace();
  const [layers, setLayers] = useState<DirectionAllResponse['layers'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const fetchLayers = useCallback(async () => {
    if (!workspaceId) { setLayers(null); return; }
    setLoading(true);
    try {
      const res = await apiFetch<DirectionAllResponse>(`/api/direction/all?workspaceId=${workspaceId}`);
      setLayers(res.layers);
    } catch {
      setLayers(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchLayers(); }, [fetchLayers]);

  const toggleExpand = (key: string) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const hasAnyContent = layers && (layers.l1.content || layers.l2.content || layers.l3.content);

  return (
    <div className="flex flex-col h-full border-l border-border bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Direction Context
        </h3>
        <button
          onClick={fetchLayers}
          disabled={loading}
          className="p-1 rounded hover:bg-border/50 text-muted hover:text-text transition-colors disabled:opacity-40"
          title="Refresh direction layers"
        >
          <svg
            className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && !layers ? (
          <DirectionSidebarSkeleton />
        ) : !hasAnyContent ? (
          <div className="px-4 py-6 text-center">
            <p className="text-xs text-muted mb-3">No direction configured</p>
            <p className="text-xs text-muted/70 mb-4">
              Configure your direction to provide context to the LLM during spec generation.
            </p>
            {onNavigateToStack && (
              <button
                onClick={onNavigateToStack}
                className="text-xs text-accent hover:text-accent-hover underline underline-offset-2 transition-colors"
              >
                Open Direction
              </button>
            )}
          </div>
        ) : (
          <div className="py-2">
            {(['l1', 'l2', 'l3'] as const).map((key) => {
              const layer = layers![key];
              const meta = LAYER_LABELS[key];
              const content = layer.content;
              const isExpanded = expanded[key] ?? false;
              const needsTruncation = content ? content.length > 150 : false;
              const displayContent = content
                ? (isExpanded ? content : content.slice(0, 150))
                : null;

              return (
                <div key={key} className="border-b border-border/50 last:border-b-0">
                  <button
                    onClick={() => content && toggleExpand(key)}
                    className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-border/20 transition-colors text-left"
                    disabled={!content}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${content ? 'bg-green-500' : 'bg-border'}`} />
                      <span className="text-xs font-medium text-text truncate">
                        {meta.label}
                      </span>
                    </div>
                    {content && (
                      <svg
                        className={`w-3 h-3 text-muted shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </button>

                  {content ? (
                    <div className="px-4 pb-3">
                      <p className="text-[11px] text-muted/70 mb-1.5">{meta.description}</p>
                      <pre className="text-xs text-muted whitespace-pre-wrap break-words font-mono bg-bg rounded px-2 py-1.5 max-h-60 overflow-y-auto">
                        {displayContent}{!isExpanded && needsTruncation && '...'}
                      </pre>
                      {needsTruncation && (
                        <button
                          onClick={() => toggleExpand(key)}
                          className="text-[10px] text-accent hover:text-accent-hover mt-1 transition-colors"
                        >
                          {isExpanded ? 'Collapse' : 'View full'}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="px-4 pb-3">
                      <p className="text-[11px] text-muted/50 italic">Not configured</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
