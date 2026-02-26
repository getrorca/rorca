import { createContext, useContext, useState, type ReactNode } from 'react';

interface HelpTipsContextValue {
  showTips: boolean;
  setShowTips: (show: boolean) => void;
}

const HelpTipsCtx = createContext<HelpTipsContextValue | null>(null);

const LS_KEY = 'rorca_show_tips';

export function HelpTipsProvider({ children }: { children: ReactNode }) {
  const [showTips, setShowTipsRaw] = useState<boolean>(() => {
    const stored = localStorage.getItem(LS_KEY);
    return stored === null ? true : stored === 'true';
  });

  const setShowTips = (show: boolean) => {
    localStorage.setItem(LS_KEY, String(show));
    setShowTipsRaw(show);
  };

  return (
    <HelpTipsCtx.Provider value={{ showTips, setShowTips }}>
      {children}
    </HelpTipsCtx.Provider>
  );
}

export function useHelpTips() {
  const ctx = useContext(HelpTipsCtx);
  if (!ctx) throw new Error('useHelpTips must be inside HelpTipsProvider');
  return ctx;
}
