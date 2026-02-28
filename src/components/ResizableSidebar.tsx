import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

const STORAGE_KEY = 'rorca:sidebar-width';
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 0;

function getStoredWidth(): number {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = Number(stored);
            if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) return parsed;
        }
    } catch { /* SSR / restricted */ }
    return DEFAULT_WIDTH;
}

interface ResizableSidebarProps {
    children: ReactNode;
    className?: string;
}

export default function ResizableSidebar({ children, className = '' }: ResizableSidebarProps) {
    const [width, setWidth] = useState(getStoredWidth);
    const [collapsed, setCollapsed] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isHovering, setIsHovering] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const startXRef = useRef(0);
    const startWidthRef = useRef(0);

    // Persist width when it changes (only when not collapsed)
    useEffect(() => {
        if (!collapsed) {
            try { localStorage.setItem(STORAGE_KEY, String(width)); } catch { /* noop */ }
        }
    }, [width, collapsed]);

    const onMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        startXRef.current = e.clientX;
        startWidthRef.current = collapsed ? MIN_WIDTH : width;
        setIsDragging(true);

        if (collapsed) {
            setCollapsed(false);
            setWidth(MIN_WIDTH);
        }
    }, [width, collapsed]);

    // Global mousemove / mouseup while dragging
    useEffect(() => {
        if (!isDragging) return;

        const onMouseMove = (e: MouseEvent) => {
            const delta = e.clientX - startXRef.current;
            const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
            setWidth(newWidth);
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

    // Double-click to toggle collapse
    const onDoubleClick = useCallback(() => {
        setCollapsed((prev) => !prev);
    }, []);

    const effectiveWidth = collapsed ? COLLAPSED_WIDTH : width;

    return (
        <div
            ref={containerRef}
            className={`relative shrink-0 h-full hidden md:flex ${className}`}
            style={{
                width: effectiveWidth,
                transition: isDragging ? 'none' : 'width 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
        >
            {/* Sidebar content — hidden when fully collapsed */}
            <div
                className="h-full overflow-hidden"
                style={{
                    width: collapsed ? 0 : width,
                    minWidth: collapsed ? 0 : width,
                    opacity: collapsed ? 0 : 1,
                    transition: isDragging ? 'none' : 'opacity 150ms ease, width 200ms cubic-bezier(0.16, 1, 0.3, 1)',
                }}
            >
                {children}
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
                title="Drag to resize"
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
