/**
 * The minimap: the campus as a small isometric thumbnail, with the viewport over it.
 *
 * It is the same projection as the office, not a plan view — a plan of an isometric room is a second, different
 * picture of the same place, and the owner then has to translate between them. The thumbnail is the slab, the zone
 * rugs in their own accents, the partitions as hairlines, a dot per person, and the four corners of what the main
 * camera can see.
 */
import { type Cell, type Pt, type Rect, iso, quad, view } from './iso.js';
import { ACCENT, MATERIAL as M, rgba } from './materials.js';
import { roundPoly } from './shapes.js';
import type { CampusMap } from './campus.js';
import type { Camera } from './camera.js';

export interface Dot { x: number; y: number; colour: string }

/**
 * The thumbnail is drawn a little low in its box, so the back walls and the zone plates along the top edge are not
 * clipped. Both the renderer and the click unprojection read this, or a click would land where nothing was drawn.
 */
export const MINIMAP_PAN = { x: 0, y: 6 } as const;

/** The zoom at which the whole campus fits a box of `w` x `h`, with `pad` px to spare. */
export function thumbZoom(m: Pick<CampusMap, 'width' | 'height'>, w: number, h: number, pad = 8): number {
  const span = m.width + m.height;
  return Math.min((w - pad * 2) / (span * 32), (h - pad * 2) / (span * 16 + 60));
}

/**
 * Draw the thumbnail. `canvas` is sized in CSS pixels by the chrome around it; this owns its backing store, so a
 * device-pixel-ratio change is handled here and nowhere else.
 */
export function drawMinimap(canvas: HTMLCanvasElement, m: CampusMap, cam: Camera, dots: Dot[]): void {
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const w = canvas.clientWidth || 196, h = canvas.clientHeight || 112;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const z = thumbZoom(m, w, h);
  const v = view({ at: { x: m.width / 2, y: m.height / 2 }, zoom: z, w, h, pan: MINIMAP_PAN });
  const slab: Rect = { x0: 0, y0: 0, x1: m.width, y1: m.height };

  roundPoly(g, quad(v, slab), 5);
  g.fillStyle = rgba(M.floor, 0.92);
  g.fill();
  g.strokeStyle = rgba(M.ink, 0.16);
  g.lineWidth = 1;
  g.stroke();

  for (const zone of m.zones) {
    const a = ACCENT[zone.accent];
    roundPoly(g, quad(v, zone.rect), 3);
    g.fillStyle = rgba(a.rug, zone.accent === 'neutral' ? 0.6 : 0.95);
    g.fill();
  }
  g.lineWidth = 1;
  for (const p of m.partitions) {
    const a = p.axis === 'x' ? v.p(p.x, p.y, 0) : v.p(p.x, p.y, 0);
    const b = p.axis === 'x' ? v.p(p.x + p.len, p.y, 0) : v.p(p.x, p.y + p.len, 0);
    g.strokeStyle = rgba(ACCENT[p.accent].base, 0.5);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  for (const d of dots) {
    const p = v.p(d.x, d.y, 0);
    g.beginPath();
    g.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    g.fillStyle = d.colour;
    g.fill();
  }

  // the viewport: the four screen corners of the main camera, unprojected onto the floor and drawn here
  const corners = viewportQuad(cam).map((c) => v.p(c.x, c.y, 0));
  g.beginPath();
  corners.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  g.strokeStyle = M.attention;
  g.lineWidth = 1.5;
  g.stroke();
  g.fillStyle = rgba(M.attention, 0.12);
  g.fill();
}

/** The main camera's four screen corners, as grid cells on the floor plane. */
export function viewportQuad(cam: Camera): Cell[] {
  return [cam.toGrid(0, 0), cam.toGrid(cam.w, 0), cam.toGrid(cam.w, cam.h), cam.toGrid(0, cam.h)];
}

/** A minimap point → the grid cell under it, so a click on the thumbnail can move the camera. */
export function minimapToGrid(px: number, py: number, m: Pick<CampusMap, 'width' | 'height'>, w: number, h: number): Cell {
  const z = thumbZoom(m, w, h);
  const o = iso(m.width / 2, m.height / 2, 0);
  const ox = w / 2 - o.x * z + MINIMAP_PAN.x, oy = h / 2 - o.y * z + MINIMAP_PAN.y;
  const wx = (px - ox) / z, wy = (py - oy) / z;
  return { x: wx / 64 + wy / 32, y: wy / 32 - wx / 64 };
}

export type { Pt };
