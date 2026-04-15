import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTerminalSession } from '../hooks/useTerminalSession';
import '@xterm/xterm/css/xterm.css';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TerminalPaneProps {
  sessionId: string;
  onExit?: (exitCode: number) => void;
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

interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Build terminal theme from CSS variables at runtime to respect dynamic theme changes.
 * Falls back to hardcoded dark theme colors if CSS variables are not available.
 */
function buildTerminalTheme(): TerminalTheme {
  const style = getComputedStyle(document.documentElement);

  return {
    // Background/foreground
    background: style.getPropertyValue('--terminal-bg')?.trim() || '#0d1117',
    foreground: style.getPropertyValue('--terminal-fg')?.trim() || '#e6edf3',
    cursor: style.getPropertyValue('--accent-border')?.trim() || '#58a6ff',
    selection: '#264f78',

    // ANSI colors (standard)
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',

    // ANSI colors (bright)
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TerminalPane({ sessionId, onExit, className }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [scrollbackFetched, setScrollbackFetched] = useState(false);

  const { onData, sendInput, sendResize, reconnecting, onExit: onSessionExit, onShellEvent } = useTerminalSession(sessionId);

  const writeCommandBadge = useCallback((exitCode: number, durationMs: number) => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const durationText = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
    const badgeText = exitCode === 0 ? `✓ ${durationText}` : `✗ ${exitCode}`;
    const color = exitCode === 0 ? '\x1b[32m' : '\x1b[31m';
    const col = Math.max(1, terminal.cols - badgeText.length + 1);

    terminal.write(`\x1b[s\x1b[${col}G${color}${badgeText}\x1b[0m\x1b[u`);
  }, []);

  // ─── Terminal initialization ──────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create terminal with theme from CSS variables
    const theme = buildTerminalTheme();
    const terminal = new Terminal({
      ...TERMINAL_OPTIONS,
      theme,
    });

    // Create fit addon
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

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
  }, [sessionId, sendInput, sendResize]); // Include sessionId + callbacks in deps

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

  useEffect(() => {
    const unsubscribe = onShellEvent((event) => {
      if (event.event === 'command_end') {
        writeCommandBadge(event.exitCode, event.durationMs);
      }
    });

    return unsubscribe;
  }, [onShellEvent, writeCommandBadge]);

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={`relative w-full h-full ${className ?? ''}`}>
      {/* Terminal container */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Reconnecting overlay */}
      {reconnecting && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-white">
            <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            <span>Reconnecting...</span>
          </div>
        </div>
      )}
    </div>
  );
}
