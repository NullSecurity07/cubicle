/**
 * The campus clip: the shape the office may paint into, and the two facts the frame rate rests on.
 *
 * The clip used to be a rounded path, and a rounded path is a mask: 28 fps where the same office with a six-edge
 * clip holds 60. So the clip is the bare silhouette, the rounding is painted back over a sliver, and the whole
 * thing is skipped when the silhouette is bigger than the canvas. Each of those is only safe if the geometry says
 * so, which is what this file checks — none of it needs a canvas.
 */
import { describe, expect, it } from 'vitest';
import { campusCovers, campusHull, campusRound } from './paint.js';
import { roundPolyPoints, roundPolyReach } from './shapes.js';
import { Camera } from './camera.js';
import type { View } from './iso.js';
import type { CampusMap } from './campus.js';

const map = { width: 40, height: 28 } as CampusMap;
const bounds = { x0: 0, y0: 0, x1: map.width, y1: map.height };

/** A camera framing the campus the way the viewer does, at a given zoom and centre. */
const viewAt = (zoom: number, tx: number, ty: number, w = 1280, h = 800): View =>
  new Camera({ w, h, bounds, at: { x: tx, y: ty }, zoom }).view();

describe('the campus silhouette', () => {
  it('is six points, whatever the zoom — the clip has to stay under nine edges to keep the fast path', () => {
    for (const z of [0.4, 0.8, 1.6, 3]) expect(campusHull(viewAt(z, 20, 14), map).length).toBe(6);
  });

  it('is convex, so a point inside every edge is a point inside the shape', () => {
    const h = campusHull(viewAt(1.2, 20, 14), map);
    const cross = (i: number): number => {
      const a = h[i], b = h[(i + 1) % h.length], c = h[(i + 2) % h.length];
      return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    };
    const signs = h.map((_, i) => Math.sign(cross(i))).filter((s) => s !== 0);
    expect(new Set(signs).size).toBe(1);
  });
});

describe('the rounded silhouette, as points', () => {
  it('stays inside the square one — the rounding only ever takes pixels away', () => {
    const v = viewAt(1.2, 20, 14);
    const h = campusHull(v, map);
    const r = roundPolyPoints(h, campusRound(v));
    // every rounded point is inside (or on) every edge of the hull
    for (let i = 0; i < h.length; i++) {
      const a = h[i], b = h[(i + 1) % h.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const side = (p: { x: number; y: number }): number => ex * (p.y - a.y) - ey * (p.x - a.x);
      const inward = Math.sign(side(h[(i + 2) % h.length]));
      for (const p of r) expect(Math.sign(side(p)) === inward || Math.abs(side(p)) < 1e-6).toBe(true);
    }
  });

  it('follows the corner within a quarter of a pixel, so the chords cannot be seen', () => {
    const v = viewAt(1.2, 20, 14);
    const rr = campusRound(v);
    const pts = roundPolyPoints(campusHull(v, map), rr);
    // the deepest a chord can cut under its own arc, for the step this uses
    const sag = rr * (1 - Math.cos(Math.PI / 30));
    expect(sag).toBeLessThan(0.25);
    expect(pts.length).toBeGreaterThan(6);
  });

  it('is the polygon itself when the radius is zero', () => {
    const h = campusHull(viewAt(1, 20, 14), map);
    expect(roundPolyPoints(h, 0)).toEqual(h);
  });

  it('leaves the edge alone past each corner\'s reach — that is what the trim may touch', () => {
    const v = viewAt(1.2, 20, 14);
    const h = campusHull(v, map);
    const reach = roundPolyReach(h, campusRound(v));
    expect(reach.every((t) => t > 0)).toBe(true);
    // every rounded point is within its own corner's reach of some hull point: past that the two outlines are
    // the same line, so repainting there could only cost the edge its antialiasing
    for (const p of roundPolyPoints(h, campusRound(v))) {
      const near = h.some((c, i) => Math.hypot(p.x - c.x, p.y - c.y) <= reach[i] + 1e-6);
      expect(near).toBe(true);
    }
  });
});

describe('when the silhouette covers the canvas', () => {
  it('says yes over the middle of the campus, close in', () => {
    expect(campusCovers(viewAt(3, 20, 14), map)).toBe(true);
  });

  it('says no at the campus fit, where the office has an edge on the screen', () => {
    expect(campusCovers(viewAt(0.35, 20, 14), map)).toBe(false);
  });

  it('says no at a corner of the campus, where one corner of the canvas is off the slab', () => {
    expect(campusCovers(viewAt(3, 1, 1), map)).toBe(false);
  });

  it('never says yes while a hull point is on the screen', () => {
    for (const z of [0.3, 0.5, 0.9, 1.4, 2.2, 3.5]) {
      for (const [tx, ty] of [[20, 14], [4, 4], [36, 24], [20, 2], [2, 14]] as [number, number][]) {
        const v = viewAt(z, tx, ty);
        if (!campusCovers(v, map)) continue;
        for (const p of campusHull(v, map)) {
          const onScreen = p.x >= 0 && p.x <= v.cam.w && p.y >= 0 && p.y <= v.cam.h;
          expect(onScreen, `zoom ${z} at ${tx},${ty}`).toBe(false);
        }
      }
    }
  });
});
