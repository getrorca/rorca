import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronUp } from 'lucide-react';
import TerminalPanel from '../panels/TerminalPanel';
import { useTerminalDrawer } from '../contexts/TerminalDrawerContext';
import { useBreakpoint } from '../hooks/useBreakpoint';

const MIN_HEIGHT = 120;

interface TerminalSessionRecord {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  createdAt: string;
  exited?: boolean;
}

interface TerminalSessionsResponse {
  sessions?: TerminalSessionRecord[];
}

export default function TerminalDrawer() {
  const { isOpen, height, isFullscreen, open, close, setHeight, enterFullscreen } = useTerminalDrawer();
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === 'mobile';
  const [sessionCount, setSessionCount] = useState(0);
  const frameRef = useRef<number | null>(null);
  const pendingHeightRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const updateSessions = async () => {
      try {
        const response = await fetch('/api/terminal/sessions', { credentials: 'same-origin' });
        if (!response.ok) return;
        const data = await response.json() as TerminalSessionsResponse;
        if (!cancelled) {
          setSessionCount((data.sessions ?? []).filter((session) => !session.exited).length);
        }
      } catch {
      }
    };

    void updateSessions();
    const interval = window.setInterval(() => { void updateSessions(); }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      containerRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleToggle = () => {
      if (isOpen) close();
      else open();
    };
    window.addEventListener('rorca:toggle-drawer', handleToggle);
    return () => window.removeEventListener('rorca:toggle-drawer', handleToggle);
  }, [isOpen, open, close]);

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    document.body.style.userSelect = 'none';

    const commitPendingHeight = () => {
      if (pendingHeightRef.current != null) {
        setHeight(pendingHeightRef.current);
        pendingHeightRef.current = null;
      }
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextHeight = Math.max(MIN_HEIGHT, Math.min(window.innerHeight * 0.8, window.innerHeight - moveEvent.clientY));
      pendingHeightRef.current = nextHeight;
      if (frameRef.current != null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
      });
    };

    const onMouseUp = () => {
      commitPendingHeight();
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleLabel = useMemo(() => {
    if (sessionCount === 0) return 'OpenCode · Click to start';
    return 'OpenCode';
  }, [sessionCount]);

  const drawerStyle = isFullscreen
    ? { left: 'var(--sidebar-width, 220px)' }
    : { left: 'var(--sidebar-width, 220px)', height: `${height}px` };

  if (!isOpen) {
    if (isMobile) {
      return (
        <button
          className="fixed bottom-4 right-4 z-50 w-14 h-14 rounded-full bg-accent shadow-lg flex items-center justify-center"
          onClick={open}
          aria-label="Open OpenCode terminal"
        >
          <Bot size={24} className="text-white" />
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={open}
        className="fixed bottom-0 right-0 z-30 h-8 cursor-pointer border-t border-border bg-panel px-3 flex items-center gap-2"
        style={{ left: 'var(--sidebar-width, 220px)' }}
        aria-label="Open OpenCode terminal drawer"
      >
        <Bot size={12} className="text-accent shrink-0" />
        <span className="text-[12px] text-text">{handleLabel}</span>
        {sessionCount > 0 && (
          <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[9px] text-muted">
            {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
          </span>
        )}
        <span className="ml-auto">
          <ChevronUp size={12} className="text-muted" />
        </span>
      </button>
    );
  }

  return (
    <div
      ref={containerRef}
      className={isFullscreen
        ? 'fixed inset-0 right-0 z-50 flex flex-col border-t-2 border-accent/40 bg-panel'
        : 'fixed bottom-0 right-0 z-30 flex flex-col border-t-2 border-accent/40 bg-panel'}
      style={drawerStyle}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      tabIndex={-1}
    >
      {!isFullscreen && (
        <div className="w-full h-1 cursor-ns-resize hover:bg-accent/30" onMouseDown={handleMouseDown} />
      )}
      <div className="flex-1 min-h-0">
        <TerminalPanel mode="drawer" onCollapse={close} onExpand={enterFullscreen} />
      </div>
    </div>
  );
}
