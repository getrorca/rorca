// ─── PostgreSQL Binary Manager ──────────────────────────────────────────────
// DIST-001: Downloads and manages pre-built PostgreSQL 16 binaries (with pgvector
// and AGE extensions) on first run. Same pattern as Prisma (engine binaries)
// and Playwright (browser binaries).
//
// Cache location: ~/.rorca/postgres/
// Supports: darwin-arm64, darwin-x64, linux-x64, win32-x64

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { createGunzip } from 'zlib';
import { logger } from './logger';

// ─── Constants ──────────────────────────────────────────────────────────────

const POSTGRES_VERSION = '16.4';

const DEFAULT_DOWNLOAD_URL =
  'https://github.com/rorca-postgres-builds/releases/download';

type Platform = 'darwin' | 'linux' | 'win32';
type Arch = 'arm64' | 'x64';
type PlatformTarget = `${Platform}-${Arch}`;

const SUPPORTED_TARGETS: PlatformTarget[] = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'win32-x64',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCacheDir(): string {
  return path.join(os.homedir(), '.rorca', 'postgres');
}

function getVersionFile(): string {
  return path.join(getCacheDir(), '.version');
}

function getPlatformTarget(): PlatformTarget {
  const platform = process.platform as string;
  const arch = process.arch as string;
  const target = `${platform}-${arch}` as PlatformTarget;

  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(
      `Unsupported platform: ${target}. Supported targets: ${SUPPORTED_TARGETS.join(', ')}`
    );
  }

  return target;
}

function getBinaryName(): string {
  return process.platform === 'win32' ? 'postgres.exe' : 'postgres';
}

/** Simple ASCII progress bar for terminal output. */
function renderProgress(current: number, total: number, label: string): void {
  if (total <= 0) {
    process.stdout.write(`\r${label} ${formatBytes(current)}`);
    return;
  }

  const pct = Math.min(100, Math.round((current / total) * 100));
  const barWidth = 30;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
  const size = formatBytes(total);
  process.stdout.write(`\r${label} ${bar} ${pct}% (${size})`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

/**
 * Follow redirects (GitHub Releases → S3). Returns the final response stream.
 * Max 5 redirects to prevent loops.
 */
function fetchWithRedirects(
  url: string,
  maxRedirects: number = 5
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        // Follow redirect
        resolve(fetchWithRedirects(res.headers.location, maxRedirects - 1));
        res.resume(); // drain the response
        return;
      }

      if (status !== 200) {
        res.resume();
        reject(
          new Error(`Download failed: HTTP ${status} from ${url}`)
        );
        return;
      }

      resolve(res);
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error('Connection timed out'));
    });
  });
}

// ─── PostgresManager ────────────────────────────────────────────────────────

export class PostgresManager {
  private readonly cacheDir: string;
  private readonly versionFile: string;
  private readonly downloadBaseUrl: string;
  private readonly expectedVersion: string;

  constructor(opts?: { downloadBaseUrl?: string; cacheDir?: string }) {
    this.cacheDir = opts?.cacheDir ?? getCacheDir();
    this.versionFile = opts?.cacheDir
      ? path.join(opts.cacheDir, '.version')
      : getVersionFile();
    this.downloadBaseUrl =
      process.env.POSTGRES_DOWNLOAD_URL?.trim() ||
      opts?.downloadBaseUrl ||
      DEFAULT_DOWNLOAD_URL;
    this.expectedVersion = POSTGRES_VERSION;
  }

  /** Path to the postgres binary inside the cache. */
  getBinPath(): string {
    return path.join(this.cacheDir, 'bin', getBinaryName());
  }

  /** Path to the pg_ctl binary. */
  getPgCtlPath(): string {
    const name = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
    return path.join(this.cacheDir, 'bin', name);
  }

  /** Path to the initdb binary. */
  getInitdbPath(): string {
    const name = process.platform === 'win32' ? 'initdb.exe' : 'initdb';
    return path.join(this.cacheDir, 'bin', name);
  }

  /** Check if postgres binary exists and is executable. */
  isInstalled(): boolean {
    const binPath = this.getBinPath();
    try {
      fs.accessSync(binPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Run `postgres --version` and parse the output. Returns null if not installed. */
  getVersion(): string | null {
    if (!this.isInstalled()) return null;

    try {
      const raw = execSync(`"${this.getBinPath()}" --version`, {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      // Output: "postgres (PostgreSQL) 16.4"
      const match = raw.match(/(\d+\.\d+(?:\.\d+)?)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /** Check if the cached version matches the expected version. */
  needsUpdate(): boolean {
    if (!this.isInstalled()) return true;

    try {
      const storedVersion = fs.readFileSync(this.versionFile, 'utf-8').trim();
      return storedVersion !== this.expectedVersion;
    } catch {
      // No version file → needs download
      return true;
    }
  }

  /**
   * Download and extract the correct PostgreSQL binary for the current platform.
   * Shows progress bar in terminal. Skips if already cached and version matches.
   * Returns the bin path on success.
   */
  async download(): Promise<string> {
    if (!this.needsUpdate()) {
      logger.info(
        `[postgres] PostgreSQL ${this.expectedVersion} already cached at ${this.cacheDir}`
      );
      return this.getBinPath();
    }

    const target = getPlatformTarget();
    const tarballName = `postgres-${this.expectedVersion}-${target}.tar.gz`;
    const url = `${this.downloadBaseUrl}/v${this.expectedVersion}/${tarballName}`;

    logger.info(`[postgres] Downloading PostgreSQL ${this.expectedVersion} for ${target}...`);
    logger.info(`[postgres] URL: ${url}`);

    // Ensure cache directory exists
    fs.mkdirSync(this.cacheDir, { recursive: true });

    const tmpFile = path.join(this.cacheDir, `.download-${Date.now()}.tar.gz`);

    try {
      await this.downloadFile(url, tmpFile);
      process.stdout.write('\n'); // newline after progress bar

      logger.info('[postgres] Extracting...');
      await this.extractTarball(tmpFile, this.cacheDir);

      // Verify the binary works
      if (!this.isInstalled()) {
        throw new Error(
          `Extraction completed but ${this.getBinPath()} not found or not executable`
        );
      }

      const actualVersion = this.getVersion();
      logger.info(
        `[postgres] Installed PostgreSQL ${actualVersion ?? this.expectedVersion} at ${this.cacheDir}`
      );

      // Write version stamp
      fs.writeFileSync(this.versionFile, this.expectedVersion, 'utf-8');

      return this.getBinPath();
    } catch (err) {
      // Clean up partial download
      this.cleanupFile(tmpFile);

      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[postgres] Download failed: ${message}`);
      logger.error('[postgres] Manual install fallback:');
      logger.error(
        `[postgres]   1. Download: ${url}`
      );
      logger.error(
        `[postgres]   2. Extract to: ${this.cacheDir}`
      );
      logger.error(
        `[postgres]   3. Ensure ${this.getBinPath()} is executable`
      );
      logger.error(
        '[postgres]   4. Or set POSTGRES_DOWNLOAD_URL to a mirror/custom build location'
      );

      throw new Error(`PostgreSQL download failed: ${message}`);
    }
  }

  /** Ensure postgres is available — download if needed. Convenience wrapper. */
  async ensureInstalled(): Promise<string> {
    return this.download();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async downloadFile(url: string, dest: string): Promise<void> {
    const label = `Downloading PostgreSQL ${this.expectedVersion} + pgvector...`;

    const res = await fetchWithRedirects(url);
    const total = parseInt(res.headers['content-length'] ?? '0', 10);
    let downloaded = 0;

    return new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(dest);

      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        renderProgress(downloaded, total, label);
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        this.cleanupFile(dest);
        reject(err);
      });

      res.on('error', (err) => {
        this.cleanupFile(dest);
        reject(err);
      });
    });
  }

  private async extractTarball(tarball: string, dest: string): Promise<void> {
    if (process.platform === 'win32') {
      // Windows: use tar (available since Windows 10 1803)
      execSync(`tar -xzf "${tarball}" -C "${dest}" --strip-components=1`, {
        timeout: 120_000,
      });
    } else {
      execSync(`tar -xzf "${tarball}" -C "${dest}" --strip-components=1`, {
        timeout: 120_000,
      });
    }

    // Clean up tarball after extraction
    this.cleanupFile(tarball);

    // Ensure bin/ executables have correct permissions on Unix
    if (process.platform !== 'win32') {
      const binDir = path.join(dest, 'bin');
      if (fs.existsSync(binDir)) {
        const entries = fs.readdirSync(binDir);
        for (const entry of entries) {
          const fullPath = path.join(binDir, entry);
          try {
            fs.chmodSync(fullPath, 0o755);
          } catch {
            // best-effort
          }
        }
      }
    }
  }

  private cleanupFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // best-effort cleanup
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: PostgresManager | null = null;

export function getPostgresManager(): PostgresManager {
  if (!_instance) {
    _instance = new PostgresManager();
  }
  return _instance;
}
