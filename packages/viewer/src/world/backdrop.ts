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
 * The sky fills the whole viewport. It is drawn at `scrollFactor 0`, so this depends on the canvas size and
 * nothing else — not the camera bounds, not the zoom, not the world size.
 */
export function skyRect(viewW: number, viewH: number): Rect {
  return { x: 0, y: 0, width: Math.max(1, Math.ceil(viewW)), height: Math.max(1, Math.ceil(viewH)) };
}

/** The night tint, in world pixels: the building plus a tile of margin, and nothing beyond it. */
export function nightRect(b: TileRect, tile: number, margin = 1): Rect {
  const x = (b.x0 - margin) * tile, y = (b.y0 - margin) * tile;
  return { x, y, width: (b.x1 - b.x0 + 1 + margin * 2) * tile, height: (b.y1 - b.y0 + 1 + margin * 2) * tile };
}

/**
 * The colour the canvas clears to. It can only show through in the frame before the sky texture exists, but that
 * frame is the white flash the review caught, so it follows the sky's horizon stop rather than the page theme.
 */
export function backdropColour(stops: readonly [string, string]): string { return stops[1]; }
