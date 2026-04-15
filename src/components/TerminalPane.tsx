import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
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

const SEARCH_DECORATIONS = {
  matchBackground: '#264f78',
  matchBorder: '#58a6ff',
  matchOverviewRuler: '#58a6ff',
  activeMatchBackground: '#1f6feb',
  activeMatchBorder: '#79c0ff',
  activeMatchColorOverviewRuler: '#79c0ff',
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
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [scrollbackFetched, setScrollbackFetched] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'found' | 'not-found'>('idle');
  const isSearchOpenRef = useRef(false);

  const { onData, sendInput, sendResize, reconnecting, onExit: onSessionExit } = useTerminalSession(sessionId);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchStatus('idle');
    terminalRef.current?.focus();
  }, []);

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);

  const runSearch = useCallback((direction: 'next' | 'previous', query: string) => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !query.trim()) {
      setSearchStatus('idle');
      return;
    }

    const found =
      direction === 'previous'
        ? searchAddon.findPrevious(query, {
            regex: false,
            wholeWord: false,
            caseSensitive: false,
            incremental: true,
            decorations: SEARCH_DECORATIONS,
          })
        : searchAddon.findNext(query, {
            regex: false,
            wholeWord: false,
            caseSensitive: false,
            incremental: true,
            decorations: SEARCH_DECORATIONS,
          });

    setSearchStatus(found ? 'found' : 'not-found');
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

    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);

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
    searchAddonRef.current = searchAddon;

    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      const isFindShortcut = (event.metaKey || event.ctrlKey) && key === 'f';

      if (isFindShortcut) {
        setIsSearchOpen(true);
        return false;
      }

      if (event.key === 'Escape' && isSearchOpenRef.current) {
        closeSearch();
        return false;
      }

      return true;
    });

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
      searchAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [closeSearch, sessionId, sendInput, sendResize]);

  useEffect(() => {
    if (!isSearchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [isSearchOpen]);

  useEffect(() => {
    if (!isSearchOpen) return;
    if (!searchQuery.trim()) {
      setSearchStatus('idle');
      return;
    }

    setSearchStatus('searching');
    const timeoutId = window.setTimeout(() => {
      runSearch('next', searchQuery);
    }, 150);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isSearchOpen, runSearch, searchQuery]);

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
      <div
        className={[
          'absolute top-0 inset-x-0 z-10 h-8 border-b border-border bg-surface-200/90 backdrop-blur-sm',
          'flex items-center gap-1 px-2 transition-transform duration-200 ease-out',
          isSearchOpen ? 'translate-y-0' : '-translate-y-full pointer-events-none',
        ].join(' ')}
      >
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSearch();
              return;
            }

            if (event.key === 'Enter') {
              event.preventDefault();
              runSearch(event.shiftKey ? 'previous' : 'next', searchQuery);
            }
          }}
          placeholder="Find in terminal..."
          autoFocus
          className="h-6 flex-1 rounded-md border border-border bg-surface px-2 text-[12px] font-mono text-foreground outline-none ring-0 placeholder:text-muted"
        />
        <button
          type="button"
          onClick={() => runSearch('previous', searchQuery)}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-muted transition-colors hover:text-foreground"
          aria-label="Previous match"
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          onClick={() => runSearch('next', searchQuery)}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-muted transition-colors hover:text-foreground"
          aria-label="Next match"
        >
          <ChevronDown size={16} />
        </button>
        <div className="min-w-[72px] text-center text-[11px] text-muted">
          {searchStatus === 'searching'
            ? 'Searching...'
            : searchStatus === 'found'
              ? 'Match found'
              : searchStatus === 'not-found'
                ? 'No matches'
                : 'Find'}
        </div>
        <button
          type="button"
          onClick={closeSearch}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-muted transition-colors hover:text-foreground"
          aria-label="Close search"
        >
          <X size={16} />
        </button>
      </div>

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
