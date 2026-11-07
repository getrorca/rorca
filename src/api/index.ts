/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// Typed API client — barrel export
// Usage: import { specsApi, pipelineApi } from '../api';

export * as specsApi from './specs';
export * as pipelineApi from './pipeline';
export * as workspacesApi from './workspaces';
export * as analyticsApi from './analytics';
export * as directionApi from './direction';
export * as settingsApi from './settings';
export * as notificationsApi from './notifications';
export * as templatesApi from './templates';
export * as missionApi from './mission';

// Re-export types for convenience
export type { ApiOptions, PaginatedResponse } from './types';
export { ApiError } from '../lib/apiFetch';
