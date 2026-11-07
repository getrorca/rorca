/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';


interface ActivityEnvelope {
  eventId: string;
  streamSequence: number;
  observedAt: string;
  kind: string;
  plane: string;
  payload: Record<string, unknown>;
  redaction: { class: string; ordinaryProjectionContainsRaw: false };
  authorityEffect: 'none';
}

interface ActivityPage {
  status: 'ok' | 'gap' | 'reset';
  resetReason: string | null;
  events: ActivityEnvelope[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface OperationalPlane {
  plane: string;
  status: string;
  sourceClass: string | null;
  sourceIdentity: string | null;
  sourceHash: string | null;
  observedAt: string | null;
  validUntil: string | null;
  reasonCode: string;
  impact: string;
  nextSafeAction: string;
}

interface RunActivityProjection {
  runtimeGeneration: number | null;
  lease: string;
  cancellation: string;
  context: string;
  completionCandidate: string;
  retryBudget: { state: string; spent: number; maximum: number };
  closeout: { decisionId: string; status: 'accepted' | 'blocked'; verified: true } | null;
}

interface RunActivityState {
  state: string;
  projection: RunActivityProjection;
  operationalPlanes: OperationalPlane[];
  planeCount: 7;
  notices: string[];
  authoritative: false;
  authorityEffect: 'none';
}

export interface RunActivityViewProps {
  runId: number;
  workspaceId: string;
  refreshMs?: number;
}

const tone = (status: string): string => {
  if (['healthy', 'active', 'authorized', 'settled'].includes(status)) return 'text-success border-success/30 bg-success/5';
  if (['failed', 'rejected', 'quarantined', 'gap'].includes(status)) return 'text-error border-error/30 bg-error/5';
  if (['degraded', 'stale'].includes(status)) return 'text-warning border-warning/30 bg-warning/5';
  return 'text-muted border-border bg-panel/30';
};

function eventSummary(event: ActivityEnvelope): string {
  const payload = event.payload ?? {};
  const reason = payload.reasonCode ?? payload.activityType ?? payload.state ?? payload.status;
  return typeof reason === 'string' ? reason : event.kind;
}

const stateLabel = (value: string): string => value.replaceAll('_', ' ');

export default function RunActivityView({
  runId,
  workspaceId,
  refreshMs = 2_000,
}: RunActivityViewProps) {
  const [state, setState] = useState<RunActivityState | null>(null);
  const [events, setEvents] = useState<ActivityEnvelope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const query = `workspaceId=${encodeURIComponent(workspaceId)}`;
      const [nextState, tailPage] = await Promise.all([
        apiFetch<RunActivityState>(`/api/mission-control/v1/run-activity/runs/${runId}/state?${query}`),
        apiFetch<ActivityPage>(`/api/mission-control/v1/run-activity/runs/${runId}/events?${query}&limit=100&tail=true`),
      ]);
      setState(nextState);
      setEvents(tailPage.events.slice(-100));
      setError(tailPage.status === 'ok' ? null : `${tailPage.status}: ${tailPage.resetReason ?? 'replay unavailable'}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Run activity is unavailable');
    } finally {
      setLoading(false);
    }
  }, [runId, workspaceId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), refreshMs);
    return () => window.clearInterval(timer);
  }, [refresh, refreshMs]);

  return (
    <section
      id="governed-run-activity"
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col bg-background focus:outline-none"
      aria-label="Governed run activity"
      data-testid="run-activity-view"
    >
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <div>
            <h2 className="text-sm font-semibold">Run activity</h2>
            <p className="text-[11px] text-muted">Governed state, status planes, and durable events. Interactive output remains in Terminal.</p>
          </div>
          <button type="button" onClick={() => void refresh()} aria-label="Refresh run activity" className="rounded p-1.5 text-muted hover:bg-panel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </header>

        {error && (
          <div role="alert" className="flex items-center gap-2 border-b border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} />{error}
          </div>
        )}

        {state && (
          <div className="border-b border-border p-3" data-testid="run-current-state">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Current governed state</h3>
              <span className="text-[11px] text-muted">generation {state.projection.runtimeGeneration ?? 'not observed'}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <div><dt className="text-muted">Lease</dt><dd>{stateLabel(state.projection.lease)}</dd></div>
              <div><dt className="text-muted">Cancellation</dt><dd>{stateLabel(state.projection.cancellation)}</dd></div>
              <div><dt className="text-muted">Context</dt><dd>{stateLabel(state.projection.context)}</dd></div>
              <div><dt className="text-muted">Retry</dt><dd>{stateLabel(state.projection.retryBudget.state)} · {state.projection.retryBudget.spent}/{state.projection.retryBudget.maximum}</dd></div>
              <div><dt className="text-muted">Completion candidate</dt><dd>{stateLabel(state.projection.completionCandidate)}</dd></div>
              <div><dt className="text-muted">Canonical closeout</dt><dd>{state.projection.closeout
                ? `${state.projection.closeout.status} · ${state.projection.closeout.decisionId}`
                : 'not observed'}</dd></div>
            </dl>
          </div>
        )}

        <div className="border-b border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Independent status planes</h3>
            <span className="text-[11px] text-muted">{state?.operationalPlanes.length ?? 0}/7 observed</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5" data-testid="status-planes">
            {(state?.operationalPlanes ?? []).map((plane) => (
              <div key={plane.plane} className={`rounded border px-2 py-1.5 ${tone(plane.status)}`} title={`${plane.impact} ${plane.nextSafeAction}`}>
                <div className="truncate text-[11px] font-medium">{stateLabel(plane.plane)}</div>
                <div className="truncate text-[10px] opacity-80">{plane.status} · {plane.reasonCode}</div>
                <div className="truncate text-[10px] opacity-70">{plane.sourceClass ?? 'source unavailable'} · {plane.sourceIdentity ?? 'identity unavailable'}</div>
                <div className="truncate font-mono text-[9px] opacity-60">{plane.sourceHash ?? 'hash unavailable'}</div>
                <div className="truncate text-[9px] opacity-60">observed {plane.observedAt ?? 'not observed'} · valid until {plane.validUntil ?? 'not available'}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3" aria-live="polite">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Activity stream</h3>
            <span className="text-[11px] text-muted">{state?.state ?? (loading ? 'loading' : 'empty')}</span>
          </div>
          {events.length === 0 && !loading ? (
            <p className="text-xs text-muted">No durable activity has been observed.</p>
          ) : (
            <ol className="space-y-1" data-testid="activity-stream">
              {events.map((event) => (
                <li key={`${event.eventId}:${event.streamSequence}`} className="rounded border border-border bg-panel/30 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate font-medium">{event.kind.replaceAll('_', ' ')}</span>
                    <span className="shrink-0 text-muted">#{event.streamSequence}</span>
                  </div>
                  <div className="truncate text-[10px] text-muted">{event.plane} · {eventSummary(event)}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
    </section>
  );
}
