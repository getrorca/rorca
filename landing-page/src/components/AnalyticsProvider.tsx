'use client';

import { Suspense, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { initAnalytics, trackPageView } from '@/lib/analytics';

function PageViewTrackerInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const prevPath = useRef('');

  useEffect(() => {
    const url = pathname + (searchParams?.toString() ? `?${searchParams.toString()}` : '');
    if (url !== prevPath.current) {
      prevPath.current = url;
      trackPageView(url);
    }
  }, [pathname, searchParams]);

  return null;
}

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initAnalytics();
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <PageViewTrackerInner />
      </Suspense>
      {children}
    </>
  );
}
