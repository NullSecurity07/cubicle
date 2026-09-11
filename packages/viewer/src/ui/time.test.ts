import { describe, it, expect } from 'vitest';
import { hourBucket, skyFor, nightColourFor, lampAlphaFor, tintFor, sunOrMoon, replayLabel, REPLAY_AUTOLOAD_MS } from './time.js';
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

/**
 * M9: the clock label carried "(Space pauses, arrows step)" — a keyboard hint wedged into a readout. The hint moved
 * beside the transport it is about (`#replay-hint`), which is itself only on the screen in replay mode.
 */
describe('the replay clock label', () => {
  const ev = (ts: string): { ts: string } => ({ ts });
  it('reads the count and the span of the day', () => {
    expect(replayLabel([ev('2026-09-11T09:00:00.000Z'), ev('2026-09-11T17:30:12.000Z')])).toBe('2 events · 09:00:00–17:30:12');
  });
  it('says so when the day is empty, rather than printing an empty span', () => {
    expect(replayLabel([])).toBe('no events that day');
  });
  it('carries no keyboard hint: the clock is a clock', () => {
    const label = replayLabel([ev('2026-09-11T09:00:00.000Z')]);
    expect(label).not.toMatch(/space|arrow/i);
  });
  it('gives the socket a moment before `?replay=` loads a day', () => {
    expect(REPLAY_AUTOLOAD_MS).toBeGreaterThan(0);
  });
});
