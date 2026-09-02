import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import path from 'node:path';

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Atomic write: temp file in the same directory → fsync → rename. Synchronous by design (checkpoint safety). */
export function atomicWriteSync(filePath: string, content: string | Buffer): string {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, content);
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, filePath);
  return sha256(content);
}

export async function atomicWrite(filePath: string, content: string | Buffer): Promise<string> {
  return atomicWriteSync(filePath, content);
}

export function readTextIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8');
}

export async function listFilesRecursive(root: string, opts: { ignore?: (rel: string) => boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (opts.ignore?.(rel)) continue;
      if (e.isDirectory()) await walk(abs);
      else out.push(rel);
    }
  }
  if (existsSync(root)) await walk(root);
  return out.sort();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Compact id: prefix_YYYYMMDD_xxxxxx (24 random bits; callers still check for collisions). */
export function makeId(prefix: string): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${prefix}_${ymd}_${randomBytes(3).toString('hex')}`;
}

/** Deterministic id derived from an idempotency key, so a replayed step recreates the same note instead of a duplicate. */
export function idFromKey(prefix: string, key: string): string {
  const body = key.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return body.startsWith(`${prefix}_`) ? body : `${prefix}_${body}`; // no "job_job_…" when the key is itself a job id
}

/** Timestamp for note filenames: YYYY-MM-DD-HHmm */
export function stampForFilename(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
