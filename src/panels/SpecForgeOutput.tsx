import type { Story } from '../components/StoryCard';

/* ─── Types ───────────────────────────────────────────────────────── */

export type { Story };

export interface ContextUsedMeta {
  standards: boolean;
  conventions: boolean;
  project: boolean;
  memory: boolean;
  schema: boolean;
  scopesMatched: string[];
  totalTokens: number;
}

export interface ContextUsed {
  text: string;
  meta: ContextUsedMeta;
}

export interface ContextSummary {
  directionLayers: {
    l1: boolean;
    l2: { present: boolean; domain: string | null };
    l3: boolean;
  };
  skills: string[];
  memoryEntries: number;
  agentsMd: boolean;
  template: string | null;
  schemaSnapshot: boolean;
  gitMemory: boolean;
  estimatedTokens: number;
  modelContextWindow: number;
  vectorHits?: number;
  graphHits?: number;
  retrievalTier?: 'cache' | 'search' | 'hybrid';
  retrievalLatencyMs?: number;
}

export interface GeneratedSpec {
  specName: string;
  stories: Story[];
  diagram?: string;
  diagramType?: 'mermaid-flowchart' | 'mermaid-sequence' | 'ascii';
  savedPath?: string;
  generatedAt: string;
  contextUsed?: ContextUsed;
  contextSummary?: ContextSummary;
}
