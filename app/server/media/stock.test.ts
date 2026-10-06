import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  broll, creditOf, fakeStock, filmStock, LICENCE, peopleIn, pexels, PEXELS_HINT, PEXELS_REFUSED, photographable, trouble, type Found,
} from './stock.ts';
import { heldFaceLine, NO_PHOTOS_LINE } from './video.ts';

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

describe('what a failed search means for the rest of the film', () => {
  const failure = async (env: NodeJS.ProcessEnv, status: number) =>
    pexels(env, answering({}, status)).find({ query: 'a bare table' }).then(() => null, (error: unknown) => error);

  it('stops asking, and says so once, when Pexels refuses the key', async () => {
    for (const status of [401, 403]) expect(trouble(await failure({ PEXELS_API_KEY: 'wrong' }, status))).toEqual({ say: PEXELS_REFUSED, stop: true });
  });

  it('stops asking, and says why, when the hour is spent', async () => {
    const said = trouble(await failure({ PEXELS_API_KEY: 'k' }, 429));
    expect(said.stop).toBe(true);
    expect(said.say).toMatch(/used up/);
  });

  it('stops quietly with no key at all, since the film said that once already', async () => {
    expect(trouble(await failure({}, 200))).toEqual({ say: '', stop: true });
  });

  it('treats a missing picture or a blip as this one picture only', async () => {
    expect(trouble(await failure({ PEXELS_API_KEY: 'k' }, 404))).toEqual({ say: '', stop: false });
    expect(trouble(new Error('fetch failed'))).toEqual({ say: '', stop: false });
  });

  it('keeps photographs out of the hand-drawn look alone', () => {
    expect(photographable('sketch')).toBe(false);
    expect(photographable('clean')).toBe(true);
  });

  it('tells the founder in the studio\'s words what a Pexels key would add, and where to get one', () => {
    expect(NO_PHOTOS_LINE).toMatch(/^Real photographs needs a Pexels key/);
    expect(NO_PHOTOS_LINE).toContain('pexels.com/api');
  });
});

describe('a lip-sync service that is set up but not spent', () => {
  it('says the service works and what would use it, never to add a token the founder already has', () => {
    for (const draft of [true, false]) {
      expect(heldFaceLine(draft)).not.toContain('HF_TOKEN');
      expect(heldFaceLine(draft)).toMatch(/set up/);
    }
    expect(heldFaceLine(false)).toMatch(/AI clips/);
    expect(heldFaceLine(true)).toMatch(/draft/);
  });
});

describe('one film asking the library, as the founder hears it', () => {
  const counting = (status: number) => {
    let searches = 0;
    const http = (async (url: string | URL) => {
      if (String(url).startsWith('https://api.pexels.com')) searches += 1;
      return answering(PHOTOS, status)(url);
    }) as unknown as typeof fetch;
    return { http, searches: () => searches };
  };

  it('with no key, says it once up front, asks nothing and hands every picture to drawing', async () => {
    const { http, searches } = counting(200);
    const lines: string[] = [];
    const photos = filmStock(pexels({}, http), 'clean', (line) => lines.push(line));
    expect(photos.missing).toBe(true);
    for (let scene = 0; scene < 3; scene += 1) expect(await photos.take({ query: 'a bare table' })).toBeNull();
    expect(searches()).toBe(0);
    expect(lines).toEqual([]);
  });

  it('with a refused key, says PEXELS_API_KEY once and stops asking after the first scene', async () => {
    const { http, searches } = counting(401);
    const lines: string[] = [];
    const photos = filmStock(pexels({ PEXELS_API_KEY: 'wrong' }, http), 'clean', (line) => lines.push(line));
    expect(photos.missing).toBe(false);
    for (let scene = 0; scene < 4; scene += 1) expect(await photos.take({ query: 'a bare table' })).toBeNull();
    expect(searches()).toBe(1);
    expect(lines).toEqual([PEXELS_REFUSED]);
  });

  it('with a spent hour, says so once and stops asking', async () => {
    const { http, searches } = counting(429);
    const lines: string[] = [];
    const photos = filmStock(pexels({ PEXELS_API_KEY: 'k' }, http), 'clean', (line) => lines.push(line));
    for (let scene = 0; scene < 3; scene += 1) await photos.take({ query: 'a bare table' });
    expect(searches()).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/used up/);
  });

  it('with a working key, brings back a photograph with its credit, and keeps people off the speaker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'film-stock-'));
    try {
      const photos = filmStock(pexels({ PEXELS_API_KEY: 'k' }, answering(PHOTOS), dir), 'clean', () => {});
      const got = await photos.take({ query: 'a bare table' });
      expect(got?.ext).toBe('jpg');
      expect(got?.bytes.length).toBeGreaterThan(0);
      expect(creditOf(got!.found)).toContain('on Pexels');
      const asSpeaker = await photos.take({ query: 'a bare table', speaker: true, fits: (one) => one.people });
      expect(asSpeaker).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('never photographs a hand-drawn film and never says a key is missing there', async () => {
    const { http, searches } = counting(200);
    const photos = filmStock(pexels({ PEXELS_API_KEY: 'k' }, http), 'sketch', () => {});
    expect(await photos.take({ query: 'a bare table' })).toBeNull();
    expect(searches()).toBe(0);
    expect(filmStock(pexels({}, http), 'sketch', () => {}).missing).toBe(false);
    expect(filmStock(undefined, 'clean', () => {}).missing).toBe(false);
  });

  it('reads a 403 on one photograph file as that picture only, not a refused key', () => {
    expect(trouble(new Error('that photograph could not be fetched (403)'))).toEqual({ say: '', stop: false });
  });
});
