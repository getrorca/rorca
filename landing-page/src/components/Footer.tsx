import Link from 'next/link';

const productLinks = [
  { href: '/download', label: 'Download' },
  { href: '/docs', label: 'Docs' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/troubleshooting', label: 'Troubleshooting' },
];

const deepDiveLinks = [
  { href: '/architecture', label: 'Architecture' },
  { href: '/memory', label: 'Memory' },
  { href: '/execution', label: 'Execution' },
];

export function Footer() {
  return (
    <footer className="border-t border-white/5 mt-32 py-12">
      <div className="max-w-7xl mx-auto px-6 sm:px-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
          <div className="flex flex-col gap-3">
            <span className="font-bold text-lg tracking-tighter text-white">Rorca</span>
            <span className="text-zinc-400 text-sm max-w-sm leading-relaxed">
              Local-first AI spec orchestration for autonomous software development.
            </span>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-zinc-300">Product</h3>
            <div className="flex flex-col gap-2">
              {productLinks.map((link) => (
                <Link key={link.href} href={link.href} className="text-zinc-400 hover:text-white transition-colors text-sm">
                  {link.label}
                </Link>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-zinc-300">Deep dive</h3>
            <div className="flex flex-col gap-2">
              {deepDiveLinks.map((link) => (
                <Link key={link.href} href={link.href} className="text-zinc-400 hover:text-white transition-colors text-sm">
                  {link.label}
                </Link>
              ))}
              <a href="https://github.com/getrorca/rorca" target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-white transition-colors text-sm">
                GitHub
              </a>
            </div>
          </div>
        </div>

        <div className="border-t border-white/5 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="text-zinc-400/50 text-sm">© {new Date().getFullYear()} Rorca. Built for local-first autonomous development.</span>
          <a href="mailto:hello@rorca.app" className="text-zinc-400 hover:text-white transition-colors text-sm">
            hello@rorca.app
          </a>
        </div>
      </div>
    </footer>
  );
}
