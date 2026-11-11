import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA_URL = new URL('./schema.sql', import.meta.url);

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  if ((row?.user_version ?? 0) >= 1) return;
  db.exec(readFileSync(SCHEMA_URL, 'utf8'));
  db.exec('PRAGMA user_version = 1');
}
