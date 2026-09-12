/**
 * Where the sky and the night tint go. Pure: the scene builds the game objects, this decides their rectangles.
 *
 * Two rules the scene used to get wrong:
 *  - the sky and the night rect were sized to the *world* (960 × 1024) while the camera looks at a 1280-wide
 *    viewport, so a flat slab of the page background flanked the tower and stayed near-white all night (C2).
 *    The sky is screen-space now: it fills the viewport at any zoom, and the surround is whatever the sky is.
 *  - the night rect sat over the sky as well as the building, multiplying the designed night gradient down to
 *    near-black (M20). It covers the building only; the sky already carries its own night stops.
 */

export interface Rect { x: number; y: number; width: number; height: number }
/** A rectangle in tiles, inclusive on both ends — the shape `BUILDING` uses. */
export interface TileRect { x0: number; x1: number; y0: number; y1: number }

/**
 * The sky fills the whole viewport, whatever the camera is doing.
 *
 * `scrollFactor 0` stops an object scrolling; it does not stop the camera *zoom* scaling it about the middle of
 * the viewport. At the tower elevation (zoom 0.5) a viewport-sized sky was drawn at half size in the middle of
 * the canvas, and the flat clear colour showed around it — a rectangle of gradient in a field of horizon, with a
 * hard edge, in the one scene that frames the whole building. So the rectangle is divided by the zoom: what the
 * camera then multiplies back is exactly the viewport.
 */
export function skyRect(viewW: number, viewH: number, zoom = 1): Rect {
  const z = Math.max(1e-6, zoom);
  const w = Math.max(1, Math.ceil(viewW / z)), h = Math.max(1, Math.ceil(viewH / z));
  return { x: viewW / 2 - w / 2, y: viewH / 2 - h / 2, width: w, height: h };
}

/** The night tint, in world pixels: the building plus a tile of margin, and nothing beyond it. */
export function nightRect(b: TileRect, tile: number, margin = 1): Rect {
  const x = (b.x0 - margin) * tile, y = (b.y0 - margin) * tile;
  // The margin is on three sides. At the foot it would overlap the kerb row, which `groundRect` now tints along
  // with the rest of the street: two tints on one row is a dark stripe across the pavement at the building's base.
  return { x, y, width: (b.x1 - b.x0 + 1 + margin * 2) * tile, height: (b.y1 - b.y0 + 1 + margin) * tile };
}

/** How far the ground runs past the map, in world pixels. Wider and deeper than any viewport at the tower fit. */
export const GROUND_OVERSCAN = 4096;
/** Rows of street between the building's last row and the pavement: the kerb, then the carriageway. */
export const ROAD_ROWS = 3;

/**
 * The ground beyond the map: the road and the pavement, each run out past both edges and below.
 *
 * The map is 60 × 64 tiles and the tower fit shows 2560 × 1408 of world, so at that elevation the building stood
 * in the middle of a sky that went on below the pavement and out past both kerbs — by day, a cutaway tower
 * floating in blue (visual QA R-M6; invisible while every scene was night). Two bands, not one, because the map's
 * own street is two colours and a single fill would put a tan step where the asphalt ends.
 *
 * `ROAD_ROWS` mirrors `paintStreet` in `scripts/world/tower.ts`: kerb at `groundY + 1`, carriageway at `+2..+3`,
 * pavement from `+4` down. These draw *under* the tilemap, so inside the map nothing of them shows.
 */
export function groundBands(b: TileRect, tile: number, worldW: number, worldH: number, over = GROUND_OVERSCAN): { road: Rect; pavement: Rect } {
  const x = -over, width = worldW * tile + over * 2;
  const roadY = (b.y1 + 1) * tile, paveY = roadY + ROAD_ROWS * tile;
  return {
    road: { x, y: roadY, width, height: ROAD_ROWS * tile },
    pavement: { x, y: paveY, width, height: Math.max(tile, worldH * tile - paveY + over) },
  };
}
/** The whole ground, as one rectangle: what the night tint covers, so the run-out darkens with the street. */
export function groundRect(b: TileRect, tile: number, worldW: number, worldH: number, over = GROUND_OVERSCAN): Rect {
  const { road, pavement } = groundBands(b, tile, worldW, worldH, over);
  return { x: road.x, y: road.y, width: road.width, height: pavement.y + pavement.height - road.y };
}

/** A star in the night sky, in screen pixels: `s` is its side, 1 or 2. */
export interface Star { x: number; y: number; s: number }
/** Where the sun or the moon sits, in screen pixels, and how big its disc is. */
export interface SkyBody { kind: 'sun' | 'moon'; x: number; y: number; r: number }

/**
 * What is in the sky besides the gradient.
 *
 * Two thirds of the tower frame is sky — the zoom is forced, so the fix is to furnish it rather than to re-fit
 * (visual QA R-M6). A disc high on the right, clear of the top bar and of the tower's own columns, and at night a
 * scatter of stars from a fixed sequence so they never crawl between frames. Positions are fractions of the
 * viewport, so they hold at any window size, and they are whole pixels, because everything else here is.
 */
export function skyBody(viewW: number, viewH: number, kind: 'sun' | 'moon'): SkyBody {
  return { kind, x: Math.round(viewW * 0.8), y: Math.round(viewH * 0.2), r: 10 };
}

/** One row of a rasterised disc: `y` and `x0` are offsets from the centre, `w` the run's width in whole pixels. */
export interface Run { y: number; x0: number; w: number }
/**
 * A filled circle of radius `r` about (0, 0), row by row, on the pixel grid.
 *
 * The first cut of the sun was four overlapping rectangles with the corners taken off, which at r 10 read as a
 * yellow square — a sticky note pinned to the sky rather than a sun (visual QA R-M6). A disc has to actually be
 * round at this size, and it has to be round in whole pixels, because everything else in the frame is.
 *
 * Rows are sampled at their own centres. The half-width is rounded, not floored: floored, the widest run came out
 * two pixels short of the 2r the row count gives, and the sun was visibly an egg.
 */
export function discRuns(r: number): Run[] {
  const out: Run[] = [];
  for (let y = -r; y < r; y++) {
    const dy = y + 0.5;
    const half = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
    if (half > 0) out.push({ y, x0: -half, w: half * 2 });
  }
  return out;
}

/** `n` stars, deterministic by index, never inside the top bar and never in the lower third where the tower is. */
export function stars(viewW: number, viewH: number, n = 44): Star[] {
  const out: Star[] = [];
  let h = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const x = Math.round((h % 10007) / 10007 * viewW);
    h = (h * 1664525 + 1013904223) >>> 0;
    const y = Math.round(60 + (h % 10007) / 10007 * (viewH * 0.62));
    out.push({ x, y, s: (h >>> 16) % 5 === 0 ? 2 : 1 });
  }
  return out;
}

/**
 * The colour the canvas clears to. It can only show through in the frame before the sky texture exists, but that
 * frame is the white flash the review caught, so it follows the sky's horizon stop rather than the page theme.
 */
export function backdropColour(stops: readonly [string, string]): string { return stops[1]; }
