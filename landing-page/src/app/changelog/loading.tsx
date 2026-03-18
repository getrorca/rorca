import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';

export default function ChangelogLoading() {
  return (
    <main className="min-h-screen bg-abyss text-white flex flex-col">
      <Nav />

      <div className="pt-32 pb-20 px-6 sm:px-12 mx-auto max-w-4xl w-full flex-1">
        {/* Header Skeleton */}
        <div className="mb-20 text-center">
          <div className="h-12 bg-zinc-800 rounded-lg mb-6 animate-pulse w-3/4 mx-auto" />
          <div className="h-6 bg-zinc-800 rounded-lg animate-pulse w-1/2 mx-auto" />
        </div>

        {/* Changelog Entries Skeleton */}
        <div className="space-y-12">
          {[1, 2, 3].map((index) => (
            <div key={index} className="border-l-2 border-accent/30 pl-6 md:pl-8">
              {/* Version Header Skeleton */}
              <div className="mb-6">
                <div className="h-8 bg-zinc-800 rounded-lg mb-3 animate-pulse w-32" />
                <div className="h-4 bg-zinc-800 rounded-lg animate-pulse w-40" />
              </div>

              {/* Sections Skeleton */}
              <div className="space-y-6">
                {[1, 2, 3].map((section) => (
                  <div key={section}>
                    <div className="h-5 bg-zinc-800 rounded-lg mb-3 animate-pulse w-24" />
                    <ul className="space-y-2">
                      {[1, 2, 3].map((item) => (
                        <li key={item} className="flex items-start gap-3">
                          <div className="h-4 w-4 bg-zinc-800 rounded-full animate-pulse mt-1 flex-shrink-0" />
                          <div className="h-4 bg-zinc-800 rounded-lg animate-pulse flex-1" />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Footer />
    </main>
  );
}
