/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef, useCallback, useState, useId, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface SlideOverProps {
    isOpen: boolean;
    onClose: () => void;
    title?: React.ReactNode;
    ariaLabel?: string;
    hideHeader?: boolean;
    desktopMaxWidth?: number;
    /** Opt-in sheet behavior for surfaces whose tablet layout cannot retain useful background context. */
    fullScreenBelowDesktop?: boolean;
    /** Keeps the desktop board pointer-accessible while the non-modal detail panel is open. */
    allowBackgroundInteraction?: boolean;
    contentClassName?: string;
    restoreFocusRef?: RefObject<HTMLElement | null>;
    children: React.ReactNode;
}

const SWIPE_THRESHOLD = 100; // px to swipe down before triggering close

export default function SlideOver({
    isOpen,
    onClose,
    title,
    ariaLabel,
    hideHeader,
    desktopMaxWidth,
    fullScreenBelowDesktop = false,
    allowBackgroundInteraction = false,
    contentClassName = '',
    restoreFocusRef,
    children,
}: SlideOverProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const breakpoint = useBreakpoint();
    const isMobile = breakpoint === 'mobile';
    const isFullScreen = isMobile || (fullScreenBelowDesktop && breakpoint === 'tablet');
    const titleId = useId();

    // Focus trap — captures focus inside the dialog, restores on close
    const focusTrapRef = useFocusTrap<HTMLDivElement>(isOpen, restoreFocusRef);

    // Swipe-to-close state
    const [swipeY, setSwipeY] = useState(0);
    const touchStartRef = useRef<{ y: number; scrollTop: number } | null>(null);

    // Handle Escape key
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            const anotherModalIsOpen = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
                .some((modal) => modal !== focusTrapRef.current);
            if (anotherModalIsOpen) return;
            onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [focusTrapRef, isOpen, onClose]);

    // Prevent body scroll while open
    useEffect(() => {
        if (!isOpen || (allowBackgroundInteraction && !isFullScreen)) return;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = ''; };
    }, [allowBackgroundInteraction, isFullScreen, isOpen]);

    // Handle click outside panel (desktop only)
    const handleBackdropClick = (e: React.MouseEvent) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
            onClose();
        }
    };

    // Mobile swipe-down-to-close gesture handlers
    const onTouchStart = useCallback((e: React.TouchEvent) => {
        if (!isMobile) return;
        const contentEl = panelRef.current?.querySelector('[data-slide-content]');
        touchStartRef.current = {
            y: e.touches[0].clientY,
            scrollTop: contentEl?.scrollTop ?? 0,
        };
    }, [isMobile]);

    const onTouchMove = useCallback((e: React.TouchEvent) => {
        if (!isMobile || !touchStartRef.current) return;
        // Only allow swipe when content is scrolled to top
        if (touchStartRef.current.scrollTop > 0) return;
        const delta = e.touches[0].clientY - touchStartRef.current.y;
        if (delta > 0) {
            setSwipeY(delta);
        }
    }, [isMobile]);

    const onTouchEnd = useCallback(() => {
        if (!isMobile) return;
        if (swipeY > SWIPE_THRESHOLD) {
            onClose();
        }
        setSwipeY(0);
        touchStartRef.current = null;
    }, [isMobile, swipeY, onClose]);

    // Reset swipe on close
    useEffect(() => {
        if (!isOpen) setSwipeY(0);
    }, [isOpen]);

    if (!isOpen) return null;

    const dialogTitle = title || 'Details';

    // Mobile: full-screen slide-up with swipe-down-to-close
    if (isFullScreen) {
        const opacity = swipeY > 0 ? Math.max(0.2, 1 - swipeY / 300) : 1;

        return createPortal(
            <aside
                ref={focusTrapRef}
                className="fixed inset-0 z-[100] flex flex-col"
                aria-modal="true"
                role="dialog"
                aria-labelledby={!hideHeader ? titleId : undefined}
                aria-label={hideHeader ? (ariaLabel ?? 'Detail panel') : undefined}
            >
                {/* Backdrop */}
                <div
                    className="absolute inset-0 bg-black/60 transition-opacity"
                    style={{ opacity }}
                    onClick={onClose}
                    aria-hidden="true"
                />

                {/* Full-screen panel */}
                <div
                    ref={panelRef}
                    className="relative flex flex-col w-full h-full bg-bg animate-slide-up-full"
                    style={{
                        transform: swipeY > 0 ? `translateY(${swipeY}px)` : undefined,
                        transition: swipeY > 0 ? 'none' : 'transform var(--motion-duration-drawer) var(--motion-ease-out)',
                    }}
                    onTouchStart={onTouchStart}
                    onTouchMove={onTouchMove}
                    onTouchEnd={onTouchEnd}
                >
                    {/* Swipe handle + close bar */}
                    <div className="flex flex-col items-center pt-2 pb-1 shrink-0 bg-bg">
                        {/* Swipe indicator pill */}
                        <div className="w-10 h-1 rounded-full bg-muted/40 mb-2" aria-hidden="true" />
                        <div className="flex items-center justify-between w-full px-4">
                            <button
                                onClick={onClose}
                                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md text-muted hover:text-[var(--text)] transition-colors"
                                aria-label="Close panel"
                            >
                                <X size={22} aria-hidden="true" />
                            </button>
                            {!hideHeader && (
                                <h2 id={titleId} className="text-base font-semibold text-[var(--text)] tracking-tight flex-1 text-center mr-11">
                                    {dialogTitle}
                                </h2>
                            )}
                        </div>
                    </div>

                    {/* Content */}
                    <div data-slide-content className={`flex-1 min-h-0 overflow-y-auto contain-layout ${contentClassName}`}>
                        {children}
                    </div>
                </div>
            </aside>,
            document.body
        );
    }

    // Desktop + Tablet: right-aligned slide panel with an optional consumer-specific bound.
    const maxWidth = desktopMaxWidth ?? (breakpoint === 'tablet' ? 480 : 800);

    return createPortal(
        <aside
            ref={focusTrapRef}
            className={`fixed inset-0 z-[100] flex justify-end ${allowBackgroundInteraction ? 'pointer-events-none' : ''}`}
            onClick={allowBackgroundInteraction ? undefined : handleBackdropClick}
            aria-modal={allowBackgroundInteraction ? undefined : 'true'}
            role="dialog"
            aria-labelledby={!hideHeader ? titleId : undefined}
            aria-label={hideHeader ? (ariaLabel ?? 'Detail panel') : undefined}
        >
            {/* Heavy overlay shadow */}
            {!allowBackgroundInteraction && <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" aria-hidden="true" />}

            {/* Slide panel */}
            <div
                ref={panelRef}
                className="pointer-events-auto relative flex h-full w-full flex-col border-l border-border bg-bg animate-slideInRight shadow-[0_0_64px_rgba(0,0,0,0.8)]"
                style={{ maxWidth }}
            >
                {/* Header */}
                {!hideHeader && (
                    <header className="flex justify-start px-6 py-4 border-b border-border bg-panel shrink-0 gap-3 items-center">
                        <button
                            onClick={onClose}
                            className="w-8 h-8 flex items-center justify-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-200 transition-colors mr-2"
                            aria-label="Close panel"
                        >
                            <X size={20} aria-hidden="true" />
                        </button>
                        <h2 id={titleId} className="text-lg font-semibold text-[var(--text)] tracking-tight">
                            {dialogTitle}
                        </h2>
                    </header>
                )}

                {/* Content */}
                <div data-slide-content className={`flex-1 min-h-0 overflow-y-auto contain-layout ${contentClassName}`}>
                    {children}
                </div>
            </div>
        </aside>,
        document.body
    );
}
