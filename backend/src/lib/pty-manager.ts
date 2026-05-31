/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { logger } from './logger';

export const PTY_UNAVAILABLE_HINT = 'Run: cd backend && npm rebuild node-pty';

let ptyAvailable = false;

try {
  require('node-pty');
  ptyAvailable = true;
} catch (err) {
  logger.warn({ err }, `[pty-manager] node-pty unavailable — PTY mode disabled. ${PTY_UNAVAILABLE_HINT}`);
}

export const PTY_AVAILABLE = ptyAvailable;
