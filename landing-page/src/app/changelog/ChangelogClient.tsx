'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';

export interface ChangelogEntry {
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

interface ChangelogClientProps {
  entries: ChangelogEntry[];
}

export default function ChangelogClient({ entries }: ChangelogClientProps) {
  return (
    <main className="min-h-screen bg-abyss text-white selection:bg-fizz selection:text-abyss flex flex-col">
      <Nav />

      <div className="pt-32 pb-20 px-6 sm:px-12 mx-auto max-w-4xl w-full flex-1">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-16 text-center"
        >
          <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-4">Updates</p>
          <h1 className="text-4xl md:text-6xl font-medium tracking-tight mb-6">
            Release <span className="text-accent">Notes</span>.
          </h1>
          <p className="text-zinc-400 text-lg leading-relaxed">
            Track the latest product changes, fixes, and improvements.
          </p>
        </motion.div>

        {entries.length > 0 ? (
          <div className="space-y-12">
            {entries.map((entry, index) => (
              <motion.section
                key={entry.dateSlug}
                id={entry.dateSlug}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.08 }}
                className="scroll-mt-32 border-l-2 border-accent/30 pl-6 md:pl-8"
              >
                <div className="mb-6">
                  <h2 className="text-3xl font-medium mb-2">v{entry.version}</h2>
                  <time className="text-zinc-400 text-sm">
                    {new Date(`${entry.date}T00:00:00Z`).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </time>
                </div>

                <div className="space-y-6">
                  {Object.entries(entry.sections).map(([sectionName, items]) => {
                    if (!items || items.length === 0) return null;

                    const sectionColors: Record<string, string> = {
                      Added: 'text-green-400/70',
                      Changed: 'text-blue-400/70',
                      Fixed: 'text-yellow-400/70',
                      Removed: 'text-red-400/70',
                    };

                    const sectionColor = sectionColors[sectionName] || 'text-zinc-400/70';

                    return (
                      <div key={sectionName}>
                        <h3 className={`font-medium mb-3 ${sectionColor}`}>{sectionName}</h3>
                        <ul className="space-y-2">
                          {items.map((item, itemIndex) => (
                            <li key={itemIndex} className="text-zinc-300 flex items-start gap-3">
                              <span className="text-accent/60 mt-1">•</span>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </motion.section>
            ))}
          </div>
        ) : (
          <div className="text-center py-20">
            <p className="text-zinc-400 text-lg">No changelog entries yet.</p>
          </div>
        )}
      </div>

      <Footer />
    </main>
  );
}
