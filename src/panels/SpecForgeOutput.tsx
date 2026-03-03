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

export interface GeneratedSpec {
  specName: string;
  stories: Story[];
  diagram?: string;
  diagramType?: 'mermaid-flowchart' | 'mermaid-sequence' | 'ascii';
  savedPath?: string;
  generatedAt: string;
  contextUsed?: ContextUsed;
}
