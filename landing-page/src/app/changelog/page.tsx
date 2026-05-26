import { Metadata } from 'next';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';

interface ChangelogEntry {
  version: string;
  date: string;
  dateSlug: string;
  sections: {
    Added?: string[];
    Changed?: string[];
    Fixed?: string[];
    Removed?: string[];
    [key: string]: string[] | undefined;
  };
}

function parseChangelog(content: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const versionRegex = /^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/gm;
  const sectionRegex = /^### (Added|Changed|Fixed|Removed|Deprecated)/gm;

  let match;
  const versionMatches = Array.from(content.matchAll(versionRegex));

  for (let i = 0; i < versionMatches.length; i++) {
    const versionMatch = versionMatches[i];
    const version = versionMatch[1];
    const date = versionMatch[2];
    const dateSlug = date.replace(/-/g, '');

    // Get content between this version and the next
    const startIndex = versionMatch.index! + versionMatch[0].length;
    const nextVersionIndex =
      i + 1 < versionMatches.length
        ? versionMatches[i + 1].index
        : content.length;

    const versionContent = content.substring(startIndex, nextVersionIndex);

    const sections: {
      Added?: string[];
      Changed?: string[];
      Fixed?: string[];
      Removed?: string[];
      [key: string]: string[] | undefined;
    } = {};

    // Parse sections
    const sectionMatches = Array.from(versionContent.matchAll(sectionRegex));
    for (let j = 0; j < sectionMatches.length; j++) {
      const sectionMatch = sectionMatches[j];
      const sectionName = sectionMatch[1] as
        | 'Added'
        | 'Changed'
        | 'Fixed'
        | 'Removed';
      const sectionStartIndex = sectionMatch.index! + sectionMatch[0].length;
      const nextSectionIndex =
        j + 1 < sectionMatches.length
          ? sectionMatches[j + 1].index
          : versionContent.length;

      const sectionContent = versionContent.substring(
        sectionStartIndex,
        nextSectionIndex
      );

      // Parse bullets
      const bullets = sectionContent
        .split('\n')
        .filter((line) => line.match(/^- /))
        .map((line) => line.replace(/^- /, '').trim());

      if (bullets.length > 0) {
        sections[sectionName] = bullets;
      }
    }

    if (Object.keys(sections).length > 0) {
      entries.push({
        version,
        date,
        dateSlug,
        sections,
      });
    }
  }

  return entries;
}

export const metadata: Metadata = {
  title: 'Changelog | Rorca',
  description:
    'Release notes and changelog for Rorca AI orchestration platform.',
  openGraph: {
    title: 'Changelog | Rorca',
    description:
      'Release notes and changelog for Rorca AI orchestration platform.',
    type: 'website',
  },
};

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
    <main className="min-h-screen bg-abyss text-white selection:bg-fizz selection:text-abyss flex flex-col">
      <Nav />

      {/* Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="pt-32 pb-20 px-6 sm:px-12 mx-auto max-w-4xl w-full flex-1">
        {/* Header */}
        <div className="mb-20 text-center">
          <h1 className="text-4xl md:text-6xl font-medium tracking-tight mb-6">
            Release <span className="text-accent">Notes</span>.
          </h1>
          <p className="text-zinc-400 text-lg leading-relaxed">
            Track updates, improvements, and fixes to Rorca.
          </p>
        </div>

        {/* Changelog Entries */}
        {entries.length > 0 ? (
          <div className="space-y-12">
            {entries.map((entry, index) => (
              <section
                key={entry.dateSlug}
                id={entry.dateSlug}
                className="scroll-mt-32 border-l-2 border-accent/30 pl-6 md:pl-8"
              >
                {/* Version Header */}
                <div className="mb-6">
                  <h2 className="text-3xl font-medium mb-2">
                    v{entry.version}
                  </h2>
                  <time className="text-zinc-400 text-sm">
                    {new Date(`${entry.date}T00:00:00Z`).toLocaleDateString(
                      'en-US',
                      {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      }
                    )}
                  </time>
                </div>

                {/* Sections */}
                <div className="space-y-6">
                  {Object.entries(entry.sections).map(
                    ([sectionName, items]) => {
                      if (!items || items.length === 0) return null;

                      const sectionColors: {
                        [key: string]: string;
                      } = {
                        Added: 'text-green-400/70',
                        Changed: 'text-blue-400/70',
                        Fixed: 'text-yellow-400/70',
                        Removed: 'text-red-400/70',
                      };

                      const sectionColor = sectionColors[sectionName] || 'text-zinc-400/70';

                      return (
                        <div key={sectionName}>
                          <h3 className={`font-medium mb-3 ${sectionColor}`}>
                            {sectionName}
                          </h3>
                          <ul className="space-y-2">
                            {items.map((item, itemIndex) => (
                              <li
                                key={itemIndex}
                                className="text-zinc-300 flex items-start gap-3"
                              >
                                <span className="text-accent/60 mt-1">•</span>
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    }
                  )}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="text-center py-20">
            <p className="text-zinc-400 text-lg">
              No changelog entries yet.
            </p>
          </div>
        )}
      </div>

      <Footer />
    </main>
  );
}
