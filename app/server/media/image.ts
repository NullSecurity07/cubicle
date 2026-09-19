import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Maker, Piece } from './jobs.ts';

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT = 90_000;
export const SETUP_HINT = 'No picture maker is set up. The founder adds CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to .env — a free Cloudflare account covers hundreds of pictures a day — then restarts the app.';

// FLUX.1 schnell always draws a square, so the shape is asked for in the prompt. The older models Workers AI offers
// take a size instead, which is what a model set in STAGE_IMAGE_MODEL gets.
const SHAPES: Record<string, { words: string; width: number; height: number }> = {
  square: { words: '', width: 1024, height: 1024 },
  wide: { words: ', wide 16:9 composition', width: 1280, height: 768 },
  tall: { words: ', tall 9:16 composition', width: 768, height: 1280 },
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

export const imageMakers = (env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): Maker[] => [cloudflareImages(env, http)];

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
