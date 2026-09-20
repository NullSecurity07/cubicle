import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Maker, Piece } from './jobs.ts';
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const app = await Promise.race([
      connect(spot.space, key ? { token: key } : {}),
      new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('the Space did not answer')), CONNECT_TIMEOUT); }),
    ]).finally(() => clearTimeout(timer));
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
export const imageMakers = (env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): Maker[] =>
  [cloudflareImages(env, http), huggingFaceImages(env, undefined, http)];

// What a free daily quota is spent on, and what it is never spent on twice. A picture is filed under a hash of
// exactly what was asked for, so a founder who renders the same film again — after a line of narration changed, or
// after the app restarted — pays nothing for the pictures they already have. A cache that cannot be written to is
// not an error: the film is made either way.
export const askedFor = (name: string, prompt: string, shape: unknown): string =>
  createHash('sha256').update(`${name}|${String(shape ?? '')}|${prompt}`).digest('hex').slice(0, 32);

export function cachedImages(maker: Maker, dir: string): Maker {
  return {
    name: maker.name,
    ready: maker.ready,
    async make(ask, help): Promise<Piece> {
      const file = join(dir, `${askedFor(maker.name, String(ask.prompt ?? ''), ask.shape)}.img`);
      const held = await readFile(file).catch(() => null);
      if (held?.length) { help.report('drawn before, so it costs nothing'); return { ext: held[0] === 0x89 ? 'png' : 'jpg', bytes: held }; }
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
export function firstImages(...makers: Maker[]): Maker {
  // Which backends have gone quiet, and on which day they did, so tomorrow starts clean without anyone restarting
  // anything. The day is the plain calendar-ish one a free quota resets on; near enough for "come back tomorrow".
  const spent = new Map<string, { day: number; why: string }>();
  const today = () => Math.floor(Date.now() / 86_400_000);
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
          return await one.make(ask, help);
        } catch (error) {
          const why = (error as Error).message;
          if (help.signal?.aborted) throw error;
          if (outOfPictures(why)) {
            spent.set(one.name, { day, why });
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
