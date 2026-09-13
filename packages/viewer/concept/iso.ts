/**
 * SP9 concept — the projection.
 *
 * One isometric plane, 2:1. A cell is 64 x 32 screen px at zoom 1 and a unit of height is 34 px, which puts a person
 * (1.65 units) at 56 px — the figure height the spec asks for at room zoom.
 *
 * Grid space is the campus floor: `x` runs to the lower-right on screen, `y` to the lower-left, `z` straight up.
 * The grid origin is therefore the *top* vertex of the diamond, the two walls at `x = 0` and `y = 0` are the back
 * walls and we see their inner faces, and depth order is simply `x + y`.
 *
 * There is one projection function and one camera. Everything else in the concept — floors, boxes, upright panels,
 * people, labels — goes through `View.p()`, so re-aiming the camera re-aims the whole picture and nothing drifts.
 */

export const TILE_W = 64;
export const TILE_H = 32;
export const TILE_Z = 34;
/** A person, in height units. 1.65 * 34 = 56 px at zoom 1. */
export const PERSON_H = 1.65;

export interface Pt { x: number; y: number }
export interface Cell { x: number; y: number }
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Grid → unscaled world px, camera-independent. */
export function iso(gx: number, gy: number, gz = 0): Pt {
  return { x: (gx - gy) * (TILE_W / 2), y: (gx + gy) * (TILE_H / 2) - gz * TILE_Z };
}

/** Painter's depth for a cell: the plane is single, so `x + y` is the whole answer. */
export const depth = (gx: number, gy: number): number => gx + gy;

export interface Camera {
  /** the grid cell the camera is centred on */
  at: Cell;
  /** fractional, eased in the real viewer; a plain number here */
  zoom: number;
  /** viewport in CSS px */
  w: number; h: number;
  /** screen-space nudge, for framing chrome out of the way */
  pan?: Pt;
}

export interface View {
  cam: Camera;
  /** grid + height → screen px */
  p(gx: number, gy: number, gz?: number): Pt;
  /** screen px per world px */
  z: number;
  /** one cell, in screen px */
  cw: number; ch: number;
  /** one height unit, in screen px */
  cz: number;
}

export function view(cam: Camera): View {
  const o = iso(cam.at.x, cam.at.y, 0);
  const px = cam.w / 2 - o.x * cam.zoom + (cam.pan?.x ?? 0);
  const py = cam.h / 2 - o.y * cam.zoom + (cam.pan?.y ?? 0);
  return {
    cam,
    z: cam.zoom,
    cw: TILE_W * cam.zoom,
    ch: TILE_H * cam.zoom,
    cz: TILE_Z * cam.zoom,
    p(gx: number, gy: number, gz = 0): Pt {
      const w = iso(gx, gy, gz);
      return { x: px + w.x * cam.zoom, y: py + w.y * cam.zoom };
    },
  };
}

/** The four screen corners of a grid rectangle at height `gz`, clockwise from the top vertex. */
export function quad(v: View, r: Rect, gz = 0): Pt[] {
  return [v.p(r.x0, r.y0, gz), v.p(r.x1, r.y0, gz), v.p(r.x1, r.y1, gz), v.p(r.x0, r.y1, gz)];
}

export const inset = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, y0: r.y0 + d, x1: r.x1 - d, y1: r.y1 - d });
export const centre = (r: Rect): Cell => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

/**
 * The zoom at which a grid rectangle fits a viewport with `pad` px to spare. Used to frame the campus overview
 * rather than hand-tuning a magic number that breaks the moment a zone moves.
 */
export function zoomToFit(r: Rect, w: number, h: number, pad: number): number {
  const wpx = (r.x1 - r.x0 + (r.y1 - r.y0)) * (TILE_W / 2);
  const hpx = (r.x1 - r.x0 + (r.y1 - r.y0)) * (TILE_H / 2);
  return Math.min((w - pad * 2) / wpx, (h - pad * 2) / hpx);
}
