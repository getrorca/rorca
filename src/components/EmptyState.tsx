/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import type { ElementType, ReactNode } from 'react';

/* ─── Shared Empty State Component ──────────────────────────────── */

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: ElementType;
}

interface EmptyStateProps {
  icon: ElementType;
  heading: string;
  subtext?: string;
  action?: EmptyStateAction;
  /** 'full' = centered in container, 'section' = inline section, 'column' = minimal column placeholder */
  variant?: 'full' | 'section' | 'column';
  /** Optional children rendered below subtext, above action */
  children?: ReactNode;
}

export default function EmptyState({
  icon: Icon,
  heading,
  subtext,
  action,
  variant = 'full',
  children,
}: EmptyStateProps) {
  if (variant === 'column') {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Icon size={32} className="text-muted/30 mb-2" />
        <p className="text-sm text-muted">{heading}</p>
      </div>
    );
  }

  const isSection = variant === 'section';

  return (
    <div
      className={
        isSection
          ? 'flex flex-col items-center justify-center py-12 text-center px-4'
          : 'flex flex-col items-center justify-center h-full min-h-[300px] text-center px-6'
      }
    >
      <div className="flex flex-col items-center max-w-[400px]">
        <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
          <Icon size={28} className="text-accent" />
        </div>
        <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">
          {heading}
        </h3>
        {subtext && (
          <p className="text-sm text-muted leading-relaxed">{subtext}</p>
        )}
        {children}
        {action && (
          <button
            onClick={action.onClick}
            className="mt-4 flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            {action.icon && <action.icon size={14} />}
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
