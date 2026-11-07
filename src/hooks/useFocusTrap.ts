/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef, useCallback, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface FocusTrapOptions {
  /** Called for Escape only when this trap owns the topmost modal. */
  onEscape?: (() => void) | undefined;
}

/**
 * Traps focus inside a container element while active.
 * Returns a ref to attach to the container.
 * On unmount (or when active becomes false), restores focus to the element
 * that was focused before the trap activated.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  active = true,
  restoreFocusRef?: RefObject<HTMLElement | null>,
  options: FocusTrapOptions = {},
) {
  const containerRef = useRef<T>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const requestedRestoreRef = useRef(restoreFocusRef);
  requestedRestoreRef.current = restoreFocusRef;
  const onEscapeRef = useRef(options.onEscape);
  onEscapeRef.current = options.onEscape;

  // Capture the previously focused element when the trap activates
  useEffect(() => {
    if (active) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
    }
  }, [active]);

  // Restore focus when trap deactivates or unmounts
  useEffect(() => {
    if (!active) return;
    return () => {
      requestAnimationFrame(() => {
        // Read the requested target after the closing render. This lets a
        // responsive drawer restore to a trigger that remounts on close.
        const target = requestedRestoreRef.current?.current ?? previousFocusRef.current;
        if (target?.isConnected && typeof target.focus === 'function') target.focus();
      });
    };
  }, [active]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const topmostModal = (e.target as HTMLElement | null)?.closest<HTMLElement>('[aria-modal="true"]');
    const owningModal = container.matches('[aria-modal="true"]')
      ? container
      : container.closest<HTMLElement>('[aria-modal="true"]');
    if (topmostModal && owningModal !== topmostModal) return;

    if (e.key === 'Escape' && onEscapeRef.current) {
      e.preventDefault();
      e.stopPropagation();
      onEscapeRef.current();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden';
    });

    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (!container.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, handleKeyDown]);

  // Focus enters the dialog in the same committed render. Deferring to an
  // animation frame leaves the opener active for a visible keyboard cycle.
  useEffect(() => {
    if (!active || !containerRef.current) return;
    if (document.activeElement && containerRef.current.contains(document.activeElement)) return;
    const firstFocusable = containerRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
  }, [active]);

  return containerRef;
}
