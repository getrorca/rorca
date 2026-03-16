import type { Metadata } from 'next';

export const SITE_NAME = 'Rorca';
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rorca.app';
export const TWITTER_HANDLE = '@rorca_app';
export const DEFAULT_OG_IMAGE = `${SITE_URL}/og/og-default.png`;

export interface PageMetadata {
  title: string;
  description: string;
  path: string;
  ogImage?: string;
}

export function buildMetadata(page: PageMetadata): Metadata {
  const url = `${SITE_URL}${page.path}`;
  const ogImage = page.ogImage || DEFAULT_OG_IMAGE;
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
  },
  architecture: {
    title: 'Architecture',
    description:
      'How Rorca orchestrates AI agents: Direction Stack (L1–L5 context cascade), spec lifecycle, pipeline execution, and the three agent paths.',
    path: '/architecture',
  },
  compute: {
    title: 'Compute & Execution',
    description:
      'Every story runs as a fresh isolated subprocess with the full tool set — bash, edit, read, write, glob, grep. No context limits. A spec can run forever.',
    path: '/compute',
  },
  download: {
    title: 'Download',
    description:
      'Download Rorca for macOS or Linux. Self-hosted, one-command install. Bring your own Claude subscription or API key.',
    path: '/download',
  },
  engine: {
    title: 'Context-Intent Engine',
    description:
      "Rorca's Context-Intent Engine bridges 'The Is' (your codebase) and 'The Ought' (what should be built) — automatically routing the right context to every story.",
    path: '/engine',
  },
  pricing: {
    title: 'Pricing',
    description:
      'Free for spec generation. $15/mo for full pipeline execution. $30/mo for unlimited workspaces and teams. Self-hosted is free forever.',
    path: '/pricing',
  },
};
