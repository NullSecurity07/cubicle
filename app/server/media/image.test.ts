import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { createStore } from '../store.ts';
import { mediaTools } from '../tools/media.ts';
import { cloudflareImages, fakeImages, pictureOf, SETUP_HINT } from './image.ts';
import { createMedia } from './jobs.ts';

const keys = { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const asked: { url: string; body: any; headers: any }[] = [];
const answers = (make: () => Response): typeof fetch => (async (url: any, init?: RequestInit) => {
  asked.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
  return make();
}) as typeof fetch;

describe('Cloudflare pictures', () => {
  it('says what the founder must set up, and nothing once the keys are there', () => {
    expect(cloudflareImages({}).ready()).toBe(SETUP_HINT);
    expect(cloudflareImages({ CLOUDFLARE_API_TOKEN: 'token' }).ready()).toBe(SETUP_HINT);
    expect(cloudflareImages(keys).ready()).toBeNull();
  });

  it('asks FLUX for the shape in words, and reads the base64 picture out of the answer', async () => {
    asked.length = 0;
    const maker = cloudflareImages(keys, answers(() => Response.json({ result: { image: png.toString('base64') } })));
    const piece = await maker.make({ prompt: 'a paper plane', shape: 'wide' }, { report: () => {} });
    expect(piece).toEqual({ ext: 'png', bytes: png });
    expect(asked[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/black-forest-labs/flux-1-schnell');
    expect(asked[0].body).toEqual({ prompt: 'a paper plane, wide 16:9 composition', steps: 4 });
    expect(asked[0].headers.authorization).toBe('Bearer token');
  });

  it('gives another model the size instead, and takes the picture as it comes', async () => {
    asked.length = 0;
    const maker = cloudflareImages({ ...keys, STAGE_IMAGE_MODEL: '@cf/stabilityai/stable-diffusion-xl-base-1.0' }, answers(() => new Response(jpg, { headers: { 'content-type': 'image/jpeg' } })));
    expect(await maker.make({ prompt: 'a kite', shape: 'tall' }, { report: () => {} })).toEqual({ ext: 'jpg', bytes: jpg });
    expect(asked[0].url).toContain('stable-diffusion-xl-base-1.0');
    expect(asked[0].body).toEqual({ prompt: 'a kite', width: 768, height: 1280 });
  });

  it('passes on what went wrong in one line', async () => {
    const refused = cloudflareImages(keys, answers(() => new Response('Authentication error', { status: 401 })));
    await expect(refused.make({ prompt: 'a kite' }, { report: () => {} })).rejects.toThrow('Cloudflare answered 401: Authentication error');
    const empty = cloudflareImages(keys, answers(() => Response.json({ result: {} })));
    await expect(empty.make({ prompt: 'a kite' }, { report: () => {} })).rejects.toThrow('no picture came back');
    expect(() => pictureOf(Buffer.alloc(0), 'image/png')).toThrow('no picture came back');
  });
});

describe('generate_image', () => {
  const wired: Stage = {
    ...seedStage,
    cards: [{ id: 'studio-1', kind: 'imagegen', x: 0, y: 0, w: 1, h: 1 }],
    wires: [...seedStage.wires, { id: 'w', from: 'studio-1', fromHandle: 'r', to: 'marketing', toHandle: 'l' }],
  };

  const turn = async (stage: Stage) => {
    const dir = await mkdtemp(join(tmpdir(), 'imagetool-'));
    const store = createStore(dir);
    const media = createMedia({ dir, store, makers: { imagegen: [fakeImages] } });
    const [tool] = mediaTools(media);
    return { tool, media, context: { stage, roomId: 'marketing', store, granted: new Map<string, string>() } };
  };

  it('draws in the studio wired to this person, and shows the picture in the reply', async () => {
    const { tool, media, context } = await turn(wired);
    const ran = await tool.run({ prompt: 'A paper plane over a city', shape: 'wide' }, context);
    expect(ran.text).toMatch(/^Made the picture\.\n\n!\[A paper plane over a city\]\(\/api\/files\/media\/[a-z0-9-]+\.png\)$/);
    expect(ran.effect).toEqual({ kind: 'media-made', id: 'studio-1' });
    expect((await media.read('studio-1')).results[0].prompt).toBe('A paper plane over a city');
  });

  it('asks the founder for a studio when none is wired, and never draws in someone else\'s', async () => {
    const { tool, context } = await turn({ ...wired, wires: seedStage.wires });
    await expect(tool.run({ prompt: 'a kite' }, context)).rejects.toThrow(/no image studio is connected to your room/);
    const other = await turn(wired);
    await expect(tool.run({ prompt: 'a kite' }, { ...other.context, roomId: 'build' })).rejects.toThrow(/no image studio is connected/);
  });

  it('will not draw from nothing', async () => {
    const { tool, context } = await turn(wired);
    await expect(tool.run({ prompt: '  ' }, context)).rejects.toThrow('"prompt" is missing');
  });
});
