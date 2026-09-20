import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { brightest, holdFor, liftFor, luminance, meanLight, MOST, ratio, sampleOf, scrimFor, washed, WANTS } from './contrast.ts';

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
