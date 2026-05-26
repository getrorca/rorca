import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/metadata';

const routes = [
  ['/', 'weekly', 1.0],
  ['/download', 'weekly', 0.95],
  ['/pricing', 'monthly', 0.85],
  ['/architecture', 'monthly', 0.8],
  ['/memory', 'monthly', 0.78],
  ['/execution', 'monthly', 0.78],
  ['/changelog', 'weekly', 0.7],
  ['/troubleshooting', 'monthly', 0.68],
  ['/docs', 'monthly', 0.9],
  ['/docs/getting-started', 'monthly', 0.88],
  ['/docs/spec-creation', 'monthly', 0.86],
  ['/docs/architecture', 'monthly', 0.84],
  ['/docs/memory-retrieval', 'monthly', 0.84],
  ['/docs/execution', 'monthly', 0.84],
  ['/docs/cli', 'monthly', 0.82],
  ['/docs/tui', 'monthly', 0.82],
  ['/docs/pi-extension', 'monthly', 0.82],
  ['/docs/tools', 'monthly', 0.82],
  ['/docs/pricing-packaging', 'monthly', 0.8],
  ['/docs/troubleshooting', 'monthly', 0.8],
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date().toISOString();

  return routes.map(([path, changeFrequency, priority]) => ({
    url: `${SITE_URL}${path === '/' ? '' : path}`,
    lastModified: now,
    changeFrequency,
    priority,
  }));
}
