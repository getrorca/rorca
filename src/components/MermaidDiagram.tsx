/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Clipboard,
  Check,
} from 'lucide-react';

interface MermaidDiagramProps {
  diagram: { text: string; type: 'mermaid' | 'ascii' } | null;
  idPrefix?: string;
}

export default function MermaidDiagram({ diagram, idPrefix = 'mermaid' }: MermaidDiagramProps) {
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState('');
  const [renderError, setRenderError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!diagram || diagram.type !== 'mermaid' || !mermaidRef.current) return;
    let cancelled = false;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          themeVariables: {
            primaryColor: '#6366f1',
            primaryTextColor: '#fafafa',
            primaryBorderColor: '#3f3f46',
            lineColor: '#a1a1aa',
            secondaryColor: '#1c1c21',
            tertiaryColor: '#0f0f11',
          },
        });
        const id = `${idPrefix}-${Date.now()}`;
        const { svg } = await mermaid.render(id, diagram.text);
        if (!cancelled) {
          setSvgContent(svg);
          setRenderError('');
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : 'Failed to render');
          setSvgContent('');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [diagram, idPrefix]);

  // Reset zoom/pan when diagram changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [diagram]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.min(3, Math.max(0.25, z + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  }, [dragging]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const handleZoomIn = useCallback(() => setZoom(z => Math.min(3, z + 0.25)), []);
  const handleZoomOut = useCallback(() => setZoom(z => Math.max(0.25, z - 0.25)), []);
  const handleReset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  const handleCopyMermaid = useCallback(async () => {
    if (!diagram) return;
    await navigator.clipboard.writeText(diagram.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [diagram]);

  if (!diagram) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No dependency diagram available for this spec
      </div>
    );
  }

  if (diagram.type === 'ascii') {
    return (
      <div className="p-4">
        <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre">
          {diagram.text}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0">
        <button
          onClick={handleZoomIn}
          className="p-1.5 rounded text-muted hover:text-text hover:bg-panel transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button
          onClick={handleZoomOut}
          className="p-1.5 rounded text-muted hover:text-text hover:bg-panel transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <button
          onClick={handleReset}
          className="p-1.5 rounded text-muted hover:text-text hover:bg-panel transition-colors"
          title="Reset view"
        >
          <Maximize2 size={14} />
        </button>
        <span className="text-[10px] text-muted font-mono ml-1">{Math.round(zoom * 100)}%</span>
        <div className="flex-1" />
        <button
          onClick={handleCopyMermaid}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-muted hover:text-text border border-border hover:bg-panel transition-colors"
          title="Copy Mermaid source"
        >
          {copied ? <Check size={12} /> : <Clipboard size={12} />}
          {copied ? 'Copied' : 'Copy Mermaid'}
        </button>
      </div>

      {/* Diagram viewport */}
      <div
        className="flex-1 overflow-hidden bg-panel cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {renderError ? (
          <div className="p-4 text-sm text-error">
            <p className="font-medium mb-1">Render error</p>
            <pre className="text-xs font-mono whitespace-pre-wrap">{renderError}</pre>
          </div>
        ) : (
          <div
            ref={mermaidRef}
            className="p-4 origin-top-left select-none"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transition: dragging ? 'none' : 'transform 0.15s ease-out',
            }}
            dangerouslySetInnerHTML={{ __html: svgContent }}
          />
        )}
      </div>
    </div>
  );
}
