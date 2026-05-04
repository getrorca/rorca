/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * AnimatedModal: Animated backdrop + modal entry with scaleIn + fadeIn
 * Used for: modals, dialogs, confirmation screens
 * Animation: scale from 95% to 100% + fadeIn (150ms)
 * Exit: scale back down + fadeOut
 */

import { motion, AnimatePresence } from 'framer-motion';
import { scaleIn } from '../lib/animations';

interface AnimatedModalProps {
  isOpen: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  className?: string;
  backdropClassName?: string;
  closeOnBackdropClick?: boolean;
}

export function AnimatedModal({
  isOpen,
  onClose,
  children,
  className = '',
  backdropClassName = '',
  closeOnBackdropClick = true,
}: AnimatedModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={`fixed inset-0 z-40 bg-black/50 ${backdropClassName}`}
            onClick={() => closeOnBackdropClick && onClose?.()}
          />
          {/* Modal content */}
          <motion.div
            variants={scaleIn}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{
              duration: 0.15,
              ease: [0.4, 0, 0.2, 1],
            }}
            className={`fixed inset-0 z-50 flex items-center justify-center pointer-events-none ${className}`}
          >
            <div className="pointer-events-auto">
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default AnimatedModal;
