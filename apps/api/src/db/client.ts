import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env['DB_PATH'] ?? path.join(__dirname, '../../data/updraft.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA foreign_keys = ON');
    // Retry writes for up to 5s before throwing SQLITE_BUSY.
    // Without this, any write that arrives while the pipeline holds a
    // transaction fails instantly with SQLITE_BUSY.
    _db.exec('PRAGMA busy_timeout = 5000');
    // WAL readers never block writers and vice-versa, but WAL checkpoints
    // can still stall. wal_autocheckpoint=0 disables the auto-checkpoint so
    // it doesn't compete with concurrent writes; we checkpoint on shutdown instead.
    _db.exec('PRAGMA wal_autocheckpoint = 0');
    // Keep frequently-used pages in memory.
    _db.exec('PRAGMA cache_size = -8000'); // 8 MB
  }
  return _db;
}

export function withTransaction<T>(db: Database.Database, fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}
