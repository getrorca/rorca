import { useState } from 'react';
import { ChevronDown, ChevronRight, Check, X, AlertTriangle, FileText, Brain, Shield, Layers, Puzzle, Search, Share2 } from 'lucide-react';
import type { ContextSummary } from '../panels/SpecForgeOutput';

interface ContextSummaryCardProps {
  summary: ContextSummary;
  isGenerating?: boolean;
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${
        ok ? 'bg-success/15 text-success' : 'bg-muted/15 text-muted'
      }`}
      aria-label={`${label}: ${ok ? 'present' : 'missing'}`}
    >
      {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      {label}
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

export default function ContextSummaryCard({ summary, isGenerating }: ContextSummaryCardProps) {
  const [expanded, setExpanded] = useState(!!isGenerating);

  const { directionLayers, skills, memoryEntries, agentsMd, template, schemaSnapshot, gitMemory, estimatedTokens, modelContextWindow, vectorHits, graphHits, retrievalTier, retrievalLatencyMs } = summary;

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
            <StatusBadge ok={directionLayers.l1} label="L1 Standards" />
            <StatusBadge
              ok={directionLayers.l2.present}
              label={directionLayers.l2.domain ? `L2 ${directionLayers.l2.domain}` : 'L2 Conventions'}
            />
            <StatusBadge ok={directionLayers.l3} label="L3 Project" />
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
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1 ${vectorHits && vectorHits > 0 ? 'text-text' : 'text-zinc-400'}`}
              title="Vector search and knowledge graph require embeddings. Run POST /api/admin/embed-all or set OPENAI_API_KEY to enable."
            >
              <Search className="w-3 h-3" />
              Vector Search{' '}
              {vectorHits != null && vectorHits > 0
                ? <span className="text-success">✅ {vectorHits} hit{vectorHits !== 1 ? 's' : ''}</span>
                : <span>⬚ No embeddings</span>}
              {retrievalTier && (
                <span className="ml-1 px-1.5 py-0 rounded bg-muted/15 text-[10px] font-medium text-muted">
                  {retrievalTier}
                </span>
              )}
              {retrievalLatencyMs != null && (
                <span className="text-muted text-[10px] ml-0.5">{retrievalLatencyMs}ms</span>
              )}
            </span>
            <span
              className={`inline-flex items-center gap-1 ${graphHits && graphHits > 0 ? 'text-text' : 'text-zinc-400'}`}
              title="Vector search and knowledge graph require embeddings. Run POST /api/admin/embed-all or set OPENAI_API_KEY to enable."
            >
              <Share2 className="w-3 h-3" />
              Knowledge Graph{' '}
              {graphHits != null && graphHits > 0
                ? <span className="text-success">✅ {graphHits} node{graphHits !== 1 ? 's' : ''}</span>
                : <span>⬚ No graph data</span>}
            </span>
          </div>

          {/* Skills */}
          <div className="flex items-start gap-1.5 text-xs">
            <Puzzle className="w-3 h-3 text-muted mt-0.5 shrink-0" />
            <span className="text-muted">Skills:</span>
            {skills.length > 0 ? (
              <span className="text-text">{skills.join(', ')}</span>
            ) : (
              <span className="text-muted italic">none</span>
            )}
          </div>

          {/* Memory + Template */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1 text-muted">
              <Brain className="w-3 h-3" />
              Memory: <span className={memoryEntries > 0 ? 'text-text' : ''}>{memoryEntries} entries</span>
            </span>
            <span className="inline-flex items-center gap-1 text-muted">
              Template: <span className={template ? 'text-text' : ''}>{template || 'none'}</span>
            </span>
          </div>

          {/* Token usage bar */}
          <TokenBar estimated={estimatedTokens} contextWindow={modelContextWindow} />
        </div>
      )}
    </div>
  );
}
