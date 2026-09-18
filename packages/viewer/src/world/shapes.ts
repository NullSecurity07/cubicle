/**
 * The shape library.
 *
 * Everything in the campus is built from five primitives: a rounded polygon, a two-tone fill, a swept shadow, an
 * extruded iso box and an upright panel. Nothing here knows what a desk is; `props.ts` and `characters.ts` compose
 * these. Two rules hold the art direction together:
 *
 *  - every silhouette has rounded corners (`roundPoly`), including the iso quads — a hard vector corner is what
 *    made the tower read as a diagram;
 *  - every face is filled with `twoTone`, a two-stop gradient with a soft seam running from the top-left light to
 *    the bottom-right, so a flat shape still has a lit side without anyone painting a highlight by hand.
 */
import { type Pt, type Rect, type View, quad } from './iso.js';
import { MATERIAL as M, dim, lit, rgba, top, warm } from './materials.js';

export type G = CanvasRenderingContext2D;

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const len = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Path a polygon with rounded corners. `r` is clamped to half of the shortest edge, so tiny shapes stay shapes. */
export function roundPoly(g: G, pts: Pt[], r: number): void {
  const n = pts.length;
  if (n < 3) return;
  let shortest = Infinity;
  for (let i = 0; i < n; i++) shortest = Math.min(shortest, len(pts[i], pts[(i + 1) % n]));
  const rr = Math.max(0, Math.min(r, shortest / 2));
  g.beginPath();
  const s = mid(pts[0], pts[1]);
  g.moveTo(s.x, s.y);
  for (let i = 1; i <= n; i++) {
    const c = pts[i % n];
    const m = mid(pts[i % n], pts[(i + 1) % n]);
    g.arcTo(c.x, c.y, m.x, m.y, rr);
  }
  g.closePath();
}

export function roundRect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** The bounding box of a path's points — the two-tone gradient needs an axis to run along. */
export function bbox(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A flat-shaded fill with one soft seam: light at the top-left, shade at the bottom-right. The two middle stops sit
 * 6 % apart so the eye reads two tones rather than a gradient — flat art with a light in it.
 */
export function twoTone(g: G, b: { x: number; y: number; w: number; h: number }, a: string, c: string, seam = 0.52): CanvasGradient {
  const grad = g.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
  grad.addColorStop(0, a);
  grad.addColorStop(Math.max(0, seam - 0.04), a);
  grad.addColorStop(Math.min(1, seam + 0.04), c);
  grad.addColorStop(1, c);
  return grad;
}

export function fillPoly(g: G, pts: Pt[], r: number, a: string, c?: string, seam?: number): void {
  roundPoly(g, pts, r);
  g.fillStyle = c ? twoTone(g, bbox(pts), a, c, seam) : a;
  g.fill();
}

/** Andrew's monotone chain. Used to sweep a footprint along the light vector into one shadow silhouette. */
export function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (src: Pt[]): Pt[] => {
    const out: Pt[] = [];
    for (const q of src) { while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop(); out.push(q); }
    out.pop();
    return out;
  };
  return [...build(p), ...build([...p].reverse())];
}

/**
 * One long soft shadow, as an alpha gradient.
 *
 * The footprint is swept along the light vector and the hull of the two copies is filled with a gradient that runs
 * from `alpha` at the object's feet to nothing at the far end. Drawn into a separate layer which is composited once
 * through a blur, so the whole scene's shadows share one penumbra instead of each carrying its own `shadowBlur`.
 */
export function sweepShadow(g: G, foot: Pt[], dx: number, dy: number, alpha: number, tint: string): void {
  if (foot.length < 3) return;
  const moved = foot.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  const shape = hull([...foot, ...moved]);
  let cx = 0, cy = 0;
  for (const p of foot) { cx += p.x; cy += p.y; }
  cx /= foot.length; cy /= foot.length;
  const grad = g.createLinearGradient(cx, cy, cx + dx * 1.05, cy + dy * 1.05);
  grad.addColorStop(0, rgba(tint, alpha));
  grad.addColorStop(0.35, rgba(tint, alpha * 0.62));
  grad.addColorStop(1, rgba(tint, 0));
  roundPoly(g, shape, 3);
  g.fillStyle = grad;
  g.fill();
}

/** The footprint of a grid rectangle, for `sweepShadow`. */
export const footprint = (v: View, r: Rect, gz = 0): Pt[] => quad(v, r, gz);

export interface Box extends Rect { z?: number; h: number }

/**
 * An extruded iso box. The silhouette is filled first so the three faces cannot show a seam, then the lit face (the
 * one whose normal points to the lower-left, towards the light) and the top go over it.
 */
export function isoBox(g: G, v: View, b: Box, base: string, opts: { r?: number; topColour?: string } = {}): void {
  const z0 = b.z ?? 0, z1 = z0 + b.h;
  const r = opts.r ?? Math.max(2, 3 * v.z);
  const P = (x: number, y: number, z: number): Pt => v.p(x, y, z);
  const sil = [
    P(b.x0, b.y0, z1), P(b.x1, b.y0, z1), P(b.x1, b.y0, z0),
    P(b.x1, b.y1, z0), P(b.x0, b.y1, z0), P(b.x0, b.y1, z1),
  ];
  fillPoly(g, sil, r, lit(base), dim(base), 0.58);
  // the face at y = y1: normal points to the lower-left, into the light
  fillPoly(g, [P(b.x0, b.y1, z1), P(b.x1, b.y1, z1), P(b.x1, b.y1, z0), P(b.x0, b.y1, z0)], r * 0.7, warm(base, 0.03, 2), lit(base), 0.6);
  // the face at x = x1: turned away
  fillPoly(g, [P(b.x1, b.y0, z1), P(b.x1, b.y1, z1), P(b.x1, b.y1, z0), P(b.x1, b.y0, z0)], r * 0.7, dim(base), warm(base, -0.11, -2), 0.5);
  const t = opts.topColour ?? top(base);
  fillPoly(g, [P(b.x0, b.y0, z1), P(b.x1, b.y0, z1), P(b.x1, b.y1, z1), P(b.x0, b.y1, z1)], r, warm(t, 0.025, 2), t, 0.55);
}

/** A flat patch of floor: one rounded iso quad, no height. */
export function isoSlab(g: G, v: View, r: Rect, a: string, c?: string, radius = 10): void {
  fillPoly(g, quad(v, r), radius * v.z, a, c, 0.5);
}

export type Axis = 'x' | 'y';

export interface PanelSpec {
  /** the face's anchor cell: for axis `x` the low-x end, for axis `y` the low-y end */
  x: number; y: number;
  axis: Axis;
  /** length in cells along the axis */
  len: number;
  /** foot and height, in height units */
  z?: number; h: number;
}

/** The four screen corners of an upright panel's visible face, clockwise from the top-left. */
export function faceQuad(v: View, s: PanelSpec): Pt[] {
  const z0 = s.z ?? 0, z1 = z0 + s.h;
  return s.axis === 'x'
    ? [v.p(s.x, s.y, z1), v.p(s.x + s.len, s.y, z1), v.p(s.x + s.len, s.y, z0), v.p(s.x, s.y, z0)]
    : [v.p(s.x, s.y + s.len, z1), v.p(s.x, s.y, z1), v.p(s.x, s.y, z0), v.p(s.x, s.y + s.len, z0)];
}

/** An upright panel — a partition, a screen, a whiteboard. `thick` adds the cap you see along its top edge. */
export function panel(g: G, v: View, s: PanelSpec, base: string, opts: { r?: number; thick?: number; capColour?: string } = {}): Pt[] {
  const face = faceQuad(v, s);
  const r = opts.r ?? Math.max(2, 4 * v.z);
  fillPoly(g, face, r, lit(base), dim(base), 0.56);
  const t = opts.thick ?? 0;
  if (t > 0) {
    const z1 = (s.z ?? 0) + s.h;
    const cap = s.axis === 'x'
      ? [v.p(s.x, s.y - t, z1), v.p(s.x + s.len, s.y - t, z1), v.p(s.x + s.len, s.y, z1), v.p(s.x, s.y, z1)]
      : [v.p(s.x - t, s.y, z1), v.p(s.x - t, s.y + s.len, z1), v.p(s.x, s.y + s.len, z1), v.p(s.x, s.y, z1)];
    fillPoly(g, cap, r * 0.8, top(opts.capColour ?? base), warm(opts.capColour ?? base, 0.01, 2), 0.6);
  }
  return face;
}

/**
 * Text laid into an upright face. The shear matches the face's own foreshortening — a horizontal step of one pixel
 * becomes (1, ±0.5) — so labels sit *in* the wall instead of floating in front of it.
 */
export function faceText(g: G, at: Pt, axis: Axis, text: string, o: { size: number; colour: string; weight?: number; align?: CanvasTextAlign; font?: string; letter?: string; maxWidth?: number }): void {
  g.save();
  g.translate(at.x, at.y);
  g.transform(1, axis === 'x' ? 0.5 : -0.5, 0, 1, 0, 0);
  let size = o.size;
  if (o.letter) (g as unknown as { letterSpacing: string }).letterSpacing = o.letter;
  // Fit to the face. A line of content that runs off the end of its panel and carries on across the floor is the
  // single fastest way to make a rendered office look unfinished, and it happens at every zoom but the authored one.
  if (o.maxWidth && o.maxWidth > 0) {
    g.font = `${o.weight ?? 500} ${size}px ${o.font ?? UI_FONT}`;
    const w = g.measureText(text).width;
    if (w > o.maxWidth) size = Math.max(4, (size * o.maxWidth) / w);
  }
  g.font = `${o.weight ?? 500} ${size}px ${o.font ?? UI_FONT}`;
  g.textAlign = o.align ?? 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = o.colour;
  g.fillText(text, 0, 0);
  if (o.letter) (g as unknown as { letterSpacing: string }).letterSpacing = '0px';
  g.restore();
}

export const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", sans-serif';
export const MONO_FONT = 'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", "DejaVu Sans Mono", monospace';

/** A soft radial glow — a lamp, a window's spill, the warm halo round a screen. */
export function glow(g: G, at: Pt, r: number, colour: string, alpha: number): void {
  if (r <= 0 || alpha <= 0) return;
  const grad = g.createRadialGradient(at.x, at.y, 0, at.x, at.y, r);
  grad.addColorStop(0, rgba(colour, alpha));
  grad.addColorStop(0.45, rgba(colour, alpha * 0.42));
  grad.addColorStop(1, rgba(colour, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(at.x, at.y, r, 0, Math.PI * 2);
  g.fill();
}

/** An elliptical contact shadow directly under a thing, so nothing floats. */
export function contact(g: G, at: Pt, rx: number, ry: number, alpha: number, tint: string): void {
  const grad = g.createRadialGradient(at.x, at.y, 0, at.x, at.y, Math.max(rx, ry));
  grad.addColorStop(0, rgba(tint, alpha));
  grad.addColorStop(1, rgba(tint, 0));
  g.save();
  g.translate(at.x, at.y);
  g.scale(1, ry / Math.max(rx, ry));
  g.translate(-at.x, -at.y);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(at.x, at.y, Math.max(rx, ry), 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/**
 * Where the labels went this frame, so the next one can get out of the way.
 *
 * Everything that names something in the campus lands on the same plate: a screen, a zone, a desk, a person. Drawn
 * where each of them sits, they pile up — the first render had "Vault" over "CFO" over "Billboard" over "CISO" in
 * one corner of Operations, and two "Backend Engineer" plates crossing each other in Dev (visual QA S9-6). So each
 * plate claims the box it is about to fill; a plate that finds the box taken lifts by its own height and tries
 * again, and one that cannot find room in `lift` tries is not drawn at all. A missing name is a smaller lie than
 * two names on top of each other, and the camera moves, so it comes back.
 *
 * One book per renderer, cleared at the top of every frame. Draw order is priority: whoever asks first, keeps it.
 */
export class Plates {
  private boxes: { x: number; y: number; w: number; h: number }[] = [];
  /** Where a plate may land: inside the canvas, clear of the rail and the two bars. */
  private area = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };
  clear(area?: { x0: number; y0: number; x1: number; y1: number }): void {
    this.boxes.length = 0;
    if (area) this.area = area;
  }
  /** Reserve a rectangle nothing may be drawn under — the minimap, say. Top-left coordinates. */
  block(x: number, y: number, w: number, h: number): void { this.boxes.push({ x: x + w / 2, y: y + h / 2, w, h }); }
  /** Claim a box centred on (x, y). Returns where it ended up, or null when there is no room. */
  claim(x: number, y: number, w: number, h: number, lift: number): { x: number; y: number } | null {
    for (let i = 0; i <= lift; i++) {
      const yy = y - i * (h + 3);
      // Whole, or not at all. A plate half under the zone rail reads as a name the label budget cut off, which is
      // a bug report; the same plate absent reads as a zone the camera has not reached, which is the truth.
      if (x - w / 2 < this.area.x0 || x + w / 2 > this.area.x1 || yy - h / 2 < this.area.y0 || yy + h / 2 > this.area.y1) continue;
      let clear = true;
      for (const b of this.boxes) {
        if (Math.abs(b.x - x) * 2 < b.w + w - 2 && Math.abs(b.y - yy) * 2 < b.h + h - 2) { clear = false; break; }
      }
      if (clear) { this.boxes.push({ x, y: yy, w, h }); return { x, y: yy }; }
    }
    return null;
  }
}

/** The one book the campus draws against. `view.ts` clears it once a frame, before anything is painted. */
export const PLATES = new Plates();

/**
 * A label on a soft plate: UI type, never sheared, never scaled by the camera. Labels are chrome that happens to
 * sit in the world — they stay crisp at every zoom, which is the whole reason they are drawn in screen space.
 *
 * `lift` is how many of its own heights the plate may rise to find clear space; 0 means it will not move but still
 * yields to a plate already there. Pass `crowd: false` for a plate that must always be drawn — a bubble's speaker,
 * an owner's own selection — which then takes its space and lets the rest work round it.
 */
export function plate(g: G, at: Pt, text: string, o: { size?: number; chip?: string; ink?: string; sub?: string; alpha?: number; align?: 'centre' | 'left'; lift?: number; crowd?: boolean } = {}): { w: number; h: number } {
  const size = o.size ?? 12;
  const ink = o.ink ?? M.ink;
  const padX = Math.round(size * 0.75), padY = Math.round(size * 0.42);
  g.save();
  g.font = `600 ${size}px ${UI_FONT}`;
  const tw = g.measureText(text).width;
  let sw = 0;
  if (o.sub) { g.font = `500 ${size - 1}px ${UI_FONT}`; sw = g.measureText(o.sub).width + size * 0.7; }
  const chipW = o.chip ? size * 0.5 + size * 0.45 : 0;
  const w = Math.round(tw + sw + chipW + padX * 2);
  const h = Math.round(size + padY * 2);
  const cx = o.align === 'left' ? at.x + w / 2 : at.x;
  let cy = at.y;
  if (o.crowd !== false) {
    const spot = PLATES.claim(cx, cy, w, h, o.lift ?? 0);
    if (!spot) { g.restore(); return { w: 0, h: 0 }; }
    cy = spot.y;
  }
  const x = cx - w / 2;
  const y = cy - h / 2;
  g.shadowColor = 'rgba(46,38,28,0.22)';
  g.shadowBlur = 10;
  g.shadowOffsetY = 3;
  roundRect(g, x, y, w, h, h / 2);
  g.fillStyle = `rgba(255,255,255,${o.alpha ?? 0.9})`;
  g.fill();
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
  roundRect(g, x + 0.5, y + 0.5, w - 1, h - 1, (h - 1) / 2);
  g.strokeStyle = 'rgba(44,36,26,0.10)';
  g.lineWidth = 1;
  g.stroke();
  let tx = x + padX;
  if (o.chip) {
    roundRect(g, tx, y + h / 2 - size * 0.25, size * 0.5, size * 0.5, size * 0.16);
    g.fillStyle = o.chip;
    g.fill();
    tx += size * 0.5 + size * 0.45;
  }
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = `600 ${size}px ${UI_FONT}`;
  g.fillStyle = ink;
  g.fillText(text, tx, y + h / 2 + 0.5);
  if (o.sub) {
    g.font = `500 ${size - 1}px ${UI_FONT}`;
    g.fillStyle = 'rgba(44,36,26,0.52)';
    g.fillText(o.sub, tx + tw + size * 0.7, y + h / 2 + 0.5);
  }
  g.restore();
  return { w, h };
}

/**
 * A speech bubble in UI type. Rounded, with a short tail towards the speaker; the same plate material as a label so
 * the overlay and the world share one surface.
 */
export function bubble(g: G, at: Pt, lines: string[], o: { size?: number; max?: number; tail?: 'left' | 'right'; ink?: string; tint?: string; within?: { w: number; h: number } } = {}): void {
  const size = o.size ?? 12.5;
  const ink = o.ink ?? M.bubbleInk;
  const padX = Math.round(size * 0.92), padY = Math.round(size * 0.62);
  const lh = Math.round(size * 1.32);
  g.save();
  g.font = `500 ${size}px ${UI_FONT}`;
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, g.measureText(l).width);
  const w = Math.round(tw + padX * 2);
  const h = Math.round(lines.length * lh + padY * 2);
  // Inside the frame, always. A bubble centred on someone standing near the right-hand edge used to run off the
  // screen and the owner read half a sentence (visual QA S9-5); pushed back in, the tail still points at whoever
  // said it, which is the only thing the position has to carry.
  const m = 12;
  let x = at.x - w / 2;
  let y = at.y - h;
  if (o.within) {
    x = Math.max(m, Math.min(o.within.w - w - m, x));
    y = Math.max(m, Math.min(o.within.h - h - m, y));
  }
  g.shadowColor = 'rgba(40,32,24,0.26)';
  g.shadowBlur = 14;
  g.shadowOffsetY = 4;
  roundRect(g, x, y, w, h, Math.min(13, h / 2.2));
  g.fillStyle = o.tint ?? 'rgba(255,255,255,0.96)';
  g.fill();
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
  // the tail: a rounded wedge under the body, pointing down at the speaker
  const tx = Math.max(x + 12, Math.min(x + w - 12, at.x + (o.tail === 'left' ? -w * 0.24 : w * 0.24)));
  fillPoly(g, [{ x: tx - 6, y: y + h - 2 }, { x: tx + 6, y: y + h - 2 }, { x: tx + (o.tail === 'left' ? -3 : 3), y: y + h + 8 }], 2.5, o.tint ?? 'rgba(255,255,255,0.96)');
  roundRect(g, x + 0.5, y + 0.5, w - 1, h - 1, Math.min(12.5, (h - 1) / 2.2));
  g.strokeStyle = 'rgba(40,32,24,0.09)';
  g.lineWidth = 1;
  g.stroke();
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = ink;
  lines.forEach((l, i) => { g.fillText(l, x + padX, y + padY + lh * i + lh / 2); });
  g.restore();
}
