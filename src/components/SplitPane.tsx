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

const KEYBOARD_RATIO_STEP = 0.05;
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
  const [ratioBounds, setRatioBounds] = useState({ minimum: 0.1, maximum: 0.9 });

  // Persist ratio on change
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(ratio)); } catch { /* ignore */ }
  }, [ratio]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateBounds = () => {
      const width = container.getBoundingClientRect().width;
      if (width <= 0) return;
      const minimum = Math.min(0.5, MIN_PX / width);
      const maximum = Math.max(0.5, 1 - minimum);
      setRatioBounds((current) => current.minimum === minimum && current.maximum === maximum
        ? current
        : { minimum, maximum });
      setRatio((current) => Math.max(minimum, Math.min(maximum, current)));
    };
    updateBounds();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateBounds);
    observer?.observe(container);
    window.addEventListener('resize', updateBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const onSeparatorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const containerWidth = containerRef.current.getBoundingClientRect().width;
    if (containerWidth <= 0) return;
    const minimumRatio = Math.min(0.5, MIN_PX / containerWidth);
    const maximumRatio = Math.max(0.5, 1 - minimumRatio);
    setRatioBounds({ minimum: minimumRatio, maximum: maximumRatio });
    if (event.key === 'Home') {
      setRatio(minimumRatio);
      return;
    }
    if (event.key === 'End') {
      setRatio(maximumRatio);
      return;
    }
    setRatio((current) => Math.max(
      minimumRatio,
      Math.min(maximumRatio, current + (event.key === 'ArrowRight' ? KEYBOARD_RATIO_STEP : -KEYBOARD_RATIO_STEP)),
    ));
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const containerWidth = rect.width;
      if (containerWidth <= 0) return;
      const x = e.clientX - rect.left;
      const minimumRatio = Math.min(0.5, MIN_PX / containerWidth);
      const maximumRatio = Math.max(0.5, 1 - minimumRatio);
      setRatioBounds({ minimum: minimumRatio, maximum: maximumRatio });
      setRatio(Math.max(minimumRatio, Math.min(maximumRatio, x / containerWidth)));
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

  const announcedMinimum = Math.ceil(ratioBounds.minimum * 100);
  const announcedMaximum = Math.floor(ratioBounds.maximum * 100);
  const announcedRatio = Math.max(announcedMinimum, Math.min(announcedMaximum, Math.round(ratio * 100)));

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
        onKeyDown={onSeparatorKeyDown}
        role="separator"
        aria-label="Resize run detail panels"
        aria-orientation="vertical"
        aria-valuemin={announcedMinimum}
        aria-valuemax={announcedMaximum}
        aria-valuenow={announcedRatio}
        aria-valuetext={`${announcedRatio} percent left panel`}
        tabIndex={0}
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
