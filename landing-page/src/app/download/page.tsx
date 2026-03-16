'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { Download, Copy, Check, Monitor, Terminal, Database, Globe, ChevronRight, AlertTriangle, CheckCircle, ExternalLink } from 'lucide-react';
import { useState, useEffect } from 'react';

type Platform = 'macos-arm64' | 'macos-x64' | 'linux-x64' | 'windows-x64';

interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  assets: GitHubAsset[];
  html_url: string;
}

interface ReleaseCache {
  data: GitHubRelease;
  timestamp: number;
}

interface PlatformAsset {
  id: Platform;
  label: string;
  os: string;
  arch: string;
  filename: string;
  icon: string;
  isMac: boolean;
}

const PLATFORMS: PlatformAsset[] = [
  {
    id: 'macos-arm64',
    label: 'macOS Apple Silicon',
    os: 'macOS',
    arch: 'ARM64',
    filename: 'rorca-macos-arm64',
    icon: '🍎',
    isMac: true,
  },
  {
    id: 'macos-x64',
    label: 'macOS Intel',
    os: 'macOS',
    arch: 'x64',
    filename: 'rorca-macos-x64',
    icon: '🍎',
    isMac: true,
  },
  {
    id: 'linux-x64',
    label: 'Linux',
    os: 'Linux',
    arch: 'x64',
    filename: 'rorca-linux-x64',
    icon: '🐧',
    isMac: false,
  },
  {
    id: 'windows-x64',
    label: 'Windows',
    os: 'Windows',
    arch: 'x64',
    filename: 'rorca-windows-x64.exe',
    icon: '🪟',
    isMac: false,
  },
];

const GITHUB_RELEASES_BASE = 'https://github.com/getrorca/rorca/releases/latest/download';
const GITHUB_RELEASES_PAGE = 'https://github.com/getrorca/rorca/releases';
const CACHE_KEY = 'rorca_release_cache';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const CURL_ONELINER = 'curl -fsSL https://get.rorca.app | sh';

const START_STEPS = [
  {
    num: 1,
    icon: Database,
    title: 'Downloads Postgres if needed',
    description: 'Fetches embedded PostgreSQL 16 binaries (~50MB). Skipped if Postgres is already running or DATABASE_URL is set.',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
  },
  {
    num: 2,
    icon: Terminal,
    title: 'Starts Postgres on :5433',
    description: 'Initialises a local cluster with initdb, starts pg_ctl, creates the rorca user and database. Zero config required.',
    color: 'text-sky-400',
    bg: 'bg-sky-500/10',
    border: 'border-sky-500/20',
  },
  {
    num: 3,
    icon: Globe,
    title: 'Runs migrations',
    description: 'Applies all schema migrations automatically. Safe to run repeatedly — idempotent IF NOT EXISTS guards throughout.',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
  },
  {
    num: 4,
    icon: Monitor,
    title: 'Opens dashboard at localhost:3030',
    description: 'Launches the Rorca UI in your browser. Backend API on :3030, frontend on :5210 in dev mode.',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
  },
];

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'macos-arm64';

  // User-Agent Client Hints API (Chrome 90+, Edge 90+) — more reliable than UA string
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const clientHintsPlatform = uaData?.platform?.toLowerCase() ?? '';

  // Fallback: legacy navigator.platform
  const legacyPlatform = navigator.platform?.toLowerCase() ?? '';

  // Fallback: UA string
  const ua = navigator.userAgent.toLowerCase();

  const platformStr = clientHintsPlatform || legacyPlatform || ua;

  if (platformStr.includes('win')) return 'windows-x64';
  if (platformStr.includes('linux')) return 'linux-x64';
  if (platformStr.includes('mac') || platformStr.includes('darwin')) {
    // Best-effort ARM detection: UA string sometimes contains 'arm', 'apple', or 'aarch'
    // navigator.platform on Apple Silicon still reports "MacIntel" in many browsers
    // so we default to arm64 (more common modern Mac)
    return 'macos-arm64';
  }

  return 'macos-arm64';
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatReleaseDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

function readCache(): GitHubRelease | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: ReleaseCache = JSON.parse(raw);
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null;
    return cached.data;
  } catch {
    // localStorage unavailable (private browsing) or parse error
    return null;
  }
}

function writeCache(data: GitHubRelease): void {
  try {
    const entry: ReleaseCache = { data, timestamp: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // localStorage unavailable — skip silently
  }
}

function DownloadButtonSkeleton() {
  return (
    <div className="animate-pulse bg-zinc-800/60 border border-white/5 rounded-xl p-5 flex items-center gap-4">
      <div className="w-10 h-10 rounded-lg bg-zinc-700/60" />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-zinc-700/60 rounded w-32" />
        <div className="h-3 bg-zinc-700/40 rounded w-20" />
      </div>
      <div className="h-9 w-28 bg-zinc-700/60 rounded-lg" />
    </div>
  );
}

export default function DownloadPage() {
  const [detected, setDetected] = useState<Platform | null>(null);
  const [copied, setCopied] = useState(false);
  // null = loading, false = failed/no releases, GitHubRelease = success
  const [release, setRelease] = useState<GitHubRelease | null | false>(null);

  useEffect(() => {
    setDetected(detectPlatform());

    // Try cache first
    const cached = readCache();
    if (cached) {
      setRelease(cached);
      return;
    }

    // Fetch with ETag conditional request support
    const storedEtag = (() => {
      try { return localStorage.getItem(`${CACHE_KEY}_etag`) ?? undefined; } catch { return undefined; }
    })();

    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (storedEtag) headers['If-None-Match'] = storedEtag;

    fetch('https://api.github.com/repos/getrorca/rorca/releases/latest', { headers })
      .then(async (r) => {
        if (r.status === 304) {
          // Not modified — bump cache TTL by rewriting with existing data
          const stale = readCache();
          if (stale) { writeCache(stale); setRelease(stale); }
          else setRelease(false);
          return;
        }
        if (r.status === 403 || r.status === 429) {
          // Rate limited — fall back to static links (no error shown to user)
          setRelease(false);
          return;
        }
        if (!r.ok) {
          // 404 (private repo / no releases) or other error
          setRelease(false);
          return;
        }

        // Store ETag for future conditional requests
        const etag = r.headers.get('ETag');
        if (etag) {
          try { localStorage.setItem(`${CACHE_KEY}_etag`, etag); } catch { /* skip */ }
        }

        const data: GitHubRelease = await r.json();
        writeCache(data);
        setRelease(data);
      })
      .catch(() => {
        // Network error — fall back to static links silently
        setRelease(false);
      });
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(CURL_ONELINER).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const isLoading = detected === null || release === null;
  const hasRelease = release !== null && release !== false;
  const noReleases = release === false;
  const showMacWarning = detected === 'macos-arm64' || detected === 'macos-x64';

  // Find the asset size for a given platform filename
  const getAssetSize = (filename: string): string => {
    if (!hasRelease) return '';
    const asset = (release as GitHubRelease).assets.find((a) =>
      a.name === filename || a.name.startsWith(filename)
    );
    return asset ? formatBytes(asset.size) : '';
  };

  // Get the direct download URL from the release assets, falling back to the CDN pattern
  const getDownloadUrl = (platform: PlatformAsset): string => {
    if (hasRelease) {
      const asset = (release as GitHubRelease).assets.find((a) =>
        a.name === platform.filename || a.name.startsWith(platform.filename)
      );
      if (asset) return asset.browser_download_url;
    }
    return `${GITHUB_RELEASES_BASE}/${platform.filename}`;
  };

  return (
    <main className="min-h-screen bg-abyss text-white selection:bg-fizz selection:text-abyss flex flex-col">
      <Nav />
      <div className="pt-32 pb-24 px-6 sm:px-12 mx-auto max-w-5xl w-full flex-grow">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="mb-16 text-center"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/5 text-xs font-medium text-zinc-400 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Self-hosted · No cloud required
          </div>
          <h1 className="text-4xl md:text-6xl font-medium tracking-tight mb-5">
            Download Rorca
          </h1>
          <p className="text-zinc-400 text-xl max-w-2xl mx-auto leading-relaxed">
            A single binary. Postgres auto-provisioned. Dashboard ready in under 30 seconds.
          </p>

          {/* Release version + date */}
          {hasRelease && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="mt-6 flex items-center justify-center gap-3 flex-wrap"
            >
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-300 text-sm font-mono font-medium">
                {(release as GitHubRelease).tag_name}
              </span>
              {(release as GitHubRelease).published_at && (
                <span className="text-sm text-zinc-500">
                  Released {formatReleaseDate((release as GitHubRelease).published_at)}
                </span>
              )}
              <a
                href={(release as GitHubRelease).html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Release notes <ExternalLink className="w-3 h-3" />
              </a>
            </motion.div>
          )}
        </motion.div>

        {/* curl | sh one-liner */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}
          className="mb-14"
        >
          <p className="text-center text-sm font-medium text-zinc-500 uppercase tracking-widest mb-4">
            Quickest path — macOS &amp; Linux
          </p>
          <div className="relative group mx-auto max-w-2xl">
            <div className="flex items-center justify-between bg-zinc-900 border border-white/10 rounded-xl px-5 py-4 font-mono text-sm">
              <span className="text-zinc-300 select-all">{CURL_ONELINER}</span>
              <button
                onClick={handleCopy}
                aria-label="Copy to clipboard"
                className="ml-4 flex-shrink-0 p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
            {copied && (
              <p className="text-center text-xs text-emerald-400 mt-2 font-medium">Copied!</p>
            )}
          </div>
        </motion.div>

        {/* macOS warning */}
        {showMacWarning && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
            className="mb-10 mx-auto max-w-2xl flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-5 py-4 text-sm text-amber-300"
          >
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              After downloading, you may need to allow Rorca in{' '}
              <strong>System Settings › Privacy &amp; Security</strong> before running.
            </span>
          </motion.div>
        )}

        {/* Platform download buttons */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2, ease: 'easeOut' }}
          className="mb-20"
        >
          <p className="text-center text-sm font-medium text-zinc-500 uppercase tracking-widest mb-6">
            Or download the binary
          </p>

          {/* No releases yet — empty state */}
          {!isLoading && noReleases && (
            <div className="text-center text-sm text-zinc-500 mb-6">
              No releases available yet.{' '}
              <a
                href={GITHUB_RELEASES_PAGE}
                target="_blank"
                rel="noopener noreferrer"
                className="text-violet-400 hover:text-violet-300 transition-colors inline-flex items-center gap-1"
              >
                Check /releases <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}

          <div className="space-y-3 max-w-2xl mx-auto">
            {isLoading
              ? PLATFORMS.map((p) => <DownloadButtonSkeleton key={p.id} />)
              : PLATFORMS.map((platform, idx) => {
                  const isActive = detected === platform.id;
                  const assetSize = getAssetSize(platform.filename);
                  const downloadUrl = getDownloadUrl(platform);

                  return (
                    <motion.div
                      key={platform.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.3, delay: idx * 0.06 }}
                      className={`flex items-center gap-4 rounded-xl p-5 border transition-all ${
                        isActive
                          ? 'bg-white/5 border-violet-500'
                          : 'bg-zinc-900/50 border-white/5 opacity-70 hover:opacity-100 hover:border-white/10'
                      }`}
                    >
                      <span className="text-2xl w-9 text-center flex-shrink-0">{platform.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white text-sm">{platform.label}</span>
                          {isActive && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                              Detected
                            </span>
                          )}
                          {assetSize && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-white/5 font-mono">
                              {assetSize}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-500 mt-0.5 font-mono">{platform.filename}</p>
                      </div>

                      {noReleases ? (
                        <span
                          aria-disabled="true"
                          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-zinc-800/50 text-zinc-500 cursor-not-allowed select-none border border-white/5"
                        >
                          Coming Soon
                        </span>
                      ) : (
                        <a
                          href={downloadUrl}
                          download
                          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                            isActive
                              ? 'bg-white text-zinc-950 hover:bg-zinc-100'
                              : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                          }`}
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </a>
                      )}
                    </motion.div>
                  );
                })}
          </div>
        </motion.div>

        {/* rorca start visual */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3, ease: 'easeOut' }}
          className="mb-20"
        >
          <h2 className="text-center text-2xl font-medium mb-2">What happens when you run <code className="font-mono text-violet-400 text-xl">rorca start</code></h2>
          <p className="text-center text-zinc-500 text-sm mb-10">Four steps, zero config.</p>

          <div className="relative">
            {/* Connector line */}
            <div className="absolute left-9 top-10 bottom-10 w-px bg-gradient-to-b from-violet-500/40 via-sky-500/40 to-amber-500/40 hidden sm:block" />

            <div className="space-y-4">
              {START_STEPS.map((step, i) => {
                const Icon = step.icon;
                return (
                  <motion.div
                    key={step.num}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.4, delay: 0.35 + i * 0.08 }}
                    className={`flex items-start gap-5 p-5 rounded-xl border ${step.bg} ${step.border} relative`}
                  >
                    <div className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${step.bg} border ${step.border} relative z-10`}>
                      <Icon className={`w-4 h-4 ${step.color}`} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-mono font-medium ${step.color}`}>Step {step.num}</span>
                        <ChevronRight className="w-3 h-3 text-zinc-600" />
                        <span className="text-sm font-medium text-white">{step.title}</span>
                      </div>
                      <p className="text-sm text-zinc-400 leading-relaxed">{step.description}</p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </motion.div>

        {/* System requirements */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4, ease: 'easeOut' }}
        >
          <h2 className="text-center text-2xl font-medium mb-8">System Requirements</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
            {[
              { label: 'Git', detail: 'Any recent version', ok: true },
              { label: '2 GB RAM', detail: 'Minimum for Postgres + pipeline', ok: true },
              { label: 'PostgreSQL 16', detail: 'Auto-provisioned on first run', ok: true, note: 'included' },
              { label: 'Node.js', detail: 'Bundled inside the binary', ok: true, note: 'bundled' },
            ].map((req) => (
              <div key={req.label} className="flex items-center gap-3 bg-zinc-900/50 border border-white/5 rounded-xl px-5 py-4">
                <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{req.label}</span>
                    {req.note && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-white/5">
                        {req.note}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-500 mt-0.5">{req.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>

      </div>
      <Footer />
    </main>
  );
}
