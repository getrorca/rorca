import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';

const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const RETENTION_DAYS = 30;

export function getBackupDir(): string {
  return process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

/**
 * Create a SQLite backup using the .backup() API.
 * This produces a consistent snapshot even while the WAL is active.
 * Returns the absolute path to the backup file.
 */
export async function createBackup(): Promise<{ filename: string; path: string; size: number }> {
  const backupDir = getBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `rorcha-backup-${timestamp}.db`;
  const backupPath = path.join(backupDir, filename);

  await db.backup(backupPath);

  const stat = fs.statSync(backupPath);
  return { filename, path: backupPath, size: stat.size };
}

export interface BackupInfo {
  filename: string;
  size: number;
  createdAt: string;
}

/**
 * List available backups sorted by creation time (newest first).
 */
export function listBackups(): BackupInfo[] {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('rorcha-backup-') && f.endsWith('.db'));

  return files
    .map(filename => {
      const stat = fs.statSync(path.join(backupDir, filename));
      return {
        filename,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Delete backups older than RETENTION_DAYS.
 * Returns count of deleted files.
 */
export function pruneOldBackups(): number {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return 0;

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('rorcha-backup-') && f.endsWith('.db'));

  for (const filename of files) {
    const filePath = path.join(backupDir, filename);
    const stat = fs.statSync(filePath);
    if (stat.birthtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      deleted++;
    }
  }

  return deleted;
}
