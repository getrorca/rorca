// Typed API client — barrel export
// Usage: import { specsApi, pipelineApi } from '../api';

export * as specsApi from './specs';
export * as pipelineApi from './pipeline';
export * as authApi from './auth';
export * as workspacesApi from './workspaces';
export * as analyticsApi from './analytics';
export * as directionApi from './direction';
export * as settingsApi from './settings';
export * as notificationsApi from './notifications';
export * as templatesApi from './templates';

// Re-export types for convenience
export type { ApiOptions, PaginatedResponse } from './types';
export { ApiError } from '../lib/apiFetch';
