import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, realpathSync, unlinkSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openDb, type Db } from './db.js';
import { EventLog } from './events.js';
import { atomicWriteSync, listFilesRecursive, nowIso, sha256 } from './fs.js';
import { parseNote, stringifyNote, extractYamlBlock, extractOwnerComments, type Note } from './frontmatter.js';
import { assertWritable, isCachePath, normalizeRel } from './guard.js';
import { Constitution, OwnerPreferences, type Constitution as ConstitutionT, type OwnerPreferences as OwnerPreferencesT } from './schemas.js';

export const TOMBSTONE = 'deleted';

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
    const n = normalizeRel(rel); // throws UnsafePathError on `..`
    const p = path.resolve(this.root, n);
    if (!p.startsWith(this.root + path.sep) && p !== this.root) throw new Error(`Path escapes vault: ${rel}`);
    // Symlink escape: the nearest existing ancestor must resolve inside the vault.
    let probe = p;
    while (!existsSync(probe)) probe = path.dirname(probe);
    const real = realpathSync(probe);
    const rootReal = realpathSync(this.root);
    if (!(real === rootReal || real.startsWith(rootReal + path.sep))) throw new Error(`Path escapes vault via symlink: ${rel}`);
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
          if (e.isSymbolicLink()) continue; // never follow links (a sandbox could plant one)
          const a = path.join(d, e.name);
          const r = this.rel(a);
          if (isCachePath(r)) continue;
          if (e.isDirectory()) walk(a); else files.push(r);
        }
      };
      walk(abs);
    } else {
      files = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isFile() && !e.isSymbolicLink()).map((e) => this.rel(path.join(abs, e.name)));
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
  writeText(rel: string, content: string, by: string, opts: { job?: string | null; generated?: boolean } = {}): string {
    const r = normalizeRel(rel);
    if (isCachePath(r)) throw new Error(`Refusing to write cache path through the vault API: ${r}`);
    assertWritable(r, by, this.constitution().never_modify);
    const sha = atomicWriteSync(this.abs(r), content);
    this.recordWritten(r, sha, by, content);
    // Generated files (Jobs/queue.md, Metrics/*.md, …) still record an event (spec §4.2): the flag lets the
    // viewer ignore them as owner-visible churn, while a cache rebuild from events keeps their provenance.
    this.events.emit({ type: 'vault.wrote', agent: by, job: opts.job ?? null, payload: { path: r, sha, by, ...(opts.generated ? { generated: true } : {}) } });
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

  /** Read-modify-write a note in one step. Refuses to touch a note whose frontmatter is present but unparsable. */
  updateNote<T extends Record<string, unknown>>(rel: string, mutate: (note: Note<T>) => Note<T> | void, by: string, opts: { job?: string | null } = {}): Note<T> {
    const text = this.readText(rel);
    const note = parseNote<T>(text);
    const fmBlock = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.trim();
    if (fmBlock && fmBlock !== '{}' && Object.keys(note.data as object).length === 0) {
      this.events.emit({ type: 'daemon.warning', payload: { path: rel, reason: 'malformed frontmatter; refusing to rewrite' } });
      throw new Error(`malformed frontmatter in ${rel}; not rewriting`);
    }
    const next = mutate(note) ?? note;
    // Compare-and-write: if the file changed under us (an Obsidian save), re-read and re-apply once, then last-writer-wins with a warning.
    const before = sha256(text);
    if (this.currentSha(rel) !== before) {
      const fresh = parseNote<T>(this.readText(rel));
      const again = mutate(fresh) ?? fresh;
      this.events.emit({ type: 'daemon.warning', payload: { path: rel, reason: 'note changed during update; re-applied mutation on the fresh copy' } });
      this.writeNote(rel, again.data as Record<string, unknown>, again.body, by, opts);
      return again;
    }
    this.writeNote(rel, next.data as Record<string, unknown>, next.body, by, opts);
    return next;
  }

  /** Delete a file on behalf of the system; leaves a tombstone so the watcher does not report an owner deletion. */
  remove(rel: string, by: string, opts: { job?: string | null } = {}): void {
    const r = normalizeRel(rel);
    assertWritable(r, by, this.constitution().never_modify);
    const p = this.abs(r);
    if (existsSync(p)) unlinkSync(p);
    this.recordWritten(r, TOMBSTONE, by);
    this.events.emit({ type: 'vault.wrote', agent: by, job: opts.job ?? null, payload: { path: r, sha: TOMBSTONE, by, deleted: true } });
  }

  /** Move a file on behalf of the system (archive), recording both ends. */
  move(fromRel: string, toRel: string, by: string, opts: { job?: string | null } = {}): void {
    const from = normalizeRel(fromRel); const to = normalizeRel(toRel);
    assertWritable(from, by, this.constitution().never_modify);
    assertWritable(to, by, this.constitution().never_modify);
    const content = readFileSync(this.abs(from));
    mkdirSync(path.dirname(this.abs(to)), { recursive: true });
    renameSync(this.abs(from), this.abs(to));
    const sha = sha256(content);
    this.recordWritten(from, TOMBSTONE, by);
    this.recordWritten(to, sha, by);
    this.events.emit({ type: 'vault.wrote', agent: by, job: opts.job ?? null, payload: { path: to, sha, by, moved_from: from } });
    this.events.emit({ type: 'vault.wrote', agent: by, job: opts.job ?? null, payload: { path: from, sha: TOMBSTONE, by, deleted: true } });
  }

  // ---------- written_sha bookkeeping ----------
  recordWritten(rel: string, sha: string, by: string, content?: string): void {
    const comments = content !== undefined ? JSON.stringify(extractOwnerComments(content)) : null;
    this.db.prepare('INSERT OR REPLACE INTO written_sha(path, sha, ts, by, comments_json) VALUES (?, ?, ?, ?, ?)').run(normalizeRel(rel), sha, nowIso(), by, comments);
  }

  /** %%cubicle: …%% comments that were present the last time the system wrote this file (null when unknown). */
  writtenComments(rel: string): string[] | null {
    const row = this.db.prepare('SELECT comments_json FROM written_sha WHERE path = ?').get(normalizeRel(rel)) as { comments_json: string | null } | undefined;
    if (!row || row.comments_json === null) return null;
    try { return JSON.parse(row.comments_json) as string[]; } catch { return null; }
  }

  /**
   * Owner comments added since the system last wrote each note — the startup sweep for `%%cubicle: …%%`
   * feedback typed while the daemon was stopped (the watcher starts with `ignoreInitial`, so those edits
   * raise no `owner.edited`).
   *
   * The baseline is `written_sha.comments_json`; where that is missing, the committed (git HEAD) version
   * of the file is used instead, the same fallback `collectOwnerFeedback` applies on the `owner.edited`
   * path, so the two agree on which comments are new. The fallback is also what keeps this sweep working
   * after `rebuildWrittenSha()`: that replays `vault.wrote` events, which carry no content, so
   * `comments_json` is NULL for every path afterwards and the recorded baseline is gone.
   *
   * A file with neither baseline (never written by the system, never committed) is skipped: nothing can
   * prove the owner, rather than a model or a scrape, wrote its comments.
   */
  commentsChangedSinceWritten(): { path: string; added: string[] }[] {
    const out: { path: string; added: string[] }[] = [];
    const tracked = existsSync(path.join(this.root, '.git'));
    for (const rel of this.list('', { recursive: true, ext: '.md' })) {
      const text = this.readTextOrNull(rel);
      if (text === null) continue;
      const current = extractOwnerComments(text);
      if (!current.length) continue; // nothing to report, so do not pay for a baseline lookup
      const prior = this.writtenComments(rel) ?? (tracked ? this.committedComments(rel) : null);
      if (prior === null) continue;
      const known = new Set(prior);
      const added = current.filter((c) => !known.has(c));
      if (added.length) out.push({ path: rel, added });
    }
    return out;
  }

  /** `%%cubicle: …%%` comments in the committed (git HEAD) version of a path; null when git has no such file. */
  private committedComments(rel: string): string[] | null {
    try {
      const text = execFileSync('git', ['show', `HEAD:${normalizeRel(rel)}`], { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
      return extractOwnerComments(text);
    } catch { return null; }
  }

  /**
   * Replace the recorded owner-comment baseline for a path (`null` = unknown). A write that only touches
   * machine-owned frontmatter must call this with the baseline it captured beforehand, or the owner's
   * `%%cubicle: …%%` comments in the file become "system-written" and are never delivered as feedback.
   */
  setWrittenComments(rel: string, comments: string[] | null): void {
    this.db.prepare('UPDATE written_sha SET comments_json = ? WHERE path = ?').run(comments === null ? null : JSON.stringify(comments), normalizeRel(rel));
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
    return rec === null || rec === TOMBSTONE || rec !== cur;
  }

  /** Rescan a directory after out-of-band writes (e.g. shell.run) and record every changed file. */
  rescan(dirRel: string, by: string, opts: { job?: string | null; skip?: Set<string> } = {}): string[] {
    const changed: string[] = [];
    for (const rel of this.list(dirRel, { recursive: true })) {
      if (opts.skip?.has(rel)) continue; // owner-edited files keep their owner provenance
      const cur = this.currentSha(rel);
      if (cur === null) continue;
      if (this.writtenSha(rel) !== cur) {
        this.recordWritten(rel, cur, by, /\.(md|txt|html|astro)$/i.test(rel) ? this.readTextOrNull(rel) ?? undefined : undefined);
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
