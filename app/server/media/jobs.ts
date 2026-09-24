import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Card, Media, MediaAsset, MediaCredit, MediaEvent, MediaKind, MediaResult } from '../../shared/model.ts';
import type { Store } from '../store.ts';
import type { Voice } from './voice.ts';
import { mltOf, type EditPlan } from './mlt.ts';

export type MediaJobs = ReturnType<typeof createMedia>;
// What the founder or a person asked for. `prompt` is the words of it; the rest is whatever that kind of studio offers.
export type Ask = { prompt: string } & Record<string, unknown>;
// What a backend made: the bytes and the file ending they belong in, for a video the still that stands in for it, and
// for a recording the pieces it was said in — which is the only honest way to know when each word is spoken.
// `by` is which backend really made it, for the card to say so: a founder who waited a minute for a picture is
// owed the knowledge that it was drawn here rather than fetched.
// `noncommercial` marks a file whose own licence forbids selling it, and `credits` is the text that travels beside it
// as `<file>.credits.txt`, so the terms are never only on the card.
export type Piece = {
  ext: string; bytes: Buffer; poster?: { ext: string; bytes: Buffer }; parts?: { text: string; seconds: number }[]; credit?: MediaCredit; by?: string;
  noncommercial?: boolean; credits?: string;
  // A finished film laid out as tracks, with the pictures and sound it needs. It is written beside the film as
  // `<film>.mlt`, with those files in `<film>.parts/`, so Shotcut or Kdenlive can open it.
  edit?: EditPlan;
};
// One backend that makes one kind of media. `ready` says in the founder's words why it cannot work yet, or nothing.
// `cast` is the voice makers' own answer to "who can say this?": the table the loaded weights ship with, so a film
// picking a narrator reads gender, accent and grade off the model rather than off a list somebody typed.
// `engine` names a backend the founder can ask for by name; an `optIn` one is only ever tried when it is asked for,
// so a card that says nothing gets the default. `ready` hears the ask when there is one, because asking for an
// engine by name is how a card switches it on. `others` are the engines a caller holding only this backend may name.
export type Maker = {
  name: string; ready(ask?: Ask): string | null;
  engine?: string; optIn?: boolean; others?: Maker[];
  make(ask: Ask, help: { report: (line: string) => void; signal?: AbortSignal }): Promise<Piece>;
  cast?(): Promise<Voice[]>;
  // Several backends as one may say which of them the next ask would really go to, so a film can tell the founder
  // whether its pictures are four seconds each or most of a minute before anybody starts waiting.
  next?(): string | null;
};
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

  // The hand-editable film: its parts in a folder named after it, and the `.mlt` beside it naming them by relative
  // path, so the film, its parts and the project move together as one folder.
  async function saveEdit(film: string, edit: EditPlan): Promise<string> {
    const base = film.replace(/\.[^./]+$/, '');
    const own = (name: string) => name.split('/').pop() ?? name;
    for (const file of edit.files) await deps.store.saveFileBytes(`${base}.parts/${own(file.name)}`, file.bytes);
    const text = mltOf({ ...edit.film, film: own(film), parts: `${own(base)}.parts` });
    return deps.store.saveFileBytes(`${base}.mlt`, Buffer.from(text));
  }

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

  // A name a storyboard can say out loud: the file's own name without its ending, kept unique on the card.
  const assetName = (file: string, taken: MediaAsset[]) => {
    const stem = (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9 _-]+/g, '-').replace(/^[-\s]+|[-\s]+$/g, '').slice(0, 40) || 'clip';
    if (!taken.some((one) => one.name === stem)) return stem;
    for (let next = 2; next < 99; next += 1) if (!taken.some((one) => one.name === `${stem}-${next}`)) return `${stem}-${next}`;
    return `${stem}-${Date.now().toString(36)}`;
  };

  const referenceOf = async (name: string, media: Media): Promise<{ ref: string; refText?: string }> => {
    const asset = (media.assets ?? []).find((one) => one.name === name || one.path === name);
    const result = media.results.find((one) => one.path === name || one.path === asset?.path);
    const path = asset?.path ?? result?.path;
    if (!path) throw new Error(`there is no recording called ${name} on this card to clone; drop the file on the card first`);
    if (asset && asset.kind !== 'audio') throw new Error(`${name} is not a recording, so there is no voice in it to clone`);
    return { ref: deps.store.pathOf(path), ...(result ? { refText: result.prompt } : {}) };
  };

  return {
    read,
    settled: () => queue,
    // What the founder dropped on a card. The file is already in the shared files; this is the card remembering it.
    async addAsset(cardId: string, asset: Omit<MediaAsset, 'name' | 'at'> & { file: string }): Promise<MediaAsset> {
      const media = await read(cardId);
      const assets = media.assets ?? [];
      const { file, ...rest } = asset;
      const made: MediaAsset = { ...rest, name: assetName(file, assets), at: now() };
      save(cardId, { ...media, assets: [...assets, made].slice(-24) });
      return made;
    },
    async removeAsset(cardId: string, name: string) {
      const media = await read(cardId);
      save(cardId, { ...media, assets: (media.assets ?? []).filter((one) => one.name !== name) });
    },
    assetsOf: async (cardId: string): Promise<MediaAsset[]> => (await read(cardId)).assets ?? [],
    // Why nothing can make this kind yet, in words the founder can act on; nothing when a backend is ready.
    ready(kind: MediaKind): string | null {
      const hints = (deps.makers[kind] ?? []).filter((maker) => !maker.optIn).map((maker) => maker.ready());
      if (!hints.length) return 'Nothing is set up to make this yet.';
      return hints.some((hint) => hint === null) ? null : hints.find(Boolean) ?? null;
    },
    stop(cardId: string) { running.get(cardId)?.abort(); },
    watch(tell: (event: MediaEvent) => void) { watchers.add(tell); return () => { watchers.delete(tell); }; },
    // One job per card. Backends are tried in order, the way models are, and the card keeps every line either way.
    async make(card: Card, ask: Ask, help: { report?: (line: string) => void; signal?: AbortSignal } = {}): Promise<MediaResult> {
      const all = deps.makers[card.kind as MediaKind] ?? [];
      // An engine asked for by name is the only one tried: a founder who chose a voice for its licence or its
      // clone must not be handed another one quietly. Otherwise the opt-in engines sit out.
      const named = typeof ask.engine === 'string' && all.some((maker) => maker.engine === ask.engine) ? ask.engine : null;
      const makers = named ? all.filter((maker) => maker.engine === named) : all.filter((maker) => !maker.optIn);
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
        // A voice to clone is named by the card: a file dropped on it, or one of its own recordings, whose words are
        // then known. The backend is handed where it really is on disk.
        if (typeof ask.clone === 'string' && ask.clone.trim()) ask = { ...ask, ...(await referenceOf(ask.clone.trim(), before)) };
        const failures: string[] = [];
        for (const maker of makers) {
          const hint = maker.ready(ask);
          if (hint) { failures.push(`${maker.name}: ${hint}`); continue; }
          try {
            // Which card asked is part of the asking: a video studio reads what is wired to it and what is dropped on it.
            const piece = await maker.make({ ...ask, cardId: card.id }, { report: line, signal: stop.signal });
            const at = now();
            const made: MediaResult = { path: await deps.store.saveFileBytes(nameOf(ask, at, piece.ext), piece.bytes), prompt: ask.prompt, at };
            if (piece.by) made.by = piece.by;
            if (piece.poster) made.poster = await deps.store.saveFileBytes(nameOf(ask, at + 1, piece.poster.ext), piece.poster.bytes);
            if (piece.credit) made.music = piece.credit;
            if (piece.noncommercial) made.noncommercial = true;
            if (piece.credits) made.credits = await deps.store.saveFileBytes(`${made.path}.credits.txt`, Buffer.from(piece.credits));
            // A project that could not be written costs the founder nothing but the project: the film stands.
            const mlt = piece.edit ? await saveEdit(made.path, piece.edit).catch(() => null) : null;
            if (mlt) made.mlt = mlt;
            // What the founder dropped on the card while it was working is still theirs: read the card again, not `before`.
            const latest = await read(card.id);
            save(card.id, { ...latest, state: 'idle', problem: undefined, log: [...log, `done · ${maker.name}`], results: [made, ...before.results].slice(0, KEEP) });
            return made;
          } catch (error) {
            if (stop.signal.aborted) throw new Error('stopped');
            failures.push(`${maker.name}: ${(error as Error).message}`);
          }
        }
        throw new Error(failures.join('; '));
      } catch (error) {
        const problem = (error as Error).message;
        save(card.id, { ...(await read(card.id)), state: 'failed', problem, log: [...log, `failed: ${problem}`] });
        throw error;
      } finally {
        running.delete(card.id);
      }
    },
  };
}
