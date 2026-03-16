import posthog from 'posthog-js';

type QueuedEvent = { name: string; properties?: Record<string, string> };

let initialized = false;
let disabled = false;
const queue: QueuedEvent[] = [];

function isDNT(): boolean {
  if (typeof window === 'undefined') return false;
  return navigator.doNotTrack === '1' || (window as unknown as { doNotTrack?: string }).doNotTrack === '1';
}

export function initAnalytics(): void {
  if (typeof window === 'undefined') return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || isDNT()) {
    disabled = true;
    return;
  }

  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    persistence: 'memory',
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    loaded: () => {
      initialized = true;
      for (const e of queue) {
        posthog.capture(e.name, e.properties);
      }
      queue.length = 0;
    },
  });
}

function capture(name: string, properties?: Record<string, string>): void {
  if (disabled) return;
  if (initialized) {
    posthog.capture(name, properties);
  } else {
    queue.push({ name, properties });
  }
}

export function trackPageView(path: string): void {
  capture('$pageview', { $current_url: path });
}

export function trackCtaClick(button: string, page: string): void {
  capture('cta_click', { button, page });
}

export function trackDownload(platform: string): void {
  capture('download_click', { platform });
}

export function trackAuthComplete(method: 'github' | 'email'): void {
  capture('auth_complete', { method });
}

export function trackPricingToggle(billing: 'monthly' | 'annual'): void {
  capture('pricing_toggle', { billing });
}
