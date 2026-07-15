/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  LIFECYCLE_PHASES,
  type LifecyclePhaseId,
  type LifecyclePortfolioItem,
} from '../types/lifecycle';
import LifecycleCell, { emptyLifecycleCell } from './LifecycleCell';

interface LifecycleMatrixProps {
  items: LifecyclePortfolioItem[];
  selectedSpecId: string | null;
  selectedPhaseId: LifecyclePhaseId | null;
  compact?: boolean;
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
  onSelect: (specId: string, phaseId: LifecyclePhaseId) => void;
  onOpenSpec: (specId: string) => void;
  onPageChange: (page: number) => void;
}

interface CellCoordinate { specId: string; phaseId: LifecyclePhaseId }

function coordinateKey(specId: string, phaseId: LifecyclePhaseId): string {
  return `${encodeURIComponent(specId)}:${phaseId}`;
}

function riskLabel(value: LifecyclePortfolioItem['risk']): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)} risk`;
}

function livenessLabel(item: LifecyclePortfolioItem): string {
  if (!item.liveness) return 'No active run';
  const state = item.liveness.state.replace(/_/g, ' ');
  return `Run: ${state.charAt(0).toUpperCase()}${state.slice(1)}`;
}

interface LifecycleMatrixRowProps {
  item: LifecyclePortfolioItem;
  row: number;
  selectedPhaseId: LifecyclePhaseId | null;
  focusPhaseId: LifecyclePhaseId | null;
  compact: boolean;
  registerButton: (key: string, node: HTMLButtonElement | null) => void;
  onCellSelect: (specId: string, phaseId: LifecyclePhaseId) => void;
  onOpenSpec: (specId: string) => void;
  onCellKeyDown: (event: KeyboardEvent<HTMLButtonElement>, row: number, column: number) => void;
}

const LifecycleMatrixRow = memo(function LifecycleMatrixRow({
  item,
  row,
  selectedPhaseId,
  focusPhaseId,
  compact,
  registerButton,
  onCellSelect,
  onOpenSpec,
  onCellKeyDown,
}: LifecycleMatrixRowProps) {
  return (
    <tr data-spec-id={item.specId}>
      <th scope="row" className="lifecycle-matrix-spec-cell">
        <button
          type="button"
          className="lifecycle-matrix-spec-title rounded-sm text-left hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => onOpenSpec(item.specId)}
        >{item.title}</button>
        <span className="lifecycle-matrix-spec-meta">
          {riskLabel(item.risk)} · {item.storySummary.total} {item.storySummary.total === 1 ? 'story' : 'stories'}
          {item.owner ? ` · Owner: ${item.owner.label}` : ''}
        </span>
        <span className="lifecycle-matrix-liveness" data-state={item.liveness?.state ?? 'none'}>
          {livenessLabel(item)}
        </span>
      </th>
      {LIFECYCLE_PHASES.map((phase, column) => {
        const cell = item.phases.find((candidate) => candidate.phaseId === phase.id)
          ?? emptyLifecycleCell(phase.id, phase.displayName);
        const key = coordinateKey(item.specId, phase.id);
        return (
          <td key={phase.id}>
            <LifecycleCell
              specTitle={item.title}
              phaseName={phase.displayName}
              cell={cell}
              selected={phase.id === selectedPhaseId}
              compact={compact}
              tabIndex={phase.id === focusPhaseId ? 0 : -1}
              buttonRef={(node) => registerButton(key, node)}
              onSelect={() => onCellSelect(item.specId, phase.id)}
              onKeyDown={(event) => onCellKeyDown(event, row, column)}
            />
          </td>
        );
      })}
    </tr>
  );
});

/**
 * Semantic lifecycle table keyboard model:
 * Arrow keys move one cell; Home/End move to the first/last phase in the row;
 * Ctrl+Home/Ctrl+End move to the first/last matrix cell. Enter/Space select.
 */
export default function LifecycleMatrix({
  items,
  selectedSpecId,
  selectedPhaseId,
  compact = false,
  pagination,
  onSelect,
  onOpenSpec,
  onPageChange,
}: LifecycleMatrixProps) {
  const firstCoordinate = useMemo<CellCoordinate | null>(() => (
    items[0] ? { specId: items[0].specId, phaseId: LIFECYCLE_PHASES[0].id } : null
  ), [items]);
  const selectedOnPage = useMemo<CellCoordinate | null>(() => {
    if (!selectedSpecId || !selectedPhaseId || !items.some((item) => item.specId === selectedSpecId)) return null;
    return { specId: selectedSpecId, phaseId: selectedPhaseId };
  }, [items, selectedPhaseId, selectedSpecId]);
  const [focusCoordinate, setFocusCoordinate] = useState<CellCoordinate | null>(selectedOnPage ?? firstCoordinate);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCellSelect = useCallback((specId: string, phaseId: LifecyclePhaseId) => {
    onSelectRef.current(specId, phaseId);
  }, []);
  const registerButton = useCallback((key: string, node: HTMLButtonElement | null) => {
    if (node) buttonRefs.current.set(key, node);
    else buttonRefs.current.delete(key);
  }, []);

  useEffect(() => {
    setFocusCoordinate((current) => {
      if (selectedOnPage) return selectedOnPage;
      if (current && items.some((item) => item.specId === current.specId)) return current;
      return firstCoordinate;
    });
  }, [firstCoordinate, items, selectedOnPage]);

  const focusCell = useCallback((row: number, column: number) => {
    const boundedRow = Math.max(0, Math.min(row, items.length - 1));
    const boundedColumn = Math.max(0, Math.min(column, LIFECYCLE_PHASES.length - 1));
    const item = items[boundedRow];
    const phase = LIFECYCLE_PHASES[boundedColumn];
    if (!item || !phase) return;
    const next = { specId: item.specId, phaseId: phase.id };
    setFocusCoordinate(next);
    buttonRefs.current.get(coordinateKey(next.specId, next.phaseId))?.focus();
  }, [items]);

  const handleKeyDown = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    row: number,
    column: number,
  ) => {
    let nextRow = row;
    let nextColumn = column;
    if (event.key === 'ArrowRight') nextColumn += 1;
    else if (event.key === 'ArrowLeft') nextColumn -= 1;
    else if (event.key === 'ArrowDown') nextRow += 1;
    else if (event.key === 'ArrowUp') nextRow -= 1;
    else if (event.key === 'Home') {
      nextRow = event.ctrlKey ? 0 : row;
      nextColumn = 0;
    } else if (event.key === 'End') {
      nextRow = event.ctrlKey ? items.length - 1 : row;
      nextColumn = LIFECYCLE_PHASES.length - 1;
    } else return;
    event.preventDefault();
    focusCell(nextRow, nextColumn);
  }, [focusCell, items.length]);

  const pageCount = Math.max(1, Math.ceil(pagination.total / pagination.limit));

  return (
    <section className="lifecycle-matrix-surface" aria-label="Spec lifecycle matrix">
      <p id="lifecycle-matrix-keyboard-help" className="sr-only">
        Use arrow keys to move between phase cells. Home and End move to the first and last phase in a row.
        Control plus Home and End move to the first and last matrix cell. Press Enter or Space to open phase details.
      </p>
      <div
        className="lifecycle-matrix-scroll scrollbar-themed"
        data-testid="lifecycle-matrix-scroll"
        data-scroll-affordance="horizontal-and-vertical"
        tabIndex={0}
        aria-label="Scrollable lifecycle matrix; scroll horizontally to view every phase"
      >
        <table className="lifecycle-matrix-table" aria-describedby="lifecycle-matrix-keyboard-help">
          <caption className="sr-only">Lifecycle Control delivery phase matrix</caption>
          <thead>
            <tr>
              <th scope="col" className="lifecycle-matrix-spec-header">Spec</th>
              {LIFECYCLE_PHASES.map((phase) => (
                <th key={phase.id} scope="col">{phase.displayName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, row) => (
              <LifecycleMatrixRow
                key={item.specId}
                item={item}
                row={row}
                selectedPhaseId={item.specId === selectedSpecId ? selectedPhaseId : null}
                focusPhaseId={item.specId === focusCoordinate?.specId ? focusCoordinate.phaseId : null}
                compact={compact}
                registerButton={registerButton}
                onCellSelect={onCellSelect}
                onOpenSpec={onOpenSpec}
                onCellKeyDown={handleKeyDown}
              />
            ))}
          </tbody>
        </table>
      </div>

      {pagination.total > pagination.limit && (
        <nav className="lifecycle-matrix-pagination" aria-label="Lifecycle pagination">
          <span>{pagination.total} specs · Page {pagination.page} of {pageCount}</span>
          <button
            type="button"
            disabled={pagination.page <= 1}
            onClick={() => onPageChange(pagination.page - 1)}
          >Previous</button>
          <button
            type="button"
            disabled={!pagination.hasMore || pagination.page >= pageCount}
            onClick={() => onPageChange(pagination.page + 1)}
          >Next</button>
        </nav>
      )}
    </section>
  );
}
