import { describe, it, expect } from 'vitest';
import { skyRect, nightRect, backdropColour, discRuns, groundBands, groundRect, stars, ROAD_ROWS, GROUND_OVERSCAN } from './backdrop.js';
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
    expect(r).toEqual({ x: 3 * 16, y: 1 * 16, width: 53 * 16, height: 54 * 16 });
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

/**
 * Visual QA R-M6: the map is 60 x 64 tiles and the tower fit shows 2560 x 1408 of world, so the street stopped in
 * mid-air and the building stood in a sky that went on below the pavement. Two bands, because the map's own street
 * is asphalt then pavement and one fill would put a tan step where the carriageway ends.
 */
describe('the ground beyond the map', () => {
  const W = 60, H = 64;
  it('starts at the building foot and runs out past both kerbs and below', () => {
    const { road, pavement } = groundBands(BUILDING, TILE, W, H);
    expect(road.y).toBe((BUILDING.y1 + 1) * TILE);
    expect(road.height).toBe(ROAD_ROWS * TILE);
    expect(pavement.y).toBe(road.y + road.height);              // no seam between the two
    for (const b of [road, pavement]) {
      expect(b.x).toBeLessThanOrEqual(-GROUND_OVERSCAN);
      expect(b.x + b.width).toBeGreaterThanOrEqual(W * TILE + GROUND_OVERSCAN);
    }
    expect(pavement.y + pavement.height).toBeGreaterThanOrEqual(H * TILE + GROUND_OVERSCAN);
  });
  it('never reaches up into the building: the tower is drawn, not covered', () => {
    expect(groundBands(BUILDING, TILE, W, H).road.y).toBeGreaterThanOrEqual((BUILDING.y1 + 1) * TILE);
  });
  it('hands the night tint one rectangle over exactly the two bands', () => {
    const g = groundRect(BUILDING, TILE, W, H), { road, pavement } = groundBands(BUILDING, TILE, W, H);
    expect(g.y).toBe(road.y);
    expect(g.y + g.height).toBe(pavement.y + pavement.height);
    expect([g.x, g.width]).toEqual([road.x, road.width]);
  });
  it('meets the building own night tint with no row tinted twice and none missed', () => {
    const n = nightRect(BUILDING, TILE);
    expect(n.y + n.height).toBe(groundRect(BUILDING, TILE, W, H).y);
  });
});

/** Visual QA R-M6: the first sun was four rectangles with the corners taken off, and read as a yellow square. */
describe('a disc on the pixel grid', () => {
  it('is as wide as it is tall, and symmetric about both axes', () => {
    for (const r of [4, 8, 9, 10, 16]) {
      const runs = discRuns(r);
      expect(runs).toHaveLength(2 * r);
      // As wide as it is tall. Floored rather than rounded, this came out two short and the sun was an egg.
      expect(Math.max(...runs.map((x) => x.w))).toBe(2 * r);
      for (const run of runs) expect(run.x0).toBe(-run.w / 2);         // centred on the axis
      const widths = runs.map((x) => x.w);
      expect(widths).toEqual([...widths].reverse());                   // top half mirrors the bottom
    }
  });
  it('is round, not square: the corner rows are much narrower than the middle', () => {
    const runs = discRuns(10);
    expect(runs[0].w).toBeLessThan(runs[10].w / 2);
    expect(runs.every((x) => x.w > 0)).toBe(true);                     // no empty rows inside the silhouette
  });
  it('holds every run inside the circle it claims to be', () => {
    for (const run of discRuns(10)) {
      const dy = run.y + 0.5, dx = run.w / 2;
      expect(Math.hypot(dx, Math.abs(dy)), `row ${run.y}`).toBeLessThanOrEqual(10 + 1);
    }
  });
});

/** The stars are a fixed sequence, so they never crawl between frames or move when the sky is redrawn. */
describe('the stars', () => {
  it('are the same stars every time, and none of them is under the top bar', () => {
    const a = stars(1280, 800), b = stars(1280, 800);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(20);
    for (const s of a) { expect(s.y).toBeGreaterThanOrEqual(52); expect(s.s === 1 || s.s === 2).toBe(true); }
  });
});
