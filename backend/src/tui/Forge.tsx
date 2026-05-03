import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import path from 'node:path';
import fs from 'node:fs';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import { execSync } from 'node:child_process';
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
import { apiJson, TuiApiError } from './apiClient';
import {
  buildBoardColumns,
  formatBoardMeta,
  moveBoardSelection,
  resolveBoardSelection,
  truncateSlug,
  type BoardColumn,
  type BoardSelection,
  type KanbanResponse,
  type KanbanSpec,
} from './boardUtils';
import {
  formatRecallHeader,
  getRecallCategoryColor,
  getRecallCategoryLabel,
  parseMemoryContent,
  RECALL_CATEGORIES,
  type RecallColor,
} from './recallFormatting';
import {
  buildAgentSwitchPayload,
  buildModelPickerLines,
  findSelectedModelIndex,
  flattenModels,
  formatActiveAgentLine,
  getPiInstallLines,
  getVisibleModelPickerLines,
  groupPiModels,
  moveModelSelection,
  type PiInstallMethods,
  type ProviderGroup,
} from './modelPicker';
import type { AgentType } from '../lib/config';
import type { PiModel } from '../lib/pi-detector';

const MAX_OUTPUT_LINES = 500;
const CONTEXT_WIDTH = 35;
const GENERATE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const GENERATE_SPINNER_MS = 80;
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;
const GENERATE_POLL_INTERVAL_MS = 2_000;
const STORY_TITLE_WIDTH = 46;

interface OutputEntry extends FormattedLine {
  key: string;
}

interface WorkspaceMatch {
  id: string;
  label: string;
  path: string;
}

interface WorkspaceListResponse {
  items?: WorkspaceMatch[];
  workspaces?: WorkspaceMatch[];
}

interface GeneratedStorySummary {
  id: string;
  title: string;
  complexity?: number;
}

interface GeneratedSpecActionState {
  workspace: WorkspaceMatch;
  brief: string;
  slug: string;
  stories: GeneratedStorySummary[];
}

interface GenerateSpecResponse {
  id?: string;
  slug?: string;
  userStories?: GeneratedStorySummary[];
  stories?: GeneratedStorySummary[];
  async?: boolean;
  jobId?: string;
  error?: string;
}

interface SpecGenerationJobResponse {
  jobId: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  slug?: string | null;
  error?: string | null;
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

interface BoardLine {
  text: string;
  color?: 'white' | 'gray' | 'yellow' | 'green' | 'cyan' | 'red';
  inverse?: boolean;
}

interface MemoryItemResponse {
  id: number;
  workspaceId: string;
  category: string;
  content: string;
  sourceStoryId: string | null;
  sourceRunId: number | null;
  confidence: string;
  relatedFiles: string[];
  pinned: boolean;
  sourceType: string;
  createdAt: string;
}

interface MemoryItemsResponse {
  items: MemoryItemResponse[];
  total: number;
  page: number;
  pageSize: number;
}

interface MemoryCreateResponse {
  entry: {
    date: string;
    category: string;
    title: string;
    rule: string;
    context: string;
    source: string;
  };
  total: number;
}

interface RecallEntry {
  id: string;
  date: string;
  category: string;
  title: string;
  body: string;
  source: string | null;
  color: RecallColor;
}

type RecallFormField = 'title' | 'body' | 'category';

interface RecallFormState {
  field: RecallFormField;
  title: string;
  body: string;
  categoryIndex: number;
  saving: boolean;
  error: string | null;
}

interface RecallState {
  workspace: WorkspaceMatch;
  query: string;
  loading: boolean;
  error: string | null;
  entries: RecallEntry[];
  form: RecallFormState | null;
}

interface ConfigResponse {
  agentType?: string;
  agentModel?: string | null;
}

interface PiModelsResponse {
  models?: PiModel[];
  count?: number;
  piBinPath?: string;
}

interface ModelPickerState {
  loading: boolean;
  switching: boolean;
  groups: ProviderGroup[];
  selectedIndex: number;
  activeAgent: string;
  activeModel: string | null;
  error: string | null;
  info: string | null;
  installMethods: PiInstallMethods | null;
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

function truncateText(input: string, width: number): string {
  if (input.length <= width) {
    return input;
  }

  return `${input.slice(0, Math.max(0, width - 1))}…`;
}

function formatRecallDate(date: string): string {
  const parsed = Date.parse(date);
  if (Number.isNaN(parsed)) {
    return date.slice(0, 10);
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function memoryItemToRecallEntry(item: MemoryItemResponse): RecallEntry {
  const parsed = parseMemoryContent(item.content);
  const source = item.sourceStoryId ?? (item.sourceRunId != null ? `run-${item.sourceRunId}` : null);

  return {
    id: `memory-${item.id}`,
    date: formatRecallDate(item.createdAt),
    category: item.category,
    title: parsed.title,
    body: parsed.body || item.content,
    source,
    color: getRecallCategoryColor(item.category),
  };
}

function buildCreatedRecallEntry(
  entry: MemoryCreateResponse['entry'],
  index: number,
): RecallEntry {
  return {
    id: `memory-new-${index}`,
    date: entry.date,
    category: entry.category,
    title: entry.title,
    body: entry.rule,
    source: entry.source || null,
    color: getRecallCategoryColor(entry.category),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGeneratedStories(payload: {
  userStories?: GeneratedStorySummary[];
  stories?: GeneratedStorySummary[];
}): GeneratedStorySummary[] {
  const stories = Array.isArray(payload.userStories)
    ? payload.userStories
    : Array.isArray(payload.stories)
      ? payload.stories
      : [];

  return stories.map((story) => ({
    id: story.id,
    title: story.title,
    complexity: story.complexity,
  }));
}

function formatStoryComplexity(complexity?: number): string {
  return Number.isInteger(complexity) ? `C${complexity}` : '—';
}

function formatStoryTableLine(story: GeneratedStorySummary): string {
  return `${story.id.padEnd(10, ' ')} ${truncateText(story.title, STORY_TITLE_WIDTH).padEnd(STORY_TITLE_WIDTH, ' ')} ${formatStoryComplexity(story.complexity)}`;
}

function getUserFriendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.replace(/\s+/g, ' ').trim();
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

async function resolveWorkspaceForCwd(): Promise<WorkspaceMatch | null> {
  const response = await apiJson<WorkspaceListResponse>('/api/workspaces');
  const rows = Array.isArray(response.items)
    ? response.items
    : Array.isArray(response.workspaces)
      ? response.workspaces
      : [];
  const cwd = fs.realpathSync.native(process.cwd());

  const matches = rows
    .map((row) => ({ ...row, path: fs.existsSync(row.path) ? fs.realpathSync.native(row.path) : row.path }))
    .filter((row) => cwd === row.path || cwd.startsWith(`${row.path}${path.sep}`))
    .sort((a, b) => b.path.length - a.path.length);

  return matches[0] ?? rows[0] ?? null;
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
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardPulseOn, setBoardPulseOn] = useState(true);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardColumns, setBoardColumns] = useState<BoardColumn[]>(() => buildBoardColumns({ draft: [], inProgress: [], done: [] }));
  const [boardSelection, setBoardSelection] = useState<BoardSelection>({ columnIndex: 0, specId: null });
  const [boardBusyAction, setBoardBusyAction] = useState<'approve' | 'run' | null>(null);
  const [forgeGenerationBrief, setForgeGenerationBrief] = useState<string | null>(null);
  const [forgeSpinnerFrameIndex, setForgeSpinnerFrameIndex] = useState(0);
  const [generatedSpecAction, setGeneratedSpecAction] = useState<GeneratedSpecActionState | null>(null);
  const [recallState, setRecallState] = useState<RecallState | null>(null);
  const [modelPickerState, setModelPickerState] = useState<ModelPickerState | null>(null);
  const { orchestrationState, backendStatus, backendMessage } = useOrchestrationState();

  const keyCounterRef = useRef(0);
  const walRequestRef = useRef<ClientRequest | null>(null);
  const walResponseRef = useRef<IncomingMessage | null>(null);
  const outputRequestRef = useRef<ClientRequest | null>(null);
  const outputResponseRef = useRef<IncomingMessage | null>(null);
  const outputPartialRef = useRef('');
  const activeRunIdRef = useRef<number | null>(null);
  const isUnmountedRef = useRef(false);
  const boardWorkspaceRef = useRef<WorkspaceMatch | null>(null);
  const boardFetchInFlightRef = useRef(false);
  const boardSelectionRef = useRef<BoardSelection>({ columnIndex: 0, specId: null });

  const workspaceName = useMemo(() => path.basename(process.cwd()) || 'workspace', []);
  const stdoutWidth = stdout?.columns ?? 80;
  const stdoutHeight = stdout?.rows ?? 24;
  const leftColumnWidth = Math.max(20, stdoutWidth - CONTEXT_WIDTH - 4);
  const mainHeight = Math.max(5, stdoutHeight - 7);
  const visibleOutput = outputLines.length === 0 ? [{ key: 'empty', text: '(no output yet)' }] : outputLines.slice(-mainHeight);

  const updateBoardSelection = (selection: BoardSelection): void => {
    boardSelectionRef.current = selection;
    setBoardSelection(selection);
  };

  const renderBoardColumnLines = (
    column: BoardColumn,
    selectedSpecId: string | null,
    width: number,
  ): BoardLine[] => {
    const visibleSpecs = column.specs.slice(0, 8);
    const lines: BoardLine[] = [];

    if (visibleSpecs.length === 0) {
      lines.push({ text: '(empty)', color: 'gray' });
    } else {
      for (const spec of visibleSpecs) {
        const selected = selectedSpecId === spec.id;
        const indicator = spec.activeRunStatus === 'running'
          ? boardPulseOn ? ' ●' : ' ○'
          : spec.activeRunStatus === 'queued'
            ? ` ○${spec.queuePosition ? `#${spec.queuePosition}` : ''}`
            : '';
        const color = spec.activeRunStatus === 'running'
          ? 'green'
          : spec.activeRunStatus === 'queued'
            ? 'yellow'
            : 'white';

        lines.push({
          text: `[${truncateSlug(spec.id)}]${indicator}`,
          color,
          inverse: selected,
        });
        lines.push({
          text: formatBoardMeta(spec, column.key, now),
          color: selected ? 'white' : 'gray',
          inverse: selected,
        });
      }
    }

    if (column.specs.length > 8) {
      lines.push({ text: `+${column.specs.length - 8} more`, color: 'gray' });
    }

    return lines.map((line) => ({
      ...line,
      text: line.text.length > width ? `${line.text.slice(0, Math.max(0, width - 1))}…` : line.text.padEnd(width, ' '),
    }));
  };

  const currentBoardSpec = useMemo<KanbanSpec | null>(() => {
    for (const column of boardColumns) {
      const spec = column.specs.find((item) => item.id === boardSelection.specId);
      if (spec) {
        return spec;
      }
    }

    return null;
  }, [boardColumns, boardSelection.specId]);

  const renderRecallEntryLines = (
    entry: RecallEntry,
    width: number,
  ): Array<{ text: string; color: RecallColor | 'gray' }> => {
    const sourceSuffix = entry.source ? ` · ${entry.source}` : '';
    return [
      {
        text: truncateText(`${entry.date}  [${getRecallCategoryLabel(entry.category)}] ${entry.title}${sourceSuffix}`, width),
        color: entry.color,
      },
      {
        text: truncateText(`  ${entry.body}`, width),
        color: 'gray',
      },
    ];
  };

  const cycleRecallCategory = (currentIndex: number, delta: number): number => {
    return (currentIndex + delta + RECALL_CATEGORIES.length) % RECALL_CATEGORIES.length;
  };

  const refreshBoard = async (): Promise<void> => {
    if (boardFetchInFlightRef.current) {
      return;
    }

    boardFetchInFlightRef.current = true;
    setBoardLoading(true);
    setBoardError(null);

    try {
      const workspace = boardWorkspaceRef.current ?? await resolveWorkspaceForCwd();
      boardWorkspaceRef.current = workspace;

      if (!workspace) {
        throw new Error(`No registered workspace matches ${process.cwd()}`);
      }

      const kanban = await apiJson<KanbanResponse>(`/api/specs/kanban?workspaceId=${encodeURIComponent(workspace.id)}`);
      const nextColumns = buildBoardColumns(kanban);
      setBoardColumns(nextColumns);
      updateBoardSelection(
        resolveBoardSelection(
          nextColumns,
          boardSelectionRef.current.columnIndex,
          boardSelectionRef.current.specId,
        ),
      );
    } catch (error) {
      setBoardError((error as Error).message);
    } finally {
      boardFetchInFlightRef.current = false;
      setBoardLoading(false);
    }
  };

  const openBoard = (): void => {
    setBoardOpen(true);
    void refreshBoard();
  };

  const fetchRecallEntries = async (workspaceId: string, query: string): Promise<RecallEntry[]> => {
    const endpoint = query
      ? `/api/memory/items?workspaceId=${encodeURIComponent(workspaceId)}&search=${encodeURIComponent(query)}&limit=10`
      : `/api/memory/items?workspaceId=${encodeURIComponent(workspaceId)}&limit=10`;
    const response = await apiJson<MemoryItemsResponse>(endpoint);
    return response.items.map(memoryItemToRecallEntry);
  };

  const openRecall = async (rawQuery: string): Promise<void> => {
    const query = rawQuery.trim();
    appendOutput({ text: `> recall ${query}`.trimEnd(), color: 'cyan' });

    try {
      const workspace = await resolveWorkspaceForCwd();
      if (!workspace) {
        throw new Error(`No registered workspace matches ${process.cwd()}`);
      }

      setRecallState({
        workspace,
        query,
        loading: true,
        error: null,
        entries: [],
        form: null,
      });

      const entries = await fetchRecallEntries(workspace.id, query);
      setRecallState({
        workspace,
        query,
        loading: false,
        error: null,
        entries,
        form: null,
      });
    } catch (error) {
      const message = getUserFriendlyError(error);
      setRecallState((current) => current
        ? { ...current, loading: false, error: message, entries: [] }
        : null);
      appendOutput({ text: `[${formatClock(new Date())}] recall failed: ${message}`, color: 'red' });
    }
  };

  const openRecallForm = (): void => {
    setRecallState((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        form: {
          field: 'title',
          title: '',
          body: '',
          categoryIndex: 0,
          saving: false,
          error: null,
        },
      };
    });
  };

  const submitRecallEntry = async (): Promise<void> => {
    if (!recallState?.form) {
      return;
    }

    const title = recallState.form.title.trim();
    const body = recallState.form.body.trim();
    const category = RECALL_CATEGORIES[recallState.form.categoryIndex];

    if (!title || !body) {
      setRecallState((current) => current && current.form
        ? {
            ...current,
            form: {
              ...current.form,
              error: !title ? 'Title is required' : 'Body is required',
            },
          }
        : current);
      return;
    }

    setRecallState((current) => current && current.form
      ? {
          ...current,
          form: { ...current.form, saving: true, error: null },
        }
      : current);

    try {
      const response = await apiJson<MemoryCreateResponse>('/api/memory', {
        method: 'POST',
        body: {
          workspaceId: recallState.workspace.id,
          category,
          title,
          rule: body,
          sourceType: 'manual',
        },
      });

      setRecallState((current) => {
        if (!current) {
          return current;
        }

        const created = buildCreatedRecallEntry(response.entry, keyCounterRef.current++);
        return {
          ...current,
          entries: [created, ...current.entries],
          form: null,
        };
      });
    } catch (error) {
      setRecallState((current) => current && current.form
        ? {
            ...current,
            form: {
              ...current.form,
              saving: false,
              error: getUserFriendlyError(error),
            },
          }
        : current);
    }
  };

  const approveSpec = async (specSlug: string): Promise<void> => {
    await approveSpecWithWorkspace(specSlug);
  };

  const approveSpecWithWorkspace = async (
    specSlug: string,
    workspaceOverride?: WorkspaceMatch | null,
  ): Promise<void> => {
    const normalizedSlug = specSlug.trim();
    if (!normalizedSlug) {
      appendOutput({ text: `[${formatClock(new Date())}] usage: approve <spec-slug>`, color: 'red' });
      return;
    }

    try {
      const workspace = workspaceOverride ?? boardWorkspaceRef.current ?? await resolveWorkspaceForCwd();
      boardWorkspaceRef.current = workspace;
      if (!workspace) {
        throw new Error(`No registered workspace matches ${process.cwd()}`);
      }

      await apiJson(`/api/specs/${encodeURIComponent(normalizedSlug)}/approve`, {
        method: 'POST',
        body: { workspaceId: workspace.id },
      });

      appendOutput(
        { text: `> approve ${normalizedSlug}`, color: 'cyan' },
        { text: `[forge] approved ${normalizedSlug}`, color: 'green' },
      );
    } catch (error) {
      appendOutput({
        text: `[${formatClock(new Date())}] approve failed: ${(error as Error).message}`,
        color: 'red',
      });
      throw error;
    }
  };

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
      const details = await apiJson<RunDetailsResponse>(`/api/pipeline/runs/${runId}`);
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
      const details = await apiJson<RunDetailsResponse>(`/api/pipeline/runs/${runId}`);
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

  const runSpec = async (
    specSlug: string,
    workspaceOverride?: WorkspaceMatch | null,
  ): Promise<void> => {
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
      const workspace = workspaceOverride ?? await resolveWorkspaceForCwd();
      if (!workspace) {
        throw new Error(`No registered workspace matches ${process.cwd()}`);
      }

      const trigger = await apiJson<TriggerResponse>('/api/pipeline/trigger', {
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
      if (boardOpen) {
        void refreshBoard();
      }
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

  const fetchGeneratedSpec = async (
    workspace: WorkspaceMatch,
    brief: string,
  ): Promise<GeneratedSpecActionState> => {
    const response = await apiJson<GenerateSpecResponse>('/api/specs/generate', {
      method: 'POST',
      body: {
        brief,
        workspaceId: workspace.id,
      },
      timeoutMs: GENERATE_TIMEOUT_MS,
    });

    if (response.async && response.jobId) {
      const startedAt = Date.now();

      while (Date.now() - startedAt < GENERATE_TIMEOUT_MS) {
        await sleep(GENERATE_POLL_INTERVAL_MS);
        const job = await apiJson<SpecGenerationJobResponse>(`/api/specs/generate/job/${encodeURIComponent(response.jobId)}`, {
          timeoutMs: 30_000,
        });

        if (job.status === 'failed') {
          throw new Error(job.error || 'Spec generation failed');
        }

        if (job.status === 'done') {
          const slug = job.slug || response.slug || response.id;
          if (!slug) {
            throw new Error('Spec generation finished without a slug');
          }

          const spec = await apiJson<GenerateSpecResponse>(`/api/specs/${encodeURIComponent(slug)}?workspaceId=${encodeURIComponent(workspace.id)}`, {
            timeoutMs: 30_000,
          });

          return {
            workspace,
            brief,
            slug,
            stories: normalizeGeneratedStories(spec),
          };
        }
      }

      throw new Error('Spec generation timed out before completion');
    }

    const slug = response.id || response.slug;
    if (!slug) {
      throw new Error(response.error || 'Spec generation did not return a spec slug');
    }

    return {
      workspace,
      brief,
      slug,
      stories: normalizeGeneratedStories(response),
    };
  };

  const printGeneratedSpec = (generated: GeneratedSpecActionState): void => {
    const lines: FormattedLine[] = [
      { text: `━━━━ Spec Generated: ${generated.slug} ━━━━`, color: 'green' },
      { text: `${generated.stories.length} ${generated.stories.length === 1 ? 'story' : 'stories'}`, color: 'white' },
      { text: `ID        ${'TITLE'.padEnd(STORY_TITLE_WIDTH, ' ')} COMPLEXITY`, color: 'cyan' },
    ];

    for (const story of generated.stories) {
      lines.push({ text: formatStoryTableLine(story), color: 'white' });
    }

    appendOutput(...lines);
  };

  const startForgeGeneration = async (rawBrief: string): Promise<void> => {
    const brief = rawBrief.trim();
    if (!brief) {
      appendOutput({ text: `[${formatClock(new Date())}] forge requires a non-empty brief`, color: 'red' });
      return;
    }

    if (foregroundRun || forgeGenerationBrief || generatedSpecAction) {
      appendOutput({ text: `[${formatClock(new Date())}] forge is busy`, color: 'yellow' });
      return;
    }

    appendOutput({ text: `> forge ${brief}`, color: 'cyan' });
    setGeneratedSpecAction(null);
    setForgeSpinnerFrameIndex(0);
    setForgeGenerationBrief(brief);
    setPhaseOverride('FORGING');

    try {
      const workspace = await resolveWorkspaceForCwd();
      boardWorkspaceRef.current = workspace;
      if (!workspace) {
        throw new Error(`No registered workspace matches ${process.cwd()}`);
      }

      const generated = await fetchGeneratedSpec(workspace, brief);
      printGeneratedSpec(generated);
      setGeneratedSpecAction(generated);
      setPhaseOverride(null);
    } catch (error) {
      appendOutput(
        {
          text: `[${formatClock(new Date())}] generation failed: ${getUserFriendlyError(error)}`,
          color: 'red',
        },
        {
          text: `[forge] brief preserved: ${truncateText(brief, 80)}`,
          color: 'gray',
        },
      );
      setPhaseOverride(null);
    } finally {
      setForgeGenerationBrief(null);
      setForgeSpinnerFrameIndex(0);
    }
  };

  const approveAndRunGeneratedSpec = async (generated: GeneratedSpecActionState): Promise<void> => {
    try {
      await approveSpecWithWorkspace(generated.slug, generated.workspace);
      await runSpec(generated.slug, generated.workspace);
    } catch {
      // approveSpecWithWorkspace / runSpec already print actionable errors
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
        await apiJson(`/api/pipeline/runs/${foregroundRun.runId}/cancel`, { method: 'POST' });
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

  const approveSelectedBoardSpec = async (): Promise<void> => {
    const selectedColumn = boardColumns[boardSelection.columnIndex];
    if (!selectedColumn || selectedColumn.key !== 'pending' || !currentBoardSpec || boardBusyAction) {
      return;
    }

    const selectedId = currentBoardSpec.id;
    setBoardBusyAction('approve');
    setBoardColumns((current) => {
      const pending = current[0];
      const approved = current[1];
      return [
        { ...pending, specs: pending.specs.filter((spec) => spec.id !== selectedId) },
        { ...approved, specs: [{ ...currentBoardSpec }, ...approved.specs] },
        current[2],
      ];
    });
    updateBoardSelection({ columnIndex: 1, specId: selectedId });

    try {
      await approveSpec(selectedId);
      await refreshBoard();
    } catch {
      await refreshBoard();
    } finally {
      setBoardBusyAction(null);
    }
  };

  const runSelectedBoardSpec = async (): Promise<void> => {
    const selectedColumn = boardColumns[boardSelection.columnIndex];
    if (!selectedColumn || selectedColumn.key !== 'approved' || !currentBoardSpec || boardBusyAction) {
      return;
    }

    setBoardBusyAction('run');
    try {
      await runSpec(currentBoardSpec.id);
      await refreshBoard();
    } finally {
      setBoardBusyAction(null);
    }
  };

  const refreshActiveAgentConfig = async (): Promise<{ agentType: string; agentModel: string | null }> => {
    const response = await apiJson<ConfigResponse>('/api/config');
    return {
      agentType: response.agentType ?? 'unknown',
      agentModel: response.agentModel ?? null,
    };
  };

  const handleAgentSwitch = async (agent: AgentType, model?: string | null): Promise<void> => {
    setModelPickerState((current) => current ? { ...current, switching: true, error: null, info: null } : current);

    try {
      await apiJson('/api/config/agent', {
        method: 'PUT',
        body: buildAgentSwitchPayload(agent, model),
      });
      const refreshed = await refreshActiveAgentConfig();
      setModelPickerState((current) => current
        ? {
            ...current,
            switching: false,
            activeAgent: refreshed.agentType,
            activeModel: refreshed.agentModel,
            info: formatActiveAgentLine(refreshed.agentType, refreshed.agentModel),
          }
        : current);
    } catch (error) {
      setModelPickerState((current) => current
        ? {
            ...current,
            switching: false,
            error: getUserFriendlyError(error),
          }
        : current);
    }
  };

  const openModelPicker = async (): Promise<void> => {
    appendOutput({ text: '> models', color: 'cyan' });
    setForgeSpinnerFrameIndex(0);
    setModelPickerState({
      loading: true,
      switching: false,
      groups: [],
      selectedIndex: 0,
      activeAgent: orchestrationState.activeAgent,
      activeModel: orchestrationState.activeModel,
      error: null,
      info: null,
      installMethods: null,
    });

    try {
      const active = await refreshActiveAgentConfig();
      const response = await apiJson<PiModelsResponse>('/api/config/pi-models');
      const groups = groupPiModels(response.models ?? []);
      setModelPickerState({
        loading: false,
        switching: false,
        groups,
        selectedIndex: findSelectedModelIndex(groups, active.agentType === 'pi' ? active.agentModel : null),
        activeAgent: active.agentType,
        activeModel: active.agentModel,
        error: null,
        info: null,
        installMethods: null,
      });
    } catch (error) {
      const active = await refreshActiveAgentConfig().catch(() => ({
        agentType: orchestrationState.activeAgent,
        agentModel: orchestrationState.activeModel,
      }));
      const installMethods = error instanceof TuiApiError && error.code === 'PI_NOT_FOUND'
        ? (((error.details as { installMethods?: PiInstallMethods } | undefined)?.installMethods) ?? null)
        : null;

      setModelPickerState({
        loading: false,
        switching: false,
        groups: [],
        selectedIndex: 0,
        activeAgent: active.agentType,
        activeModel: active.agentModel,
        error: installMethods ? null : getUserFriendlyError(error),
        info: null,
        installMethods,
      });
    }
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
          void startForgeGeneration(args.join(' '));
        },
      },
      {
        id: 'board',
        label: 'board',
        description: 'Open the board view',
        handler: () => {
          appendOutput({ text: '> board', color: 'cyan' });
          openBoard();
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
        args: ['[query]'],
        handler: (args) => {
          void openRecall(args.join(' '));
        },
      },
      {
        id: 'approve',
        label: 'approve',
        description: 'Approve a pending spec',
        args: ['<spec-slug>'],
        handler: (args) => {
          void approveSpec(args.join(' ').trim());
        },
      },
      {
        id: 'models',
        label: 'models',
        description: 'List available models',
        handler: () => {
          void openModelPicker();
        },
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
    [
      backendStatus,
      boardOpen,
      branchName,
      forgeGenerationBrief,
      foregroundRun,
      generatedSpecAction,
      orchestrationState.activeAgent,
      orchestrationState.phase,
      phaseOverride,
    ],
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

  useEffect(() => {
    if (!forgeGenerationBrief && !modelPickerState?.loading) {
      return;
    }

    const spinner = setInterval(() => {
      setForgeSpinnerFrameIndex((current) => (current + 1) % GENERATE_SPINNER_FRAMES.length);
    }, GENERATE_SPINNER_MS);

    return () => clearInterval(spinner);
  }, [forgeGenerationBrief, modelPickerState?.loading]);

  useEffect(() => {
    if (!boardOpen) {
      return;
    }

    void refreshBoard();
    const refreshTimer = setInterval(() => {
      void refreshBoard();
    }, 5000);
    const pulseTimer = setInterval(() => {
      setBoardPulseOn((current) => !current);
    }, 500);

    return () => {
      clearInterval(refreshTimer);
      clearInterval(pulseTimer);
    };
  }, [boardOpen]);

  useInput((input, key) => {
    if (recallState) {
      if (key.escape) {
        setRecallState(null);
        return;
      }

      if (!recallState.form) {
        if ((input === 'n' || input === 'N') && !key.ctrl && !key.meta) {
          openRecallForm();
        }
        return;
      }

      if (recallState.form.saving) {
        return;
      }

      if (key.leftArrow || key.upArrow) {
        if (recallState.form.field === 'category') {
          setRecallState((current) => current && current.form
            ? {
                ...current,
                form: {
                  ...current.form,
                  categoryIndex: cycleRecallCategory(current.form.categoryIndex, -1),
                  error: null,
                },
              }
            : current);
        }
        return;
      }

      if (key.rightArrow || key.downArrow) {
        if (recallState.form.field === 'category') {
          setRecallState((current) => current && current.form
            ? {
                ...current,
                form: {
                  ...current.form,
                  categoryIndex: cycleRecallCategory(current.form.categoryIndex, 1),
                  error: null,
                },
              }
            : current);
        }
        return;
      }

      if (key.tab) {
        setRecallState((current) => {
          if (!current?.form) {
            return current;
          }

          const nextField: Record<RecallFormField, RecallFormField> = {
            title: 'body',
            body: 'category',
            category: 'title',
          };

          return {
            ...current,
            form: {
              ...current.form,
              field: nextField[current.form.field],
              error: null,
            },
          };
        });
        return;
      }

      if (key.return) {
        if (recallState.form.field === 'title') {
          setRecallState((current) => current && current.form
            ? {
                ...current,
                form: { ...current.form, field: 'body', error: null },
              }
            : current);
          return;
        }

        if (recallState.form.field === 'body') {
          setRecallState((current) => current && current.form
            ? {
                ...current,
                form: { ...current.form, field: 'category', error: null },
              }
            : current);
          return;
        }

        void submitRecallEntry();
        return;
      }

      if (key.backspace || key.delete) {
        setRecallState((current) => {
          if (!current?.form || current.form.field === 'category') {
            return current;
          }

          const field = current.form.field;
          return {
            ...current,
            form: {
              ...current.form,
              [field]: current.form[field].slice(0, -1),
              error: null,
            },
          };
        });
        return;
      }

      if (!key.ctrl && !key.meta && input && recallState.form.field !== 'category') {
        setRecallState((current) => {
          if (!current?.form) {
            return current;
          }

          const field = current.form.field;
          if (field === 'category') {
            return current;
          }

          return {
            ...current,
            form: {
              ...current.form,
              [field]: current.form[field] + input,
              error: null,
            },
          };
        });
      }
      return;
    }

    if (modelPickerState) {
      if (key.escape) {
        setModelPickerState(null);
        return;
      }

      if (modelPickerState.loading || modelPickerState.switching) {
        return;
      }

      const totalModels = flattenModels(modelPickerState.groups).length;

      if (key.upArrow) {
        setModelPickerState((current) => current
          ? {
              ...current,
              selectedIndex: moveModelSelection(current.selectedIndex, -1, totalModels),
              error: null,
              info: null,
            }
          : current);
        return;
      }

      if (key.downArrow) {
        setModelPickerState((current) => current
          ? {
              ...current,
              selectedIndex: moveModelSelection(current.selectedIndex, 1, totalModels),
              error: null,
              info: null,
            }
          : current);
        return;
      }

      if (!key.ctrl && !key.meta && (input === 'c' || input === 'C')) {
        void handleAgentSwitch('claude');
        return;
      }

      if (!key.ctrl && !key.meta && (input === 'o' || input === 'O')) {
        void handleAgentSwitch('opencode');
        return;
      }

      if (!key.ctrl && !key.meta && (input === 'd' || input === 'D')) {
        void handleAgentSwitch('codex');
        return;
      }

      if (key.return && totalModels > 0) {
        const selected = flattenModels(modelPickerState.groups)[modelPickerState.selectedIndex];
        if (selected) {
          void handleAgentSwitch('pi', selected.model);
        }
      }
      return;
    }

    if (generatedSpecAction) {
      if (key.return) {
        const next = generatedSpecAction;
        setGeneratedSpecAction(null);
        void approveAndRunGeneratedSpec(next);
        return;
      }

      if ((input === 's' || input === 'S') && !key.ctrl && !key.meta) {
        appendOutput({ text: `Saved as pending: ${generatedSpecAction.slug}`, color: 'green' });
        setGeneratedSpecAction(null);
        return;
      }

      if ((input === 'e' || input === 'E') && !key.ctrl && !key.meta) {
        appendOutput(
          { text: `> edit stories ${generatedSpecAction.slug}`, color: 'cyan' },
          { text: `[forge] story editor not wired yet — spec saved as pending: ${generatedSpecAction.slug}`, color: 'yellow' },
        );
        setGeneratedSpecAction(null);
        return;
      }

      if (key.escape) {
        appendOutput({ text: `Spec saved as pending: ${generatedSpecAction.slug}`, color: 'yellow' });
        setGeneratedSpecAction(null);
      }
      return;
    }

    if (!boardOpen) {
      return;
    }

    if (key.escape) {
      setBoardOpen(false);
      return;
    }

    if (key.leftArrow) {
      updateBoardSelection(moveBoardSelection(boardColumns, boardSelectionRef.current, 'left'));
      return;
    }

    if (key.rightArrow) {
      updateBoardSelection(moveBoardSelection(boardColumns, boardSelectionRef.current, 'right'));
      return;
    }

    if (key.upArrow) {
      updateBoardSelection(moveBoardSelection(boardColumns, boardSelectionRef.current, 'up'));
      return;
    }

    if (key.downArrow) {
      updateBoardSelection(moveBoardSelection(boardColumns, boardSelectionRef.current, 'down'));
      return;
    }

    if ((input === 'a' || input === 'A') && !key.ctrl && !key.meta) {
      void approveSelectedBoardSpec();
      return;
    }

    if ((input === 'r' || input === 'R') && !key.ctrl && !key.meta) {
      void runSelectedBoardSpec();
    }
  });

  const effectivePhase = phaseOverride ?? orchestrationState.phase;
  const displayedStoryProgress = foregroundRun
    ? `${foregroundRun.currentStory}/${foregroundRun.totalStories}`
    : `${orchestrationState.currentStory}/${orchestrationState.totalStories}`;
  const disabledMessage = foregroundRun
    ? foregroundRun.confirmCancel
      ? `Cancel run #${foregroundRun.runId}? Press Ctrl+C again to confirm, Esc to resume.`
      : 'Run in progress... Press Ctrl+C to cancel.'
    : boardOpen
      ? 'Board active... use arrows, r, a, or Esc.'
    : undefined;
  const boardColumnWidth = Math.max(18, Math.floor((leftColumnWidth - 6) / 3));
  const boardRenderedColumns = boardColumns.map((column) =>
    renderBoardColumnLines(
      column,
      boardSelection.columnIndex === boardColumns.findIndex((item) => item.key === column.key) ? boardSelection.specId : null,
      boardColumnWidth,
    ),
  );
  const boardLineCount = Math.max(...boardRenderedColumns.map((column) => column.length), 1);
  const boardCanApprove = boardColumns[boardSelection.columnIndex]?.key === 'pending' && Boolean(currentBoardSpec);
  const boardCanRun = boardColumns[boardSelection.columnIndex]?.key === 'approved' && Boolean(currentBoardSpec);
  const spinnerLine = forgeGenerationBrief
    ? `${GENERATE_SPINNER_FRAMES[forgeSpinnerFrameIndex]} Generating spec: ${truncateText(forgeGenerationBrief, Math.max(24, leftColumnWidth - 22))}`
    : null;
  const modelPickerLines = modelPickerState
    ? buildModelPickerLines(modelPickerState.groups, modelPickerState.selectedIndex, Math.max(18, leftColumnWidth - 30))
    : null;
  const visibleModelPickerLines = modelPickerLines
    ? getVisibleModelPickerLines(modelPickerLines.lines, modelPickerLines.selectedLineIndex, Math.max(3, mainHeight - 5))
    : [];
  const recallHeader = recallState
    ? formatRecallHeader(recallState.query, recallState.entries.length, Math.max(20, leftColumnWidth - 2))
    : null;
  const commandPaletteDisabled = Boolean(foregroundRun)
    || boardOpen
    || Boolean(generatedSpecAction)
    || Boolean(forgeGenerationBrief)
    || Boolean(recallState)
    || Boolean(modelPickerState);
  const commandPaletteDisabledMessage = recallState
    ? recallState.form
      ? recallState.form.saving
        ? 'Saving memory entry...'
        : '[Enter] Next/Save  [Tab] Next field  [←/→] Category  [Esc] Back'
      : '[n] New entry  [Esc] Back'
    : modelPickerState
      ? modelPickerState.loading
        ? `${GENERATE_SPINNER_FRAMES[forgeSpinnerFrameIndex]} Loading Pi models...`
        : modelPickerState.switching
          ? 'Switching agent...'
          : '[↑/↓] Navigate  [Enter] Use Pi model  [c/o/d] Switch agent  [Esc] Back'
    : generatedSpecAction
      ? '[Enter] Approve + Run  [s] Save as pending  [e] Edit stories  [Esc] Cancel'
      : forgeGenerationBrief
        ? spinnerLine ?? 'Generating spec...'
        : disabledMessage;

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
          {recallState ? (
            <>
              <Text color="cyan">{recallHeader}</Text>
              {recallState.loading ? <Text color="gray">Loading memory…</Text> : null}
              {recallState.error ? <Text color="red">{recallState.error}</Text> : null}
              {!recallState.loading && !recallState.error && recallState.entries.length === 0 ? (
                <Text color="yellow">
                  {recallState.query ? `No memory entries match ${recallState.query}` : 'No memory entries yet'}
                </Text>
              ) : null}
              {!recallState.loading && !recallState.error
                ? recallState.entries
                    .flatMap((entry) => renderRecallEntryLines(entry, Math.max(20, leftColumnWidth - 2)))
                    .slice(0, Math.max(0, mainHeight - (recallState.form ? 8 : 2)))
                    .map((line, index) => (
                      <Text key={`recall-line-${index}`} color={line.color}>
                        {line.text}
                      </Text>
                    ))
                : null}
              {recallState.form ? (
                <>
                  <Text color="cyan">──── New Memory Entry ────</Text>
                  <Text inverse={recallState.form.field === 'title'}>
                    {truncateText(`Title: ${recallState.form.title}`, Math.max(20, leftColumnWidth - 2))}
                  </Text>
                  <Text inverse={recallState.form.field === 'body'}>
                    {truncateText(`Body: ${recallState.form.body}`, Math.max(20, leftColumnWidth - 2))}
                  </Text>
                  <Text
                    inverse={recallState.form.field === 'category'}
                    color={getRecallCategoryColor(RECALL_CATEGORIES[recallState.form.categoryIndex])}
                  >
                    {truncateText(`Category: ${RECALL_CATEGORIES[recallState.form.categoryIndex]}`, Math.max(20, leftColumnWidth - 2))}
                  </Text>
                  {recallState.form.error ? <Text color="red">{recallState.form.error}</Text> : null}
                </>
              ) : null}
            </>
          ) : modelPickerState ? (
            <>
              <Text color="cyan">{formatActiveAgentLine(modelPickerState.activeAgent, modelPickerState.activeModel)}</Text>
              <Text color="gray">Pi model picker</Text>
              {modelPickerState.loading ? <Text color="yellow">{`${GENERATE_SPINNER_FRAMES[forgeSpinnerFrameIndex]} Loading Pi models...`}</Text> : null}
              {modelPickerState.info ? <Text color="green">{modelPickerState.info}</Text> : null}
              {modelPickerState.error ? <Text color="red">{modelPickerState.error}</Text> : null}
              {modelPickerState.installMethods
                ? getPiInstallLines(modelPickerState.installMethods).map((line, index) => (
                    <Text key={`pi-install-${index}`} color={index === 0 ? 'yellow' : 'white'}>
                      {truncateText(line, Math.max(20, leftColumnWidth - 2))}
                    </Text>
                  ))
                : null}
              {!modelPickerState.loading && !modelPickerState.installMethods && modelPickerState.groups.length === 0 && !modelPickerState.error ? (
                <Text color="yellow">No models available — is pi running?</Text>
              ) : null}
              {!modelPickerState.loading && !modelPickerState.installMethods
                ? visibleModelPickerLines.map((line, index) => (
                    <Text
                      key={`model-picker-${index}`}
                      color={line.isHeader ? 'cyan' : 'white'}
                      inverse={line.selected}
                    >
                      {truncateText(line.text, Math.max(20, leftColumnWidth - 2))}
                    </Text>
                  ))
                : null}
            </>
          ) : boardOpen ? (
            <>
              <Text color="cyan">{'PENDING'.padEnd(boardColumnWidth, ' ')}│{'APPROVED'.padEnd(boardColumnWidth, ' ')}│{'RUNNING/DONE'.padEnd(boardColumnWidth, ' ')}</Text>
              <Text color="gray">{'─'.repeat(boardColumnWidth)}│{'─'.repeat(boardColumnWidth)}│{'─'.repeat(boardColumnWidth)}</Text>
              {boardLoading && boardColumns.every((column) => column.specs.length === 0) ? (
                <Text color="gray">Loading board…</Text>
              ) : null}
              {boardError ? (
                <Text color="red">{boardError}</Text>
              ) : null}
              {Array.from({ length: Math.min(mainHeight - 3, boardLineCount) }, (_, rowIndex) => (
                <Text key={`board-row-${rowIndex}`}>
                  {boardRenderedColumns.map((columnLines, columnIndex) => {
                    const line = columnLines[rowIndex] ?? { text: ''.padEnd(boardColumnWidth, ' ') };
                    return (
                      <Text key={`board-cell-${columnIndex}`} color={line.color} inverse={line.inverse}>
                        {columnIndex > 0 ? '│' : ''}
                        {line.text}
                      </Text>
                    );
                  })}
                </Text>
              ))}
              <Text color="gray">
                [r] run {boardCanRun ? '' : '(approved only)'}  [a] approve {boardCanApprove ? '' : '(pending only)'}  [Esc] back
              </Text>
            </>
          ) : (
            <>
              {visibleOutput.map((line) => (
                <Text key={line.key} color={line.color} dimColor={line.dimColor}>
                  {line.text}
                </Text>
              ))}
              {spinnerLine ? <Text color="yellow">{spinnerLine}</Text> : null}
            </>
          )}
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
          disabled={commandPaletteDisabled}
          disabledMessage={commandPaletteDisabledMessage}
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
