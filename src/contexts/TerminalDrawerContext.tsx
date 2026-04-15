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

const STORAGE_KEY = 'rorca:terminal:drawerHeight';
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;

const TerminalDrawerContext = createContext<TerminalDrawerContextValue | null>(null);

function clampHeight(height: number): number {
  const viewportMax = typeof window !== 'undefined' ? Math.floor(window.innerHeight * 0.8) : DEFAULT_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.min(height, viewportMax));
}

function getInitialHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_HEIGHT;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return clampHeight(DEFAULT_HEIGHT);
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return clampHeight(DEFAULT_HEIGHT);
    return clampHeight(parsed);
  } catch {
    return clampHeight(DEFAULT_HEIGHT);
  }
}

function persistHeight(height: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampHeight(height)));
  } catch {
  }
}

export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [heightState, setHeightState] = useState<number>(() => getInitialHeight());
  const [isFullscreen, setIsFullscreen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    setIsOpen(false);
    setIsFullscreen(false);
  }, []);
  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      if (prev) {
        setIsFullscreen(false);
      }
      return !prev;
    });
  }, []);
  const setHeight = useCallback((nextHeight: number) => {
    const clamped = clampHeight(nextHeight);
    setHeightState(clamped);
    persistHeight(clamped);
  }, []);
  const enterFullscreen = useCallback(() => {
    setIsOpen(true);
    setIsFullscreen(true);
  }, []);
  const exitFullscreen = useCallback(() => setIsFullscreen(false), []);

  const value = useMemo<TerminalDrawerContextValue>(() => ({
    isOpen,
    height: clampHeight(heightState),
    isFullscreen,
    open,
    close,
    toggle,
    setHeight,
    enterFullscreen,
    exitFullscreen,
  }), [heightState, isFullscreen, isOpen, open, close, toggle, setHeight, enterFullscreen, exitFullscreen]);

  return <TerminalDrawerContext.Provider value={value}>{children}</TerminalDrawerContext.Provider>;
}

export function useTerminalDrawer(): TerminalDrawerContextValue {
  const context = useContext(TerminalDrawerContext);
  if (!context) {
    throw new Error('useTerminalDrawer must be used within a TerminalDrawerProvider');
  }
  return context;
}

