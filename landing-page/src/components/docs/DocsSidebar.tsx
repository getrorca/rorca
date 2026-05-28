'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { docsNav } from '@/lib/docs-nav';

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <aside className="h-fit lg:sticky lg:top-28 lg:self-start">
      <div className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:overscroll-contain">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Docs navigation</p>
        <div className="space-y-2">
          <Link
            href="/docs"
            className={`block rounded-xl border px-4 py-3 transition-colors ${pathname === '/docs' ? 'border-white/20 bg-white/5 text-white' : 'border-transparent text-zinc-400 hover:border-white/10 hover:bg-white/[0.03] hover:text-white'}`}
          >
            <div className="text-sm font-medium">Overview</div>
            <div className="mt-1 text-xs text-zinc-500">Start here and branch into the guides below.</div>
          </Link>
          {docsNav.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-xl border px-4 py-3 transition-colors ${active ? 'border-white/20 bg-white/5 text-white' : 'border-transparent text-zinc-400 hover:border-white/10 hover:bg-white/[0.03] hover:text-white'}`}
              >
                <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500 mb-1">{item.eyebrow}</div>
                <div className="text-sm font-medium">{item.title}</div>
              </Link>
            );
          })}
        </div>

      </div>
    </aside>
  );
}
