import { TILE } from './tiles.js';

/** Integer zooms only: pixel art stays crisp. Plan 2 (D26) owns this set. */
export const ZOOM_STEPS = [1, 2, 3, 4];
/** One floor with a tile of margin each side: 51 tiles of building + 2, 14 rows + 2. */
export const FLOOR_VIEW = { w: (51 + 2) * TILE, h: (14 + 2) * TILE };
/** A floor is 16 rows plus the corridor row below it: what `focusFloor` must actually get on screen. */
export const FLOOR_ROWS = 17;
/** Chrome that overlays the canvas and must not count as usable height: the 52 px top bar and the 52 px time bar. */
export const BARS_H = 104;

export function snapZoom(z: number): number {
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - z) < Math.abs(best - z) ? s : best), ZOOM_STEPS[0]);
}
/** Next integer zoom in the direction of the wheel: a fractional zoom snaps to the neighbour on that side first. */
export function zoomSnap(current: number, dir: 1 | -1): number {
  const lo = ZOOM_STEPS[0], hi = ZOOM_STEPS[ZOOM_STEPS.length - 1];
  const next = dir > 0 ? Math.floor(current + 1e-6) + 1 : Math.ceil(current - 1e-6) - 1;
  return Math.max(lo, Math.min(hi, next));
}
/** Largest integer step that still fits (min 1): "fit" means nothing is cut off. */
export function snapZoomDown(z: number): number { return Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.floor(z + 1e-6))); }
export function fitZoom(viewW: number, viewH: number, w: number, h: number): number { return Math.min(viewW / w, viewH / h); }
/**
 * The zoom `focusFloor` uses: the largest integer zoom at which one floor's 17 rows fit the viewport height minus
 * the bars (ruling F2). Height only — fitting the floor's full 53-tile width as well always loses to the width
 * term at desktop aspect ratios and lands back on zoom 1, i.e. the whole-tower cross-section, which is what
 * "fit tower" is for. The camera centres on the building's horizontal centre instead, so the edge columns fall
 * outside the viewport rather than shrinking everything.
 */
export function floorZoom(_viewW: number, viewH: number): number { return snapZoomDown(Math.max(viewH - BARS_H, 1) / (FLOOR_ROWS * TILE)); }
