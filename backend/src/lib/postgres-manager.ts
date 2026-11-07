/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── PostgreSQL Binary Manager ──────────────────────────────────────────────
// DIST-001: Downloads and manages pre-built PostgreSQL 16 binaries (with pgvector
// and AGE extensions) on first run. Same pattern as Prisma (engine binaries)
// and Playwright (browser binaries).
// DIST-002: Lifecycle management — initCluster, start, stop, createDatabase,
// waitForReady. Postgres runs on port 5433 to avoid conflicts.
//
// Cache location: ~/.rorca/postgres/
// Data location:  ~/.rorca/data/
// Supports: darwin-arm64, darwin-x64, linux-x64, win32-x64

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { logger } from './logger';

// ─── Constants ──────────────────────────────────────────────────────────────

const POSTGRES_VERSION = '16.4';
const DEFAULT_PORT = 5433;
const DEFAULT_DATABASE = 'rorca';

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

function getRorcaHome(): string {
  return path.join(os.homedir(), '.rorca');
}

function getCacheDir(): string {
  return path.join(getRorcaHome(), 'postgres');
}

function getDataDir(): string {
  return path.join(getRorcaHome(), 'data');
}

function getLogFile(): string {
  return path.join(getRorcaHome(), 'postgres.log');
}

function getPort(): number {
  const envPort = process.env.RORCA_PG_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  }
  return DEFAULT_PORT;
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
  readonly dataDir: string;
  readonly port: number;
  readonly logFile: string;

  constructor(opts?: { downloadBaseUrl?: string; cacheDir?: string; dataDir?: string; port?: number }) {
    this.cacheDir = opts?.cacheDir ?? getCacheDir();
    this.versionFile = opts?.cacheDir
      ? path.join(opts.cacheDir, '.version')
      : getVersionFile();
    this.downloadBaseUrl =
      process.env.POSTGRES_DOWNLOAD_URL?.trim() ||
      opts?.downloadBaseUrl ||
      DEFAULT_DOWNLOAD_URL;
    this.expectedVersion = POSTGRES_VERSION;
    this.dataDir = opts?.dataDir ?? getDataDir();
    this.port = opts?.port ?? getPort();
    this.logFile = getLogFile();
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

  /** Path to the pg_isready binary. */
  getPgIsReadyPath(): string {
    const name = process.platform === 'win32' ? 'pg_isready.exe' : 'pg_isready';
    return path.join(this.cacheDir, 'bin', name);
  }

  /** Path to the createdb binary. */
  getCreatedbPath(): string {
    const name = process.platform === 'win32' ? 'createdb.exe' : 'createdb';
    return path.join(this.cacheDir, 'bin', name);
  }

  /** Path to the psql binary. */
  getPsqlPath(): string {
    const name = process.platform === 'win32' ? 'psql.exe' : 'psql';
    return path.join(this.cacheDir, 'bin', name);
  }

  /** Path to the PID file inside the data directory. */
  getPidFilePath(): string {
    return path.join(this.dataDir, 'postmaster.pid');
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

  // ─── Lifecycle (DIST-002) ───────────────────────────────────────────────

  /**
   * Initialize a new database cluster at dataDir if not already initialized.
   * Runs `initdb` with --no-locale for reproducibility across platforms.
   */
  initCluster(): void {
    // Already initialized if PG_VERSION file exists in data dir
    if (fs.existsSync(path.join(this.dataDir, 'PG_VERSION'))) {
      logger.info(`[postgres] Cluster already initialized at ${this.dataDir}`);
      return;
    }

    fs.mkdirSync(this.dataDir, { recursive: true });

    const initdbBin = this.getInitdbPath();
    logger.info(`[postgres] Initializing cluster at ${this.dataDir}...`);

    try {
      execSync(
        `"${initdbBin}" -D "${this.dataDir}" --no-locale --encoding=UTF8 --auth=trust`,
        {
          encoding: 'utf-8',
          timeout: 60_000,
          env: { ...process.env, LC_ALL: 'C' },
        }
      );
      logger.info('[postgres] Cluster initialized successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`initdb failed: ${msg}`);
    }
  }

  /**
   * Check if the managed Postgres server is running on our port.
   * Uses pg_isready for a reliable check.
   */
  isRunning(): boolean {
    try {
      execSync(
        `"${this.getPgIsReadyPath()}" -h localhost -p ${this.port}`,
        { encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the PID from the postmaster.pid file. Returns null if not found.
   */
  private readPidFile(): number | null {
    try {
      const content = fs.readFileSync(this.getPidFilePath(), 'utf-8');
      const firstLine = content.split('\n')[0].trim();
      const pid = parseInt(firstLine, 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Check if a PID is alive.
   */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if port is in use by our managed Postgres (via PID file).
   * Returns 'ours' if our managed PG is running, 'foreign' if something
   * else occupies the port, 'free' if port is available.
   */
  checkPort(): 'ours' | 'foreign' | 'free' {
    const pid = this.readPidFile();
    if (pid && this.isPidAlive(pid)) {
      // PID file exists and process is alive — it's ours
      return 'ours';
    }

    // Check if something else is on the port
    if (this.isRunning()) {
      // pg_isready succeeds but we have no valid PID file → foreign process
      return 'foreign';
    }

    return 'free';
  }

  /**
   * Start the managed Postgres server. Uses pg_ctl start with log output
   * redirected to ~/.rorca/postgres.log.
   * Throws if port is occupied by a foreign process.
   */
  async start(): Promise<void> {
    const portStatus = this.checkPort();

    if (portStatus === 'ours') {
      logger.info(`[postgres] Already running on port ${this.port} (pid: ${this.readPidFile()})`);
      return;
    }

    if (portStatus === 'foreign') {
      throw new Error(
        `Port ${this.port} is already in use by another process (not managed by Rorca). ` +
        `Either stop the other Postgres on port ${this.port} or set RORCA_PG_PORT to a different port.`
      );
    }

    // Clean up stale PID file if process is dead
    const stalePid = this.readPidFile();
    if (stalePid && !this.isPidAlive(stalePid)) {
      logger.info(`[postgres] Cleaning up stale PID file (pid ${stalePid} is dead)`);
      this.cleanupFile(this.getPidFilePath());
    }

    const pgCtl = this.getPgCtlPath();
    logger.info(`[postgres] Starting server on port ${this.port}...`);

    try {
      execSync(
        `"${pgCtl}" start -D "${this.dataDir}" -l "${this.logFile}" -o "-p ${this.port}" -w`,
        {
          encoding: 'utf-8',
          timeout: 30_000,
          env: { ...process.env, LC_ALL: 'C' },
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pg_ctl start failed: ${msg}. Check ${this.logFile} for details.`);
    }

    // Verify it's actually running
    await this.waitForReady(10_000);
    logger.info(`[postgres] Server started on port ${this.port} (pid: ${this.readPidFile()})`);
  }

  /**
   * Stop the managed Postgres server cleanly using pg_ctl stop -m fast.
   * No-op if server is not running.
   */
  stop(): void {
    if (!this.isRunning()) {
      logger.info('[postgres] Server is not running — nothing to stop');
      return;
    }

    const pgCtl = this.getPgCtlPath();
    logger.info('[postgres] Stopping server...');

    try {
      execSync(
        `"${pgCtl}" stop -D "${this.dataDir}" -m fast -w`,
        {
          encoding: 'utf-8',
          timeout: 30_000,
          env: { ...process.env, LC_ALL: 'C' },
        }
      );
      logger.info('[postgres] Server stopped');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[postgres] pg_ctl stop failed: ${msg}`);
      // Force kill via PID as last resort
      const pid = this.readPidFile();
      if (pid && this.isPidAlive(pid)) {
        logger.info(`[postgres] Force-killing pid ${pid}`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // best-effort
        }
      }
    }
  }

  /**
   * Create the rorca database if it doesn't exist.
   * Uses createdb which fails gracefully if DB already exists.
   */
  createDatabase(): void {
    const createdbBin = this.getCreatedbPath();

    // Check if database already exists by trying to connect
    try {
      execSync(
        `"${this.getPgIsReadyPath()}" -h localhost -p ${this.port} -d ${DEFAULT_DATABASE}`,
        { encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }
      );
      // pg_isready succeeds → database likely exists, but let createdb confirm
    } catch {
      // expected if database doesn't exist yet
    }

    try {
      execSync(
        `"${createdbBin}" -h localhost -p ${this.port} ${DEFAULT_DATABASE}`,
        { encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' }
      );
      logger.info(`[postgres] Database "${DEFAULT_DATABASE}" created`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "already exists" is not an error
      if (msg.includes('already exists')) {
        logger.info(`[postgres] Database "${DEFAULT_DATABASE}" already exists`);
        return;
      }
      throw new Error(`createdb failed: ${msg}`);
    }
  }

  /**
   * LHM-009: Verify pgvector is available on the managed native Postgres before
   * the native setup is declared successful. The bundled Rorca Postgres binary
   * ships with pgvector, but a partial/foreign extraction can leave the
   * extension's shared library missing. We check that `vector` is an available
   * extension and that `CREATE EXTENSION IF NOT EXISTS vector` succeeds, and on
   * failure return a concrete fix path instead of silently degrading.
   *
   * Returns { ok: true } when pgvector is installable/installed, or
   * { ok: false, fixPath } with actionable remediation when it is not.
   */
  verifyPgvector(): { ok: boolean; fixPath?: string } {
    const fixPath =
      'pgvector is not available on the bundled native Postgres. Reinstall it with `rorca start` ' +
      `(the binary at ${this.cacheDir} ships pgvector), or on a custom local Postgres install the ` +
      'pgvector extension and run `CREATE EXTENSION IF NOT EXISTS vector;` before continuing.';

    const psql = this.getPsqlPath();
    try {
      // 1. Confirm the extension's shared library is present and registered.
      const available = execSync(
        `"${psql}" -h localhost -p ${this.port} -d ${DEFAULT_DATABASE} -tAc ` +
          `"SELECT 1 FROM pg_available_extensions WHERE name = 'vector'"`,
        { encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' }
      ).trim();

      if (available !== '1') {
        return { ok: false, fixPath };
      }

      // 2. Ensure it is actually creatable in the rorca database.
      execSync(
        `"${psql}" -h localhost -p ${this.port} -d ${DEFAULT_DATABASE} -c ` +
          `"CREATE EXTENSION IF NOT EXISTS vector;"`,
        { encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' }
      );
      return { ok: true };
    } catch {
      return { ok: false, fixPath };
    }
  }

  /**
   * Poll pg_isready until the server is accepting connections.
   * Throws if timeout is exceeded.
   */
  async waitForReady(timeoutMs: number = 30_000): Promise<void> {
    const pollInterval = 500;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (this.isRunning()) return;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(
      `PostgreSQL did not become ready within ${timeoutMs}ms. Check ${this.logFile} for details.`
    );
  }

  /**
   * Get the DATABASE_URL connection string for the managed Postgres.
   */
  getDatabaseUrl(): string {
    return `postgresql://localhost:${this.port}/${DEFAULT_DATABASE}`;
  }

  /**
   * Full lifecycle: ensure binary, init cluster, start server, create DB,
   * set DATABASE_URL in process.env.
   */
  async ensureRunning(): Promise<string> {
    await this.ensureInstalled();
    this.initCluster();
    await this.start();
    this.createDatabase();

    // LHM-009: Native/local startup checks for pgvector explicitly and tells the
    // user how to enable or install it before declaring the setup successful.
    const pgvector = this.verifyPgvector();
    if (!pgvector.ok) {
      throw new Error(pgvector.fixPath ?? 'pgvector is required but is not available on the native Postgres.');
    }
    logger.info('[postgres] pgvector extension verified');

    const url = this.getDatabaseUrl();
    process.env.DATABASE_URL = url;
    logger.info(`[postgres] DATABASE_URL set to ${url}`);

    return url;
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
