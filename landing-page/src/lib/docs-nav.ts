export type DocsNavItem = {
  href: string;
  title: string;
  shortTitle: string;
  description: string;
  eyebrow: string;
};

export const docsNav: DocsNavItem[] = [
  {
    href: '/docs/getting-started',
    title: 'Getting started',
    shortTitle: 'Getting started',
    description: 'Install locally, understand the process model, and get from repo to running stack quickly.',
    eyebrow: 'Local-first setup',
  },
  {
    href: '/docs/spec-creation',
    title: 'Spec creation',
    shortTitle: 'Spec creation',
    description: 'The canonical explicit create-spec flow, compatibility aliases, and when backend drafting still makes sense.',
    eyebrow: 'Skill-first control plane',
  },
  {
    href: '/docs/architecture',
    title: 'Architecture',
    shortTitle: 'Architecture',
    description: 'Direction Stack, spec lifecycle, MCP contract, and the backend control plane.',
    eyebrow: 'Core model',
  },
  {
    href: '/docs/memory-retrieval',
    title: 'Memory & retrieval',
    shortTitle: 'Memory',
    description: 'How cached context, retrieval, graph context, reranking, telemetry, and feedback fit together.',
    eyebrow: 'Backend-native context',
  },
  {
    href: '/docs/execution',
    title: 'Execution',
    shortTitle: 'Execution',
    description: 'How Rorca uses Claude Code, OpenCode, Codex CLI, and Pi CLI without collapsing into one provider-specific story.',
    eyebrow: 'Provider-selected runtime',
  },
  {
    href: '/docs/tools',
    title: 'Tools & commands',
    shortTitle: 'Tools',
    description: 'The CLI, TUI, MCP tools, and Pi extension slash commands in one newcomer-friendly reference.',
    eyebrow: 'Reference surface',
  },
  {
    href: '/docs/pricing-packaging',
    title: 'Pricing & packaging',
    shortTitle: 'Pricing',
    description: 'Free local core, paid shared and managed layers, and the boundaries that preserve open-source trust.',
    eyebrow: 'Commercial shape',
  },
  {
    href: '/docs/troubleshooting',
    title: 'Troubleshooting & glossary',
    shortTitle: 'Troubleshooting',
    description: 'Common confusion points, reliability caveats, and plain-English definitions for the core terms.',
    eyebrow: 'Practical help',
  },
];

export function getDocNavItem(href: string): DocsNavItem | undefined {
  return docsNav.find((item) => item.href === href);
}
