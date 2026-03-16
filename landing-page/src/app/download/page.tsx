import type { Metadata } from 'next';
import { buildMetadata, PAGES_METADATA, SITE_URL } from '@/lib/metadata';
import DownloadClient from './DownloadClient';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.download);

const softwareAppJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Rorca',
  url: `${SITE_URL}/download`,
  downloadUrl: `${SITE_URL}/download`,
  operatingSystem: 'macOS, Linux',
  applicationCategory: 'DeveloperApplication',
  description:
    'Rorca is a self-hosted AI spec orchestration platform. A single binary, Postgres auto-provisioned, dashboard ready in under 30 seconds.',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
  author: {
    '@type': 'Organization',
    name: 'Rorca',
    url: SITE_URL,
  },
};

export default function DownloadPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareAppJsonLd) }}
      />
      <DownloadClient />
    </>
  );
}
