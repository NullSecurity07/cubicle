import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from './db.js';
import { EventLog } from './events.js';
import { atomicWriteSync, listFilesRecursive, nowIso, sha256 } from './fs.js';
import { parseNote, stringifyNote, extractYamlBlock, type Note } from './frontmatter.js';
import { assertWritable, isCachePath, normalizeRel } from './guard.js';
import { Constitution, OwnerPreferences, type Constitution as ConstitutionT, type OwnerPreferences as OwnerPreferencesT } from './schemas.js';

export interface VaultOptions {
  /** Use an in-memory database (tests). */
  memory?: boolean;
}

/**
 * The Obsidian vault is the source of truth. This class is the only sanctioned write path for
 * daemon and agents: atomic writes, owner-owned path guard, written_sha bookkeeping, vault.wrote events.
 */
export class Vault {
  readonly root: string;
  readonly cubicleDir: string;
  readonly db: Db;
  readonly events: EventLog;

  private constructor(root: string, db: Db) {
    this.root = path.resolve(root);
    this.cubicleDir = path.join(this.root, '.cubicle');
    this.db = db;
    this.events = new EventLog(db, path.join(this.cubicleDir, 'events'));
  }

  static open(root: string, opts: VaultOptions = {}): Vault {
    const abs = path.resolve(root);
    if (!existsSync(abs)) throw new Error(`Vault path does not exist: ${abs}`);
    const cubicleDir = path.join(abs, '.cubicle');
    for (const d of ['events', 'screens', 'browser', 'logs', 'workspace']) mkdirSync(path.join(cubicleDir, d), { recursive: true });
    const db = opts.memory ? openDb(':memory:') : openDb(path.join(cubicleDir, 'cubicle.db'));
    return new Vault(abs, db);
  }

  static isVault(root: string): boolean {
    return existsSync(path.join(root, 'Memory', 'constitution.md')) && existsSync(path.join(root, 'Jobs'));
  }

  close(): void {
    this.db.close();
  }

  // ---------- paths ----------
  abs(rel: string): string {
    const p = path.resolve(this.root, normalizeRel(rel));
    if (!p.startsWith(this.root + path.sep) && p !== this.root) throw new Error(`Path escapes vault: ${rel}`);
    return p;
  }

  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }

  // ---------- reads ----------
  readText(rel: string): string {
    return readFileSync(this.abs(rel), 'utf8');
  }

  readTextOrNull(rel: string): string | null {
    const p = this.abs(rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  readNote<T = Record<string, unknown>>(rel: string): Note<T> {
    return parseNote<T>(this.readText(rel));
  }

  readNoteOrNull<T = Record<string, unknown>>(rel: string): Note<T> | null {
    const t = this.readTextOrNull(rel);
    return t === null ? null : parseNote<T>(t);
  }

  /** List files (relative paths) under a directory; non-recursive by default; cache paths excluded. */
  list(dirRel: string, opts: { recursive?: boolean; ext?: string } = {}): string[] {
    const abs = this.abs(dirRel);
    if (!existsSync(abs)) return [];
    let files: string[];
    if (opts.recursive) {
      // sync variant for simplicity
      files = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const a = path.join(d, e.name);
          const r = this.rel(a);
          if (isCachePath(r)) continue;
          if (e.isDirectory()) walk(a); else files.push(r);
        }
      };
      walk(abs);
    } else {
      files = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => this.rel(path.join(abs, e.name)));
    }
    if (opts.ext) files = files.filter((f) => f.endsWith(opts.ext!));
    return files.sort();
  }

  async listAll(): Promise<string[]> {
    return listFilesRecursive(this.root, { ignore: (r) => isCachePath(r) });
  }

  // ---------- writes ----------
  /**
   * Write a file atomically on behalf of `by` (a role id, or a privileged actor: daemon|owner|system|init).
   * Agents cannot write owner-owned paths (OwnerOwnedPathError). Records written_sha and emits vault.wrote.
   */
  writeText(rel: string, content: string, by: string, opts: { job?: string | null; silent?: boolean } = {}): string {
    const r = normalizeRel(rel);
    if (isCachePath(r)) throw new Error(`Refusing to write cache path through the vault API: ${r}`);
    assertWritable(r, by, this.constitution().never_modify);
    const sha = atomicWriteSync(this.abs(r), content);
    this.recordWritten(r, sha, by);
    if (!opts.silent) this.events.emit({ type: 'vault.wrote', agent: by, job: opts.job ?? null, payload: { path: r, sha, by } });
    return sha;
  }

  writeNote(rel: string, data: Record<string, unknown>, body: string, by: string, opts: { job?: string | null } = {}): string {
    return this.writeText(rel, stringifyNote(data, body), by, opts);
  }

  appendText(rel: string, text: string, by: string, opts: { job?: string | null } = {}): string {
    const existing = this.readTextOrNull(rel) ?? '';
    const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
    return this.writeText(rel, existing + sep + text, by, opts);
  }

  /** Read-modify-write a note in one step. */
  updateNote<T extends Record<string, unknown>>(rel: string, mutate: (note: Note<T>) => Note<T> | void, by: string, opts: { job?: string | null } = {}): Note<T> {
    const note = this.readNote<T>(rel);
    const next = mutate(note) ?? note;
    this.writeNote(rel, next.data as Record<string, unknown>, next.body, by, opts);
    return next;
  }

  // ---------- written_sha bookkeeping ----------
  recordWritten(rel: string, sha: string, by: string): void {
    this.db.prepare('INSERT OR REPLACE INTO written_sha(path, sha, ts, by) VALUES (?, ?, ?, ?)').run(normalizeRel(rel), sha, nowIso(), by);
  }

  writtenSha(rel: string): string | null {
    const row = this.db.prepare('SELECT sha FROM written_sha WHERE path = ?').get(normalizeRel(rel)) as { sha: string } | undefined;
    return row?.sha ?? null;
  }

  currentSha(rel: string): string | null {
    const p = this.abs(rel);
    if (!existsSync(p) || statSync(p).isDirectory()) return null;
    return sha256(readFileSync(p));
  }

  /** A file is owner-changed when its sha differs from the last recorded write, or it was never written by the system. */
  isOwnerChanged(rel: string): boolean {
    const cur = this.currentSha(rel);
    if (cur === null) return false;
    const rec = this.writtenSha(rel);
    return rec === null || rec !== cur;
  }

  /** Rescan a directory after out-of-band writes (e.g. shell.run) and record every changed file. */
  rescan(dirRel: string, by: string, opts: { job?: string | null } = {}): string[] {
    const changed: string[] = [];
    for (const rel of this.list(dirRel, { recursive: true })) {
      const cur = this.currentSha(rel);
      if (cur === null) continue;
      if (this.writtenSha(rel) !== cur) {
        this.recordWritten(rel, cur, by);
        this.events.emit({ type: 'vault.wrote', agent: by, job: opts.job ?? null, payload: { path: rel, sha: cur, by } });
        changed.push(rel);
      }
    }
    return changed;
  }

  /** Rebuild written_sha from the vault.wrote history (cache reconstruction). */
  rebuildWrittenSha(): number {
    this.db.exec('DELETE FROM written_sha');
    let n = 0;
    for (const e of this.events.query({ types: ['vault.wrote'] })) {
      const p = e.payload as { path?: string; sha?: string; by?: string };
      if (p.path && p.sha) { this.recordWritten(p.path, p.sha, p.by ?? 'unknown'); n++; }
    }
    return n;
  }

  // ---------- owner-owned config ----------
  private constitutionCache: { sha: string; value: ConstitutionT } | null = null;

  constitution(): ConstitutionT {
    const text = this.readTextOrNull('Memory/constitution.md');
    if (text === null) return Constitution.parse({});
    const sha = sha256(text);
    if (this.constitutionCache?.sha === sha) return this.constitutionCache.value;
    const block = extractYamlBlock(parseNote(text).body) ?? {};
    const parsed = Constitution.safeParse(block);
    const value = parsed.success ? parsed.data : Constitution.parse({});
    if (!parsed.success) this.events.emit({ type: 'daemon.warning', payload: { path: 'Memory/constitution.md', reason: 'invalid constitution yaml block; defaults in effect', issues: parsed.error.issues.map((i) => i.message) } });
    this.constitutionCache = { sha, value };
    return value;
  }

  ownerPreferences(): OwnerPreferencesT {
    const text = this.readTextOrNull('Memory/owner_preferences.md');
    if (text === null) return OwnerPreferences.parse({});
    const block = extractYamlBlock(parseNote(text).body) ?? {};
    const parsed = OwnerPreferences.safeParse(block);
    return parsed.success ? parsed.data : OwnerPreferences.parse({});
  }
}
