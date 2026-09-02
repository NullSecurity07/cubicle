import { sha256, type Vault } from '@cubicle/core';
import { cosine } from '@cubicle/router';

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export const MEMORY_DIRS = ['Memory', 'Skills', 'Decisions'];

/** Split markdown into ~`size`-char chunks on paragraph boundaries. */
export function chunkText(text: string, size = 900): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) { out.push(cur); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > size * 2) { out.push(cur.slice(0, size * 2)); cur = cur.slice(size * 2); }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Embedding index over Memory/, Skills/, Decisions/ stored in SQLite `memory_vectors` (cosine in JS).
 * Rebuildable from the vault at any time: `cubicle memory rebuild`.
 */
export class MemoryIndex {
  constructor(private vault: Vault, private embed: EmbedFn, private dirs: string[] = MEMORY_DIRS) {}

  private storedSha(rel: string): string | null {
    const row = this.vault.db.prepare('SELECT sha FROM memory_vectors WHERE path = ? LIMIT 1').get(rel) as { sha: string } | undefined;
    return row?.sha ?? null;
  }

  async indexFile(rel: string): Promise<boolean> {
    const text = this.vault.readTextOrNull(rel);
    if (text === null) { this.vault.db.prepare('DELETE FROM memory_vectors WHERE path = ?').run(rel); return false; }
    const sha = sha256(text);
    if (this.storedSha(rel) === sha) return false;
    const chunks = chunkText(text);
    if (chunks.length === 0) return false;
    const vectors = await this.embed(chunks);
    const del = this.vault.db.prepare('DELETE FROM memory_vectors WHERE path = ?');
    const ins = this.vault.db.prepare('INSERT INTO memory_vectors(path, chunk_idx, text, vector, sha) VALUES (?, ?, ?, ?, ?)');
    this.vault.db.transaction(() => {
      del.run(rel);
      chunks.forEach((c, i) => ins.run(rel, i, c, Buffer.from(new Float32Array(vectors[i]).buffer), sha));
    })();
    return true;
  }

  async indexAll(): Promise<number> {
    let n = 0;
    const seen = new Set<string>();
    for (const d of this.dirs) {
      for (const rel of this.vault.list(d, { recursive: true, ext: '.md' })) {
        seen.add(rel);
        if (await this.indexFile(rel)) n++;
      }
    }
    // drop vectors for deleted files
    const rows = this.vault.db.prepare('SELECT DISTINCT path FROM memory_vectors').all() as { path: string }[];
    for (const r of rows) if (!seen.has(r.path) && this.dirs.some((d) => r.path.startsWith(d + '/'))) this.vault.db.prepare('DELETE FROM memory_vectors WHERE path = ?').run(r.path);
    return n;
  }

  async rebuild(): Promise<number> {
    this.vault.db.exec('DELETE FROM memory_vectors');
    return this.indexAll();
  }

  async search(query: string, k = 5, dirs?: string[]): Promise<{ path: string; text: string; score: number }[]> {
    const [qv] = await this.embed([query]);
    const rows = this.vault.db.prepare('SELECT path, chunk_idx, text, vector FROM memory_vectors').all() as { path: string; chunk_idx: number; text: string; vector: Buffer }[];
    const q = new Float32Array(qv);
    const scored = rows
      .filter((r) => !dirs || dirs.some((d) => r.path.startsWith(d.replace(/\/$/, '') + '/')))
      .map((r) => ({ path: r.path, text: r.text, score: cosine(q, new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4)) }))
      .sort((a, b) => b.score - a.score);
    // one hit per path
    const out: typeof scored = [];
    const seen = new Set<string>();
    for (const s of scored) { if (seen.has(s.path)) continue; seen.add(s.path); out.push(s); if (out.length >= k) break; }
    return out;
  }

  count(): number {
    return (this.vault.db.prepare('SELECT COUNT(*) c FROM memory_vectors').get() as { c: number }).c;
  }
}

/** Deterministic hashing "embedding" for tests and offline fallback (bag of character trigrams). */
export function hashEmbed(dim = 256): EmbedFn {
  return async (texts) => texts.map((t) => {
    const v = new Array(dim).fill(0);
    const s = t.toLowerCase();
    for (let i = 0; i + 3 <= s.length; i++) {
      let h = 0;
      for (let j = i; j < i + 3; j++) h = (h * 31 + s.charCodeAt(j)) >>> 0;
      v[h % dim] += 1;
    }
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / n);
  });
}
