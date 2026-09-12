import { describe, it, expect } from 'vitest';
import { hourBucket, skyFor, nightColourFor, lampAlphaFor, tintFor, sunOrMoon, clockText, replayLabel, REPLAY_AUTOLOAD_MS } from './time.js';
import { PALETTE, hexToInt, hexToHsl } from '../world/palette.js';

describe('hour buckets', () => {
  it('splits the day into night / dusk / day', () => {
    expect([hourBucket(2), hourBucket(6.5), hourBucket(13), hourBucket(19), hourBucket(22)]).toEqual(['night', 'dusk', 'day', 'dusk', 'night']);
  });
});

describe('sky', () => {
  it('uses the palette stops at the centre of each bucket and blends between them', () => {
    expect(skyFor(13)).toEqual(PALETTE.sky.day);
    expect(skyFor(23)).toEqual(PALETTE.sky.night);
    expect(skyFor(19)).toEqual(PALETTE.sky.dusk);
    expect(skyFor(20)).toEqual(PALETTE.sky.evening);
    const [top] = skyFor(20.5);                        // half way from evening to night
    expect(top).not.toBe(PALETTE.sky.evening[0]); expect(top).not.toBe(PALETTE.sky.night[0]);
    expect(top).toMatch(/^#[0-9a-f]{6}$/);
  });

  /**
   * Visual QA C2: the stops used to be blended through HSL along the shorter hue arc, and the shorter arc from the
   * dusk orange to the night navy runs backwards through red and magenta. At 19:49 — the hour every screenshot of
   * the 2026-09-12 run was taken at — the sky measured rgb(195, 57, 88): a crimson slab over a fifth of the frame.
   */
  it('never passes through red, at any minute of either ramp', () => {
    // A sunset does run orange → rose → violet, so the guard cannot be "no warm hues": it is that no stop is ever a
    // *saturated* red. The old shorter-arc blend measured hue 346° at saturation 0.55; the warmest this ramp ever
    // gets inside the red band is a terracotta at saturation 0.46, and the bar sits between the two.
    for (let h = 4; h <= 22; h += 0.05) {
      for (const stop of skyFor(h)) {
        const c = hexToHsl(stop);
        const red = c.h >= 335 || c.h < 12;   // red and crimson proper, not the orange end of the sunset
        expect(red && c.s >= 0.45, `${stop} at ${h.toFixed(2)} (hue ${c.h.toFixed(0)}, sat ${c.s.toFixed(2)})`).toBe(false);
      }
    }
    // and the blend the QA caught would fail it: hue 346°, saturation 0.55
    const crimson = hexToHsl('#c33958');
    expect(crimson.h >= 335 && crimson.s >= 0.45).toBe(true);
  });

  it('is warm at the horizon and cool at the zenith, not the other way round', () => {
    const warmth = (c: string): number => { const n = parseInt(c.slice(1), 16); return ((n >> 16) & 255) - (n & 255); };
    for (const h of [7.5, 13, 18.5, 19, 20]) {   // at full night both stops are navy and there is no warm end
      const [zenith, horizon] = skyFor(h);
      expect(warmth(horizon), `hour ${h}`).toBeGreaterThanOrEqual(warmth(zenith));
    }
  });
});

describe('night colour and lamps', () => {
  it('dusk and night differ; day has no lamps; night lamps are on', () => {
    expect(nightColourFor(19)).not.toBe(nightColourFor(23));
    expect(nightColourFor(23)).toBe(hexToInt(PALETTE.night));
    // Warm while the sky is warm, violet by the time the sky is (visual QA R2-I4): a sunset that falls on a
    // building as a cooler noon is the one thing in `09c` that disagreed with the sky about the time.
    expect(nightColourFor(18.1)).toBe(hexToInt(PALETTE.duskWarm));
    expect(nightColourFor(19)).toBe(hexToInt(PALETTE.duskWarm));
    expect(nightColourFor(20.5)).toBe(hexToInt(PALETTE.dusk));
    for (const h of [18.5, 19, 19.4]) {
      const c = hexToHsl(PALETTE.duskWarm);
      expect(c.h, 'the warm stop is warm').toBeLessThan(45);
      expect(nightColourFor(h)).toBe(hexToInt(PALETTE.duskWarm));
    }
    expect(nightColourFor(7)).toBe(hexToInt(PALETTE.duskWarm));   // dawn is warm for the same reason
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

/**
 * Visual QA R-I4: the shot harness pins an hour per scene so the daylight palette is proved on the pixels. The
 * clock kept reading the wall clock, so every daylight scene in the delivered gallery was stamped 22:52.
 */
describe('the clock under a pinned hour', () => {
  it('reads the wall clock when nothing is pinned', () => {
    const d = new Date(2026, 8, 12, 22, 52, 4);
    expect(clockText(d, null)).toBe(d.toLocaleTimeString());
  });
  it('reads the pinned hour instead, to the minute', () => {
    const d = new Date(2026, 8, 12, 22, 52, 4);
    expect(clockText(d, 12)).toBe('12:00');
    expect(clockText(d, 19.5)).toBe('19:30');
    expect(clockText(d, 22)).toBe('22:00');
  });
  it('wraps rather than printing an hour no clock has', () => {
    expect(clockText(new Date(), 24)).toBe('00:00');
    expect(clockText(new Date(), -1)).toBe('23:00');
  });
});
