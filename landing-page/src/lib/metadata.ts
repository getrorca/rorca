import type { Metadata } from 'next';

export const SITE_NAME = 'Rorca';

/**
 * Base URL for constructing absolute OG image URLs.
 * Falls back to localhost for local dev if NEXT_PUBLIC_BASE_URL is not set.
 */
function resolveBaseUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (!envUrl) {
    if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
      console.warn(
        '[rorca] NEXT_PUBLIC_BASE_URL is not set — OG image URLs will use http://localhost:3002 prefix'
      );
    }
    return 'http://localhost:3002';
  }
  return envUrl;
}

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rorca.app';
export const BASE_URL = resolveBaseUrl();
export const TWITTER_HANDLE = '@rorca_app';
export const DEFAULT_OG_IMAGE = `${SITE_URL}/og/og-default.png`;

/**
 * Known pages that have a pre-generated OG image in public/og/.
 * Keys must match the filename stem (e.g. "home" → /og/home.png).
 */
const KNOWN_OG_PAGES = new Set([
  'home',
  'architecture',
  'memory',
  'execution',
  'pricing',
  'download',
]);

/**
 * Returns the absolute OG image URL for a given page key.
 * Falls back to og-default.png with a build-time warning for unknown pages.
 */
export function resolveOgImage(pageKey: string): string {
  if (!KNOWN_OG_PAGES.has(pageKey)) {
    console.warn(`[rorca] Missing OG image for ${pageKey}, using default`);
    return `${BASE_URL}/og/og-default.png`;
  }
  return `${BASE_URL}/og/${pageKey}.png`;
}

export interface PageMetadata {
  title: string;
  description: string;
  path: string;
  /** Override the auto-resolved OG image URL. */
  ogImage?: string;
  /** Page key used to look up /og/{key}.png. Defaults to the route name. */
  ogKey?: string;
}

export function buildMetadata(page: PageMetadata): Metadata {
  const url = `${SITE_URL}${page.path}`;
  // Determine OG key: explicit override > ogKey field > derive from path
  const ogKey = page.ogKey ?? (page.path === '/' ? 'home' : page.path.replace(/^\//, ''));
  const ogImage = page.ogImage ?? resolveOgImage(ogKey);
  const fullTitle = page.path === '/' ? `${SITE_NAME} — ${page.title}` : `${page.title} | ${SITE_NAME}`;

  return {
    title: fullTitle,
    description: page.description,
    metadataBase: new URL(SITE_URL),
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: fullTitle,
      description: page.description,
      url,
      siteName: SITE_NAME,
      type: 'website',
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: fullTitle,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      site: TWITTER_HANDLE,
      title: fullTitle,
      description: page.description,
      images: [ogImage],
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}

export const PAGES_METADATA: Record<string, PageMetadata> = {
  home: {
    title: 'AI Spec Orchestration. Ship features autonomously.',
    description:
      'Rorca turns a plain-English brief into a structured spec, then executes every story as an isolated subprocess — no context limits, runs to completion.',
    path: '/',
    ogKey: 'home',
  },
  architecture: {
    title: 'Architecture',
    description:
      'How Rorca orchestrates AI agents: Direction Stack (L1–L5 context cascade), spec lifecycle, pipeline execution, and the three agent paths.',
    path: '/architecture',
    ogKey: 'architecture',
  },
  execution: {
    title: 'Execution',
    description:
      'Three first-class execution engines — Claude Code, OpenCode, Codex CLI. Model cascading saves 40–60% vs all-Opus. Wave-parallel runs independent stories concurrently across isolated git worktrees.',
    path: '/execution',
    ogKey: 'execution',
  },
  download: {
    title: 'Download',
    description:
      'Download Rorca for macOS or Linux. Self-hosted, one-command install. Bring your own Claude subscription or API key.',
    path: '/download',
    ogKey: 'download',
  },
  memory: {
    title: 'Memory',
    description:
      'How Rorca remembers and applies knowledge: tiered memory retrieval (CAG→RAG→Graph), virtual context routing via micromatch globs, and LLM-matched skills injection per story.',
    path: '/memory',
    ogKey: 'memory',
  },
  pricing: {
    title: 'Pricing',
    description:
      'Free for spec generation. $15/mo for full pipeline execution. $30/mo for unlimited workspaces and teams. Self-hosted is free forever.',
    path: '/pricing',
    ogKey: 'pricing',
  },
};
