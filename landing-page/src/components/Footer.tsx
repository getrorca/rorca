import Link from 'next/link';

export function Footer() {
    return (
        <footer className="border-t border-white/5 mt-32 py-12">
            <div className="max-w-7xl mx-auto px-6 sm:px-12 flex flex-col md:flex-row items-center justify-between gap-6">
                <div className="flex items-center gap-2">
                    <span className="font-bold text-xl tracking-tighter text-iceberg">Rorca</span>
                    <span className="text-iceberg/50 text-sm">© {new Date().getFullYear()}</span>
                </div>
                <div className="flex gap-8">
                    <Link href="#" className="text-iceberg/50 hover:text-fizz transition-colors text-sm font-medium">Twitter</Link>
                    <Link href="#" className="text-iceberg/50 hover:text-fizz transition-colors text-sm font-medium">GitHub</Link>
                    <Link href="#" className="text-iceberg/50 hover:text-fizz transition-colors text-sm font-medium">Terms</Link>
                </div>
            </div>
        </footer>
    );
}
