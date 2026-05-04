/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * AnimatedToast: Toast notification with slideRight entry and fadeOut exit
 * Used for: success messages, error alerts, notifications
 * Animation: slideRight from left (100ms), exit fadeOut (100ms)
 */

import { motion, AnimatePresence } from 'framer-motion';

interface AnimatedToastProps {
  isOpen: boolean;
  message: string;
  type?: 'success' | 'error' | 'info' | 'warning';
  onClose?: () => void;
  duration?: number; // Auto-close duration in ms (0 = manual only)
  className?: string;
}

const typeStyles: Record<string, { bg: string; text: string; icon: string }> = {
  success: {
    bg: 'bg-emerald-500/90',
    text: 'text-white',
    icon: '✓',
  },
  error: {
    bg: 'bg-red-500/90',
    text: 'text-white',
    icon: '✕',
  },
  info: {
    bg: 'bg-blue-500/90',
    text: 'text-white',
    icon: 'ℹ',
  },
  warning: {
    bg: 'bg-amber-500/90',
    text: 'text-white',
    icon: '⚠',
  },
};

export function AnimatedToast({
  isOpen,
  message,
  type = 'info',
  onClose,
  duration = 3000,
  className = '',
}: AnimatedToastProps) {
  const style = typeStyles[type] || typeStyles.info;

  const handleAnimationComplete = () => {
    if (duration > 0 && onClose) {
      setTimeout(onClose, duration);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 16 }}
          transition={{
            duration: 0.1,
            ease: [0.4, 0, 0.2, 1],
          }}
          className={`fixed bottom-4 left-4 z-50 ${className}`}
          onAnimationComplete={handleAnimationComplete}
        >
          <div
            className={`flex items-center gap-2 px-4 py-3 rounded-lg ${style.bg} ${style.text} shadow-lg font-medium text-sm`}
          >
            <span>{style.icon}</span>
            <span>{message}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default AnimatedToast;
