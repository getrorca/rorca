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

/**
 * Traps focus inside a container element while active.
 * Returns a ref to attach to the container.
 * On unmount (or when active becomes false), restores focus to the element
 * that was focused before the trap activated.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  active = true,
  restoreFocusRef?: RefObject<HTMLElement | null>,
) {
  const containerRef = useRef<T>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const requestedRestoreRef = useRef(restoreFocusRef);
  requestedRestoreRef.current = restoreFocusRef;

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
      // Read the requested target during cleanup so a drawer that switches
      // matrix cells restores to the latest selected cell, not the opener.
      const target = requestedRestoreRef.current?.current ?? previousFocusRef.current;
      if (target && typeof target.focus === 'function') {
        requestAnimationFrame(() => {
          if (target.isConnected) target.focus();
        });
      }
    };
  }, [active]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !containerRef.current) return;
    const topmostModal = (e.target as HTMLElement | null)?.closest<HTMLElement>('[aria-modal="true"]');
    if (topmostModal && topmostModal !== containerRef.current && !containerRef.current.contains(topmostModal)) return;

    const focusable = Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
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

    if (!containerRef.current.contains(document.activeElement)) {
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

  // Auto-focus first focusable element inside the container
  useEffect(() => {
    if (!active || !containerRef.current) return;
    // Slight delay to let the DOM render
    const timer = requestAnimationFrame(() => {
      if (!containerRef.current) return;
      if (document.activeElement && containerRef.current.contains(document.activeElement)) return;
      const firstFocusable = containerRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (firstFocusable) {
        firstFocusable.focus();
      }
    });
    return () => cancelAnimationFrame(timer);
  }, [active]);

  return containerRef;
}
