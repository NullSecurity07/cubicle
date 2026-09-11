import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { CubicleEvent, type EventType, type NewEvent } from './schemas.js';
import { nowIso } from './fs.js';

export type EventListener = (e: CubicleEvent) => void;

/**
 * Append-only event log: SQLite `events` + JSONL mirror under `.cubicle/events/YYYY-MM-DD.jsonl`.
 * The JSONL is the durable copy; SQLite is a rebuildable index.
 */
export class EventLog {
  private emitter = new EventEmitter();
  private insert;

  constructor(private db: Db, private jsonlDir: string) {
    mkdirSync(jsonlDir, { recursive: true });
    this.insert = db.prepare('INSERT INTO events(ts, type, agent, job, payload_json) VALUES (?, ?, ?, ?, ?)');
    this.emitter.setMaxListeners(100);
  }

  emit(ev: NewEvent): CubicleEvent {
    const full = CubicleEvent.parse({ ...ev, ts: ev.ts ?? nowIso() });
    const payloadJson = JSON.stringify(full.payload ?? {});
    const info = this.insert.run(full.ts, full.type, full.agent ?? null, full.job ?? null, payloadJson);
    full.id = Number(info.lastInsertRowid);
    const day = full.ts.slice(0, 10);
    appendFileSync(path.join(this.jsonlDir, `${day}.jsonl`), JSON.stringify(full) + '\n');
    this.emitter.emit('event', full);
    this.emitter.emit(full.type, full);
    return full;
  }

  on(type: EventType | '*', fn: EventListener): () => void {
    const key = type === '*' ? 'event' : type;
    this.emitter.on(key, fn);
    return () => this.emitter.off(key, fn);
  }

  /**
   * Bounded event query. `limit` always keeps the **newest** N rows — every caller that passes one is asking
   * "what has happened lately", and an oldest-first cut silently froze those answers at the first N events the
   * vault ever wrote. `order` only decides the row order of what comes back: `'asc'` (the default) oldest-first,
   * `'desc'` newest-first.
   */
  query(opts: { from?: string; to?: string; types?: EventType[]; job?: string; limit?: number; order?: 'asc' | 'desc' } = {}): CubicleEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.from) { where.push('ts >= ?'); params.push(opts.from); }
    if (opts.to) { where.push('ts <= ?'); params.push(opts.to); }
    if (opts.job) { where.push('job = ?'); params.push(opts.job); }
    if (opts.types?.length) { where.push(`type IN (${opts.types.map(() => '?').join(',')})`); params.push(...opts.types); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const sql = opts.limit
      ? `SELECT id, ts, type, agent, job, payload_json FROM events${clause} ORDER BY id DESC LIMIT ${Number(opts.limit)}`
      : `SELECT id, ts, type, agent, job, payload_json FROM events${clause} ORDER BY id ASC`;
    const rows = this.db.prepare(sql).all(...params) as { id: number; ts: string; type: string; agent: string | null; job: string | null; payload_json: string }[];
    // The SQL above returns newest-first when limited and oldest-first otherwise; flip to the requested order.
    const newestFirst = Boolean(opts.limit);
    if (newestFirst !== (opts.order === 'desc')) rows.reverse();
    return rows.map((r) => ({ id: r.id, ts: r.ts, type: r.type as EventType, agent: r.agent, job: r.job, payload: JSON.parse(r.payload_json) }));
  }

  last(type: EventType, filter?: (e: CubicleEvent) => boolean): CubicleEvent | undefined {
    if (!filter) {
      const r = this.db.prepare('SELECT id, ts, type, agent, job, payload_json FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(type) as { id: number; ts: string; type: string; agent: string | null; job: string | null; payload_json: string } | undefined;
      return r ? { id: r.id, ts: r.ts, type: r.type as EventType, agent: r.agent, job: r.job, payload: JSON.parse(r.payload_json) } : undefined;
    }
    const rows = this.query({ types: [type] });
    for (let i = rows.length - 1; i >= 0; i--) if (filter(rows[i])) return rows[i];
    return undefined;
  }

  count(type?: EventType, since?: string): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (type) { where.push('type = ?'); params.push(type); }
    if (since) { where.push('ts >= ?'); params.push(since); }
    const row = this.db.prepare(`SELECT COUNT(*) c FROM events${where.length ? ' WHERE ' + where.join(' AND ') : ''}`).get(...params) as { c: number };
    return row.c;
  }

  /** Rebuild the SQLite table from the JSONL mirror (cache reconstruction). */
  static rebuildFromJsonl(db: Db, jsonlDir: string): number {
    db.exec('DELETE FROM events');
    if (!existsSync(jsonlDir)) return 0;
    const insert = db.prepare('INSERT INTO events(ts, type, agent, job, payload_json) VALUES (?, ?, ?, ?, ?)');
    let n = 0;
    const files = readdirSync(jsonlDir).filter((f) => f.endsWith('.jsonl')).sort();
    const tx = db.transaction(() => {
      for (const f of files) {
        for (const line of readFileSync(path.join(jsonlDir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            insert.run(e.ts, e.type, e.agent ?? null, e.job ?? null, JSON.stringify(e.payload ?? {}));
            n++;
          } catch { /* skip corrupt line */ }
        }
      }
    });
    tx();
    return n;
  }
}
