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

import { useEffect, type ReactNode } from 'react';
import {
  Loader2,
  AlertTriangle,
  Database,
  GitBranch,
  MessageSquareText,
  Layers,
  Sparkles,
  Search,
  FileText,
} from 'lucide-react';
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
    if (isOpen && event && !event.synthetic && !record && !loading && !error) {
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

        {record && !loading && !error && <RawBody payload={record.payload} event={event} />}

        {event?.synthetic && !record && !loading && !error && <SyntheticEventBody event={event} />}

        {!event && !loading && !error && (
          <p className="text-sm text-muted py-10 text-center">No trace event selected.</p>
        )}
      </div>
    </SlideOver>
  );
}

function RawBody({ payload, event }: { payload: unknown; event: ContextTraceEvent | null }) {
  const record = isPlainRecord(payload) ? payload : null;

  if (record && isRetrievalTracePayload(record, event)) {
    return <RetrievalTraceBody payload={record} />;
  }

  if (record && isArbiterTracePayload(record, event)) {
    return <ArbiterTraceBody payload={record} />;
  }

  if (record && isPromptTracePayload(record, event)) {
    return <PromptTraceBody payload={record} event={event} />;
  }

  const { text, truncated, totalChars } = truncateJson(payload);
  return (
    <div className="space-y-2" data-testid="context-trace-json-fallback">
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

type TracePayloadRecord = Record<string, unknown>;

interface DirectionSection {
  title: string;
  body: string;
}

interface PromptSection {
  title: string;
  body: string;
}

interface SelectedEvidenceItem {
  key: string;
  kind: string;
  title: string;
  body: string;
  skillName: string;
  score: number | null;
  source: string;
  auditLabel: string;
}

function RetrievalTraceBody({ payload }: { payload: TracePayloadRecord }) {
  const memorySection = asString(payload.memorySection);
  const graphSection = asString(payload.graphSection);
  const selections = asRecordArray(payload.selections);
  const meta = isPlainRecord(payload.meta) ? payload.meta : {};
  const error = asString(payload.error);
  const memoryBullets = extractMarkdownBullets(memorySection);
  const selectedKeys = asStringArray(meta.selectedCandidateKeys);
  const matchedSkills = asStringArray(meta.matchedSkills);
  const evidenceItems = buildSelectedEvidenceItems(selections, memoryBullets, selectedKeys);
  const selectedCount = evidenceItems.length || selections.length || selectedKeys.length || asNumber(meta.selectedCount) || memoryBullets.length;
  const candidateCount = asNumber(meta.candidateCount) || asNumber(meta.totalCandidates) || selectedCount;
  const tier = asString(meta.retrievalTier) || asString(meta.tier) || 'execution retrieval';
  const latency = asNumber(meta.latencyMs);
  const needsMoreEvidence = meta.needsMoreEvidence === true;
  const graphHits = asNumber(meta.graphHits);
  const summarySentence = error
    ? 'Rorca attempted retrieval for this story, but the retrieval step failed before context could be injected.'
    : selectedCount > 0
      ? `Rorca selected ${selectedCount.toLocaleString()} of ${candidateCount.toLocaleString()} candidate${candidateCount === 1 ? '' : 's'} and converted them into agent-ready context.`
      : 'Rorca ran retrieval, but no memory candidates were selected for the final story prompt.';

  if (error) {
    return (
      <div className="space-y-4" data-testid="trace-retrieval-view">
        <TraceHero
          icon={<Search size={18} />}
          eyebrow="Retrieval synthesis"
          title="Retrieval did not complete"
          description={summarySentence}
          chips={[{ label: 'Status', value: 'error', tone: 'danger' }]}
        />
        <InsightPanel title="Failure reason" icon={<AlertTriangle size={14} />}>
          <p className="text-sm leading-6 text-rose-400">{error}</p>
        </InsightPanel>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="trace-retrieval-view">
      <TraceHero
        icon={<Search size={18} />}
        eyebrow="Retrieval synthesis"
        title={needsMoreEvidence ? 'Relevant context found, but evidence was thin' : 'Retrieved context was injected into the story prompt'}
        description={summarySentence}
        chips={[
          { label: 'Tier', value: humanizeValue(tier), tone: 'accent' },
          { label: 'Selected', value: selectedCount.toLocaleString(), tone: selectedCount > 0 ? 'success' : 'neutral' },
          ...(latency != null ? [{ label: 'Latency', value: `${latency}ms`, tone: 'neutral' as TraceChipTone }] : []),
          ...(graphHits != null ? [{ label: 'Graph hits', value: graphHits.toLocaleString(), tone: graphHits > 0 ? 'success' as TraceChipTone : 'neutral' as TraceChipTone }] : []),
        ]}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <MetricCard label="Candidates evaluated" value={candidateCount.toLocaleString()} helper="Potential memories/files considered" />
        <MetricCard label="Sent to agent" value={selectedCount.toLocaleString()} helper="Evidence that survived ranking and budget" tone="success" />
        <MetricCard label="Memory text" value={formatBytesish(memorySection.length)} helper="Rendered as prompt-ready constraints" />
      </div>

      <InsightPanel title="What the agent received" icon={<Database size={14} />}>
        {memoryBullets.length > 0 ? (
          <div className="space-y-2">
            {memoryBullets.slice(0, 10).map((item, index) => (
              <div key={`${item}-${index}`} className="rounded border border-border/60 bg-[var(--surface-100)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Memory #{index + 1}</p>
                <p className="mt-1 text-sm leading-6 text-[var(--text)]">{item}</p>
              </div>
            ))}
            {memoryBullets.length > 10 && (
              <p className="text-xs text-muted">+{memoryBullets.length - 10} more retrieved memories are represented in the full context text.</p>
            )}
          </div>
        ) : memorySection ? (
          <ReadableTextBlock text={stripMarkdownHeading(memorySection)} maxChars={5000} />
        ) : (
          <p className="text-sm text-muted">No memory section was injected for this story.</p>
        )}
      </InsightPanel>

      {(evidenceItems.length > 0 || matchedSkills.length > 0) && (
        <InsightPanel title="Selected evidence" icon={<Sparkles size={14} />}>
          <p className="mb-3 text-xs leading-5 text-muted">
            These are the memories that survived ranking and were sent to the agent. Audit IDs are tucked away so the useful lesson stays front-and-center.
          </p>
          {matchedSkills.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Matched retrieval skills">
              {matchedSkills.map((skill) => (
                <span key={skill} className="rounded bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                  {skill}
                </span>
              ))}
            </div>
          )}
          {evidenceItems.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {evidenceItems.slice(0, 8).map((item, index) => (
                <SelectedEvidenceCard key={`${item.key}-${index}`} item={item} index={index} />
              ))}
              {evidenceItems.length > 8 && (
                <p className="text-xs text-muted">+{evidenceItems.length - 8} more selected evidence item(s) were recorded for this trace.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">No explicit selection handles were recorded for this trace.</p>
          )}
        </InsightPanel>
      )}

      <InsightPanel title="Graph contribution" icon={<GitBranch size={14} />}>
        {graphSection ? (
          <ReadableTextBlock text={graphSection} maxChars={6000} />
        ) : (
          <div className="rounded border border-border/60 bg-[var(--surface-100)] p-3" data-testid="trace-graph-empty">
            <p className="text-sm font-semibold text-[var(--text)]">Graph was not used for this story</p>
            <p className="mt-1 text-sm leading-6 text-muted">
              Rorca found enough signal from memory/search retrieval, and no graph hits were added to the final prompt.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-[var(--surface-300)] px-2 py-0.5 text-[10px] font-medium text-muted">Graph hits: {(graphHits ?? 0).toLocaleString()}</span>
              <span className="rounded-full bg-[var(--surface-300)] px-2 py-0.5 text-[10px] font-medium text-muted">Retrieval source: Memory/search</span>
            </div>
          </div>
        )}
      </InsightPanel>
    </div>
  );
}

function ArbiterTraceBody({ payload }: { payload: TracePayloadRecord }) {
  const directionText = asString(payload.directionText);
  const sections = parseDirectionSections(directionText);
  const layers = sections.length || (directionText ? 1 : 0);

  return (
    <div className="space-y-4" data-testid="trace-arbiter-view">
      <TraceHero
        icon={<Layers size={18} />}
        eyebrow="Arbiter synthesis"
        title="Direction layers were merged into one execution contract"
        description="The arbiter stack tells the agent which global standards, workspace conventions, project facts, and story-specific instructions outrank generic model behavior."
        chips={[
          { label: 'Layers', value: layers.toLocaleString(), tone: layers > 0 ? 'success' : 'neutral' },
          { label: 'Size', value: formatBytesish(directionText.length), tone: 'neutral' },
        ]}
      />

      <div className="grid gap-3 md:grid-cols-2" data-testid="trace-arbiter-layers">
        {sections.map((section, index) => (
          <div key={`${section.title}-${index}`} className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Layer {index + 1}</p>
              <span className="rounded bg-[var(--surface-300)] px-1.5 py-0.5 text-[10px] text-muted">{countWords(section.body).toLocaleString()} words</span>
            </div>
            <h4 className="text-sm font-semibold text-[var(--text)]">{section.title}</h4>
            <ul className="space-y-1.5 text-xs leading-5 text-muted">
              {summarizeSectionBody(section.body).map((line, lineIndex) => (
                <li key={`${line}-${lineIndex}`} className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <InsightPanel title="Developer takeaways" icon={<Sparkles size={14} />}>
        <ul className="space-y-2 text-sm leading-6 text-[var(--text)]">
          {buildArbiterTakeaways(sections).map((takeaway) => (
            <li key={takeaway} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              <span>{takeaway}</span>
            </li>
          ))}
        </ul>
      </InsightPanel>

      <details className="rounded border border-border/70 bg-[var(--surface-100)]">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text)]">Read full arbiter stack</summary>
        <ReadableTextBlock text={directionText || 'No direction text was recorded.'} maxChars={MAX_RAW_RENDER_CHARS} className="border-t border-border/70" />
      </details>
    </div>
  );
}

function PromptTraceBody({ payload, event }: { payload: TracePayloadRecord; event: ContextTraceEvent | null }) {
  const prompt = asString(payload.prompt);
  const agentType = asString(payload.agentType) || 'agent';
  const mode = asString(payload.mode) || 'execution';
  const sections = parsePromptSections(prompt);
  const { text: promptText, truncated, totalChars } = truncatePlainText(prompt, MAX_RAW_RENDER_CHARS);

  return (
    <div className="space-y-4" data-testid="trace-prompt-view">
      <TraceHero
        icon={<MessageSquareText size={18} />}
        eyebrow="Prompt assembly"
        title="This is the final instruction packet sent to the coding agent"
        description="Rorca combined the story, repo governance, retrieved memory, skills, graph context, and execution packet into a single prompt."
        chips={[
          { label: 'Agent', value: humanizeValue(agentType), tone: 'accent' },
          { label: 'Mode', value: humanizeValue(mode), tone: 'neutral' },
          { label: 'Story', value: event?.storyId || 'unknown', tone: 'neutral' },
          { label: 'Words', value: countWords(prompt).toLocaleString(), tone: 'success' },
        ]}
      />

      <InsightPanel title="Prompt anatomy" icon={<FileText size={14} />}>
        {sections.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-2">
            {sections.slice(0, 8).map((section, index) => (
              <div key={`${section.title}-${index}`} className="rounded border border-border/60 bg-[var(--surface-100)] p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-semibold text-[var(--text)]">{section.title}</p>
                  <span className="rounded bg-[var(--surface-300)] px-1.5 py-0.5 text-[10px] text-muted">{countWords(section.body).toLocaleString()} words</span>
                </div>
                <p className="mt-1 text-[11px] leading-5 text-muted">{excerpt(section.body, 240) || 'Section body was empty.'}</p>
              </div>
            ))}
            {sections.length > 8 && <p className="text-xs text-muted">+{sections.length - 8} more prompt sections are included below.</p>}
          </div>
        ) : (
          <p className="text-sm text-muted">The prompt did not contain markdown section headings, so it is shown as one assembled instruction block below.</p>
        )}
      </InsightPanel>

      {truncated && (
        <div className="flex items-center gap-2 p-2 rounded bg-amber-500/5 border border-amber-500/20 text-[12px] text-amber-500">
          <AlertTriangle size={13} className="shrink-0" />
          Prompt truncated for display ({MAX_RAW_RENDER_CHARS.toLocaleString()} of {totalChars.toLocaleString()} chars shown).
        </div>
      )}

      <section className="rounded border border-border bg-[var(--surface-200)]" data-testid="trace-final-prompt">
        <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Final prompt</p>
          <span className="text-[10px] text-muted">Plain text · not raw JSON</span>
        </div>
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-6 text-[var(--text)]">
          {promptText || 'No prompt text was recorded.'}
        </pre>
      </section>
    </div>
  );
}

interface TraceChip {
  label: string;
  value: string;
  tone?: TraceChipTone;
}

type TraceChipTone = 'neutral' | 'success' | 'accent' | 'danger';

function TraceHero({ icon, eyebrow, title, description, chips }: { icon: ReactNode; eyebrow: string; title: string; description: string; chips: TraceChip[] }) {
  return (
    <section className="rounded-xl border border-[var(--accent)]/20 bg-gradient-to-br from-[var(--accent)]/12 via-[var(--surface-200)] to-[var(--surface-100)] p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-[var(--accent)]/10 p-2 text-[var(--accent)]">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">{eyebrow}</p>
          <h3 className="mt-1 text-lg font-semibold leading-6 text-[var(--text)]">{title}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{description}</p>
          {chips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {chips.map((chip) => <TraceChipBadge key={`${chip.label}:${chip.value}`} chip={chip} />)}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function TraceChipBadge({ chip }: { chip: TraceChip }) {
  const toneClass = chip.tone === 'success'
    ? 'bg-emerald-500/10 text-emerald-500'
    : chip.tone === 'danger'
      ? 'bg-rose-500/10 text-rose-400'
      : chip.tone === 'accent'
        ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
        : 'bg-[var(--surface-300)] text-muted';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClass}`}>
      <span className="opacity-75">{chip.label}: </span>{chip.value}
    </span>
  );
}

function MetricCard({ label, value, helper, tone = 'neutral' }: { label: string; value: string; helper: string; tone?: 'neutral' | 'success' }) {
  return (
    <div className="rounded border border-border bg-[var(--surface-200)] p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold ${tone === 'success' ? 'text-emerald-500' : 'text-[var(--text)]'}`}>{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-muted">{helper}</p>
    </div>
  );
}

function InsightPanel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded border border-border bg-[var(--surface-200)] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
        <span className="text-[var(--accent)]">{icon}</span>
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function ReadableTextBlock({ text, maxChars, className = '' }: { text: string; maxChars: number; className?: string }) {
  const { text: displayed, truncated, totalChars } = truncatePlainText(text, maxChars);
  return (
    <div className={`space-y-2 p-3 ${className}`}>
      {truncated && (
        <div className="flex items-center gap-2 rounded bg-amber-500/5 p-2 text-[12px] text-amber-500">
          <AlertTriangle size={13} className="shrink-0" />
          Text truncated for display ({maxChars.toLocaleString()} of {totalChars.toLocaleString()} chars shown).
        </div>
      )}
      <div className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--text)]">{displayed}</div>
    </div>
  );
}

function SelectedEvidenceCard({ item, index }: { item: SelectedEvidenceItem; index: number }) {
  return (
    <article className="rounded border border-border/60 bg-[var(--surface-100)] p-3" data-testid="selected-evidence-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Evidence #{index + 1}</p>
          <h4 className="mt-1 text-sm font-semibold leading-5 text-[var(--text)]">{item.title}</h4>
        </div>
        {item.score != null && (
          <span className="shrink-0 rounded bg-emerald-500/10 px-2 py-1 font-mono text-xs font-semibold text-emerald-500" title="Selection relevance score">
            {formatScorePercent(item.score)}%
          </span>
        )}
      </div>

      {item.body && <p className="mt-2 text-xs leading-5 text-muted">{item.body}</p>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="rounded-full bg-[var(--surface-300)] px-2 py-0.5 text-[10px] font-medium text-muted">{humanizeValue(item.kind)}</span>
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">Sent to prompt</span>
        {item.skillName && <span className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">Matched {item.skillName}</span>}
        {item.source && <span className="rounded-full bg-[var(--surface-300)] px-2 py-0.5 text-[10px] font-medium text-muted">{humanizeValue(item.source)}</span>}
      </div>

      <details className="mt-3 rounded border border-border/60 bg-[var(--surface-200)]">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-medium text-muted">Audit details</summary>
        <dl className="space-y-1 border-t border-border/60 px-2.5 py-2 text-[11px]">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted">Handle</dt>
            <dd className="min-w-0 break-all font-mono text-[var(--text)]">{item.auditLabel}</dd>
          </div>
          {item.score != null && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted">Score</dt>
              <dd className="font-mono text-[var(--text)]">{item.score.toFixed(3)}</dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  );
}

function isPlainRecord(value: unknown): value is TracePayloadRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRetrievalTracePayload(payload: TracePayloadRecord, event: ContextTraceEvent | null): boolean {
  return event?.phase === 'memory'
    || 'memorySection' in payload
    || 'graphSection' in payload
    || 'selections' in payload;
}

function isArbiterTracePayload(payload: TracePayloadRecord, event: ContextTraceEvent | null): boolean {
  return typeof payload.directionText === 'string'
    || (event?.phase === 'context' && typeof event.label === 'string' && event.label.startsWith('arbiter:'));
}

function isPromptTracePayload(payload: TracePayloadRecord, _event: ContextTraceEvent | null): boolean {
  return typeof payload.prompt === 'string';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecordArray(value: unknown): TracePayloadRecord[] {
  return Array.isArray(value) ? value.filter(isPlainRecord) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function buildSelectedEvidenceItems(
  selections: TracePayloadRecord[],
  memoryBullets: string[],
  selectedKeys: string[],
): SelectedEvidenceItem[] {
  const total = Math.max(selections.length, selectedKeys.length, memoryBullets.length);
  return Array.from({ length: total }, (_, index) => {
    const selection = selections[index] ?? {};
    const key = asString(selection.candidateKey) || asString(selection.key) || selectedKeys[index] || `selected-evidence-${index + 1}`;
    const kind = asString(selection.candidateKind) || asString(selection.kind) || 'memory';
    const score = asNumber(selection.score) ?? asNumber(selection.relevanceScore) ?? asNumber(selection.finalScore);
    const source = asString(selection.source) || asString(selection.sourceType);
    const skillName = asString(selection.skillName);
    const text = asString(selection.snippet)
      || asString(selection.text)
      || asString(selection.rule)
      || memoryBullets[index]
      || '';
    const explicitTitle = asString(selection.title) || asString(selection.memoryTitle);
    const { title, body } = splitEvidenceText(text, explicitTitle, index);

    return {
      key,
      kind,
      title,
      body,
      skillName,
      score,
      source,
      auditLabel: key,
    };
  });
}

function splitEvidenceText(text: string, explicitTitle: string, index: number): { title: string; body: string } {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return {
      title: explicitTitle || `Retrieved memory #${index + 1}`,
      body: 'This selected memory was sent to the prompt, but this older trace only recorded its audit handle.',
    };
  }

  if (explicitTitle) {
    const body = normalized.startsWith(explicitTitle)
      ? normalizeWhitespace(normalized.slice(explicitTitle.length).replace(/^[:\-–—]\s*/, ''))
      : normalized;
    return { title: explicitTitle, body };
  }

  const colonIndex = normalized.indexOf(':');
  if (colonIndex >= 4 && colonIndex <= 120) {
    const title = normalized.slice(0, colonIndex).trim();
    const body = normalized.slice(colonIndex + 1).trim();
    if (title.length >= 4 && body.length > 0) return { title, body };
  }

  const sentenceMatch = normalized.match(/^(.{24,140}?[.!?])\s+(.+)$/);
  if (sentenceMatch) {
    return { title: sentenceMatch[1].trim(), body: sentenceMatch[2].trim() };
  }

  return {
    title: excerpt(normalized, 110),
    body: normalized.length > 110 ? normalized : '',
  };
}

function truncatePlainText(value: string, maxChars: number): TruncatedJson {
  const totalChars = value.length;
  if (totalChars <= maxChars) return { text: value, truncated: false, totalChars };
  return { text: value.slice(0, maxChars), truncated: true, totalChars };
}

function extractMarkdownBullets(text: string): string[] {
  if (!text.trim()) return [];
  const matches = [...text.matchAll(/(?:^|\n)\s*[-*]\s+([\s\S]*?)(?=\n\s*[-*]\s+|\n#{1,6}\s+|$)/g)];
  return matches
    .map((match) => normalizeWhitespace(match[1]))
    .filter(Boolean);
}

function stripMarkdownHeading(text: string): string {
  return text.replace(/^#{1,6}\s+.*?\n+/, '').trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parseDirectionSections(text: string): DirectionSection[] {
  if (!text.trim()) return [];
  const headingPattern = /^===\s*(.*?)\s*===\s*$/gm;
  const headings = [...text.matchAll(headingPattern)];
  if (headings.length === 0) return [{ title: 'Direction stack', body: text.trim() }];

  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index ?? text.length : text.length;
    return {
      title: heading[1].trim(),
      body: text.slice(start, end).trim(),
    };
  }).filter((section) => section.body.length > 0 || section.title.length > 0);
}

function summarizeSectionBody(body: string): string[] {
  const bullets = extractMarkdownBullets(body);
  if (bullets.length > 0) return bullets.slice(0, 3).map((item) => excerpt(item, 180));
  const lines = body
    .split('\n')
    .map((line) => line.replace(/^[-\s]+/, '').trim())
    .filter((line) => line && !line.endsWith(':'));
  return (lines.length > 0 ? lines : ['Layer content was present but not line-oriented.'])
    .slice(0, 3)
    .map((line) => excerpt(line, 180));
}

function buildArbiterTakeaways(sections: DirectionSection[]): string[] {
  const titles = sections.map((section) => section.title.toLowerCase());
  const takeaways: string[] = [];
  if (titles.some((title) => title.includes('global') || title.includes('l1'))) {
    takeaways.push('Global engineering standards were present, so safety and repository-wide conventions should guide implementation choices.');
  }
  if (titles.some((title) => title.includes('domain') || title.includes('l2'))) {
    takeaways.push('Domain conventions were loaded, giving the agent product- and stack-specific constraints beyond generic coding advice.');
  }
  if (titles.some((title) => title.includes('project') || title.includes('l3'))) {
    takeaways.push('Project context was injected, including workspace paths, governance, and repo-specific development commands where available.');
  }
  if (titles.some((title) => title.includes('spec') || title.includes('story') || title.includes('l4') || title.includes('l5'))) {
    takeaways.push('Spec/story instructions were included last, so the immediate story can refine the broader direction stack.');
  }
  if (takeaways.length === 0) {
    takeaways.push('The direction stack was captured as plain instructions for the agent, not as opaque JSON.');
  }
  return takeaways;
}

function parsePromptSections(prompt: string): PromptSection[] {
  if (!prompt.trim()) return [];
  const headingPattern = /^#{1,3}\s+(.+?)\s*$/gm;
  const headings = [...prompt.matchAll(headingPattern)];
  if (headings.length === 0) return [];

  const sections: PromptSection[] = [];
  const firstHeadingIndex = headings[0].index ?? 0;
  const preamble = prompt.slice(0, firstHeadingIndex).trim();
  if (preamble) sections.push({ title: 'Opening instructions', body: preamble });

  headings.forEach((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index ?? prompt.length : prompt.length;
    sections.push({ title: heading[1].trim(), body: prompt.slice(start, end).trim() });
  });
  return sections.filter((section) => section.title || section.body);
}

function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function excerpt(text: string, maxChars: number): string {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatBytesish(chars: number): string {
  if (chars < 1000) return `${chars.toLocaleString()} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

function formatScorePercent(score: number): number {
  const normalized = score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function humanizeValue(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function SyntheticEventBody({ event }: { event: ContextTraceEvent }) {
  return (
    <div className="space-y-3" data-testid="context-trace-synthetic-body">
      <div className="flex items-start gap-2 p-3 rounded bg-amber-500/5 border border-amber-500/20 text-sm text-amber-400">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">Metadata-only trace</p>
          <p className="text-[12px] text-amber-400/80 mt-0.5">
            The raw artifact is unavailable for this run, so this drawer shows the saved trace metadata instead.
          </p>
        </div>
      </div>

      {event.metrics && (
        <div className="rounded border border-border/60 bg-black/10 p-3" data-testid="context-trace-synthetic-metrics">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">Metrics</p>
          <div className="grid grid-cols-2 gap-2 text-xs text-muted">
            {event.metrics.tokens != null && <span>Tokens: <strong className="text-[var(--text)]">{event.metrics.tokens.toLocaleString()}</strong></span>}
            {event.metrics.bytes != null && <span>Bytes: <strong className="text-[var(--text)]">{event.metrics.bytes.toLocaleString()}</strong></span>}
            {event.metrics.fileCount != null && <span>Files: <strong className="text-[var(--text)]">{event.metrics.fileCount.toLocaleString()}</strong></span>}
            {event.metrics.durationMs != null && <span>Latency: <strong className="text-[var(--text)]">{event.metrics.durationMs.toLocaleString()}ms</strong></span>}
          </div>
        </div>
      )}

      {event.details && event.details.length > 0 && (
        <div className="rounded border border-border/60 bg-black/10 p-3" data-testid="context-trace-synthetic-details">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">Details</p>
          <ul className="space-y-1 text-xs text-[var(--text)] list-disc pl-4">
            {event.details.map((detail, index) => (
              <li key={`${event.rawRef}-detail-${index}`}>{detail}</li>
            ))}
          </ul>
        </div>
      )}
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
