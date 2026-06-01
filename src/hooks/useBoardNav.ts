/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Board navigation hook for Kanban-style card grids.
 *
 * Provides j/k (up/down within column), h/l (left/right between columns),
 * Enter (open), and action key shortcuts (a/x/e/d) on the focused card.
 *
 * Keyboard shortcuts only fire when no input/textarea/contenteditable is focused.
 */

export interface BoardNavColumn {
  key: string;
  cardIds: string[];
}

export interface BoardNavCallbacks {
  onOpen: (cardId: string) => void;
  onApprove?: (cardId: string) => void;
  onReject?: (cardId: string) => void;
  onEdit?: (cardId: string) => void;
  onDelete?: (cardId: string) => void;
}

export interface BoardNavState {
  focusedColumnIdx: number;
  focusedCardIdx: number;
  focusedCardId: string | null;
  focusedColumnKey: string | null;
}

const MOBILE_BREAKPOINT = 768;

export function useBoardNav(
  columns: BoardNavColumn[],
  callbacks: BoardNavCallbacks,
  enabled: boolean = true,
) {
  const [focusCol, setFocusCol] = useState(0);
  const [focusCard, setFocusCard] = useState(0);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  // Reset focus when columns change shape significantly
  useEffect(() => {
    setFocusCol((prev) => Math.min(prev, Math.max(0, columns.length - 1)));
    setFocusCard((prev) => {
      const col = columns[Math.min(focusCol, columns.length - 1)];
      if (!col) return 0;
      return Math.min(prev, Math.max(0, col.cardIds.length - 1));
    });
  }, [columns, focusCol]);

  // Scroll focused card into view
  const scrollToCard = useCallback((columnKey: string, cardId: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-board-card="${cardId}"][data-board-col="${columnKey}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.focus({ preventScroll: true });
    });
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;
    if (window.innerWidth < MOBILE_BREAKPOINT) return;

    const target = e.target as HTMLElement;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    if (isInput) return;

    // Skip if a modal/dialog is open (z-50 overlay)
    if (document.querySelector('[role="dialog"]')) return;

    const cols = columnsRef.current;
    if (cols.length === 0) return;

    const clampCol = (i: number) => Math.max(0, Math.min(i, cols.length - 1));
    const clampCard = (colIdx: number, i: number) => {
      const len = cols[colIdx]?.cardIds.length ?? 0;
      return Math.max(0, Math.min(i, len - 1));
    };

    const getFocusedId = (colIdx: number, cardIdx: number): string | null => {
      return cols[colIdx]?.cardIds[cardIdx] ?? null;
    };

    switch (e.key) {
      case 'j': { // Down within column
        e.preventDefault();
        setFocusCard((prev) => {
          const next = clampCard(clampCol(focusCol), prev + 1);
          const col = cols[clampCol(focusCol)];
          if (col?.cardIds[next]) scrollToCard(col.key, col.cardIds[next]);
          return next;
        });
        break;
      }
      case 'k': { // Up within column
        e.preventDefault();
        setFocusCard((prev) => {
          const next = clampCard(clampCol(focusCol), prev - 1);
          const col = cols[clampCol(focusCol)];
          if (col?.cardIds[next]) scrollToCard(col.key, col.cardIds[next]);
          return next;
        });
        break;
      }
      case 'h': { // Left to previous column
        e.preventDefault();
        setFocusCol((prev) => {
          const next = clampCol(prev - 1);
          const col = cols[next];
          const cardIdx = clampCard(next, focusCard);
          setFocusCard(cardIdx);
          if (col?.cardIds[cardIdx]) scrollToCard(col.key, col.cardIds[cardIdx]);
          return next;
        });
        break;
      }
      case 'l': { // Right to next column
        e.preventDefault();
        setFocusCol((prev) => {
          const next = clampCol(prev + 1);
          const col = cols[next];
          const cardIdx = clampCard(next, focusCard);
          setFocusCard(cardIdx);
          if (col?.cardIds[cardIdx]) scrollToCard(col.key, col.cardIds[cardIdx]);
          return next;
        });
        break;
      }
      case 'Enter': { // Open focused card detail
        const id = getFocusedId(focusCol, focusCard);
        if (id) {
          e.preventDefault();
          callbacksRef.current.onOpen(id);
        }
        break;
      }
      case 'a': { // Approve focused card
        const id = getFocusedId(focusCol, focusCard);
        if (id && callbacksRef.current.onApprove) {
          e.preventDefault();
          callbacksRef.current.onApprove(id);
        }
        break;
      }
      case 'x': { // Reject focused card (with confirmation built into handler)
        const id = getFocusedId(focusCol, focusCard);
        if (id && callbacksRef.current.onReject) {
          e.preventDefault();
          callbacksRef.current.onReject(id);
        }
        break;
      }
      case 'e': { // Edit brief of focused card
        const id = getFocusedId(focusCol, focusCard);
        if (id && callbacksRef.current.onEdit) {
          e.preventDefault();
          callbacksRef.current.onEdit(id);
        }
        break;
      }
      case 'd': { // Delete focused card (with confirmation built into handler)
        const id = getFocusedId(focusCol, focusCard);
        if (id && callbacksRef.current.onDelete) {
          e.preventDefault();
          callbacksRef.current.onDelete(id);
        }
        break;
      }
      default:
        return; // Don't prevent default for unhandled keys
    }
  }, [enabled, focusCol, focusCard, scrollToCard]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Derive current state
  const focusedColumnKey = columns[focusCol]?.key ?? null;
  const focusedCardId = columns[focusCol]?.cardIds[focusCard] ?? null;

  return {
    focusedColumnIdx: focusCol,
    focusedCardIdx: focusCard,
    focusedCardId,
    focusedColumnKey,
    setFocus: useCallback((colIdx: number, cardIdx: number) => {
      setFocusCol(colIdx);
      setFocusCard(cardIdx);
    }, []),
  } as const;
}
