/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ContextTraceRawDrawer — CTM-002 browser-safe raw payload viewer.
 *
 * Renders the lazily-fetched raw payload for a single context-trace event. The
 * payload is NOT loaded until the drawer opens (the parent calls resolveRaw),
 * keeping the heavy blob off the hot path. Large JSON is truncated client-side
 * so a multi-megabyte payload can never lock up the browser tab.
 */

import { useEffect } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import SlideOver from './SlideOver';
import type { ContextTraceEvent, ContextTraceRawRecord } from '../hooks/useContextTrace';

/** Max characters of pretty-printed JSON rendered inline before truncation. */
export const MAX_RAW_RENDER_CHARS = 200_000;

export interface TruncatedJson {
  text: string;
  truncated: boolean;
  totalChars: number;
}

/**
 * Safely serialize + truncate an arbitrary payload for rendering. Pure and
 * testable. Never throws: a circular / unserializable payload falls back to a
 * String() representation so the drawer always renders something.
 */
export function truncateJson(payload: unknown, maxChars = MAX_RAW_RENDER_CHARS): TruncatedJson {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    // Circular or otherwise unserializable — degrade gracefully.
    text = String(payload);
  }

  const totalChars = text.length;
  if (totalChars <= maxChars) {
    return { text, truncated: false, totalChars };
  }
  return {
    text: text.slice(0, maxChars),
    truncated: true,
    totalChars,
  };
}

interface ContextTraceRawDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** The metadata event whose raw payload is being inspected. */
  event: ContextTraceEvent | null;
  /** Resolution state, driven by useContextTrace.getRawState. */
  loading: boolean;
  error: string | null;
  record: ContextTraceRawRecord | null;
  /** Trigger the lazy fetch — called on open. */
  onResolve: (rawRef: string) => void;
}

export default function ContextTraceRawDrawer({
  isOpen,
  onClose,
  event,
  loading,
  error,
  record,
  onResolve,
}: ContextTraceRawDrawerProps) {
  // Fetch on open (and only when nothing is loaded/loading yet). This is the
  // "fetch only when a user explicitly opens a detail view" guarantee.
  useEffect(() => {
    if (isOpen && event && !record && !loading && !error) {
      onResolve(event.rawRef);
    }
  }, [isOpen, event, record, loading, error, onResolve]);

  const title = event
    ? `${event.phase} · ${event.label ?? event.rawRef}`
    : 'Context trace';

  return (
    <SlideOver isOpen={isOpen} onClose={onClose} title={title}>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {event && (
          <div className="flex items-center gap-2 text-[11px] text-muted flex-wrap">
            <span className="font-mono">{event.rawRef}</span>
            <span>·</span>
            <span>seq {event.seq}</span>
            <span>·</span>
            <span className={statusColor(event.status)}>{event.status}</span>
            {event.storyId && (
              <>
                <span>·</span>
                <span className="font-mono">{event.storyId}</span>
              </>
            )}
            <span className="ml-auto">{new Date(event.ts).toLocaleTimeString()}</span>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" />
            Loading raw payload…
          </div>
        )}

        {error && !loading && (
          <div className="flex items-start gap-2 p-3 rounded bg-rose-500/5 border border-rose-500/20 text-sm text-rose-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Could not load raw payload</p>
              <p className="text-[12px] text-rose-400/80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {record && !loading && !error && <RawBody payload={record.payload} />}

        {!event && !loading && !error && (
          <p className="text-sm text-muted py-10 text-center">No trace event selected.</p>
        )}
      </div>
    </SlideOver>
  );
}

function RawBody({ payload }: { payload: unknown }) {
  const { text, truncated, totalChars } = truncateJson(payload);
  return (
    <div className="space-y-2">
      {truncated && (
        <div className="flex items-center gap-2 p-2 rounded bg-amber-500/5 border border-amber-500/20 text-[12px] text-amber-500">
          <AlertTriangle size={13} className="shrink-0" />
          Payload truncated for display ({MAX_RAW_RENDER_CHARS.toLocaleString()} of{' '}
          {totalChars.toLocaleString()} chars shown).
        </div>
      )}
      <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words bg-black/20 rounded p-3 overflow-x-auto">
        {text}
      </pre>
    </div>
  );
}

function statusColor(status: ContextTraceEvent['status']): string {
  switch (status) {
    case 'ok':
      return 'text-emerald-500';
    case 'partial':
      return 'text-amber-500';
    case 'error':
      return 'text-rose-400';
    default:
      return 'text-muted';
  }
}
