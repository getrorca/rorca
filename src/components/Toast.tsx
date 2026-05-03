/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, X, XCircle, AlertTriangle, Info, RotateCcw, Copy } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
  persistent?: boolean;
  durationMs?: number;
}

const TOAST_CONFIG: Record<ToastType, {
  icon: typeof Check;
  colorClass: string;
  autoDismissMs: number;
}> = {
  success: {
    icon: Check,
    colorClass: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
    autoDismissMs: 3000,
  },
  error: {
    icon: XCircle,
    colorClass: 'bg-red-500/15 border-red-500/30 text-red-400',
    autoDismissMs: 0, // persistent
  },
  warning: {
    icon: AlertTriangle,
    colorClass: 'bg-amber-500/15 border-amber-500/30 text-amber-400',
    autoDismissMs: 5000,
  },
  info: {
    icon: Info,
    colorClass: 'bg-blue-500/15 border-blue-500/30 text-blue-400',
    autoDismissMs: 3000,
  },
};

const MAX_VISIBLE = 3;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const config = TOAST_CONFIG[toast.type];
  const Icon = config.icon;

  const dismiss = () => {
    setExiting(true);
    setTimeout(() => onDismiss(toast.id), 150);
  };

  useEffect(() => {
    const ms = toast.persistent ? 0 : (toast.durationMs ?? config.autoDismissMs);
    if (ms > 0) {
      timerRef.current = setTimeout(dismiss, ms);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopyError = () => {
    navigator.clipboard.writeText(toast.message);
  };

  return (
    <div
      className={`flex items-start gap-2.5 px-4 py-3 rounded-lg shadow-lg border text-sm font-medium max-w-sm backdrop-blur-sm transition-all duration-150 ${config.colorClass} ${
        exiting ? 'opacity-0 translate-x-4' : 'animate-toast-slide-in'
      }`}
      role={toast.type === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
    >
      <Icon size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="break-words">{toast.message}</p>
        {(toast.action || toast.type === 'error') && (
          <div className="flex items-center gap-2 mt-1.5">
            {toast.action && (
              <button
                onClick={() => { toast.action!.onClick(); dismiss(); }}
                className="text-xs font-semibold underline underline-offset-2 hover:no-underline opacity-80 hover:opacity-100 transition-opacity flex items-center gap-1"
              >
                <RotateCcw size={10} />
                {toast.action.label}
              </button>
            )}
            {toast.type === 'error' && (
              <button
                onClick={handleCopyError}
                className="text-xs opacity-60 hover:opacity-100 transition-opacity flex items-center gap-1"
                title="Copy error message"
                aria-label="Copy error message"
              >
                <Copy size={10} aria-hidden="true" />
                Copy
              </button>
            )}
          </div>
        )}
      </div>
      <button
        onClick={dismiss}
        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity mt-0.5"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  // Show only the newest MAX_VISIBLE toasts
  const visible = toasts.slice(-MAX_VISIBLE);
  if (visible.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2" aria-live="assertive" aria-atomic="false">
      {visible.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
