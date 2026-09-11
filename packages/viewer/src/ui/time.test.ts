import { describe, it, expect } from 'vitest';
import { hourBucket, skyFor, nightColourFor, lampAlphaFor, tintFor, sunOrMoon } from './time.js';
import { PALETTE, hexToInt } from '../world/palette.js';

describe('hour buckets', () => {
  it('splits the day into night / dusk / day', () => {
    expect([hourBucket(2), hourBucket(6.5), hourBucket(13), hourBucket(19), hourBucket(22)]).toEqual(['night', 'dusk', 'day', 'dusk', 'night']);
  });
});

describe('sky', () => {
  it('uses the palette stops at the centre of each bucket and blends between them', () => {
    expect(skyFor(13)).toEqual(PALETTE.sky.day);
    expect(skyFor(23)).toEqual(PALETTE.sky.night);
    expect(skyFor(19.5)).toEqual(PALETTE.sky.dusk);
    const [top] = skyFor(20.25);                       // half way from dusk to night
    expect(top).not.toBe(PALETTE.sky.dusk[0]); expect(top).not.toBe(PALETTE.sky.night[0]);
    expect(top).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('night colour and lamps', () => {
  it('dusk and night differ; day has no lamps; night lamps are on', () => {
    expect(nightColourFor(19)).not.toBe(nightColourFor(23));
    expect(nightColourFor(23)).toBe(hexToInt(PALETTE.night));
    expect(nightColourFor(18.1)).toBe(hexToInt(PALETTE.dusk));
    expect(lampAlphaFor(12)).toBe(0);
    expect(lampAlphaFor(21)).toBe(1);
    expect(lampAlphaFor(19.5)).toBeGreaterThan(0); expect(lampAlphaFor(19.5)).toBeLessThan(1);
    expect(lampAlphaFor(19.5)).toBeCloseTo(tintFor(19.5) / tintFor(23));
  });
});

describe('time bar icon', () => {
  it('shows the sun through the working day and the moon otherwise', () => {
    expect(sunOrMoon(12)).toBe('sun'); expect(sunOrMoon(6)).toBe('sun'); expect(sunOrMoon(17.9)).toBe('sun');
    expect(sunOrMoon(18)).toBe('moon'); expect(sunOrMoon(2)).toBe('moon'); expect(sunOrMoon(23.5)).toBe('moon');
  });
});
