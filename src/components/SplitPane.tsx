/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';

const STORAGE_KEY = 'rorca-split-pane-ratio';
const DEFAULT_RATIO = 0.6;
const MIN_PX = 200;

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
}

export default function SplitPane({ left, right }: SplitPaneProps) {
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const [ratio, setRatio] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const val = parseFloat(stored);
        if (val >= 0.1 && val <= 0.9) return val;
      }
    } catch { /* ignore */ }
    return DEFAULT_RATIO;
  });

  // Persist ratio on change
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(ratio)); } catch { /* ignore */ }
  }, [ratio]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const containerWidth = rect.width;
      const x = e.clientX - rect.left;

      // Enforce min width on both sides
      const clampedX = Math.max(MIN_PX, Math.min(x, containerWidth - MIN_PX));
      setRatio(clampedX / containerWidth);
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Mobile: vertical stack — terminal 60vh top, story list scrollable below
  if (isMobile) {
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        {/* Top pane: terminal at 60vh */}
        <div className="shrink-0" style={{ height: '60vh' }}>
          <div className="h-full overflow-hidden">{left}</div>
        </div>
        {/* Bottom pane: story list, scrollable */}
        <div className="shrink-0 border-t border-border" style={{ minHeight: '40vh' }}>
          {right}
        </div>
      </div>
    );
  }

  // Desktop: horizontal split pane with draggable divider
  return (
    <div ref={containerRef} className="flex-1 min-h-0 flex flex-row relative">
      {/* Left pane */}
      <div style={{ width: `${ratio * 100}%`, minWidth: MIN_PX }} className="h-full min-w-0 overflow-hidden">
        {left}
      </div>

      {/* Draggable divider */}
      <div
        onMouseDown={onMouseDown}
        className="shrink-0 w-[5px] h-full cursor-col-resize relative group z-10
                   border-x border-border bg-panel hover:bg-accent/20 transition-colors"
      >
        {/* Grab handle — three dots */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-[3px]">
          <span className="block w-[3px] h-[3px] rounded-full bg-muted group-hover:bg-accent transition-colors" />
          <span className="block w-[3px] h-[3px] rounded-full bg-muted group-hover:bg-accent transition-colors" />
          <span className="block w-[3px] h-[3px] rounded-full bg-muted group-hover:bg-accent transition-colors" />
        </div>
      </div>

      {/* Right pane */}
      <div style={{ width: `${(1 - ratio) * 100}%`, minWidth: MIN_PX }} className="h-full min-w-0 overflow-hidden">
        {right}
      </div>
    </div>
  );
}
