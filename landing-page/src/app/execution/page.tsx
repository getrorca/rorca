import type { Metadata } from 'next';
import { buildMetadata, PAGES_METADATA } from '@/lib/metadata';
import ExecutionClient from './ExecutionClient';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.execution);

export default function ExecutionPage() {
  return <ExecutionClient />;
}
