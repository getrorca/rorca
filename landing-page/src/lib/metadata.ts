import type { Metadata } from 'next';

export const SITE_NAME = 'Rorca';

/**
 * Base URL for constructing absolute OG image URLs.
 * Falls back to the public site URL when a dedicated base URL is not set.
 */
function resolveBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    'https://rorca.app'
  );
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
    title: 'Spec-first AI orchestration. Ship features autonomously.',
    description:
      'Rorca turns a brief into a structured spec, persists explicit drafts, and executes stories with backend-native retrieval, telemetry, and feedback.',
    path: '/',
    ogKey: 'home',
  },
  architecture: {
    title: 'Architecture',
    description:
      'How Rorca layers the Direction Stack, explicit spec persistence, retrieval, and execution into one control plane.',
    path: '/architecture',
    ogKey: 'architecture',
  },
  execution: {
    title: 'Execution',
    description:
      'How Rorca runs approved work story by story across Claude Code, OpenCode, Codex, and Pi CLI through one orchestration contract.',
    path: '/execution',
    ogKey: 'execution',
  },
  download: {
    title: 'Download',
    description:
      'Install Rorca locally with one command. Self-hosted, Postgres-ready, and built for dashboard, backend, and worker workflows.',
    path: '/download',
    ogKey: 'download',
  },
  memory: {
    title: 'Memory',
    description:
      'How Rorca combines cached context, retrieval, graph links, and feedback to keep context relevant.',
    path: '/memory',
    ogKey: 'memory',
  },
  pricing: {
    title: 'Pricing',
    description:
      'Free local Rorca, plus managed, shared, and governed deployment options as the product expands.',
    path: '/pricing',
    ogKey: 'pricing',
  },
};
