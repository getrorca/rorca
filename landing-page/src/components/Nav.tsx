import Link from 'next/link';

export function Nav() {
    return (
        <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
            <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
                <Link href="/" className="flex items-center gap-[4px] group">
                    {/* Faceted Gem Mark — Precision grid-aligned, φ geometry */}
                    <div className="flex items-center justify-center w-8 h-8">
                        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"
                            className="transition-all duration-700 group-hover:drop-shadow-[0_0_12px_rgba(0,245,255,0.5)]">

                            {/* Outer rounded rhombus */}
                            <path d="M14 2 C17.5 2 26 10.5 26 14 C26 17.5 17.5 26 14 26 C10.5 26 2 17.5 2 14 C2 10.5 10.5 2 14 2 Z"
                                stroke="white" strokeWidth="1.1" fill="rgba(255,255,255,0.04)" />

                            {/* Left face — fill the left half of the diamond */}
                            <path d="M2 14 C2 10.5 10.5 2 14 2 L14 26 C10.5 26 2 17.5 2 14 Z"
                                fill="rgba(255,255,255,0.12)" />

                            {/* Center partition — exact vertical from top vertex (14,2) to bottom vertex (14,26) */}
                            <line x1="14" y1="2" x2="14" y2="26"
                                stroke="white" strokeWidth="0.9" strokeOpacity="0.5" />

                            {/* Right face — very faint, recessive */}
                            <path d="M14 2 C17.5 2 26 10.5 26 14 C26 17.5 17.5 26 14 26 L14 2 Z"
                                fill="rgba(255,255,255,0.02)" />

                            {/* Eye — snapped to 4px grid, anchored 4px right of center line */}
                            {/* Left edge at x=18 (14+4), center at (20,9), 4×4 diamond */}
                            <path d="M20 7 L22 9 L20 11 L18 9 Z"
                                fill="#00F5FF" fillOpacity="0.95"
                                className="transition-all duration-500 group-hover:drop-shadow-[0_0_6px_rgba(0,245,255,1)]" />
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
