/**
 * The campus, painted.
 *
 * Five passes, in this order, and the order is the contract:
 *
 *   1. the ground and the slab — the floor is a plate that floats, so an open plan still has an edge
 *   2. the floor dressing — window pools, walkways, the accent rug per zone
 *   3. the world, back to front by `x + y` on the single plane, people interleaved with the furniture
 *   4. the hour, as one multiply over the campus plus the bloom back in
 *   5. UI type — zone plates, desk plates, name plates, speech bubbles — in screen space, never sheared
 *
 * Nothing here owns a canvas or a camera; `view.ts` does. This file turns map data into `Drawable`s and knows the
 * order they go in, which is what makes both the live renderer and the minimap thumbnail able to use it.
 */
import { type Rect, type View, quad } from './iso.js';
import { ACCENT, type AccentName, type Light, MATERIAL as M, mix, rgba, shade, warm } from './materials.js';
import { type G, fillPoly, hull, plate, roundPoly } from './shapes.js';
import {
  type Drawable, boardTable, chair, counter, curtainWall, desk, floorLamp, glassWall, highTable, path, plant, rug,
  screen, shelf, stool, windowPools,
} from './props.js';
import type { CampusMap } from './campus.js';

export interface ScreenContent {
  lines?: string[];
  image?: CanvasImageSource | null;
  live?: boolean;
}
export type ScreenSource = (kind: string) => ScreenContent;

const ACCENT_CHIP: Record<string, string> = Object.fromEntries(Object.entries(ACCENT).map(([k, a]) => [k, a.chip]));
export const accentChip = (name: string): string => ACCENT_CHIP[name] ?? ACCENT_CHIP.neutral;

/** The campus slab: the whole plate the office is poured on. */
export const slabOf = (m: Pick<CampusMap, 'width' | 'height'>): Rect => ({ x0: 0, y0: 0, x1: m.width, y1: m.height });

/**
 * Everything in the campus that is not a person, in one list, already in the order the map declares.
 *
 * Built once when the map loads. Nothing in it depends on the camera or the hour — a `Drawable` is handed both
 * when it draws — so this is the one allocation the office makes for its furniture.
 */
export function buildProps(m: CampusMap): Drawable[] {
  const out: Drawable[] = [];
  out.push(windowPools(m.width, 'x', m.wall), windowPools(m.height, 'y', m.wall));
  for (const p of m.paths) out.push(path(p));
  for (const z of m.zones) out.push(rug(z.rect, z.accent, { alpha: z.accent === 'neutral' ? 0.72 : 0.92 }));
  out.push(curtainWall(m.width, 'x', { thick: m.wall }), curtainWall(m.height, 'y', { thick: m.wall }));
  for (const p of m.partitions) out.push(glassWall({ x: p.x, y: p.y, axis: p.axis, len: p.len, z: 0, h: p.h }, p.accent));
  for (const p of m.props) {
    switch (p.kind) {
      case 'boardtable': out.push(boardTable(p.rect)); break;
      case 'counter': out.push(counter(p.rect)); break;
      case 'hightable': out.push(highTable(p.at.x, p.at.y)); break;
      case 'stool': out.push(stool(p.at.x, p.at.y)); break;
      case 'floorlamp': out.push(floorLamp(p.at.x, p.at.y)); break;
      case 'shelf': out.push(shelf(p.at.x, p.at.y, Number(p.props.w ?? 3), 0.75, String(p.props.accent ?? 'neutral') as AccentName)); break;
      case 'plant': out.push(plant(p.at.x, p.at.y, Number(p.props.size ?? 1))); break;
      case 'chair': out.push(chair(p.at.x, p.at.y, (String(p.props.facing ?? 'se') as 'se' | 'sw' | 'ne' | 'nw'))); break;
      default: break;
    }
  }
  for (const d of Object.values(m.desks)) {
    const w = d.rect.x1 - d.rect.x0, dd = d.rect.y1 - d.rect.y0;
    out.push(chair(d.rect.x0 + w / 2 - 0.46, d.side === 'near' ? d.rect.y1 + 0.56 : d.rect.y0 - 1.28, d.side === 'near' ? 'nw' : 'se'));
    out.push(desk(d.rect.x0, d.rect.y0, w, dd, { accent: d.accent, side: d.side, lamp: d.lamp, papers: d.papers }));
  }
  return out;
}

/**
 * The ten screens, rebuilt each frame from whatever they are showing.
 *
 * They are the one family of props whose content changes between frames, so they are not in `buildProps`: a
 * terminal that redraws only when the furniture does is a terminal showing last minute's output.
 */
export function buildScreens(m: CampusMap, content: ScreenSource): Drawable[] {
  return Object.values(m.screens).map((s) => {
    const c = content(s.kind);
    return screen({
      x: s.x, y: s.y, axis: s.axis, len: s.len, z: s.z, h: s.h,
      name: nameOf(s.label, s.kind), line: s.line, accent: s.accent, kind: s.face, pier: s.pier,
      ...(c.lines && c.lines.length ? { lines: c.lines } : {}),
      ...(c.image ? { image: c.image } : {}),
      ...(c.live ? { live: true } : {}),
    });
  });
}

/** "Terminal — shell output" is a caption; the plate wants the name. */
export function nameOf(label: string, kind: string): string {
  const head = label.split('—')[0].trim();
  return head || kind;
}

/* -------------------------------------------------------------------------------------------------------- */
/* the passes                                                                                                */
/* -------------------------------------------------------------------------------------------------------- */

/** Path the campus slab: the floor plate and nothing standing on it. */
export function slabPath(g: G, v: View, m: CampusMap): void {
  roundPoly(g, quad(v, slabOf(m)), 26 * v.z);
}

/**
 * What the campus may paint into: the slab *swept upwards* by the height of the tallest thing on it.
 *
 * Clipping to the floor quad alone looks right until something stands near a back wall, because a wall at `y = 0`
 * rises off the top edge of that quad and is cut away — which is how the curtain wall, the whiteboard and every
 * window came to be missing from the first renders while every desk in the middle of the floor survived.
 */
export function campusClip(g: G, v: View, m: CampusMap, headUnits = 4.4): void {
  const base = quad(v, slabOf(m));
  const lift = headUnits * v.cz;
  roundPoly(g, hull([...base, ...base.map((p) => ({ x: p.x, y: p.y - lift }))]), 22 * v.z);
}

/** Pass 1: the ground the slab floats on, and the slab itself. */
export function paintGround(g: G, v: View, m: CampusMap, light: Light): void {
  const { w, h } = v.cam;
  const SLAB = slabOf(m);
  const ground = g.createLinearGradient(0, 0, w * 0.6, h);
  ground.addColorStop(0, light.groundFrom);
  ground.addColorStop(1, light.groundTo);
  g.fillStyle = ground;
  g.fillRect(0, 0, w, h);
  const bloom = g.createRadialGradient(w * 0.16, -h * 0.1, 0, w * 0.16, -h * 0.1, h * 1.5);
  bloom.addColorStop(0, rgba(light.name === 'dusk' ? M.bloomDusk : light.name === 'night' ? M.bloomNight : M.bloomDay, light.name === 'dusk' ? 0.2 : 0.1));
  bloom.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = bloom;
  g.fillRect(0, 0, w, h);

  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = 46;
  g.shadowOffsetY = 26;
  fillPoly(g, quad(v, SLAB, -0.42), 26 * v.z, shade(M.slabEdge, -0.12), shade(M.slabEdge, -0.24));
  g.restore();
  fillPoly(g, [v.p(SLAB.x1, SLAB.y0, 0), v.p(SLAB.x1, SLAB.y0, -0.42), v.p(SLAB.x1, SLAB.y1, -0.42), v.p(SLAB.x1, SLAB.y1, 0)], 4 * v.z, shade(M.slabEdge, -0.06), shade(M.slabEdge, -0.16));
  fillPoly(g, [v.p(SLAB.x0, SLAB.y1, 0), v.p(SLAB.x1, SLAB.y1, 0), v.p(SLAB.x1, SLAB.y1, -0.42), v.p(SLAB.x0, SLAB.y1, -0.42)], 4 * v.z, M.slabEdge, shade(M.slabEdge, -0.1));
  fillPoly(g, quad(v, SLAB), 26 * v.z, warm(M.floor, 0.012, 3), M.floor, 0.46);
}

/** Pass 4: the hour, as one multiply across the campus, then the sun's bloom added back. */
export function paintHour(g: G, v: View, m: CampusMap, light: Light): void {
  const { w, h } = v.cam;
  g.save();
  campusClip(g, v, m);
  g.clip();
  const mul = g.createLinearGradient(w * 0.1, 0, w * 0.85, h);
  mul.addColorStop(0, light.mulFrom);
  mul.addColorStop(0.42, mix(light.mulFrom, light.mulTo, 0.3));
  mul.addColorStop(1, light.mulTo);
  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = light.mulAlpha;
  g.fillStyle = mul;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'screen';
  const bloomIn = g.createRadialGradient(w * 0.34, h * 0.1, 0, w * 0.34, h * 0.1, Math.max(w, h) * 0.62);
  bloomIn.addColorStop(0, rgba(light.washFrom, light.washAlpha));
  bloomIn.addColorStop(1, rgba(light.washFrom, 0));
  g.fillStyle = bloomIn;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
  const bnc = g.createLinearGradient(w, 0, 0, h);
  bnc.addColorStop(0, rgba(light.bounce, light.bounceAlpha));
  bnc.addColorStop(1, rgba(light.bounce, 0));
  g.fillStyle = bnc;
  g.fillRect(0, 0, w, h);
  g.restore();

  const vig = g.createRadialGradient(w * 0.46, h * 0.44, Math.min(w, h) * 0.26, w * 0.46, h * 0.44, Math.max(w, h) * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, light.name === 'dusk' ? 'rgba(18,12,26,0.38)' : light.name === 'night' ? 'rgba(6,8,18,0.46)' : 'rgba(10,12,20,0.3)');
  g.fillStyle = vig;
  g.fillRect(0, 0, w, h);
}

/** Pass 5a: the zone plates. */
export function paintZonePlates(g: G, v: View, m: CampusMap, o: { current?: string | null } = {}): void {
  const { w, h } = v.cam;
  for (const z of m.zones) {
    const at = v.p(z.rect.x0 + (z.rect.x1 - z.rect.x0) * z.plate.fx, z.rect.y0 + (z.rect.y1 - z.rect.y0) * z.plate.fy, 0);
    if (at.x < -90 || at.x > w + 90 || at.y < -40 || at.y > h + 40) continue;
    plate(g, at, z.label, {
      size: Math.max(11, Math.min(13.5, 10 + v.z * 3.4)),
      chip: accentChip(z.accent),
      alpha: o.current && o.current === z.id ? 0.98 : 0.92,
      lift: 2,
    });
  }
}
