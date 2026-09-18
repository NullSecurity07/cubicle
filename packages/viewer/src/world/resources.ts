/**
 * The five things the owner can put on the campus, drawn.
 *
 * Same rules as `props.ts`: a grid rectangle in, a `Drawable` out, every colour from `materials.ts`, every
 * silhouette rounded and two-toned by the one light at the top-left. They are objects in the room, not icons on a
 * map — a browser is a kiosk somebody walks up to, a document is a board on an easel, a note is a square of paper
 * propped on a desk stand. A thing the owner can drag has to look like a thing, or the office is a diagram again.
 *
 * Each is 0.8–1.5 cells tall: below the standing partitions, above a desk, so a row of them never hides a person.
 */
import { type Pt, type Rect, type View, centre } from './iso.js';
import { ACCENT, type Light, MATERIAL as M, dim, lit, mix, rgba, shade, warm } from './materials.js';
import { type G, type PanelSpec, MONO_FONT, UI_FONT, bbox, faceQuad, faceText, fillPoly, glow, isoBox, panel, plate, roundPoly, roundRect } from './shapes.js';
import { type Drawable, shadowVec } from './props.js';
import type { Resource } from './campus.js';
import { type ToolName } from './layout.js';
import * as swept from './shapes.js';

const quadOf = (v: View, r: Rect, z = 0): Pt[] => [v.p(r.x0, r.y0, z), v.p(r.x1, r.y0, z), v.p(r.x1, r.y1, z), v.p(r.x0, r.y1, z)];

/** How tall each kind stands, for the culling box and the shadow. */
export const RESOURCE_H: Record<Resource['kind'], number> = { browser: 1.42, doc: 1.34, note: 1.2, site: 1.5, station: 1.16 };

/** The one `Drawable` for anything the owner added. */
export function resourceProp(r: Resource): Drawable {
  const c = centre(r.rect);
  const h = RESOURCE_H[r.kind];
  return {
    d: c.x + c.y + 0.01,
    bounds: { x0: r.rect.x0 - 0.35, y0: r.rect.y0 - 0.35, x1: r.rect.x1 + 0.35, y1: r.rect.y1 + 0.45 },
    hz: h + 0.9,
    shadow(g, v, light) {
      const s = shadowVec(v, light, h * 0.62);
      swept.sweepShadow(g, quadOf(v, inset(r.rect, 0.08)), s.dx, s.dy, light.shadowAlpha, light.shadowTint);
    },
    draw(g, v, light) {
      switch (r.kind) {
        case 'browser': drawKiosk(g, v, light, r); break;
        case 'doc': drawBoard(g, v, light, r); break;
        case 'note': drawSticky(g, v, r); break;
        case 'site': drawSiteScreen(g, v, light, r); break;
        case 'station': drawStation(g, v, light, r); break;
      }
      // The name goes on a plate close in, exactly as a screen's does, so a kiosk and the terminal are named by the
      // same object and the campus has one way of saying what a thing is. Over the thing's own middle: hung off a
      // corner of the footprint it drifted up and to the left of whatever it was naming (visual QA SP9b-4).
      if (v.z > 0.7) {
        plate(g, v.p(c.x, c.y, RESOURCE_H[r.kind] + 0.45), r.label, { size: 11, chip: ACCENT[r.accent].chip, alpha: 0.93, lift: 1 });
      }
    },
  };
}

const inset = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, y0: r.y0 + d, x1: r.x1 - d, y1: r.y1 - d });

/** The upright face of a thing, turned towards the camera: a panel across the near edge of its footprint. */
function facePanel(r: Rect, z: number, h: number, pad = 0.12): PanelSpec {
  return { x: r.x0 + pad, y: r.y1 - pad, axis: 'x', len: r.x1 - r.x0 - pad * 2, z, h };
}

/** A lit screen inside an upright face: the soft dark glass every surface in the campus is made of. */
function glassFace(g: G, v: View, s: PanelSpec, light: Light, tint: string = M.screen): { face: Pt[]; box: { x: number; y: number; w: number; h: number } } {
  const face = faceQuad(v, s);
  roundPoly(g, face, Math.max(1.5, 3 * v.z));
  const b = bbox(face);
  const grad = g.createLinearGradient(b.x, b.y, b.x + b.w * 0.5, b.y + b.h);
  grad.addColorStop(0, shade(tint, 0.07));
  grad.addColorStop(1, shade(tint, -0.01));
  g.fillStyle = grad;
  g.fill();
  glow(g, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, Math.max(b.w, b.h) * 0.8, M.screenGlow, light.name === 'dusk' ? 0.18 : 0.07);
  return { face, box: b };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the five                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * A browser kiosk: a slim charcoal column with a screen on its head, the way a check-in terminal stands in a
 * lobby. The screen carries a stand-in page — a chrome bar with three dots and two rules — because a kiosk showing
 * nothing reads as switched off, and the office is never switched off.
 */
function drawKiosk(g: G, v: View, light: Light, r: Resource): void {
  const a = ACCENT[r.accent];
  const foot = inset(r.rect, 0.3);
  // a soft base, a column, then the head
  fillPoly(g, quadOf(v, inset(r.rect, 0.24), 0), 5 * v.z, lit(M.charcoal), dim(M.charcoal));
  isoBox(g, v, { ...foot, z: 0, h: 0.72 }, shade(M.charcoal, 0.03), { r: Math.max(2, 4 * v.z) });
  const headZ = 0.72;
  isoBox(g, v, { ...inset(r.rect, 0.14), z: headZ, h: 0.1 }, M.charcoal, { r: Math.max(2, 5 * v.z), topColour: shade(M.charcoal, 0.08) });
  const bezel = facePanel(r.rect, headZ + 0.1, 0.56, 0.16);
  panel(g, v, bezel, shade(M.screen, -0.05), { thick: 0.08, r: Math.max(2, 4 * v.z) });
  const inner: PanelSpec = { x: bezel.x + 0.07, y: bezel.y - 0.012, axis: 'x', len: bezel.len - 0.14, z: bezel.z! + 0.06, h: bezel.h - 0.12 };
  const { face, box } = glassFace(g, v, inner, light);
  if (v.z > 0.5) {
    g.save();
    roundPoly(g, face, Math.max(1.5, 3 * v.z));
    g.clip();
    // the chrome bar across the top of the page, and two rules of content under it
    const hpx = inner.h * v.cz;
    const line = (up: number, from: number, len: number, colour: string, thick: number): void => {
      const z = inner.z! + up / v.cz;
      const p0 = v.p(inner.x + inner.len * from, inner.y, z), p1 = v.p(inner.x + inner.len * (from + len), inner.y, z);
      g.strokeStyle = colour;
      g.lineWidth = Math.max(1, thick * v.z);
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
    };
    line(hpx * 0.82, 0.08, 0.2, rgba(a.base, 0.9), 2.6);
    line(hpx * 0.82, 0.34, 0.58, rgba(M.screenDim, 0.75), 2.2);
    line(hpx * 0.52, 0.08, 0.7, rgba(M.screenInk, 0.6), 2);
    line(hpx * 0.3, 0.08, 0.46, rgba(M.screenInk, 0.34), 2);
    g.restore();
  }
  // the accent hairline along the column's front edge: the mark a desk, a partition and a station all wear, so a
  // kiosk reads as a piece of this office's furniture rather than as a prop borrowed from another drawing
  const p0 = v.p(foot.x0 + 0.06, foot.y1, 0.62), p1 = v.p(foot.x1 - 0.06, foot.y1, 0.62);
  g.strokeStyle = rgba(a.chip, 0.9);
  g.lineWidth = Math.max(1.2, 2.4 * v.z);
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
  void box;
}

/**
 * A document board: a vault note pinned up where the room can read it. A pale sheet in a walnut frame on a low
 * easel, with three rules of type and the note's own heading rule in the accent.
 */
function drawBoard(g: G, v: View, light: Light, r: Resource): void {
  const a = ACCENT[r.accent];
  const legZ = 0.5;
  // Two legs leaning back, with a cross-bar the board sits on. Thin sticks with nothing between them read as a
  // music stand; the bar is what makes it an easel (visual QA SP9b-4).
  g.save();
  g.strokeStyle = shade(M.walnut, -0.08);
  g.lineWidth = Math.max(1.8, 4 * v.z);
  g.lineCap = 'round';
  for (const fx of [0.14, 0.86]) {
    const x = r.rect.x0 + (r.rect.x1 - r.rect.x0) * fx;
    const p0 = v.p(x, r.rect.y1 - 0.04, 0), p1 = v.p(x, r.rect.y0 + 0.2, legZ + 0.66);
    g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
  }
  const barL = v.p(r.rect.x0 + 0.1, r.rect.y1 - 0.14, legZ - 0.06), barR = v.p(r.rect.x1 - 0.1, r.rect.y1 - 0.14, legZ - 0.06);
  g.lineWidth = Math.max(1.6, 3.4 * v.z);
  g.beginPath(); g.moveTo(barL.x, barL.y); g.lineTo(barR.x, barR.y); g.stroke();
  g.restore();
  const frame = facePanel(r.rect, legZ, 0.78, 0.06);
  panel(g, v, frame, M.walnut, { thick: 0.09, r: Math.max(2, 4 * v.z), capColour: M.walnutPale });
  const sheet: PanelSpec = { x: frame.x + 0.1, y: frame.y - 0.012, axis: 'x', len: frame.len - 0.2, z: frame.z! + 0.08, h: frame.h - 0.16 };
  const face = faceQuad(v, sheet);
  roundPoly(g, face, Math.max(1.5, 2.5 * v.z));
  const b = bbox(face);
  const grad = g.createLinearGradient(b.x, b.y, b.x + b.w * 0.4, b.y + b.h);
  grad.addColorStop(0, warm(M.board, 0.03, 3));
  grad.addColorStop(1, shade(M.board, -0.04));
  g.fillStyle = grad;
  g.fill();
  if (v.z > 0.5) {
    g.save();
    roundPoly(g, face, Math.max(1.5, 2.5 * v.z));
    g.clip();
    const hpx = sheet.h * v.cz;
    const maxW = Math.max(8, (sheet.len - 0.16) * 32 * v.z);
    const size = Math.max(4, Math.min(9.5, hpx / 5.4));
    faceText(g, v.p(sheet.x + 0.1, sheet.y - 0.014, sheet.z! + (hpx * 0.68) / v.cz), 'x', r.label, { size, colour: a.ink, weight: 700, font: UI_FONT, maxWidth: maxW });
    for (const [up, len] of [[0.44, 0.88], [0.28, 0.74], [0.13, 0.52]] as [number, number][]) {
      const z = sheet.z! + (hpx * up) / v.cz;
      const p0 = v.p(sheet.x + 0.1, sheet.y - 0.014, z), p1 = v.p(sheet.x + 0.1 + (sheet.len - 0.2) * len, sheet.y - 0.014, z);
      g.strokeStyle = rgba(M.ink, 0.2);
      g.lineWidth = Math.max(1, 1.6 * v.z);
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
    }
    g.restore();
  }
  void light;
}

/**
 * A sticky note: a small warm square, lifted a little off the floor on a wire stand and tipped back, with the
 * owner's own hand on it as three short rules. The one object in the campus that is theirs and nobody else's.
 */
function drawSticky(g: G, v: View, r: Resource): void {
  const a = ACCENT[r.accent];
  const c = centre(r.rect);
  const base = v.p(c.x, c.y, 0);
  const stemTop = v.p(c.x, c.y, 0.45);
  // A wire foot and a stem, so the square is propped at reading height rather than lying on the floor. At 0.42
  // cells the paper was a beige smudge the size of a mug from two desks away (visual QA SP9b-4).
  fillPoly(g, [v.p(c.x - 0.2, c.y, 0), v.p(c.x, c.y - 0.2, 0), v.p(c.x + 0.2, c.y, 0), v.p(c.x, c.y + 0.2, 0)], 3 * v.z, lit(M.rail), dim(M.rail));
  g.save();
  g.strokeStyle = shade(M.rail, -0.08);
  g.lineWidth = Math.max(1.2, 2.4 * v.z);
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(base.x, base.y); g.lineTo(stemTop.x, stemTop.y); g.stroke();
  g.restore();
  // Over its own stem, not on the front edge of the footprint: a panel at `y1` stands a third of a cell forward
  // of the post holding it up, and the note then reads as floating (visual QA SP9b-5).
  const paper: PanelSpec = { x: r.rect.x0 + 0.06, y: c.y + 0.06, axis: 'x', len: r.rect.x1 - r.rect.x0 - 0.12, z: 0.45, h: 0.72 };
  const face = faceQuad(v, paper);
  roundPoly(g, face, Math.max(1.5, 2.5 * v.z));
  const b = bbox(face);
  g.fillStyle = swept.twoTone(g, b, warm(M.jar, 0.09, 4), M.jar, 0.55);
  g.fill();
  // a folded corner: the one bit of character a square of paper gets
  const fold = [v.p(paper.x + paper.len - 0.2, paper.y, paper.z!), v.p(paper.x + paper.len, paper.y, paper.z!), v.p(paper.x + paper.len, paper.y, paper.z! + 0.2)];
  fillPoly(g, fold, 1.5 * v.z, shade(M.jar, -0.1), shade(M.jar, -0.16));
  if (v.z > 0.55) {
    g.save();
    roundPoly(g, face, Math.max(1.5, 2.5 * v.z));
    g.clip();
    const hpx = paper.h * v.cz;
    for (const [up, len] of [[0.74, 0.8], [0.54, 0.9], [0.34, 0.62], [0.16, 0.4]] as [number, number][]) {
      const z = paper.z! + (hpx * up) / v.cz;
      const p0 = v.p(paper.x + 0.1, paper.y - 0.012, z), p1 = v.p(paper.x + 0.1 + (paper.len - 0.2) * len, paper.y - 0.012, z);
      g.strokeStyle = rgba(a.ink, 0.42);
      g.lineWidth = Math.max(1, 1.5 * v.z);
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
    }
    g.restore();
  }
}

/**
 * The site: a wide screen on a slim stand showing the company's own page — a header band in the accent and three
 * blocks under it. Not a browser: this one is always the live site, so it is drawn as a page and not as a window.
 */
function drawSiteScreen(g: G, v: View, light: Light, r: Resource): void {
  const a = ACCENT[r.accent];
  const c = centre(r.rect);
  const footR = inset(r.rect, 0.5);
  fillPoly(g, quadOf(v, { x0: c.x - 0.45, y0: c.y - 0.2, x1: c.x + 0.45, y1: c.y + 0.2 }, 0), 5 * v.z, lit(M.charcoal), dim(M.charcoal));
  const stem0 = v.p(c.x, c.y, 0.02), stem1 = v.p(c.x, c.y, 0.62);
  g.strokeStyle = shade(M.charcoal, 0.06);
  g.lineWidth = Math.max(1.6, 4.5 * v.z);
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(stem0.x, stem0.y); g.lineTo(stem1.x, stem1.y); g.stroke();
  const bezel = facePanel(r.rect, 0.6, 0.82, 0.08);
  panel(g, v, bezel, shade(M.screen, -0.04), { thick: 0.07, r: Math.max(2, 4 * v.z) });
  const inner: PanelSpec = { x: bezel.x + 0.07, y: bezel.y - 0.012, axis: 'x', len: bezel.len - 0.14, z: bezel.z! + 0.06, h: bezel.h - 0.12 };
  const { face } = glassFace(g, v, inner, light, mix(M.screen, M.white, 0.06));
  if (v.z > 0.5) {
    g.save();
    roundPoly(g, face, Math.max(1.5, 3 * v.z));
    g.clip();
    const hpx = inner.h * v.cz;
    // the header band, then three blocks of page
    const band: PanelSpec = { x: inner.x, y: inner.y, axis: 'x', len: inner.len, z: inner.z! + (hpx * 0.74) / v.cz, h: (hpx * 0.26) / v.cz };
    fillPoly(g, faceQuad(v, band), 1.5, rgba(a.base, 0.85), rgba(a.base, 0.6));
    for (let i = 0; i < 3; i++) {
      const bx = inner.x + 0.06 + i * ((inner.len - 0.12) / 3);
      const blk: PanelSpec = { x: bx, y: inner.y, axis: 'x', len: (inner.len - 0.12) / 3 - 0.06, z: inner.z! + (hpx * 0.18) / v.cz, h: (hpx * 0.42) / v.cz };
      fillPoly(g, faceQuad(v, blk), 1.5, rgba(M.screenInk, 0.24), rgba(M.screenInk, 0.14));
    }
    g.restore();
  }
  void footR;
}

/** The glyph each tool family wears. Drawn into the station's face, never as an emoji or an image. */
const STATION_GLYPH: Record<ToolName, (g: G, v: View, s: PanelSpec, colour: string) => void> = {
  email: (g, v, s, colour) => {
    // an envelope: a rectangle with its flap folded down
    const box = faceRect(v, s, 0.22, 0.28, 0.56, 0.44);
    g.strokeStyle = colour;
    g.lineWidth = Math.max(1.2, 2.2 * v.z);
    g.lineJoin = 'round';
    roundPoly(g, box, 2 * v.z);
    g.stroke();
    g.beginPath();
    g.moveTo(box[0].x, box[0].y);
    g.lineTo((box[0].x + box[2].x) / 2, (box[0].y + box[2].y) / 2);
    g.lineTo(box[1].x, box[1].y);
    g.stroke();
  },
  deploy: (g, v, s, colour) => {
    // an arrow leaving the ground, with a margin round it: a glyph touching both edges of its own face reads as
    // a badge rather than as a sign on a station (visual QA SP9b-5)
    const a = faceAt(v, s, 0.5, 0.26), b = faceAt(v, s, 0.5, 0.7);
    g.strokeStyle = colour;
    g.lineWidth = Math.max(1.2, 2.4 * v.z);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    const l = faceAt(v, s, 0.32, 0.55), rr = faceAt(v, s, 0.68, 0.55);
    g.beginPath(); g.moveTo(l.x, l.y); g.lineTo(b.x, b.y); g.lineTo(rr.x, rr.y); g.stroke();
  },
  analytics: (g, v, s, colour) => {
    // three bars, rising
    g.strokeStyle = colour;
    g.lineWidth = Math.max(1.6, 3.4 * v.z);
    g.lineCap = 'round';
    [[0.28, 0.44], [0.5, 0.62], [0.72, 0.82]].forEach(([fx, top]) => {
      const p0 = faceAt(v, s, fx, 0.2), p1 = faceAt(v, s, fx, top);
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
    });
  },
  memory: (g, v, s, colour) => {
    // a stack of three discs: what was kept
    g.strokeStyle = colour;
    g.lineWidth = Math.max(1.2, 2.2 * v.z);
    for (const up of [0.28, 0.48, 0.68]) {
      const l = faceAt(v, s, 0.24, up), r = faceAt(v, s, 0.76, up);
      g.beginPath();
      g.moveTo(l.x, l.y);
      g.bezierCurveTo(l.x, l.y - 5 * v.z, r.x, r.y - 5 * v.z, r.x, r.y);
      g.stroke();
    }
  },
};

/** A point on an upright face, as fractions of its length and height. */
function faceAt(v: View, s: PanelSpec, fx: number, fy: number): Pt {
  return v.p(s.x + s.len * fx, s.y - 0.012, (s.z ?? 0) + s.h * fy);
}
function faceRect(v: View, s: PanelSpec, x: number, y: number, w: number, h: number): Pt[] {
  return [faceAt(v, s, x, y + h), faceAt(v, s, x + w, y + h), faceAt(v, s, x + w, y), faceAt(v, s, x, y)];
}

/**
 * A tool station: a low plinth with a lit panel on it carrying the family's glyph. Email by the post office,
 * deploy by the terminal, analytics by the newsstand, memory by the vault — a place an agent walks to, so it is
 * furniture at standing height rather than a sign on a wall.
 */
function drawStation(g: G, v: View, light: Light, r: Resource): void {
  const a = ACCENT[r.accent];
  const foot = inset(r.rect, 0.14);
  isoBox(g, v, { ...foot, z: 0, h: 0.62 }, M.walnut, { r: Math.max(2, 4 * v.z), topColour: M.walnutPale });
  isoBox(g, v, { ...inset(r.rect, 0.08), z: 0.62, h: 0.08 }, M.stone, { r: Math.max(2, 4 * v.z), topColour: M.stoneTop });
  const bezel = facePanel(r.rect, 0.7, 0.46, 0.16);
  panel(g, v, bezel, shade(M.screen, -0.04), { thick: 0.07, r: Math.max(2, 4 * v.z) });
  const inner: PanelSpec = { x: bezel.x + 0.06, y: bezel.y - 0.012, axis: 'x', len: bezel.len - 0.12, z: bezel.z! + 0.05, h: bezel.h - 0.1 };
  const { face } = glassFace(g, v, inner, light);
  if (v.z > 0.5 && r.tool) {
    g.save();
    roundPoly(g, face, Math.max(1.5, 3 * v.z));
    g.clip();
    STATION_GLYPH[r.tool](g, v, inner, rgba(mix(a.base, M.white, 0.35), 0.95));
    g.restore();
  }
  // the accent hairline along the plinth's front edge, the same mark a desk wears
  const p0 = v.p(foot.x0 + 0.08, foot.y1, 0.66), p1 = v.p(foot.x1 - 0.08, foot.y1, 0.66);
  g.strokeStyle = rgba(a.chip, 0.9);
  g.lineWidth = Math.max(1.2, 2.4 * v.z);
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the drag: what the floor shows while something is in the air                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The landing footprint, drawn on the floor under the pointer: a dashed outline of the cell the thing will take,
 * in the accent where it may land and in red where something is already there. It is the whole of the answer to
 * "can I drop it here", and it is on the floor rather than on the thing, because the thing is in the air.
 */
export function drawGhost(g: G, v: View, rect: Rect, blocked: boolean): void {
  const pts = quadOf(v, rect, 0);
  g.save();
  roundPoly(g, pts, 6 * v.z);
  g.fillStyle = rgba(blocked ? M.bad : M.attention, blocked ? 0.16 : 0.13);
  g.fill();
  g.setLineDash([Math.max(4, 7 * v.z), Math.max(3, 5 * v.z)]);
  g.strokeStyle = rgba(blocked ? M.bad : M.attention, 0.85);
  g.lineWidth = Math.max(1.4, 2 * v.z);
  g.stroke();
  g.restore();
}

/** The contact shadow a lifted thing casts: bigger and softer than the one it had on the floor. */
export function drawLiftShadow(g: G, v: View, rect: Rect, light: Light): void {
  const s = shadowVec(v, light, 1.5);
  swept.sweepShadow(g, quadOf(v, rect, 0), s.dx, s.dy, light.shadowAlpha * 1.1, light.shadowTint);
}

/** A soft plate the owner reads while placing something from the dock: what it is, under the pointer. */
export function drawPlacingLabel(g: G, at: Pt, text: string, accent: string): void {
  plate(g, { x: at.x, y: at.y - 26 }, text, { size: 11, chip: accent, alpha: 0.95, crowd: false });
}

export { roundRect, MONO_FONT };
