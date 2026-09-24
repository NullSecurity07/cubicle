import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hit, Stage } from '../shared/model.ts';
import { readableDocIds, wiredCards } from './prompt.ts';
import { writeAtomic } from './fsx.ts';

// One source of text as it is handed in: a whole doc, a room's conversation, a memory, a decision, a file, a page.
export type Piece = Omit<Hit, 'score'>;
type Embedder = (texts: string[]) => Promise<number[][]>;
type Passage = Piece & { hash: string; vector?: number[] };
const CHUNK = 700;
const TOP = 6;

// Long text becomes passages that end where a paragraph ends; one overlong paragraph is cut at sentence or word ends.
export function chunksOf(text: string, limit = CHUNK): string[] {
  const parts: string[] = [];
  let held = '';
  const push = () => { if (held.trim()) parts.push(held.trim()); held = ''; };
  for (const paragraph of text.split(/\n{2,}/).map((one) => one.trim()).filter(Boolean)) {
    if (paragraph.length > limit) {
      push();
      let rest = paragraph;
      while (rest.length > limit) {
        const window = rest.slice(0, limit);
        const cut = Math.max(window.lastIndexOf('. ') + 1, window.lastIndexOf('\n'), window.lastIndexOf(' '));
        parts.push(rest.slice(0, cut > limit / 3 ? cut : limit).trim());
        rest = rest.slice(cut > limit / 3 ? cut : limit).trim();
      }
      held = rest;
    } else if (held.length + paragraph.length + 2 > limit) { push(); held = paragraph; } else held = held ? `${held}\n\n${paragraph}` : paragraph;
  }
  push();
  return parts;
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
const dot = (a: number[], b: number[]) => { let sum = 0; for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]; return sum; };
// Share of the question's words that the passage holds: what keeps a name or an id findable whatever the model thinks.
function wordScore(question: string[], passage: string): number {
  if (!question.length) return 0;
  const held = new Set(words(passage));
  return question.filter((word) => held.has(word)).length / question.length;
}

// A stand-in embedder for tests and the fake-model mode: words hashed into a small vector. No model, no download.
export const wordEmbedder: Embedder = async (texts) => texts.map((text) => {
  const vector = new Array<number>(256).fill(0);
  for (const word of words(text)) vector[createHash('md5').update(word.replace(/(ing|ed|es|s)$/, '')).digest().readUInt16BE(0) % 256] += 1;
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
});

// The real one: a small sentence model run inside the server. It loads on first use and stays; the model file
// (about 23 MB) is fetched once into `cacheDir` and used offline from then on.
export function localEmbedder(cacheDir: string, model = process.env.STAGE_RECALL_MODEL ?? 'Xenova/all-MiniLM-L6-v2'): Embedder {
  let ready: Promise<(texts: string[]) => Promise<number[][]>> | null = null;
  return async (texts) => {
    ready ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      const run = await pipeline('feature-extraction', model, { dtype: 'q8' });
      return async (batch: string[]) => (await run(batch, { pooling: 'mean', normalize: true })).tolist() as number[][];
    })().catch((error) => { ready = null; throw error; });
    const embed = await ready;
    const vectors: number[][] = [];
    for (let at = 0; at < texts.length; at += 32) vectors.push(...await embed(texts.slice(at, at + 32)));
    return vectors;
  };
}

// What one person may recall: their own room (talk and memory), the docs they can read (wired or pinned), the link
// cards wired to them, the shared files and the founder's decisions. The same rule that decides what they can touch.
export function mayRecall(stage: Stage, roomId: string): (piece: Piece) => boolean {
  const docs = new Set(readableDocIds(stage, roomId));
  const cards = new Set(wiredCards(stage, roomId).map((card) => card.id));
  return (piece) => (piece.kind === 'doc' ? docs.has(piece.id) : piece.kind === 'link' ? cards.has(piece.id)
    : piece.kind === 'chat' || piece.kind === 'memory' ? piece.roomId === roomId : true);
}

// Finds passages by meaning across everything the workspace holds. The workspace files stay the truth: `gather` reads
// them fresh, only passages whose text changed are embedded again, and the saved vectors can be deleted at any time.
// `gather` may be handed the kinds wanted and read only those; one that reads everything anyway is filtered here.
export function createRecall(deps: { dir: string; embed: Embedder; gather: (kinds?: ReadonlySet<Piece['kind']>) => Promise<Piece[]> }) {
  const path = join(deps.dir, '.index', 'recall.json');
  let known: Map<string, number[]> | null = null;
  let mode: 'meaning' | 'words' = 'meaning';
  let queue: Promise<unknown> = Promise.resolve();

  async function load() {
    if (known) return known;
    known = new Map();
    try { for (const [hash, packed] of Object.entries(JSON.parse(await readFile(path, 'utf8')).vectors as Record<string, string>)) known.set(hash, [...new Float32Array(new Uint8Array(Buffer.from(packed, 'base64')).buffer)]); } catch { /* no index yet */ }
    return known;
  }
  async function passages(kinds?: ReadonlySet<Piece['kind']>): Promise<Passage[]> {
    const vectors = await load();
    // The hash is what was embedded and nothing else: the kind, the title and the words. When a piece was written is
    // not in it, so an index saved before passages carried a date still matches every one of them and nothing is
    // embedded again for the sake of a new field.
    const all: Passage[] = (await deps.gather(kinds)).filter((piece) => !kinds || kinds.has(piece.kind)).flatMap((piece) => chunksOf(piece.text).map((text) => ({ ...piece, text, hash: createHash('sha1').update(`${piece.kind}\n${piece.title}\n${text}`).digest('hex') })));
    const fresh = all.filter((passage) => !vectors.has(passage.hash));
    if (fresh.length) {
      try {
        const made = await deps.embed(fresh.map((passage) => `${passage.title}\n${passage.text}`));
        fresh.forEach((passage, index) => vectors.set(passage.hash, made[index]));
        mode = 'meaning';
        // Keep only what is still in the workspace, so the file does not grow with every edit. A search over some
        // kinds only has not seen the rest, so it cannot tell what is gone and throws nothing away.
        if (!kinds) {
          const live = new Set(all.map((passage) => passage.hash));
          for (const hash of [...vectors.keys()]) if (!live.has(hash)) vectors.delete(hash);
        }
        const packed = Object.fromEntries([...vectors].map(([hash, vector]) => [hash, Buffer.from(new Float32Array(vector).buffer).toString('base64')]));
        queue = queue.then(async () => { await writeAtomic(path, JSON.stringify({ vectors: packed }), { mkdir: true }); }).catch(() => {});
      } catch { mode = 'words'; }
    }
    return all.map((passage) => ({ ...passage, vector: vectors.get(passage.hash) }));
  }

  return {
    mode: () => mode,
    settled: () => queue,
    // Brings the saved vectors up to date without searching: run after start so the first real search is quick.
    warm: async () => { await passages(); },
    // `kinds` searches only those, and reads only those from the workspace.
    async search(query: string, options: { allow?: (piece: Piece) => boolean; top?: number; kinds?: Piece['kind'][] } = {}): Promise<Hit[]> {
      const asked = query.trim();
      if (!asked) return [];
      const pool = (await passages(options.kinds ? new Set(options.kinds) : undefined)).filter((passage) => !options.allow || options.allow(passage));
      const question = [...new Set(words(asked))];
      let vector: number[] | undefined;
      if (mode === 'meaning' && pool.some((passage) => passage.vector)) { try { [vector] = await deps.embed([asked]); } catch { mode = 'words'; } }
      const scored = pool.map((passage) => {
        const byWords = wordScore(question, `${passage.title} ${passage.text}`);
        const byMeaning = vector && passage.vector ? Math.max(0, dot(vector, passage.vector)) : 0;
        return { passage, score: vector ? 0.7 * byMeaning + 0.3 * byWords : byWords };
      }).filter((one) => one.score > (vector ? 0.12 : 0)).sort((a, b) => b.score - a.score);
      // Two passages of one source rarely add much: keep the best of each until the list is full.
      const hits: Hit[] = [];
      const per = new Map<string, number>();
      for (const { passage: { hash: _hash, vector: _vector, ...piece }, score } of scored) {
        const key = `${piece.kind}:${piece.id}`;
        if ((per.get(key) ?? 0) >= 2) continue;
        per.set(key, (per.get(key) ?? 0) + 1);
        hits.push({ ...piece, score: Math.round(score * 1000) / 1000 });
        if (hits.length >= (options.top ?? TOP)) break;
      }
      return hits;
    },
  };
}
