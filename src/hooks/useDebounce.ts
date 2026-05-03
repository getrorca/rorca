import { useState, useEffect, useRef } from 'react';

/**
 * Debounces a value by the specified delay.
 * Returns the debounced value that only updates after `delay` ms of inactivity.
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timerRef.current ?? undefined);
  }, [value, delay]);

  return debounced;
}
