import { TILE } from './tiles.js';

/** Integer zooms only: pixel art stays crisp. Plan 2 (D26) owns this set. */
export const ZOOM_STEPS = [1, 2, 3, 4, 5];
/** One floor with a tile of margin each side: 51 tiles of building + 2, 14 rows + 2. */
export const FLOOR_VIEW = { w: (51 + 2) * TILE, h: (14 + 2) * TILE };

export function snapZoom(z: number): number {
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - z) < Math.abs(best - z) ? s : best), ZOOM_STEPS[0]);
}
export function floorZoom(viewW: number, viewH: number): number {
  const raw = Math.min(viewW / FLOOR_VIEW.w, viewH / FLOOR_VIEW.h);
  return snapZoom(Math.max(0.8, Math.min(5, raw)));
}
