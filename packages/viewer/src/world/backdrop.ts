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
  return { x, y, width: (b.x1 - b.x0 + 1 + margin * 2) * tile, height: (b.y1 - b.y0 + 1 + margin * 2) * tile };
}

/**
 * The pavement, in world pixels: everything below the building's own night rect, across the full width of the map.
 *
 * The tower fit puts the street in frame (checklist: "four floors, the lobby and the street in one frame"), and a
 * night that stopped at the building's foundations left a strip of bright daylight pavement under a dark tower.
 * It is a second rectangle rather than a taller one because the columns either side of the building are sky, and
 * the sky carries its own night stops — tinting those twice is what made the night near-black before.
 */
export function streetRect(b: TileRect, tile: number, worldW: number, worldH: number, margin = 1): Rect {
  const y = (b.y1 + margin + 1) * tile;
  return { x: 0, y, width: worldW * tile, height: Math.max(0, worldH * tile - y) };
}

/**
 * The colour the canvas clears to. It can only show through in the frame before the sky texture exists, but that
 * frame is the white flash the review caught, so it follows the sky's horizon stop rather than the page theme.
 */
export function backdropColour(stops: readonly [string, string]): string { return stops[1]; }
