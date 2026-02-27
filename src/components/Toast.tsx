import { useState, useCallback, useRef } from 'react';
import { Check, X } from 'lucide-react';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, show, dismiss };
}

export function ToastContainer({
  toasts,
  onDismiss,
  position = 'bottom-right',
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  position?: 'bottom-right' | 'top-right';
}) {
  if (toasts.length === 0) return null;

  const posClass = position === 'top-right' ? 'fixed top-4 right-4' : 'fixed bottom-4 right-4';
  const animClass = position === 'top-right' ? 'animate-slide-in-top-right' : 'animate-[slideUp_200ms_ease-out]';

  return (
    <div className={`${posClass} z-50 flex flex-col gap-2`}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg border text-sm font-medium ${animClass} ${
            toast.type === 'success'
              ? 'bg-success/15 border-success/30 text-success'
              : 'bg-error/15 border-error/30 text-error'
          }`}
        >
          {toast.type === 'success' ? <Check size={14} /> : <X size={14} />}
          {toast.message}
          <button
            onClick={() => onDismiss(toast.id)}
            className="ml-2 opacity-60 hover:opacity-100 transition-opacity"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
