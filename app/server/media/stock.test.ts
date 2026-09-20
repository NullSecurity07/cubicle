import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { broll, creditOf, fakeStock, LICENCE, peopleIn, pexels, PEXELS_HINT, type Found } from './stock.ts';

const PHOTOS = {
  photos: [{
    id: 12345, width: 1200, height: 1800, url: 'https://www.pexels.com/photo/12345/',
    photographer: 'A Photographer', photographer_url: 'https://www.pexels.com/@one',
    alt: 'a bare table by a window', src: { large2x: 'https://images.pexels.com/12345.jpg' },
  }],
};
const VIDEOS = {
  videos: [{
    id: 999, width: 1080, height: 1920, duration: 12, url: 'https://www.pexels.com/video/999/',
    user: { name: 'A Film-maker', url: 'https://www.pexels.com/@two' },
    video_files: [
      { link: 'https://videos.pexels.com/small.mp4', file_type: 'video/mp4', width: 640 },
      { link: 'https://videos.pexels.com/big.mp4', file_type: 'video/mp4', width: 1920 },
    ],
  }],
};

const answering = (body: unknown, status = 200) => (async (url: string | URL) => {
  const address = String(url);
  if (address.startsWith('https://images.') || address.startsWith('https://videos.')) {
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('the file').buffer } as unknown as Response;
  }
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}) as unknown as typeof fetch;

describe('a key nobody has set', () => {
  it('says where a free one comes from rather than failing quietly', () => {
    const library = pexels({}, answering(PHOTOS));
    expect(library.ready()).toBe(PEXELS_HINT);
    expect(library.ready()).toContain('pexels.com/api');
  });

  it('refuses to search without one', async () => {
    await expect(pexels({}, answering(PHOTOS)).find({ query: 'a bare table' })).rejects.toThrow(/PEXELS_API_KEY/);
  });
});

describe('what comes back', () => {
  it('carries the photographer, the page and the licence with every photograph', async () => {
    const found = await pexels({ PEXELS_API_KEY: 'k' }, answering(PHOTOS)).find({ query: 'a bare table', shape: 'tall' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'photo', by: 'A Photographer', page: 'https://www.pexels.com/photo/12345/', licence: LICENCE,
      url: 'https://images.pexels.com/12345.jpg',
    });
    expect(creditOf(found[0])).toContain('A Photographer');
  });

  it('asks a tall film for portrait', async () => {
    let asked = '';
    const seen = (async (url: string | URL) => { asked = String(url); return { ok: true, status: 200, json: async () => PHOTOS } as unknown as Response; }) as unknown as typeof fetch;
    await pexels({ PEXELS_API_KEY: 'k' }, seen).find({ query: 'a bare table', shape: 'tall' });
    expect(asked).toContain('orientation=portrait');
  });

  it('takes the biggest file a clip offers', async () => {
    const found = await pexels({ PEXELS_API_KEY: 'k' }, answering(VIDEOS)).find({ query: 'rain', kind: 'video' });
    expect(found[0].url).toBe('https://videos.pexels.com/big.mp4');
    expect(found[0].seconds).toBe(12);
  });

  it('says plainly when the hour\'s free searches are gone', async () => {
    await expect(pexels({ PEXELS_API_KEY: 'k' }, answering({}, 429)).find({ query: 'a bare table' }))
      .rejects.toThrow(/used up/);
  });
});

describe('the file, once', () => {
  it('is fetched once and kept, with the photographer written down beside it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stock-'));
    try {
      let fetched = 0;
      const counting = (async (url: string | URL) => {
        const address = String(url);
        if (address.startsWith('https://images.')) { fetched += 1; return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('the file').buffer } as unknown as Response; }
        return { ok: true, status: 200, json: async () => PHOTOS } as unknown as Response;
      }) as unknown as typeof fetch;
      const library = pexels({ PEXELS_API_KEY: 'k' }, counting, dir);
      const [one] = await library.find({ query: 'a bare table' });
      await library.get(one);
      await library.get(one);
      expect(fetched).toBe(1);
      const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as Record<string, { by: string }>;
      expect(Object.values(index)[0].by).toBe('A Photographer');
      expect(library.used().map((used) => used.id)).toContain(one.id);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('a person in a photograph', () => {
  const people: Found = { id: 'a', kind: 'photo', url: 'u', page: 'p', width: 1, height: 1, by: 'B', byUrl: 'b', licence: LICENCE, what: 'a woman walking past a wall', people: true };
  const thing: Found = { ...people, id: 'b', what: 'a bare table by a window', people: false };

  it('is read off what the photographer wrote', () => {
    expect(peopleIn('a woman walking past a wall')).toBe(true);
    expect(peopleIn('a bare table by a window')).toBe(false);
  });

  it('is b-roll and never the film\'s own speaker', () => {
    expect(broll([people, thing], { speaker: true }).map((one) => one.id)).toEqual(['b']);
    expect(broll([people, thing]).map((one) => one.id)).toEqual(['a', 'b']);
  });

  it('never sits beside a claim about a named product, because that implies an endorsement', () => {
    expect(broll([people, thing], { names: ['Acme'] }).map((one) => one.id)).toEqual(['b']);
  });
});

describe('the library the tests get', () => {
  it('never leaves the machine and still remembers what was taken', async () => {
    const library = fakeStock();
    expect(library.ready()).toBeNull();
    const found = await library.find({ query: 'anything' });
    await library.get(found[0]);
    expect(library.used()).toHaveLength(1);
  });
});
