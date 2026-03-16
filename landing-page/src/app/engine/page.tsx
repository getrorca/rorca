import type { Metadata } from 'next';
import { buildMetadata, PAGES_METADATA } from '@/lib/metadata';
import EngineClient from './EngineClient';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.engine);

export default function EnginePage() {
  return <EngineClient />;
}
