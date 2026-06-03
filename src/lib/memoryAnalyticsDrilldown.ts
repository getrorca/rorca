/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export const MEMORY_ANALYTICS_DRILLDOWN_STORAGE_KEY = 'rorca_memory_analytics_drilldown';

export type MemoryAnalyticsDrilldownMetric = 'conflicts' | 'superseded' | 'hotspots' | 'recentCuration';

export interface MemoryAnalyticsDrilldown {
  source: 'ontology-health';
  workspaceId: string;
  metric: MemoryAnalyticsDrilldownMetric;
  label: string;
  description: string;
  memoryIds: number[];
  specIds: string[];
  filePaths: string[];
  createdAt: string;
}
