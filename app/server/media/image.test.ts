import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Maker } from './jobs.ts';
import { seedStage, type Stage } from '../../shared/model.ts';
import { createStore } from '../store.ts';
import { mediaTools } from '../tools/media.ts';
import {
  askedFor, cachedImages, cloudflareImages, fakeImages, firstImages, HF_SPENT, huggingFaceImages, outOfPictures,
  type Picture, type PictureConnect, pictureOf, pictureSpaces, pictureUrlOf, SETUP_HINT,
} from './image.ts';
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
    // The path is said in words as well as linked, because the next thing asked for is a film with it in.
    expect(ran.text).toMatch(/^Made the picture\. It is saved at media\/[a-z0-9-]+\.png — pass that path to generate_video in "images"/);
    expect(ran.text).toMatch(/!\[A paper plane over a city\]\(\/api\/files\/media\/[a-z0-9-]+\.png\)$/);
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

  // The studio cannot spell, so words never go in the prompt. They are handed over separately and set over the
  // finished picture in real type, and the person is told in so many words which words went on it.
  it('hands the words to the studio rather than to the model, and says which went on the picture', async () => {
    const asked: Record<string, unknown>[] = [];
    const watching: Maker = { name: 'watched', ready: () => null, async make(ask) { asked.push(ask); return { ext: 'png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; } };
    const dir = await mkdtemp(join(tmpdir(), 'imagewords-'));
    const store = createStore(dir);
    const media = createMedia({ dir, store, makers: { imagegen: [watching] } });
    const [tool] = mediaTools(media);
    const context = { stage: wired, roomId: 'marketing', store, granted: new Map<string, string>() };
    const ran = await tool.run({ prompt: 'a city at dusk', headline: 'Top VCs backing India', lines: ['Accel India', '  ', 'Blume Ventures'] }, context);
    expect(asked[0].headline).toBe('Top VCs backing India');
    expect(asked[0].lines).toEqual(['Accel India', 'Blume Ventures']);
    expect(ran.text).toContain('set on it in real type: “Top VCs backing India”, over 2 lines');
    // A picture with no words is still a picture with no words said about it.
    await tool.run({ prompt: 'a city at dawn' }, context);
    expect(asked[1].headline).toBe('');
    expect(asked[1].lines).toEqual([]);
    await expect(tool.run({ prompt: 'a city', headline: 'x'.repeat(61) }, context)).rejects.toThrow('"headline" is too long');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('a picture is paid for once', () => {
  it('keeps what was drawn under what was asked for, and hands it back for nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pictures-'));
    let drawn = 0;
    const once: Maker = {
      name: 'counted', ready: () => null,
      async make() { drawn += 1; return { ext: 'png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, drawn]) }; },
    };
    const kept = cachedImages(once, dir);
    const said: string[] = [];
    const first = await kept.make({ prompt: 'a paper plane', shape: 'wide' }, { report: (line) => said.push(line) });
    const again = await kept.make({ prompt: 'a paper plane', shape: 'wide' }, { report: (line) => said.push(line) });
    expect(drawn).toBe(1);
    expect(again.bytes).toEqual(first.bytes);
    expect(said.join(' ')).toContain('costs nothing');
    // A different shape of the same words is a different picture, and so is a different prompt.
    await kept.make({ prompt: 'a paper plane', shape: 'tall' }, { report: () => {} });
    await kept.make({ prompt: 'a paper boat', shape: 'wide' }, { report: () => {} });
    expect(drawn).toBe(3);
    expect(askedFor('a', 'b', 'wide')).not.toBe(askedFor('a', 'b', 'tall'));
    await rm(dir, { recursive: true, force: true });
  });

  it('knows when a free service has said there is nothing left today', () => {
    expect(outOfPictures('Cloudflare answered 429: you have used up your daily free allocation of 10,000 neurons')).toBe(true);
    expect(outOfPictures('Too Many Requests')).toBe(true);
    expect(outOfPictures('fetch failed')).toBe(false);
    expect(outOfPictures('no picture came back')).toBe(false);
  });
});

// The second way of drawing, and the way the two of them share a day between them. Nothing here touches the network:
// a Space is a small script of what it claims to take and what it will send back, and the file it hands over is
// served by a stand-in fetch.
describe('Hugging Face pictures', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
  type Script = { endpoints: Record<string, string[]>; notes: unknown[] };
  // What a listing says it wants, as the Space would say it back: a demo that still has all these names is a demo we
  // can use, and one that has renamed a single parameter is one to skip.
  const asks = (spot: Picture) => Object.keys(spot.params);
  const gallery = (url: string) => [{ type: 'status', stage: 'complete' }, { type: 'data', data: [{ image: { url, path: '/x.png' } }] }];
  const plain = (url: string) => [{ type: 'status', stage: 'complete' }, { type: 'data', data: [{ url, path: '/x.png' }] }];

  function demos(plan: Record<string, Script>) {
    const calls: { space: string; endpoint: string; args: Record<string, unknown>; token?: string }[] = [];
    const connect: PictureConnect = async (space, options) => {
      const script = plan[space];
      if (!script) throw new Error('the Space is not running');
      return {
        async view_api() {
          return { named_endpoints: Object.fromEntries(Object.entries(script.endpoints).map(([at, names]) => [at, { parameters: names.map((parameter_name) => ({ parameter_name })) }])) };
        },
        async predict(endpoint: string, args: Record<string, unknown>) {
          calls.push({ space, endpoint, args, token: options.token });
          // A real Space refuses by throwing, which is the one way the reason reaches us at all.
          const wrong = script.notes.find((note) => (note as { stage?: string }).stage === 'error') as { message?: unknown } | undefined;
          if (wrong) throw new Error(String(wrong.message ?? 'the Space said no'));
          const answer = script.notes.find((note) => (note as { type?: string }).type === 'data') as { data?: unknown } | undefined;
          return { data: answer?.data };
        },
        close() {},
      };
    };
    return { calls, connect };
  }

  const fetched: { url: string; headers: Record<string, string> }[] = [];
  const served = (body: Buffer | number): typeof fetch => (async (url: any, init?: RequestInit) => {
    fetched.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return typeof body === 'number' ? new Response('gone', { status: body }) : new Response(new Uint8Array(body), { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  it('names a Space, an endpoint and which parameter takes what, so a dead demo is a one-line edit', () => {
    expect(pictureSpaces.length).toBeGreaterThan(1);
    for (const spot of pictureSpaces) {
      expect(spot.space, spot.name).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(spot.endpoint, spot.name).toMatch(/^\//);
      // Every listing must have somewhere to put the words, or it cannot draw what was asked for.
      expect(Object.values(spot.params), spot.name).toContain('$prompt');
    }
  });

  it('asks the first Space, fills in the words and the shape, and fetches the picture back', async () => {
    fetched.length = 0;
    const first = pictureSpaces[0];
    const { calls, connect } = demos({ [first.space]: { endpoints: { [first.endpoint]: asks(first) }, notes: gallery('https://z.hf.space/file=out.png') } });
    const said: string[] = [];
    const maker = huggingFaceImages({}, connect, served(png));
    const piece = await maker.make({ prompt: 'a paper plane', shape: 'wide' }, { report: (line) => said.push(line) });
    expect(piece).toEqual({ ext: 'png', bytes: png });
    expect(calls[0].endpoint).toBe(first.endpoint);
    expect(calls[0].args.prompt).toBe('a paper plane');
    // Nothing was left as a slot: a `$name` that reached a Space would be drawn as those very words.
    expect(Object.values(calls[0].args).filter((one) => typeof one === 'string' && one.startsWith('$'))).toEqual([]);
    // The shape the founder asked for reaches the Space, in whichever way that Space likes to hear it.
    expect(JSON.stringify(Object.values(calls[0].args))).toMatch(/16:9|1280/);
    expect(fetched[0].url).toBe('https://z.hf.space/file=out.png');
    expect(said.join(' ')).toContain(first.name);
  });

  it('skips a Space that has been rewritten, says which name went, and draws on the next one', async () => {
    const [first, second] = pictureSpaces;
    const { calls, connect } = demos({
      [first.space]: { endpoints: { [first.endpoint]: asks(first).map((name, at) => (at === 0 ? `${name}_v2` : name)) }, notes: [] },
      [second.space]: { endpoints: { [second.endpoint]: asks(second) }, notes: plain('https://flux.hf.space/file=out.png') },
    });
    const said: string[] = [];
    const piece = await huggingFaceImages({}, connect, served(png)).make({ prompt: 'a kite' }, { report: (line) => said.push(line) });
    expect(piece.bytes).toEqual(png);
    // The rewritten Space was never asked to draw, only asked what it takes.
    expect(calls.map((one) => one.space)).toEqual([second.space]);
    expect(said.join(' ')).toContain('no longer takes');
    expect(said.join(' ')).toContain('pictures.json');
  });

  it('draws with no token at all, and hands one over when the founder has set one', async () => {
    fetched.length = 0;
    const first = pictureSpaces[0];
    const plan = { [first.space]: { endpoints: { [first.endpoint]: asks(first) }, notes: gallery('https://z.hf.space/file=out.png') } };
    const open = demos(plan);
    expect(huggingFaceImages({}).ready()).toBeNull();
    await huggingFaceImages({}, open.connect, served(png)).make({ prompt: 'a kite' }, { report: () => {} });
    expect(open.calls[0].token).toBeUndefined();
    expect(fetched[0].headers.authorization).toBeUndefined();
    const signed = demos(plan);
    await huggingFaceImages({ HF_TOKEN: 'hf_secret' }, signed.connect, served(png)).make({ prompt: 'a kite' }, { report: () => {} });
    expect(signed.calls[0].token).toBe('hf_secret');
    expect(fetched[1].headers.authorization).toBe('Bearer hf_secret');
  });

  it('says in one line when the day\'s free GPU is spent, in words the film knows to stop on', async () => {
    const [first, second] = pictureSpaces;
    const { calls, connect } = demos({
      [first.space]: { endpoints: { [first.endpoint]: asks(first) }, notes: [{ type: 'status', stage: 'error', message: 'You have exceeded your GPU quota (60s requested vs. 0s left).' }] },
      [second.space]: { endpoints: { [second.endpoint]: asks(second) }, notes: plain('https://flux.hf.space/file=out.png') },
    });
    const maker = huggingFaceImages({}, connect, served(png));
    await expect(maker.make({ prompt: 'a kite' }, { report: () => {} })).rejects.toThrow(HF_SPENT);
    // Every Space spends the same allowance, so the second one is not asked.
    expect(calls.map((one) => one.space)).toEqual([first.space]);
    expect(outOfPictures(HF_SPENT)).toBe(true);
  });

  it('finds the picture whether it comes on its own or inside a gallery', () => {
    expect(pictureUrlOf([{ url: 'a.png' }])).toBe('a.png');
    expect(pictureUrlOf([{ image: { url: 'b.png' } }, { image: { url: 'c.png' } }])).toBe('b.png');
    expect(pictureUrlOf({ image: { path: '/tmp/x', url: 'd.png' } })).toBe('d.png');
    expect(pictureUrlOf([{ caption: null }])).toBeNull();
    expect(pictureUrlOf(null)).toBeNull();
  });
});

describe('when one free day runs out', () => {
  type Counted = Maker & { asked: number };
  const counted = (name: string, plan: { hint?: string; fails?: string } = {}): Counted => {
    const one: Counted = {
      name,
      asked: 0,
      ready: () => plan.hint ?? null,
      async make() {
        one.asked += 1;
        if (plan.fails) throw new Error(plan.fails);
        return { ext: 'png', bytes: Buffer.from(name) };
      },
    };
    return one;
  };
  const spent = 'Cloudflare answered 429: you have used up your daily free allocation of 10,000 neurons';

  it('takes the first that is set up and leaves the second alone', async () => {
    const cloud = counted('Cloudflare');
    const face = counted('Hugging Face');
    const piece = await firstImages(cloud, face).make({ prompt: 'a kite' }, { report: () => {} });
    expect(piece.bytes.toString()).toBe('Cloudflare');
    expect(face.asked).toBe(0);
  });

  it('moves to the next when one says its day is done, and says so once, in one line', async () => {
    const cloud = counted('Cloudflare', { fails: spent });
    const face = counted('Hugging Face');
    const both = firstImages(cloud, face);
    const said: string[] = [];
    const piece = await both.make({ prompt: 'a kite' }, { report: (line) => said.push(line) });
    expect(piece.bytes.toString()).toBe('Hugging Face');
    expect(said).toEqual(["today's free pictures from Cloudflare are used up, so the rest are drawn on Hugging Face — they come back tomorrow"]);
    // The rest of the day goes straight to the one that still answers: the spent one is not asked a second time.
    await both.make({ prompt: 'a boat' }, { report: (line) => said.push(line) });
    expect(cloud.asked).toBe(1);
    expect(face.asked).toBe(2);
    expect(said).toHaveLength(1);
  });

  it('tells the founder once when every way of drawing is spent, and lets the film fall back to textures', async () => {
    const cloud = counted('Cloudflare', { fails: spent });
    const face = counted('Hugging Face', { fails: 'ZeroGPU quota exceeded' });
    const both = firstImages(cloud, face);
    const said: string[] = [];
    await expect(both.make({ prompt: 'a kite' }, { report: (line) => said.push(line) })).rejects.toThrow(/quota/);
    expect(said.at(-1)).toBe("today's free pictures are used up, so the scenes sit on textures instead — they come back tomorrow");
    // Asked again, it does not touch either of them and does not say the same thing twice.
    const again = said.length;
    const twice = await both.make({ prompt: 'a boat' }, { report: (line) => said.push(line) }).catch((error: Error) => error);
    // What comes back is still in the words the film watches for, so the scene takes the graceful way out.
    expect(outOfPictures((twice as Error).message)).toBe(true);
    expect(cloud.asked).toBe(1);
    expect(face.asked).toBe(1);
    expect(said).toHaveLength(again);
  });

  it('hands on when one simply fails, without writing off its whole day', async () => {
    const cloud = counted('Cloudflare', { fails: 'fetch failed' });
    const face = counted('Hugging Face');
    const both = firstImages(cloud, face);
    expect((await both.make({ prompt: 'a kite' }, { report: () => {} })).bytes.toString()).toBe('Hugging Face');
    await both.make({ prompt: 'a boat' }, { report: () => {} });
    expect(cloud.asked).toBe(2);
  });

  it('is ready while any of them is, and otherwise says the clearest thing the founder can do', async () => {
    const some = firstImages(counted('Cloudflare', { hint: SETUP_HINT }), counted('Hugging Face'));
    expect(some.ready()).toBeNull();
    expect((await some.make({ prompt: 'a kite' }, { report: () => {} })).bytes.toString()).toBe('Hugging Face');
    const none = firstImages(counted('Cloudflare', { hint: SETUP_HINT }), counted('Hugging Face', { hint: 'the Space list is empty' }));
    expect(none.ready()).toBe(SETUP_HINT);
    await expect(none.make({ prompt: 'a kite' }, { report: () => {} })).rejects.toThrow(SETUP_HINT);
  });
});
