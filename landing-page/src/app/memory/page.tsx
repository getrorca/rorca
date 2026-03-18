import type { Metadata } from 'next';
import { buildMetadata, PAGES_METADATA } from '@/lib/metadata';
import MemoryClient from './MemoryClient';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.memory);

export default function MemoryPage() {
  return <MemoryClient />;
}
