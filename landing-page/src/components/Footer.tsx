import Link from 'next/link';

export function Footer() {
    return (
        <footer className="border-t border-white/5 bg-zinc-900 min-h-[280px]">
            <div className="max-w-7xl mx-auto px-6 sm:px-12 py-16">
                {/* Four-column grid: Product, Company, Legal, Community */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
                    {/* Product column */}
                    <div>
                        <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Product</h3>
                        <ul className="space-y-3 text-sm">
                            <li>
                                <Link href="/download" className="text-zinc-400 hover:text-white transition-colors">
                                    Download
                                </Link>
                            </li>
                            <li>
                                <Link href="/pricing" className="text-zinc-400 hover:text-white transition-colors">
                                    Pricing
                                </Link>
                            </li>
                            <li>
                                <Link href="/docs" className="text-zinc-400 hover:text-white transition-colors">
                                    Docs <span className="text-zinc-600">(Coming Soon)</span>
                                </Link>
                            </li>
                            <li>
                                <Link href="/changelog" className="text-zinc-400 hover:text-white transition-colors">
                                    Changelog <span className="text-zinc-600">(Coming Soon)</span>
                                </Link>
                            </li>
                        </ul>
                    </div>

                    {/* Company column */}
                    <div>
                        <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Company</h3>
                        <ul className="space-y-3 text-sm">
                            <li>
                                <Link href="/about" className="text-zinc-400 hover:text-white transition-colors">
                                    About <span className="text-zinc-600">(Coming Soon)</span>
                                </Link>
                            </li>
                            <li>
                                <Link href="/blog" className="text-zinc-400 hover:text-white transition-colors">
                                    Blog <span className="text-zinc-600">(Coming Soon)</span>
                                </Link>
                            </li>
                            <li>
                                <Link href="/careers" className="text-zinc-400 hover:text-white transition-colors">
                                    Careers <span className="text-zinc-600">(Coming Soon)</span>
                                </Link>
                            </li>
                        </ul>
                    </div>

                    {/* Legal column */}
                    <div>
                        <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Legal</h3>
                        <ul className="space-y-3 text-sm">
                            <li>
                                <Link href="/terms" className="text-zinc-400 hover:text-white transition-colors">
                                    Terms
                                </Link>
                            </li>
                            <li>
                                <Link href="/privacy" className="text-zinc-400 hover:text-white transition-colors">
                                    Privacy
                                </Link>
                            </li>
                        </ul>
                    </div>

                    {/* Community column */}
                    <div>
                        <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Community</h3>
                        <ul className="space-y-3 text-sm">
                            <li>
                                <a
                                    href="https://github.com/getrorca/rorca"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-zinc-400 hover:text-white transition-colors"
                                >
                                    GitHub
                                </a>
                            </li>
                            <li>
                                <a
                                    href="https://x.com/getrorca"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-zinc-400 hover:text-white transition-colors"
                                >
                                    Twitter / X
                                </a>
                            </li>
                            <li>
                                <a
                                    href="https://discord.gg/rorca"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-zinc-400 hover:text-white transition-colors"
                                >
                                    Discord
                                </a>
                            </li>
                        </ul>
                    </div>
                </div>

                {/* Bottom divider and copyright */}
                <div className="border-t border-white/5 pt-8">
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
                        <div>© 2026 Rorca. All rights reserved.</div>
                        <div>
                            <a
                                href="mailto:support@rorca.app"
                                className="text-zinc-400 hover:text-white transition-colors"
                            >
                                support@rorca.app
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </footer>
    );
}
