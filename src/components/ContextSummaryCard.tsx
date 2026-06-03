/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Check, X, AlertTriangle, FileText, Brain, Shield, Layers, Puzzle, Search, Share2, FolderOpen } from 'lucide-react';
import type { ContextSummary } from '../panels/SpecForgeOutput';

interface SkillDetail {
  name: string;
  relevance?: number;
  reason?: string;
}

interface ContextSummaryCardProps {
  summary: ContextSummary;
  isGenerating?: boolean;
  skillDetails?: SkillDetail[];
}

function StatusBadge({ ok, label, title, tokens }: { ok: boolean; label: string; title?: string | null; tokens?: number }) {
  const displayLabel = ok && title ? `${label} ${title}` : label;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${
        ok ? 'bg-success/15 text-success' : 'bg-muted/15 text-muted'
      }`}
      aria-label={`${label}: ${ok ? 'present' : 'missing'}`}
    >
      {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      {displayLabel}
      {ok && tokens != null && tokens > 0 && (
        <span className="ml-1 px-1 py-0 rounded bg-success/20 text-[10px] font-mono text-success">
          {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : tokens} tok
        </span>
      )}
    </span>
  );
}

function TokenBar({ estimated, contextWindow }: { estimated: number; contextWindow: number }) {
  const pct = Math.min(100, Math.round((estimated / contextWindow) * 100));
  const estK = (estimated / 1000).toFixed(1);
  const ctxK = (contextWindow / 1000).toFixed(0);

  let barColor = 'bg-accent';
  let tooltip = '';
  if (pct > 80) {
    barColor = 'bg-error';
    tooltip = 'Context near limit — consider reducing direction stack or skills';
  } else if (pct > 50) {
    barColor = 'bg-warning';
    tooltip = 'High context usage — spec quality may degrade';
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted flex items-center gap-1">
          <Layers className="w-3 h-3" />
          Tokens
        </span>
        <span className={`font-mono ${pct > 80 ? 'text-error' : pct > 50 ? 'text-warning' : 'text-text'}`}>
          {estK}K / {ctxK}K ({pct}%)
        </span>
      </div>
      <div
        className="h-1.5 rounded-full bg-border overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Token usage: ${pct}%`}
        title={tooltip}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {pct > 50 && (
        <p className={`text-[10px] flex items-center gap-1 ${pct > 80 ? 'text-error' : 'text-warning'}`}>
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {tooltip}
        </p>
      )}
    </div>
  );
}

export default function ContextSummaryCard({ summary, isGenerating, skillDetails }: ContextSummaryCardProps) {
  const [expanded, setExpanded] = useState(!!isGenerating);
  const [filesExpanded, setFilesExpanded] = useState(false);

  const { directionLayers, skills, memoryEntries, agentsMd, template, schemaSnapshot, gitMemory, estimatedTokens, modelContextWindow, retrieval } = summary;
  // Prefer nested retrieval object (SW-010); fall back to legacy flat fields for older logs
  const cagHits = retrieval?.cagHits ?? 0;
  const vectorHits = retrieval?.ragHits ?? summary.vectorHits;
  const graphHits = retrieval?.graphHits ?? summary.graphHits;
  const retrievalTier = retrieval?.tier ?? summary.retrievalTier;
  const retrievalLatencyMs = retrieval?.latencyMs ?? summary.retrievalLatencyMs;
  const ontologyExplainability = retrieval?.ontologyExplainability;

  return (
    <div
      className="border border-border rounded-lg bg-panel overflow-hidden"
      aria-label="Spec generation context summary"
    >
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/5 transition-colors"
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronDown className="w-4 h-4 text-muted shrink-0" />
          : <ChevronRight className="w-4 h-4 text-muted shrink-0" />
        }
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">
          Context Injected
        </span>
        {/* Compact inline badges when collapsed */}
        {!expanded && (
          <div className="flex items-center gap-1.5 ml-auto overflow-hidden">
            <StatusBadge ok={directionLayers.l1} label="L1" />
            <StatusBadge ok={directionLayers.l2.present} label="L2" />
            <StatusBadge ok={directionLayers.l3} label="L3" />

            {skills.length > 0 && (
              <span className="text-[10px] text-muted font-medium px-1.5 py-0.5 bg-muted/10 rounded-full">
                {skills.length} skill{skills.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border/50">
          {/* Direction layers */}
          <div className="flex flex-wrap items-center gap-1.5 pt-2">
            {directionLayers.l1 ? (
              <StatusBadge
                ok={true}
                label="L1"
                title={directionLayers.l1Title ?? 'Standards'}
                tokens={directionLayers.l1Tokens}
              />
            ) : (
              <StatusBadge ok={false} label="L1 Standards" />
            )}
            {directionLayers.l2.present ? (
              <StatusBadge
                ok={true}
                label="L2"
                title={directionLayers.l2Title ?? (directionLayers.l2.domain ? directionLayers.l2.domain : 'Conventions')}
                tokens={directionLayers.l2Tokens}
              />
            ) : (
              <StatusBadge ok={false} label={directionLayers.l2.domain ? `L2 ${directionLayers.l2.domain}` : 'L2 Conventions'} />
            )}
            {directionLayers.l3 ? (
              <StatusBadge
                ok={true}
                label="L3"
                title={directionLayers.l3Title ?? 'Project'}
                tokens={directionLayers.l3Tokens}
              />
            ) : (
              <StatusBadge ok={false} label="L3 Project" />
            )}
          </div>

          {/* Context files row */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`inline-flex items-center gap-1 ${agentsMd ? 'text-text' : 'text-muted'}`}>
              <Shield className="w-3 h-3" />
              AGENTS.md {agentsMd ? '✓' : '—'}
            </span>
            <span className={`inline-flex items-center gap-1 ${schemaSnapshot ? 'text-text' : 'text-muted'}`}>
              <FileText className="w-3 h-3" />
              Schema {schemaSnapshot ? '✓' : '—'}
            </span>
            <span className={`inline-flex items-center gap-1 ${gitMemory ? 'text-text' : 'text-muted'}`}>
              <FileText className="w-3 h-3" />
              Git Memory {gitMemory ? '✓' : '—'}
            </span>
          </div>

          {/* Semantic retrieval */}
          <div className="space-y-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 ${cagHits > 0 ? 'text-text' : 'text-zinc-400'}`}
                title="Cache-augmented generation: direction layers, memory, and skills resolved from in-memory cache"
              >
                <Brain className="w-3 h-3" />
                Cache (CAG){' '}
                {cagHits > 0
                  ? <span className="text-success">{cagHits} hit{cagHits !== 1 ? 's' : ''}</span>
                  : <span>0 hits</span>}
              </span>
              {(vectorHits != null && vectorHits > 0) || retrievalTier === 'cache' ? (
                <span
                  className={`inline-flex items-center gap-1 ${vectorHits && vectorHits > 0 ? 'text-text' : 'text-zinc-400'}`}
                  title="Retrieval-augmented generation: hybrid vector+keyword search for unfamiliar concepts"
                >
                  <Search className="w-3 h-3" />
                  Vector (RAG){' '}
                  {vectorHits != null && vectorHits > 0
                    ? <span className="text-success">{vectorHits} hit{vectorHits !== 1 ? 's' : ''}</span>
                    : <span>— skipped (cache sufficient)</span>}
                </span>
              ) : null}
              {(graphHits != null && graphHits > 0) || retrievalTier === 'cache' ? (
                <span
                  className={`inline-flex items-center gap-1 ${graphHits && graphHits > 0 ? 'text-text' : 'text-zinc-400'}`}
                  title="Knowledge graph context via Apache AGE"
                >
                  <Share2 className="w-3 h-3" />
                  Graph{' '}
                  {graphHits != null && graphHits > 0
                    ? <span className="text-success">{graphHits} node{graphHits !== 1 ? 's' : ''}</span>
                    : <span>— skipped (cache sufficient)</span>}
                </span>
              ) : null}
              {retrievalTier && (
                <span className="px-1.5 py-0 rounded bg-muted/15 text-[10px] font-medium text-muted" title="cache = in-memory (~0ms), search = vector+keyword (50-200ms), hybrid = both">
                  {retrievalTier}
                </span>
              )}
              {retrievalLatencyMs != null && (
                <span className="text-muted text-[10px]">{retrievalLatencyMs}ms</span>
              )}
            </div>
            {ontologyExplainability && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1">
                  <Share2 className="w-3 h-3" />
                  Ontology
                </span>
                <span className={`rounded-full px-1.5 py-0.5 font-medium ${ontologyExplainability.status === 'available' ? 'bg-success/15 text-success' : ontologyExplainability.status === 'partial' ? 'bg-warning/15 text-warning' : 'bg-muted/15 text-muted'}`}>
                  {ontologyExplainability.status}
                </span>
                {(ontologyExplainability.activeCount + ontologyExplainability.suppressedCount + ontologyExplainability.conflictCount) > 0 ? (
                  <span>
                    {ontologyExplainability.activeCount} active • {ontologyExplainability.suppressedCount} superseded • {ontologyExplainability.conflictCount} conflicts
                  </span>
                ) : null}
                {ontologyExplainability.examples.length > 0 ? (
                  <span className="truncate">{ontologyExplainability.examples.join(' • ')}{ontologyExplainability.hiddenExplanationCount > 0 ? ` • +${ontologyExplainability.hiddenExplanationCount} more` : ''}</span>
                ) : (
                  <span>{ontologyExplainability.message}</span>
                )}
              </div>
            )}
          </div>

          {/* Skills */}
          <div className="flex items-start gap-1.5 text-xs">
            <span className={`inline-flex items-center gap-1 shrink-0 ${skills.length > 0 ? 'text-text' : 'text-muted'}`}>
              <Puzzle className="w-3 h-3 mt-0.5 shrink-0" />
              Skills{' '}
              {skills.length > 0
                ? <span className="text-success">✓ {skills.length}</span>
                : <span>—</span>}
            </span>
            {skills.length > 0 && skillDetails && skillDetails.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {skillDetails.map(sk => {
                  const rel = sk.relevance ?? 0;
                  const badgeClass = rel >= 8
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : rel >= 5
                      ? 'bg-blue-500/15 text-blue-400'
                      : 'bg-muted/15 text-muted';
                  return (
                    <span
                      key={sk.name}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/10 border border-border/50 text-[10px]"
                      title={sk.reason ?? undefined}
                    >
                      <span className="font-mono text-text">{sk.name}</span>
                      {sk.relevance != null && (
                        <span className={`px-1 py-0 rounded text-[9px] font-semibold ${badgeClass}`}>
                          {sk.relevance}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            ) : skills.length > 0 ? (
              <span className="text-muted">{skills.join(', ')}</span>
            ) : null}
          </div>

          {/* Context Files (CU-004) — only shown if predictedFiles is non-empty */}
          {summary.predictedFiles && summary.predictedFiles.length > 0 && (() => {
            const allFiles = summary.predictedFiles!;
            const displayFiles = allFiles.slice(0, 20);
            const overflow = allFiles.length - 20;
            return (
              <div className="text-xs">
                <button
                  onClick={() => setFilesExpanded(e => !e)}
                  className="flex items-center gap-1 text-muted hover:text-text transition-colors"
                  aria-expanded={filesExpanded}
                >
                  {filesExpanded
                    ? <ChevronDown className="w-3 h-3" />
                    : <ChevronRight className="w-3 h-3" />
                  }
                  <FolderOpen className="w-3 h-3" />
                  <span className="font-medium">Context Files ({allFiles.length})</span>
                </button>
                {filesExpanded && (
                  <div className="mt-1.5 pl-4 space-y-0.5">
                    {displayFiles.map(f => (
                      <div key={f} className="flex items-center gap-1">
                        <code className="px-1 py-0 rounded bg-muted/10 text-[10px] font-mono text-text break-all">
                          {f}
                        </code>
                      </div>
                    ))}
                    {overflow > 0 && (
                      <span className="text-muted text-[10px]">+{overflow} more</span>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Memory + Template */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className={`inline-flex items-center gap-1 ${memoryEntries > 0 ? 'text-text' : 'text-muted'}`}>
              <Brain className="w-3 h-3" />
              Memory{' '}
              {memoryEntries > 0
                ? <><span className="text-success">✓</span> {memoryEntries} entries</>
                : <span>— 0 entries</span>}
            </span>
            <span className={`inline-flex items-center gap-1 ${template ? 'text-text' : 'text-muted'}`}>
              Template{' '}
              {template
                ? <><span className="text-success">✓</span> {template}</>
                : <span>— none</span>}
            </span>
          </div>

          {/* Token usage bar */}
          <TokenBar estimated={estimatedTokens} contextWindow={modelContextWindow} />
        </div>
      )}
    </div>
  );
}
