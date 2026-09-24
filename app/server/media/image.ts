import { digestOf } from './hash.ts';
import { connectWithin } from './turns.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import type { Maker, Piece } from './jobs.ts';
import { localImages } from './local-image.ts';
// The Hugging Face client is loaded on first use, the way the clips backend loads it: a second, optional way of
// drawing must never be the reason the server will not start.
const gradio = () => import('@gradio/client');
import listed from './pictures.json' with { type: 'json' };

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT = 90_000;
export const SETUP_HINT = 'No picture maker is set up. The founder adds CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to .env — a free Cloudflare account covers hundreds of pictures a day — then restarts the app.';

// FLUX.1 schnell always draws a square, so the shape is asked for in the prompt. The older models Workers AI offers
// take a size instead, which is what a model set in STAGE_IMAGE_MODEL gets.
// `resolution` is the same shape said the way the Z-Image demo insists on hearing it — one of its own listed choices,
// spaces and brackets and all — because a Space with a fixed list of sizes refuses anything that is not on the list.
const SHAPES: Record<string, { words: string; width: number; height: number; resolution: string }> = {
  square: { words: '', width: 1024, height: 1024, resolution: '1024x1024 ( 1:1 )' },
  wide: { words: ', wide 16:9 composition', width: 1280, height: 768, resolution: '1280x720 ( 16:9 )' },
  tall: { words: ', tall 9:16 composition', width: 768, height: 1280, resolution: '720x1280 ( 9:16 )' },
};

// Workers AI answers either with the picture itself or, for FLUX, with base64 inside JSON.
export function pictureOf(body: Buffer, type: string): Piece {
  let bytes = body;
  if (type.includes('json')) {
    const image = (JSON.parse(body.toString('utf8')) as { result?: { image?: unknown } }).result?.image;
    if (typeof image !== 'string' || !image) throw new Error('no picture came back');
    bytes = Buffer.from(image, 'base64');
  }
  if (!bytes.length) throw new Error('no picture came back');
  // PNG and JPEG are the two it sends; the first byte says which.
  return { ext: bytes[0] === 0x89 ? 'png' : 'jpg', bytes };
}

// Cloudflare Workers AI, the one image model that is free and needs no card: 10,000 neurons a day, hundreds of pictures.
export function cloudflareImages(env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): Maker {
  const model = env.STAGE_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  const flux = model.includes('flux');
  return {
    name: 'Cloudflare',
    ready: () => (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID ? null : SETUP_HINT),
    async make(ask, { report, signal }) {
      const shape = SHAPES[String(ask.shape ?? 'square')] ?? SHAPES.square;
      report('drawing it…');
      const timeout = AbortSignal.timeout(TIMEOUT);
      const response = await http(`${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: `${ask.prompt}${flux ? shape.words : ''}`, ...(flux ? { steps: 4 } : { width: shape.width, height: shape.height }) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`Cloudflare answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return pictureOf(Buffer.from(await response.arrayBuffer()), response.headers.get('content-type') ?? '');
    },
  };
}

// The second way to draw, for the day the first has nothing left. Hugging Face lends a public demo a real GPU for the
// length of one call — a Space marked ZeroGPU — and anybody may ask, signed in or not. Unsigned, the daily allowance
// is small but it is real, which is exactly the point: when Cloudflare's neurons are spent at four in the afternoon,
// the film still gets its pictures. A read token in HF_TOKEN buys a bigger allowance, so it is passed when there is
// one and simply left out when there is not.
//
// A demo is someone else's to take down or rewrite overnight. `pictures.json` is therefore the whole list — which
// Space, which endpoint, which parameter takes which of our inputs — in the order they are tried, so a dead demo is a
// one-line edit and never a code change. Before every call the Space's own `/gradio_api/info` is read back and the
// parameter names checked against that line, so a demo that changed shape is skipped with a line saying which name
// went, rather than answering with something wrong.
const SLOTS = ['prompt', 'width', 'height', 'resolution', 'seed'] as const;
type Slot = (typeof SLOTS)[number];
export type Picture = { name: string; space: string; endpoint: string; params: Record<string, unknown> };
export const pictureSpaces = (listed as { pictures: Picture[] }).pictures;
// How a Space is reached, kept as its own seam so a test can stand in for one. It differs from the clips backend's in
// the one way that matters here: the token is optional, because drawing works without an account.
// What a picture Space is asked, narrowed to what is used here so a test can stand in for one. A clip watches its
// Space as a stream of notes because it takes minutes; a picture asks and waits, because it takes seconds and
// because a refusal reaches us only as a thrown error.
export type PictureApp = {
  view_api(): Promise<{ named_endpoints: Record<string, { parameters: { parameter_name: string }[] }> }>;
  predict(endpoint: string, args: Record<string, unknown>): Promise<{ data: unknown }>;
  close(): void;
};
export type PictureConnect = (space: string, options: { token?: `hf_${string}` }) => Promise<PictureApp>;
const CONNECT_TIMEOUT = 60_000;
// Said in words `outOfPictures` recognises, so the film stops asking instead of being refused scene by scene.
export const HF_SPENT = "today's free Hugging Face drawing quota is used up; it comes back in a few hours";

// Whatever a Space said went wrong, in one line the founder can act on.
export function plainly(message: unknown): string {
  const text = typeof message === 'string' ? message
    : Array.isArray(message) ? message.map((part) => (part as { message?: string })?.message ?? String(part)).join('; ')
    : message instanceof Error ? message.message : String(message ?? '');
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (/quota|exceed.{0,40}gpu|gpu.{0,40}(exceed|ran out|used up|limit)|\b429\b|too many requests/i.test(tidy)) return HF_SPENT;
  return tidy.slice(0, 200) || 'the Space answered with nothing';
}

// Gradio hands a picture back in a couple of shapes: the file on its own, or a gallery of files each in its own little
// envelope. Whichever it is, what is wanted is the first link.
export function pictureUrlOf(data: unknown): string | null {
  for (const item of Array.isArray(data) ? data : [data]) {
    if (!item || typeof item !== 'object') continue;
    const file = item as { url?: unknown; image?: unknown };
    if (typeof file.url === 'string' && file.url) return file.url;
    const inside = pictureUrlOf(file.image);
    if (inside) return inside;
  }
  return null;
}

// A link that belongs to Hugging Face itself is the only one our token is ever sent to.
const theirs = (url: string) => /^https?:\/\/[^/]*(hf\.space|huggingface\.co)(\/|$)/i.test(url);

export function huggingFaceImages(
  env: NodeJS.ProcessEnv = process.env,
  connect: PictureConnect = async (space, options) => (await gradio()).Client.connect(space, options) as unknown as Promise<PictureApp>,
  http: typeof fetch = fetch,
): Maker {
  const token = () => env.HF_TOKEN as `hf_${string}` | undefined;

  async function once(spot: Picture, have: Record<Slot, unknown>, help: { report: (line: string) => void; signal?: AbortSignal }): Promise<Piece> {
    if (help.signal?.aborted) throw new Error('stopped');
    help.report(`drawing it on ${spot.name}…`);
    const key = token();
    const app = await connectWithin(connect(spot.space, key ? { token: key } : {}), CONNECT_TIMEOUT);
    try {
      const args: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(spot.params)) {
        const filled = typeof value === 'string' && value.startsWith('$') && (SLOTS as readonly string[]).includes(value.slice(1))
          ? have[value.slice(1) as Slot] : value;
        if (filled !== undefined) args[name] = filled;
      }
      // Asking the demo what it takes, every time, turns a silently wrong picture into a line that names the Space and
      // the parameter that went — which is the whole edit to `pictures.json`.
      const endpoint = (await app.view_api()).named_endpoints[spot.endpoint];
      if (!endpoint) throw new Error(`the Space changed shape: ${spot.space} has no ${spot.endpoint} any more — pictures.json needs a new line`);
      const known = new Set(endpoint.parameters.map((one) => one.parameter_name));
      const gone = Object.keys(args).filter((name) => !known.has(name));
      if (gone.length) throw new Error(`the Space changed shape: ${spot.space} ${spot.endpoint} no longer takes ${gone.join(', ')} — pictures.json needs a new line`);
      // Asked for and waited on in one go, rather than watched as a stream of notes. A picture is seconds of work,
      // so there is no progress worth showing — and the stream is where the reason goes missing: a ZeroGPU Space
      // with nothing left today ends the stream with no notes at all, so a founder was told "the Space finished
      // without a picture" when what it really said was that the free allowance was spent and a token buys more.
      const answered = await app.predict(spot.endpoint, args).catch((error: unknown) => { throw new Error(plainly(error)); });
      if (help.signal?.aborted) throw new Error('stopped');
      const url = pictureUrlOf(answered?.data);
      if (!url) throw new Error('the Space finished without a picture');
      // The link a Space hands back lives for minutes, so the file is fetched the moment the call returns, not later.
      const timeout = AbortSignal.timeout(TIMEOUT);
      const answer = await http(url, {
        headers: key && theirs(url) ? { authorization: `Bearer ${key}` } : {},
        signal: help.signal ? AbortSignal.any([help.signal, timeout]) : timeout,
      });
      if (!answer.ok) throw new Error(`the picture could not be fetched back (${answer.status}) — these links last only minutes`);
      return pictureOf(Buffer.from(await answer.arrayBuffer()), answer.headers.get('content-type') ?? '');
    } finally {
      // Closing aborts the client's own stream, and the client raises that as an error nobody asked about. A
      // picture that arrived is not undone by a tidy-up, so the tidy-up is never allowed to be the failure.
      try { app.close(); } catch { /* the Space is finished with either way */ }
    }
  }

  return {
    name: 'Hugging Face',
    // Nothing for the founder to set up: the demos answer without an account, and a token only makes the day longer.
    ready: () => null,
    async make(ask, help) {
      const shape = SHAPES[String(ask.shape ?? 'square')] ?? SHAPES.square;
      const have: Record<Slot, unknown> = {
        prompt: String(ask.prompt ?? ''),
        width: shape.width,
        height: shape.height,
        resolution: shape.resolution,
        seed: Math.floor(Math.random() * 1_000_000),
      };
      const failures: string[] = [];
      for (const spot of pictureSpaces) {
        try {
          return await once(spot, have, help);
        } catch (error) {
          const why = plainly(error);
          // Every Space spends the same allowance, so once that is gone there is no second demo worth asking.
          if (why === HF_SPENT || help.signal?.aborted) throw new Error(why === HF_SPENT ? HF_SPENT : 'stopped');
          failures.push(`${spot.name}: ${why}`);
          help.report(`${spot.name} could not: ${why}`);
        }
      }
      throw new Error(failures.join('; ') || 'no Space is listed to draw with');
    },
  };
}

// Cloudflare first, because it is quick and its day is generous; Hugging Face second, because it is slower but it is
// still there when the first day is over.
// The order pictures are asked for in, and why. Cloudflare answers in four seconds, so it goes first while it has
// anything left. This machine is next: it takes a minute but it never runs out, which is the whole point — both
// free services ran dry inside one afternoon and a founder's film came out as coloured fog. The Hugging Face demos
// come last because they are somebody else's machine and their allowance is the smallest of the three.
//
// `STAGE_IMAGE_BACKEND` is the founder's override: `local` never leaves the house, `cloud` never uses the machine.
// Whether a picture might be drawn here, which is what a film needs to know before it tells the founder how long
// it will take: a minute a picture is worth saying out loud, four seconds is not.
export const mayDrawHere = (env: NodeJS.ProcessEnv = process.env): boolean =>
  imageMakers(env).some((one) => one.name === 'this computer' && !one.ready());
export const imageMakers = (env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): Maker[] => {
  const only = env.STAGE_IMAGE_BACKEND?.trim().toLowerCase();
  const here = localImages({ env, fetch: http });
  if (only === 'local') return [here];
  const away = [cloudflareImages(env, http), huggingFaceImages(env, undefined, http)];
  if (only === 'cloud') return away;
  return [away[0], here, away[1]];
};

// What a free daily quota is spent on, and what it is never spent on twice. A picture is filed under a hash of
// exactly what was asked for, so a founder who renders the same film again — after a line of narration changed, or
// after the app restarted — pays nothing for the pictures they already have. A cache that cannot be written to is
// not an error: the film is made either way.
// A draft is drawn smaller, so it is filed apart from the full-size picture of the same words. The size joins the
// name only when one was asked for, which leaves every picture already in the cache exactly where it was.
export const askedFor = (name: string, prompt: string, shape: unknown, size?: unknown): string =>
  digestOf(`${name}|${String(shape ?? '')}|${prompt}${typeof size === 'string' && size ? `|${size}` : ''}`, 32);
// The same, without who was asked to draw it. The maker's name is every backend set up today joined together, so a
// key added or a model fetched filed every picture anew and drew it again; a picture is what was asked for, not who
// happened to be asked. Pictures filed under the old key are still found there, and copied under the new one.
export const pictureKey = (prompt: string, shape: unknown, size?: unknown): string =>
  digestOf(`picture|${String(shape ?? '')}|${prompt}${typeof size === 'string' && size ? `|${size}` : ''}`, 32);
// Who drew a picture that nobody had to draw: said in `by`, so a film can count what its second run cost it.
export const DRAWN_BEFORE = 'drawn before';

export function cachedImages(maker: Maker, dir: string): Maker {
  return {
    name: maker.name,
    ready: maker.ready,
    next: maker.next ? () => maker.next!() : undefined,
    async make(ask, help): Promise<Piece> {
      const prompt = String(ask.prompt ?? '');
      // The stand-in pixel of the fake mode is filed apart, so it can never be handed to a real film.
      const file = join(dir, `${maker.name === fakeImages.name ? askedFor(maker.name, prompt, ask.shape, ask.size) : pictureKey(prompt, ask.shape, ask.size)}.img`);
      let held = await readFile(file).catch(() => null);
      if (!held?.length) {
        held = await readFile(join(dir, `${askedFor(maker.name, prompt, ask.shape, ask.size)}.img`)).catch(() => null);
        if (held?.length) await writeFile(file, held).catch(() => {});
      }
      if (held?.length) { help.report('drawn before, so it costs nothing'); return { ext: held[0] === 0x89 ? 'png' : 'jpg', bytes: held, by: DRAWN_BEFORE }; }
      const piece = await maker.make(ask, help);
      await mkdir(dir, { recursive: true }).then(() => writeFile(file, piece.bytes)).catch(() => { /* a cache is a kindness, not a requirement */ });
      return piece;
    },
  };
}

// Whether a picture service has said, in its own words, that there is nothing left today. There is no retrying
// past this and no point asking again for the next scene: the founder is told once and the film uses textures.
export const outOfPictures = (why: string): boolean =>
  /\b429\b|daily free allocation|quota|rate ?limit|too many requests/i.test(why);

// A picture that costs nothing and needs no network, for the checks and the fake-model mode.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const fakeImages: Maker = {
  name: 'fake',
  ready: () => null,
  async make(_ask, { report }) {
    report('drawing it…');
    return { ext: 'png', bytes: Buffer.from(PIXEL, 'base64') };
  },
};

// Several ways of drawing as one, tried in the order given. This exists because a free day ends: Cloudflare's ten
// thousand neurons go at some point in the afternoon and, until this, that was the end of pictures for the day.
//
// The one thing worth remembering between scenes is which backend has already said "nothing left today". A film is
// thirty scenes; being told the same thing thirty times, a minute apart, is the difference between a film that
// finishes and one that does not. So a backend that says it is spent is skipped for the rest of the day without
// being asked again, and the founder hears about it once, in a line that says what happens next.
export const firstImages = (...makers: Maker[]): Maker => firstOf(makers);

// Where "spent today" is kept between one run of the app and the next. A service finds out it is empty by being
// asked, and the app is restarted many times a day — so without this the first film after every restart told the
// founder "about two minutes" and then spent eight drawing on this computer. It is read once and written on the
// rare occasion something runs dry; a file that cannot be read or written changes nothing.
export type SpentKept = { read(): Record<string, { day: number; why: string }>; write(all: Record<string, { day: number; why: string }>): void };
export const spentFile = (file: string): SpentKept => ({
  read() { try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, { day: number; why: string }>; } catch { return {}; } },
  write(all) { try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(all)); } catch { /* remembered for this run only */ } },
});

export function firstOf(makers: Maker[], kept?: SpentKept): Maker {
  // Which backends have gone quiet, and on which day they did, so tomorrow starts clean without anyone restarting
  // anything. The day is the plain calendar-ish one a free quota resets on; near enough for "come back tomorrow".
  const today = () => Math.floor(Date.now() / 86_400_000);
  const spent = new Map<string, { day: number; why: string }>(Object.entries(kept?.read() ?? {}).filter(([, one]) => one?.day === today()));
  const hint = () => makers.map((one) => one.ready()).find(Boolean) ?? SETUP_HINT;
  let toldAllOut = -1;
  const allOut = (help: { report: (line: string) => void }) => {
    if (toldAllOut === today()) return;
    toldAllOut = today();
    help.report("today's free pictures are used up, so the scenes sit on textures instead — they come back tomorrow");
  };

  return {
    name: makers.map((one) => one.name).join(' then ') || 'nothing',
    // Ready while any one of them is ready; otherwise the first hint, which is the one the founder can act on.
    ready: () => (makers.some((one) => !one.ready()) ? null : hint()),
    // Which of them the next picture would be asked of: the first that is set up and has not said it is spent
    // today. It is what is known rather than what is certain — a service finds out it is empty by being asked.
    next: () => makers.find((one) => !one.ready() && spent.get(one.name)?.day !== today())?.name ?? null,
    async make(ask, help) {
      const day = today();
      const set = makers.filter((one) => !one.ready());
      if (!set.length) throw new Error(hint());
      const able = set.filter((one) => spent.get(one.name)?.day !== day);
      // Everything was already spent before this scene began: say so once, and hand on the service's own words so the
      // film knows to stop asking rather than treating it as one picture that went wrong.
      if (!able.length) {
        allOut(help);
        throw new Error(set.map((one) => spent.get(one.name)?.why).find(Boolean) ?? HF_SPENT);
      }
      const failures: string[] = [];
      for (const one of able) {
        try {
          // Whose picture it is, carried back so the card can say it rather than leaving the founder to guess why
          // one took four seconds and the next took a minute.
          return { ...await one.make(ask, help), by: one.name };
        } catch (error) {
          const why = (error as Error).message;
          if (help.signal?.aborted) throw error;
          if (outOfPictures(why)) {
            spent.set(one.name, { day, why });
            kept?.write(Object.fromEntries(spent));
            const next = set.find((other) => spent.get(other.name)?.day !== day);
            if (!next) { allOut(help); throw new Error(why); }
            help.report(`today's free pictures from ${one.name} are used up, so the rest are drawn on ${next.name} — they come back tomorrow`);
            continue;
          }
          failures.push(`${one.name}: ${why}`);
        }
      }
      throw new Error(failures.join('; '));
    },
  };
}
