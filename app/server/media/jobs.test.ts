import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card, Media, MediaEvent } from '../../shared/model.ts';
import { createStore } from '../store.ts';
import { createMedia, type Maker } from './jobs.ts';

const card: Card = { id: 'studio-1', kind: 'imagegen', x: 0, y: 0, w: 1, h: 1 };
const folder = () => mkdtemp(join(tmpdir(), 'media-'));
const maker = (name: string, extra: Partial<Maker> = {}): Maker => ({
  name,
  ready: () => null,
  async make(_ask, { report }) { report(`${name} is drawing`); return { ext: 'png', bytes: Buffer.from(name) }; },
  ...extra,
});
const studio = async (makers: Maker[], now?: () => number) => {
  const dir = await folder();
  return { dir, media: createMedia({ dir, store: createStore(dir), makers: { imagegen: makers }, now }) };
};

describe('media jobs', () => {
  it('keeps what it made, tells whoever watches, and writes a sidecar that reads back', async () => {
    const { dir, media } = await studio([maker('one')]);
    const seen: MediaEvent[] = [];
    media.watch((event) => seen.push(event));
    const made = await media.make(card, { prompt: 'A calm desk at dawn' });
    expect(made.path).toMatch(/^media\/[a-z0-9]+-a-calm-desk-at-dawn\.png$/);
    expect(made.prompt).toBe('A calm desk at dawn');
    expect(await createStore(dir).readFileBytes(made.path)).toEqual(Buffer.from('one'));

    const now = await media.read(card.id);
    expect(now).toMatchObject({ state: 'idle', results: [made] });
    expect(now.log).toEqual(['one is drawing', 'done · one']);
    expect(seen).toContainEqual({ id: card.id, line: 'one is drawing' });
    expect(seen.at(-1)).toEqual({ id: card.id, changed: true });

    await media.settled();
    expect(JSON.parse(await readFile(join(dir, 'media', 'studio-1.json'), 'utf8'))).toEqual(now);
  });

  it('tries each backend in turn and keeps the failure in words the founder can read', async () => {
    const { media } = await studio([
      maker('unset', { ready: () => 'Add a key to .env.' }),
      maker('broken', { make: async () => { throw new Error('answered 401'); } }),
      maker('three'),
    ]);
    expect((await media.make(card, { prompt: 'a kite' })).path).toContain('a-kite');
    expect((await media.read(card.id)).log.at(-1)).toBe('done · three');

    const { media: none } = await studio([maker('broken', { make: async () => { throw new Error('answered 401'); } })]);
    await expect(none.make(card, { prompt: 'a kite' })).rejects.toThrow('broken: answered 401');
    expect(await none.read(card.id)).toMatchObject({ state: 'failed', problem: 'broken: answered 401' });
  });

  it('says why nothing can be made yet, and nothing when a backend is ready', async () => {
    const { media } = await studio([maker('unset', { ready: () => 'Add a key to .env.' })]);
    expect(media.ready('imagegen')).toBe('Add a key to .env.');
    expect(media.ready('voicegen')).toBe('Nothing is set up to make this yet.');
    const { media: fine } = await studio([maker('one')]);
    expect(fine.ready('imagegen')).toBeNull();
  });

  it('reads a job that the app closed on as failed, never as still making', async () => {
    const dir = await folder();
    const held: Media = { state: 'making', log: ['drawing it…'], results: [] };
    await mkdir(join(dir, 'media'), { recursive: true });
    await writeFile(join(dir, 'media', 'studio-1.json'), JSON.stringify(held));
    const media = createMedia({ dir, store: createStore(dir), makers: { imagegen: [maker('one')] } });
    expect(await media.read(card.id)).toMatchObject({ state: 'failed', problem: 'the app was closed' });
    expect((await media.read(card.id)).log).toEqual(['drawing it…', 'failed: the app was closed']);
  });

  it('keeps the last twelve, newest first, and does two jobs on one card one at a time', async () => {
    let at = 1_700_000_000_000;
    const { media } = await studio([maker('one')], () => (at += 1000));
    for (let round = 0; round < 14; round += 1) await media.make(card, { prompt: `picture ${round}` });
    const kept = (await media.read(card.id)).results;
    expect(kept).toHaveLength(12);
    expect(kept[0].prompt).toBe('picture 13');
    expect(kept.at(-1)!.prompt).toBe('picture 2');

    const slow = await studio([maker('slow', { make: async () => { await new Promise((done) => setTimeout(done, 20)); return { ext: 'png', bytes: Buffer.from('slow') }; } })]);
    const first = slow.media.make(card, { prompt: 'first' });
    await expect(slow.media.make(card, { prompt: 'second' })).rejects.toThrow(/already making/);
    await first;
  });

  it('stops a job the founder no longer wants', async () => {
    const { media } = await studio([maker('slow', {
      async make(_ask, { signal }) {
        await new Promise((done, fail) => { signal?.addEventListener('abort', () => fail(new Error('aborted')), { once: true }); setTimeout(done, 500); });
        return { ext: 'png', bytes: Buffer.from('slow') };
      },
    })]);
    const job = media.make(card, { prompt: 'a long one' });
    setTimeout(() => media.stop(card.id), 10);
    await expect(job).rejects.toThrow('stopped');
    expect(await media.read(card.id)).toMatchObject({ state: 'failed', problem: 'stopped' });
  });
});
