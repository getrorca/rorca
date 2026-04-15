import { createContext, useContext, useCallback, useRef, useState, type ReactNode } from 'react';
import { ToastContainer, type ToastType, type ToastAction, type Toast } from '../components/Toast';

interface ShowOptions {
  action?: ToastAction;
  persistent?: boolean;
  durationMs?: number;
}

interface ToastContextValue {
  show: (message: string, type?: ToastType, options?: ShowOptions) => void;
  success: (message: string, options?: ShowOptions) => void;
  error: (message: string, options?: ShowOptions) => void;
  warning: (message: string, options?: ShowOptions) => void;
  info: (message: string, options?: ShowOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useGlobalToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useGlobalToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string, type: ToastType = 'success', options?: ShowOptions) => {
    const id = nextId.current++;
    const toast: Toast = {
      id,
      message,
      type,
      action: options?.action,
      persistent: options?.persistent,
      durationMs: options?.durationMs,
    };
    setToasts((prev) => [...prev, toast]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const success = useCallback((message: string, options?: ShowOptions) => show(message, 'success', options), [show]);
  const error = useCallback((message: string, options?: ShowOptions) => show(message, 'error', options), [show]);
  const warning = useCallback((message: string, options?: ShowOptions) => show(message, 'warning', options), [show]);
  const info = useCallback((message: string, options?: ShowOptions) => show(message, 'info', options), [show]);

  return (
    <ToastContext.Provider value={{ show, success, error, warning, info }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
