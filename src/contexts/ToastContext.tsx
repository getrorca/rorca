import { createContext, useContext, useCallback, useRef, useState, type ReactNode } from 'react';
import { ToastContainer, type ToastType, type ToastAction, type Toast } from '../components/Toast';

interface ShowOptions {
  action?: ToastAction;
  persistent?: boolean;
}

interface ToastContextValue {
  show: (message: string, type?: ToastType, options?: ShowOptions) => void;
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
    };
    setToasts((prev) => [...prev, toast]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
