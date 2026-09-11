import { describe, it, expect } from 'vitest';
import { skyRect, nightRect, backdropColour } from './backdrop.js';
import { skyFor } from '../ui/time.js';

const BUILDING = { x0: 4, x1: 54, y0: 2, y1: 54 };
const TILE = 16;

describe('the sky', () => {
  it('fills the viewport, not the world: nothing of the canvas is left for a flat background slab', () => {
    // The bug this pins: sky and night were sized to the 960 × 1024 world while the viewport is 1280 wide, so a
    // third of the screen stayed the page background at every zoom and never darkened at night.
    for (const [w, h] of [[1280, 800], [800, 600], [2560, 1440], [400, 400]]) {
      const r = skyRect(w, h);
      expect(r).toEqual({ x: 0, y: 0, width: w, height: h });
    }
  });
  it('rounds a fractional canvas size up, and never collapses to nothing', () => {
    expect(skyRect(1279.4, 799.2)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    expect(skyRect(0, 0)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
  it('hands the canvas clear colour the horizon stop, so the pre-texture frame is never the page theme', () => {
    expect(backdropColour(skyFor(2))).toBe(skyFor(2)[1]);
    expect(backdropColour(skyFor(2))).not.toBe(backdropColour(skyFor(13)));   // night and noon differ
  });
});

describe('the night tint', () => {
  it('covers the building plus a tile of margin and stops there — the sky keeps its own night gradient', () => {
    const r = nightRect(BUILDING, TILE);
    expect(r).toEqual({ x: 3 * 16, y: 1 * 16, width: 53 * 16, height: 55 * 16 });
    // the building's four corners are inside
    expect(r.x).toBeLessThanOrEqual(BUILDING.x0 * TILE);
    expect(r.y).toBeLessThanOrEqual(BUILDING.y0 * TILE);
    expect(r.x + r.width).toBeGreaterThanOrEqual((BUILDING.x1 + 1) * TILE);
    expect(r.y + r.height).toBeGreaterThanOrEqual((BUILDING.y1 + 1) * TILE);
  });
  it('does not reach the sky: a viewport-wide canvas is wider than the tint', () => {
    expect(nightRect(BUILDING, TILE).width).toBeLessThan(skyRect(1280, 800).width);
  });
});
