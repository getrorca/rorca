#!/usr/bin/env tsx
/**
 * OG Image Generator
 * Generates static 1200x630 PNG OG images for each landing page route.
 * Run: npx tsx landing-page/scripts/generate-og.ts
 * Or:  npm run generate-og  (from landing-page/)
 */

import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = path.join(__dirname, '..', 'public', 'og');
const W = 1200;
const H = 630;

interface PageDef {
  name: string;
  title: string;
  tagline: string;
  accentColor?: string;
}

const PAGES: PageDef[] = [
  {
    name: 'home',
    title: 'AI Spec Orchestration',
    tagline: 'Ship features autonomously. No context limits.',
    accentColor: '#8b5cf6',
  },
  {
    name: 'architecture',
    title: 'Architecture',
    tagline: 'Direction Stack meets isolated subprocesses.',
    accentColor: '#6d28d9',
  },
  {
    name: 'engine',
    title: 'Context-Intent Engine',
    tagline: 'Right context to every story, automatically.',
    accentColor: '#7c3aed',
  },
  {
    name: 'compute',
    title: 'Compute & Execution',
    tagline: 'Fresh subprocess per story. Full tool set.',
    accentColor: '#5b21b6',
  },
  {
    name: 'pricing',
    title: 'Pricing',
    tagline: 'Free to spec. Pay to ship.',
    accentColor: '#8b5cf6',
  },
  {
    name: 'download',
    title: 'Download Rorca',
    tagline: 'One command. Self-hosted. Forever free.',
    accentColor: '#7c3aed',
  },
];

const DEFAULT_PAGE: PageDef = {
  name: 'og-default',
  title: 'AI Spec Orchestration',
  tagline: 'Turn a brief into shipped code — autonomously.',
  accentColor: '#8b5cf6',
};

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wraps long text into multiple tspan lines at a given max char width.
 * Returns SVG tspan elements as a string.
 */
function wrapText(text: string, x: number, y: number, maxCharsPerLine: number, lineHeight: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  // Center vertically around y
  const totalHeight = (lines.length - 1) * lineHeight;
  const startY = y - totalHeight / 2;

  return lines
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? startY - y : lineHeight}">${escapeXml(line)}</tspan>`)
    .join('');
}

function buildSvg(page: PageDef): string {
  const accent = page.accentColor ?? '#8b5cf6';

  // Title font size — shrink for long titles
  const titleFontSize = page.title.length > 20 ? 58 : 68;

  const titleTspans = wrapText(page.title, W / 2, 295, 28, titleFontSize * 1.2);
  const taglineTspans = wrapText(page.tagline, W / 2, 400, 52, 38);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <!-- Background gradient -->
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#09090b"/>
      <stop offset="50%" stop-color="#0d0d14"/>
      <stop offset="100%" stop-color="#09090b"/>
    </linearGradient>

    <!-- Radial glow -->
    <radialGradient id="glow" cx="50%" cy="20%" r="55%" fx="50%" fy="20%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>

    <!-- Logo gradient -->
    <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="#6d28d9"/>
    </linearGradient>

    <!-- Subtle grid pattern -->
    <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
      <path d="M 60 0 L 0 0 0 60" fill="none" stroke="rgba(255,255,255,0.025)" stroke-width="1"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- Grid overlay -->
  <rect width="${W}" height="${H}" fill="url(#grid)"/>

  <!-- Glow effect -->
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- Subtle top border accent -->
  <rect x="0" y="0" width="${W}" height="3" fill="${accent}" opacity="0.6"/>

  <!-- Logo mark (rounded rect + R) -->
  <rect x="${W / 2 - 32}" y="100" width="64" height="64" rx="16" ry="16" fill="url(#logoGrad)"/>
  <text
    x="${W / 2}"
    y="146"
    text-anchor="middle"
    dominant-baseline="auto"
    font-family="system-ui, -apple-system, sans-serif"
    font-size="34"
    font-weight="700"
    fill="white"
  >R</text>

  <!-- Wordmark -->
  <text
    x="${W / 2}"
    y="205"
    text-anchor="middle"
    dominant-baseline="auto"
    font-family="system-ui, -apple-system, sans-serif"
    font-size="28"
    font-weight="700"
    letter-spacing="-0.5"
    fill="#fafafa"
  >Rorca</text>

  <!-- Page title -->
  <text
    text-anchor="middle"
    font-family="system-ui, -apple-system, sans-serif"
    font-size="${titleFontSize}"
    font-weight="700"
    letter-spacing="-1.5"
    fill="#fafafa"
    y="${295}"
  >${titleTspans}</text>

  <!-- Divider line -->
  <rect x="${W / 2 - 40}" y="358" width="80" height="2" rx="1" fill="${accent}" opacity="0.5"/>

  <!-- Tagline -->
  <text
    text-anchor="middle"
    font-family="system-ui, -apple-system, sans-serif"
    font-size="28"
    font-weight="400"
    fill="rgba(250,250,250,0.55)"
    y="400"
  >${taglineTspans}</text>

  <!-- Domain badge -->
  <text
    x="${W / 2}"
    y="${H - 36}"
    text-anchor="middle"
    font-family="system-ui, -apple-system, sans-serif"
    font-size="18"
    letter-spacing="0.5"
    fill="rgba(250,250,250,0.3)"
  >rorca.app</text>
</svg>`;
}

async function generateImage(page: PageDef): Promise<void> {
  const outPath = path.join(OUT_DIR, `${page.name}.png`);
  const startMs = Date.now();

  process.stdout.write(`Generating OG image for ${page.name}... `);

  const svg = buildSvg(page);

  await sharp(Buffer.from(svg))
    .resize(W, H)
    .png({ compressionLevel: 8 })
    .toFile(outPath);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`done (${elapsed}s)`);
}

async function main(): Promise<void> {
  // Ensure output directory exists
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = [...PAGES, DEFAULT_PAGE];

  for (const page of all) {
    try {
      await generateImage(page);
    } catch (err) {
      console.error(`\nOG generation failed for ${page.name}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // Validation: confirm all expected files exist at 1200x630
  const expected = [...PAGES.map((p) => p.name), DEFAULT_PAGE.name];
  let allOk = true;

  for (const name of expected) {
    const filePath = path.join(OUT_DIR, `${name}.png`);
    if (!fs.existsSync(filePath)) {
      console.error(`Missing OG image for ${name}, using default`);
      allOk = false;
    }
  }

  if (!allOk) {
    process.exit(1);
  }

  console.log(`\n✓ All ${all.length} OG images generated in ${OUT_DIR}`);
}

main();
