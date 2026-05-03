/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Pencil,
  Terminal as TerminalIcon,
  Brain,
  GitCommitHorizontal,
  MessageSquare,
} from 'lucide-react';
import { BASE_URL } from '../lib/apiFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

type ActionType = 'Read' | 'Write' | 'Executing' | 'Planning' | 'Committing' | 'Task' | 'Output';

interface LogEntry {
  text: string;
  timestamp: number;
}

interface ActionGroup {
  type: ActionType;
  entries: LogEntry[];
  collapsed: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ACTION_CONFIG: Record<ActionType, { icon: typeof FileText; label: string; color: string }> = {
  Read:       { icon: FileText,            label: 'Read',       color: 'text-blue-400' },
  Write:      { icon: Pencil,              label: 'Write',      color: 'text-emerald-400' },
  Executing:  { icon: TerminalIcon,        label: 'Executing',  color: 'text-amber-400' },
  Planning:   { icon: Brain,               label: 'Planning',   color: 'text-purple-400' },
  Committing: { icon: GitCommitHorizontal, label: 'Committing', color: 'text-cyan-400' },
  Task:       { icon: MessageSquare,       label: 'Task',       color: 'text-orange-400' },
  Output:     { icon: TerminalIcon,        label: 'Output',     color: 'text-gray-400' },
};

// Patterns to detect action types from terminal output.
// Claude --print and opencode both emit tool-use markers in their output.
const ACTION_PATTERNS: [RegExp, ActionType][] = [
  [/^Read\b/i,                    'Read'],
  [/^\[Read\]/i,                  'Read'],
  [/^Reading\b/i,                 'Read'],
  [/^Write\b/i,                   'Write'],
  [/^\[Write\]/i,                 'Write'],
  [/^Writing\b/i,                 'Write'],
  [/^Edit\b/i,                    'Write'],
  [/^\[Edit\]/i,                  'Write'],
  [/^Bash\b/i,                    'Executing'],
  [/^\[Bash\]/i,                  'Executing'],
  [/^\[Executing\]/i,             'Executing'],
  [/^Executing\b/i,               'Executing'],
  [/^Planning\b/i,                'Planning'],
  [/^\[Planning\]/i,              'Planning'],
  [/^Thinking\b/i,                'Planning'],
  [/^Committing\b/i,              'Committing'],
  [/^\[Commit\]/i,                'Committing'],
  [/^Commit\b/i,                  'Committing'],
  [/^Task\b/i,                    'Task'],
  [/^\[Task\]/i,                  'Task'],
];

/** Strip ANSI escape codes from a string */
function stripAnsi(str: string): string {
   
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Classify a line of terminal output into an action type */
function classifyLine(line: string): ActionType {
  const cleaned = stripAnsi(line).trimStart();
  if (!cleaned) return 'Output';
  for (const [pattern, type] of ACTION_PATTERNS) {
    if (pattern.test(cleaned)) return type;
  }
  return 'Output';
}

// ─── Component ──────────────────────────────────────────────────────────────

interface SemanticLogViewProps {
  runId: number;
}

export default function SemanticLogView({ runId }: SemanticLogViewProps) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsedSet, setCollapsedSet] = useState<Set<number>>(new Set());

  // Connect to the same SSE stream as RunTerminal
  useEffect(() => {
    const es = new EventSource(`${BASE_URL}/api/pipeline/runs/${runId}/output`);
    esRef.current = es;

    let lineBuffer = '';

    es.addEventListener('chunk', (e: MessageEvent) => {
      try {
        const binary = atob(e.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const text = new TextDecoder().decode(bytes);

        lineBuffer += text;
        const parts = lineBuffer.split('\n');
        // Keep the last incomplete line in the buffer
        lineBuffer = parts.pop() || '';

        if (parts.length > 0) {
          const now = Date.now();
          const newEntries = parts
            .filter((l) => l.trim().length > 0)
            .map((l) => ({ text: l, timestamp: now }));

          if (newEntries.length > 0) {
            setLines((prev) => [...prev, ...newEntries]);
          }
        }
      } catch {
        // ignore malformed chunk
      }
    });

    es.addEventListener('done', () => es.close());
    es.onerror = () => es.close();

    return () => {
      es.close();
    };
  }, [runId]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, autoScroll]);

  // Detect if user scrolled away from bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  // Group consecutive lines with the same action type
  const groups: ActionGroup[] = useMemo(() => {
    const result: ActionGroup[] = [];
    for (const entry of lines) {
      const type = classifyLine(entry.text);
      const lastGroup = result[result.length - 1];
      if (lastGroup && lastGroup.type === type) {
        lastGroup.entries.push(entry);
      } else {
        result.push({
          type,
          entries: [entry],
          collapsed: collapsedSet.has(result.length),
        });
      }
    }
    // Apply collapsed state
    return result.map((g, i) => ({ ...g, collapsed: collapsedSet.has(i) }));
  }, [lines, collapsedSet]);

  const toggleGroup = useCallback((index: number) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // Summary counts for header
  const typeCounts = useMemo(() => {
    const counts: Partial<Record<ActionType, number>> = {};
    for (const g of groups) {
      counts[g.type] = (counts[g.type] || 0) + g.entries.length;
    }
    return counts;
  }, [groups]);

  return (
    <div className="h-full flex flex-col">
      {/* Summary bar */}
      <div className="shrink-0 px-3 py-1.5 border-b border-border bg-panel flex items-center gap-3 flex-wrap">
        {(Object.entries(typeCounts) as [ActionType, number][])
          .filter(([type]) => type !== 'Output')
          .map(([type, count]) => {
            const config = ACTION_CONFIG[type];
            const Icon = config.icon;
            return (
              <span key={type} className={`inline-flex items-center gap-1 text-[10px] font-medium ${config.color}`}>
                <Icon size={11} />
                {count}
              </span>
            );
          })}
        {lines.length === 0 && (
          <span className="text-[10px] text-muted">Waiting for output...</span>
        )}
      </div>

      {/* Grouped log entries */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={{ background: 'var(--bg)' }}
      >
        {groups.map((group, groupIndex) => {
          const config = ACTION_CONFIG[group.type];
          const Icon = config.icon;
          const isCollapsed = group.collapsed;

          return (
            <div key={groupIndex} className="border-b border-border/50">
              {/* Group header */}
              <button
                onClick={() => toggleGroup(groupIndex)}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-panel/50 transition-colors text-left"
              >
                {isCollapsed ? (
                  <ChevronRight size={12} className="text-muted shrink-0" />
                ) : (
                  <ChevronDown size={12} className="text-muted shrink-0" />
                )}
                <Icon size={13} className={`shrink-0 ${config.color}`} />
                <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
                <span className="ml-auto text-[10px] text-muted font-mono">
                  {group.entries.length} line{group.entries.length !== 1 ? 's' : ''}
                </span>
              </button>

              {/* Group entries */}
              {!isCollapsed && (
                <div className="px-3 pb-1.5">
                  {group.entries.map((entry, entryIndex) => (
                    <pre
                      key={entryIndex}
                      className="text-[11px] leading-[1.4] font-mono text-[var(--text)] whitespace-pre-wrap break-all pl-6"
                    >
                      {stripAnsi(entry.text)}
                    </pre>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
