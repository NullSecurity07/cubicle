import { TILE } from './tiles.js';
import { CAPTION_BAND } from './text.js';

/** Integer zooms only: pixel art stays crisp. Plan 2 (D26) owns this set. */
export const ZOOM_STEPS = [1, 2, 3, 4];
/**
 * The one exception, and only for `fitTower`: the tower is 53 rows from roof to pavement — 848 px — and no viewport
 * this product targets has that much room between the bars, so no integer zoom fits it. A half is the one other
 * ratio that stays exact under nearest-neighbour sampling (two world pixels to one screen pixel, nothing averaged),
 * which is why the tower elevation is 0.5 and not the 0.909 the old fit landed on and resampled everything at.
 */
export const TOWER_ZOOM = 0.5;
export const FIT_STEPS = [TOWER_ZOOM, ...ZOOM_STEPS];
/** One floor with a tile of margin each side: 51 tiles of building + 2, 14 rows + 2. */
export const FLOOR_VIEW = { w: (51 + 2) * TILE, h: (14 + 2) * TILE };
/** A floor object is `FLOOR_STRIDE + 1` rows: the slab, the rooms, the corridor, and the slab of the floor below. */
export const FLOOR_ROWS = 14;
/**
 * Chrome that overlays the canvas and must not count as usable room: the top bar and the time bar over it
 * (`--bar-h` and `--time-h`), and the floor rail down its left edge (`--rail-w`). `camera.test.ts` and
 * `decor.test.ts` hold these against ui/tokens.css.
 */
export const CHROME = { top: 52, bottom: 64, left: 44 } as const;
export const BARS_H = CHROME.top + CHROME.bottom;
/** Half a tile of air inside the viewport edge, so a floor fit never ends mid-object (visual QA I11). */
export const GUTTER = TILE / 2;

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
/** Largest step of `steps` that still fits, the smallest step when none does. */
export function stepDown(z: number, steps: readonly number[] = FIT_STEPS): number {
  let out = steps[0];
  for (const s of steps) if (s <= z + 1e-6 && s > out) out = s;
  return out;
}
export function fitZoom(viewW: number, viewH: number, w: number, h: number): number { return Math.min(viewW / w, viewH / h); }

/** A world rectangle, in world pixels. */
export interface Rect { x: number; y: number; w: number; h: number }
export const rectOfTiles = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: x0 * TILE, y: y0 * TILE, w: (x1 - x0 + 1) * TILE, h: (y1 - y0 + 1) * TILE });

/**
 * Where the camera has to sit for `rect` to be whole and centred in the part of the canvas the overlay leaves free.
 *
 * The canvas runs edge to edge under the bars and the rail, so a fit that divides `scale.height` puts a third of
 * the subject behind chrome: `09a-tower-day` had F4's desks under the top bar and the street reduced to a sliver.
 * The zoom divides the free area, and the centre is pushed back by half of the difference the chrome makes, so
 * what the eye sees centred is the rectangle and not the canvas.
 */
export function cameraCentre(rect: Rect, zoom: number): { cx: number; cy: number } {
  return { cx: rect.x + rect.w / 2 - CHROME.left / 2 / zoom, cy: rect.y + rect.h / 2 + (BARS_H / 2 - CHROME.top) / zoom };
}

/**
 * Keep the bottom of the viewport on the map.
 *
 * Only the bottom: the tower stands in the sky, so a camera on F4 looking over the roof is right, and the columns
 * either side of the building are sky at every elevation. Below the pavement there is nothing to draw, and a
 * centred F1 put nine rows of void under the street. A view too tall for the map is left where it was — that is
 * the tower fit, which frames the whole map on purpose.
 */
export function clampBottom(cy: number, zoom: number, viewH: number, worldH: number): number {
  const half = viewH / 2 / zoom;
  return worldH >= half * 2 ? Math.min(cy, worldH - half) : cy;
}

/** How much sky a floor view may hold above the roofline before the frame is mostly nothing. */
export const ROOF_SKY = TILE * 2;
/**
 * Keep the roofline near the top of the frame.
 *
 * `clampBottom` had no partner, so the top floor was centred in the band with 229 px of flat sky above the roof
 * while the floors below ran off the bottom edge — a third of `06-f4` and the whole top third of
 * `10-browser-live` was void (visual QA R-I1). Two tiles of sky say "this is the top of the building"; more says
 * nothing at all, and the frame is better spent on the tower.
 */
export function clampTop(cy: number, zoom: number, viewH: number, roofY: number, sky = ROOF_SKY): number {
  const half = viewH / 2 / zoom;
  return Math.max(cy, roofY - sky + half - CHROME.top / zoom);
}
export function fitCamera(viewW: number, viewH: number, rect: Rect, steps: readonly number[] = FIT_STEPS): { zoom: number; cx: number; cy: number } {
  const usableW = Math.max(1, viewW - CHROME.left - GUTTER * 2), usableH = Math.max(1, viewH - BARS_H - GUTTER * 2);
  const zoom = stepDown(Math.min(usableW / rect.w, usableH / rect.h), steps);
  return { zoom, ...cameraCentre(rect, zoom) };
}

/**
 * Camera bounds that still contain the viewport at the tower elevation. A 1280 px viewport at zoom 0.5 sees 2560
 * world pixels, and the map is 960 wide: with the old world-plus-64 bounds, Phaser's own clamp pinned the scroll
 * and the tower ended up against the left edge of the frame. The margin is whatever the widest view needs, plus a
 * tile of play so the fit's own rail offset is never clamped away.
 */
export function cameraBounds(viewW: number, viewH: number, worldW: number, worldH: number, minZoom = TOWER_ZOOM): Rect {
  const mx = Math.max(64, (viewW / minZoom - worldW) / 2 + TILE * 8), my = Math.max(64, (viewH / minZoom - worldH) / 2 + TILE * 8);
  return { x: -mx, y: -my, w: worldW + mx * 2, h: worldH + my * 2 };
}

/**
 * The zoom a floor view uses: the largest integer zoom at which the floor's rows fit the height the bars leave AND
 * the building's full width fits the width the rail leaves.
 *
 * The width term is back, and it is what decides at 1280 × 800. Dropping it is what put a floor view at zoom 2,
 * where 40 of the building's 51 columns are on screen and the end rooms lose their desks — the CTO's office in
 * `06-f4` was an empty rectangle because the desk was off the left edge. The three elevations of the design
 * principles are the tower (0.5), a whole floor (1 here), and a room (2–4, reached by clicking or the wheel).
 */
export function floorZoom(viewW: number, viewH: number, buildingW = 51 * TILE): number {
  const usableW = Math.max(1, viewW - CHROME.left - GUTTER * 2), usableH = Math.max(1, viewH - BARS_H - GUTTER * 2);
  return snapZoomDown(Math.min(usableW / buildingW, usableH / (FLOOR_ROWS * TILE)));
}

/** A band of the world, in world pixels: what the focus veil dims. */
export interface Band { x: number; y: number; w: number; h: number }
/** What `veilBands` needs of a floor: its own top row and the row of the floor below it (`y1 + 1` at the bottom). */
export interface FloorRows { n: number; y0: number; y1: number }

/**
 * The world outside the floor in focus: the tower above it, the tower below it, and the street.
 *
 * A floor view is 13 rows of a 64-row map, so whatever the zoom, the neighbouring floors share the frame — at full
 * brightness they carried their own room signs and screens, and `03-f1` read as if the whiteboard belonged to Dev.
 * Dimming them is the answer the tower already proves with its night rect: the floor you are on is lit, the rest of
 * the building is context.
 *
 * Two things decide where a band ends:
 *  - the floor *below* is what bounds this one, not `y1`: floor objects are `FLOOR_STRIDE + 1` rows and overlap by
 *    the slab they share, so cutting at `y1 + 1` left the next floor's wall row lit;
 *  - both edges then move up by `CAPTION_BAND`, because a screen's caption plate hangs above the screen's own top
 *    row and so sits on the slab of the floor above it. Cut on the floor boundary and every focused floor's own
 *    captions are dimmed while the floor below's are lit — a lit label glued to an unlit screen (R-C1).
 *
 * The tower bands are the building's own columns, never wider: the sky either side is screen-space and carries its
 * own night, and a veil drawn over it leaves a rectangle of darker sky with a visible edge. That is not a
 * hypothetical — the bands ran a tile wide of the building on each side, and once the floor scenes were taken by
 * day (visual QA R-I4) the result was a hard vertical seam down both sides of the frame, sky at rgb(190,216,241)
 * above the focused floor and rgb(91,106,135) beside the ones below it. The street is the one band that runs the
 * full width of the map, because the pavement does.
 */
export function veilBands(n: number, floors: readonly FloorRows[], building: { x0: number; x1: number; y0: number; y1: number }, world: { cols: number; rows: number }): Band[] {
  const floor = floors.find((f) => f.n === n);
  if (!floor) return [];
  const below = floors.find((f) => f.n === n - 1);
  const bot = below ? below.y0 : floor.y1 + 1;
  const x = building.x0 * TILE, w = (building.x1 - building.x0 + 1) * TILE;
  const top = (building.y0 - 1) * TILE, foot = (building.y1 + 2) * TILE;
  // The lower edge only moves up where there is a floor below with captions to protect; the ground floor's own
  // last row is its own.
  const lit0 = floor.y0 * TILE - CAPTION_BAND, lit1 = bot * TILE - (below ? CAPTION_BAND : 0);
  const out: Band[] = [];
  if (lit0 > top) out.push({ x, y: top, w, h: lit0 - top });
  if (lit1 < foot) out.push({ x, y: lit1, w, h: foot - lit1 });
  if (foot < world.rows * TILE) out.push({ x: 0, y: foot, w: world.cols * TILE, h: world.rows * TILE - foot });
  return out;
}
/** How dark the veil goes. Enough to push a floor back without hiding that the tower continues. */
export const VEIL_ALPHA = 0.55;
/** The veil belongs to the floor and room elevations; at the tower fit the whole building is the subject. */
export function veilAlpha(zoom: number): number { return zoom >= 1 - 1e-6 ? VEIL_ALPHA : 0; }
