/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock, Cpu, GitBranch, Loader2, Wrench } from 'lucide-react';
import type { WalEvent } from '../hooks/usePipelineSSE';

type AgentStatus = 'running' | 'completed' | 'failed';

interface AgentLane {
  id: string;
  parentId: string | null;
  name: string;
  role: string;
  status: AgentStatus;
  startedAt: string;
  finishedAt: string | null;
  tools: string[];
  eventCount: number;
  failureReason: string | null;
  evidence: string[];
  retryOf: string | null;
  continuationOf: string | null;
  sequence: number;
}

interface OrchestrationPayload {
  kind?: string | null;
  sequence?: number;
  idempotencyKey?: string;
  observedAt?: string;
  attempt?: { id?: string; label?: string };
  process?: { id?: string };
  omp?: {
    agentId?: string | null;
    parentAgentId?: string | null;
    taskId?: string | null;
    rpcType?: string;
    raw?: Record<string, unknown>;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [item.trim()];
    const itemRecord = record(item);
    return [text(itemRecord, 'label', 'name', 'path', 'uri', 'summary')].filter((entry): entry is string => !!entry);
  });
}

function payloadOf(event: WalEvent): OrchestrationPayload | null {
  if (!event.event_type.startsWith('orchestration.') || !event.payload) return null;
  try {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    return record(payload) as OrchestrationPayload;
  } catch {
    return null;
  }
}

function durableOrchestrationEntries(events: WalEvent[]) {
  const unique = new Map<string, { event: WalEvent; payload: OrchestrationPayload }>();
  for (const event of events) {
    const payload = payloadOf(event);
    if (!payload) continue;
    const key = payload.idempotencyKey ?? `sequence:${payload.sequence ?? event.id}`;
    if (!unique.has(key)) unique.set(key, { event, payload });
  }
  return [...unique.values()].sort((a, b) => (a.payload.sequence ?? a.event.id) - (b.payload.sequence ?? b.event.id));
}

export function projectOrchestrationTree(events: WalEvent[]): AgentLane[] {
  const lanes = new Map<string, AgentLane>();
  const ordered = durableOrchestrationEntries(events);

  for (const { event, payload } of ordered) {
    const omp = payload.omp ?? {};
    const raw = record(omp.raw);
    const nested = { ...record(raw.event), ...record(raw.data) };
    const agentId = omp.agentId ?? text(raw, 'agentId', 'agent_id') ?? text(nested, 'agentId', 'agent_id')
      ?? payload.process?.id ?? `attempt:${payload.attempt?.id ?? event.story_id ?? 'unknown'}`;
    const parentId = omp.parentAgentId ?? text(raw, 'parentAgentId', 'parent_agent_id')
      ?? text(nested, 'parentAgentId', 'parent_agent_id');
    const observedAt = payload.observedAt ?? event.ts;
    const existing = lanes.get(agentId);
    const kind = payload.kind ?? event.event_type.replace('orchestration.', '');
    const role = text(raw, 'role', 'agentRole', 'agent_role') ?? text(nested, 'role', 'agentRole', 'agent_role');
    const name = text(raw, 'name', 'agentName', 'agent_name') ?? text(nested, 'name', 'agentName', 'agent_name');
    const tool = text(raw, 'toolName', 'tool_name') ?? text(nested, 'toolName', 'tool_name')
      ?? (kind === 'task_started' ? omp.taskId ?? null : null);
    const reason = text(raw, 'failureReason', 'failure_reason', 'reason', 'error', 'message')
      ?? text(nested, 'failureReason', 'failure_reason', 'reason', 'error', 'message')
      ?? text(record(raw.error), 'message', 'reason')
      ?? text(record(nested.error), 'message', 'reason');
    const retryOf = text(raw, 'retryOfAgentId', 'retry_of_agent_id', 'retryOf', 'retry_of')
      ?? text(nested, 'retryOfAgentId', 'retry_of_agent_id', 'retryOf', 'retry_of');
    const continuationOf = text(raw, 'continuationOfAgentId', 'continuation_of_agent_id', 'continuedFromAgentId', 'continued_from_agent_id')
      ?? text(nested, 'continuationOfAgentId', 'continuation_of_agent_id', 'continuedFromAgentId', 'continued_from_agent_id');
    const evidence = [
      ...stringList(raw.evidence), ...stringList(raw.artifacts), ...stringList(raw.producedEvidence),
      ...stringList(nested.evidence), ...stringList(nested.artifacts), ...stringList(nested.producedEvidence),
    ];

    const lane: AgentLane = existing ?? {
      id: agentId,
      parentId,
      name: name ?? (parentId ? 'Subagent' : 'Parent agent'),
      role: role ?? (parentId ? 'Worker' : 'Orchestrator'),
      status: 'running',
      startedAt: observedAt,
      finishedAt: null,
      tools: [],
      eventCount: 0,
      failureReason: null,
      evidence: [],
      retryOf: null,
      continuationOf: null,
      sequence: payload.sequence ?? event.id,
    };
    lane.parentId = lane.parentId ?? parentId;
    lane.name = name ?? lane.name;
    lane.role = role ?? lane.role;
    lane.eventCount += 1;
    if (tool && !lane.tools.includes(tool)) lane.tools.push(tool);
    for (const item of evidence) if (!lane.evidence.includes(item)) lane.evidence.push(item);
    lane.retryOf = retryOf ?? lane.retryOf;
    lane.continuationOf = continuationOf ?? lane.continuationOf;
    if (kind === 'agent_failed') {
      lane.status = 'failed';
      lane.finishedAt = observedAt;
      lane.failureReason = reason ?? lane.failureReason ?? 'Agent failed without a recorded reason.';
    } else if (kind === 'agent_completed') {
      lane.status = 'completed';
      lane.finishedAt = observedAt;
    }
    lanes.set(agentId, lane);
  }
  return [...lanes.values()].sort((a, b) => a.sequence - b.sequence);
}

function roman(index: number): string {
  const values: Array<[number, string]> = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let value = index + 1;
  let result = '';
  for (const [amount, numeral] of values) while (value >= amount) { result += numeral; value -= amount; }
  return result;
}

function elapsed(lane: AgentLane, now: number): string {
  const start = Date.parse(lane.startedAt);
  const end = lane.finishedAt ? Date.parse(lane.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Unknown';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const statusPresentation: Record<AgentStatus, { label: string; icon: typeof Check; className: string }> = {
  running: { label: 'Running', icon: Loader2, className: 'text-accent' },
  completed: { label: 'Completed', icon: Check, className: 'text-success' },
  failed: { label: 'Failed', icon: AlertTriangle, className: 'text-error' },
};

export default function OrchestrationTree({ events }: { events: WalEvent[] }) {
  const lanes = useMemo(() => projectOrchestrationTree(events), [events]);
  const durableEvents = useMemo(() => durableOrchestrationEntries(events), [events]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const hasRunningLane = lanes.some((lane) => lane.status === 'running');
  useEffect(() => {
    if (!hasRunningLane) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningLane]);
  const rootIds = useMemo(() => new Set(lanes.map((lane) => lane.id)), [lanes]);
  const childLanes = lanes.filter((lane) => lane.parentId && rootIds.has(lane.parentId));
  const labels = new Map(childLanes.map((lane, index) => [lane.id, roman(index)]));

  if (lanes.length === 0) {
    return (
      <div data-testid="orchestration-empty" className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-4 text-center text-muted">
        <GitBranch size={30} aria-hidden="true" className="opacity-40" />
        <p className="text-sm font-medium text-[var(--text)]">No agent activity recorded</p>
        <p className="max-w-sm text-xs">The agent tree appears when a run emits durable parent or subagent orchestration events.</p>
      </div>
    );
  }

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section aria-labelledby="orchestration-heading" className="h-full min-w-0 overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-5">
      <div className="mb-4 min-w-0">
        <h2 id="orchestration-heading" className="text-sm font-semibold text-[var(--text)]">Agent tree</h2>
        <p className="mt-1 text-xs text-muted">Parent and subagent lanes reconstructed from {durableEvents.length} stored orchestration events</p>
        <div data-testid="orchestration-replay-receipt" className="mt-2 rounded-md border border-border bg-panel px-3 py-2 text-xs text-muted">
          <span className="font-medium text-[var(--text)]">Durable replay receipt</span>
          <span className="ml-2">
            Sequence {durableEvents[0].payload.sequence ?? durableEvents[0].event.id}
            {'–'}{durableEvents.at(-1)!.payload.sequence ?? durableEvents.at(-1)!.event.id}
          </span>
          <span className="mt-1 block">Live updates and refresh reconstruct from the same AAV-007 WAL stream.</span>
        </div>
      </div>
      <div role="tree" aria-label="Agent orchestration lanes" className="flex min-w-0 flex-col gap-2">
        {lanes.map((lane, index) => {
          const presentation = statusPresentation[lane.status];
          const StatusIcon = presentation.icon;
          const isExpanded = expanded.has(lane.id);
          const laneLabel = labels.get(lane.id);
          const parent = lane.parentId ? lanes.find((candidate) => candidate.id === lane.parentId) : null;
          const level = parent ? 2 : 1;
          return (
            <div key={lane.id} role="none" className={`min-w-0 ${level === 2 ? 'ml-3 border-l border-border pl-3 sm:ml-6' : ''}`}>
              <button
                ref={(element) => { buttons.current[index] = element; }}
                type="button"
                role="treeitem"
                aria-level={level}
                aria-expanded={isExpanded}
                aria-label={`${laneLabel ? `Lane ${laneLabel}, ` : ''}${lane.role} ${lane.name}, ${presentation.label}`}
                onClick={() => toggle(lane.id)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowDown') next = Math.min(lanes.length - 1, index + 1);
                  else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = lanes.length - 1;
                  else return;
                  event.preventDefault();
                  buttons.current[next]?.focus();
                }}
                className="w-full min-w-0 rounded-lg border border-border bg-panel px-3 py-3 text-left transition-colors hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {laneLabel && <span aria-hidden="true" className="shrink-0 font-mono text-sm font-bold text-accent">{laneLabel}</span>}
                  <span className="min-w-0 break-words text-sm font-medium text-[var(--text)]">{lane.role} · {lane.name}</span>
                  <span className={`ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium ${presentation.className}`}>
                    <StatusIcon size={12} aria-hidden="true" className={lane.status === 'running' ? 'animate-spin' : ''} />
                    {presentation.label}
                  </span>
                </span>
                <span className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
                  <span className="min-w-0 break-all font-mono" title={lane.id}>ID {lane.id}</span>
                  <span className="inline-flex items-center gap-1"><Clock size={11} aria-hidden="true" />{elapsed(lane, now)}</span>
                  <span>{lane.eventCount} event{lane.eventCount === 1 ? '' : 's'}</span>
                </span>
                {parent && <span className="mt-1 block break-all text-[11px] text-muted">Child of {parent.name} ({parent.id})</span>}
                {lane.failureReason && <span className="mt-2 block break-words rounded bg-error/10 px-2 py-1 text-xs text-error">Failure: {lane.failureReason}</span>}
                {(lane.retryOf || lane.continuationOf) && (
                  <span className="mt-2 block break-all text-xs text-[var(--text)]">
                    {lane.retryOf && <>Retry of {lane.retryOf}</>}
                    {lane.retryOf && lane.continuationOf && ' · '}
                    {lane.continuationOf && <>Continues {lane.continuationOf}</>}
                  </span>
                )}
              </button>
              {isExpanded && (
                <div className="mx-2 min-w-0 rounded-b-lg border-x border-b border-border bg-bg px-3 py-2 text-xs">
                  <div className="flex min-w-0 items-start gap-2 text-muted">
                    <Wrench size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span className="break-words">Tools: {lane.tools.length ? lane.tools.join(', ') : 'No tool activity recorded'}</span>
                  </div>
                  <div className="mt-2 flex min-w-0 items-start gap-2 text-muted">
                    <Cpu size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span className="break-words">Evidence: {lane.evidence.length ? lane.evidence.join(', ') : 'No produced evidence recorded'}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
