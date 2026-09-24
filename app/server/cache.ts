import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelClient } from './providers.ts';
import type { ModelMessage } from './prompt.ts';

// What was asked before and answered the same way need not be asked again. Two kinds, both on disk under the
// workspace's own `cache/` folder, both counted: a side call (a summary, a reflection, a compaction note: never a turn,
// never a call that offers tools) is kept six hours by its exact prompt and model; a web read is kept fifteen minutes
// by what was read, and says when it was read, so a figure quoted from it keeps its age.
export const SIDE_TTL = 6 * 3600_000;
export const WEB_TTL = 15 * 60_000;
const SWEEP_EVERY = 3600_000;

export type CacheKind = 'side' | 'web';
export type CacheEvent = { folder: string; kind: CacheKind; hit: boolean; tokens?: number };

// Whoever keeps count (the usage book) listens here, for its own workspace.
const listeners = new Set<(event: CacheEvent) => void>();
export function onCache(listener: (event: CacheEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const tell = (event: CacheEvent) => { for (const listener of listeners) { try { listener(event); } catch { /* a counter never costs a read */ } } };

// A reply that came out of the cache carries this usage object, so the book does not count it as a request.
export const fromCache = new WeakSet<object>();

export const hashOf = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex');
// The same prompt written with other line endings or runs of spaces is the same prompt.
const tidy = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
export const normalised = (messages: ModelMessage[]) => JSON.stringify(messages.map((message) => [
  message.role, tidy(message.content),
  ...('tool_calls' in message && message.tool_calls?.length ? [message.tool_calls.map((call) => [call.function.name, call.function.arguments])] : []),
  ...('images' in message && message.images?.length ? [message.images.map((image) => image.url.length > 200 ? hashOf(image.url) : image.url)] : []),
]));

type Kept<T> = { at: number; value: T };

// When each folder was last swept. Kept here rather than in each cache, because a cache is made afresh for every side
// call and every web read: held per cache, every single write swept the whole folder.
const swept = new Map<string, number>();

// One folder of json files, one per key. What is out of date is ignored when read, and swept away once an hour.
export function diskCache<T>(dir: string, ttl: number, now: () => number = Date.now) {
  const file = (key: string) => join(dir, `${key}.json`);
  async function sweep() {
    swept.set(dir, now());
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (info && now() - info.mtimeMs > ttl) await rm(join(dir, name), { force: true }).catch(() => {});
    }
  }
  return {
    async get(key: string): Promise<Kept<T> | undefined> {
      try {
        const kept = JSON.parse(await readFile(file(key), 'utf8')) as Kept<T>;
        return now() - kept.at < ttl && now() >= kept.at ? kept : undefined;
      } catch { return undefined; }
    },
    async put(key: string, value: T) {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(`${file(key)}.tmp`, JSON.stringify({ at: now(), value }));
        await rename(`${file(key)}.tmp`, file(key));
        if (now() - (swept.get(dir) ?? 0) > SWEEP_EVERY) await sweep();
      } catch { /* a cache that cannot be written is only a cache that misses */ }
    },
  };
}

// ---------------------------------------------------------------- side calls

type Book = { folder: string | null; admit(name: string): boolean; failed(name: string, error: unknown): unknown };
type Answer = { text: string; tokens: number };

// A client for one side call: it asks the breaker before it goes out, reports what went wrong to the book, and, with
// no tools on offer, answers from the cache when the very same prompt went to the very same model in the last six
// hours. A reply that was cut short or called a tool is never kept.
export function sideClient(client: ModelClient, book: Book, now: () => number = Date.now): ModelClient {
  const folder = book.folder;
  const disk = folder ? diskCache<Answer>(join(folder, 'cache', 'side'), SIDE_TTL, now) : null;
  return {
    ...client,
    async step(messages, options) {
      if (!book.admit(client.name)) throw new Error(`${client.name} is resting after failing several times in a row`);
      const key = disk && !options.tools?.length ? hashOf(client.model, normalised(messages)) : '';
      if (disk && key) {
        const kept = await disk.get(key);
        if (kept?.value.text.trim()) {
          options.onToken(kept.value.text);
          const usage = { input: 0, output: 0 };
          fromCache.add(usage);
          tell({ folder: folder!, kind: 'side', hit: true, tokens: kept.value.tokens });
          return { text: '', calls: [], usage };
        }
      }
      let said = '';
      try {
        const turn = await client.step(messages, { ...options, onToken: (token) => { said += token; options.onToken(token); } });
        if (disk && key) {
          tell({ folder: folder!, kind: 'side', hit: false });
          const text = turn.text || said;
          if (text.trim() && !turn.calls.length && !turn.cut) await disk.put(key, { text, tokens: (turn.usage?.input ?? 0) + (turn.usage?.output ?? 0) });
        }
        return turn;
      } catch (error) {
        book.failed(client.name, error);
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------- web reads

const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
export const readAt = (at: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return `(Read ${stamp(at)} UTC, ${minutes ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : 'just now'}, and kept: the same read within ${WEB_TTL / 60_000} minutes comes from here.)`;
};

// A read that failed is not worth keeping: it should be tried again, not remembered.
export const worthKeeping = (text: string) => text.trim().length >= 200 && !/could not be read|did not load|came back almost empty|refused this request|could not be fetched|^## [^\n]*\nFailed: |asked for a human check|nothing could be read|nothing was found/i.test(text.slice(0, 600));

export function webCache(folder: string | null | undefined, now: () => number = Date.now) {
  const disk = folder ? diskCache<string>(join(folder, 'cache', 'web'), WEB_TTL, now) : null;
  const key = (parts: unknown[]) => hashOf(JSON.stringify(parts));
  return {
    on: !!disk,
    // One read, whole. A hit says when it was read, on its first line.
    async one(parts: unknown[], read: () => Promise<string>, keep: (text: string) => boolean = worthKeeping): Promise<string> {
      if (!disk) return read();
      const id = key(parts);
      const kept = await disk.get(id);
      if (kept) { tell({ folder: folder!, kind: 'web', hit: true }); return `${readAt(kept.at, now())}\n${kept.value}`; }
      tell({ folder: folder!, kind: 'web', hit: false });
      const text = await read();
      if (keep(text)) await disk.put(id, text);
      return text;
    },
    // Several reads in one call (pages, queries), kept one by one. `read` gets only the ones not kept and gives back
    // one block each, in order, or null when its answer cannot be split back into them; then that answer is used as
    // it came, after the kept ones.
    async many(items: string[], parts: (item: string) => unknown[], read: (missing: string[]) => Promise<{ blocks: string[] | null; raw: string }>, keep: (text: string) => boolean = worthKeeping): Promise<string[]> {
      if (!disk) { const got = await read(items); return got.blocks ?? [got.raw]; }
      const kept = await Promise.all(items.map((item) => disk.get(key(parts(item)))));
      for (const one of kept) tell({ folder: folder!, kind: 'web', hit: !!one });
      const missing = items.filter((_, at) => !kept[at]);
      const got = missing.length ? await read(missing) : { blocks: [], raw: '' };
      if (!got.blocks || got.blocks.length !== missing.length) {
        return [...kept.flatMap((one) => (one ? [`${readAt(one.at, now())}\n${one.value}`] : [])), ...(got.raw ? [got.raw] : [])];
      }
      const fresh = new Map(missing.map((item, at) => [item, got.blocks![at]]));
      for (const [item, block] of fresh) if (keep(block)) await disk.put(key(parts(item)), block);
      return items.map((item, at) => (kept[at] ? `${readAt(kept[at]!.at, now())}\n${kept[at]!.value}` : fresh.get(item)!));
    },
  };
}
