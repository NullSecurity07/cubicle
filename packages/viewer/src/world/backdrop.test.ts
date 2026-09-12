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
    const r = skyRect(1279.4, 799.2);
    expect([r.width, r.height]).toEqual([1280, 800]);
    expect(r.x).toBeLessThanOrEqual(0); expect(r.y).toBeLessThanOrEqual(0);   // the round-up hangs off the edge, never inside it
    expect(skyRect(0, 0)).toEqual({ x: -0.5, y: -0.5, width: 1, height: 1 });
  });

  /**
   * Visual QA (found while fixing C2/C3): `scrollFactor 0` stops an object scrolling, not the camera zoom scaling
   * it about the middle of the viewport. At the tower elevation the sky was drawn at half size in the middle of
   * the canvas with the flat clear colour around it — a hard-edged rectangle of gradient in a field of horizon.
   */
  it('still covers the viewport once the camera zoom has multiplied it', () => {
    for (const zoom of [0.5, 1, 2, 3, 4]) {
      const r = skyRect(1280, 800, zoom);
      // what the camera does to a scrollFactor-0 object: scale about the centre of the viewport
      const screen = (v: number, centre: number): number => (v - centre) * zoom + centre;
      expect(screen(r.x, 640), `zoom ${zoom}`).toBeLessThanOrEqual(0);
      expect(screen(r.x + r.width, 640), `zoom ${zoom}`).toBeGreaterThanOrEqual(1280);
      expect(screen(r.y, 400), `zoom ${zoom}`).toBeLessThanOrEqual(0);
      expect(screen(r.y + r.height, 400), `zoom ${zoom}`).toBeGreaterThanOrEqual(800);
    }
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
