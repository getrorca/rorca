import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bot, ChevronUp } from 'lucide-react';
import TerminalPanel from '../panels/TerminalPanel';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useTerminalDrawer } from '../contexts/TerminalDrawerContext';
import { apiFetch } from '../lib/apiFetch';

interface TerminalHistorySession {
  sessionId: string;
}

const MIN_HEIGHT = 120;

function getSidebarOffset(breakpoint: ReturnType<typeof useBreakpoint>): string {
  return breakpoint === 'desktop' ? 'var(--sidebar-width, 220px)' : '0px';
}

export default function TerminalDrawer() {
  const location = useLocation();
  // Don't render the drawer when the full-screen terminal panel is active
  const isTerminalPanel = location.pathname === '/terminal';

  const breakpoint = useBreakpoint();
  const { workspaceId } = useWorkspace();
  const {
    isOpen,
    height,
    isFullscreen,
    open,
    close,
    setHeight,
    enterFullscreen,
  } = useTerminalDrawer();
  const [sessionCount, setSessionCount] = useState(0);
  const drawerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const latestHeightRef = useRef(height);

  useEffect(() => {
    latestHeightRef.current = height;
  }, [height]);

  useEffect(() => {
    if (!workspaceId) {
      setSessionCount(0);
      return;
    }

    let cancelled = false;

    const loadSessionCount = async () => {
      try {
        const response = await apiFetch<{ sessions: TerminalHistorySession[] }>(
          `/api/terminal/sessions/history?workspaceId=${encodeURIComponent(workspaceId)}&limit=20`
        );
        if (!cancelled) {
          setSessionCount(response.sessions?.length ?? 0);
        }
      } catch {
        if (!cancelled) {
          setSessionCount(0);
        }
      }
    };

    void loadSessionCount();
    const interval = window.setInterval(() => {
      void loadSessionCount();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workspaceId]);

  const sidebarOffset = useMemo(() => getSidebarOffset(breakpoint), [breakpoint]);
  const showMobileFab = breakpoint === 'mobile' && !isOpen;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    drawerRef.current?.focus();
  }, [isOpen, isFullscreen]);

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isFullscreen || breakpoint === 'mobile') {
      return;
    }

    event.preventDefault();
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (frameRef.current !== null) {
        return;
      }

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        latestHeightRef.current = Math.min(
          Math.max(MIN_HEIGHT, window.innerHeight - moveEvent.clientY),
          Math.floor(window.innerHeight * 0.8),
        );
      });
    };

    const handleMouseUp = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      document.body.style.userSelect = '';
      setHeight(latestHeightRef.current);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  if (!isOpen) {
    if (showMobileFab) {
      return (
        <button
          type="button"
          className="fixed bottom-4 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-accent shadow-lg"
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
        className="fixed bottom-0 z-30 flex h-8 items-center gap-2 border-t border-border bg-panel px-3 cursor-pointer"
        style={{ left: sidebarOffset, right: 0 }}
        onClick={open}
        aria-label="Open OpenCode terminal"
      >
        <Bot size={12} className="text-accent" />
        {sessionCount === 0 ? (
          <span className="text-[11px] font-medium text-[var(--text)]">OpenCode · Click to start</span>
        ) : (
          <span className="text-[11px] font-medium text-[var(--text)]">OpenCode</span>
        )}
        {sessionCount !== 0 ? (
          <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[9px] text-muted">
            {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
          </span>
        ) : null}
        <span className="ml-auto">
          <ChevronUp size={12} className="text-muted" />
        </span>
      </button>
    );
  }

  if (isTerminalPanel) return null;

  return (
    <div
      ref={drawerRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      className="fixed bottom-0 z-30 flex flex-col border-t-2 border-accent/40 bg-panel outline-none"
      style={{
        left: sidebarOffset,
        right: 0,
        top: isFullscreen ? 0 : 'auto',
        bottom: 0,
        height: isFullscreen ? '100vh' : `${height}px`,
        zIndex: isFullscreen ? 50 : 30,
      }}
    >
      {!isFullscreen && (
        <div className="h-1 w-full cursor-ns-resize hover:bg-accent/30" onMouseDown={startResize} />
      )}
      <div className="min-h-0 flex-1">
        <TerminalPanel mode="drawer" onCollapse={close} onExpand={enterFullscreen} />
      </div>
    </div>
  );
}
