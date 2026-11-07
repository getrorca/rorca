/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

-- Preserve the exact immutable preview identity on every new qualification receipt.
-- Historical rows predate this binding and intentionally remain NULL rather than
-- claiming an approximate current-preview relationship.
ALTER TABLE ssdlc_release_qualifications
  ADD COLUMN IF NOT EXISTS preview_hash TEXT
  CHECK (preview_hash IS NULL OR preview_hash ~ '^sha256:[0-9a-f]{64}$');
