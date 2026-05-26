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
    description: 'True beginner guide: install, connect a workspace, configure providers and models, add skills, choose stories, and run your first spec.',
    eyebrow: 'Start here first',
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
    description: 'Execution CLI selection, orchestration modes, and cross-surface run behavior.',
    eyebrow: 'Provider-selected runtime',
  },
  {
    href: '/docs/cli',
    title: 'CLI guide',
    shortTitle: 'CLI',
    description: 'In-depth standalone CLI guide with flags, engine examples, sequential mode, forge, and operator workflows.',
    eyebrow: 'Keyboard-first operator',
  },
  {
    href: '/docs/tui',
    title: 'TUI guide',
    shortTitle: 'TUI',
    description: 'Board, watch, model picker, recall, story editing, and live run control in the embedded terminal UI.',
    eyebrow: 'Embedded control room',
  },
  {
    href: '/docs/pi-extension',
    title: 'Pi extension guide',
    shortTitle: 'Pi extension',
    description: 'In-depth Pi slash-command docs covering install, run, retry, watch, model selection, and execution caveats.',
    eyebrow: 'Pi-native operator surface',
  },
  {
    href: '/docs/tools',
    title: 'Tools & commands',
    shortTitle: 'Tools',
    description: 'Reference index for the CLI, TUI, MCP tools, and Pi extension, with links into the dense guides.',
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
