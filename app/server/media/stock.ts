import { digestOf } from './hash.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Real photographs, from people who took them.
//
// Everything else in this studio draws its pictures. A drawn picture is always of something that has never
// existed, and for half the shots in a film that is exactly right — but a film about a real trade, shot entirely
// out of a picture model, has the look the research calls "generic footage that could illustrate any sentence".
// A real photograph of a real thing is the cheapest fix there is, and there is a free one.
//
// Pexels, then. A free key from pexels.com/api, two hundred requests an hour, and a licence that says in as many
// words: free to use, attribution not required, modification allowed. What it forbids is selling an unaltered copy
// and redistributing the library — a film that cuts a photograph into a timeline with type, a voice and music over
// it is neither. Their API guidelines ask for a prominent link back and for the photographer to be credited where
// possible, so every picture this brings back carries its author and the page it came from, and the card shows
// them. The film itself carries no credit, because the licence does not ask for one.
//
// Two clauses decide how a person in a photograph may be used, and they are not negotiable: an identifiable person
// may not appear in a bad light, and nothing may imply that they endorse a product. So a photograph of a person is
// b-roll and nothing else — never "the speaker", never beside a claim about a named product. `broll` below is
// where that is enforced rather than remembered.

export const PEXELS_HINT = 'No stock photographs are set up. The founder gets a free key from pexels.com/api — it takes a minute and costs nothing — '
  + 'puts PEXELS_API_KEY in .env and restarts the app. Without it the film draws every picture instead.';

export const LICENCE = 'https://www.pexels.com/license/';

export type StockKind = 'photo' | 'video';

// One photograph or clip, with everything needed to use it and everything needed to defend using it.
export type Found = {
  id: string; kind: StockKind;
  // Where the file itself is, and where a person would go to look at it.
  url: string; page: string;
  width: number; height: number;
  by: string; byUrl: string;
  licence: string;
  // What the photographer said it is, which is the only description anybody has.
  what: string;
  // Whether there is an identifiable person in it. A picture with one is b-roll and never the film's speaker.
  people: boolean;
  seconds?: number;
  // The credit line itself, for a library whose licence asks for one in its own words (CC BY on Openverse and
  // Wikimedia Commons). A Pexels picture leaves it out and is credited the Pexels way.
  credit?: string;
};

export type Stock = {
  name: string;
  ready(): string | null;
  find(ask: { query: string; kind?: StockKind; shape?: string; many?: number }, signal?: AbortSignal): Promise<Found[]>;
  // The file, cached on disk under a name made out of its id, so the same photograph is fetched once.
  get(one: Found, signal?: AbortSignal): Promise<{ ext: string; bytes: Buffer }>;
  // Everything this film has used, for the card: the photographer and the page, in order.
  used(): Found[];
  // What the library has to say since it was last asked: a day's free searches spent, a source that did not answer
  // and the next one tried. A film says each of these once.
  heard?(): string[];
  // Whether it has moving footage as well as photographs.
  moving?: boolean;
};

// A photographer's name and the page their picture lives on, said the way a credit is said.
export const creditOf = (one: Found): string => one.credit ?? `${one.what || 'photograph'} by ${one.by} on Pexels — ${one.page}`;

// The photographs a film shows, one line each, said once however many shots share one. It goes in the credits file
// beside the film and beside every version remade from it.
// A picture or clip from Openverse or Wikimedia Commons names its own licence in its line, because CC BY asks for
// exactly that: the work, who made it, the licence and where it lives.
export const photoCredits = (credits: (string | undefined)[]): string => {
  const each = [...new Set(credits.filter((one): one is string => !!one))];
  const pexels = each.filter((one) => / on Pexels — /.test(one));
  const open = each.filter((one) => !/ on Pexels — /.test(one));
  return [
    ...(pexels.length ? [[`Photographs (Pexels, free to use: ${LICENCE}):`, ...pexels.map((one) => `- ${one}`)].join('\n')] : []),
    ...(open.length ? [['Photographs and footage (Openverse and Wikimedia Commons, each under the licence its line names):', ...open.map((one) => `- ${one}`)].join('\n')] : []),
  ].join('\n\n');
};

// What a failed search or fetch means for the rest of the film. A spent hour stops the asking for this film and is
// said, so the founder knows why the rest went back to drawing. A key Pexels refuses is the founder's to fix and is
// said once, loudly, because otherwise every film draws every picture and nobody knows why. An ordinary miss — a
// 404, a network blip — is just this one picture, and the next scene may land.
export const PEXELS_REFUSED = 'PEXELS_API_KEY in .env was not accepted by Pexels, so the film is drawing every picture instead of photographing them.';
export const NONE_ANSWERED = 'no free photograph library answered';
export function trouble(error: unknown): { say: string; stop: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  if (message === PEXELS_HINT) return { say: '', stop: true };
  if (/used up/i.test(message) || /\b429\b/.test(message)) return { say: message, stop: true };
  // Only the search itself carries the key. A 403 on fetching one photograph is the picture's CDN saying no to that
  // one file, not Pexels refusing the founder's key.
  if (/stock library answered (401|403)\b/.test(message)) return { say: PEXELS_REFUSED, stop: true };
  // Every free library tried and none answered: said once, and the picture is drawn. The next scene asks again,
  // because a library that blinked for one search is usually back for the next.
  if (message.startsWith(NONE_ANSWERED)) return { say: message, stop: false };
  return { say: '', stop: false };
}

// Which looks a real photograph can sit inside. Every pack is photographic except `sketch`, which is line work.
export const photographable = (pack: string): boolean => pack !== 'sketch';

// One film's use of the library, kept out of the film's long loop so what a founder hears can be tested. It asks for
// a photograph only where one can sit (`photographable`), only while there is a key, and only until the key is
// refused or the hour is spent; each of those is said once, and every miss comes back as null so the film draws that
// picture instead. It never throws: a library that is optional by design is never the reason a film fails.
export type FilmStock = {
  // True when this film would have used photographs and cannot, because no key is set. The film says so once.
  missing: boolean;
  // True when the library can be asked for real moving footage too (Wikimedia Commons, or Pexels with a key).
  clips: boolean;
  take(ask: { query: string; shape?: string; speaker?: boolean; names?: string[]; fits?: (one: Found) => boolean }, signal?: AbortSignal):
    Promise<{ found: Found; ext: string; bytes: Buffer } | null>;
  // A few seconds of real footage of the scene's own things, or null. Same rules as a photograph: never the speaker,
  // never beside a named product's claim.
  clip(ask: { query: string; shape?: string; speaker?: boolean; names?: string[]; seconds?: number }, signal?: AbortSignal):
    Promise<{ found: Found; ext: string; bytes: Buffer } | null>;
};
export function filmStock(stock: Stock | undefined, pack: string, report: (line: string) => void): FilmStock {
  const on = !!stock && photographable(pack);
  let troubled = false;
  const said = new Set<string>();
  const say = (line: string) => { if (line && !said.has(line)) { said.add(line); report(line); } };
  const hear = () => { for (const line of stock?.heard?.() ?? []) say(line); };
  const one = async (kind: StockKind, ask: { query: string; shape?: string; speaker?: boolean; names?: string[]; fits?: (one: Found) => boolean; seconds?: number }, signal?: AbortSignal) => {
    if (!on || stock!.ready() || troubled || signal?.aborted) return null;
    try {
      const found = broll(await stock!.find({ query: ask.query, kind, shape: ask.shape, many: 6 }, signal),
        { speaker: ask.speaker, names: ask.names })
        .filter((one) => !ask.fits || ask.fits(one))
        .filter((one) => kind !== 'video' || !one.seconds || one.seconds >= Math.min(3, ask.seconds ?? 3));
      hear();
      if (!found.length) return null;
      const piece = await stock!.get(found[0], signal);
      return { found: found[0], ...piece };
    } catch (error) {
      hear();
      const { say: line, stop } = trouble(error);
      say(line);
      if (stop) troubled = true;
      return null;
    }
  };
  return {
    missing: on && !!stock!.ready(),
    clips: on && !stock!.ready() && !!stock!.moving,
    take: (ask, signal) => one('photo', ask, signal),
    clip: (ask, signal) => one('video', ask, signal),
  };
}

// The words that mean there is somebody in the picture. Read off what the photographer wrote, because that is the
// only description that exists without looking at the picture, and it is usually a fair one.
const SOMEBODY = /\b(man|woman|men|women|person|people|boy|girl|child|children|guy|lady|couple|family|crowd|portrait|face|hands?|model|worker|student|teacher|doctor|nurse|chef|group|team|he|she|his|her)\b/i;
export const peopleIn = (what: string): boolean => SOMEBODY.test(what ?? '');

// The photographs a film may actually use for a given moment. A picture with somebody in it is b-roll: it may
// illustrate a general point and it may never stand in for the film's own speaker, and it never sits under a
// claim about a named product, because both of those imply an endorsement nobody gave.
export function broll(found: Found[], about: { speaker?: boolean; names?: string[] } = {}): Found[] {
  const claims = (about.names ?? []).filter(Boolean).length > 0;
  return found.filter((one) => !one.people || (!about.speaker && !claims));
}

// Which orientation a film's shape asks for. A reel wants portrait; anything else takes what it is given.
const orientationOf = (shape?: string): string => (shape === 'tall' ? 'portrait' : shape === 'square' ? 'square' : 'landscape');

type Index = Record<string, { by: string; byUrl: string; page: string; licence: string; what: string; kind: StockKind; credit?: string }>;

// The one thing worth remembering between films: which picture came from whom. It is a plain JSON file beside the
// cached pictures, so a founder can read it, and so a licence question years from now has an answer.
export async function remember(dir: string, one: Found): Promise<void> {
  const file = join(dir, 'index.json');
  const held: Index = await readFile(file, 'utf8').then((raw) => JSON.parse(raw) as Index).catch(() => ({}));
  held[one.id] = { by: one.by, byUrl: one.byUrl, page: one.page, licence: one.licence, what: one.what, kind: one.kind, ...(one.credit ? { credit: one.credit } : {}) };
  await writeFile(file, `${JSON.stringify(held, null, 2)}\n`).catch(() => {});
}

// Which library served a picture, by the id it was given there.
export const libraryOf = (id: string): string =>
  id.startsWith('openverse-') ? 'Openverse' : id.startsWith('commons-') ? 'Wikimedia Commons' : id.startsWith('pexels-') ? 'Pexels' : 'another library';

// How many pictures and clips each library served today, kept beside the cached pictures so Health can say which
// library films really drew on — a row that said "drawn pictures only" while a film used two Openverse photographs.
export type Served = { day: string; by: Record<string, number> };
const servedFile = (dir: string) => join(dir, 'served.json');
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
export async function servedToday(dir: string, now = Date.now()): Promise<Record<string, number>> {
  const held = await readFile(servedFile(dir), 'utf8').then((raw) => JSON.parse(raw) as Served).catch(() => null);
  return held && held.day === today(now) ? held.by ?? {} : {};
}
export async function served(dir: string, one: Pick<Found, 'id'>, now = Date.now()): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => {});
  const by = await servedToday(dir, now);
  const name = libraryOf(one.id);
  by[name] = (by[name] ?? 0) + 1;
  await writeFile(servedFile(dir), JSON.stringify({ day: today(now), by } satisfies Served)).catch(() => {});
}

export function pexels(env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch, dir = '.cache/stock'): Stock {
  const key = env.PEXELS_API_KEY?.trim();
  const taken: Found[] = [];
  const ask = async (url: string, signal?: AbortSignal): Promise<unknown> => {
    const answer = await http(url, { headers: { Authorization: key ?? '' }, signal });
    if (answer.status === 429) throw new Error("this hour's two hundred free stock searches are used up; it comes back on the hour");
    if (!answer.ok) throw new Error(`the stock library answered ${answer.status}`);
    return answer.json();
  };
  return {
    name: 'pexels',
    moving: true,
    ready: () => (key ? null : PEXELS_HINT),
    async find(want, signal) {
      if (!key) throw new Error(PEXELS_HINT);
      const many = Math.min(24, Math.max(1, want.many ?? 8));
      const orientation = orientationOf(want.shape);
      const query = encodeURIComponent(want.query.slice(0, 120));
      const kind: StockKind = want.kind ?? 'photo';
      const url = kind === 'video'
        ? `https://api.pexels.com/videos/search?query=${query}&orientation=${orientation}&size=medium&per_page=${many}`
        : `https://api.pexels.com/v1/search?query=${query}&orientation=${orientation}&per_page=${many}`;
      const said = (await ask(url, signal)) as Record<string, unknown>;
      const list = Array.isArray(said.photos) ? said.photos : Array.isArray(said.videos) ? said.videos : [];
      return list.flatMap((one): Found[] => {
        const item = (one ?? {}) as Record<string, unknown>;
        const what = String(item.alt ?? '').trim();
        const by = String(item.photographer ?? (item.user as Record<string, unknown> | undefined)?.name ?? '').trim();
        const byUrl = String(item.photographer_url ?? (item.user as Record<string, unknown> | undefined)?.url ?? '').trim();
        const page = String(item.url ?? '').trim();
        const id = `pexels-${kind}-${String(item.id ?? '')}`;
        // A photograph's biggest usable file, or a clip's — Pexels nests the clip's files one level down.
        const file = kind === 'video'
          ? (Array.isArray(item.video_files) ? item.video_files as Record<string, unknown>[] : [])
            .filter((one) => String(one.file_type ?? '').includes('mp4'))
            .sort((a, b) => Number(b.width ?? 0) - Number(a.width ?? 0))[0]
          : ((item.src ?? {}) as Record<string, unknown>);
        const link = kind === 'video' ? String(file?.link ?? '') : String((file as Record<string, unknown>)?.large2x ?? (file as Record<string, unknown>)?.large ?? '');
        if (!link || !String(item.id ?? '')) return [];
        return [{
          id, kind, url: link, page, width: Number(item.width ?? file?.width ?? 0), height: Number(item.height ?? file?.height ?? 0),
          by, byUrl, licence: LICENCE, what, people: peopleIn(`${what} ${page}`),
          ...(kind === 'video' ? { seconds: Number(item.duration ?? 0) } : {}),
        }];
      });
    },
    async get(one, signal) {
      await mkdir(dir, { recursive: true }).catch(() => {});
      const ext = one.kind === 'video' ? 'mp4' : 'jpg';
      const file = join(dir, `${digestOf(one.id, 24)}.${ext}`);
      const held = await readFile(file).catch(() => null);
      if (held?.length) { if (!taken.some((other) => other.id === one.id)) taken.push(one); await served(dir, one); return { ext, bytes: held }; }
      const answer = await http(one.url, { signal });
      if (!answer.ok) throw new Error(`that photograph could not be fetched (${answer.status})`);
      const bytes = Buffer.from(await answer.arrayBuffer());
      await writeFile(file, bytes).catch(() => {});
      await remember(dir, one);
      await served(dir, one);
      taken.push(one);
      return { ext, bytes };
    },
    used: () => [...taken],
  };
}

// What the tests and a run with no key get: two photographs that are always there and never leave the machine.
export const fakeStock = (found: Found[] = []): Stock => {
  const taken: Found[] = [];
  const library: Found[] = found.length ? found : [
    { id: 'fake-1', kind: 'photo', url: 'file://one.jpg', page: 'https://www.pexels.com/photo/1/', width: 1200, height: 1800, by: 'A Photographer', byUrl: 'https://www.pexels.com/@one', licence: LICENCE, what: 'a bare table by a window', people: false },
    { id: 'fake-2', kind: 'photo', url: 'file://two.jpg', page: 'https://www.pexels.com/photo/2/', width: 1200, height: 1800, by: 'Another Photographer', byUrl: 'https://www.pexels.com/@two', licence: LICENCE, what: 'a woman walking past a wall', people: true },
  ];
  return {
    name: 'fake stock',
    moving: library.some((one) => one.kind === 'video'),
    ready: () => null,
    async find(want) { return library.filter((one) => !want.kind || one.kind === want.kind).slice(0, want.many ?? 8); },
    async get(one) { taken.push(one); return { ext: one.kind === 'video' ? 'mp4' : 'jpg', bytes: Buffer.from('a photograph') }; },
    used: () => [...taken],
  };
};
