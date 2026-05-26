import type { Metadata } from 'next';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildMetadata, SITE_URL } from '@/lib/metadata';
import ChangelogClient, { type ChangelogEntry } from './ChangelogClient';

export const metadata: Metadata = buildMetadata({
  title: 'Changelog',
  description: 'Release notes and product updates for Rorca.',
  path: '/changelog',
  ogImage: `${SITE_URL}/og/home.png`,
});

function parseChangelog(content: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const versionRegex = /^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/gm;
  const sectionRegex = /^### (Added|Changed|Fixed|Removed|Deprecated)/gm;

  const versionMatches = Array.from(content.matchAll(versionRegex));

  for (let i = 0; i < versionMatches.length; i++) {
    const versionMatch = versionMatches[i];
    const version = versionMatch[1];
    const date = versionMatch[2];
    const dateSlug = date.replace(/-/g, '');

    const startIndex = versionMatch.index! + versionMatch[0].length;
    const nextVersionIndex = i + 1 < versionMatches.length ? versionMatches[i + 1].index! : content.length;
    const versionContent = content.substring(startIndex, nextVersionIndex);

    const sections: ChangelogEntry['sections'] = {};

    const sectionMatches = Array.from(versionContent.matchAll(sectionRegex));
    for (let j = 0; j < sectionMatches.length; j++) {
      const sectionMatch = sectionMatches[j];
      const sectionName = sectionMatch[1] as 'Added' | 'Changed' | 'Fixed' | 'Removed';
      const sectionStartIndex = sectionMatch.index! + sectionMatch[0].length;
      const nextSectionIndex = j + 1 < sectionMatches.length ? sectionMatches[j + 1].index! : versionContent.length;
      const sectionContent = versionContent.substring(sectionStartIndex, nextSectionIndex);

      const bullets = sectionContent
        .split('\n')
        .filter((line) => line.match(/^- /))
        .map((line) => line.replace(/^- /, '').trim());

      if (bullets.length > 0) {
        sections[sectionName] = bullets;
      }
    }

    if (Object.keys(sections).length > 0) {
      entries.push({ version, date, dateSlug, sections });
    }
  }

  return entries;
}

export default function ChangelogPage() {
  let entries: ChangelogEntry[] = [];

  try {
    const changelogPath = resolve(process.cwd(), '../CHANGELOG.md');
    const content = readFileSync(changelogPath, 'utf-8');
    entries = parseChangelog(content);
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`Failed to read CHANGELOG.md: ${error.message}`);
    }
  }

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: entries.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.version,
      description:
        entry.sections.Added && entry.sections.Added.length > 0
          ? entry.sections.Added[0]
          : `Version ${entry.version} released on ${entry.date}`,
      url: `/changelog#${entry.dateSlug}`,
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ChangelogClient entries={entries} />
    </>
  );
}
