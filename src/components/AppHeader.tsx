/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Menu } from 'lucide-react';
import WorkspaceSelector from './WorkspaceSelector';

interface AppHeaderProps {
    onMenuToggle?: () => void;
    showMenuButton?: boolean;
    breadcrumbs?: React.ReactNode;
    actions?: React.ReactNode;
    rightSlot?: React.ReactNode; // e.g. NetworkIndicator, PlanBadge, UserMenu passed from Shell
}

export default function AppHeader({ onMenuToggle, showMenuButton, breadcrumbs, actions, rightSlot }: AppHeaderProps) {
    return (
        <header className="h-12 flex items-center justify-between px-3 sm:px-4 bg-bg border-b border-border shrink-0 font-sans">
            {/* Left: Hamburger + Breadcrumbs */}
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                {showMenuButton && (
                    <button
                        onClick={onMenuToggle}
                        className="md:hidden w-11 h-11 flex items-center justify-center text-[var(--text)] hover:bg-surface-200 transition-colors -ml-1 rounded-md shrink-0"
                        aria-label="Open navigation menu"
                    >
                        <Menu size={20} />
                    </button>
                )}

                <div className="hidden md:flex items-center gap-2 min-w-0 flex-1 truncate">
                    {breadcrumbs ? (
                        breadcrumbs
                    ) : (
                        <span className="font-medium text-[var(--text)] text-sm tracking-tight select-none">
                            Rorca
                        </span>
                    )}
                </div>

                {/* Mobile fallback Workspace Selector */}
                <div className="md:hidden shrink-0">
                    <WorkspaceSelector />
                </div>
            </div>

            {/* Center: Contextual Actions (e.g. Save buttons, Toggles) */}
            {actions && (
                <div className="hidden sm:flex items-center gap-2 flex-1 justify-center">
                    {actions}
                </div>
            )}

            {/* Right: Global Controls (Network, Theme, User) */}
            <div className="flex items-center gap-1 sm:gap-2 shrink-0 justify-end flex-1 sm:flex-none">
                {rightSlot}
            </div>
        </header>
    );
}
