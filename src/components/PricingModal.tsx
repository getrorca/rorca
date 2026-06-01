/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

interface PricingModalProps {
  onClose: () => void;
}

export default function PricingModal({ onClose }: PricingModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div className="max-w-lg rounded-xl border border-border bg-panel p-6 text-sm text-muted" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-lg font-semibold text-text">Local-first OSS edition</h2>
        <p>
          This repository ships the Apache-2.0 local-first edition of Rorca. Hosted identity, billing,
          and multi-user collaboration are not part of this repo.
        </p>
      </div>
    </div>
  );
}
