import { describe, it, expect } from 'vitest';
import { chromeVisibility, minimapWanted, MINIMAP_W, MINIMAP_H } from './minimap.js';
import { minimapToGrid, thumbZoom, viewportQuad } from '../world/minimap-draw.js';
import { Camera } from '../world/camera.js';

const CAMPUS = { width: 52, height: 36 };

describe('the minimap thumbnail', () => {
  it('fits the whole campus in its box, with air to spare', () => {
    const z = thumbZoom(CAMPUS, MINIMAP_W, MINIMAP_H);
    expect(z).toBeGreaterThan(0);
    expect((CAMPUS.width + CAMPUS.height) * 32 * z).toBeLessThanOrEqual(MINIMAP_W);
    expect((CAMPUS.width + CAMPUS.height) * 16 * z).toBeLessThanOrEqual(MINIMAP_H);
  });
  it('a click in the middle of the thumbnail is the middle of the campus', () => {
    const c = minimapToGrid(MINIMAP_W / 2, MINIMAP_H / 2, CAMPUS, MINIMAP_W, MINIMAP_H);
    // the projection is shifted down a little to leave room for the back walls, so the middle lands a touch short
    expect(c.x + c.y).toBeCloseTo(CAMPUS.width / 2 + CAMPUS.height / 2, 0);
  });
  it('clicking to the right of the middle moves along +x, and below it along both', () => {
    const mid = minimapToGrid(MINIMAP_W / 2, MINIMAP_H / 2, CAMPUS, MINIMAP_W, MINIMAP_H);
    const right = minimapToGrid(MINIMAP_W / 2 + 20, MINIMAP_H / 2, CAMPUS, MINIMAP_W, MINIMAP_H);
    expect(right.x).toBeGreaterThan(mid.x);
    expect(right.y).toBeLessThan(mid.y);
    const down = minimapToGrid(MINIMAP_W / 2, MINIMAP_H / 2 + 20, CAMPUS, MINIMAP_W, MINIMAP_H);
    expect(down.x).toBeGreaterThan(mid.x);
    expect(down.y).toBeGreaterThan(mid.y);
  });
  it('the viewport quad is the four screen corners of the main camera, in grid cells', () => {
    const cam = new Camera({ w: 1280, h: 800, bounds: { x0: 0, y0: 0, x1: 52, y1: 36 } });
    cam.panTo({ x: 26, y: 18 }, { zoom: 1, now: true });
    const q = viewportQuad(cam);
    expect(q).toHaveLength(4);
    // top-left of the screen is the smallest x + y on the floor; bottom-right the largest
    expect(q[0].x + q[0].y).toBeLessThan(q[2].x + q[2].y);
  });
});

describe('when the strip belongs on the screen', () => {
  it('is away at the campus overview and back once the camera is closer', () => {
    expect(minimapWanted(0.42, 0.42)).toBe(false);
    expect(minimapWanted(0.5, 0.42)).toBe(false);
    expect(minimapWanted(0.9, 0.42)).toBe(true);
  });
  it('the Map button only offers to undo a minimap the owner hid themselves', () => {
    expect(chromeVisibility(true, null)).toEqual({ strip: true, showBtn: false });
    expect(chromeVisibility(false, null)).toEqual({ strip: false, showBtn: false });
    expect(chromeVisibility(false, false)).toEqual({ strip: false, showBtn: true });
  });
});
