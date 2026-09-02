import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  agent TEXT,
  job TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE TABLE IF NOT EXISTS quota (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  window_start TEXT NOT NULL,
  rpm_used INTEGER NOT NULL DEFAULT 0,
  rpd_used INTEGER NOT NULL DEFAULT 0,
  tpm_used INTEGER NOT NULL DEFAULT 0,
  tpd_used INTEGER NOT NULL DEFAULT 0,
  cooling_until TEXT,
  PRIMARY KEY (provider, model)
);
CREATE TABLE IF NOT EXISTS quota_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS quota_calls_ts ON quota_calls(provider, model, ts);
CREATE TABLE IF NOT EXISTS jobs_index (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  assigned TEXT NOT NULL,
  type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  updated TEXT NOT NULL,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_vectors (
  path TEXT NOT NULL,
  chunk_idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  vector BLOB NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (path, chunk_idx)
);
CREATE TABLE IF NOT EXISTS screens (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS written_sha (
  path TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  ts TEXT NOT NULL,
  by TEXT NOT NULL
);
`;

/** Open (or create) the cache database. Rebuilds the schema if the version pragma mismatches. */
export function openDb(file: string): Db {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
  if (row && Number(row.value) !== SCHEMA_VERSION) {
    // Cache only: drop everything and recreate. The vault + JSONL remain the source of truth.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    db.exec(SCHEMA);
    // The JSONL mirror next to the db is the durable copy; restore the index right away.
    const jsonlDir = path.join(path.dirname(file), 'events');
    if (existsSync(jsonlDir)) {
      const insert = db.prepare('INSERT INTO events(ts, type, agent, job, payload_json) VALUES (?, ?, ?, ?, ?)');
      for (const f of readdirSync(jsonlDir).filter((x) => x.endsWith('.jsonl')).sort()) {
        for (const line of readFileSync(path.join(jsonlDir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const e = JSON.parse(line); insert.run(e.ts, e.type, e.agent ?? null, e.job ?? null, JSON.stringify(e.payload ?? {})); } catch { /* skip */ }
        }
      }
    }
  }
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

export function openMemoryDb(): Db {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}
