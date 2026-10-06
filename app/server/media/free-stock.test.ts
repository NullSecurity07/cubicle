import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowance, commons, creditLine, licenceOf, openverse, OPENVERSE_BUSY, OPENVERSE_SPENT, photoLibrary, plainText, queryOf, stockChain,
} from './free-stock.ts';
import { filmStock, NONE_ANSWERED, photoCredits, trouble, type Stock } from './stock.ts';
import { pictureSpaces, spacesFor } from './image.ts';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'free-stock-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

type Seen = { url: string; headers: Record<string, string> };
const answering = (body: unknown, status = 200, headers: Record<string, string> = {}, seen: Seen[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    if (!String(url).includes('api')) return new Response(new Uint8Array([0xff, 0xd8, 1, 2]), { status: 200 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;

const OPENVERSE = { results: [
  { id: 'a1', title: 'Baker at the oven', url: 'https://live.staticflickr.com/a1.jpg', foreign_landing_url: 'https://www.flickr.com/photos/x/1', creator: 'Ana', creator_url: 'https://flickr.com/ana', license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/', attribution: '"Baker at the oven" by Ana is licensed under CC BY 2.0. To view a copy of this license, visit https://creativecommons.org/licenses/by/2.0/.', width: 4000, height: 2600, filetype: 'jpg', tags: [{ name: 'bread' }] },
  { id: 'a2', title: 'Tiny', url: 'https://x/a2.jpg', foreign_landing_url: 'https://x/2', creator: 'B', license: 'cc0', width: 800, height: 500, filetype: 'jpg' },
  { id: 'a3', title: 'Logo', url: 'https://x/a3.svg', foreign_landing_url: 'https://x/3', creator: 'C', license: 'cc0', width: 4000, height: 2000, filetype: 'svg' },
  { id: 'a4', title: 'Shared alike', url: 'https://x/a4.jpg', foreign_landing_url: 'https://x/4', creator: 'D', license: 'by-sa', license_version: '4.0', width: 4000, height: 2000, filetype: 'jpg' },
  { id: 'a5', title: 'Standing up', url: 'https://x/a5.jpg', foreign_landing_url: 'https://x/5', creator: 'E', license: 'pdm', width: 2000, height: 3000, filetype: 'jpg' },
  { id: 'a6', title: 'Old oven', url: 'https://x/a6.jpg', foreign_landing_url: 'https://x/6', creator: 'F', license: 'pdm', width: 3000, height: 2000, filetype: 'jpg' },
] };

const meta = (artist: string, licence: string, name = 'Baker') => ({
  Artist: { value: artist }, LicenseShortName: { value: licence }, ObjectName: { value: name }, ImageDescription: { value: 'Bread in a stone oven' },
});
const COMMONS_PHOTOS = { query: { pages: [
  { pageid: 11, index: 2, title: 'File:Oven.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/o.jpg', thumburl: 'https://upload.wikimedia.org/thumb/1920px-o.jpg', width: 4000, height: 3000, mime: 'image/jpeg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Oven.jpg', extmetadata: meta('<a href="//commons.wikimedia.org/wiki/User:Ermell">Ermell</a>', 'CC BY 4.0', 'Oven') }] },
  { pageid: 12, index: 1, title: 'File:Gfdl.jpg', imageinfo: [{ url: 'https://u/g.jpg', width: 4000, height: 3000, mime: 'image/jpeg', descriptionurl: 'https://c/g', extmetadata: meta('X', 'GFDL 1.2') }] },
  { pageid: 13, index: 3, title: 'File:Small.jpg', imageinfo: [{ url: 'https://u/s.jpg', width: 1200, height: 800, mime: 'image/jpeg', descriptionurl: 'https://c/s', extmetadata: meta('Y', 'CC0') }] },
  { pageid: 14, index: 4, title: 'File:Drawing.svg', imageinfo: [{ url: 'https://u/d.svg', width: 4000, height: 3000, mime: 'image/svg+xml', descriptionurl: 'https://c/d', extmetadata: meta('Z', 'CC0') }] },
  { pageid: 15, index: 5, title: 'File:Sa.jpg', imageinfo: [{ url: 'https://u/sa.jpg', width: 4000, height: 3000, mime: 'image/jpeg', descriptionurl: 'https://c/sa', extmetadata: meta('W', 'CC BY-SA 4.0') }] },
] } };
const COMMONS_VIDEOS = { query: { pages: [
  { pageid: 21, index: 1, title: 'File:Bakery.webm', videoinfo: [{ url: 'https://upload.wikimedia.org/b.webm', width: 1920, height: 1080, duration: 12.5, mime: 'video/webm', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Bakery.webm', extmetadata: meta('Missvain', 'CC BY 4.0', 'Bakery'),
    derivatives: [{ src: 'https://upload.wikimedia.org/b.480p.vp9.webm', transcodekey: '480p.vp9.webm', width: 854, height: 480 }, { src: 'https://upload.wikimedia.org/b.1080p.vp9.webm', transcodekey: '1080p.vp9.webm', width: 1920, height: 1080 }, { src: 'https://upload.wikimedia.org/b.720p.vp9.webm', transcodekey: '720p.vp9.webm', width: 1280, height: 720 }] }] },
  { pageid: 22, index: 2, title: 'File:Low.ogv', videoinfo: [{ url: 'https://u/l.ogv', width: 640, height: 480, duration: 8, mime: 'application/ogg', descriptionurl: 'https://c/l', extmetadata: meta('V', 'CC0'), derivatives: [] }] },
  { pageid: 23, index: 3, title: 'File:Sa.webm', videoinfo: [{ url: 'https://u/sa.webm', width: 1920, height: 1080, duration: 8, mime: 'video/webm', descriptionurl: 'https://c/sa', extmetadata: meta('U', 'CC BY-SA 4.0'), derivatives: [] }] },
  { pageid: 24, index: 4, title: 'File:Pd.webm', videoinfo: [{ url: 'https://u/pd.webm', width: 1280, height: 720, duration: 6, mime: 'video/webm', descriptionurl: 'https://c/pd', extmetadata: meta('T', 'Public domain', 'Old film'), derivatives: [] }] },
] } };

describe('the words an open library is asked', () => {
  it('keeps the one or two things a brief names and drops feelings, plans and verbs', () => {
    expect(queryOf('a baker pulling bread from a stone oven at dawn')).toBe('baker bread');
    expect(queryOf('Growth that compounds while you sleep')).toBe('');
    expect(queryOf('The future of innovation is a better strategy')).toBe('');
    expect(queryOf('Freight trucks at a loading dock, wide cinematic photo, soft light', 1)).toBe('freight');
    expect(queryOf('A train station in 2026')).toBe('train station');
  });
});

describe('licences', () => {
  it('takes CC0, public domain and CC BY, and nothing that binds or forbids', () => {
    expect(licenceOf('CC0')).toEqual({ ok: true, name: 'CC0' });
    expect(licenceOf('Public domain')).toEqual({ ok: true, name: 'Public domain' });
    expect(licenceOf('PDM 1.0').ok).toBe(true);
    expect(licenceOf('CC BY 4.0')).toEqual({ ok: true, name: 'CC BY 4.0' });
    expect(licenceOf('CC BY-SA 4.0').ok).toBe(false);
    expect(licenceOf('CC BY-NC 2.0').ok).toBe(false);
    expect(licenceOf('CC BY-ND 3.0').ok).toBe(false);
    expect(licenceOf('GFDL 1.2').ok).toBe(false);
    expect(licenceOf('').ok).toBe(false);
  });
  it('says a credit line the way CC BY asks: work, maker, licence, where it lives', () => {
    expect(creditLine({ title: 'Oven', by: 'Ermell', licence: 'CC BY 4.0', page: 'https://commons.wikimedia.org/wiki/File:Oven.jpg', source: 'Wikimedia Commons' }))
      .toBe('"Oven" by Ermell · CC BY 4.0 · Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Oven.jpg');
    expect(plainText('<a href="x">Ana &amp; Bo</a>')).toBe('Ana & Bo');
    expect(plainText('<div class="fn value">\nUnknown author<span style="display: none;">Unknown author</span> or not provided</div>')).toBe('Unknown author or not provided');
  });
});

describe('Openverse', () => {
  it('asks for the nouns only, open licences only, and keeps big landscape files with their credit', async () => {
    const seen: Seen[] = [];
    const found = await openverse(answering(OPENVERSE, 200, {}, seen), dir).find({ query: 'a baker pulling bread from a stone oven', shape: 'wide' });
    expect(seen[0].url).toContain('q=baker%20bread');
    expect(seen[0].url).toContain('license=cc0,pdm,by');
    expect(seen[0].url).toContain('aspect_ratio=wide');
    expect(seen[0].headers['user-agent']).toMatch(/CubicleStudio/);
    expect(found.map((one) => one.id)).toEqual(['openverse-photo-a1', 'openverse-photo-a6']);
    expect(found[0].credit).toBe('"Baker at the oven" by Ana is licensed under CC BY 2.0. (https://creativecommons.org/licenses/by/2.0/) · Openverse — https://www.flickr.com/photos/x/1');
    expect(found[0].licence).toBe('CC BY 2.0');
    expect(found[1].credit).toBe('"Old oven" by F · Public domain · Openverse — https://x/6');
  });
  it('asks nothing for footage, or for a line with no thing in it', async () => {
    const seen: Seen[] = [];
    const library = openverse(answering(OPENVERSE, 200, {}, seen), dir);
    expect(await library.find({ query: 'bakery', kind: 'video' })).toEqual([]);
    expect(await library.find({ query: 'growth that compounds' })).toEqual([]);
    expect(seen).toHaveLength(0);
  });
  it('counts every search and stops at two hundred a day, and believes the count Openverse sends back', async () => {
    let now = Date.parse('2026-10-06T10:00:00Z');
    const library = openverse(answering(OPENVERSE, 200, { 'x-ratelimit-available-anon_sustained': '0' }), dir, () => now);
    await library.find({ query: 'oven' });
    await expect(library.find({ query: 'oven' })).rejects.toThrow(OPENVERSE_SPENT);
    expect(JSON.parse(await readFile(join(dir, 'openverse-count.json'), 'utf8'))).toMatchObject({ day: '2026-10-06', used: 1, left: 0 });
    now = Date.parse('2026-10-07T10:00:00Z');
    await expect(library.find({ query: 'oven' })).resolves.toHaveLength(2);
  });
  it('stops at twenty a minute without spending the day', async () => {
    let now = Date.parse('2026-10-06T10:00:00Z');
    const count = allowance(join(dir, 'c.json'), () => now);
    for (let i = 0; i < 20; i += 1) await count.spend();
    expect(await count.blocked()).toBe(OPENVERSE_BUSY);
    now += 61_000;
    expect(await count.blocked()).toBeNull();
    expect(await count.used()).toEqual({ used: 20, left: 180 });
  });
  it('a 429 is a spent minute or a spent day, said in words', async () => {
    await expect(openverse(answering('slow down', 429), dir).find({ query: 'oven' })).rejects.toThrow(OPENVERSE_BUSY);
    await expect(openverse(answering('sustained', 429, { 'retry-after': '40000' }), join(dir, 'b')).find({ query: 'oven' })).rejects.toThrow(OPENVERSE_SPENT);
  });
});

describe('Wikimedia Commons', () => {
  it('keeps big bitmaps under CC0, public domain or CC BY, in search order, with a credit naming the author', async () => {
    const seen: Seen[] = [];
    const found = await commons(answering(COMMONS_PHOTOS, 200, {}, seen), dir).find({ query: 'a stone oven', shape: 'wide' });
    expect(seen[0].url).toContain('gsrsearch=stone+oven+filetype%3Abitmap');
    expect(seen[0].url).toContain('iiurlwidth=1920');
    expect(seen[0].headers['user-agent']).toMatch(/CubicleStudio/);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'commons-photo-11', url: 'https://upload.wikimedia.org/thumb/1920px-o.jpg', by: 'Ermell', licence: 'CC BY 4.0' });
    expect(found[0].credit).toBe('"Oven" by Ermell · CC BY 4.0 · Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Oven.jpg');
  });
  it('keeps footage of 720 lines or more, taking the 1080p VP9 copy, and refuses share-alike', async () => {
    const found = await commons(answering(COMMONS_VIDEOS), dir).find({ query: 'bakery', kind: 'video', shape: 'wide' });
    expect(found.map((one) => one.id)).toEqual(['commons-video-21', 'commons-video-24']);
    expect(found[0]).toMatchObject({ url: 'https://upload.wikimedia.org/b.1080p.vp9.webm', width: 1920, height: 1080, seconds: 12.5, licence: 'CC BY 4.0' });
    expect(found[1]).toMatchObject({ url: 'https://u/pd.webm', licence: 'Public domain' });
    const got = await commons(answering(COMMONS_VIDEOS), dir).get(found[0]);
    expect(got.ext).toBe('webm');
  });
  it('an error is said, not swallowed', async () => {
    await expect(commons(answering('down', 503), dir).find({ query: 'oven' })).rejects.toThrow('Wikimedia Commons answered 503');
  });
});

describe('one library out of several', () => {
  const failing = (name: string, message: string, moving = false): Stock => ({
    name, moving, ready: () => null, async find() { throw new Error(message); }, async get() { throw new Error('no'); }, used: () => [],
  });
  it('falls from a spent Openverse to Commons, says so once, and fetches from the one that found it', async () => {
    const chain = stockChain([failing('Openverse', OPENVERSE_SPENT), commons(answering(COMMONS_PHOTOS), dir)]);
    const found = await chain.find({ query: 'stone oven' });
    expect(found[0].id).toBe('commons-photo-11');
    expect(chain.heard!()).toEqual([OPENVERSE_SPENT]);
    await chain.find({ query: 'stone oven' });
    expect(chain.heard!()).toEqual([]);
    expect((await chain.get(found[0])).ext).toBe('jpg');
    expect(chain.used().map((one) => one.id)).toEqual(['commons-photo-11']);
  });
  it('asks for footage only of a library that has some', async () => {
    const chain = stockChain([openverse(answering(OPENVERSE), dir), commons(answering(COMMONS_VIDEOS), dir)]);
    expect(chain.moving).toBe(true);
    expect((await chain.find({ query: 'bakery', kind: 'video' }))[0].id).toBe('commons-video-21');
  });
  it('tries the first thing alone when two together found nothing', async () => {
    const seen: Seen[] = [];
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: {} });
      return answering(String(url).includes('stone%20oven') || String(url).includes('stone+oven') ? { results: [], query: { pages: [] } } : COMMONS_PHOTOS)(url, init);
    }) as typeof fetch;
    const found = await stockChain([commons(http, dir)]).find({ query: 'stone oven' });
    expect(seen.map((one) => /gsrsearch=([^&]+)/.exec(one.url)![1])).toEqual(['stone+oven+filetype%3Abitmap', 'stone+filetype%3Abitmap']);
    expect(found).toHaveLength(1);
  });
  it('when nobody answers, says so in plain words and the film draws', async () => {
    const chain = stockChain([failing('Openverse', 'Openverse answered 500'), failing('Wikimedia Commons', 'Wikimedia Commons answered 503')]);
    const error = await chain.find({ query: 'oven' }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(new RegExp(`^${NONE_ANSWERED} for this picture`));
    expect((error as Error).message).toContain('Wikimedia Commons answered 503');
    expect(trouble(error)).toEqual({ say: (error as Error).message, stop: false });
  });
  it('with no key the library is Openverse then Commons; with one, Pexels comes first', () => {
    expect(photoLibrary({}, answering({}), dir).name).toBe('Openverse → Wikimedia Commons');
    expect(photoLibrary({ PEXELS_API_KEY: 'k' }, answering({}), dir).name).toBe('pexels → Openverse → Wikimedia Commons');
    expect(photoLibrary({}, answering({}), dir).ready()).toBeNull();
  });
});

describe('a film using the free libraries', () => {
  it('takes a photograph, says a spent library once, and never throws', async () => {
    const lines: string[] = [];
    const chain = stockChain([failing('Openverse', OPENVERSE_SPENT), commons(answering(COMMONS_PHOTOS), dir)]);
    const film = filmStock(chain, 'documentary', (line) => lines.push(line));
    expect(film.missing).toBe(false);
    const one = await film.take({ query: 'stone oven', shape: 'wide' });
    await film.take({ query: 'stone oven', shape: 'wide' });
    expect(one?.found.credit).toContain('Wikimedia Commons');
    expect(lines).toEqual([OPENVERSE_SPENT]);
    const dead = filmStock(stockChain([failing('Wikimedia Commons', 'Wikimedia Commons answered 503')]), 'documentary', (line) => lines.push(line));
    await expect(dead.take({ query: 'oven' })).resolves.toBeNull();
    expect(lines.at(-1)).toMatch(new RegExp(`^${NONE_ANSWERED}`));
  });
  it('takes a real clip of the scene', async () => {
    const film = filmStock(stockChain([openverse(answering(OPENVERSE), dir), commons(answering(COMMONS_VIDEOS), dir)]), 'documentary', () => {});
    expect(film.clips).toBe(true);
    const clip = await film.clip({ query: 'a busy bakery at dawn', shape: 'wide', seconds: 4 });
    expect(clip?.found.kind).toBe('video');
    expect(clip?.ext).toBe('webm');
  });
  function failing(name: string, message: string): Stock {
    return { name, ready: () => null, async find() { throw new Error(message); }, async get() { throw new Error('no'); }, used: () => [] };
  }
});

describe('credits beside the film', () => {
  it('keeps Pexels lines under the Pexels heading and open-licence lines under their own, each naming its licence', () => {
    const text = photoCredits([
      'a desk by Ana on Pexels — https://www.pexels.com/photo/1',
      '"Oven" by Ermell · CC BY 4.0 · Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Oven.jpg',
      '"Oven" by Ermell · CC BY 4.0 · Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Oven.jpg',
    ]);
    expect(text).toBe([
      'Photographs (Pexels, free to use: https://www.pexels.com/license/):',
      '- a desk by Ana on Pexels — https://www.pexels.com/photo/1',
      '',
      'Photographs and footage (Openverse and Wikimedia Commons, each under the licence its line names):',
      '- "Oven" by Ermell · CC BY 4.0 · Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Oven.jpg',
    ].join('\n'));
  });
});

describe('FLUX.1 Krea', () => {
  it('is listed after Z-Image, and goes first when the prompt asks for a photograph', () => {
    expect(pictureSpaces.map((one) => one.name).slice(0, 2)).toEqual(['Z-Image Turbo', 'FLUX.1 Krea']);
    const krea = pictureSpaces[1];
    expect(krea).toMatchObject({ space: 'black-forest-labs/FLUX.1-Krea-dev', endpoint: '/infer', look: 'photo' });
    expect(krea.params).toMatchObject({ guidance_scale: 4.5, num_inference_steps: 28, width: '$width', height: '$height' });
    expect(spacesFor('a documentary photograph of a baker')[0].name).toBe('FLUX.1 Krea');
    expect(spacesFor('a flat illustration of a baker')[0].name).toBe('Z-Image Turbo');
  });
});
