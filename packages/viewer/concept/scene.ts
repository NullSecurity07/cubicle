/**
 * SP9 concept — the renderer.
 *
 * Turns the zone table into props and people, then paints in five passes:
 *
 *   1. the ground and the campus slab — the floor is a plate that floats, so the open plan has an edge
 *   2. every shadow, swept into one offscreen layer and composited through a single blur: one light, one penumbra
 *   3. the floor dressing — window pools, walkways, the accent rug per division
 *   4. the world, back to front by `x + y` on the single plane
 *   5. the hour's wash, then the UI type: zone plates, desk plates, speech bubbles — always crisp, never sheared
 *
 * The passes are the contract the real renderer will keep. Phaser can own pass 4 as a display list sorted by the same
 * key; passes 1–3 and 5 are one canvas each.
 */
import { ACCENT, type Light, MATERIAL as M, mix, rgba, shade, warm } from './palette.js';
import { PERSON_H, type Rect, type View, quad } from './iso.js';
import { type G, bubble, fillPoly, hull, plate, roundPoly, sweepShadow } from './shapes.js';
import { type Drawable, boardTable, chair, counter, curtainWall, desk, floorLamp, glassWall, highTable, path, plant, rug, screen, shadowVec, shelf, stool, windowPools } from './props.js';
import { drawPerson, personFoot, personFrom } from './characters.js';
import { BODIES, CAMPUS, DESKS, FLOOR_LAMPS, HIGH_TABLES, LOOSE_CHAIRS, PARTITIONS, PATHS, PLANTS, SCREENS, SHELVES, STOOLS, TABLES, ZONES } from './zones.js';

const SLAB: Rect = { x0: 0, y0: 0, x1: CAMPUS.w, y1: CAMPUS.h };
const ACCENT_CHIP: Record<string, string> = Object.fromEntries(Object.entries(ACCENT).map(([k, a]) => [k, a.chip]));

/** Everything in the campus that is not a person, in one flat list. */
export function props(): Drawable[] {
  const out: Drawable[] = [];
  out.push(windowPools(CAMPUS.w, 'x', CAMPUS.wall), windowPools(CAMPUS.h, 'y', CAMPUS.wall));
  for (const p of PATHS) out.push(path(p));
  for (const z of ZONES) out.push(rug(z.rect, z.accent, { alpha: z.accent === 'neutral' ? 0.72 : 0.92 }));
  out.push(curtainWall(CAMPUS.w, 'x', { thick: CAMPUS.wall }), curtainWall(CAMPUS.h, 'y', { thick: CAMPUS.wall }));
  for (const p of PARTITIONS) out.push(glassWall({ x: p.x, y: p.y, axis: p.axis, len: p.len, z: 0, h: p.h ?? 1.38 }, p.accent));
  for (const t of TABLES) out.push(t.kind === 'board' ? boardTable(t.rect) : counter(t.rect));
  for (const d of DESKS) {
    out.push(chair(d.x + (d.w ?? 2.5) / 2 - 0.46, d.side === 'near' ? d.y + (d.d ?? 1.3) + 0.56 : d.y - 1.28, d.side === 'near' ? 'nw' : 'se'));
    out.push(desk(d.x, d.y, d.w ?? 2.5, d.d ?? 1.3, { accent: d.accent, side: d.side, label: d.label, lamp: d.lamp, papers: d.papers }));
  }
  for (const c of LOOSE_CHAIRS) out.push(chair(c.x, c.y, c.facing));
  for (const t of HIGH_TABLES) out.push(highTable(t.x, t.y));
  for (const s of STOOLS) out.push(stool(s.x, s.y, s.colour));
  for (const l of FLOOR_LAMPS) out.push(floorLamp(l.x, l.y));
  for (const s of SHELVES) out.push(shelf(s.x, s.y, s.w && s.w > 0 ? s.w : 3, 0.75, s.accent));
  for (const p of PLANTS) out.push(plant(p.x, p.y, p.size ?? 1));
  for (const s of SCREENS) out.push(screen({ ...s, accent: s.accent }));
  return out;
}

/** Everyone, as drawables. The painter is one function; only the pixel height changes with the camera. */
export function people(): Drawable[] {
  return BODIES.map((b) => {
    const p = personFrom(b.id, b.outfit, b.pose, b.facing, {
      ...(b.style ? { style: b.style } : {}),
      ...(b.glasses === undefined ? {} : { glasses: b.glasses }),
      ...(b.tag ? { tag: b.tag } : {}),
    });
    return {
      d: b.x + b.y + 0.05,
      shadow(g: G, v: View, light: Light) {
        const at = v.p(b.x, b.y, 0);
        const s = shadowVec(v, light, PERSON_H * 0.72);
        sweepShadow(g, personFoot(at, PERSON_H * v.cz), s.dx, s.dy, light.shadowAlpha * 0.95, light.shadowTint);
      },
      draw(g: G, v: View, light: Light) { drawPerson(g, v.p(b.x, b.y, 0), PERSON_H * v.cz, p, light); },
    };
  });
}

export interface SceneOpts {
  /** zone plates; off when the camera is close enough that the room names itself */
  zoneLabels?: boolean;
  bubbles?: boolean;
}

/** Path the campus slab itself — the floor plate, and nothing standing on it. */
function slabPath(g: G, v: View): void {
  roundPoly(g, quad(v, SLAB), 26 * v.z);
}

/**
 * What the campus is allowed to paint into: the slab *swept upwards* by the height of the tallest thing on it.
 *
 * Clipping to the floor quad alone looks right until something stands near a back wall, because a wall at `y = 0`
 * rises off the top edge of that quad and is cut away — which is exactly how the curtain wall, the whiteboard and
 * every window came to be missing from the first renders while every desk in the middle of the floor survived.
 */
function campusClip(g: G, v: View, headUnits = 4.4): void {
  const base = quad(v, SLAB);
  const lift = headUnits * v.cz;
  roundPoly(g, hull([...base, ...base.map((p) => ({ x: p.x, y: p.y - lift }))]), 22 * v.z);
}

export function render(g: G, v: View, light: Light, o: SceneOpts = {}): void {
  const { w, h } = v.cam;

  // ---- 1. the ground, and the slab the campus is poured on ------------------------------------------------------
  const ground = g.createLinearGradient(0, 0, w * 0.6, h);
  ground.addColorStop(0, light.groundFrom);
  ground.addColorStop(1, light.groundTo);
  g.fillStyle = ground;
  g.fillRect(0, 0, w, h);
  // a wide soft bloom where the light comes from, so the dark ground is not flat
  const bloom = g.createRadialGradient(w * 0.16, -h * 0.1, 0, w * 0.16, -h * 0.1, h * 1.5);
  bloom.addColorStop(0, rgba(light.name === 'dusk' ? '#FF9E52' : '#8FB4D8', light.name === 'dusk' ? 0.2 : 0.1));
  bloom.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = bloom;
  g.fillRect(0, 0, w, h);

  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = 46;
  g.shadowOffsetY = 26;
  fillPoly(g, quad(v, SLAB, -0.42), 26 * v.z, shade(M.slabEdge, -0.12), shade(M.slabEdge, -0.24));
  g.restore();
  fillPoly(g, [
    v.p(SLAB.x1, SLAB.y0, 0), v.p(SLAB.x1, SLAB.y0, -0.42), v.p(SLAB.x1, SLAB.y1, -0.42),
    v.p(SLAB.x1, SLAB.y1, 0),
  ], 4 * v.z, shade(M.slabEdge, -0.06), shade(M.slabEdge, -0.16));
  fillPoly(g, [
    v.p(SLAB.x0, SLAB.y1, 0), v.p(SLAB.x1, SLAB.y1, 0), v.p(SLAB.x1, SLAB.y1, -0.42),
    v.p(SLAB.x0, SLAB.y1, -0.42),
  ], 4 * v.z, M.slabEdge, shade(M.slabEdge, -0.1));
  // the poured floor itself
  fillPoly(g, quad(v, SLAB), 26 * v.z, warm(M.floor, 0.012, 3), M.floor, 0.46);

  const items = [...props(), ...people()].sort((a, b) => a.d - b.d);
  const dressing = items.filter((i) => i.floor);
  const world = items.filter((i) => !i.floor);

  // ---- 2. the floor dressing, then every shadow over it ---------------------------------------------------------
  g.save();
  slabPath(g, v);
  g.clip();
  for (const it of dressing) it.draw(g, v, light);
  g.restore();

  const layer = document.createElement('canvas');
  const dpr = Math.max(1, Math.round((g.canvas.width / w) * 100) / 100);
  layer.width = Math.ceil(w * dpr);
  layer.height = Math.ceil(h * dpr);
  const lg = layer.getContext('2d');
  if (lg) {
    lg.scale(dpr, dpr);
    for (const it of world) it.shadow?.(lg, v, light);
    g.save();
    slabPath(g, v);
    g.clip();
    g.filter = `blur(${(2.5 + 4.5 * v.z).toFixed(2)}px)`;
    g.drawImage(layer, 0, 0, w, h);
    g.filter = 'none';
    g.restore();
  }

  // ---- 3. the world, back to front ------------------------------------------------------------------------------
  g.save();
  campusClip(g, v);
  g.clip();
  for (const it of world) it.draw(g, v, light);
  g.restore();

  // ---- 4. the hour, as one multiply across the campus, then the bloom back in ------------------------------------
  g.save();
  campusClip(g, v);
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
  // the sun itself: a broad warm bloom over the window wall, added rather than blended
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

  // a whole-frame vignette, so the eye lands in the middle of the campus
  const vig = g.createRadialGradient(w * 0.46, h * 0.44, Math.min(w, h) * 0.26, w * 0.46, h * 0.44, Math.max(w, h) * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, light.name === 'dusk' ? 'rgba(18,12,26,0.38)' : 'rgba(10,12,20,0.3)');
  g.fillStyle = vig;
  g.fillRect(0, 0, w, h);

  // ---- 5b. UI type ---------------------------------------------------------------------------------------------
  if (o.zoneLabels !== false) {
    for (const z of ZONES) {
      const fx = z.labelAt?.fx ?? 0.5, fy = z.labelAt?.fy ?? 0.5;
      const at = v.p(z.rect.x0 + (z.rect.x1 - z.rect.x0) * fx, z.rect.y0 + (z.rect.y1 - z.rect.y0) * fy, 0);
      if (at.x < -80 || at.x > w + 80 || at.y < -40 || at.y > h + 40) continue;
      plate(g, at, z.label, { size: Math.max(11, Math.min(13.5, 11 + v.z * 3)), chip: ACCENT_CHIP[z.accent], alpha: 0.93 });
    }
  }
  if (o.bubbles) {
    for (const b of BODIES) {
      if (!b.says) continue;
      const at = v.p(b.x, b.y, PERSON_H + 0.34);
      bubble(g, at, b.says, { size: Math.max(11, Math.min(13.5, 9 + v.z * 4)), tail: b.facing === 'se' || b.facing === 'ne' ? 'left' : 'right' });
    }
  }
}

export { SLAB };
