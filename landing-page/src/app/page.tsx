import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { FeatureGrid } from '@/components/FeatureGrid';
import { HowItWorks } from '@/components/HowItWorks';
import { Footer } from '@/components/Footer';
import { buildMetadata, PAGES_METADATA, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.home);

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Rorca',
  url: SITE_URL,
  description:
    'Rorca is an AI spec orchestration platform. Turn a plain-English brief into a structured spec, then execute every story autonomously.',
  sameAs: ['https://rorca.ai'],
  logo: {
    '@type': 'ImageObject',
    url: `${SITE_URL}/og/og-default.png`,
  },
};

export default function Home() {
  return (
    <main className="min-h-screen bg-abyss selection:bg-fizz selection:text-abyss relative overflow-hidden flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <Nav />
      <div className="pt-32 flex-grow">
        <Hero />
        <FeatureGrid />
        <div className="w-full h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent my-10" />
        <HowItWorks />
      </div>
      <Footer />
    </main>
  );
}
