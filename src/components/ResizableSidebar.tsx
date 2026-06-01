/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useCallback, useEffect, createContext, useContext, type ReactNode } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';

// Context so child components (e.g. Sidebar) can read collapsed state without prop drilling
export const SidebarCollapsedContext = createContext(false);
export function useSidebarCollapsed() { return useContext(SidebarCollapsedContext); }

const STORAGE_KEY = 'rorca:sidebar-state';
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 48;
const COLLAPSE_THRESHOLD = 80;

interface SidebarState {
    collapsed: boolean;
    lastWidth: number;
}

function getStoredState(): SidebarState {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored) as Partial<SidebarState>;
            const lastWidth = typeof parsed.lastWidth === 'number' && parsed.lastWidth >= MIN_WIDTH && parsed.lastWidth <= MAX_WIDTH
                ? parsed.lastWidth
                : DEFAULT_WIDTH;
            return { collapsed: Boolean(parsed.collapsed), lastWidth };
        }
    } catch { /* SSR / restricted */ }
    return { collapsed: false, lastWidth: DEFAULT_WIDTH };
}

function saveStoredState(state: SidebarState): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* noop */ }
}

interface ResizableSidebarProps {
    children: ReactNode;
    className?: string;
}

export default function ResizableSidebar({ children, className = '' }: ResizableSidebarProps) {
    const breakpoint = useBreakpoint();
    const storedStateRef = useRef<SidebarState | null>(null);
    if (storedStateRef.current === null) storedStateRef.current = getStoredState();
    const storedState = storedStateRef.current;
    const [width, setWidth] = useState(storedState.lastWidth);
    const [collapsed, setCollapsed] = useState(storedState.collapsed);
    const [isDragging, setIsDragging] = useState(false);
    const [isHovering, setIsHovering] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const startXRef = useRef(0);
    const startWidthRef = useRef(0);
    const lastExpandedWidthRef = useRef(storedState.lastWidth);

    // Persist state whenever collapsed or width changes
    useEffect(() => {
        saveStoredState({ collapsed, lastWidth: lastExpandedWidthRef.current });
    }, [collapsed, width]);

    const onMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        startXRef.current = e.clientX;
        // When collapsed, treat starting width as COLLAPSED_WIDTH for delta calculation
        startWidthRef.current = collapsed ? COLLAPSED_WIDTH : width;
        setIsDragging(true);
    }, [width, collapsed]);

    // Global mousemove / mouseup while dragging
    useEffect(() => {
        if (!isDragging) return;

        const onMouseMove = (e: MouseEvent) => {
            const delta = e.clientX - startXRef.current;
            const rawWidth = startWidthRef.current + delta;

            if (rawWidth < COLLAPSE_THRESHOLD) {
                // Snap to collapsed
                setCollapsed(true);
            } else {
                // Expanded: clamp between MIN_WIDTH and MAX_WIDTH
                const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, rawWidth));
                setCollapsed(false);
                setWidth(newWidth);
                lastExpandedWidthRef.current = newWidth;
            }
        };

        const onMouseUp = () => {
            setIsDragging(false);
        };

        // Prevent text selection while dragging
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        return () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [isDragging]);

    // Double-click to toggle collapse — also persists to localStorage immediately
    const onDoubleClick = useCallback(() => {
        setCollapsed((prev) => {
            const next = !prev;
            if (prev) {
                // Expanding: restore last expanded width
                setWidth(lastExpandedWidthRef.current);
                saveStoredState({ collapsed: false, lastWidth: lastExpandedWidthRef.current });
            } else {
                // Collapsing
                saveStoredState({ collapsed: true, lastWidth: lastExpandedWidthRef.current });
            }
            return next;
        });
    }, []);

    // Mobile + Tablet: Sidebar handles its own layout — ResizableSidebar just passes children through
    if (breakpoint === 'mobile' || breakpoint === 'tablet') {
        return <>{children}</>;
    }

    // Desktop: resizable wrapper with drag handle
    const effectiveWidth = collapsed ? COLLAPSED_WIDTH : width;

    return (
        <div
            ref={containerRef}
            className={`relative shrink-0 h-full flex ${className}`}
            style={{
                width: effectiveWidth,
                ['--sidebar-width' as string]: `${effectiveWidth}px`,
                transition: isDragging ? 'none' : 'width 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
        >
            {/* Sidebar content — clipped to COLLAPSED_WIDTH when collapsed */}
            <div
                className="h-full overflow-hidden"
                style={{
                    width: collapsed ? COLLAPSED_WIDTH : width,
                    minWidth: collapsed ? COLLAPSED_WIDTH : width,
                    opacity: 1,
                    transition: isDragging ? 'none' : 'width 200ms cubic-bezier(0.16, 1, 0.3, 1)',
                }}
            >
                <SidebarCollapsedContext.Provider value={collapsed}>
                    {children}
                </SidebarCollapsedContext.Provider>
            </div>

            {/* Drag handle — always visible on the right edge */}
            <div
                className="absolute top-0 right-0 w-[5px] h-full z-30 group"
                style={{ cursor: 'col-resize' }}
                onMouseDown={onMouseDown}
                onDoubleClick={onDoubleClick}
                onMouseEnter={() => setIsHovering(true)}
                onMouseLeave={() => setIsHovering(false)}
                role="separator"
                aria-orientation="vertical"
                aria-valuenow={effectiveWidth}
                aria-valuemin={MIN_WIDTH}
                aria-valuemax={MAX_WIDTH}
                title={`Drag to resize · Double-click to ${collapsed ? 'expand' : 'collapse'}`}
            >
                {/* Visual indicator line */}
                <div
                    className="absolute top-0 right-0 w-[2px] h-full transition-colors duration-150"
                    style={{
                        backgroundColor: isDragging
                            ? 'var(--accent)'
                            : isHovering
                                ? 'var(--accent)'
                                : 'transparent',
                    }}
                />

                {/* Tooltip on hover (non-dragging) */}
                {isHovering && !isDragging && (
                    <div
                        className="absolute top-1/2 -translate-y-1/2 left-3 bg-surface-200 border border-border text-[var(--text)] text-xs px-2.5 py-1.5 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none"
                        style={{ animation: 'fadeIn 150ms ease' }}
                    >
                        <div className="font-medium">Drag to resize</div>
                        <div className="text-muted text-[10px] mt-0.5">Double-click to {collapsed ? 'expand' : 'collapse'}</div>
                    </div>
                )}
            </div>
        </div>
    );
}
