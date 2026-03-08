import Link from 'next/link';

export function Nav() {
    return (
        <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
            <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
                <Link href="/" className="flex items-center gap-[4px] group">
                    {/* Faceted Gem Mark — Precision grid-aligned, φ geometry */}
                    <div className="flex items-center justify-center w-8 h-8">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="116 60 280 392" width="28" height="28"
                            aria-label="Rorca logo" role="img"
                            className="transition-all duration-700 group-hover:drop-shadow-[0_0_12px_rgba(0,229,255,0.5)]">
                            <defs>
                                <linearGradient id="nav-lg" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" stopColor="#1A1D24" />
                                    <stop offset="100%" stopColor="#050505" />
                                </linearGradient>
                                <linearGradient id="nav-rg" x1="0%" y1="0%" x2="0%" y2="100%">
                                    <stop offset="0%" stopColor="#515B6B" />
                                    <stop offset="100%" stopColor="#232934" />
                                </linearGradient>
                                <clipPath id="nav-cd">
                                    <rect x="132" y="132" width="248" height="248" rx="36" transform="rotate(45 256 256)" />
                                </clipPath>
                            </defs>
                            <rect x="116" y="116" width="280" height="280" rx="44" transform="rotate(45 256 256)" fill="currentColor" opacity="0.12" />
                            <rect x="120" y="120" width="272" height="272" rx="40" transform="rotate(45 256 256)" fill="#FFFFFF" stroke="currentColor" strokeWidth="2" strokeOpacity="0.15" />
                            <g clipPath="url(#nav-cd)">
                                <rect x="0" y="0" width="256" height="512" fill="url(#nav-lg)" />
                                <rect x="256" y="0" width="256" height="512" fill="url(#nav-rg)" />
                                <line x1="256" y1="0" x2="256" y2="512" stroke="#E5E7EB" strokeWidth="12" />
                                <g transform="rotate(45 256 256)">
                                    <rect x="224" y="156" width="124" height="60" rx="16" fill="#00E5FF" />
                                    <rect x="232" y="164" width="108" height="44" rx="8" fill="none" stroke="#000000" strokeWidth="5" opacity="0.9" />
                                </g>
                            </g>
                        </svg>
                    </div>
                    <span className="font-medium text-base tracking-tight text-white transition-colors duration-300 group-hover:text-zinc-300" style={{ fontFamily: 'var(--font-space-grotesk)' }}>rorca</span>
                </Link>
                <div className="hidden md:flex items-center gap-8">
                    <Link href="/" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors">Home</Link>
                    <Link href="/architecture" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors">Architecture</Link>
                    <Link href="/engine" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors">Engine</Link>
                    <Link href="/compute" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors">Compute</Link>
                    <Link href="#" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors">Pricing</Link>
                </div>
                <div className="flex items-center gap-4">
                    <Link href="#" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors hidden sm:block">Log In</Link>
                    <button className="px-4 py-1.5 bg-white text-zinc-950 rounded-md text-sm font-medium hover:bg-zinc-200 transition-colors">
                        Sign Up
                    </button>
                </div>
            </div>
        </header>
    );
}
