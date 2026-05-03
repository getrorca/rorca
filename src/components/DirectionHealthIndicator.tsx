/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useMemo } from 'react';

interface LayerState {
  content: string;
  isDirty: boolean;
  isSaving: boolean;
}

interface Props {
  l1: LayerState;
  l2: LayerState;
  l3: LayerState;
}

interface LayerDiag {
  layer: string;
  label: string;
  status: 'empty' | 'sparse' | 'ok';
  warning: string | null;
}

type HealthLevel = 'red' | 'yellow' | 'green';

const SPARSE_THRESHOLD = 40; // characters — less than this is considered sparse

function computeHealth(l1: LayerState, l2: LayerState, l3: LayerState) {
  const diags: LayerDiag[] = [];

  const assess = (layer: string, label: string, content: string, emptyWarning: string): LayerDiag => {
    const trimmed = content.trim();
    if (!trimmed) return { layer, label, status: 'empty', warning: emptyWarning };
    if (trimmed.length < SPARSE_THRESHOLD) return { layer, label, status: 'sparse', warning: `${label} is very brief — consider adding more detail` };
    return { layer, label, status: 'ok', warning: null };
  };

  diags.push(assess('L1', 'Standards', l1.content, 'No standards — specs will lack engineering guardrails'));
  diags.push(assess('L2', 'Conventions', l2.content, 'No conventions — Claude won\'t understand your industry patterns'));
  diags.push(assess('L3', 'Project', l3.content, 'No project context — Claude won\'t know your stack or architecture'));

  const emptyCount = diags.filter(d => d.status === 'empty').length;
  const sparseCount = diags.filter(d => d.status === 'sparse').length;
  const okCount = diags.filter(d => d.status === 'ok').length;

  let level: HealthLevel;
  let summary: string;

  if (okCount === 3) {
    level = 'green';
    summary = 'All layers configured — specs will have full context';
  } else if (emptyCount === 3) {
    level = 'red';
    summary = 'No layers configured — specs will have no project context';
  } else if (emptyCount >= 2) {
    level = 'red';
    const configured = diags.find(d => d.status !== 'empty');
    summary = `Only ${configured?.label} is set — specs will be missing critical context`;
  } else if (emptyCount === 1 || sparseCount >= 2) {
    level = 'yellow';
    summary = 'Partially configured — specs may miss some context';
  } else {
    // All have content but some sparse
    level = sparseCount > 0 ? 'yellow' : 'green';
    summary = sparseCount > 0 ? 'Layers configured but some are very brief' : 'All layers configured — specs will have full context';
  }

  // Score: 0-100
  const score = diags.reduce((acc, d) => {
    if (d.status === 'ok') return acc + 33;
    if (d.status === 'sparse') return acc + 15;
    return acc;
  }, 0);

  const warnings = diags.filter(d => d.warning !== null);

  return { level, summary, score: Math.min(score, 100), diags, warnings };
}

const LEVEL_STYLES: Record<HealthLevel, { badge: string; dot: string; label: string }> = {
  red: {
    badge: 'bg-red-500/15 text-red-400 border-red-500/30',
    dot: 'bg-red-400',
    label: 'Incomplete',
  },
  yellow: {
    badge: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    dot: 'bg-yellow-400',
    label: 'Partial',
  },
  green: {
    badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    dot: 'bg-emerald-400',
    label: 'Ready',
  },
};

export default function DirectionHealthIndicator({ l1, l2, l3 }: Props) {
  const [expanded, setExpanded] = useState(false);
  const health = useMemo(() => computeHealth(l1, l2, l3), [l1, l2, l3]);

  const style = LEVEL_STYLES[health.level];

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border transition-colors ${style.badge} hover:brightness-110`}
        title={health.summary}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${style.dot}`} />
        {style.label}
      </button>

      {expanded && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-bg border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          {/* Header */}
          <div className="px-3 py-2 border-b border-border">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text">Direction Health</span>
              <span className={`text-xs font-medium ${style.badge.includes('red') ? 'text-red-400' : style.badge.includes('yellow') ? 'text-yellow-400' : 'text-emerald-400'}`}>
                {health.score}%
              </span>
            </div>
            <p className="text-xs text-muted mt-0.5">{health.summary}</p>
          </div>

          {/* Layer diagnostics */}
          <div className="px-3 py-2 space-y-2">
            {health.diags.map((d) => (
              <div key={d.layer} className="flex items-start gap-2">
                <span className={`inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                  d.status === 'ok' ? 'bg-emerald-400' : d.status === 'sparse' ? 'bg-yellow-400' : 'bg-red-400'
                }`} />
                <div className="min-w-0">
                  <div className="text-xs text-text">
                    <span className="font-medium">{d.layer}</span>
                    <span className="text-muted ml-1">{d.label}</span>
                    <span className="text-muted ml-1">
                      {d.status === 'ok' ? '— configured' : d.status === 'sparse' ? '— sparse' : '— empty'}
                    </span>
                  </div>
                  {d.warning && (
                    <p className="text-xs text-muted mt-0.5">{d.warning}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Impact note */}
          {health.level !== 'green' && (
            <div className="px-3 py-2 border-t border-border bg-bg">
              <p className="text-xs text-muted">
                {health.level === 'red'
                  ? 'Generated specs will be generic and miss project-specific requirements. Configure at least Standards and Project for meaningful results.'
                  : 'Specs will work but may lack nuance in areas without direction. Fill in remaining layers for best quality.'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Click-away to close */}
      {expanded && (
        <div className="fixed inset-0 z-40" onClick={() => setExpanded(false)} />
      )}
    </div>
  );
}
