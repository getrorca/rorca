import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import path from 'node:path';
import fs from 'node:fs';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import { execSync } from 'node:child_process';
import { query } from '../db/index';
import type { SemanticStep } from '../lib/semantic-log-parser';
import CommandPalette, { type ForgeCommand } from './CommandPalette';
import useOrchestrationState, { type OrchestrationPhase } from './useOrchestrationState';
import {
  formatClock,
  formatRawOutputLine,
  formatSemanticStepLine,
  formatWalLifecycleLine,
  isStructuredAgentLine,
  parseWalPayload,
  type FormattedLine,
  type PipelineWalEvent,
  type WalPayload,
} from './runFormatting';

const MAX_OUTPUT_LINES = 500;
const CONTEXT_WIDTH = 35;

interface OutputEntry extends FormattedLine {
  key: string;
}

interface WorkspaceMatch {
  id: string;
  label: string;
  path: string;
}

interface TriggerResponse {
  ok?: boolean;
  queued?: boolean;
  runId?: number;
  queuePosition?: number;
  error?: string;
}

interface RunDetailsResponse {
  run: {
    id: number;
    status: string;
    started_at?: string | null;
    finished_at?: string | null;
  };
  stories: Array<{ story_id: string; status: string }>;
  specStories?: Array<{ id: string; title: string }>;
  tokenSummary?: {
    inputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
  };
}

interface ForegroundRunState {
  runId: number;
  specSlug: string;
  queuePosition: number | null;
  currentStory: number;
  totalStories: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  excludedCount: number;
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeCost: number;
  directionSummary: string | null;
  confirmCancel: boolean;
}

const WAL_STREAM_URL = 'http://localhost:3030/api/pipeline/stream';

function safeBranchName(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;]*m/g, '');
}

function pushRingBuffer(lines: OutputEntry[], next: OutputEntry[]): OutputEntry[] {
  const merged = [...lines, ...next];
  return merged.length > MAX_OUTPUT_LINES ? merged.slice(merged.length - MAX_OUTPUT_LINES) : merged;
}

function phaseColor(phase: OrchestrationPhase): 'gray' | 'yellow' | 'green' | 'red' {
  switch (phase) {
    case 'FORGING':
    case 'RETRYING':
      return 'yellow';
    case 'COMPLETE':
      return 'green';
    case 'FAILED':
      return 'red';
    case 'IDLE':
    default:
      return 'gray';
  }
}

function parseSseEvent(rawEvent: string): { event: string | null; data: string } | null {
  const lines = rawEvent.split(/\r?\n/);
  let eventName: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!eventName && dataLines.length === 0) {
    return null;
  }

  return { event: eventName, data: dataLines.join('\n') };
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  if (mins === 0) {
    return `${secs}s`;
  }
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

function specPathFromSlug(specSlug: string): string {
  return `forge/specs/approved/${specSlug}.json`;
}

function summarizeDirection(payload: WalPayload): string | null {
  const contextFiles = Array.isArray(payload.context_files)
    ? payload.context_files.filter((value): value is string => typeof value === 'string')
    : [];

  if (contextFiles.length === 0) {
    return null;
  }

  return contextFiles
    .map((file) => file.split('/').pop() ?? file)
    .slice(0, 3)
    .join(', ');
}

async function httpJson<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const target = new URL(url);
    const body = init?.body != null ? JSON.stringify(init.body) : null;
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const parsed = raw ? JSON.parse(raw) as T & { error?: string } : {} as T;
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error((parsed as { error?: string }).error ?? `HTTP ${res.statusCode ?? 500}`));
            return;
          }
          resolve(parsed);
        });
      },
    );

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function resolveWorkspaceForCwd(): Promise<WorkspaceMatch | null> {
  const rows = await query<WorkspaceMatch>('SELECT id, label, path FROM workspaces');
  const cwd = fs.realpathSync.native(process.cwd());

  const matches = rows
    .map((row) => ({ ...row, path: fs.existsSync(row.path) ? fs.realpathSync.native(row.path) : row.path }))
    .filter((row) => cwd === row.path || cwd.startsWith(`${row.path}${path.sep}`))
    .sort((a, b) => b.path.length - a.path.length);

  return matches[0] ?? null;
}

function summarizeRun(stories: RunDetailsResponse['stories']): {
  passed: number;
  failed: number;
  skipped: number;
  excluded: number;
} {
  const latest = new Map<string, string>();
  for (const story of stories) {
    latest.set(story.story_id, story.status);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let excluded = 0;

  for (const status of latest.values()) {
    if (status === 'pass') passed += 1;
    else if (status === 'fail') failed += 1;
    else if (status === 'skip') skipped += 1;
    else if (status === 'excluded') excluded += 1;
  }

  return { passed, failed, skipped, excluded };
}

export function Forge(): JSX.Element {
  const { stdout } = useStdout();
  const [now, setNow] = useState(() => new Date());
  const [branchName] = useState(() => safeBranchName());
  const [outputLines, setOutputLines] = useState<OutputEntry[]>([]);
  const [foregroundRun, setForegroundRun] = useState<ForegroundRunState | null>(null);
  const [phaseOverride, setPhaseOverride] = useState<OrchestrationPhase | null>(null);
  const { orchestrationState, backendStatus, backendMessage } = useOrchestrationState();

  const keyCounterRef = useRef(0);
  const walRequestRef = useRef<ClientRequest | null>(null);
  const walResponseRef = useRef<IncomingMessage | null>(null);
  const outputRequestRef = useRef<ClientRequest | null>(null);
  const outputResponseRef = useRef<IncomingMessage | null>(null);
  const outputPartialRef = useRef('');
  const activeRunIdRef = useRef<number | null>(null);
  const isUnmountedRef = useRef(false);

  const workspaceName = useMemo(() => path.basename(process.cwd()) || 'workspace', []);
  const stdoutWidth = stdout?.columns ?? 80;
  const stdoutHeight = stdout?.rows ?? 24;
  const leftColumnWidth = Math.max(20, stdoutWidth - CONTEXT_WIDTH - 4);
  const mainHeight = Math.max(5, stdoutHeight - 7);
  const visibleOutput = outputLines.length === 0 ? [{ key: 'empty', text: '(no output yet)' }] : outputLines.slice(-mainHeight);

  const appendOutput = (...entries: FormattedLine[]): void => {
    if (entries.length === 0) {
      return;
    }

    setOutputLines((current) =>
      pushRingBuffer(
        current,
        entries.map((entry) => ({
          ...entry,
          text: stripAnsi(entry.text),
          key: `line-${keyCounterRef.current++}`,
        })),
      ),
    );
  };

  const closeRunStreams = (): void => {
    walRequestRef.current?.destroy();
    walResponseRef.current?.destroy();
    outputRequestRef.current?.destroy();
    outputResponseRef.current?.destroy();
    walRequestRef.current = null;
    walResponseRef.current = null;
    outputRequestRef.current = null;
    outputResponseRef.current = null;
    outputPartialRef.current = '';
  };

  const syncRunMetadata = async (runId: number): Promise<void> => {
    try {
      const details = await httpJson<RunDetailsResponse>(`http://localhost:3030/api/pipeline/runs/${runId}`);
      if (activeRunIdRef.current !== runId || isUnmountedRef.current) {
        return;
      }

      const summary = summarizeRun(details.stories);
      setForegroundRun((current) => {
        if (!current || current.runId !== runId) {
          return current;
        }

        return {
          ...current,
          totalStories: details.specStories?.length ?? current.totalStories,
          passedCount: summary.passed,
          failedCount: summary.failed,
          skippedCount: summary.skipped,
          excludedCount: summary.excluded,
          cumulativeInput: details.tokenSummary?.inputTokens ?? current.cumulativeInput,
          cumulativeOutput: details.tokenSummary?.outputTokens ?? current.cumulativeOutput,
          cumulativeCost: details.tokenSummary?.totalCostUsd ?? current.cumulativeCost,
        };
      });
    } catch {
      // Best-effort only.
    }
  };

  const printRunSummary = async (runId: number, status: string): Promise<void> => {
    try {
      const details = await httpJson<RunDetailsResponse>(`http://localhost:3030/api/pipeline/runs/${runId}`);
      const summary = summarizeRun(details.stories);
      const startedAt = details.run.started_at ? Date.parse(details.run.started_at) : NaN;
      const finishedAt = details.run.finished_at ? Date.parse(details.run.finished_at) : Date.now();
      const elapsedSeconds = Number.isNaN(startedAt) ? 0 : Math.max(0, Math.round((finishedAt - startedAt) / 1000));
      const totalStories = details.specStories?.length ?? (summary.passed + summary.failed + summary.skipped + summary.excluded);
      const timestamp = `[${formatClock(new Date())}]`;

      appendOutput(
        { text: `${timestamp} ${status === 'done' ? '■ COMPLETE' : status === 'cancelled' ? '■ CANCELLED' : '■ FAILED'} run #${runId}`, color: status === 'done' ? 'green' : status === 'cancelled' ? 'yellow' : 'red' },
        { text: `           stories ${totalStories} total  ${summary.passed} passed  ${summary.failed} failed  ${summary.skipped} skipped  ${summary.excluded} excluded`, color: 'white' },
        { text: `           elapsed ${formatDuration(elapsedSeconds)}`, color: 'white' },
        { text: `           cost    $${(details.tokenSummary?.totalCostUsd ?? 0).toFixed(2)}`, color: 'white' },
      );
    } catch (error) {
      appendOutput({
        text: `[${formatClock(new Date())}] summary unavailable for run #${runId}: ${(error as Error).message}`,
        color: 'red',
      });
    }
  };

  const finishForegroundRun = async (runId: number, status: string): Promise<void> => {
    if (activeRunIdRef.current !== runId) {
      return;
    }

    closeRunStreams();
    activeRunIdRef.current = null;
    setForegroundRun(null);
    setPhaseOverride(status === 'done' ? 'COMPLETE' : 'FAILED');
    await printRunSummary(runId, status);
  };

  const handleWalEvent = async (event: PipelineWalEvent): Promise<void> => {
    const payload = parseWalPayload(event.payload);
    const runId = typeof payload.run_id === 'number'
      ? payload.run_id
      : typeof payload.run_id === 'string'
        ? parseInt(payload.run_id, 10)
        : null;

    if (runId == null || runId !== activeRunIdRef.current) {
      return;
    }

    const formatted = formatWalLifecycleLine(event, payload, new Date());
    if (formatted) {
      appendOutput(formatted);
    }

    if (event.event_type === 'story_started') {
      setForegroundRun((current) => (
        current && current.runId === runId
          ? {
              ...current,
              currentStory: current.totalStories > 0
                ? Math.min(current.totalStories, current.currentStory + 1)
                : current.currentStory + 1,
              directionSummary: summarizeDirection(payload) ?? current.directionSummary,
            }
          : current
      ));
      return;
    }

    if (event.event_type === 'story_token_update') {
      setForegroundRun((current) => (
        current && current.runId === runId
          ? {
              ...current,
              cumulativeInput: typeof payload.cumulative_input === 'number' ? payload.cumulative_input : current.cumulativeInput,
              cumulativeOutput: typeof payload.cumulative_output === 'number' ? payload.cumulative_output : current.cumulativeOutput,
              cumulativeCost: typeof payload.cumulative_cost_usd === 'number' ? payload.cumulative_cost_usd : current.cumulativeCost,
            }
          : current
      ));
      return;
    }

    if (event.event_type === 'story_passed' || event.event_type === 'story_failed' || event.event_type === 'story_skipped') {
      void syncRunMetadata(runId);
      return;
    }

    if (event.event_type === 'run_cancelled') {
      appendOutput({ text: `[${formatClock(new Date())}] cancel delivered for run #${runId}`, color: 'yellow' });
      await finishForegroundRun(runId, 'cancelled');
      return;
    }

    if (event.event_type === 'run_finished') {
      const status = typeof payload.status === 'string' ? payload.status : 'failed';
      await finishForegroundRun(runId, status);
    }
  };

  const connectWalStream = (runId: number): void => {
    const req = http.get(WAL_STREAM_URL, (res) => {
      walResponseRef.current = res;
      let buffer = '';

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;

        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseEvent(rawEvent);
          if (parsed?.event === 'wal_event' && parsed.data) {
            try {
              void handleWalEvent(JSON.parse(parsed.data) as PipelineWalEvent);
            } catch {
              // Ignore malformed events; keep the stream alive.
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      });
    });

    walRequestRef.current = req;
  };

  const connectOutputStream = (runId: number): void => {
    const req = http.get(`http://localhost:3030/api/pipeline/runs/${runId}/output`, (res) => {
      outputResponseRef.current = res;
      let buffer = '';

      const flushRawChunk = (chunkText: string): void => {
        outputPartialRef.current += chunkText;
        const segments = outputPartialRef.current.split(/\r?\n/);
        outputPartialRef.current = segments.pop() ?? '';

        for (const segment of segments) {
          const trimmed = stripAnsi(segment);
          if (!trimmed.trim() || isStructuredAgentLine(trimmed)) {
            continue;
          }
          appendOutput(formatRawOutputLine(trimmed));
        }
      };

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;

        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseEvent(rawEvent);

          if (parsed?.event === 'chunk' && parsed.data) {
            flushRawChunk(Buffer.from(parsed.data, 'base64').toString('utf8'));
          } else if (parsed?.event === 'semantic_step' && parsed.data) {
            try {
              appendOutput(formatSemanticStepLine(JSON.parse(parsed.data) as SemanticStep));
            } catch {
              // Ignore malformed semantic steps.
            }
          } else if (parsed?.event === 'done' && outputPartialRef.current.trim()) {
            appendOutput(formatRawOutputLine(outputPartialRef.current.trim()));
            outputPartialRef.current = '';
          }

          boundary = buffer.indexOf('\n\n');
        }
      });
    });

    outputRequestRef.current = req;
  };

  const runSpec = async (specSlug: string): Promise<void> => {
    if (foregroundRun) {
      appendOutput({ text: `[${formatClock(new Date())}] run already in progress`, color: 'yellow' });
      return;
    }

    const normalizedSlug = specSlug.trim();
    if (!normalizedSlug) {
      appendOutput({ text: `[${formatClock(new Date())}] usage: run <spec-slug>`, color: 'red' });
      return;
    }

    appendOutput({ text: `> run ${normalizedSlug}`, color: 'cyan' });

    try {
      const workspace = await resolveWorkspaceForCwd();
      if (!workspace) {
        throw new Error(`No registered workspace matches ${process.cwd()}`);
      }

      const trigger = await httpJson<TriggerResponse>('http://localhost:3030/api/pipeline/trigger', {
        method: 'POST',
        body: {
          workspaceId: workspace.id,
          specPath: specPathFromSlug(normalizedSlug),
        },
      });

      if (!trigger.runId) {
        throw new Error(trigger.error ?? 'Pipeline trigger did not return a run ID');
      }

      activeRunIdRef.current = trigger.runId;
      setPhaseOverride('FORGING');
      setForegroundRun({
        runId: trigger.runId,
        specSlug: normalizedSlug,
        queuePosition: trigger.queuePosition ?? null,
        currentStory: 0,
        totalStories: 0,
        passedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        excludedCount: 0,
        cumulativeInput: 0,
        cumulativeOutput: 0,
        cumulativeCost: 0,
        directionSummary: null,
        confirmCancel: false,
      });

      appendOutput({
        text: `⟳ Queued run #${trigger.runId}${trigger.queuePosition ? ` (position ${trigger.queuePosition})` : ''}`,
        color: 'yellow',
      });

      closeRunStreams();
      connectWalStream(trigger.runId);
      connectOutputStream(trigger.runId);
      void syncRunMetadata(trigger.runId);
    } catch (error) {
      activeRunIdRef.current = null;
      setForegroundRun(null);
      setPhaseOverride('FAILED');
      appendOutput({
        text: `[${formatClock(new Date())}] run failed to start: ${(error as Error).message}`,
        color: 'red',
      });
    }
  };

  const requestCancel = (): boolean => {
    if (!foregroundRun) {
      return false;
    }

    if (!foregroundRun.confirmCancel) {
      setForegroundRun((current) => (current ? { ...current, confirmCancel: true } : current));
      appendOutput({
        text: `[${formatClock(new Date())}] confirm cancel run #${foregroundRun.runId} — press Ctrl+C again to send cancel`,
        color: 'yellow',
      });
      return true;
    }

    void (async () => {
      try {
        await httpJson(`http://localhost:3030/api/pipeline/runs/${foregroundRun.runId}/cancel`, { method: 'POST' });
        setForegroundRun((current) => (current ? { ...current, confirmCancel: false } : current));
        appendOutput({
          text: `[${formatClock(new Date())}] cancel requested for run #${foregroundRun.runId}`,
          color: 'yellow',
        });
      } catch (error) {
        appendOutput({
          text: `[${formatClock(new Date())}] cancel failed: ${(error as Error).message}`,
          color: 'red',
        });
      }
    })();

    return true;
  };

  const commands = useMemo<ForgeCommand[]>(
    () => [
      {
        id: 'run',
        label: 'run',
        description: 'Run an approved spec',
        args: ['<spec-slug>'],
        handler: (args) => {
          void runSpec(args.join(' ').trim());
        },
      },
      {
        id: 'forge',
        label: 'forge',
        description: 'Generate a spec from a brief',
        args: ['<brief>'],
        handler: (args) => {
          appendOutput(
            { text: `> forge ${args.join(' ')}`.trimEnd(), color: 'cyan' },
            { text: `[forge] placeholder forge handler for "${args.join(' ')}"` },
          );
        },
      },
      {
        id: 'board',
        label: 'board',
        description: 'Open the board view',
        handler: () => {
          appendOutput({ text: '> board', color: 'cyan' }, { text: '[forge] board view is not wired yet' });
        },
      },
      {
        id: 'status',
        label: 'status',
        description: 'Show pipeline status',
        handler: () => {
          appendOutput(
            { text: '> status', color: 'cyan' },
            { text: `[forge] phase=${phaseOverride ?? orchestrationState.phase} agent=${orchestrationState.activeAgent} branch=${branchName} backend=${backendStatus}` },
          );
        },
      },
      {
        id: 'recall',
        label: 'recall',
        description: 'Search memory',
        args: ['<query>'],
        handler: (args) => appendOutput({ text: `> recall ${args.join(' ')}`.trimEnd(), color: 'cyan' }, { text: `[forge] recall placeholder for "${args.join(' ')}"` }),
      },
      {
        id: 'approve',
        label: 'approve',
        description: 'Approve a pending spec',
        args: ['<spec-slug>'],
        handler: (args) => appendOutput({ text: `> approve ${args.join(' ')}`.trimEnd(), color: 'cyan' }, { text: `[forge] approve placeholder for "${args.join(' ')}"` }),
      },
      {
        id: 'models',
        label: 'models',
        description: 'List available models',
        handler: () => appendOutput({ text: '> models', color: 'cyan' }, { text: '[forge] model picker not wired yet' }),
      },
      {
        id: 'agent',
        label: 'agent',
        description: 'Switch execution agent',
        args: ['<type>'],
        handler: (args) => appendOutput({ text: `> agent ${args.join(' ')}`.trimEnd(), color: 'cyan' }, { text: `[forge] agent placeholder for "${args.join(' ')}"` }),
      },
      {
        id: 'attach',
        label: 'attach',
        description: 'Attach to an active run',
        args: ['<runId>'],
        handler: (args) => appendOutput({ text: `> attach ${args.join(' ')}`.trimEnd(), color: 'cyan' }, { text: `[forge] attach placeholder for run "${args.join(' ')}"` }),
      },
      {
        id: 'chat',
        label: 'chat',
        description: 'Open chat mode',
        handler: () => appendOutput({ text: '> chat', color: 'cyan' }, { text: '[forge] chat mode not wired yet' }),
      },
      {
        id: 'doctor',
        label: 'doctor',
        description: 'Run diagnostics',
        handler: () => appendOutput({ text: '> doctor', color: 'cyan' }, { text: '[forge] doctor placeholder: all checks mocked' }),
      },
      {
        id: 'auth-login',
        label: 'auth login',
        description: 'Authenticate with a provider',
        args: ['[<provider>]'],
        handler: (args) => appendOutput({ text: `> auth login ${args.join(' ')}`.trimEnd(), color: 'cyan' }, { text: `[forge] auth login placeholder${args[0] ? ` for "${args[0]}"` : ''}` }),
      },
      {
        id: 'auth-status',
        label: 'auth status',
        description: 'Show auth state',
        handler: () => appendOutput({ text: '> auth status', color: 'cyan' }, { text: '[forge] auth status placeholder: unauthenticated' }),
      },
      {
        id: 'quit',
        label: 'quit',
        description: 'Exit forge',
        handler: () => process.exit(0),
      },
      {
        id: 'q',
        label: 'q',
        description: 'Exit forge',
        handler: () => process.exit(0),
      },
    ],
    [backendStatus, branchName, foregroundRun, orchestrationState.activeAgent, orchestrationState.phase, phaseOverride],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => () => {
    isUnmountedRef.current = true;
    closeRunStreams();
  }, []);

  const effectivePhase = phaseOverride ?? orchestrationState.phase;
  const displayedStoryProgress = foregroundRun
    ? `${foregroundRun.currentStory}/${foregroundRun.totalStories}`
    : `${orchestrationState.currentStory}/${orchestrationState.totalStories}`;
  const disabledMessage = foregroundRun
    ? foregroundRun.confirmCancel
      ? `Cancel run #${foregroundRun.runId}? Press Ctrl+C again to confirm, Esc to resume.`
      : 'Run in progress... Press Ctrl+C to cancel.'
    : undefined;

  return (
    <Box flexDirection="column" width={stdoutWidth} height={stdoutHeight}>
      <Box borderStyle="single" paddingX={1} height={3}>
        <Text wrap="truncate-end">
          [RORCA FORGE] workspace:{workspaceName} agent:{orchestrationState.activeAgent} branch:{branchName} {formatClock(now)}
          {orchestrationState.backgroundRunsCount > 0 ? ` bg:${orchestrationState.backgroundRunsCount}` : ''}
        </Text>
      </Box>

      <Box flexGrow={1}>
        <Box borderStyle="single" flexDirection="column" width={leftColumnWidth} paddingX={1}>
          {visibleOutput.map((line) => (
            <Text key={line.key} color={line.color} dimColor={line.dimColor}>
              {line.text}
            </Text>
          ))}
        </Box>

        <Box borderStyle="single" flexDirection="column" width={CONTEXT_WIDTH} paddingX={1}>
          <Text>STATE</Text>
          <Text>
            phase: <Text color={phaseColor(effectivePhase)}>{effectivePhase}</Text>
          </Text>
          {backendStatus === 'offline' ? <Text color="red">{backendMessage ?? 'Backend offline'}</Text> : null}
          <Text>stories: {displayedStoryProgress}</Text>
          <Text>spec: {foregroundRun?.specSlug ?? orchestrationState.specSlug ?? 'none'}</Text>
          <Text>agent: {orchestrationState.activeAgent}</Text>
          <Text>model: {orchestrationState.activeModel ?? 'default'}</Text>
          <Text>pi session: {orchestrationState.piSessionId ?? 'inactive'}</Text>
          <Text>tokens in: {foregroundRun?.cumulativeInput ?? orchestrationState.cumulativeTokens.input}</Text>
          <Text>tokens out: {foregroundRun?.cumulativeOutput ?? orchestrationState.cumulativeTokens.output}</Text>
          <Text>cost usd: ${(foregroundRun?.cumulativeCost ?? orchestrationState.cumulativeTokens.cost).toFixed(2)}</Text>
          <Text>direction: {foregroundRun?.directionSummary ?? orchestrationState.directionSummary ?? 'none'}</Text>
          <Text>background: {orchestrationState.backgroundRunsCount > 0 ? orchestrationState.backgroundRunsCount : 0}</Text>
        </Box>
      </Box>

      <Box borderStyle="single" flexDirection="column" paddingX={1} minHeight={3}>
        <CommandPalette
          commands={commands}
          disabled={Boolean(foregroundRun)}
          disabledMessage={disabledMessage}
          onCtrlC={requestCancel}
          onEscape={() => {
            if (foregroundRun?.confirmCancel) {
              setForegroundRun((current) => (current ? { ...current, confirmCancel: false } : current));
            }
          }}
          onUnknownCommand={(input) => appendOutput({ text: `> ${input}`, color: 'cyan' }, { text: `[forge] unknown command: ${input}` })}
        />
      </Box>
    </Box>
  );
}

export default Forge;
