'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { docsNav } from '@/lib/docs-nav';

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <aside className="lg:sticky lg:top-28 h-fit">
      <div className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Docs navigation</p>
        <div className="space-y-2">
          <Link
            href="/docs"
            className={`block rounded-xl border px-4 py-3 transition-colors ${pathname === '/docs' ? 'border-white/20 bg-white/5 text-white' : 'border-transparent text-zinc-400 hover:border-white/10 hover:bg-white/[0.03] hover:text-white'}`}
          >
            <div className="text-sm font-medium">Overview</div>
            <div className="mt-1 text-xs text-zinc-500">Start here and branch into the current docs sections.</div>
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

        <div className="mt-5 border-t border-white/5 pt-5 text-sm text-zinc-400 leading-relaxed">
          <p className="mb-3">
            Current docs are anchored to the product-truth matrix and the explicit create-spec contract.
          </p>
          <a href="https://github.com/getrorca/rorca#readme" target="_blank" rel="noreferrer" className="text-fizz hover:text-white transition-colors font-medium">
            View README
          </a>
        </div>
      </div>
    </aside>
  );
}
