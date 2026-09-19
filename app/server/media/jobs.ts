import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Card, Media, MediaEvent, MediaKind, MediaResult } from '../../shared/model.ts';
import type { Store } from '../store.ts';

export type MediaJobs = ReturnType<typeof createMedia>;
// What the founder or a person asked for. `prompt` is the words of it; the rest is whatever that kind of studio offers.
export type Ask = { prompt: string } & Record<string, unknown>;
// What a backend made: the bytes and the file ending they belong in, and for a video the still that stands in for it.
export type Piece = { ext: string; bytes: Buffer; poster?: { ext: string; bytes: Buffer } };
// One backend that makes one kind of media. `ready` says in the founder's words why it cannot work yet, or nothing.
export type Maker = { name: string; ready(): string | null; make(ask: Ask, help: { report: (line: string) => void; signal?: AbortSignal }): Promise<Piece> };
export type Makers = Partial<Record<MediaKind, Maker[]>>;

const KEEP = 12;
const EMPTY: Media = { state: 'idle', log: [], results: [] };
const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
// A name the founder can read back in a file browser: when it was made, and the first words of what was asked for.
const nameOf = (ask: Ask, at: number, ext: string) =>
  `media/${at.toString(36)}-${ask.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'made'}.${ext}`;

// What each studio card has made lives beside the stage, one file per card, and the files themselves go to the shared
// files folder. The server owns all of it: the card only asks. Written as it goes, through the same queue and
// tmp-rename as the boards, so a card read back mid-job tells the truth and a crash never leaves half a file.
export function createMedia(deps: { dir: string; store: Store; makers: Makers; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const path = (cardId: string) => join(deps.dir, 'media', `${safe(cardId)}.json`);
  const cache = new Map<string, Media>();
  const running = new Map<string, AbortController>();
  const watchers = new Set<(event: MediaEvent) => void>();
  let queue: Promise<unknown> = Promise.resolve();

  async function read(cardId: string): Promise<Media> {
    const known = cache.get(cardId);
    if (known) return known;
    let media = EMPTY;
    try { media = { ...EMPTY, ...JSON.parse(await readFile(path(cardId), 'utf8')) }; } catch { /* nothing made yet */ }
    // A job cut short by the app closing cannot still be making something.
    if (media.state === 'making') media = { ...media, state: 'failed', problem: 'the app was closed', log: [...media.log, 'failed: the app was closed'] };
    cache.set(cardId, media);
    return media;
  }
  function write(cardId: string, media: Media) {
    cache.set(cardId, media);
    const text = JSON.stringify(media, null, 2);
    queue = queue.then(async () => {
      await mkdir(join(deps.dir, 'media'), { recursive: true });
      await writeFile(`${path(cardId)}.tmp`, text);
      await rename(`${path(cardId)}.tmp`, path(cardId));
    }).catch(() => {});
  }
  // A whole change (a job started, finished or failed) is a nudge to read the card again; a line travels on its own.
  function save(cardId: string, media: Media) {
    write(cardId, media);
    for (const tell of watchers) tell({ id: cardId, changed: true });
  }

  return {
    read,
    settled: () => queue,
    // Why nothing can make this kind yet, in words the founder can act on; nothing when a backend is ready.
    ready(kind: MediaKind): string | null {
      const hints = (deps.makers[kind] ?? []).map((maker) => maker.ready());
      if (!hints.length) return 'Nothing is set up to make this yet.';
      return hints.some((hint) => hint === null) ? null : hints.find(Boolean) ?? null;
    },
    stop(cardId: string) { running.get(cardId)?.abort(); },
    watch(tell: (event: MediaEvent) => void) { watchers.add(tell); return () => { watchers.delete(tell); }; },
    // One job per card. Backends are tried in order, the way models are, and the card keeps every line either way.
    async make(card: Card, ask: Ask, help: { report?: (line: string) => void; signal?: AbortSignal } = {}): Promise<MediaResult> {
      const makers = deps.makers[card.kind as MediaKind] ?? [];
      if (!makers.length) throw new Error('nothing is set up to make this yet');
      if (running.has(card.id)) throw new Error('this card is already making something');
      const stop = new AbortController();
      help.signal?.addEventListener('abort', () => stop.abort(), { once: true });
      running.set(card.id, stop);
      const before = await read(card.id);
      const log: string[] = [];
      const line = (text: string) => {
        log.push(text);
        write(card.id, { ...before, state: 'making', problem: undefined, log: [...log] });
        for (const tell of watchers) tell({ id: card.id, line: text });
        help.report?.(text);
      };
      try {
        const failures: string[] = [];
        for (const maker of makers) {
          const hint = maker.ready();
          if (hint) { failures.push(`${maker.name}: ${hint}`); continue; }
          try {
            const piece = await maker.make(ask, { report: line, signal: stop.signal });
            const at = now();
            const made: MediaResult = { path: await deps.store.saveFileBytes(nameOf(ask, at, piece.ext), piece.bytes), prompt: ask.prompt, at };
            if (piece.poster) made.poster = await deps.store.saveFileBytes(nameOf(ask, at + 1, piece.poster.ext), piece.poster.bytes);
            save(card.id, { state: 'idle', log: [...log, `done · ${maker.name}`], results: [made, ...before.results].slice(0, KEEP) });
            return made;
          } catch (error) {
            if (stop.signal.aborted) throw new Error('stopped');
            failures.push(`${maker.name}: ${(error as Error).message}`);
          }
        }
        throw new Error(failures.join('; '));
      } catch (error) {
        const problem = (error as Error).message;
        save(card.id, { ...before, state: 'failed', problem, log: [...log, `failed: ${problem}`] });
        throw error;
      } finally {
        running.delete(card.id);
      }
    },
  };
}
