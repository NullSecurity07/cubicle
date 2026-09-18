/**
 * The camera over the campus.
 *
 * Fractional and eased, in both axes and in zoom: there are no integer zoom steps any more, because there is no
 * pixel grid left to keep a sprite crisp on — everything is drawn as vector at device pixel ratio, so a camera
 * between two zooms is not a resampled picture, it is the picture.
 *
 * `at` is the grid cell under the middle of the *free* area, not under the middle of the canvas: the rail runs
 * down the left edge and the bars sit over the top and bottom, and a fit that divides the whole canvas puts a
 * third of its subject behind chrome.
 */
import { TILE_H, TILE_W, type Cell, type Pt, type Rect, type View, view } from './iso.js';
import { MOTION } from './motion.js';

/**
 * Chrome that overlays the canvas and must not count as usable room: the top bar and the time bar over it
 * (`--bar-h` and `--time-h`), and the zone rail down the left edge (`--rail-w`). `camera.test.ts` holds these
 * against ui/tokens.css.
 */
/** What the HTML layer takes out of the canvas: the top bar, the time bar, the zone rail, and a control's
 *  own height (the minimap's M toggle sits `hit` above it). The camera frames inside this, and so do the plates. */
export const CHROME = { top: 52, bottom: 64, left: 96, hit: 32 } as const;
/** A little air inside the free area, so a fit never ends hard against the chrome. */
export const GUTTER = 18;

/** How far the camera may be pushed. Below the first the campus is a postage stamp; above the last a face is soft. */
export const ZOOM_MIN = 0.22, ZOOM_MAX = 2.2;
export const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** The world-pixel size of a grid rectangle, ignoring height. */
export function worldSize(r: Rect): { w: number; h: number } {
  const dx = r.x1 - r.x0, dy = r.y1 - r.y0;
  return { w: (dx + dy) * (TILE_W / 2), h: (dx + dy) * (TILE_H / 2) };
}

/** The zoom at which a grid rectangle fits the free area, with `head` cells of height allowed above the floor. */
export function fitZoom(r: Rect, viewW: number, viewH: number, head = 0): number {
  const s = worldSize(r);
  const usableW = Math.max(80, viewW - CHROME.left - GUTTER * 2);
  const usableH = Math.max(80, viewH - CHROME.top - CHROME.bottom - GUTTER * 2);
  return clampZoom(Math.min(usableW / Math.max(1, s.w), usableH / Math.max(1, s.h + head * 34)));
}

export const centreOf = (r: Rect): Cell => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

/** Easing: a critically-damped approach, so a camera never overshoots and never quite stops short. */
function approach(current: number, target: number, dt: number, rate: number): number {
  if (MOTION.scale === 0) return target;
  const k = 1 - Math.exp(-rate * dt / Math.max(0.05, MOTION.scale));
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 1e-4 ? target : next;
}

export interface CameraOpts { w: number; h: number; bounds: Rect }

export class Camera {
  at: Cell;
  zoom: number;
  /** where the camera is heading; equal to `at`/`zoom` once it has arrived */
  targetAt: Cell;
  targetZoom: number;
  w: number; h: number;
  bounds: Rect;
  /** the pan rate, per second; a drag sets both ends at once so it is exact */
  rate = 9;

  constructor(o: CameraOpts & { at?: Cell; zoom?: number }) {
    this.w = o.w; this.h = o.h; this.bounds = o.bounds;
    this.at = { ...(o.at ?? centreOf(o.bounds)) };
    this.targetAt = { ...this.at };
    this.zoom = o.zoom ?? 0.5;
    this.targetZoom = this.zoom;
  }

  get settled(): boolean {
    return Math.abs(this.at.x - this.targetAt.x) < 1e-3 && Math.abs(this.at.y - this.targetAt.y) < 1e-3 && Math.abs(this.zoom - this.targetZoom) < 1e-4;
  }

  resize(w: number, h: number): void { this.w = w; this.h = h; this.clamp(); }

  /** The projection for this frame. */
  view(): View {
    return view({ at: this.at, zoom: this.zoom, w: this.w, h: this.h, pan: { x: CHROME.left / 2, y: (CHROME.top - CHROME.bottom) / 2 } });
  }

  step(dt: number): void {
    this.zoom = approach(this.zoom, this.targetZoom, dt, this.rate * 1.15);
    this.at = { x: approach(this.at.x, this.targetAt.x, dt, this.rate), y: approach(this.at.y, this.targetAt.y, dt, this.rate) };
  }

  /** Screen pixel → grid cell on the floor plane. */
  toGrid(sx: number, sy: number): Cell {
    const v = this.view();
    const o = v.p(0, 0, 0);
    const wx = (sx - o.x) / this.zoom, wy = (sy - o.y) / this.zoom;
    return { x: wx / TILE_W + wy / TILE_H, y: wy / TILE_H - wx / TILE_W };
  }

  /** Grid cell → screen pixel, at this frame's projection. */
  toScreen(gx: number, gy: number, gz = 0): Pt { return this.view().p(gx, gy, gz); }

  /** Head for a cell; `now` lands there this frame (a drag, the console) rather than easing. */
  panTo(at: Cell, o: { zoom?: number; now?: boolean } = {}): void {
    this.targetAt = { ...at };
    if (o.zoom !== undefined) this.targetZoom = clampZoom(o.zoom);
    if (o.now) { this.at = { ...this.targetAt }; this.zoom = this.targetZoom; }
    this.clamp();
  }

  /** Frame a grid rectangle: the zoom that fits it and the centre that holds it. */
  frame(r: Rect, o: { head?: number; zoom?: number; now?: boolean } = {}): void {
    const z = o.zoom ?? fitZoom(r, this.w, this.h, o.head ?? 0);
    this.panTo(centreOf(r), { zoom: z, ...(o.now ? { now: true } : {}) });
  }

  /** Drag: move the target by a screen-space delta at the current zoom, with no easing behind it. */
  nudge(dxPx: number, dyPx: number): void {
    const wx = -dxPx / this.zoom, wy = -dyPx / this.zoom;
    this.targetAt = { x: this.targetAt.x + wx / TILE_W + wy / TILE_H, y: this.targetAt.y + wy / TILE_H - wx / TILE_W };
    this.at = { ...this.targetAt };
    this.clamp();
  }

  /** Zoom while keeping the grid point under (px, py) where it is. */
  zoomAbout(z: number, px: number, py: number): void {
    const want = clampZoom(z);
    if (Math.abs(want - this.targetZoom) < 1e-4) return;
    const before = this.toGrid(px, py);
    const prev = this.zoom;
    this.zoom = want;
    const after = this.toGrid(px, py);
    this.zoom = prev;
    this.targetZoom = want;
    this.targetAt = { x: this.targetAt.x + (before.x - after.x), y: this.targetAt.y + (before.y - after.y) };
    this.clamp();
  }

  /**
   * Keep the campus in view.
   *
   * Not "keep the viewport inside the campus": at the overview the campus is smaller than the frame in one axis
   * and a viewport clamp would pin it to an edge. What is held is the *centre*, inside the campus plus a margin
   * that shrinks as the camera zooms in — so an owner can push a little past the edge to look at the back wall
   * and cannot lose the office off the side of the screen.
   */
  clamp(): void {
    const m = 3;
    const b = this.bounds;
    const cl = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    this.targetAt = { x: cl(this.targetAt.x, b.x0 - m, b.x1 + m), y: cl(this.targetAt.y, b.y0 - m, b.y1 + m) };
    this.at = { x: cl(this.at.x, b.x0 - m, b.x1 + m), y: cl(this.at.y, b.y0 - m, b.y1 + m) };
    this.targetZoom = clampZoom(this.targetZoom);
    this.zoom = clampZoom(this.zoom);
  }
}

/**
 * The zoom at which a person is legible — a name plate, a face, the line on a screen.
 *
 * Every "is this close enough to draw text" question in the renderer asks this one, so the whole viewer changes
 * its mind at the same moment rather than one label at a time.
 */
export const ROOM_ZOOM = 0.78;
export const worldTextVisible = (zoom: number): boolean => zoom >= 0.5 - 1e-6;
export const nameLabelVisible = (zoom: number): boolean => zoom >= ROOM_ZOOM - 1e-6;
