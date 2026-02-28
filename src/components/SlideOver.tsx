import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface SlideOverProps {
    isOpen: boolean;
    onClose: () => void;
    title?: React.ReactNode;
    hideHeader?: boolean;
    children: React.ReactNode;
}

export default function SlideOver({ isOpen, onClose, title, hideHeader, children }: SlideOverProps) {
    const panelRef = useRef<HTMLDivElement>(null);

    // Handle Escape key
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Handle click outside panel
    const handleBackdropClick = (e: React.MouseEvent) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
            onClose();
        }
    };

    if (!isOpen) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[100] flex justify-end"
            onClick={handleBackdropClick}
            aria-modal="true"
            role="dialog"
        >
            {/* Heavy overlay shadow as requested by King Mode spec */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" />

            {/* Slide panel */}
            <div
                ref={panelRef}
                className="relative flex flex-col w-full max-w-[800px] h-full bg-bg border-l border-border animate-slideInRight shadow-[0_0_64px_rgba(0,0,0,0.8)]"
            >
                {/* Header */}
                {!hideHeader && (
                    <div className="flex justify-start px-6 py-4 border-b border-border bg-panel shrink-0 gap-3 items-center">
                        <button
                            onClick={onClose}
                            className="w-8 h-8 flex items-center justify-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-200 transition-colors mr-2"
                            aria-label="Close panel"
                        >
                            <X size={20} />
                        </button>
                        <h2 className="text-lg font-semibold text-[var(--text)] tracking-tight">
                            {title || 'Details'}
                        </h2>
                    </div>
                )}

                {/* Content */}
                <div className="flex-1 overflow-y-auto contain-layout">
                    {children}
                </div>
            </div>
        </div>,
        document.body
    );
}
