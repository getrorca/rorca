/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, ChevronRight, ChevronDown, Trash2, Rocket, Settings, Sparkles, Package } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import type { PanelId } from './Sidebar';

// ─── Types ──────────────────────────────────────────────────────────────────

interface StackItem {
  name: string;
  version?: string;
  source: string;
}

interface Surface {
  path: string;
  name: string;
  stack: StackItem[];
  suggestedL2: string;
}

interface BootstrapResult {
  configured: boolean;
  empty: boolean;
  surfaces: Surface[];
  direction: {
    standards: string;
    conventions: string;
    project: string;
  };
  scopes: Array<{ path: string; inject: string[]; priority: number }>;
  suggestedSkills: string[];
  healthBefore: number;
  healthAfter: number;
  filesCreated: string[];
}

interface WorkspaceWizardProps {
  workspaceId: string;
  workspaceName: string;
  onComplete: () => void;
  onDismiss: () => void;
  onNavigate: (panel: PanelId) => void;
}

// ─── Scan Messages ──────────────────────────────────────────────────────────

const SCAN_MESSAGES = [
  'Reading package.json...',
  'Analyzing directory structure...',
  'Detecting tech stack...',
  'Scanning for monorepo packages...',
  'Reading configuration files...',
  'Inferring conventions...',
  'Generating direction layers...',
  'Building context routing...',
];

// ─── Step Indicator ─────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full transition-all duration-300 ${
              i < current ? 'bg-accent' :
              i === current ? 'bg-accent w-6 rounded-full' :
              'bg-border'
            }`}
          />
          {i < total - 1 && (
            <div className={`w-8 h-px transition-colors ${i < current ? 'bg-accent' : 'bg-border'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Surface Card ───────────────────────────────────────────────────────────

function SurfaceCard({ surface, onRemove }: {
  surface: Surface;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-panel">
      <div className="flex items-start justify-between p-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <Package size={16} className="text-accent shrink-0" />
            <span className="text-sm font-semibold text-[var(--text)] truncate">{surface.name}</span>
            <span className="text-xs text-muted font-mono">{surface.path === '.' ? '/' : surface.path}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {surface.stack.map((s, i) => (
              <span key={i} className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-accent/10 text-accent">
                {s.name}
                {s.version && <span className="ml-1 text-muted">{s.version}</span>}
              </span>
            ))}
          </div>
        </div>
        <button
          onClick={onRemove}
          className="p-1.5 rounded hover:bg-surface-200 transition-colors text-muted hover:text-red-500"
          title="Remove surface"
          aria-label={`Remove ${surface.name} surface`}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Show details toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-4 py-2 text-xs text-muted hover:text-[var(--text)] hover:bg-surface-200 transition-colors border-t border-border"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? 'Hide details' : 'Show details'}
      </button>

      {expanded && (
        <div className="px-4 pb-3 text-xs text-muted space-y-1 border-t border-border pt-2">
          <p><strong>Domain:</strong> {surface.suggestedL2 || 'general'}</p>
          <p><strong>Stack sources:</strong> {surface.stack.map(s => s.source).join(', ')}</p>
        </div>
      )}
    </div>
  );
}

// ─── WorkspaceWizard ────────────────────────────────────────────────────────

export default function WorkspaceWizard({
  workspaceId,
  workspaceName,
  onComplete,
  onDismiss,
  onNavigate,
}: WorkspaceWizardProps) {
  // Wizard state
  const [step, setStep] = useState<0 | 1 | 2>(0); // 0=scanning, 1=review, 2=done
  const [scanMessageIdx, setScanMessageIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Bootstrap data
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [isEmpty, setIsEmpty] = useState(false);

  // Empty workspace fallback
  const [briefText, setBriefText] = useState('');
  const [briefSubmitting, setBriefSubmitting] = useState(false);

  // Commit state
  const [committing, setCommitting] = useState(false);

  // Summary for step 3
  const [commitSummary, setCommitSummary] = useState({ surfaces: 0, layers: 0 });

  // Cycle scan messages during step 0
  useEffect(() => {
    if (step !== 0) return;
    const id = setInterval(() => {
      setScanMessageIdx(prev => (prev + 1) % SCAN_MESSAGES.length);
    }, 2000);
    return () => clearInterval(id);
  }, [step]);

  // Trigger bootstrap on mount
  const runBootstrap = useCallback(async () => {
    setStep(0);
    setError(null);
    try {
      const data = await apiFetch<BootstrapResult>(
        `/api/workspaces/${workspaceId}/bootstrap`,
        { method: 'POST' },
      );
      setResult(data);
      setSurfaces(data.surfaces);

      if (data.empty) {
        setIsEmpty(true);
      }

      setStep(1);
    } catch (err: any) {
      setError(err.message || 'Bootstrap scan failed');
      setStep(1);
    }
  }, [workspaceId]);

  useEffect(() => {
    runBootstrap();
  }, [runBootstrap]);

  // Handle brief submission for empty workspaces
  const handleBriefSubmit = async () => {
    if (!briefText.trim()) return;
    setBriefSubmitting(true);
    try {
      // Re-run bootstrap won't help for empty projects,
      // so we generate direction from the brief text directly
      const dirResult = await apiFetch<{ direction: { standards: string; conventions: string; project: string } }>(
        `/api/workspaces/${workspaceId}/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brief: briefText }),
        },
      );

      // Update result with whatever we got
      if (dirResult) {
        setResult(prev => prev ? {
          ...prev,
          direction: dirResult.direction || prev.direction,
          empty: false,
        } : null);
        setIsEmpty(false);
      }
    } catch {
      // If the brief-enriched bootstrap also fails, just proceed with empty direction
      setIsEmpty(false);
    } finally {
      setBriefSubmitting(false);
    }
  };

  // Commit wizard results
  const handleCommit = async () => {
    if (!result) return;
    setCommitting(true);
    try {
      const resp = await apiFetch<{ ok: boolean; layersSaved: number }>(
        `/api/workspaces/${workspaceId}/bootstrap/commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            direction: result.direction,
            surfaces,
            scopes: result.scopes,
          }),
        },
      );

      setCommitSummary({
        surfaces: surfaces.length,
        layers: resp.layersSaved,
      });
      setStep(2);
    } catch (err: any) {
      setError(err.message || 'Failed to save configuration');
    } finally {
      setCommitting(false);
    }
  };

  const removeSurface = (index: number) => {
    setSurfaces(prev => prev.filter((_, i) => i !== index));
  };

  const handleStartBuilding = () => {
    onComplete();
    onNavigate('specs');
  };

  const handleCustomize = () => {
    onComplete();
    onNavigate('settings');
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Workspace Setup Wizard"
    >
      <div className="relative bg-bg border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Close button */}
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 z-10 p-2 rounded-lg hover:bg-surface-200 transition-colors text-muted hover:text-[var(--text)]"
          aria-label="Dismiss wizard"
        >
          <X size={18} />
        </button>

        {/* Header */}
        <div className="px-8 pt-8 pb-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
              <Sparkles size={20} className="text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[var(--text)]">
                {step === 0 ? 'Setting up' :
                 step === 1 ? (isEmpty ? 'Tell me about your project' : "Here's what I found") :
                 'Ready to go'}
                {step <= 1 && <span className="text-muted font-normal ml-1.5">{workspaceName}</span>}
              </h2>
            </div>
          </div>

          <StepIndicator current={step} total={3} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-8 pb-8">
          {/* ── Step 0: Scanning ── */}
          {step === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-6">
              <div className="relative">
                <Loader2 size={40} className="text-accent animate-spin" />
                <div className="absolute inset-0 animate-ping opacity-20">
                  <Loader2 size={40} className="text-accent" />
                </div>
              </div>
              <div className="text-center space-y-2">
                <p className="text-sm font-medium text-[var(--text)]">Scanning your project...</p>
                <p className="text-xs text-muted animate-pulse" key={scanMessageIdx}>
                  {SCAN_MESSAGES[scanMessageIdx]}
                </p>
              </div>
              {/* Progress bar (indeterminate) */}
              <div className="w-64 h-1 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full animate-indeterminate-progress" />
              </div>
            </div>
          )}

          {/* ── Step 1: Review ── */}
          {step === 1 && (
            <div className="space-y-6">
              {error && (
                <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                  <p className="text-sm text-red-500">{error}</p>
                  <button
                    onClick={() => { setError(null); runBootstrap(); }}
                    className="mt-2 text-xs text-accent hover:underline"
                  >
                    Retry scan
                  </button>
                </div>
              )}

              {/* Empty workspace: show brief textarea */}
              {isEmpty && !error && (
                <div className="space-y-4">
                  <p className="text-sm text-muted">
                    I couldn't detect a stack. Tell me about your project:
                  </p>
                  <textarea
                    value={briefText}
                    onChange={(e) => setBriefText(e.target.value)}
                    placeholder="e.g., A Next.js 14 SaaS app with Tailwind, Prisma, and Stripe integration for managing subscription billing..."
                    className="w-full h-32 px-4 py-3 text-sm bg-panel border border-border rounded-lg text-[var(--text)] placeholder:text-muted/60 focus:border-accent focus:ring-1 focus:ring-accent transition-colors resize-none"
                  />
                  <button
                    onClick={handleBriefSubmit}
                    disabled={!briefText.trim() || briefSubmitting}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
                  >
                    {briefSubmitting ? (
                      <><Loader2 size={14} className="animate-spin" /> Analyzing...</>
                    ) : (
                      <>Generate direction from description</>
                    )}
                  </button>
                </div>
              )}

              {/* Surfaces list */}
              {!isEmpty && !error && surfaces.length > 0 && (
                <div className="space-y-3">
                  {surfaces.map((surface, i) => (
                    <SurfaceCard
                      key={`${surface.path}-${i}`}
                      surface={surface}
                      onRemove={() => removeSurface(i)}
                    />
                  ))}
                </div>
              )}

              {/* Direction preview */}
              {!isEmpty && !error && result && (
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-muted uppercase tracking-wider">
                    Direction layers to be configured
                  </p>
                  {(['standards', 'conventions', 'project'] as const).map((key) => {
                    const labels = {
                      standards: 'Standards',
                      conventions: 'Conventions',
                      project: 'Project',
                    };
                    const content = result.direction[key];
                    if (!content) return null;
                    return (
                      <DirectionPreview
                        key={key}
                        label={labels[key]}
                        content={content}
                      />
                    );
                  })}
                </div>
              )}

              {/* Health score change */}
              {!isEmpty && !error && result && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-surface-200">
                  <span className="text-xs text-muted">Health score:</span>
                  <span className="text-sm font-bold text-red-500">{result.healthBefore}%</span>
                  <ChevronRight size={14} className="text-muted" />
                  <span className="text-sm font-bold text-emerald-500">{result.healthAfter}%</span>
                </div>
              )}

              {/* Actions */}
              {!isEmpty && !error && (
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={handleCommit}
                    disabled={committing || surfaces.length === 0}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
                  >
                    {committing ? (
                      <><Loader2 size={16} className="animate-spin" /> Saving...</>
                    ) : (
                      <>Apply configuration <ChevronRight size={16} /></>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Done ── */}
          {step === 2 && (
            <div className="flex flex-col items-center justify-center py-12 gap-6">
              {/* Success animation */}
              <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center animate-scale-in">
                <svg className="w-8 h-8 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" className="animate-check-draw" />
                </svg>
              </div>

              <div className="text-center space-y-2">
                <h3 className="text-lg font-bold text-[var(--text)]">You're all set!</h3>
                <p className="text-sm text-muted max-w-md">
                  {commitSummary.surfaces} {commitSummary.surfaces === 1 ? 'surface' : 'surfaces'} configured,{' '}
                  {commitSummary.layers} direction {commitSummary.layers === 1 ? 'layer' : 'layers'} populated,{' '}
                  Memory initialized.
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-col items-center gap-3 w-full max-w-xs">
                <button
                  onClick={handleStartBuilding}
                  className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
                >
                  <Rocket size={16} />
                  Start Building
                </button>
                <button
                  onClick={handleCustomize}
                  className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-[var(--text)] transition-colors"
                >
                  <Settings size={12} />
                  Customize in Settings
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Direction Preview ──────────────────────────────────────────────────────

function DirectionPreview({ label, content }: { label: string; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.split('\n').slice(0, 3).join('\n');
  const hasMore = content.split('\n').length > 3;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-200 transition-colors"
      >
        <span className="text-xs font-semibold text-[var(--text)]">{label}</span>
        {hasMore && (
          expanded ? <ChevronDown size={12} className="text-muted" /> : <ChevronRight size={12} className="text-muted" />
        )}
      </button>
      {(expanded || !hasMore) && (
        <div className="border-t border-border px-4 py-3">
          <pre className="text-xs text-muted whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
            {expanded ? content : preview}
          </pre>
        </div>
      )}
    </div>
  );
}
