/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
// Invocation-owned DB lane: bind every fresh test connection to the fixture workspace.
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = 'workspace:wave-two';
process.env.JEST_SKIP_RUNTIME_MIGRATIONS = 'true';
