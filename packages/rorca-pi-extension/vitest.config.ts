/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/rorca-pi-extension/extensions/rorca/__tests__/**/*.test.ts"],
  },
});
