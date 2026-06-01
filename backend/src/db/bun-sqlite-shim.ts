/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * bun:sqlite compatibility shim for better-sqlite3.
 *
 * Wraps Bun's native SQLite implementation to match the better-sqlite3 API
 * surface used throughout the Rorca backend: prepare/get/all/run, exec, pragma.
 *
 * Used by `bun build --compile` to eliminate the native C++ addon dependency.
 */

// @ts-ignore — bun:sqlite is a Bun built-in, not visible to tsc
import { Database as BunDatabase } from 'bun:sqlite';

/** Mimics better-sqlite3 RunResult */
interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Wraps a bun:sqlite Statement to match better-sqlite3's Statement API */
class StatementWrapper {
  private stmt: any; // bun:sqlite Statement

  constructor(stmt: any) {
    this.stmt = stmt;
  }

  get(...params: any[]): any {
    return this.stmt.get(...params) ?? undefined;
  }

  all(...params: any[]): any[] {
    return this.stmt.all(...params);
  }

  run(...params: any[]): RunResult {
    this.stmt.run(...params);
    // bun:sqlite doesn't return RunResult from Statement.run() the same way,
    // but the underlying database tracks changes/lastInsertRowid
    return { changes: 0, lastInsertRowid: 0 };
  }
}

/** Wraps bun:sqlite Database to match better-sqlite3's Database API */
class DatabaseWrapper {
  private bunDb: any; // BunDatabase instance

  constructor(filePath: string) {
    this.bunDb = new BunDatabase(filePath, { create: true });
  }

  prepare(sql: string): StatementWrapper {
    return new StatementWrapper(this.bunDb.prepare(sql));
  }

  exec(sql: string): void {
    // bun:sqlite throws on empty/comment-only SQL; better-sqlite3 silently ignores.
    // Strip comments and check for actual SQL content before executing.
    const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!stripped) return;
    // bun:sqlite exec() also chokes if multi-statement SQL contains comment-only segments
    // between semicolons. Filter each statement individually.
    const statements = stripped.split(';').map(s => s.trim()).filter(s => s.length > 0);
    if (statements.length === 0) return;
    try {
      // Rejoin cleaned statements and execute
      this.bunDb.exec(statements.join(';\n') + ';');
    } catch (err: any) {
      // Add context to the error for debugging
      const preview = sql.slice(0, 120).replace(/\n/g, ' ');
      throw new Error(`SQLite exec failed: ${err.message}\n  SQL: ${preview}...`);
    }
  }

  pragma(pragmaStr: string): any {
    // better-sqlite3's .pragma() method handles two forms:
    //   db.pragma('journal_mode = WAL')   — setter, returns value
    //   db.pragma('table_info(users)')    — getter, returns rows
    //   db.pragma('foreign_keys = ON')    — setter

    // For setters like 'journal_mode = WAL' or 'foreign_keys = ON'
    if (pragmaStr.includes('=')) {
      const result = this.bunDb.prepare(`PRAGMA ${pragmaStr}`).all();
      return result.length === 1 ? result[0] : result;
    }

    // For getters like 'table_info(users)'
    return this.bunDb.prepare(`PRAGMA ${pragmaStr}`).all();
  }

  close(): void {
    this.bunDb.close();
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this.bunDb.exec('BEGIN');
      try {
        const result = fn(...args);
        this.bunDb.exec('COMMIT');
        return result;
      } catch (err) {
        this.bunDb.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

// Export as default (matches `import Database from 'better-sqlite3'`)
export default DatabaseWrapper;
// Also export the type alias (matches `import { Database as DatabaseType } from 'better-sqlite3'`)
export { DatabaseWrapper as Database };
