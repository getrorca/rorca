/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Cpu,
  Clock,
  GitBranch,
  FolderGit2,
  Hash,
  Skull,
  Copy,
  Check,
  DollarSign,
  Loader2,
  Zap,
  FileText,
  RotateCcw,
} from 'lucide-react';
import type { WalEvent } from '../hooks/usePipelineSSE';
import AgentBadge from './AgentBadge';
import { normalizeAgentType } from '../lib/agent-display';
import { formatRunCostTelemetry, formatRunTokenTelemetry, normalizeRunTokenTelemetry, type RunTokenTelemetry } from '../lib/run-metadata';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ContextComparisonData {
  predicted: Record<string, { totalTokens: number; injectedFiles: string[] }>;
  actual: Record<string, { contextFiles: string[] }>;
}

interface ResumeSummary {
  continueFromId: string | null;
  resumedAfterId: string | null;
  carriedForwardCount: number;
}

interface RunMetadataPanelProps {
  run: {
    id: number;
    status: string;
    pid: number | null;
    branch_name: string | null;
    worktree_path: string | null;
    started_at: string;
    finished_at: string | null;
    agentType?: string | null;
    agentModel?: string | null;
    agent_type?: string | null;
    agent_model?: string | null;
  };
  tokenSummary: RunTokenTelemetry;
  specModel: string | null;
  totalStories: number;
  walEvents: WalEvent[];
  onKill?: () => void;
  contextComparison?: ContextComparisonData | null;
  resumeSummary?: ResumeSummary | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function _modelShortName(model: string): string {
  // "claude-sonnet-4-5-20250929" → "Sonnet 4.5"
  // "claude-opus-4-6" → "Opus 4.6"
  // "openai/gpt-4o" → "GPT-4o"
  if (model.includes('opus')) return 'Opus ' + extractVersion(model);
  if (model.includes('sonnet')) return 'Sonnet ' + extractVersion(model);
  if (model.includes('haiku')) return 'Haiku ' + extractVersion(model);
  if (model.includes('/')) return model.split('/').pop() || model;
  return model;
}

function extractVersion(model: string): string {
  // claude-opus-4-6 → 4.6; claude-sonnet-4-5-20250929 → 4.5
  const match = model.match(/(\d+)-(\d+)(?:-\d{8})?$/);
  if (match) return `${match[1]}.${match[2]}`;
  return '';
}

// ─── CopyButton ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="p-0.5 rounded hover:bg-bg transition-colors text-muted hover:text-[var(--text)]"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check size={11} className="text-emerald-500" aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
    </button>
  );
}

// ─── MetadataRow ────────────────────────────────────────────────────────────

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Cpu;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <Icon size={12} className="text-muted shrink-0" />
      <span className="text-[10px] text-muted uppercase tracking-wider w-16 shrink-0">{label}</span>
      <div className="flex items-center gap-1.5 text-xs text-[var(--text)] min-w-0 flex-1">
        {children}
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function RunMetadataPanel({
  run,
  tokenSummary,
  totalStories,
  walEvents,
  onKill,
  contextComparison,
  resumeSummary,
}: RunMetadataPanelProps) {
  const [now, setNow] = useState(Date.now());

  const telemetry = normalizeRunTokenTelemetry(tokenSummary);
  const agentType = normalizeAgentType(run.agentType ?? run.agent_type);

  // Tick every second for live elapsed / ETA
  const isActive = run.status === 'running' || run.status === 'paused' || run.status === 'blocked';
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  // Elapsed time
  const elapsedSec = useMemo(() => {
    const start = new Date(run.started_at).getTime();
    const end = run.finished_at ? new Date(run.finished_at).getTime() : now;
    return Math.max(0, Math.floor((end - start) / 1000));
  }, [run.started_at, run.finished_at, now]);

  // Count completed stories from WAL for ETA
  const completedCount = useMemo(() => {
    let count = 0;
    for (const evt of walEvents) {
      if (
        evt.event_type === 'story_passed' ||
        evt.event_type === 'story_failed' ||
        evt.event_type === 'story_skipped'
      ) {
        count++;
      }
    }
    return count;
  }, [walEvents]);

  // Estimated time remaining
  const eta = useMemo(() => {
    if (!isActive || completedCount === 0 || completedCount >= totalStories) return null;
    const avgSec = elapsedSec / completedCount;
    const remaining = totalStories - completedCount;
    return Math.round(avgSec * remaining);
  }, [isActive, completedCount, totalStories, elapsedSec]);


  return (
    <div className="shrink-0 border-t border-border bg-panel">
      <div className="px-3 py-1.5 border-b border-border/50">
        <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">Run Info</span>
      </div>

      {resumeSummary && (resumeSummary.continueFromId || resumeSummary.resumedAfterId || resumeSummary.carriedForwardCount > 0) && (
        <MetaRow icon={RotateCcw} label="Continue">
          <div className="flex flex-wrap items-center gap-1.5" data-testid="run-resume-summary">
            {resumeSummary.continueFromId && (
              <span className="font-mono text-[10px] text-amber-400">
                from {resumeSummary.continueFromId}
              </span>
            )}
            {resumeSummary.resumedAfterId && (
              <span className="text-[10px] text-muted">
                after {resumeSummary.resumedAfterId}
              </span>
            )}
            {resumeSummary.carriedForwardCount > 0 && (
              <span className="text-[10px] text-muted">
                {resumeSummary.carriedForwardCount} carried forward
              </span>
            )}
          </div>
        </MetaRow>
      )}

      {/* Tokens */}
      <MetaRow icon={Cpu} label="Tokens">
        <span className="font-mono">
          {formatRunTokenTelemetry(telemetry, agentType)}
        </span>
      </MetaRow>

      {/* Elapsed + ETA */}
      <MetaRow icon={Clock} label="Time">
        <span className="font-mono">{formatDuration(elapsedSec)}</span>
        {isActive && <Loader2 size={10} className="animate-spin text-blue-500" />}
        {eta != null && (
          <span className="text-[10px] text-muted ml-1">
            ~{formatDuration(eta)} remaining
          </span>
        )}
      </MetaRow>

      {/* Branch */}
      {run.branch_name && (
        <MetaRow icon={GitBranch} label="Branch">
          <span className="font-mono truncate">{run.branch_name}</span>
          <CopyButton text={run.branch_name} />
        </MetaRow>
      )}

      {/* Worktree */}
      {run.worktree_path && (
        <MetaRow icon={FolderGit2} label="Worktree">
          <span className="font-mono truncate text-[10px]">{run.worktree_path}</span>
          <CopyButton text={run.worktree_path} />
        </MetaRow>
      )}

      {/* PID */}
      {run.pid && (
        <MetaRow icon={Hash} label="PID">
          <span className="font-mono">{run.pid}</span>
          {isActive && onKill && (
            <button
              onClick={onKill}
              className="ml-1 flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 transition-colors"
            >
              <Skull size={10} />
              kill
            </button>
          )}
        </MetaRow>
      )}

      {/* Engine (agent type) */}
      <MetaRow icon={Zap} label="Engine">
        <div className="flex items-center gap-1.5">
          <AgentBadge agentType={run.agentType ?? run.agent_type} agentModel={run.agentModel ?? run.agent_model} showModelName={false} />
          {(run.agentModel ?? run.agent_model) && (
            <span className="text-[10px] text-muted font-mono">{run.agentModel ?? run.agent_model}</span>
          )}
        </div>
      </MetaRow>


      {/* CIE-016: Context — predicted vs actual */}
      {contextComparison && (() => {
        const predictedKeys = Object.keys(contextComparison.predicted);
        const actualKeys = Object.keys(contextComparison.actual);
        const predictedFileCount = predictedKeys.reduce(
          (sum, k) => sum + (contextComparison.predicted[k]?.injectedFiles?.length ?? 0), 0
        );
        const predictedTokens = predictedKeys.reduce(
          (sum, k) => sum + (contextComparison.predicted[k]?.totalTokens ?? 0), 0
        );
        const actualFileCount = actualKeys.reduce(
          (sum, k) => sum + (contextComparison.actual[k]?.contextFiles?.length ?? 0), 0
        );
        const hasActual = actualKeys.length > 0;

        return (
          <MetaRow icon={FileText} label="Context">
            <span className="font-mono text-[10px]">
              {hasActual ? (
                <>
                  {formatTokens(predictedTokens)} predicted
                  <span className="text-muted mx-1">/</span>
                  {predictedFileCount} files pred
                  <span className="text-muted mx-1">vs</span>
                  {actualFileCount} actual
                </>
              ) : (
                <>{formatTokens(predictedTokens)} predicted · {predictedFileCount} files</>
              )}
            </span>
          </MetaRow>
        );
      })()}

      {/* Cost */}
      <MetaRow icon={DollarSign} label="Cost">
        <span className="text-[10px] text-muted">{formatRunCostTelemetry(telemetry, agentType)}</span>
      </MetaRow>
    </div>
  );
}
