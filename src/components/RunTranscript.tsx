/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, Download, Loader2 } from 'lucide-react';
import { apiFetch, BASE_URL } from '../lib/apiFetch';

export type PtyTranscriptEventType =
  | 'model_message'
  | 'tool_call'
  | 'tool_result'
  | 'host_notice'
  | 'error'
  | 'gap';

interface PtyTranscriptEvent {
  eventId: string;
  contractVersion: number;
  generationId: string;
  runId: number;
  storyId: string;
  seq: number;
  eventType: PtyTranscriptEventType;
  eventSource: 'structured' | 'terminal_normalized' | 'host' | 'recovery';
  role: 'assistant' | 'system' | 'tool' | 'host' | null;
  correlationId: string | null;
  payload: unknown;
  redacted: boolean;
  truncated: boolean;
  authoritative: boolean;
  createdAt: string;
}

interface TranscriptGap {
  afterSeq: number;
  beforeSeq: number;
  missingCount: number;
  reason: 'sequence_gap';
}

interface PtyTranscriptPage {
  contractVersion: number;
  generationId: string;
  items: PtyTranscriptEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  gaps: TranscriptGap[];
}

interface RunTranscriptProps {
  runId: number;
  generationId: string | null;
  available: boolean;
  archiveAvailable: boolean;
  active: boolean;
}

const ANSI_OR_CONTROL_PATTERN = /(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-_]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F])/g;

function safeTranscriptText(payload: unknown): string {
  let value: string;
  if (typeof payload === 'string') {
    value = payload;
  } else if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    value = (payload as { text: string }).text;
  } else {
    try {
      value = JSON.stringify(payload, null, 2) ?? '';
    } catch {
      value = '[Unserializable structured payload]';
    }
  }
  return value.replace(ANSI_OR_CONTROL_PATTERN, '');
}

const EVENT_LABELS: Record<PtyTranscriptEventType, string> = {
  model_message: 'Model',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  host_notice: 'Host notice',
  error: 'Error',
  gap: 'Capture gap',
};

function eventTone(eventType: PtyTranscriptEventType): { color: string; background: string } {
  if (eventType === 'error' || eventType === 'gap') {
    return { color: 'var(--terminal-state-warning)', background: 'var(--terminal-state-warning-bg)' };
  }
  if (eventType === 'host_notice') {
    return { color: 'var(--terminal-state-notice)', background: 'var(--terminal-state-notice-bg)' };
  }
  return { color: 'var(--text)', background: 'var(--panel)' };
}

export default function RunTranscript({
  runId,
  generationId,
  available,
  archiveAvailable,
  active,
}: RunTranscriptProps) {
  const [items, setItems] = useState<PtyTranscriptEvent[]>([]);
  const [gaps, setGaps] = useState<TranscriptGap[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveGuardOpen, setArchiveGuardOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const requestIdentityRef = useRef(0);
  const lastSequenceRef = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const loadPage = useCallback(async (nextCursor: string | null, initial: boolean) => {
    if (!generationId || loading) return;
    const requestIdentity = ++requestIdentityRef.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: '50' });
    if (nextCursor) params.set('cursor', nextCursor);
    try {
      const page = await apiFetch<PtyTranscriptPage>(
        `/api/pty-evidence/runs/${runId}/generations/${generationId}/transcript?${params}`,
        { silent: true },
      );
      if (requestIdentity !== requestIdentityRef.current) return;
      if (page.contractVersion !== 1 || page.generationId !== generationId) {
        throw new Error('Transcript page identity did not match the active generation.');
      }
      let priorSequence = initial ? 0 : lastSequenceRef.current;
      for (const item of page.items) {
        if (item.contractVersion !== 1
          || item.runId !== runId
          || item.generationId !== generationId
          || !Number.isSafeInteger(item.seq)
          || item.seq <= priorSequence) {
          throw new Error('Transcript event identity or sequence did not match the requested page.');
        }
        priorSequence = item.seq;
      }
      lastSequenceRef.current = priorSequence;
      setItems(previous => initial ? page.items : [...previous, ...page.items]);
      setGaps(previous => initial ? page.gaps : [...previous, ...page.gaps]);
      // An active-generation poll can legitimately return no new events and a
      // null nextCursor. Preserve the last opaque cursor; resetting it would
      // make the next poll fetch page one and falsely report a sequence mismatch.
      setCursor(page.nextCursor ?? nextCursor);
      setHasMore(page.hasMore);
      setAnnouncement(`${page.items.length} transcript events loaded${page.hasMore ? '; more history is available.' : '; complete history is loaded.'}`);
    } catch (loadError) {
      if (requestIdentity !== requestIdentityRef.current) return;
      setError(loadError instanceof Error ? loadError.message : 'Transcript history is temporarily unavailable.');
      setAnnouncement('Transcript history could not be loaded. Retry is available.');
    } finally {
      if (requestIdentity === requestIdentityRef.current) setLoading(false);
    }
  }, [generationId, loading, runId]);

  useEffect(() => {
    requestIdentityRef.current += 1;
    setItems([]);
    lastSequenceRef.current = 0;
    setGaps([]);
    setCursor(null);
    setHasMore(false);
    setError(null);
    setArchiveGuardOpen(false);
    setAnnouncement('');
    if (generationId) void loadPage(null, true);
    return () => { requestIdentityRef.current += 1; };
    // Loading is intentionally generation-scoped. Pagination remains explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationId, runId]);

  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const events = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-transcript-event="true"]') ?? []);
    if (events.length === 0) return;
    const current = events.indexOf(document.activeElement as HTMLElement);
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = events.length - 1;
    else if (event.key === 'ArrowDown') next = Math.min(events.length - 1, Math.max(0, current + 1));
    else next = Math.max(0, current < 0 ? 0 : current - 1);
    event.preventDefault();
    events[next]?.focus();
  };

  if (!generationId) {
    return (
      <div className="h-full flex items-center justify-center px-4 text-center text-sm text-muted" role="status">
        Structured transcript is unavailable because this run has no PTY generation. Open Connection diagnostics for the durable fallback source.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-panel" aria-label="Complete structured transcript">
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>

      {gaps.map(gap => (
        <div
          key={`${gap.afterSeq}:${gap.beforeSeq}`}
          className="shrink-0 px-2 sm:px-3 py-2 text-xs border-b"
          style={{ color: 'var(--terminal-state-warning)', background: 'var(--terminal-state-warning-bg)', borderColor: 'var(--terminal-state-warning)' }}
          role="alert"
        >
          Structured capture gap: transcript sequences {gap.afterSeq + 1}–{gap.beforeSeq - 1} are missing ({gap.missingCount} events). Raw archive availability does not imply these normalized events can be reconstructed.
        </div>
      ))}

      {error && (
        <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-3 text-xs" role="alert" style={{ color: 'var(--terminal-state-warning)', background: 'var(--terminal-state-warning-bg)' }}>
          <span className="flex items-center gap-2"><AlertCircle size={14} />{error}</span>
          <button className="underline font-medium focus-visible:outline focus-visible:outline-2" onClick={() => void loadPage(cursor, items.length === 0)}>Retry</button>
        </div>
      )}

      <ul
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        aria-label="Transcript events"
        onKeyDown={handleListKeyDown}
      >
        {items.map(event => {
          const tone = eventTone(event.eventType);
          return (
            <li key={event.eventId} className="border-b border-border/60">
              <article
                tabIndex={0}
                data-transcript-event="true"
                className="px-2 sm:px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                style={{ color: tone.color, background: tone.background, outlineColor: 'var(--terminal-focus-ring)' }}
                aria-label={`${EVENT_LABELS[event.eventType]} transcript event ${event.seq}${event.redacted ? ', redacted' : ''}${event.truncated ? ', truncated' : ''}`}
              >
                <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted">
                  <strong style={{ color: tone.color }}>{EVENT_LABELS[event.eventType]}</strong>
                  <span>sequence {event.seq}</span>
                  <span>{event.role ?? event.eventSource}</span>
                  {event.correlationId && <span className="font-mono truncate max-w-full">correlation {event.correlationId}</span>}
                  {event.authoritative && <span>authoritative</span>}
                  {event.redacted && <span>redacted</span>}
                  {event.truncated && <span>truncated</span>}
                </header>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[var(--text)]">{safeTranscriptText(event.payload)}</pre>
              </article>
            </li>
          );
        })}
      </ul>

      {items.length === 0 && !loading && !error && (
        <div className="flex-1 flex items-center justify-center px-4 text-center text-sm text-muted" role="status">
          {active
            ? 'Waiting for the first structured transcript event…'
            : available
              ? 'This generation ended without structured transcript events.'
              : 'No structured transcript was captured for this generation. Terminal replay and Connection diagnostics remain available.'}
        </div>
      )}

      <div className="shrink-0 border-t border-border bg-panel px-2 sm:px-3 py-2 flex flex-wrap items-center gap-2">
        {(hasMore || (active && items.length > 0)) && (
          <button
            onClick={() => void loadPage(cursor, false)}
            disabled={loading}
            className="px-2.5 py-1.5 rounded border border-border text-xs font-medium hover:bg-surface-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2"
            style={{ outlineColor: 'var(--terminal-focus-ring)' }}
          >
            {loading ? <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" />Loading</span> : hasMore ? 'Load next 50 events' : 'Check for newer events'}
          </button>
        )}
        {loading && items.length === 0 && <span className="text-xs text-muted" role="status">Loading first transcript page…</span>}
        {!hasMore && items.length > 0 && <span className="text-[10px] text-muted">Loaded through sequence {items.at(-1)?.seq}.</span>}

        {archiveAvailable && (
          <button
            onClick={() => setArchiveGuardOpen(value => !value)}
            className="ml-auto px-2.5 py-1.5 rounded border border-border text-xs font-medium hover:bg-surface-200 focus-visible:outline focus-visible:outline-2"
            style={{ outlineColor: 'var(--terminal-focus-ring)' }}
            aria-expanded={archiveGuardOpen}
          >
            Raw archive…
          </button>
        )}
      </div>

      {archiveGuardOpen && (
        <div className="shrink-0 border-t border-border px-3 py-2 text-xs" style={{ background: 'var(--terminal-state-warning-bg)' }}>
          <div className="font-semibold" style={{ color: 'var(--terminal-state-warning)' }}>Sensitive, retention-limited evidence</div>
          <p className="mt-1 text-[var(--text)]">
            The exact raw PTY archive may contain secrets, file contents, prompts, and operator keystrokes. It is retained only until the server’s configured expiry; downloaded copies are your responsibility. Store it securely and delete it when no longer required.
          </p>
          <a
            className="mt-2 inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 font-medium text-[var(--accent-contrast)] bg-accent hover:bg-accent-hover focus-visible:outline focus-visible:outline-2"
            style={{ outlineColor: 'var(--terminal-focus-ring)' }}
            href={`${BASE_URL}/api/pty-evidence/runs/${runId}/generations/${generationId}/raw-archive`}
            download
          >
            <Download size={13} /> Download sensitive raw archive
          </a>
          <p className="mt-1 text-[10px] text-muted">Local operator admin authorization is checked when the download begins.</p>
        </div>
      )}
    </div>
  );
}
