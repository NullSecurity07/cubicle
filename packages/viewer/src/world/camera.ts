import { TILE } from './tiles.js';

/** Integer zooms only: pixel art stays crisp. Plan 2 (D26) owns this set. */
export const ZOOM_STEPS = [1, 2, 3, 4];
/** One floor with a tile of margin each side: 51 tiles of building + 2, 14 rows + 2. */
export const FLOOR_VIEW = { w: (51 + 2) * TILE, h: (14 + 2) * TILE };

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
/** A whole floor in 85 % of the viewport, at an integer zoom. */
export function floorZoom(viewW: number, viewH: number): number { return snapZoomDown(fitZoom(viewW * 0.85, viewH * 0.85, FLOOR_VIEW.w, FLOOR_VIEW.h)); }
