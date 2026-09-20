import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { brightest, gammaFor, holdFor, LEAST_GAMMA, LIGHT_ENOUGH, liftFor, lighten, luminance, meanLight, MOST, ratio, sampleOf, scrimFor, washed, WANTS } from './contrast.ts';

describe('what a contrast ratio really is', () => {
  it('agrees with the numbers everybody quotes', () => {
    expect(ratio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 1);
    expect(ratio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 4);
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 4);
    expect(luminance([0, 0, 0])).toBeCloseTo(0, 4);
  });

  it('washes a picture the way the renderer really does', () => {
    expect(washed([255, 255, 255], [0, 0, 0], 0.5)).toEqual([128, 128, 128]);
    expect(washed([200, 100, 50], [0, 0, 0], 0)).toEqual([200, 100, 50]);
  });
});

describe('how hard a picture has to be held down', () => {
  it('asks almost nothing of a dark picture and most of a wash of a white one', () => {
    const dark = holdFor([18, 20, 24], '#FFFFFF', '#0C0D12');
    const pale = holdFor([244, 242, 238], '#FFFFFF', '#0C0D12');
    expect(dark).toBeLessThan(0.2);
    expect(pale).toBeGreaterThan(0.5);
    expect(pale).toBeLessThanOrEqual(MOST);
  });

  it('really clears the line it was solving for', () => {
    for (const under of [[244, 242, 238], [130, 128, 126], [18, 20, 24]] as [number, number, number][]) {
      const hold = holdFor(under, '#FFFFFF', '#0C0D12');
      expect(ratio([255, 255, 255], washed(under, [12, 13, 18], hold))).toBeGreaterThanOrEqual(WANTS - 0.01);
    }
  });

  it('never covers a picture over entirely — past that the answer is a different picture', () => {
    expect(holdFor([255, 255, 255], '#F2F5F8', '#F4F0E6')).toBeLessThanOrEqual(MOST);
  });

  it('keeps whatever floor the pack already had', () => {
    expect(holdFor([10, 10, 10], '#FFFFFF', '#000000', WANTS, 0.3)).toBeGreaterThanOrEqual(0.3);
  });
});

describe('sampling the picture rather than averaging it', () => {
  it('takes the bright quarter, because that is where a line of type stops being readable', () => {
    const pixels: [number, number, number][] = [
      ...Array.from({ length: 30 }, () => [10, 10, 10] as [number, number, number]),
      ...Array.from({ length: 10 }, () => [250, 250, 250] as [number, number, number]),
    ];
    expect(luminance(brightest(pixels))).toBeGreaterThan(luminance([10, 10, 10]));
  });

  it('answers with nothing rather than a guess when it cannot look at the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contrast-'));
    try {
      expect(await sampleOf(join(dir, 'nothing-here.png'), { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
      expect(await scrimFor(join(dir, 'nothing-here.png'), 'foot', '#FFFFFF', '#000000')).toBeNull();
      expect(await meanLight(join(dir, 'nothing-here.png'))).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('a picture too dark to see a subject in', () => {
  it('is lifted, and only a little — past a quarter it is a different photograph', () => {
    expect(liftFor(0.4)).toBe(1);
    expect(liftFor(0.16)).toBe(1);
    expect(liftFor(0.08)).toBeGreaterThan(1);
    expect(liftFor(0.001)).toBeLessThanOrEqual(1.28);
  });
});

afterAll(() => {});

describe('a dark still is lifted in the file, by a curve', () => {
  it('leaves a readable picture alone and never goes past its floor', () => {
    expect(gammaFor(LIGHT_ENOUGH)).toBe(1);
    expect(gammaFor(0.4)).toBe(1);
    expect(gammaFor(0.05)).toBeLessThan(1);
    expect(gammaFor(0.05)).toBeGreaterThan(gammaFor(0.02));
    expect(gammaFor(0.0001)).toBe(LEAST_GAMMA);
  });

  it('raises the shadows and leaves the one lamp in the room where it was', async () => {
    const { default: sharp } = await import('sharp');
    const dir = await mkdtemp(join(tmpdir(), 'lift-'));
    try {
      // A dark room with one bright lamp in the corner: a gain strong enough to open the room burns the lamp out.
      const file = join(dir, 'room.png');
      const lamp = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 240, g: 236, b: 220 } } }).png().toBuffer();
      await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 30, g: 28, b: 26 } } }).composite([{ input: lamp, left: 170, top: 10 }]).png().toFile(file);
      const before = (await meanLight(file))!;
      const did = await lighten(file);
      expect(did?.gamma).toBeLessThan(1);
      const after = (await meanLight(file))!;
      expect(after).toBeGreaterThan(before * 1.5);
      const lampNow = (await sampleOf(file, { x: 0.87, y: 0.07, w: 0.06, h: 0.06 }, 2))![0];
      expect(lampNow[0]).toBeLessThan(250);
      expect(lampNow[0]).toBeGreaterThanOrEqual(240);
      // A second pass finds nothing left to do, so a picture drawn before is never lifted twice into daylight.
      const bright = join(dir, 'day.png');
      await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 150, g: 150, b: 150 } } }).png().toFile(bright);
      expect((await lighten(bright))?.gamma).toBe(1);
      expect(await lighten(join(dir, 'nothing-here.png'))).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
