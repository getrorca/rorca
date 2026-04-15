import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface TerminalDrawerContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const TerminalDrawerContext = createContext<TerminalDrawerContextValue | null>(null);

export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((value) => !value), []);

  const value = useMemo(() => ({ isOpen, open, close, toggle }), [isOpen, open, close, toggle]);

  return <TerminalDrawerContext.Provider value={value}>{children}</TerminalDrawerContext.Provider>;
}

export function useTerminalDrawer(): TerminalDrawerContextValue {
  const context = useContext(TerminalDrawerContext);
  if (!context) {
    throw new Error('useTerminalDrawer must be used within TerminalDrawerProvider');
  }
  return context;
}
