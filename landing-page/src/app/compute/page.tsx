import type { Metadata } from 'next';
import { buildMetadata, PAGES_METADATA } from '@/lib/metadata';
import ComputeClient from './ComputeClient';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.compute);

export default function ComputePage() {
  return <ComputeClient />;
}
