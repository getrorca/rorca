/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export interface UpgradePromptProps {
  feature: string;
  featureName: string;
  description: string;
  open: boolean;
  onClose: () => void;
  onUpgrade?: () => void;
}

export function ProBadge() {
  return null;
}

export function UpgradePromptInline() {
  return null;
}

export function UpgradePromptModal() {
  return null;
}
