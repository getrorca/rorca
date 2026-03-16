import type { Metadata } from 'next';
import { buildMetadata, PAGES_METADATA } from '@/lib/metadata';
import ArchitectureClient from './ArchitectureClient';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.architecture);

export default function ArchitecturePage() {
  return <ArchitectureClient />;
}
