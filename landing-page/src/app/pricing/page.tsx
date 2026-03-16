import type { Metadata } from 'next';
import { buildMetadata, PAGES_METADATA } from '@/lib/metadata';
import PricingClient from './PricingClient';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.pricing);

export default function PricingPage() {
  return <PricingClient />;
}
