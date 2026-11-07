/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download } from 'lucide-react';
import { scaleIn } from '../lib/animations';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface ImagePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  filename: string;
}

export function ImagePreviewModal({ isOpen, onClose, imageUrl, filename }: ImagePreviewModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(isOpen, undefined, { onEscape: onClose });


  // Focus close button when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => closeButtonRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Prevent body scroll
  useEffect(() => {
    if (isOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [isOpen]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[60] bg-black/85"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Dialog */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${filename}`}
            ref={trapRef}
            variants={scaleIn}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="fixed inset-0 z-[61] flex flex-col items-center justify-center pointer-events-none"
          >
            {/* Inner container — pointer-events re-enabled */}
            <div
              className="pointer-events-auto flex flex-col items-center max-w-[90vw] max-h-[90vh] w-full"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Toolbar */}
              <div className="flex items-center justify-between w-full px-2 pb-2 gap-3">
                <span className="text-xs text-white/70 truncate max-w-[calc(100%-5rem)]">{filename}</span>
                <div className="flex items-center gap-1 shrink-0">
                  <a
                    href={imageUrl}
                    download={filename}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download"
                    className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <Download size={15} />
                  </a>
                  <button
                    ref={closeButtonRef}
                    onClick={onClose}
                    title="Close (Esc)"
                    aria-label="Close image preview"
                    className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              {/* Image */}
              <img
                src={imageUrl}
                alt={filename}
                className="max-w-full max-h-[80vh] rounded-lg object-contain shadow-2xl"
                draggable={false}
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default ImagePreviewModal;
