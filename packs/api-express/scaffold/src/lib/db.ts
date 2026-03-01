import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data.db');

const db = new Database(DB_PATH);

// WAL mode for concurrent read performance
db.pragma('journal_mode = WAL');

// Enable foreign key constraints
db.pragma('foreign_keys = ON');

export { db };
