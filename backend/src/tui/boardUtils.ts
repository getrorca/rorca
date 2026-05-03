export interface KanbanSpec {
  id: string;
  storyCount: number;
  generatedAt: string;
  approvedAt?: string;
  passedStories?: number;
  failedStories?: number;
  activeRunStatus?: 'running' | 'queued';
  queuePosition?: number;
}

export interface KanbanResponse {
  draft: KanbanSpec[];
  inProgress: KanbanSpec[];
  done: KanbanSpec[];
}

export type BoardColumnKey = 'pending' | 'approved' | 'runningDone';

export interface BoardColumn {
  key: BoardColumnKey;
  title: string;
  specs: KanbanSpec[];
}

export interface BoardSelection {
  columnIndex: number;
  specId: string | null;
}

export function truncateSlug(slug: string, max = 28): string {
  if (slug.length <= max) {
    return slug;
  }

  if (max <= 1) {
    return '…';
  }

  return `${slug.slice(0, max - 1)}…`;
}

function formatRelativeTime(dateString: string, now: Date): string {
  const timestamp = Date.parse(dateString);
  if (Number.isNaN(timestamp)) {
    return 'unknown';
  }

  const seconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function computePassRate(spec: KanbanSpec, columnKey: BoardColumnKey): number {
  if (spec.storyCount <= 0) {
    return 0;
  }

  if (columnKey === 'pending') {
    return 0;
  }

  if (typeof spec.passedStories === 'number') {
    return Math.max(0, Math.min(100, Math.round((spec.passedStories / spec.storyCount) * 100)));
  }

  if (columnKey === 'runningDone' && !spec.activeRunStatus) {
    return 100;
  }

  return 0;
}

export function formatBoardMeta(spec: KanbanSpec, columnKey: BoardColumnKey, now: Date): string {
  const storyLabel = spec.storyCount === 1 ? 'story' : 'stories';
  const timeAgo = formatRelativeTime(spec.approvedAt || spec.generatedAt, now);
  return `  ↳ ${spec.storyCount} ${storyLabel}  •  ${computePassRate(spec, columnKey)}%  •  ${timeAgo}`;
}

export function buildBoardColumns(kanban: KanbanResponse): BoardColumn[] {
  const approved = kanban.inProgress.filter((spec) => !spec.activeRunStatus);
  const runningDone = [
    ...kanban.inProgress.filter((spec) => Boolean(spec.activeRunStatus)),
    ...kanban.done,
  ];

  return [
    { key: 'pending', title: 'PENDING', specs: kanban.draft },
    { key: 'approved', title: 'APPROVED', specs: approved },
    { key: 'runningDone', title: 'RUNNING/DONE', specs: runningDone },
  ];
}

function getColumnIndexForSpec(columns: BoardColumn[], specId: string): number {
  return columns.findIndex((column) => column.specs.some((spec) => spec.id === specId));
}

function getSpecIndex(column: BoardColumn, specId: string | null): number {
  if (!specId) {
    return 0;
  }

  const index = column.specs.findIndex((spec) => spec.id === specId);
  return index >= 0 ? index : 0;
}

export function resolveBoardSelection(
  columns: BoardColumn[],
  preferredColumnIndex = 0,
  preferredSpecId: string | null = null,
): BoardSelection {
  if (preferredSpecId) {
    const foundColumnIndex = getColumnIndexForSpec(columns, preferredSpecId);
    if (foundColumnIndex >= 0) {
      return { columnIndex: foundColumnIndex, specId: preferredSpecId };
    }
  }

  const preferredColumn = columns[preferredColumnIndex];
  if (preferredColumn?.specs[0]) {
    return { columnIndex: preferredColumnIndex, specId: preferredColumn.specs[0].id };
  }

  const firstNonEmptyIndex = columns.findIndex((column) => column.specs.length > 0);
  if (firstNonEmptyIndex >= 0) {
    return { columnIndex: firstNonEmptyIndex, specId: columns[firstNonEmptyIndex].specs[0].id };
  }

  return { columnIndex: 0, specId: null };
}

export function moveBoardSelection(
  columns: BoardColumn[],
  selection: BoardSelection,
  direction: 'left' | 'right' | 'up' | 'down',
): BoardSelection {
  const currentColumn = columns[selection.columnIndex] ?? columns[0];
  if (!currentColumn) {
    return selection;
  }

  if (direction === 'up' || direction === 'down') {
    if (currentColumn.specs.length === 0) {
      return selection;
    }

    const currentIndex = getSpecIndex(currentColumn, selection.specId);
    const nextIndex = direction === 'up'
      ? Math.max(0, currentIndex - 1)
      : Math.min(currentColumn.specs.length - 1, currentIndex + 1);

    return {
      columnIndex: selection.columnIndex,
      specId: currentColumn.specs[nextIndex]?.id ?? null,
    };
  }

  const step = direction === 'left' ? -1 : 1;
  const currentIndex = getSpecIndex(currentColumn, selection.specId);

  for (let index = selection.columnIndex + step; index >= 0 && index < columns.length; index += step) {
    if (columns[index].specs.length === 0) {
      continue;
    }

    const nextRow = Math.min(currentIndex, columns[index].specs.length - 1);
    return {
      columnIndex: index,
      specId: columns[index].specs[nextRow]?.id ?? null,
    };
  }

  return selection;
}
