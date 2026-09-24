import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeckEvent } from '../../shared/deck.ts';
import { stubPdf } from './render.ts';
import { createDecks, type Gathered } from './store.ts';

// A store over a throwaway folder, with the made-up storyboard (no model), a stand-in printer, and files kept in memory.
async function setup(opts: { think?: (prompt: string) => Promise<string>; gathered?: Gathered } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'decks-'));
  const files = new Map<string, Buffer>();
  const heard: DeckEvent[] = [];
  const prompts: string[] = [];
  const decks = createDecks({
    dir,
    gather: async () => opts.gathered ?? { material: { brief: '', sources: [] }, dress: {}, using: [] },
    save: async (name, bytes) => { files.set(name, bytes); return name; },
    print: async (html) => stubPdf((html.match(/<section /g) ?? []).length),
    ...(opts.think ? { think: async (prompt: string) => { prompts.push(prompt); return opts.think!(prompt); } } : {}),
    tell: (_card, event) => heard.push(event),
    now: () => Date.UTC(2026, 8, 25, 9),
  });
  return { decks, files, heard, prompts, dir };
}

describe('a deck', () => {
  it('is made from a brief into a version with its slides, its page and its PDF, and says each step', async () => {
    const { decks, files, heard, dir } = await setup();
    const made = await decks.make('deck-1', { brief: 'Seed deck for Relay', purpose: 'pitch', look: 'clean' });
    expect(made.version).toBe(1);
    expect(made.slides.map((one) => one.shape)).toEqual(['title', 'problem', 'solution', 'traction', 'ask']);
    expect(made.slides.find((one) => one.shape === 'traction')?.lines).toEqual(['No numbers yet.']);
    expect(made.pdf).toMatch(/^decks\/seed-deck-for-relay-deck-1-v1\.pdf$/);
    expect(files.get(made.pdf)!.toString()).toContain('/Count 5');
    expect(files.get(made.html)!.toString()).toContain('<section class="slide slide--title"');
    const deck = await decks.read('deck-1');
    expect(deck.state).toBe('idle');
    expect(deck.log).toContain('printing 5 slides to PDF…');
    expect(deck.log.at(-1)).toBe('done · version 1, 5 slides');
    expect(heard.some((one) => one.deck.state === 'making')).toBe(true);
    await decks.settled();
    expect(JSON.parse(await readFile(join(dir, 'decks', 'deck-1.json'), 'utf8')).versions).toHaveLength(1);
  });

  it('takes notes as the next version, remaking only what they touch', async () => {
    const { decks } = await setup();
    const first = await decks.make('deck-1', { brief: 'Seed deck', purpose: 'pitch', look: 'editorial' });
    const second = await decks.edit('deck-1', 'merge slides 2 and 3');
    expect(second.version).toBe(2);
    expect(second.from).toBe(1);
    expect(second.look).toBe('editorial');
    expect(second.slides).toHaveLength(first.slides.length - 1);
    expect(second.slides[0]).toEqual(first.slides[0]);
    expect(second.slides[1].lines).toContain('One stage for the whole company');
    expect(second.said).toContain('merged slides 2 and 3');
    expect(second.said).toContain('kept 3 of 4 slides as they were');
    const deck = await decks.read('deck-1');
    expect(deck.versions.map((one) => one.version)).toEqual([1, 2]);
    expect(deck.slides).toEqual(second.slides);
    // Notes on an earlier version are read against that version's numbers.
    const third = await decks.edit('deck-1', 'drop 5', { version: 1 });
    expect(third.from).toBe(1);
    expect(third.slides.map((one) => one.shape)).toEqual(['title', 'problem', 'solution', 'traction']);
  });

  it('says what it could not read, and refuses notes that change nothing', async () => {
    const { decks } = await setup();
    await expect(decks.edit('deck-1', 'drop 2')).rejects.toThrow('there is no deck to edit yet');
    await decks.make('deck-1', { brief: 'x', purpose: 'pitch', look: 'clean' });
    await expect(decks.edit('deck-1', 'make it pop')).rejects.toThrow('none of the notes said what to change');
    const deck = await decks.read('deck-1');
    expect(deck.state).toBe('failed');
    expect(deck.log).toContain('I could not read: make it pop');
    const made = await decks.edit('deck-1', 'drop 2, make it pop');
    expect(made.said).toContain('I could not read: make it pop');
  });

  it('asks a model once more with the critic\'s faults, then mends, and rewrites one slide from a note', async () => {
    const replies = [
      JSON.stringify({ title: 'Relay', slides: [{ shape: 'title', headline: 'Relay' }, { shape: 'traction', headline: 'We grew 300% this year and it keeps going up', lines: ['300% growth'] }, { shape: 'ask', headline: 'Raising $2M' }] }),
      JSON.stringify({ title: 'Relay', slides: [{ shape: 'title', headline: 'Relay' }, { shape: 'traction', headline: 'Growing', lines: ['300% growth'] }, { shape: 'ask', headline: 'Raising $2M' }] }),
      JSON.stringify({ shape: 'ask', headline: 'Join our first round', lines: ['Introductions to agencies'] }),
    ];
    const { decks, prompts } = await setup({
      think: async () => replies.shift()!,
      gathered: { material: { brief: '', sources: [], metrics: { name: 'Metrics card', text: 'Revenue up 300% since March' } }, dress: {}, using: ['the Metrics card'] },
    });
    const made = await decks.make('deck-1', { brief: 'Relay seed, raising $2M', purpose: 'pitch', look: 'clean' });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Today is Friday, 25 September 2026');
    expect(prompts[0]).toContain('Metrics card (the only source for traction numbers)');
    expect(prompts[1]).toContain('the headline has 10 words');
    expect(made.slides[1].source).toBe('Metrics card');
    expect(made.slides[2].source).toBe('your brief');
    const edited = await decks.edit('deck-1', 'slide 3: warmer, for angels');
    expect(prompts[2]).toContain('The note: slide 3: warmer, for angels');
    expect(edited.slides[2]).toMatchObject({ id: made.slides[2].id, headline: 'Join our first round' });
    expect(edited.slides.slice(0, 2)).toEqual(made.slides.slice(0, 2));
  });

  it('draws one slide of one version for a thumbnail', async () => {
    const { decks } = await setup();
    await decks.make('deck-1', { brief: 'x', purpose: 'pitch', look: 'clean' });
    expect(await decks.slidePage('deck-1', 1, 2)).toContain('id="s3"');
    expect(await decks.slidePage('deck-1', 1, 9)).toBeNull();
    expect(await decks.slidePage('deck-1', 4, 0)).toBeNull();
  });

  it('makes one thing at a time on a card', async () => {
    const { decks } = await setup({ think: () => new Promise(() => {}) });
    void decks.make('deck-1', { brief: 'x', purpose: 'pitch', look: 'clean' }).catch(() => {});
    await new Promise((done) => setTimeout(done, 10));
    expect(decks.busy('deck-1')).toBe(true);
    await expect(decks.make('deck-1', { brief: 'x', purpose: 'pitch', look: 'clean' })).rejects.toThrow('already being made');
  });
});
