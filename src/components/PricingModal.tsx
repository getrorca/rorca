/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { X } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface PricingModalProps {
  onClose: () => void;
}

export default function PricingModal({ onClose }: PricingModalProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, undefined, { onEscape: onClose });
  return (
    <div
      ref={trapRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pricing-modal-title"
    >
      <div className="relative max-w-lg rounded-xl border border-border bg-panel p-6 pr-12 text-sm text-muted shadow-xl" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close edition information"
          className="absolute right-3 top-3 inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-muted hover:bg-surface-200 hover:text-[var(--text)]"
        >
          <X size={18} aria-hidden="true" />
        </button>
        <h2 id="pricing-modal-title" className="mb-2 text-lg font-semibold text-[var(--text)]">Local-first OSS edition</h2>
        <p>
          This repository ships the Apache-2.0 local-first edition of Rorca. Hosted identity, billing,
          and multi-user collaboration are not part of this repo.
        </p>
      </div>
    </div>
  );
}
