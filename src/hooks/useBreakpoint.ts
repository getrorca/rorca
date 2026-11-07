/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const MOBILE_MAX = 639;   // < 640px
const TABLET_MAX = 1024;  // 640px–1024px (the canonical tablet QA viewport is 1024×768)
// desktop = >= 1025px

/**
 * Returns the current responsive breakpoint: 'mobile' | 'tablet' | 'desktop'.
 * Updates reactively via matchMedia listeners.
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => classifyBreakpoint(window.innerWidth));

  useEffect(() => {
    const mqlMobile = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
    const mqlTablet = window.matchMedia(`(min-width: ${MOBILE_MAX + 1}px) and (max-width: ${TABLET_MAX}px)`);

    const update = () => {
      if (mqlMobile.matches) setBp('mobile');
      else if (mqlTablet.matches) setBp('tablet');
      else setBp('desktop');
    };

    mqlMobile.addEventListener('change', update);
    mqlTablet.addEventListener('change', update);
    update();

    return () => {
      mqlMobile.removeEventListener('change', update);
      mqlTablet.removeEventListener('change', update);
    };
  }, []);

  return bp;
}

export function classifyBreakpoint(width: number): Breakpoint {
  if (width <= MOBILE_MAX) return 'mobile';
  if (width <= TABLET_MAX) return 'tablet';
  return 'desktop';
}

/** Returns true for touch-capable devices */
export function useTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(() =>
    'ontouchstart' in window || navigator.maxTouchPoints > 0
  );

  useEffect(() => {
    const mql = window.matchMedia('(pointer: coarse)');
    const handler = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    mql.addEventListener('change', handler);
    setIsTouch(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isTouch;
}
