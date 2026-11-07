/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useRef, useCallback, useEffect } from 'react';

const LONG_PRESS_MS = 300;
const DRAG_MOVE_THRESHOLD = 8; // px before considering it a drag

interface TouchDragConfig {
  /** Called when long-press initiates a drag on an element with [data-drag-id] */
  onDragStart?: (dragId: string, sourceColumn: string) => void;
  /** Called when drag ends over a drop zone with [data-drop-column] */
  onDrop?: (dragId: string, targetColumn: string) => void;
  /** Called when drag is cancelled (released outside a drop zone) */
  onDragCancel?: () => void;
}

/**
 * Enables touch-based drag-and-drop with long-press activation.
 *
 * Usage:
 * - Add `data-drag-id="specId"` and `data-drag-column="columnKey"` to draggable elements
 * - Add `data-drop-column="columnKey"` to drop zone containers
 * - Call `attachRef` on the scrollable container element
 *
 * Behavior:
 * - Long-press (300ms) initiates drag
 * - Vibration feedback on drag start (if supported)
 * - Visual ghost element follows finger
 * - Drop zones highlight when dragged over (48px min target)
 * - Release triggers drop or cancel
 */
export function useTouchDragDrop(config: TouchDragConfig) {
  const containerRef = useRef<HTMLElement | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDragging = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragColumnRef = useRef<string | null>(null);
  const startPos = useRef({ x: 0, y: 0 });

  const cleanupGhost = useCallback(() => {
    if (ghostRef.current) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
    // Remove all highlight classes
    document.querySelectorAll('[data-drop-column]').forEach(el => {
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.backgroundColor = '';
    });
  }, []);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const target = e.target as HTMLElement;
    const draggable = target.closest<HTMLElement>('[data-drag-id]');
    if (!draggable) return;

    const touch = e.touches[0];
    startPos.current = { x: touch.clientX, y: touch.clientY };

    longPressTimer.current = setTimeout(() => {
      const dragId = draggable.dataset.dragId!;
      const dragColumn = draggable.dataset.dragColumn || '';

      isDragging.current = true;
      dragIdRef.current = dragId;
      dragColumnRef.current = dragColumn;

      // Vibration feedback
      if (navigator.vibrate) {
        navigator.vibrate(30);
      }

      // Create ghost element
      const ghost = document.createElement('div');
      const rect = draggable.getBoundingClientRect();
      ghost.style.cssText = `
        position: fixed;
        top: ${rect.top}px;
        left: ${rect.left}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        pointer-events: none;
        z-index: 10000;
        opacity: 0.85;
        transform: scale(1.03);
        transition: transform 0.15s ease;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        border-radius: 8px;
        overflow: hidden;
      `;
      // Clone visual content
      const clone = draggable.cloneNode(true) as HTMLElement;
      clone.style.cssText = 'width:100%;height:100%;';
      ghost.appendChild(clone);
      document.body.appendChild(ghost);
      ghostRef.current = ghost;

      // Dim original
      draggable.style.opacity = '0.4';

      config.onDragStart?.(dragId, dragColumn);
    }, LONG_PRESS_MS);
  }, [config]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];

    // Cancel long-press if moved too far before it triggered
    if (!isDragging.current && longPressTimer.current) {
      const dx = Math.abs(touch.clientX - startPos.current.x);
      const dy = Math.abs(touch.clientY - startPos.current.y);
      if (dx > DRAG_MOVE_THRESHOLD || dy > DRAG_MOVE_THRESHOLD) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
      return;
    }

    if (!isDragging.current || !ghostRef.current) return;

    e.preventDefault(); // Prevent scroll while dragging

    // Move ghost
    const ghost = ghostRef.current;
    const rect = ghost.getBoundingClientRect();
    const offsetX = touch.clientX - rect.width / 2;
    const offsetY = touch.clientY - rect.height / 2;
    ghost.style.top = `${offsetY}px`;
    ghost.style.left = `${offsetX}px`;

    // Highlight drop zones
    document.querySelectorAll('[data-drop-column]').forEach(el => {
      const r = el.getBoundingClientRect();
      const isOver = touch.clientX >= r.left && touch.clientX <= r.right &&
                     touch.clientY >= r.top && touch.clientY <= r.bottom;
      (el as HTMLElement).style.outline = isOver ? '2px dashed var(--accent)' : '';
      (el as HTMLElement).style.backgroundColor = isOver ? 'rgba(79, 70, 229, 0.05)' : '';
    });
  }, []);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    // Clear long-press timer
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }

    if (!isDragging.current) return;
    isDragging.current = false;

    const dragId = dragIdRef.current;
    dragIdRef.current = null;
    dragColumnRef.current = null;

    // Restore original element opacity
    document.querySelectorAll('[data-drag-id]').forEach(el => {
      (el as HTMLElement).style.opacity = '';
    });

    // Find drop target
    const touch = e.changedTouches[0];
    let dropTarget: string | null = null;
    document.querySelectorAll('[data-drop-column]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (touch.clientX >= r.left && touch.clientX <= r.right &&
          touch.clientY >= r.top && touch.clientY <= r.bottom) {
        dropTarget = (el as HTMLElement).dataset.dropColumn!;
      }
    });

    cleanupGhost();

    if (dragId && dropTarget) {
      config.onDrop?.(dragId, dropTarget);
    } else {
      config.onDragCancel?.();
    }
  }, [config, cleanupGhost]);

  const attachRef = useCallback((el: HTMLElement | null) => {
    // Detach from previous
    if (containerRef.current) {
      containerRef.current.removeEventListener('touchstart', handleTouchStart);
      containerRef.current.removeEventListener('touchmove', handleTouchMove);
      containerRef.current.removeEventListener('touchend', handleTouchEnd);
    }

    containerRef.current = el;

    // Attach to new
    if (el) {
      el.addEventListener('touchstart', handleTouchStart, { passive: true });
      el.addEventListener('touchmove', handleTouchMove, { passive: false });
      el.addEventListener('touchend', handleTouchEnd, { passive: true });
    }
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      cleanupGhost();
      if (containerRef.current) {
        containerRef.current.removeEventListener('touchstart', handleTouchStart);
        containerRef.current.removeEventListener('touchmove', handleTouchMove);
        containerRef.current.removeEventListener('touchend', handleTouchEnd);
      }
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, cleanupGhost]);

  return { attachRef };
}
