/**
 * The prop library.
 *
 * Every object in the campus is a `Drawable`: a depth key, an optional shadow pass and a draw pass. The scene
 * collects them, sweeps all the shadows into one blurred layer, then draws the objects back-to-front by `d = x + y`.
 * A prop never reaches for a colour that is not in `palette.ts` and never positions itself in screen space — it is
 * given a grid rectangle and the view does the rest, which is what will let these functions move into the real
 * renderer unchanged.
 */
import { type Pt, type Rect, type View, centre } from './iso.js';
import { ACCENT, type AccentName, type Light, MATERIAL as M, dim, lit, mix, rgba, shade, warm } from './materials.js';
import { type Axis, type G, type PanelSpec, MONO_FONT, UI_FONT, faceQuad, faceText, fillPoly, glow, isoBox, isoSlab, panel, plate, roundRect, twoTone } from './shapes.js';
import * as swept from './shapes.js';

export interface Drawable {
  /** painter's depth on the single plane */
  d: number;
  /**
   * The id of the thing in `Office/campus.md` this belongs to, where it belongs to one — a desk is a chair and a
   * desk and they carry the same owner. The renderer needs it for exactly one job: while the owner is dragging
   * something, the thing has to be drawn where the pointer is and *not* where it still is in the map.
   */
  owner?: string;
  /**
   * The grid footprint and height this prop paints inside, so the renderer can drop what the camera cannot see.
   * At room zoom four fifths of the campus is off screen; without this the frame pays for all of it.
   */
  bounds?: Rect;
  hz?: number;
  /**
   * Floor dressing — rugs, walkways, the pools under the windows. It is painted *before* the shadow layer, because
   * a shadow that falls on a rug and is then covered by that rug is no shadow at all.
   */
  floor?: boolean;
  shadow?(g: G, v: View, light: Light): void;
  draw(g: G, v: View, light: Light): void;
}

/** How far a unit of height throws its shadow, in screen px. One light, so one vector for the whole campus. */
export function shadowVec(v: View, light: Light, heightUnits: number): { dx: number; dy: number } {
  const hpx = heightUnits * v.cz * light.shadowLen;
  return { dx: hpx * 0.92, dy: hpx * 0.58 };
}

const quadOf = (v: View, r: Rect, z = 0): Pt[] => [v.p(r.x0, r.y0, z), v.p(r.x1, r.y0, z), v.p(r.x1, r.y1, z), v.p(r.x0, r.y1, z)];

/** The generic body: an extruded box that casts one long soft shadow. */
export function boxProp(r: Rect, z: number, h: number, base: string, o: { radius?: number; topColour?: string; noShadow?: boolean } = {}): Drawable {
  const c = centre(r);
  return {
    d: c.x + c.y,
    bounds: r, hz: z + h,
    shadow(g, v, light) {
      if (o.noShadow) return;
      const { dx, dy } = shadowVec(v, light, z + h);
      swept.sweepShadow(g, quadOf(v, r, 0), dx, dy, light.shadowAlpha, light.shadowTint);
    },
    draw(g, v) { isoBox(g, v, { ...r, z, h }, base, { r: o.radius, topColour: o.topColour }); },
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* floor                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

/** A zone's floor: the accent rug, softened at the corners, with a hairline of the accent at its edge. */
export function rug(r: Rect, accent: AccentName, o: { radius?: number; alpha?: number } = {}): Drawable {
  const a = ACCENT[accent];
  return {
    d: -1000 + (r.x0 + r.y0) * 0.001,
    bounds: r, hz: 0,
    floor: true,
    draw(g, v) {
      g.save();
      g.globalAlpha = o.alpha ?? 1;
      isoSlab(g, v, r, warm(a.rug, 0.02, 3), a.rug, o.radius ?? 14);
      g.globalAlpha = 1;
      swept.roundPoly(g, quadOf(v, r), (o.radius ?? 14) * v.z);
      g.strokeStyle = rgba(a.base, 0.18);
      g.lineWidth = Math.max(1, 1.2 * v.z);
      g.stroke();
      g.restore();
    },
  };
}

/** A walkway: the same poured floor, polished a step brighter. */
export function path(r: Rect, o: { radius?: number } = {}): Drawable {
  return {
    d: -900 + (r.x0 + r.y0) * 0.001,
    bounds: r, hz: 0,
    floor: true,
    draw(g, v) { isoSlab(g, v, r, M.path, mix(M.path, M.floor, 0.55), o.radius ?? 18); },
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the desk, the chair and what is on them                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export interface DeskOpts {
  accent: AccentName;
  /**
   * Which side the occupant is on, in grid terms — and therefore which side of the monitor we see. The camera looks
   * from the +x +y corner, so an occupant on the `far` side (smaller y) faces towards us and their monitor turns its
   * back to us; an occupant on the `near` side has their back to us and we read their screen over their shoulder.
   * Getting this wrong is what makes iso offices look like showrooms: every monitor facing the camera at once.
   */
  side?: 'far' | 'near';
  lamp?: boolean;
  mug?: boolean;
  papers?: boolean;
  label?: string;
}

const TOP_Z = 0.62;


/** What a desk monitor shows. Three short lines, so the face can hold them at any zoom the camera reaches. */
const MONITOR_LINES = ['const brief =', '  await plan()', 'ok · 12 passing'] as const;

/** A desk: walnut top, two slim legs, a monitor on its stand and an accent chip on the front edge. */
export function desk(x: number, y: number, w = 2.5, d = 1.3, o: DeskOpts = { accent: 'neutral' }): Drawable {
  const r: Rect = { x0: x, y0: y, x1: x + w, y1: y + d };
  const c = centre(r);
  const a = ACCENT[o.accent];
  const far = (o.side ?? 'far') === 'far';
  return {
    d: c.x + c.y,
    bounds: { x0: r.x0 - 0.2, y0: r.y0 - 0.5, x1: r.x1 + 0.2, y1: r.y1 + 0.6 }, hz: TOP_Z + 0.8,
    shadow(g, v, light) {
      const s = shadowVec(v, light, TOP_Z + 0.1);
      swept.sweepShadow(g, quadOf(v, r), s.dx, s.dy, light.shadowAlpha, light.shadowTint);
    },
    draw(g, v, light) {
      // legs
      isoBox(g, v, { x0: x + 0.12, y0: y + 0.15, x1: x + 0.32, y1: y + d - 0.15, z: 0, h: TOP_Z }, shade(M.walnut, -0.08), { r: 2 });
      isoBox(g, v, { x0: x + w - 0.32, y0: y + 0.15, x1: x + w - 0.12, y1: y + d - 0.15, z: 0, h: TOP_Z }, shade(M.walnut, -0.1), { r: 2 });
      // the top
      isoBox(g, v, { ...r, z: TOP_Z, h: 0.09 }, M.walnut, { r: Math.max(2, 4 * v.z), topColour: M.walnutPale });
      const zt = TOP_Z + 0.09;
      // the monitor: mounted on the edge away from the occupant, so it is turned towards them
      const mx = x + w * 0.3;
      const my = far ? y + 0.42 : y + d - 0.32;
      /**
       * The keyboard, the mug and the papers, on the occupant's side of the desk.
       *
       * Drawn before the monitor on a near-side desk and after it on a far-side one, because on a near-side desk
       * the occupant's side is the *back* of the picture: painting the keyboard last laid a white slab straight
       * across the lit screen in every Dev and Revenue desk in the frame (visual QA S9-9).
       */
      const loose = (): void => {
        const ky = far ? y + d - 0.5 : y + 0.24;
        isoBox(g, v, { x0: x + w * 0.2, y0: ky, x1: x + w * 0.2 + 0.88, y1: ky + 0.26, z: zt, h: 0.035 }, M.keyboard, { r: 2 });
        if (o.mug !== false) {
          const p = v.p(x + w - 0.42, far ? y + d - 0.38 : y + 0.38, zt);
          const rw = 0.16 * v.cw * 0.5;
          roundRect(g, p.x - rw * 0.5, p.y - 0.2 * v.cz, rw, 0.2 * v.cz, rw * 0.28);
          g.fillStyle = twoTone(g, { x: p.x - rw * 0.5, y: p.y - 0.2 * v.cz, w: rw, h: 0.2 * v.cz }, lit(M.mug), dim(M.mug));
          g.fill();
        }
        if (o.papers) {
          isoBox(g, v, { x0: x + 0.22, y0: far ? y + d - 0.62 : y + 0.2, x1: x + 1.0, y1: far ? y + d - 0.2 : y + 0.62, z: zt, h: 0.02 }, M.paper, { r: 2 });
        }
      };
      if (!far) loose();
      isoBox(g, v, { x0: mx + 0.34, y0: my - 0.06, x1: mx + 0.56, y1: my + 0.06, z: zt, h: 0.14 }, M.charcoal, { r: 2 });
      panel(g, v, { x: mx, y: my, axis: 'x', len: 0.98, z: zt + 0.12, h: 0.54 },
        far ? mix(M.charcoal, M.monitorLit, 0.22) : shade(M.charcoal, -0.02),
        { thick: 0.07, r: Math.max(2, 3 * v.z) });
      if (!far) {
        // read over their shoulder: the lit face of the screen
        const inner: PanelSpec = { x: mx + 0.08, y: my - 0.012, axis: 'x', len: 0.82, z: zt + 0.19, h: 0.4 };
        const face = faceQuad(v, inner);
        swept.roundPoly(g, face, Math.max(1.5, 2.5 * v.z));
        const b = swept.bbox(face);
        const grad = g.createLinearGradient(b.x, b.y, b.x + b.w * 0.5, b.y + b.h);
        grad.addColorStop(0, shade(M.screen, 0.08));
        grad.addColorStop(1, shade(M.screen, 0.01));
        g.fillStyle = grad;
        g.fill();
        if (v.z > 0.42) {
          // Three lines inside a face 0.82 cells wide and 0.4 tall. The size comes from the face, not from the
          // camera: it used to be `6.4 * v.z * 1.6`, which at a zone fit set a 26 px terminal on a 68 px screen and
          // laid the overflow out across the desk and the floor beside it (visual QA S9-3). Clipped as well, so a
          // line that still does not fit is cut at the bezel rather than escaping it.
          g.save();
          swept.roundPoly(g, face, Math.max(1.5, 2.5 * v.z));
          g.clip();
          const faceH = 0.4 * v.cz, faceW = 0.74 * 32 * v.z;
          const step = faceH / 3.4;
          const size = Math.max(3.6, Math.min(step * 0.86, faceW / 7.2));
          for (let i = 0; i < 3; i++) {
            faceText(g, v.p(mx + 0.12, my - 0.014, zt + 0.19 + (0.4 * (2.5 - i)) / 3.4), 'x', MONITOR_LINES[i],
              { size, colour: rgba(i === 2 ? M.pass : M.screenInk, 0.8), weight: 400, font: MONO_FONT, maxWidth: faceW });
          }
          g.restore();
        }
        glow(g, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, Math.max(b.w, b.h) * 0.8, M.screenGlow, light.name === 'dusk' ? 0.2 : 0.08);
      }
      if (far) loose();
      if (o.lamp && v.z > 0.38) lampAt(g, v, x + w - 0.3, y + 0.32, zt, light);
      // the accent chip on the front edge, so a division reads even without its label
      if (v.z > 0.44) {
        const p0 = v.p(x + w * 0.06, y + d, zt - 0.02), p1 = v.p(x + w * 0.4, y + d, zt - 0.02);
        g.save();
        g.lineCap = 'round';
        g.strokeStyle = rgba(a.chip, 0.9);
        g.lineWidth = Math.max(1.2, 2.6 * v.z);
        g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
        g.restore();
      }
      if (o.label && v.z > 0.85) {
        plate(g, v.p(x + w / 2, y + d + 0.42, 0), o.label, { size: 10.5, chip: a.chip, alpha: 0.88 });
      }
    },
  };
}

/** A task chair: charcoal seat and back, a stem and a soft base. `facing` is which way the sitter looks. */
export function chair(x: number, y: number, facing: 'se' | 'sw' | 'ne' | 'nw' = 'se'): Drawable {
  const r: Rect = { x0: x, y0: y, x1: x + 0.72, y1: y + 0.72 };
  const c = centre(r);
  const backNorth = facing === 'se' || facing === 'sw';
  return {
    d: c.x + c.y - 0.02,
    bounds: { x0: x - 0.1, y0: y - 0.1, x1: x + 0.82, y1: y + 0.82 }, hz: 1.0,
    shadow(g, v, light) {
      const s = shadowVec(v, light, 0.5);
      swept.sweepShadow(g, quadOf(v, { x0: x + 0.1, y0: y + 0.1, x1: x + 0.62, y1: y + 0.62 }), s.dx, s.dy, light.shadowAlpha * 0.85, light.shadowTint);
    },
    draw(g, v) {
      const p = v.p(c.x, c.y, 0);
      // base and stem
      fillPoly(g, [v.p(x + 0.06, c.y, 0), v.p(c.x, y + 0.06, 0), v.p(x + 0.66, c.y, 0), v.p(c.x, y + 0.66, 0)], 3 * v.z, lit(M.charcoal), dim(M.charcoal));
      roundRect(g, p.x - 0.035 * v.cw, p.y - 0.42 * v.cz, 0.07 * v.cw, 0.42 * v.cz, 2);
      g.fillStyle = shade(M.charcoal, 0.05); g.fill();
      isoBox(g, v, { x0: x + 0.06, y0: y + 0.06, x1: x + 0.66, y1: y + 0.66, z: 0.42, h: 0.09 }, M.charcoal, { r: Math.max(2, 5 * v.z), topColour: shade(M.charcoal, 0.07) });
      const by = backNorth ? y + 0.1 : y + 0.62;
      panel(g, v, { x: x + 0.05, y: by, axis: 'x', len: 0.62, z: 0.51, h: 0.46 }, shade(M.charcoal, 0.02), { thick: 0.08, r: Math.max(2, 5 * v.z) });
    },
  };
}

/** A desk lamp: stem, shade and — after dark — the pool it throws. */
function lampAt(g: G, v: View, x: number, y: number, z: number, light: Light): void {
  const base = v.p(x, y, z);
  const head = v.p(x, y, z + 0.42);
  g.save();
  g.strokeStyle = shade(M.charcoal, 0.1);
  g.lineWidth = Math.max(1.2, 2.2 * v.z);
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(base.x, base.y);
  g.quadraticCurveTo(base.x - 0.1 * v.cw, head.y, head.x + 0.14 * v.cw, head.y);
  g.stroke();
  g.restore();
  fillPoly(g, [
    { x: head.x + 0.04 * v.cw, y: head.y - 0.02 * v.cz },
    { x: head.x + 0.26 * v.cw, y: head.y - 0.02 * v.cz },
    { x: head.x + 0.3 * v.cw, y: head.y + 0.14 * v.cz },
    { x: head.x, y: head.y + 0.14 * v.cz },
  ], 3 * v.z, lit(light.lamps ? M.shadeOn : M.shadeOff), dim(light.lamps ? M.shadeOnWarm : M.shadeOffWarm));
  if (light.lamps) {
    glow(g, { x: head.x + 0.15 * v.cw, y: head.y + 0.2 * v.cz }, 1.5 * v.cw, M.lamp, 0.5);
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* partitions, shelves, planting                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

/** A glass partition: a frosted pane in a slim rail, tinted by the division it belongs to. */
export function glassWall(s: PanelSpec, accent: AccentName = 'neutral'): Drawable {
  const a = ACCENT[accent];
  const along = s.axis === 'x' ? { x: s.x + s.len / 2, y: s.y } : { x: s.x, y: s.y + s.len / 2 };
  return {
    d: along.x + along.y - 0.04,
    bounds: s.axis === 'x'
      ? { x0: s.x - 0.2, y0: s.y - 0.3, x1: s.x + s.len + 0.2, y1: s.y + 0.3 }
      : { x0: s.x - 0.3, y0: s.y - 0.2, x1: s.x + 0.3, y1: s.y + s.len + 0.2 },
    hz: (s.z ?? 0) + s.h,
    shadow(g, v, light) {
      const sh = shadowVec(v, light, s.h * 0.55);
      const foot: Rect = s.axis === 'x'
        ? { x0: s.x, y0: s.y - 0.09, x1: s.x + s.len, y1: s.y + 0.05 }
        : { x0: s.x - 0.09, y0: s.y, x1: s.x + 0.05, y1: s.y + s.len };
      swept.sweepShadow(g, quadOf(v, foot), sh.dx, sh.dy, light.shadowAlpha * 0.5, light.shadowTint);
    },
    draw(g, v, light) {
      const face = faceQuad(v, s);
      // the pane: a real surface, brighter where the light rakes across it, tinted by the division behind it
      swept.roundPoly(g, face, Math.max(2, 5 * v.z));
      const b = swept.bbox(face);
      const grad = g.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
      grad.addColorStop(0, rgba(warm(M.glass, 0.1), 0.46));
      grad.addColorStop(0.48, rgba(M.glass, 0.2));
      grad.addColorStop(1, rgba(mix(M.glass, a.base, 0.3), 0.3));
      g.fillStyle = grad;
      g.fill();
      g.strokeStyle = rgba(M.white, light.name === 'dusk' ? 0.24 : 0.34);
      g.lineWidth = Math.max(1, 1.1 * v.z);
      g.stroke();
      // a raking streak, one per pane
      g.save();
      swept.roundPoly(g, face, Math.max(2, 5 * v.z));
      g.clip();
      g.strokeStyle = rgba(M.white, 0.34);
      g.lineWidth = Math.max(1.5, 4.5 * v.z);
      g.beginPath();
      g.moveTo(b.x + b.w * 0.1, b.y + b.h);
      g.lineTo(b.x + b.w * 0.4, b.y - b.h * 0.1);
      g.stroke();
      g.restore();
      // slim anodised rails and posts; the division's accent is one hairline along the head, not a coloured frame
      const z1 = (s.z ?? 0) + s.h;
      const rail = (z: number, thick: number, colour: string): void => {
        const r: Rect = s.axis === 'x'
          ? { x0: s.x, y0: s.y - 0.07, x1: s.x + s.len, y1: s.y }
          : { x0: s.x - 0.07, y0: s.y, x1: s.x, y1: s.y + s.len };
        isoBox(g, v, { ...r, z, h: thick }, colour, { r: 2 });
      };
      rail(z1 - 0.07, 0.07, M.rail);
      rail(s.z ?? 0, 0.08, shade(M.walnut, -0.02));
      for (const end of [0, s.len - 0.07]) {
        const r: Rect = s.axis === 'x'
          ? { x0: s.x + end, y0: s.y - 0.075, x1: s.x + end + 0.07, y1: s.y }
          : { x0: s.x - 0.075, y0: s.y + end, x1: s.x, y1: s.y + end + 0.07 };
        isoBox(g, v, { ...r, z: s.z ?? 0, h: s.h - 0.07 }, M.rail, { r: 2 });
      }
      const c0 = s.axis === 'x' ? v.p(s.x, s.y - 0.075, z1) : v.p(s.x - 0.075, s.y, z1);
      const c1 = s.axis === 'x' ? v.p(s.x + s.len, s.y - 0.075, z1) : v.p(s.x - 0.075, s.y + s.len, z1);
      g.strokeStyle = rgba(a.chip, 0.9);
      g.lineWidth = Math.max(1.2, 2.2 * v.z);
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(c0.x, c0.y); g.lineTo(c1.x, c1.y); g.stroke();
    },
  };
}

/** A low shelf: walnut carcase, a row of files and something green on the end. */
export function shelf(x: number, y: number, w = 3, d = 0.75, accent: AccentName = 'neutral'): Drawable {
  const r: Rect = { x0: x, y0: y, x1: x + w, y1: y + d };
  const c = centre(r);
  const a = ACCENT[accent];
  return {
    d: c.x + c.y,
    bounds: { x0: r.x0 - 0.1, y0: r.y0 - 0.1, x1: r.x1 + 0.1, y1: r.y1 + 0.1 }, hz: 1.05,
    shadow(g, v, light) {
      const s = shadowVec(v, light, 0.78);
      swept.sweepShadow(g, quadOf(v, r), s.dx, s.dy, light.shadowAlpha, light.shadowTint);
    },
    draw(g, v) {
      isoBox(g, v, { ...r, z: 0, h: 0.74 }, M.walnut, { r: Math.max(2, 4 * v.z), topColour: M.walnutPale });
      // a shadow gap and a drawer line
      const p0 = v.p(x + 0.04, y + d, 0.38), p1 = v.p(x + w - 0.04, y + d, 0.38);
      g.strokeStyle = rgba(shade(M.walnut, -0.16), 0.55);
      g.lineWidth = Math.max(1, 1.2 * v.z);
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
      // files on top
      const colours = [a.chip, M.paper, shade(a.base, 0.16), M.file, a.chip];
      for (let i = 0; i < Math.max(2, Math.floor(w * 1.4)); i++) {
        const bx = x + 0.25 + i * 0.42;
        if (bx + 0.3 > x + w - 0.2) break;
        isoBox(g, v, { x0: bx, y0: y + 0.18, x1: bx + 0.28, y1: y + d - 0.18, z: 0.74, h: 0.22 + (i % 3) * 0.05 }, colours[i % colours.length], { r: 2 });
      }
    },
  };
}

/** A plant: a warm pot and a fan of soft leaves, in three greens. `size` is its height in cells. */
export function plant(x: number, y: number, size = 1): Drawable {
  return {
    d: x + y,
    bounds: { x0: x - 0.6 * size, y0: y - 0.6 * size, x1: x + 0.6 * size, y1: y + 0.6 * size }, hz: 1.4 * size,
    shadow(g, v, light) {
      const s = shadowVec(v, light, 0.55 * size);
      swept.sweepShadow(g, quadOf(v, { x0: x - 0.28, y0: y - 0.28, x1: x + 0.28, y1: y + 0.28 }), s.dx, s.dy, light.shadowAlpha * 0.8, light.shadowTint);
    },
    draw(g, v) {
      const potH = 0.34 * size;
      isoBox(g, v, { x0: x - 0.26 * size, y0: y - 0.26 * size, x1: x + 0.26 * size, y1: y + 0.26 * size, z: 0, h: potH }, M.pot, { r: Math.max(2, 6 * v.z * size), topColour: shade(M.pot, -0.1) });
      const base = v.p(x, y, potH);
      const H = 0.95 * size * v.cz;
      const greens = [M.leafDeep, M.leaf, M.leafPale, M.leaf, M.leafDeep, M.leafPale, M.leaf];
      for (let i = 0; i < 7; i++) {
        const t = (i / 6) * 2 - 1;
        const tipX = base.x + t * 0.42 * size * v.cw * 0.5;
        const tipY = base.y - H * (0.62 + 0.38 * (1 - Math.abs(t) * 0.6));
        const w = Math.max(1.6, 0.1 * size * v.cw * 0.5);
        g.beginPath();
        g.moveTo(base.x, base.y - H * 0.05);
        g.quadraticCurveTo(base.x + t * 0.3 * size * v.cw * 0.5 - w, (base.y + tipY) / 2, tipX, tipY);
        g.quadraticCurveTo(base.x + t * 0.3 * size * v.cw * 0.5 + w, (base.y + tipY) / 2 + w, base.x, base.y - H * 0.05);
        g.closePath();
        g.fillStyle = t < 0 ? warm(greens[i], 0.045, 4) : greens[i];
        g.fill();
      }
    },
  };
}

/** A stool: a walnut seat on a slim charcoal stem and a soft foot. */
export function stool(x: number, y: number, colour: string = M.walnutPale): Drawable {
  return {
    d: x + y - 0.01,
    bounds: { x0: x - 0.4, y0: y - 0.4, x1: x + 0.4, y1: y + 0.4 }, hz: 0.7,
    shadow(g, v, light) {
      const s = shadowVec(v, light, 0.56);
      swept.sweepShadow(g, quadOf(v, { x0: x - 0.22, y0: y - 0.22, x1: x + 0.22, y1: y + 0.22 }), s.dx, s.dy, light.shadowAlpha * 0.8, light.shadowTint);
    },
    draw(g, v) {
      const p = v.p(x, y, 0);
      fillPoly(g, [v.p(x - 0.22, y, 0), v.p(x, y - 0.22, 0), v.p(x + 0.22, y, 0), v.p(x, y + 0.22, 0)], 3 * v.z, lit(M.charcoal), dim(M.charcoal));
      roundRect(g, p.x - 0.035 * v.cw, p.y - 0.56 * v.cz, 0.07 * v.cw, 0.56 * v.cz, 2);
      g.fillStyle = shade(M.charcoal, 0.08); g.fill();
      isoBox(g, v, { x0: x - 0.26, y0: y - 0.26, x1: x + 0.26, y1: y + 0.26, z: 0.54, h: 0.1 }, colour, { r: Math.max(2, 8 * v.z), topColour: shade(colour, 0.07) });
    },
  };
}

/** A high table: the round walnut top the pantry stools stand round. */
export function highTable(x: number, y: number): Drawable {
  return {
    d: x + y - 0.02,
    bounds: { x0: x - 0.65, y0: y - 0.65, x1: x + 0.65, y1: y + 0.65 }, hz: 1.1,
    shadow(g, v, light) {
      const s = shadowVec(v, light, 1.0);
      swept.sweepShadow(g, quadOf(v, { x0: x - 0.34, y0: y - 0.34, x1: x + 0.34, y1: y + 0.34 }), s.dx, s.dy, light.shadowAlpha * 0.85, light.shadowTint);
    },
    draw(g, v) {
      const p = v.p(x, y, 0);
      fillPoly(g, [v.p(x - 0.34, y, 0), v.p(x, y - 0.34, 0), v.p(x + 0.34, y, 0), v.p(x, y + 0.34, 0)], 4 * v.z, lit(M.charcoal), dim(M.charcoal));
      roundRect(g, p.x - 0.045 * v.cw, p.y - 0.96 * v.cz, 0.09 * v.cw, 0.96 * v.cz, 2);
      g.fillStyle = shade(M.charcoal, 0.08); g.fill();
      isoBox(g, v, { x0: x - 0.5, y0: y - 0.5, x1: x + 0.5, y1: y + 0.5, z: 0.94, h: 0.08 }, M.walnut, { r: Math.max(3, 16 * v.z), topColour: M.walnutPale });
    },
  };
}

/** A floor lamp: a slim stem, a soft shade, and after dark the pool it lays on the floor. */
export function floorLamp(x: number, y: number): Drawable {
  return {
    d: x + y,
    bounds: { x0: x - 0.4, y0: y - 0.4, x1: x + 0.4, y1: y + 0.4 }, hz: 2.0,
    shadow(g, v, light) {
      const s = shadowVec(v, light, 1.5);
      swept.sweepShadow(g, quadOf(v, { x0: x - 0.2, y0: y - 0.2, x1: x + 0.2, y1: y + 0.2 }), s.dx, s.dy, light.shadowAlpha * 0.7, light.shadowTint);
    },
    draw(g, v, light) {
      fillPoly(g, [v.p(x - 0.26, y, 0), v.p(x, y - 0.26, 0), v.p(x + 0.26, y, 0), v.p(x, y + 0.26, 0)], 3 * v.z, lit(M.charcoal), dim(M.charcoal));
      const foot = v.p(x, y, 0.04), head = v.p(x, y, 1.52);
      g.strokeStyle = shade(M.charcoal, 0.1);
      g.lineWidth = Math.max(1.2, 2.4 * v.z);
      g.beginPath(); g.moveTo(foot.x, foot.y); g.lineTo(head.x, head.y); g.stroke();
      const shade0 = light.lamps ? M.floorShadeOn : M.floorShadeOff;
      fillPoly(g, [
        { x: head.x - 0.19 * v.cw, y: head.y },
        { x: head.x + 0.19 * v.cw, y: head.y },
        { x: head.x + 0.26 * v.cw, y: head.y + 0.42 * v.cz },
        { x: head.x - 0.26 * v.cw, y: head.y + 0.42 * v.cz },
      ], 4 * v.z, lit(shade0), dim(shade0));
      if (light.lamps) glow(g, { x: head.x, y: head.y + 0.5 * v.cz }, 2.4 * v.cw, M.lamp, 0.4);
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* tables and counters                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** The board table: one long walnut slab, heavily rounded, on two plinths. */
export function boardTable(r: Rect): Drawable {
  const c = centre(r);
  return {
    d: c.x + c.y,
    bounds: r, hz: 0.9,
    shadow(g, v, light) {
      const s = shadowVec(v, light, 0.78);
      swept.sweepShadow(g, quadOf(v, r), s.dx, s.dy, light.shadowAlpha, light.shadowTint);
    },
    draw(g, v) {
      const w = r.x1 - r.x0;
      isoBox(g, v, { x0: r.x0 + w * 0.16, y0: r.y0 + 0.32, x1: r.x0 + w * 0.34, y1: r.y1 - 0.32, z: 0, h: 0.66 }, shade(M.walnut, -0.1), { r: 3 });
      isoBox(g, v, { x0: r.x1 - w * 0.34, y0: r.y0 + 0.32, x1: r.x1 - w * 0.16, y1: r.y1 - 0.32, z: 0, h: 0.66 }, shade(M.walnut, -0.12), { r: 3 });
      isoBox(g, v, { ...r, z: 0.66, h: 0.1 }, M.walnut, { r: Math.max(4, 16 * v.z), topColour: M.walnutPale });
      // a sheen across the top, and papers
      const face = quadOf(v, r, 0.76);
      g.save();
      swept.roundPoly(g, face, 16 * v.z);
      g.clip();
      const b = swept.bbox(face);
      const grad = g.createLinearGradient(b.x, b.y, b.x + b.w * 0.7, b.y + b.h);
      grad.addColorStop(0, rgba(M.white, 0.16));
      grad.addColorStop(0.55, rgba(M.white, 0));
      g.fillStyle = grad;
      g.fill();
      g.restore();
    },
  };
}

/** The pantry counter: a walnut carcase under a pale stone top, with a splash of things on it. */
export function counter(r: Rect): Drawable {
  const c = centre(r);
  return {
    d: c.x + c.y,
    bounds: { x0: r.x0 - 0.1, y0: r.y0 - 0.1, x1: r.x1 + 0.1, y1: r.y1 + 0.1 }, hz: 1.45,
    shadow(g, v, light) {
      const s = shadowVec(v, light, 1.0);
      swept.sweepShadow(g, quadOf(v, r), s.dx, s.dy, light.shadowAlpha, light.shadowTint);
    },
    draw(g, v) {
      isoBox(g, v, { ...r, z: 0, h: 0.92 }, M.walnut, { r: Math.max(2, 4 * v.z) });
      isoBox(g, v, { x0: r.x0 - 0.06, y0: r.y0 - 0.06, x1: r.x1 + 0.06, y1: r.y1 + 0.06, z: 0.92, h: 0.09 }, M.stone, { r: Math.max(2, 5 * v.z), topColour: M.stoneTop });
      // cupboard lines
      const n = Math.max(2, Math.round((r.x1 - r.x0) / 1.1));
      for (let i = 1; i < n; i++) {
        const x = r.x0 + ((r.x1 - r.x0) * i) / n;
        const a = v.p(x, r.y1, 0.06), b = v.p(x, r.y1, 0.86);
        g.strokeStyle = rgba(shade(M.walnut, -0.16), 0.5);
        g.lineWidth = Math.max(1, 1.1 * v.z);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }
      const zt = 1.01;
      // a kettle, a jar, two mugs
      isoBox(g, v, { x0: r.x0 + 0.4, y0: r.y0 + 0.25, x1: r.x0 + 0.85, y1: r.y0 + 0.7, z: zt, h: 0.38 }, M.kettle, { r: Math.max(2, 5 * v.z) });
      isoBox(g, v, { x0: r.x0 + 1.1, y0: r.y0 + 0.3, x1: r.x0 + 1.42, y1: r.y0 + 0.62, z: zt, h: 0.3 }, M.jar, { r: Math.max(2, 4 * v.z) });
      for (let i = 0; i < 3; i++) {
        const p = v.p(r.x0 + 1.9 + i * 0.34, r.y0 + 0.45, zt);
        const w = 0.18 * v.cw * 0.5;
        roundRect(g, p.x - w / 2, p.y - 0.22 * v.cz, w, 0.22 * v.cz, w * 0.3);
        g.fillStyle = twoTone(g, { x: p.x - w / 2, y: p.y - 0.22 * v.cz, w, h: 0.22 * v.cz }, lit(i === 1 ? M.mugWarm : M.mugPale), dim(i === 1 ? M.mugWarm : M.mugPale));
        g.fill();
      }
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the screens                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

export interface ScreenSpec extends PanelSpec {
  /** the name that goes on the plate under it */
  name: string;
  /** the one line of content the screen carries */
  line: string;
  accent?: AccentName;
  kind?: 'screen' | 'board' | 'paper';
  /** put the plate at the panel's foot rather than over its head */
  plateBelow?: boolean;
  /** the plaster pier behind the panel; off only where it already hangs on a solid wall */
  pier?: boolean;
  /**
   * What the surface is actually showing right now: the last few lines the daemon sent, and — for the billboard —
   * the browser frame itself. A screen with live content is the thing the office is for; a screen with a stand-in
   * line is one nothing has happened on yet.
   */
  lines?: string[];
  image?: CanvasImageSource | null;
  /** a stream is open on it: the small pulse in the corner */
  live?: boolean;
}

/**
 * One of the ten screens: a soft dark panel, a hairline bezel, one line of content laid into the face, a warm halo
 * after dark, and a UI plate naming it. `board` and `paper` variants carry the same geometry in whiteboard and
 * noticeboard materials, so the whiteboard is the same object as the terminal and not a second kind of thing.
 */
export function screen(s: ScreenSpec): Drawable {
  const along = s.axis === 'x' ? { x: s.x + s.len / 2, y: s.y } : { x: s.x, y: s.y + s.len / 2 };
  const acc = ACCENT[s.accent ?? 'neutral'];
  const kind = s.kind ?? 'screen';
  const body = kind === 'screen' ? M.screen : kind === 'board' ? M.board : M.notice;
  const ink = kind === 'screen' ? M.screenInk : M.ink;
  return {
    d: along.x + along.y + 0.02,
    bounds: s.axis === 'x'
      ? { x0: s.x - 0.6, y0: s.y - 0.6, x1: s.x + s.len + 0.6, y1: s.y + 0.6 }
      : { x0: s.x - 0.6, y0: s.y - 0.6, x1: s.x + 0.6, y1: s.y + s.len + 0.6 },
    hz: (s.z ?? 0) + s.h + 1.2,
    draw(g, v, light) {
      // The pier the screen hangs on. Without it a panel in a gap between two partitions floats in mid-air, which is
      // the one thing a viewer notices before anything else in the picture.
      if (s.pier !== false) {
        const pier: PanelSpec = s.axis === 'x'
          ? { x: s.x - 0.26, y: s.y + 0.05, axis: 'x', len: s.len + 0.52, z: 0, h: (s.z ?? 0) + s.h + 0.34 }
          : { x: s.x + 0.05, y: s.y - 0.26, axis: 'y', len: s.len + 0.52, z: 0, h: (s.z ?? 0) + s.h + 0.34 };
        panel(g, v, pier, shade(M.plaster, -0.06), { thick: 0.16, r: Math.max(2, 4 * v.z), capColour: shade(M.plaster, 0.02) });
        panel(g, v, { ...pier, h: 0.18 }, shade(M.plaster, -0.16), { r: 2 });
      }
      const frame: PanelSpec = { x: s.x, y: s.y, axis: s.axis, len: s.len, z: s.z, h: s.h };
      // A whiteboard and a noticeboard are pale objects on a pale wall: they get a walnut frame, or they vanish.
      panel(g, v, frame, kind === 'screen' ? shade(body, -0.04) : M.walnut, { thick: 0.1, r: Math.max(3, 6 * v.z) });
      const inner: PanelSpec = s.axis === 'x'
        ? { x: s.x + 0.1, y: s.y - 0.011, axis: 'x', len: s.len - 0.2, z: (s.z ?? 0) + 0.08, h: s.h - 0.16 }
        : { x: s.x - 0.011, y: s.y + 0.1, axis: 'y', len: s.len - 0.2, z: (s.z ?? 0) + 0.08, h: s.h - 0.16 };
      const face = faceQuad(v, inner);
      swept.roundPoly(g, face, Math.max(2, 4 * v.z));
      const b = swept.bbox(face);
      const grad = g.createLinearGradient(b.x, b.y, b.x + b.w * 0.4, b.y + b.h);
      grad.addColorStop(0, kind === 'screen' ? shade(body, 0.055) : warm(body, 0.03, 3));
      grad.addColorStop(1, kind === 'screen' ? shade(body, -0.02) : shade(body, -0.03));
      g.fillStyle = grad;
      g.fill();
      // What the panel says is laid out inside the panel, in the panel's own units, and clipped to it.
      //
      // Two things went wrong in the first campus render and both are fixed here (visual QA S9-2). Each line used
      // to be fitted to the face's width on its own, so a short line and a long one on the same screen came out at
      // two different sizes and the screen read as broken; and the baselines were fractions of the panel's height
      // with no allowance for a glyph, so a line near the top climbed out through the frame. Now one size serves
      // the whole panel — the largest that fits the widest line *and* the rows the face has room for — the
      // baselines are laid out from the face's own box in screen pixels, and the whole block is clipped to the
      // face, so nothing a screen is handed can ever end up on the floor beside it.
      const faceH = Math.max(1, (s.h - 0.16) * v.cz);
      const maxW = Math.max(8, (s.len - 0.5) * 32 * v.z);
      const bottom = (s.z ?? 0) + 0.08;
      /** Text in the panel's own plane, `px` screen pixels up from the foot of the inner face. */
      const inFaceAt = (px: number, text: string, size: number, colour: string, weight: number, font: string, letter?: string): void => {
        const gz = bottom + px / v.cz;
        const at = s.axis === 'x' ? v.p(s.x + 0.25, s.y - 0.014, gz) : v.p(s.x - 0.014, s.y + s.len - 0.25, gz);
        faceText(g, at, s.axis, text, { size, colour, weight, font, maxWidth: maxW, ...(letter ? { letter } : {}) });
      };
      /** The one size this panel sets everything in: the largest that fits the widest line and `rows` rows. */
      const fitAll = (lines: string[], rows: number, font: string, weight: number): number => {
        let size = Math.min(17, (faceH / (rows + 0.5)) * 0.8);
        g.save();
        g.font = `${weight} 100px ${font}`;
        let widest = 1;
        for (const t of lines) widest = Math.max(widest, g.measureText(t).width / 100);
        g.restore();
        if (widest * size > maxW) size = maxW / widest;
        return Math.max(5, size);
      };
      // A live browser frame, laid into the panel's own plane. The face is a sheared parallelogram, so the frame is
      // drawn through the same shear the text uses rather than pasted flat over it — a rectangle of screenshot on
      // an isometric wall is the one thing that makes a drawn office look like a mock-up.
      if (s.image) {
        g.save();
        swept.roundPoly(g, face, Math.max(2, 4 * v.z));
        g.clip();
        const a = s.axis === 'x' ? v.p(s.x + 0.1, s.y - 0.011, (s.z ?? 0) + s.h - 0.08) : v.p(s.x - 0.011, s.y + s.len - 0.1, (s.z ?? 0) + s.h - 0.08);
        g.translate(a.x, a.y);
        g.transform(1, s.axis === 'x' ? 0.5 : -0.5, 0, 1, 0, 0);
        const fw = (s.len - 0.2) * v.cw * 0.5, fh = (s.h - 0.16) * v.cz;
        try { g.drawImage(s.image, 0, 0, Math.max(1, fw), Math.max(1, fh)); } catch { /* a frame that has not decoded yet */ }
        g.restore();
        g.save();
        swept.roundPoly(g, face, Math.max(2, 4 * v.z));
        g.clip();
        const sh = g.createLinearGradient(b.x, b.y, b.x + b.w * 0.4, b.y + b.h);
        sh.addColorStop(0, rgba(M.white, 0.14));
        sh.addColorStop(1, rgba(M.frameShade, 0.2));
        g.fillStyle = sh;
        g.fillRect(b.x, b.y, b.w, b.h);
        g.restore();
      }
      // At overview zoom the name lives *in* the panel: ten more plates over the campus would be ten more things
      // between the owner and the office. Close in, the name moves out onto a plate and the panel is all content.
      const close = v.z > 0.7;
      const content = s.lines && s.lines.length ? s.lines : [s.line];
      const bodyFont = kind === 'screen' ? MONO_FONT : UI_FONT;
      const bodyWeight = kind === 'screen' ? 500 : 600;
      if (s.image) { /* the frame is the content */ }
      else {
        g.save();
        swept.roundPoly(g, face, Math.max(2, 4 * v.z));
        g.clip();
        if (!close) {
          // Far out the name lives *in* the panel: ten more plates over the campus would be ten more things between
          // the owner and the office. One line of content under it, and no more — at this size a second is a smear.
          const size = fitAll([s.name.toUpperCase(), content[content.length - 1]], 2.2, UI_FONT, 600);
          inFaceAt(faceH * 0.56, s.name.toUpperCase(), size * 0.78, rgba(kind === 'screen' ? acc.base : acc.ink, 0.95), 700, UI_FONT, `${(size * 0.09).toFixed(2)}px`);
          inFaceAt(faceH * 0.18, content[content.length - 1], size, kind === 'screen' ? ink : M.ink, bodyWeight, bodyFont);
        } else {
          // Close in the panel is all content: as many lines as the face has room for, newest at the bottom.
          const rows = Math.max(1, Math.min(content.length, Math.floor(faceH / 13)));
          const show = content.slice(-rows);
          const size = fitAll(show, rows, bodyFont, bodyWeight);
          const step = size * 1.42;
          show.forEach((text, i) => {
            const px = faceH * 0.14 + (show.length - 1 - i) * step;
            if (px + size > faceH) return;
            inFaceAt(px, text, size, kind === 'screen' ? (i === show.length - 1 ? ink : rgba(ink, 0.72)) : M.ink, bodyWeight, bodyFont);
          });
        }
        g.restore();
      }
      if (s.live) {
        const dot = { x: b.x + b.w - Math.max(4, 7 * v.z), y: b.y + Math.max(4, 7 * v.z) };
        g.beginPath();
        g.arc(dot.x, dot.y, Math.max(1.6, 2.6 * v.z), 0, Math.PI * 2);
        g.fillStyle = M.attention;
        g.fill();
        glow(g, dot, Math.max(6, 14 * v.z), M.attention, 0.5);
      }
      if (kind === 'screen') {
        const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        glow(g, c, Math.max(b.w, b.h) * 0.75, M.screenGlow, light.name === 'dusk' ? 0.16 : 0.07);
      }
      if (close) {
        const foot = s.axis === 'x' ? v.p(s.x + s.len / 2, s.y + 0.5, 0) : v.p(s.x - 0.5, s.y + s.len / 2, 0);
        const head = s.axis === 'x' ? v.p(s.x + s.len / 2, s.y, (s.z ?? 0) + s.h + 0.82) : v.p(s.x, s.y + s.len / 2, (s.z ?? 0) + s.h + 0.82);
        plate(g, s.plateBelow ? foot : head, s.name, { size: 11.5, chip: acc.chip, alpha: 0.93, lift: 1 });
      }
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the perimeter                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The curtain wall along the two back edges. We see its inner face, so the campus has a horizon: plaster piers, a
 * run of glass bays with the hour's sky in them and, at dusk, the warm pools that sky lays on the floor.
 */
export function curtainWall(span: number, axis: Axis, o: { thick?: number; h?: number } = {}): Drawable {
  const t = o.thick ?? 0.55;
  const h = o.h ?? 3.2;
  return {
    d: -800,
    draw(g, v, light) {
      const s: PanelSpec = axis === 'x' ? { x: 0, y: t, axis: 'x', len: span, z: 0, h } : { x: t, y: 0, axis: 'y', len: span, z: 0, h };
      panel(g, v, s, shade(M.plaster, -0.11), { thick: t, r: Math.max(2, 3 * v.z), capColour: shade(M.plaster, 0.02) });
      // skirting
      panel(g, v, { ...s, h: 0.22 }, shade(M.plaster, -0.2), { r: 2 });
      const bayW = 3.3, gap = 1.15, sill = 0.68, head = h - 0.42;
      for (let a = 1.2; a + bayW < span - 0.8; a += bayW + gap) {
        const bay: PanelSpec = axis === 'x'
          ? { x: a, y: t - 0.014, axis: 'x', len: bayW, z: sill, h: head - sill }
          : { x: t - 0.014, y: a, axis: 'y', len: bayW, z: sill, h: head - sill };
        const face = faceQuad(v, bay);
        swept.roundPoly(g, face, Math.max(2, 3 * v.z));
        const b = swept.bbox(face);
        // the sky, read from the top of the pane down to the horizon: upper sky, the band the sun is in, the glow
        const grad = g.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
        grad.addColorStop(0, light.skyHigh);
        grad.addColorStop(0.46, mix(light.skyHigh, light.sky, 0.75));
        grad.addColorStop(0.78, light.sky);
        grad.addColorStop(1, light.skyLow);
        g.fillStyle = grad;
        g.fill();
        // the pane itself: a cool reflection raking across the glass, so it is glass and not a hole
        g.save();
        swept.roundPoly(g, face, Math.max(2, 3 * v.z));
        g.clip();
        const refl = g.createLinearGradient(b.x, b.y + b.h, b.x + b.w * 0.55, b.y);
        refl.addColorStop(0, rgba(M.white, 0));
        refl.addColorStop(0.55, rgba(M.white, 0.16));
        refl.addColorStop(1, rgba(M.white, 0));
        g.fillStyle = refl;
        g.fillRect(b.x, b.y, b.w, b.h);
        g.restore();
        // the reveal: a bright inner edge where the frame meets the glass
        g.strokeStyle = rgba(M.white, 0.42);
        g.lineWidth = Math.max(1, 1.3 * v.z);
        g.stroke();
        // mullions
        for (let k = 1; k < 3; k++) {
          const at = a + (bayW * k) / 3;
          const p0 = axis === 'x' ? v.p(at, t - 0.02, sill) : v.p(t - 0.02, at, sill);
          const p1 = axis === 'x' ? v.p(at, t - 0.02, head) : v.p(t - 0.02, at, head);
          g.strokeStyle = rgba(M.mullion, 0.85);
          g.lineWidth = Math.max(1.2, 2 * v.z);
          g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
        }
        glow(g, { x: b.x + b.w / 2, y: b.y + b.h * 0.6 }, Math.max(b.w, b.h) * 1.15, light.sky, light.glassGlow);
      }
    },
  };
}

/** The pools the windows lay on the floor — drawn with the floor, before anything stands on it. */
export function windowPools(span: number, axis: Axis, thick = 0.55): Drawable {
  return {
    d: -890,
    floor: true,
    draw(g, v, light) {
      if (light.poolAlpha <= 0) return;
      const bayW = 3.3, gap = 1.15, reach = 4.2;
      g.save();
      // the edge of a sunbeam is not a vector edge; blur the whole set rather than feathering each one
      g.filter = `blur(${(2 + 6 * v.z).toFixed(2)}px)`;
      for (let a = 1.2; a + bayW < span - 0.8; a += bayW + gap) {
        const pts = axis === 'x'
          ? [v.p(a, thick, 0), v.p(a + bayW, thick, 0), v.p(a + bayW + reach * 0.5, thick + reach, 0), v.p(a + reach * 0.5 - 0.4, thick + reach, 0)]
          : [v.p(thick, a, 0), v.p(thick, a + bayW, 0), v.p(thick + reach, a + bayW + reach * 0.45, 0), v.p(thick + reach, a + reach * 0.45 - 0.4, 0)];
        swept.roundPoly(g, pts, 10 * v.z);
        const b = swept.bbox(pts);
        const grad = g.createLinearGradient(b.x, b.y, b.x + b.w * 0.4, b.y + b.h);
        grad.addColorStop(0, rgba(light.poolTint, light.poolAlpha));
        grad.addColorStop(1, rgba(light.poolTint, 0));
        g.fillStyle = grad;
        g.fill();
      }
      g.restore();
    },
  };
}
