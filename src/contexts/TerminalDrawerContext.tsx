/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface TerminalDrawerContextValue {
  isOpen: boolean;
  height: number;
  isFullscreen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setHeight: (height: number) => void;
  enterFullscreen: () => void;
  exitFullscreen: () => void;
}

const TerminalDrawerContext = createContext<TerminalDrawerContextValue | null>(null);

const STORAGE_KEY = 'rorca:terminal:drawerHeight';
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;

function clampHeight(height: number, viewportHeight: number): number {
  const maxHeight = Math.max(MIN_HEIGHT, Math.floor(viewportHeight * 0.8));
  return Math.min(maxHeight, Math.max(MIN_HEIGHT, Math.round(height)));
}

function getInitialHeight(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_HEIGHT;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return clampHeight(DEFAULT_HEIGHT, window.innerHeight);
    }

    const parsed = Number.parseInt(stored, 10);
    if (Number.isNaN(parsed)) {
      return clampHeight(DEFAULT_HEIGHT, window.innerHeight);
    }

    return clampHeight(parsed, window.innerHeight);
  } catch {
    return clampHeight(DEFAULT_HEIGHT, window.innerHeight);
  }
}

export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [height, setHeightState] = useState(getInitialHeight);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    setIsOpen(false);
    setIsFullscreen(false);
  }, []);
  const toggle = useCallback(() => {
    setIsOpen((value) => {
      const next = !value;
      if (!next) {
        setIsFullscreen(false);
      }
      return next;
    });
  }, []);
  const setHeight = useCallback((nextHeight: number) => {
    const viewportHeight = typeof window === 'undefined' ? DEFAULT_HEIGHT : window.innerHeight;
    const clamped = clampHeight(nextHeight, viewportHeight);
    setHeightState(clamped);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // Ignore storage failures.
    }
  }, []);
  const enterFullscreen = useCallback(() => {
    setIsOpen(true);
    setIsFullscreen(true);
  }, []);
  const exitFullscreen = useCallback(() => setIsFullscreen(false), []);

  const value = useMemo(() => ({
    isOpen,
    height,
    isFullscreen,
    open,
    close,
    toggle,
    setHeight,
    enterFullscreen,
    exitFullscreen,
  }), [isOpen, height, isFullscreen, open, close, toggle, setHeight, enterFullscreen, exitFullscreen]);

  return <TerminalDrawerContext.Provider value={value}>{children}</TerminalDrawerContext.Provider>;
}

export function useTerminalDrawer(): TerminalDrawerContextValue {
  const context = useContext(TerminalDrawerContext);
  if (!context) {
    throw new Error('useTerminalDrawer must be used within TerminalDrawerProvider');
  }
  return context;
}
