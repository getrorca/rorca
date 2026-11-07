/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * LifecycleMatrix — canonical seven-stage delivery matrix.
 *
 * Each column is one lifecycle stage. Each cell preserves the server's stage
 * status, gate progress, blocker, and safe next action for one spec. Activating
 * a cell opens that same stage in the phase detail view.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import LifecycleLivenessBadge from '../components/LifecycleLivenessBadge';
import { LifecycleAssuranceBadge, LifecycleDeliveryBadge, LifecycleMetaChip, LifecycleRiskBadge } from '../components/LifecycleBadges';
import {
  LIFECYCLE_STAGES,
  lifecycleStageOf,
  type LifecycleMissionStage,
  type LifecyclePhaseId,
  type LifecyclePortfolioItem,
  type LifecycleStageDescriptor,
} from '../types/lifecycle';
import {
  aggregateStageCells,
  stageCellAsPhaseCell,
  stageLeadPhase,
} from '../lib/lifecycle-stages';
import LifecycleCell from './LifecycleCell';

interface LifecycleMatrixProps {
  items: LifecyclePortfolioItem[];
  selectedSpecId: string | null;
  selectedPhaseId: LifecyclePhaseId | null;
  focusSpecId?: string | null;
  focusPhaseId?: LifecyclePhaseId | null;
  compact?: boolean;
  /**
   * Compiled plan stage profile; falls back to the bundled seven-stage
   * projection when absent. The profile is the single source of the stage
   * mapping — other stage semantics are hardcoded in this component.
   */
  stages?: readonly LifecycleStageDescriptor[] | null;
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
  onSelect: (specId: string, phaseId: LifecyclePhaseId) => void;
  onOpenSpec: (specId: string) => void;
  onPageChange: (page: number) => void;
}

interface CellCoordinate { specId: string; stageId: LifecycleMissionStage }

function coordinateKey(specId: string, stageId: LifecycleMissionStage): string {
  return `${encodeURIComponent(specId)}:${stageId}`;
}

interface LifecycleMatrixRowProps {
  item: LifecyclePortfolioItem;
  row: number;
  stages: readonly LifecycleStageDescriptor[];
  selectedStageId: LifecycleMissionStage | null;
  focusStageId: LifecycleMissionStage | null;
  compact: boolean;
  registerButton: (key: string, node: HTMLButtonElement | null) => void;
  onCellSelect: (specId: string, phaseId: LifecyclePhaseId) => void;
  onOpenSpec: (specId: string) => void;
  onCellKeyDown: (event: KeyboardEvent<HTMLButtonElement>, row: number, column: number) => void;
}

const LifecycleMatrixRow = memo(function LifecycleMatrixRow({
  item,
  row,
  stages,
  selectedStageId,
  focusStageId,
  compact,
  registerButton,
  onCellSelect,
  onOpenSpec,
  onCellKeyDown,
}: LifecycleMatrixRowProps) {
  const stageCells = aggregateStageCells(item, stages);
  return (
    <tr data-spec-id={item.specId}>
      <th scope="row" className="lifecycle-matrix-spec-cell">
        <button
          type="button"
          className="lifecycle-matrix-spec-title rounded-sm text-left hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => onOpenSpec(item.specId)}
          title={item.title}
        >{item.title}</button>
        <span className="lifecycle-matrix-spec-chips">
          <LifecycleDeliveryBadge delivery={item.delivery} />
          <LifecycleAssuranceBadge assurance={item.assurance} />
          <LifecycleRiskBadge risk={item.risk} />
          <LifecycleMetaChip>
            <span className="tabular-nums">{item.storySummary.total} {item.storySummary.total === 1 ? 'story' : 'stories'}</span>
          </LifecycleMetaChip>
          {item.owner && (
            <LifecycleMetaChip>
              <span className="lifecycle-matrix-owner">{item.owner.label}</span>
            </LifecycleMetaChip>
          )}
        </span>
        <span className="lifecycle-matrix-spec-liveness">
          <LifecycleLivenessBadge liveness={item.liveness} />
        </span>
      </th>
      {stageCells.map((stage, column) => {
        const key = coordinateKey(item.specId, stage.stageId);
        return (
          <td key={stage.stageId}>
            <LifecycleCell
              specTitle={item.title}
              phaseName={stage.displayName}
              cell={stageCellAsPhaseCell(stage)}
              selected={stage.stageId === selectedStageId}
              compact={compact}
              tabIndex={stage.stageId === focusStageId ? 0 : -1}
              buttonRef={(node) => registerButton(key, node)}
              onSelect={() => onCellSelect(item.specId, stageLeadPhase(stage))}
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
 * Arrow keys move one stage cell; Home/End move to the first/last stage in the
 * row; Ctrl+Home/Ctrl+End move to the first/last matrix cell. Enter/Space
 * select, opening the phase view at the stage's lead phase.
 */
export default function LifecycleMatrix({
  items,
  selectedSpecId,
  selectedPhaseId,
  focusSpecId = null,
  focusPhaseId = null,
  compact = false,
  stages,
  pagination,
  onSelect,
  onOpenSpec,
  onPageChange,
}: LifecycleMatrixProps) {
  // Plan profile stages when present; the bundled projection otherwise. The
  // contract guarantees profile stages tile the canonical phase columns.
  const stageHeaders = stages && stages.length > 0 ? stages : LIFECYCLE_STAGES;
  const selectedStageId = selectedPhaseId ? lifecycleStageOf(selectedPhaseId) : null;
  const firstCoordinate = useMemo<CellCoordinate | null>(() => (
    items[0] ? { specId: items[0].specId, stageId: stageHeaders[0]!.id } : null
  ), [items, stageHeaders]);
  const selectedOnPage = useMemo<CellCoordinate | null>(() => {
    if (!selectedSpecId || !selectedStageId || !items.some((item) => item.specId === selectedSpecId)) return null;
    return { specId: selectedSpecId, stageId: selectedStageId };
  }, [items, selectedSpecId, selectedStageId]);
  const requestedFocusOnPage = useMemo<CellCoordinate | null>(() => {
    if (!focusSpecId || !focusPhaseId || !items.some((item) => item.specId === focusSpecId)) return null;
    return { specId: focusSpecId, stageId: lifecycleStageOf(focusPhaseId) };
  }, [focusPhaseId, focusSpecId, items]);
  const [focusCoordinate, setFocusCoordinate] = useState<CellCoordinate | null>(selectedOnPage ?? requestedFocusOnPage ?? firstCoordinate);
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
      if (requestedFocusOnPage) return requestedFocusOnPage;
      if (current && items.some((item) => item.specId === current.specId)) return current;
      return firstCoordinate;
    });
  }, [firstCoordinate, items, requestedFocusOnPage, selectedOnPage]);

  const focusCell = useCallback((row: number, column: number) => {
    const boundedRow = Math.max(0, Math.min(row, items.length - 1));
    const boundedColumn = Math.max(0, Math.min(column, stageHeaders.length - 1));
    const item = items[boundedRow];
    const stage = stageHeaders[boundedColumn];
    if (!item || !stage) return;
    const next = { specId: item.specId, stageId: stage.id };
    setFocusCoordinate(next);
    buttonRefs.current.get(coordinateKey(next.specId, next.stageId))?.focus();
  }, [items, stageHeaders]);

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
      nextColumn = stageHeaders.length - 1;
    } else return;
    event.preventDefault();
    focusCell(nextRow, nextColumn);
  }, [focusCell, items.length, stageHeaders.length]);

  const pageCount = Math.max(1, Math.ceil(pagination.total / pagination.limit));

  return (
    <section className="lifecycle-matrix-surface" aria-label="Spec lifecycle matrix">
      <p id="lifecycle-matrix-keyboard-help" className="sr-only">
        Use arrow keys to move between stage cells. Home and End move to the first and last stage in a row.
        Control plus Home and End move to the first and last matrix cell. Press Enter or Space to open the stage's phase details.
      </p>
      <div
        className="lifecycle-matrix-scroll scrollbar-themed"
        data-testid="lifecycle-matrix-scroll"
        data-scroll-affordance="horizontal-and-vertical"
        tabIndex={0}
        aria-label="Scrollable lifecycle matrix; scroll horizontally to view every stage"
      >
        <table className="lifecycle-matrix-table" aria-describedby="lifecycle-matrix-keyboard-help">
          <caption className="sr-only">Lifecycle Control delivery stage matrix</caption>
          <thead>
            {/* Stage columns come from the compiled plan profile when present;
                otherwise the bundled canonical seven-stage order is used. */}
            <tr>
              <th scope="col" className="lifecycle-matrix-spec-header">Spec</th>
              {stageHeaders.map((stage) => (
                <th key={stage.id} scope="col" className="lifecycle-matrix-stage-header">
                  {stage.displayName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, row) => (
              <LifecycleMatrixRow
                key={item.specId}
                item={item}
                row={row}
                stages={stageHeaders}
                selectedStageId={item.specId === selectedSpecId ? selectedStageId : null}
                focusStageId={item.specId === focusCoordinate?.specId ? focusCoordinate.stageId : null}
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
