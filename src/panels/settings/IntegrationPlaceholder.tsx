/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Plug } from 'lucide-react';

interface IntegrationPlaceholderProps {
  name: string;
  description: string;
}

export default function IntegrationPlaceholder({ name, description }: IntegrationPlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center max-w-md mx-auto">
      <div className="w-16 h-16 rounded-2xl bg-surface-100 border border-border flex items-center justify-center mb-4">
        <Plug size={28} className="text-muted/40" />
      </div>
      <h2 className="text-lg font-semibold text-[var(--text)] mb-2">{name} Integration</h2>
      <p className="text-sm text-muted mb-4">{description}</p>
      <span className="inline-flex items-center px-3 py-1 text-xs font-medium rounded-full bg-accent/10 text-accent border border-accent/20">
        Coming Soon
      </span>
    </div>
  );
}
