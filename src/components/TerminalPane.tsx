import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTerminalSession } from '../hooks/useTerminalSession';
import { useTheme } from '../contexts/ThemeContext';
import '@xterm/xterm/css/xterm.css';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TerminalPaneProps {
  sessionId: string;
  onExit?: (exitCode: number) => void;
  onSessionLost?: () => void;
  className?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_OPTIONS = {
  fontFamily: 'JetBrains Mono, Fira Code, Monaco, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  allowTransparency: false,
  scrollback: 5000,
  cursorBlink: true,
  cursorStyle: 'block' as const,
  convertEol: true,
};

// ─── Theme colors ─────────────────────────────────────────────────────────────

const TERMINAL_THEME_DARK: ITheme = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selection: 'rgba(38,79,120,0.5)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

const TERMINAL_THEME_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selection: 'rgba(9,105,218,0.1)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#7d4e00',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function TerminalPane({ sessionId, onExit, onSessionLost, className }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [scrollbackFetched, setScrollbackFetched] = useState(false);
  const { resolved } = useTheme();

  const currentTheme = resolved === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;

  const { onData, sendInput, sendResize, reconnecting, connectionLost, onExit: onSessionExit } = useTerminalSession(sessionId);

  // ─── Terminal initialization ──────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      ...TERMINAL_OPTIONS,
      theme: currentTheme,
    });

    // Create fit addon
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    container.style.backgroundColor = currentTheme.background ?? '';

    // Mount terminal to DOM
    terminal.open(container);

    // Guard against null container before calling fit
    if (!containerRef.current) {
      terminal.dispose();
      fitAddon.dispose();
      return;
    }

    fitAddon.fit();

    // Store refs
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Setup resize observer
    const observer = new ResizeObserver(() => {
      if (fitAddon && terminal) {
        fitAddon.fit();
        sendResize(terminal.cols, terminal.rows);
      }
    });
    observer.observe(container);
    resizeObserverRef.current = observer;

    // Wire terminal input to session
    const inputDisposable = terminal.onData((data) => {
      sendInput(data);
    });

    // Send initial size after terminal is ready
    setTimeout(() => {
      sendResize(terminal.cols, terminal.rows);
    }, 50);

    // Cleanup on unmount
    return () => {
      inputDisposable.dispose();
      observer.disconnect();
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [currentTheme, sessionId, sendInput, sendResize]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = currentTheme;
    }

    if (containerRef.current) {
      containerRef.current.style.backgroundColor = currentTheme.background ?? '';
    }
  }, [currentTheme]);

  // ─── Scrollback replay ────────────────────────────────────────────────────────

  useEffect(() => {
    if (scrollbackFetched) return;

    const abortController = new AbortController();

    const fetchScrollback = async () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const host = import.meta.env.DEV ? 'localhost:3030' : window.location.host;
        const url = `${protocol}//${host}/api/terminal/sessions/${encodeURIComponent(sessionId)}/scrollback`;

        const response = await fetch(url, { signal: abortController.signal });
        if (!response.ok) {
          // If scrollback endpoint returns error, it's likely a new session with no history
          // This is not an error case — just skip replay
          setScrollbackFetched(true);
          return;
        }

        const data = await response.json();
        const chunks = data.chunks as Array<{ sequence: number; data: string }>;

        // Replay chunks in order
        if (terminalRef.current && chunks.length > 0) {
          for (const chunk of chunks) {
            terminalRef.current.write(chunk.data);
          }
        }

        setScrollbackFetched(true);
      } catch (err) {
        // Fetch aborted or network error — ignore
        if (!(err instanceof Error && err.name === 'AbortError')) {
          console.error('[TerminalPane] Failed to fetch scrollback:', err);
        }
        setScrollbackFetched(true);
      }
    };

    fetchScrollback();

    return () => {
      abortController.abort();
    };
  }, [sessionId, scrollbackFetched]);

  // ─── WebSocket data subscription ──────────────────────────────────────────────

  useEffect(() => {
    // Only start subscribing to live data after scrollback is fetched
    if (!scrollbackFetched) return;

    const unsubscribe = onData((data) => {
      if (terminalRef.current) {
        terminalRef.current.write(data);
      }
    });

    return unsubscribe;
  }, [onData, scrollbackFetched]);

  // ─── Exit handler ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const unsubscribe = onSessionExit((exitCode) => {
      if (terminalRef.current) {
        // Write exit message in muted color
        const message = `\r\n\x1b[38;5;243m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
        terminalRef.current.write(message);
      }

      // Call parent onExit handler
      onExit?.(exitCode);
    });

    return unsubscribe;
  }, [onSessionExit, onExit]);

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={`relative w-full h-full ${className ?? ''}`}>
      {/* Terminal container */}
      <div ref={containerRef} className="w-full h-full" style={{ backgroundColor: currentTheme.background }} />

      {/* Reconnecting overlay */}
      {reconnecting && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-white">
            <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            <span>Reconnecting...</span>
          </div>
        </div>
      )}

      {connectionLost && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <p className="text-sm font-medium text-white">
              Backend connection lost. Terminal session ended.
            </p>
            <button
              type="button"
              onClick={() => onSessionLost?.()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition hover:opacity-90"
            >
              Start New Session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
