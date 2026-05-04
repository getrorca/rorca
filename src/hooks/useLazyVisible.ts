/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useRef, useState, useEffect, useCallback } from 'react';

/**
 * Returns a callback ref and a boolean indicating whether the element is visible in the viewport.
 * Uses IntersectionObserver for efficient visibility detection.
 * Once visible, stays visible (no un-rendering on scroll away).
 */
export function useLazyVisible<T extends HTMLElement = HTMLDivElement>(
  rootMargin = '100px',
): [React.RefCallback<T>, boolean] {
  const elementRef = useRef<T | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [visible, setVisible] = useState(false);

  const ref = useCallback((node: T | null) => {
    // Cleanup previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    elementRef.current = node;

    if (!node || visible) return; // already visible — no need to observe

    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observerRef.current?.disconnect();
          observerRef.current = null;
        }
      },
      { rootMargin },
    );

    observerRef.current.observe(node);
  }, [visible, rootMargin]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  return [ref, visible];
}
