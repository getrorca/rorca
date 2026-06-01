/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const MOBILE_MAX = 639;   // < 640px
const TABLET_MAX = 1023;  // 640px–1023px
// desktop = >= 1024px

/**
 * Returns the current responsive breakpoint: 'mobile' | 'tablet' | 'desktop'.
 * Updates reactively via matchMedia listeners.
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => classify(window.innerWidth));

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

function classify(w: number): Breakpoint {
  if (w <= MOBILE_MAX) return 'mobile';
  if (w <= TABLET_MAX) return 'tablet';
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
