import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTheme } from '../contexts/ThemeContext';
import { apiFetch } from '../lib/apiFetch';
import '@xterm/xterm/css/xterm.css';

interface ReadOnlyTerminalPaneProps {
  sessionId: string;
  className?: string;
  fontSize?: number;
}

const TERMINAL_OPTIONS = {
  fontFamily: 'JetBrains Mono, Fira Code, Monaco, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  allowTransparency: false,
  scrollback: 5000,
  cursorBlink: false,
  cursorStyle: 'block' as const,
  convertEol: true,
  disableStdin: true,
};

const TERMINAL_THEME_DARK = {
  background: '#0b0f17',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
};

const TERMINAL_THEME_LIGHT = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  selectionBackground: '#cce5ff',
};

export default function ReadOnlyTerminalPane({ sessionId, className, fontSize = 13 }: ReadOnlyTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { resolved } = useTheme();
  const [loading, setLoading] = useState(true);

  const currentTheme = resolved === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({ ...TERMINAL_OPTIONS, fontSize, theme: currentTheme });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      fitAddon.dispose();
      terminal.dispose();
      fitAddonRef.current = null;
      terminalRef.current = null;
    };
  }, [currentTheme, fontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = currentTheme;
  }, [currentTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    terminal.options.fontSize = fontSize;
    requestAnimationFrame(() => {
      fitAddon.fit();
    });
  }, [fontSize]);

  useEffect(() => {
    let cancelled = false;

    const loadScrollback = async () => {
      setLoading(true);
      try {
        const res = await apiFetch<{ chunks: Array<{ sequence: number; data: string }> }>(
          `/api/terminal/sessions/${encodeURIComponent(sessionId)}/scrollback`
        );

        if (cancelled || !terminalRef.current) return;
        terminalRef.current.clear();
        for (const chunk of res.chunks) {
          terminalRef.current.write(chunk.data);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadScrollback();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className={`relative h-full w-full ${className ?? ''}`}>
      <div ref={containerRef} className="h-full w-full" style={{ backgroundColor: currentTheme.background }} />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10 text-xs text-muted">
          Loading scrollback...
        </div>
      )}
    </div>
  );
}
