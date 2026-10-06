import { digestOf } from './hash.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { missedClip, NONE_ANSWERED, peopleIn, pexels, remember, served, type Found, type Stock, type StockKind } from './stock.ts';
import { nounsOf, numberish } from './visuals.ts';

// Real photographs and real footage with no key at all.
//
// Pexels needs a key, and a founder who has not made one used to get a film of drawn pictures only. Two libraries
// answer without one. Openverse searches the openly licensed pictures of the whole web (Flickr, museums, Commons)
// and says, for each, who made it and the exact credit line its licence asks for; anonymously it allows twenty
// searches a minute and two hundred a day. Wikimedia Commons is the same kind of pool, asks only for a polite
// User-Agent, and also holds video. So a film with no key asks Openverse, then Commons, then draws.
//
// Only three licences are taken: CC0, the public domain mark, and CC BY. Share-alike is left out on purpose,
// because it would bind the whole film to the same licence; non-commercial and no-derivatives forbid what a film
// is. CC BY asks for a credit, so every picture taken carries its credit line, and the line goes into the credits
// file beside the film with the Pexels ones (`photoCredits`).

const AGENT = 'CubicleStudio/1.0 (a founder film studio; every file used is credited with its licence)';
// The smallest picture worth putting on a 1080p screen, and the smallest moving footage.
export const MIN_PHOTO = 1600;
export const MIN_CLIP = 720;
export const MAX_CLIP_SECONDS = 90;

// --- the words a library is asked --------------------------------------------------------------------------
//
// An open library is a keyword search over titles and tags, not a reader of sentences. "Growth that compounds while
// you sleep" brings back junk; "bakery" brings back bakeries. So a scene's words are cut to the one or two things it
// names, and anything that is a feeling, a quality or a plan rather than a thing is dropped.
const ABSTRACT = new Set(['growth', 'success', 'future', 'innovation', 'strategy', 'idea', 'ideas', 'solution', 'solutions',
  'value', 'journey', 'vision', 'mission', 'progress', 'change', 'problem', 'problems', 'opportunity', 'impact', 'time',
  'way', 'ways', 'thing', 'things', 'lot', 'kind', 'part', 'moment', 'today', 'tomorrow', 'yesterday', 'year', 'years',
  'day', 'days', 'week', 'month', 'minute', 'minutes', 'hour', 'hours', 'second', 'seconds', 'step', 'steps', 'result',
  'results', 'goal', 'goals', 'plan', 'plans', 'reason', 'point', 'fact', 'truth', 'power', 'freedom', 'trust', 'love',
  'fear', 'hope', 'dream', 'dreams', 'help', 'better', 'best', 'fast', 'faster', 'easy', 'easier', 'simple', 'smart',
  'modern', 'quick', 'quickly', 'soft', 'light', 'morning', 'evening', 'warm', 'cold', 'calm', 'shot', 'close', 'wide',
  'photo', 'photograph', 'picture', 'image', 'composition', 'cinematic', 'style', 'look', 'scene', 'view', 'mood',
  // The small words and the verbs a slogan is made of, which a title search reads as things.
  'while', 'until', 'because', 'since', 'after', 'before', 'during', 'between', 'every', 'once', 'never', 'together',
  'compound', 'compounds', 'sleep', 'sleeps', 'grow', 'grows', 'scale', 'scales', 'win', 'wins', 'lose', 'loses', 'matter',
  'matters', 'happen', 'happens', 'feel', 'feels', 'think', 'thinks', 'believe', 'start', 'starts', 'stop', 'stops', 'move',
  'moves', 'save', 'saves', 'pay', 'pays', 'cost', 'costs', 'sell', 'sells', 'buy', 'buys', 'build', 'builds', 'launch',
  'launches', 'ships', 'grew', 'win', 'means', 'mean', 'meet', 'meets', 'stay', 'stays', 'come', 'comes', 'goes', 'go']);
const ABSTRACT_ENDING = /(?:ness|ity|ism|ment|tion|sion|ance|ence|ship|ful|ous|ive|ize|ise)$/;
const CONCRETE_ANYWAY = new Set(['station', 'television', 'mansion', 'apartment', 'equipment', 'monument', 'instrument', 'house']);

export function queryOf(brief: string, most = 2): string {
  const nouns = nounsOf(brief ?? '')
    .filter((word) => !numberish(word) && !ABSTRACT.has(word) && (CONCRETE_ANYWAY.has(word) || !ABSTRACT_ENDING.test(word)));
  return nouns.slice(0, most).join(' ');
}

// --- licences ------------------------------------------------------------------------------------------------

export type Licence = { ok: boolean; name: string };
// Read off the short name a library gives. Anything not plainly CC0, public domain or CC BY (with no SA, NC or ND
// after it) is refused, including the GFDL and anything unknown.
export function licenceOf(short: string): Licence {
  const name = (short ?? '').replace(/<[^>]*>/g, '').trim();
  if (/^cc0\b|^cc[- ]zero\b/i.test(name)) return { ok: true, name: 'CC0' };
  if (/^(public domain|pd\b|pdm\b|pd-)/i.test(name)) return { ok: true, name: 'Public domain' };
  const by = name.match(/^cc[- ]by(?:[- ]([a-z-]+))?(?:[- ]([\d.]+))?/i);
  if (by) {
    if (by[1] && /sa|nc|nd/i.test(by[1])) return { ok: false, name };
    return { ok: true, name: `CC BY${by[2] ? ` ${by[2]}` : ''}` };
  }
  return { ok: false, name };
}

// The words of a page with its markup taken off, which is how Commons hands over an author's name.
// A part the page hides is not part of the name: Commons writes an unnamed author as "Unknown author", then again
// in a hidden span, then "or not provided", which read in full as "by Unknown author Unknown author or not provided".
export const plainText = (html: string): string => (html ?? '')
  .replace(/<(\w+)[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

// One credit line, the way CC BY asks for it: the work, its maker, the licence, and where it lives.
export const creditLine = (one: { title: string; by: string; licence: string; page: string; source: string }): string =>
  `"${one.title || 'untitled'}" by ${one.by || 'an unknown author'} · ${one.licence} · ${one.source} — ${one.page}`;

const wantsShape = (shape: string | undefined, width: number, height: number): boolean =>
  shape === 'tall' ? height > width : shape === 'square' ? Math.abs(width - height) / Math.max(width, height) < 0.2 : width > height;
const bigEnough = (kind: StockKind, width: number, height: number): boolean =>
  kind === 'video' ? Math.min(width, height) >= MIN_CLIP : Math.max(width, height) >= MIN_PHOTO;

// --- a day's allowance, counted --------------------------------------------------------------------------------
//
// Openverse lets an anonymous caller ask twenty times a minute and two hundred times a day. Each search is counted
// in a small file beside the cache, and the counts Openverse sends back in its headers win over ours. When either
// is spent, the asking stops and Commons is asked instead, and the founder is told once.
//
// One film is also held to eight searches of its own (`OPENVERSE_PER_FILM`). A nine-shot film asked a query and then
// its first word alone for every shot, spent the whole minute by itself, and every picture after that was drawn.
export const OPENVERSE_DAY = 200;
export const OPENVERSE_MINUTE = 20;
export const OPENVERSE_PER_FILM = 8;
// How long a search waits for a free slot in the minute before Commons is asked instead.
export const OPENVERSE_WAIT = 20_000;
export const OPENVERSE_SPENT = "today's two hundred free Openverse searches are used up, so photographs come from Wikimedia Commons until tomorrow";
export const OPENVERSE_BUSY = "Openverse allows twenty searches a minute and they are spent, so the rest of this film's photographs come from Wikimedia Commons";
export const OPENVERSE_FILM = "this film has used up its eight Openverse searches, so the rest of its photographs come from Wikimedia Commons";
type Count = { day: string; used: number; minute: number[]; left?: number; burst?: number; burstAt?: number };
export function allowance(file: string | null, now: () => number = Date.now) {
  const today = () => new Date(now()).toISOString().slice(0, 10);
  let held: Count | null = null;
  const load = async (): Promise<Count> => {
    if (!held) held = file ? await readFile(file, 'utf8').then((raw) => JSON.parse(raw) as Count).catch(() => null) : null;
    if (!held || held.day !== today()) held = { day: today(), used: 0, minute: [] };
    held.minute = held.minute.filter((at) => now() - at < 60_000);
    // What Openverse said was left of the minute holds for that minute only.
    if (held.burstAt !== undefined && now() - held.burstAt >= 60_000) { held.burst = undefined; held.burstAt = undefined; }
    return held;
  };
  const save = async () => { if (file && held) await writeFile(file, JSON.stringify(held)).catch(() => {}); };
  return {
    // The reason no search may be made now, or null.
    async blocked(): Promise<string | null> {
      const count = await load();
      if (count.used >= OPENVERSE_DAY || count.left === 0) return OPENVERSE_SPENT;
      if (count.minute.length >= OPENVERSE_MINUTE || count.burst === 0) return OPENVERSE_BUSY;
      return null;
    },
    // How long until the minute has room for one more search: 0 when it has room now. Openverse's own count of the
    // minute wins over ours, the same as for the day.
    async room(): Promise<number> {
      const count = await load();
      const ours = count.minute.length >= OPENVERSE_MINUTE ? count.minute[0] + 60_000 - now() : 0;
      const theirs = count.burst === 0 && count.burstAt !== undefined ? count.burstAt + 60_000 - now() : 0;
      return Math.max(0, ours, theirs);
    },
    async spend(headers?: Headers) {
      const count = await load();
      count.used += 1;
      count.minute.push(now());
      const left = Number(headers?.get('x-ratelimit-available-anon_sustained') ?? NaN);
      if (Number.isFinite(left)) count.left = left;
      const burst = Number(headers?.get('x-ratelimit-available-anon_burst') ?? NaN);
      if (Number.isFinite(burst)) { count.burst = burst; count.burstAt = now(); }
      await save();
    },
    async spent(which: 'day' | 'minute') {
      const count = await load();
      if (which === 'day') count.left = 0; else count.minute = Array.from({ length: OPENVERSE_MINUTE }, () => now());
      await save();
    },
    async used(): Promise<{ used: number; left: number }> {
      const count = await load();
      return { used: count.used, left: count.left ?? Math.max(0, OPENVERSE_DAY - count.used) };
    },
  };
}

const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((done, fail) => {
  if (signal?.aborted) { fail(new Error('stopped')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); done(); }, ms);
  const stop = () => { clearTimeout(timer); fail(new Error('stopped')); };
  signal?.addEventListener('abort', stop, { once: true });
});

// --- fetching a file once ----------------------------------------------------------------------------------------

const extOf = (one: Found): string => {
  const path = one.url.split('?')[0].toLowerCase();
  const ext = path.slice(path.lastIndexOf('.') + 1);
  if (one.kind === 'video') return ['webm', 'ogv', 'mp4', 'mov'].includes(ext) ? ext : 'webm';
  return ext === 'png' ? 'png' : 'jpg';
};
function keeper(dir: string, http: typeof fetch, taken: Found[]) {
  return async (one: Found, signal?: AbortSignal): Promise<{ ext: string; bytes: Buffer }> => {
    await mkdir(dir, { recursive: true }).catch(() => {});
    const ext = extOf(one);
    const file = join(dir, `${digestOf(one.id, 24)}.${ext}`);
    const held = await readFile(file).catch(() => null);
    if (held?.length) { if (!taken.some((other) => other.id === one.id)) taken.push(one); await served(dir, one); return { ext, bytes: held }; }
    const answer = await http(one.url, { headers: { 'user-agent': AGENT }, signal });
    if (!answer.ok) throw new Error(`that ${one.kind === 'video' ? 'clip' : 'photograph'} could not be fetched (${answer.status})`);
    const bytes = Buffer.from(await answer.arrayBuffer());
    await writeFile(file, bytes).catch(() => {});
    await remember(dir, one);
    await served(dir, one);
    taken.push(one);
    return { ext, bytes };
  };
}

// --- Openverse ----------------------------------------------------------------------------------------------------

// `film()` is one film's own view of it: at most eight searches, a query it has already asked answered from what came
// back the first time (the film's topic is asked for shot after shot), and a full minute waited out for up to twenty
// seconds rather than spent. The same library with no film around it (a probe, a test) has no cap of its own.
export function openverse(http: typeof fetch = fetch, dir = '.cache/stock', now: () => number = Date.now,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = pause): Stock {
  const taken: Found[] = [];
  const count = allowance(join(dir, 'openverse-count.json'), now);
  const view = (film?: { asked: number; seen: Map<string, Found[]> }): Stock => ({
    name: 'Openverse',
    ready: () => null,
    film: () => view({ asked: 0, seen: new Map() }),
    async find(want, signal) {
      // Openverse holds pictures and sound, not footage.
      if ((want.kind ?? 'photo') === 'video') return [];
      const query = queryOf(want.query);
      if (!query) return [];
      const key = `${query}|${want.shape ?? ''}|${want.many ?? 8}`;
      const before = film?.seen.get(key);
      if (before) return before;
      if (film && film.asked >= OPENVERSE_PER_FILM) throw new Error(OPENVERSE_FILM);
      const full = await count.room();
      if (full > 0 && full <= OPENVERSE_WAIT) await wait(full, signal);
      const blocked = await count.blocked();
      if (blocked) throw new Error(blocked);
      if (film) film.asked += 1;
      const aspect = want.shape === 'tall' ? 'tall' : want.shape === 'square' ? 'square' : 'wide';
      const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license=cc0,pdm,by&aspect_ratio=${aspect}&size=large&mature=false&page_size=20`;
      await mkdir(dir, { recursive: true }).catch(() => {});
      const answer = await http(url, { headers: { 'user-agent': AGENT, accept: 'application/json' }, signal });
      if (answer.status === 429) {
        const daily = /sustained|day/i.test(`${answer.headers.get('retry-after') ?? ''} ${await answer.text().catch(() => '')}`) || Number(answer.headers.get('retry-after') ?? 0) > 120;
        await count.spent(daily ? 'day' : 'minute');
        throw new Error(daily ? OPENVERSE_SPENT : OPENVERSE_BUSY);
      }
      await count.spend(answer.headers);
      if (!answer.ok) throw new Error(`Openverse answered ${answer.status}`);
      const said = (await answer.json()) as { results?: Record<string, unknown>[] };
      const found = (said.results ?? []).flatMap((item): Found[] => {
        const licence = licenceOf(`${String(item.license ?? '') === 'by' ? 'CC BY' : String(item.license ?? '')} ${String(item.license_version ?? '')}`.trim());
        const width = Number(item.width ?? 0);
        const height = Number(item.height ?? 0);
        const filetype = String(item.filetype ?? '').toLowerCase() || String(item.url ?? '').split('?')[0].split('.').pop()!.toLowerCase();
        if (!licence.ok || !item.url || !item.id) return [];
        if (['svg', 'gif', 'pdf', 'tif', 'tiff'].includes(filetype)) return [];
        if (!bigEnough('photo', width, height) || !wantsShape(want.shape, width, height)) return [];
        const title = String(item.title ?? '').trim();
        const tags = Array.isArray(item.tags) ? (item.tags as { name?: string }[]).map((tag) => tag?.name ?? '').filter(Boolean).slice(0, 12).join(' ') : '';
        const page = String(item.foreign_landing_url ?? '').trim();
        const by = String(item.creator ?? '').trim();
        // Openverse writes the credit itself. The sentence pointing at the licence text is kept to the licence's link.
        const attribution = String(item.attribution ?? '').replace(/\s*To view (a copy of )?(this license|the terms).*$/i, '').trim();
        const licenceUrl = String(item.license_url ?? '').trim();
        const credit = attribution
          ? `${attribution}${licenceUrl ? ` (${licenceUrl})` : ''} · Openverse — ${page}`
          : creditLine({ title, by, licence: licence.name, page, source: 'Openverse' });
        return [{
          id: `openverse-photo-${String(item.id)}`, kind: 'photo', url: String(item.url), page, width, height,
          by, byUrl: String(item.creator_url ?? ''), licence: licence.name, what: `${title} ${tags}`.trim(),
          people: peopleIn(`${title} ${tags}`), credit,
        }];
      }).slice(0, want.many ?? 8);
      film?.seen.set(key, found);
      return found;
    },
    get: keeper(dir, http, taken),
    used: () => [...taken],
  });
  return view();
}

// --- Wikimedia Commons ----------------------------------------------------------------------------------------------

type Meta = Record<string, { value?: unknown } | undefined>;
const metaOf = (meta: Meta | undefined, key: string): string => plainText(String(meta?.[key]?.value ?? ''));

export function commons(http: typeof fetch = fetch, dir = '.cache/stock'): Stock {
  const taken: Found[] = [];
  return {
    name: 'Wikimedia Commons',
    moving: true,
    ready: () => null,
    async find(want, signal) {
      const query = queryOf(want.query);
      if (!query) return [];
      const kind: StockKind = want.kind ?? 'photo';
      const info = kind === 'video' ? 'videoinfo' : 'imageinfo';
      const short = kind === 'video' ? 'vi' : 'ii';
      const params = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrnamespace: '6', gsrlimit: '40',
        gsrsearch: `${query} filetype:${kind === 'video' ? 'video' : 'bitmap'}`, prop: info,
        [`${short}prop`]: kind === 'video' ? 'url|size|mime|derivatives|extmetadata' : 'url|size|mime|extmetadata',
        [`${short}extmetadatafilter`]: 'Artist|LicenseShortName|ImageDescription|ObjectName',
        ...(kind === 'photo' ? { iiurlwidth: '1920' } : {}),
      });
      const answer = await http(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { 'user-agent': AGENT, accept: 'application/json' }, signal });
      if (!answer.ok) throw new Error(`Wikimedia Commons answered ${answer.status}`);
      const said = (await answer.json()) as { query?: { pages?: Record<string, unknown>[] }; error?: { info?: string } };
      if (said.error) throw new Error(`Wikimedia Commons said: ${String(said.error.info ?? 'no').slice(0, 120)}`);
      const pages = [...(said.query?.pages ?? [])].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
      return pages.flatMap((page): Found[] => {
        const item = ((page[info] as Record<string, unknown>[] | undefined) ?? [])[0];
        if (!item) return [];
        const meta = item.extmetadata as Meta | undefined;
        const licence = licenceOf(metaOf(meta, 'LicenseShortName'));
        if (!licence.ok) return [];
        const mime = String(item.mime ?? '').toLowerCase();
        const width = Number(item.width ?? 0);
        const height = Number(item.height ?? 0);
        const title = metaOf(meta, 'ObjectName') || String(page.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
        // An author Commons does not know is no author; the credit says "an unknown author" in its own words.
        const by = metaOf(meta, 'Artist').replace(/^unknown author\b.*$/i, '').slice(0, 120);
        const pageUrl = String(item.descriptionurl ?? '');
        const what = `${title} ${metaOf(meta, 'ImageDescription').slice(0, 200)}`.trim();
        const common = {
          page: pageUrl, by, byUrl: '', licence: licence.name, what, people: peopleIn(what),
          credit: creditLine({ title, by, licence: licence.name, page: pageUrl, source: 'Wikimedia Commons' }),
        };
        if (kind === 'photo') {
          if (!/^image\/(jpeg|png|webp|tiff)$/.test(mime)) return [];
          if (!bigEnough('photo', width, height) || !wantsShape(want.shape, width, height)) return [];
          const url = String(item.thumburl ?? item.url ?? '');
          if (!url) return [];
          return [{ id: `commons-photo-${String(page.pageid ?? title)}`, kind, url, width, height, ...common }];
        }
        // Footage: the 1080p or 720p VP9 copy Commons transcodes when there is one, else the original if it is big
        // enough. Either is cut to the film's frame by ffmpeg afterwards.
        // A long film is hundreds of megabytes for four seconds of use, so only short footage is taken.
        const seconds = Number(item.duration ?? 0);
        // Any shape of footage will do: it is cut to the film's own frame afterwards, and a square or tall film asking
        // only for square or tall footage found none at all on Commons, where nearly everything is wide.
        if (!(seconds >= 3 && seconds <= MAX_CLIP_SECONDS)) return [];
        const copies = (Array.isArray(item.derivatives) ? item.derivatives as Record<string, unknown>[] : [])
          .filter((one) => /vp9\.webm$/.test(String(one.transcodekey ?? '')) && Math.min(Number(one.width ?? 0), Number(one.height ?? 0)) >= MIN_CLIP)
          .sort((a, b) => Math.min(Number(b.width), Number(b.height)) - Math.min(Number(a.width), Number(a.height)));
        const best = copies.find((one) => Math.min(Number(one.width), Number(one.height)) <= 1080) ?? copies.at(-1);
        const original = bigEnough('video', width, height) && /webm|ogg|ogv|mp4/.test(mime) ? { src: item.url, width, height } : undefined;
        const use = best ?? original;
        if (!use?.src) return [];
        return [{
          id: `commons-video-${String(page.pageid ?? title)}`, kind, url: String(use.src),
          width: Number(use.width ?? width), height: Number(use.height ?? height), seconds: Number(item.duration ?? 0), ...common,
        }];
      }).slice(0, want.many ?? 8);
    },
    get: keeper(dir, http, taken),
    used: () => [...taken],
  };
}

// --- one library out of several -------------------------------------------------------------------------------------
//
// The libraries are asked in order, and the first that brings anything back wins. One that is spent for the day or
// the minute, or one that refuses a key, is set aside for the rest of the film and the founder is told once; one
// that merely errored is passed over this time. If none of them answers, the error says so in plain words and the
// film draws the picture.
//
// `film()` is the same chain for one film: a library set aside is set aside for that film, not for every film after
// it, and each library hands over its own film's view (Openverse's eight searches).
export function stockChain(sources: Stock[]): Stock {
  const resting = new Set<string>();
  const lines: string[] = [];
  const owner = new Map<string, Stock>();
  const live = () => sources.filter((one) => !one.ready() && !resting.has(one.name));
  const tell = (line: string) => { if (line && !lines.includes(line)) lines.push(line); };
  const ask = async (want: Parameters<Stock['find']>[0], signal?: AbortSignal): Promise<{ found: Found[]; failed: string[] }> => {
    const failed: string[] = [];
    for (const source of live()) {
      if (want.kind === 'video' && !source.moving) continue;
      try {
        const found = await source.find(want, signal);
        for (const one of found) owner.set(one.id, source);
        if (found.length) return { found, failed };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        failed.push(`${source.name}: ${message}`);
        if (/used up|twenty searches a minute|\b429\b|answered (401|403)\b/.test(message)) {
          resting.add(source.name);
          tell(!/answered (401|403)\b/.test(message) ? message
            : source.name === 'pexels' ? 'PEXELS_API_KEY in .env was not accepted by Pexels, so photographs come from the free open libraries instead'
            : `${source.name} refused this machine (${message.match(/(401|403)/)![1]}), so it is not asked again for this film`);
        }
      }
    }
    return { found: [], failed };
  };
  return {
    name: sources.map((one) => one.name).join(' → '),
    moving: sources.some((one) => one.moving),
    ready: () => (sources.some((one) => !one.ready()) ? null : sources[0]?.ready() ?? 'no photograph library is set up'),
    async find(want, signal) {
      let { found, failed } = await ask(want, signal);
      // Two things named and nothing found: the first of them alone usually is.
      const first = queryOf(want.query, 1);
      if (!found.length && first && first !== queryOf(want.query)) {
        const again = await ask({ ...want, query: first }, signal);
        found = again.found;
        failed = [...failed, ...again.failed];
      }
      if (!found.length && failed.length && !live().length) throw new Error(`${NONE_ANSWERED} (${failed.join('; ')}), so the rest of the pictures are drawn`);
      if (!found.length && failed.length) throw new Error(`${NONE_ANSWERED} for this picture (${failed.join('; ').slice(0, 200)}), so it is drawn`);
      return found;
    },
    async get(one, signal) {
      const source = owner.get(one.id) ?? sources.find((each) => one.id.startsWith(each.name.toLowerCase().split(' ')[0]));
      if (!source) throw new Error('that photograph came from no library this film asked');
      return source.get(one, signal);
    },
    used: () => sources.flatMap((one) => one.used()),
    film: () => stockChain(sources.map((one) => one.film?.() ?? one)),
    heard: () => lines.splice(0),
    footageFrom: () => live().filter((one) => one.moving).map((one) => (one.name === 'pexels' ? 'Pexels' : one.name)),
  };
}

// The library a film gets: Pexels first when the founder has a key, then the two that need none.
export function photoLibrary(env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch, dir = '.cache/stock'): Stock {
  const free = [openverse(http, dir), commons(http, dir)];
  const chain = stockChain(env.PEXELS_API_KEY?.trim() ? [pexels(env, http, dir), ...free] : free);
  const noClip = () => missedClip(dir);
  return { ...chain, noClip, film: () => ({ ...chain.film!(), noClip }) };
}
