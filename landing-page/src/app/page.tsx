import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { FeatureGrid } from '@/components/FeatureGrid';
import { HowItWorks } from '@/components/HowItWorks';
import { Footer } from '@/components/Footer';

export default function Home() {
  return (
    <main className="min-h-screen bg-abyss selection:bg-fizz selection:text-abyss relative overflow-hidden flex flex-col">
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
