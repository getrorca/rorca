/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { AlertTriangle, X, RotateCcw } from 'lucide-react';

interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  variant?: 'inline' | 'fullscreen';
}

/**
 * Standardized error banner component.
 *
 * - inline   (default): red banner within panel content area; use for fetch errors
 * - fullscreen: centered card filling the panel; use for critical load failures
 */
export default function ErrorBanner({
  message,
  onRetry,
  onDismiss,
  variant = 'inline',
}: ErrorBannerProps) {
  if (variant === 'fullscreen') {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md w-full bg-panel border border-error/30 rounded-xl p-6 text-center">
          <div className="mx-auto w-10 h-10 rounded-full bg-error/15 flex items-center justify-center mb-4">
            <AlertTriangle size={20} className="text-error" />
          </div>
          <h3 className="text-base font-semibold text-primary mb-2">Failed to load</h3>
          <p className="text-sm text-red-400 mb-4 break-words">{message}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
            >
              <RotateCcw size={14} />
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  // inline (default)
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-error/10 border border-error/25 text-sm text-red-400 mx-4 my-3">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-400" />
      <span className="flex-1 break-words">{message}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1 text-xs font-medium text-red-400 hover:text-red-300 underline underline-offset-2 transition-colors"
          >
            <RotateCcw size={11} />
            Retry
          </button>
        )}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="p-0.5 rounded text-red-400 hover:text-red-300 hover:bg-error/20 transition-colors"
            aria-label="Dismiss error"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
