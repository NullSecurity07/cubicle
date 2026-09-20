import { describe, expect, it } from 'vitest';
import { imageMakers, mayDrawHere } from './image.ts';
import { DOWNLOAD_GB, localImages, MODELS, needsRam, seedOf, sizeOf, STEPS } from './local-image.ts';

// Drawing on the founder's own machine. Nothing here runs the renderer — that was proven by hand and the numbers
// are written down in the module — so what is tested is everything around it: what it says when it cannot run, how
// a shape becomes a size, that the same words draw the same picture twice, and where it sits in the order.

const env = (over: Record<string, string> = {}) => ({ STAGE_VIDEO_MODELS: '/home/somebody/.cache/models', ...over }) as NodeJS.ProcessEnv;

describe('the picture model on this machine', () => {
  it('names every file it needs, where it comes from and how big it is', () => {
    expect(MODELS.map((one) => one.what)).toEqual(['the renderer', 'the picture model', 'the words model', 'the decoder']);
    for (const model of MODELS) {
      expect(model.url, model.what).toMatch(/^https:\/\//);
      expect(model.bytes, model.what).toBeGreaterThan(1_000_000);
      // The renderer is shared with the local clip maker, so both must fetch it to the same place.
      if (model.unzip) expect(model.file).toBe('bin/sd-vulkan.zip');
    }
    // What the founder is told before a six-gigabyte download starts.
    expect(DOWNLOAD_GB).toBeGreaterThan(6);
    expect(DOWNLOAD_GB).toBeLessThan(7);
  });

  it('draws at the three shapes a film uses and nothing else', () => {
    expect(sizeOf('square')).toEqual({ width: 1024, height: 1024 });
    expect(sizeOf('tall')).toEqual({ width: 768, height: 1344 });
    expect(sizeOf('wide')).toEqual({ width: 1344, height: 768 });
    // Anything else is a square, because a size this model was not distilled for is minutes of mush.
    expect(sizeOf('portrait')).toEqual(sizeOf('square'));
    expect(sizeOf(undefined)).toEqual(sizeOf('square'));
    // Four steps is what it was distilled for; eight is no better and twice as long.
    expect(STEPS).toBe(4);
  });

  it('draws the same picture for the same words, and a different one for different words', () => {
    expect(seedOf({ prompt: 'a paper plane over a city' })).toBe(seedOf({ prompt: 'a paper plane over a city' }));
    expect(seedOf({ prompt: 'a paper plane over a city' })).not.toBe(seedOf({ prompt: 'a kite over a field' }));
    // A caller that wants a particular picture says which.
    expect(seedOf({ prompt: 'anything', seed: 7 })).toBe(7);
    expect(seedOf({ prompt: 'anything', seed: -1 })).not.toBe(-1);
  });

  it('says in the founder\'s words why it cannot run, rather than failing when asked', () => {
    expect(localImages({ env: env({ STAGE_IMAGE_BACKEND: 'cloud' }) }).ready()).toMatch(/switched off/);
    expect(localImages({ env: env({ STAGE_NO_LOCAL_IMAGES: '1' }) }).ready()).toMatch(/switched off/);
    // Six gigabytes of weights under /tmp would be fetched again every reboot, out of the memory the model needs.
    expect(localImages({ env: env({ STAGE_VIDEO_MODELS: '/tmp/models' }) }).ready()).toMatch(/memory pretending to be a disk/);
  });

  it('asks for the memory it really needs, and lets a founder who knows their machine lower the bar', () => {
    expect(needsRam(env())).toBe(9);
    expect(needsRam(env({ STAGE_IMAGE_RAM_GB: '6' }))).toBe(6);
    // Below four gigabytes is not a machine that can hold the weights at all, whatever anybody sets.
    expect(needsRam(env({ STAGE_IMAGE_RAM_GB: '1' }))).toBe(9);
  });
});

describe('the order pictures are asked for in', () => {
  const names = (list: { name: string }[]) => list.map((one) => one.name);

  it('asks the fast free service first, this machine second, and somebody else\'s demo last', () => {
    // Cloudflare answers in four seconds and this machine takes a minute — but this machine never runs out, which
    // is why it comes before the demos rather than after them.
    expect(names(imageMakers(env()))).toEqual(['Cloudflare', 'this computer', 'Hugging Face']);
  });

  it('obeys a founder who says where their pictures are drawn', () => {
    expect(names(imageMakers(env({ STAGE_IMAGE_BACKEND: 'local' })))).toEqual(['this computer']);
    expect(names(imageMakers(env({ STAGE_IMAGE_BACKEND: 'cloud' })))).toEqual(['Cloudflare', 'Hugging Face']);
  });

  it('knows whether a film should warn about the minutes before it starts', () => {
    expect(mayDrawHere(env({ STAGE_IMAGE_BACKEND: 'cloud' }))).toBe(false);
    expect(mayDrawHere(env({ STAGE_NO_LOCAL_IMAGES: '1' }))).toBe(false);
  });
});
