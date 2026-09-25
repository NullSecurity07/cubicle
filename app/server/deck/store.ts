import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_DECK, type Deck, type DeckEvent, type DeckLook, type DeckPurpose, type DeckVersion, type Slide } from '../../shared/deck.ts';
import type { Material } from './critic.ts';
import { mend } from './critic.ts';
import { applyEdits, readNotes } from './notes.ts';
import { deckHtml, type Dress } from './render.ts';
import { rewriteSlide, writeStoryboard, type Think } from './storyboard.ts';

export type Decks = ReturnType<typeof createDecks>;
// What a deck is made from, gathered fresh for every make: the words and numbers, and what the deck wears.
export type Gathered = { material: Material; dress: Omit<Dress, 'look'>; using: string[] };
export type DeckDeps = {
  dir: string;
  gather: (cardId: string, roomId?: string) => Promise<Gathered>;
  // Where a made file goes: the shared files, as `saveFileBytes` puts it. Returns the path it landed at.
  save: (name: string, bytes: Buffer) => Promise<string>;
  print: (html: string, signal?: AbortSignal) => Promise<Buffer>;
  // No model in fake mode: the fixed storyboard is used, so a journey is the same every time.
  think?: Think;
  tell?: (cardId: string, event: DeckEvent) => void;
  now?: () => number;
};
export type MakeAsk = { brief: string; purpose: DeckPurpose; look: DeckLook; roomId?: string };

const KEEP = 12;
const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'deck';

// One sidecar per Deck card, written through a queue and a tmp-rename like the boards, so a card read back mid-job
// tells the truth and a crash never leaves half a file. One job per card at a time; a job's lines go out as it goes.
export function createDecks(deps: DeckDeps) {
  const now = deps.now ?? Date.now;
  const path = (cardId: string) => join(deps.dir, 'decks', `${safe(cardId)}.json`);
  const cache = new Map<string, Deck>();
  const revs = new Map<string, number>();
  const running = new Map<string, AbortController>();
  let queue: Promise<unknown> = Promise.resolve();
  // What the last make wore, so a strip of twelve thumbnails does not read the project folder twelve times.
  const dressed = new Map<string, Omit<Dress, 'look'>>();

  async function read(cardId: string): Promise<Deck> {
    const known = cache.get(cardId);
    if (known) return known;
    let deck: Deck = EMPTY_DECK;
    try { deck = { ...EMPTY_DECK, ...JSON.parse(await readFile(path(cardId), 'utf8')) }; } catch { /* nothing made yet */ }
    if (deck.state === 'making') deck = { ...deck, state: 'failed', problem: 'the app was closed', log: [...deck.log, 'failed: the app was closed'] };
    cache.set(cardId, deck);
    revs.set(cardId, Math.max(revs.get(cardId) ?? 0, now()));
    return deck;
  }
  function write(cardId: string, deck: Deck) {
    cache.set(cardId, deck);
    const text = JSON.stringify(deck, null, 1);
    queue = queue.then(async () => {
      await mkdir(join(deps.dir, 'decks'), { recursive: true });
      await writeFile(`${path(cardId)}.tmp`, text);
      await rename(`${path(cardId)}.tmp`, path(cardId));
    }).catch(() => {});
    revs.set(cardId, Math.max((revs.get(cardId) ?? 0) + 1, now()));
    deps.tell?.(cardId, { deck, rev: revs.get(cardId)! });
  }

  // The frame every job runs in: the log, the one-at-a-time rule, and a failure written down in words.
  async function job(cardId: string, work: (line: (text: string) => void, deck: Deck, signal: AbortSignal) => Promise<DeckVersion>): Promise<DeckVersion> {
    if (running.has(cardId)) throw new Error('this deck is already being made');
    const stop = new AbortController();
    running.set(cardId, stop);
    const before = await read(cardId);
    const log: string[] = [];
    const line = (text: string) => { log.push(text); write(cardId, { ...before, state: 'making', problem: undefined, log: [...log] }); };
    try {
      line('starting…');
      const version = await work(line, before, stop.signal);
      const versions = [...before.versions, version].slice(-KEEP);
      write(cardId, { state: 'idle', log: [...log, `done · version ${version.version}, ${version.slides.length} slides`], slides: version.slides, versions });
      return version;
    } catch (error) {
      const problem = stop.signal.aborted ? 'stopped' : (error as Error).message;
      write(cardId, { ...(await read(cardId)), state: 'failed', problem, log: [...log, `failed: ${problem}`] });
      throw new Error(problem);
    } finally {
      running.delete(cardId);
    }
  }

  // The HTML and the PDF of one version, saved beside each other in the shared files.
  async function publish(cardId: string, slides: Slide[], title: string, look: DeckLook, gathered: Gathered, number: number, line: (text: string) => void, signal: AbortSignal) {
    dressed.set(cardId, gathered.dress);
    const dress: Dress = { ...gathered.dress, look };
    const html = await deckHtml(slides, dress, title);
    const stem = `decks/${slug(title)}-${cardId.slice(-6)}-v${number}`;
    const htmlPath = await deps.save(`${stem}.html`, Buffer.from(html));
    line(`printing ${slides.length} slides to PDF…`);
    const pdf = await deps.save(`${stem}.pdf`, await deps.print(html, signal));
    return { html: htmlPath, pdf };
  }
  const nextNumber = (deck: Deck) => (deck.versions.at(-1)?.version ?? 0) + 1;
  const idsFrom = (slides: Slide[]) => {
    let next = slides.reduce((most, slide) => Math.max(most, Number(/^s(\d+)$/.exec(slide.id)?.[1] ?? 0)), 0);
    return () => `s${++next}`;
  };

  return {
    read,
    settled: () => queue,
    event: async (cardId: string): Promise<DeckEvent> => { const deck = await read(cardId); return { deck, rev: revs.get(cardId)! }; },
    busy: (cardId: string) => running.has(cardId),
    stop(cardId: string) { running.get(cardId)?.abort(); },

    // A new deck from the brief and whatever is wired to the card.
    make(cardId: string, ask: MakeAsk): Promise<DeckVersion> {
      return job(cardId, async (line, before, signal) => {
        line('reading what is wired to the deck…');
        const gathered = await deps.gather(cardId, ask.roomId);
        gathered.material = { ...gathered.material, brief: ask.brief };
        if (gathered.using.length) line(`using ${gathered.using.join(', ')}`);
        if (!gathered.material.metrics) line('no Metrics card is wired, so traction says "No numbers yet."');
        const made = await writeStoryboard({ brief: ask.brief, purpose: ask.purpose, material: gathered.material, think: deps.think, ids: idsFrom([]), now: now(), report: line, signal });
        for (const said of made.said) line(said);
        const number = nextNumber(before);
        const files = await publish(cardId, made.slides, made.title, ask.look, gathered, number, line, signal);
        return { version: number, at: now(), title: made.title, slides: made.slides, ...files, brief: ask.brief, look: ask.look, purpose: ask.purpose, ...(made.said.length ? { said: made.said } : {}) };
      });
    },

    // Notes on one version: only the slides they touch are made again, and the result is the next version beside it.
    edit(cardId: string, notes: string, opts: { version?: number; roomId?: string } = {}): Promise<DeckVersion> {
      return job(cardId, async (line, before, signal) => {
        const base = opts.version ? before.versions.find((one) => one.version === opts.version) : before.versions.at(-1);
        if (!base) throw new Error(opts.version ? `there is no version ${opts.version} of this deck` : 'there is no deck to edit yet: make one first');
        const read = readNotes(notes, base.slides);
        for (const one of read.unread) line(`I could not read: ${one}`);
        if (!read.edits.length) throw new Error(read.unread.length ? 'none of the notes said what to change' : 'the notes are empty');
        const gathered = await deps.gather(cardId, opts.roomId);
        gathered.material = { ...gathered.material, brief: base.brief ?? gathered.material.brief };
        const plain = applyEdits(base.slides, read.edits);
        const said = [...plain.said];
        let slides = plain.slides;
        const touched = new Set(plain.touched);
        for (const edit of read.edits) {
          if (edit.kind !== 'rewrite') continue;
          const at = slides.findIndex((slide) => slide.id === edit.id);
          if (at < 0) continue;
          line(`rewriting slide ${at + 1}…`);
          slides[at] = await rewriteSlide(slides[at], edit.ask, { material: gathered.material, think: deps.think, now: now(), signal });
          touched.add(edit.id);
          said.push(`rewrote slide ${at + 1}`);
        }
        // The rules again, over the slides the notes touched; a kept slide is kept exactly as it was.
        const whole = mend(slides, gathered.material);
        const places = new Set(slides.flatMap((slide, index) => (touched.has(slide.id) ? [`slide ${index + 1}:`] : [])));
        const mended = { said: whole.said.filter((one) => places.has(one.slice(0, one.indexOf(':') + 1))) };
        slides = slides.map((slide, index) => (touched.has(slide.id) ? whole.slides[index] : slide));
        const kept = slides.filter((slide) => !touched.has(slide.id)).length;
        said.push(`kept ${kept} of ${slides.length} slides as they were`);
        for (const one of [...said, ...mended.said]) line(one);
        const number = nextNumber(before);
        const files = await publish(cardId, slides, base.title, base.look, gathered, number, line, signal);
        return {
          version: number, at: now(), title: base.title, slides, ...files, notes, from: base.version, ...(base.brief ? { brief: base.brief } : {}), look: base.look, purpose: base.purpose,
          said: [...said, ...mended.said, ...read.unread.map((one) => `I could not read: ${one}`)],
        };
      });
    },

    // One slide of one version as its own page, for a thumbnail. Fonts and colours as the deck was made, the logo too.
    async slidePage(cardId: string, version: number, index: number): Promise<string | null> {
      const deck = await read(cardId);
      const one = deck.versions.find((candidate) => candidate.version === version);
      if (!one || !one.slides[index]) return null;
      if (!dressed.has(cardId)) dressed.set(cardId, (await deps.gather(cardId).catch(() => null))?.dress ?? {});
      return deckHtml(one.slides, { ...dressed.get(cardId), look: one.look }, one.title, index);
    },
  };
}
