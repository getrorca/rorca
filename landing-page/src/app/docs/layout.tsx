import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { DocsSidebar } from '@/components/docs/DocsSidebar';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-abyss text-white selection:bg-fizz selection:text-abyss flex flex-col">
      <Nav />
      <div className="pt-28 pb-24 px-6 sm:px-12 mx-auto max-w-7xl w-full flex-grow">
        <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-8 lg:gap-12">
          <DocsSidebar />
          <div className="min-w-0">{children}</div>
        </div>
      </div>
      <Footer />
    </main>
  );
}
