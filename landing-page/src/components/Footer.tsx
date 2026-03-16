import Link from 'next/link';

export function Footer() {
    return (
        <footer className="border-t border-white/5 mt-32 py-12">
            <div className="max-w-7xl mx-auto px-6 sm:px-12">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
                    {/* Brand */}
                    <div className="flex flex-col gap-2">
                        <span className="font-bold text-lg tracking-tighter">Rorca</span>
                        <span className="text-zinc-400/50 text-sm">AI spec orchestration</span>
                    </div>

                    {/* Product */}
                    <div className="flex flex-col gap-3">
                        <h3 className="text-sm font-semibold text-zinc-300">Product</h3>
                        <div className="flex flex-col gap-2">
                            <Link href="/changelog" className="text-zinc-400 hover:text-white transition-colors text-sm">
                                Changelog
                            </Link>
                            <Link href="/architecture" className="text-zinc-400 hover:text-white transition-colors text-sm">
                                Architecture
                            </Link>
                        </div>
                    </div>

                    {/* Resources */}
                    <div className="flex flex-col gap-3">
                        <h3 className="text-sm font-semibold text-zinc-300">Resources</h3>
                        <div className="flex flex-col gap-2">
                            <Link href="#" className="text-zinc-400 hover:text-white transition-colors text-sm">
                                Documentation
                            </Link>
                            <Link href="#" className="text-zinc-400 hover:text-white transition-colors text-sm">
                                GitHub
                            </Link>
                        </div>
                    </div>

                    {/* Social */}
                    <div className="flex flex-col gap-3">
                        <h3 className="text-sm font-semibold text-zinc-300">Social</h3>
                        <div className="flex flex-col gap-2">
                            <Link href="#" className="text-zinc-400 hover:text-white transition-colors text-sm">
                                Twitter
                            </Link>
                            <Link href="#" className="text-zinc-400 hover:text-white transition-colors text-sm">
                                Discord
                            </Link>
                        </div>
                    </div>
                </div>

                {/* Bottom Bar */}
                <div className="border-t border-white/5 pt-8 flex flex-col md:flex-row items-center justify-between gap-6">
                    <span className="text-zinc-400/50 text-sm">© {new Date().getFullYear()} Rorca. All rights reserved.</span>
                    <div className="flex gap-6">
                        <Link href="#" className="text-zinc-400/50 hover:text-zinc-300 transition-colors text-sm">
                            Terms
                        </Link>
                        <Link href="#" className="text-zinc-400/50 hover:text-zinc-300 transition-colors text-sm">
                            Privacy
                        </Link>
                    </div>
                </div>
            </div>
        </footer>
    );
}
