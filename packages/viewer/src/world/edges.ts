/**
 * The lines on the floor, and the ports they start from.
 *
 * A connection is a permission, and the office draws it as what it is: a line between two things, lying on the
 * floor under everything that stands, so it never comes between the owner and a person. It is a diagram, not a
 * path — it does not route round the furniture, because it is not describing a walk.
 *
 * The geometry is in grid space and the maths is here, not in the renderer: a quadratic whose control point is the
 * midpoint pushed a little to one side, so two desks facing each other are joined by a bow rather than by a rule,
 * and a line never disappears into the edge of the desk it ends at. Everything below `draw` is pure, which is what
 * lets the hit test be tested without a canvas.
 */
import type { Pt, Rect, View } from './iso.js';
import { type Light, MATERIAL as M, mix, onFloorInk, rgba } from './materials.js';
import { type G, roundRect, UI_FONT } from './shapes.js';
import { type Anchor, type ConnectionKind } from './layout.js';

/** How far the curve bows off the straight line, as a fraction of its own length. */
export const BOW = 0.13;
/** The two ends stop this far short of the things they join, so a line never grows out from under a desk. */
export const END_GAP = 0.34;

export interface Curve { from: Pt; ctrl: Pt; to: Pt }

/**
 * The curve between two points on the floor.
 *
 * Both ends are pulled back by `END_GAP` along the line, so the line runs *between* two objects rather than out
 * of the middle of them, and the control point is the midpoint pushed perpendicular — always the same way round,
 * so a pair joined from either end is drawn as one line in one place.
 */
export function edgeCurve(a: Pt, b: Pt, gap = END_GAP): Curve {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const g = Math.min(gap, len * 0.3);
  const from = { x: a.x + ux * g, y: a.y + uy * g };
  const to = { x: b.x - ux * g, y: b.y - uy * g };
  // the bow is a share of the line that is actually drawn, not of the gap between the two objects, so a short line
  // between two neighbouring desks is a gentle curve rather than a loop
  const bow = Math.hypot(to.x - from.x, to.y - from.y) * BOW;
  return { from, to, ctrl: { x: (from.x + to.x) / 2 - uy * bow, y: (from.y + to.y) / 2 + ux * bow } };
}

/** A point along the curve, `t` from 0 at `from` to 1 at `to`. */
export function pointOn(c: Curve, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * c.from.x + 2 * u * t * c.ctrl.x + t * t * c.to.x,
    y: u * u * c.from.y + 2 * u * t * c.ctrl.y + t * t * c.to.y,
  };
}

/** Where a connection's line touches a thing: the middle of its footprint. */
export const edgeEnd = (a: Anchor): Pt => a.at;

/**
 * The port a drag starts from: the corner of a thing nearest the camera.
 *
 * The camera looks in from the `+x +y` corner of the plane, so that corner is the one closest to the owner and
 * the one nothing else is standing in front of. One port per thing, and it is always in the same place, so the
 * gesture is learnt once.
 */
export const portAt = (r: Rect): Pt => ({ x: r.x1, y: r.y1 });
/** How big the port ring is on the screen, and how near the pointer has to be to grab it. */
export const PORT_R = 10;
export const PORT_HIT = 14;

/** Is the pointer on this line? Sampled along the projected curve, which is cheap and exact enough at 2 px. */
export function edgeHit(v: View, c: Curve, px: number, py: number, tol = 8): boolean {
  let prev = v.p(c.from.x, c.from.y, 0);
  for (let i = 1; i <= 18; i++) {
    const p = pointOn(c, i / 18);
    const s = v.p(p.x, p.y, 0);
    if (segDist(prev, s, px, py) <= tol) return true;
    prev = s;
  }
  return false;
}

/** Distance from a point to a segment, in screen pixels. */
export function segDist(a: Pt, b: Pt, px: number, py: number): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* drawing                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The ink a line is drawn in.
 *
 * Slate at 55 %: present in the picture, never louder than a person. The accent is spent on one thing at a time
 * and a selected line is that thing, so the selected state is the only place a line is coloured. `tokens.test.ts`
 * holds these against the floor in both themes.
 */
/**
 * A resting line is scenery: the campus's own ink at 55 %, drawn on the floor under everything that stands, where
 * the hour's multiply reaches it like every other surface in the room. The spec said slate, and slate at 55 % over
 * an off-white floor measures 1.9:1 — a line the owner cannot see is not a line, so it is the ink instead, at the
 * alpha the spec asked for. 3.3:1 against the floor it lies on.
 */
export const EDGE_INK = M.ink;
export const EDGE_ALPHA = 0.55;

/**
 * A selected line is a control, and a control has to hold at every hour.
 *
 * So it is drawn *over* the hour rather than under it, and it is cased: a wider stroke in whichever of the two
 * extremes the floor is not (`onFloorInk`), with the accent running down the middle of it. The casing is what
 * carries the contrast — over 3:1 at noon, at dusk and at midnight — and the accent is what says it is the one
 * selected thing. No single colour does both jobs on a floor that goes from cream to navy over twelve hours.
 */
export const EDGE_SELECTED = M.attention;

export interface EdgeStyle { kind: ConnectionKind; selected?: boolean; hovered?: boolean; light?: Light }

/** One line on the floor. */
export function drawEdge(g: G, v: View, c: Curve, style: EdgeStyle): void {
  const a = v.p(c.from.x, c.from.y, 0), b = v.p(c.to.x, c.to.y, 0), k = v.p(c.ctrl.x, c.ctrl.y, 0);
  const path = (): void => { g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(k.x, k.y, b.x, b.y); g.stroke(); };
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const dash = (): void => { if (style.kind === 'access') g.setLineDash([Math.max(4, 6 * v.z), Math.max(3, 4.5 * v.z)]); };
  if (style.selected && style.light) {
    // The casing is solid even under a dashed line. Cased dash by dash, an access line came out as a string of
    // amber beads rather than as one line the eye can follow (visual QA SP9b-5).
    g.strokeStyle = rgba(onFloorInk(style.light), 0.9);
    g.lineWidth = Math.max(3.4, 5 * Math.max(0.7, v.z));
    path();
    dash();
    g.strokeStyle = rgba(EDGE_SELECTED, 0.98);
    g.lineWidth = Math.max(1.6, 3 * Math.max(0.7, v.z));
    path();
    g.restore();
    return;
  }
  dash();
  g.strokeStyle = rgba(EDGE_INK, style.hovered ? EDGE_ALPHA + 0.18 : EDGE_ALPHA);
  g.lineWidth = Math.max(1.4, 2 * Math.max(0.7, v.z));
  path();
  g.restore();
}

/** The ⓧ chip at the middle of the selected line: the one place a line can be cut with the pointer. */
export function drawCutChip(g: G, v: View, c: Curve, light?: Light): { x: number; y: number; r: number } {
  const mid = pointOn(c, 0.5);
  const p = v.p(mid.x, mid.y, 0);
  const r = 9;
  g.save();
  g.shadowColor = 'rgba(40,32,24,0.3)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 2;
  g.beginPath();
  g.arc(p.x, p.y, r, 0, Math.PI * 2);
  g.fillStyle = M.attention;
  g.fill();
  g.shadowColor = 'transparent';
  if (light) { g.strokeStyle = rgba(onFloorInk(light), 0.35); g.lineWidth = 1; g.stroke(); }
  g.strokeStyle = rgba(M.actionFill, 0.9);
  g.lineWidth = 1.8;
  g.lineCap = 'round';
  const d = 3.4;
  g.beginPath();
  g.moveTo(p.x - d, p.y - d); g.lineTo(p.x + d, p.y + d);
  g.moveTo(p.x + d, p.y - d); g.lineTo(p.x - d, p.y + d);
  g.stroke();
  g.restore();
  return { x: p.x, y: p.y, r: r + 4 };
}

/**
 * The port ring on a hovered thing, and the one the owner is dragging out of.
 *
 * A white disc with the thing's own accent round it and a dot in the middle: the accent has 3:1 against the disc
 * it sits on, whatever the hour, because the disc is drawn over the hour and is always white. The hairline round
 * the outside is what separates the disc from a floor that is nearly white at noon.
 */
export function drawPort(g: G, v: View, at: Pt, accent: string, o: { active?: boolean; light?: Light } = {}): void {
  const p = v.p(at.x, at.y, 0.02);
  g.save();
  g.beginPath();
  g.arc(p.x, p.y, PORT_R, 0, Math.PI * 2);
  g.fillStyle = rgba(PORT_FILL, o.active ? 0.98 : 0.92);
  g.fill();
  if (o.light) { g.strokeStyle = rgba(onFloorInk(o.light), 0.32); g.lineWidth = 1; g.stroke(); }
  g.beginPath();
  g.arc(p.x, p.y, PORT_R - 2, 0, Math.PI * 2);
  g.strokeStyle = accent;
  g.lineWidth = o.active ? 3.2 : 2.4;
  g.stroke();
  g.beginPath();
  g.arc(p.x, p.y, o.active ? 3.2 : 2.4, 0, Math.PI * 2);
  g.fillStyle = accent;
  g.fill();
  g.restore();
}

/** The disc a port's ring is drawn on. White at every hour, so one assertion covers the ring at all of them. */
export const PORT_FILL = M.white;

/** The rubber band, while a line is being drawn out of a port to wherever the pointer is. */
export function drawRubberBand(g: G, v: View, from: Pt, to: Pt, ok: boolean): void {
  const c = edgeCurve(from, to, 0.1);
  const a = v.p(c.from.x, c.from.y, 0), b = v.p(c.to.x, c.to.y, 0), k = v.p(c.ctrl.x, c.ctrl.y, 0);
  g.save();
  g.lineCap = 'round';
  g.setLineDash([Math.max(5, 8 * v.z), Math.max(4, 6 * v.z)]);
  g.strokeStyle = rgba(ok ? M.attention : EDGE_INK, ok ? 0.95 : 0.4);
  g.lineWidth = Math.max(1.6, 2.4 * Math.max(0.7, v.z));
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.quadraticCurveTo(k.x, k.y, b.x, b.y);
  g.stroke();
  g.restore();
}

/**
 * A thing this line may legally land on.
 *
 * `soft` is every other candidate on the screen: a hairline, so the owner can see at a glance which things a
 * line can reach without forty desks lighting up at once. The one under the pointer gets the full ring — one
 * loud thing at a time is the rule the whole office keeps.
 */
export function drawTargetGlow(g: G, v: View, r: Rect, o: { soft?: boolean } = {}): void {
  const pad = o.soft ? 0.1 : 0.18;
  const pts = [v.p(r.x0 - pad, r.y0 - pad, 0), v.p(r.x1 + pad, r.y0 - pad, 0), v.p(r.x1 + pad, r.y1 + pad, 0), v.p(r.x0 - pad, r.y1 + pad, 0)];
  g.save();
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
  g.closePath();
  if (!o.soft) { g.fillStyle = rgba(M.attention, 0.14); g.fill(); }
  g.strokeStyle = rgba(M.attention, o.soft ? 0.3 : 0.75);
  g.lineWidth = o.soft ? 1.2 : 2;
  g.stroke();
  g.restore();
}

/** A zone's corner handle: a small square the owner can take hold of, in the zone's own accent. */
export function drawHandle(g: G, at: Pt, accent: string): void {
  const r = 7;
  g.save();
  g.shadowColor = 'rgba(40,32,24,0.25)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 2;
  roundRect(g, at.x - r, at.y - r, r * 2, r * 2, 3);
  g.fillStyle = M.white;
  g.fill();
  g.shadowColor = 'transparent';
  roundRect(g, at.x - r + 1, at.y - r + 1, r * 2 - 2, r * 2 - 2, 2.5);
  g.strokeStyle = accent;
  g.lineWidth = 2;
  g.stroke();
  g.restore();
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the pulse                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** How long a message takes to travel its line, and how big the travelling dot is. */
export const PULSE_MS = 600;
export const PULSE_R = 6;

export interface Pulse { from: string; to: string; at: number }

/**
 * Whether a message should travel at all.
 *
 * Two rules, and both of them matter. A message only travels a line that exists — a pulse down a line the owner
 * has cut would say the office still allows something it does not. And it does not travel under reduced motion:
 * a dot crossing the floor every time anyone speaks is the one thing in this office that moves for its own sake,
 * so it is also the first thing to go when the owner has asked for less of it.
 */
export const shouldPulse = (connected: boolean, reduced: boolean): boolean => connected && !reduced;

/** A pulse's position along its line, or null once it has arrived. */
export function pulseT(p: Pulse, now: number): number | null {
  const t = (now - p.at) / PULSE_MS;
  return t >= 0 && t <= 1 ? t : null;
}

/**
 * The one memorable motion in the office: a message travelling the line it is allowed to travel.
 *
 * Six pixels across, with a warm halo behind it and a hairline of the hour's own ink round it, so it is the same
 * dot on a cream floor at noon and on a navy one at midnight. Drawn over the hour, like the selected line.
 */
export function drawPulse(g: G, v: View, c: Curve, t: number, light?: Light): void {
  const at = pointOn(c, ease(t));
  const p = v.p(at.x, at.y, 0.02);
  const fade = t < 0.12 ? t / 0.12 : t > 0.86 ? (1 - t) / 0.14 : 1;
  g.save();
  const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, PULSE_R * 2.4);
  grad.addColorStop(0, rgba(M.attention, 0.5 * fade));
  grad.addColorStop(1, rgba(M.attention, 0));
  g.fillStyle = grad;
  g.beginPath(); g.arc(p.x, p.y, PULSE_R * 2.4, 0, Math.PI * 2); g.fill();
  g.beginPath();
  g.arc(p.x, p.y, PULSE_R / 2, 0, Math.PI * 2);
  g.fillStyle = rgba(mix(M.attention, M.white, 0.35), 0.98 * fade);
  g.fill();
  if (light) { g.strokeStyle = rgba(onFloorInk(light), 0.5 * fade); g.lineWidth = 1.2; g.stroke(); }
  g.restore();
}

/** Cubic ease-in-out: a message leaves and arrives gently, which is what makes it read as travelling. */
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** The small plate over a hovered line saying what it permits. */
export function edgeLegend(kind: ConnectionKind): string {
  return kind === 'peer' ? 'Can message each other' : 'Can use this';
}

export { rgba, roundRect, UI_FONT, type Light };
