import type { Story } from '../components/StoryCard';

/* ─── Types ───────────────────────────────────────────────────────── */

export type { Story };

export interface GeneratedSpec {
  specName: string;
  stories: Story[];
  diagram?: string;
  diagramType?: 'mermaid-flowchart' | 'mermaid-sequence' | 'ascii';
  savedPath?: string;
  generatedAt: string;
  contextUsed?: string;
}
