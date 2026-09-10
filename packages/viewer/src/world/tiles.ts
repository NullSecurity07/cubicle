/**
 * Tile names and ids shared by the world generator (scripts/world/tower.ts) and the viewer's runtime tileset
 * (tileset.ts). No Phaser here: the generator runs under node and the map tests never load the renderer.
 * Ids are 1-based in Tiled (0 = empty). Append new names at the end; never renumber an existing one.
 */
export const TILES = [
  'EMPTY', 'GRASS', 'PATH', 'FLOOR', 'WALL', 'WALL_TOP', 'DOOR', 'DESK', 'CHAIR', 'TABLE', 'WHITEBOARD', 'PLANT', 'KITCHEN', 'NOTICE', 'CARPET', 'WINDOW', 'TREE', 'BENCH', 'SIGN',
  // tower (2026-09-11): sky above the roof, per-floor carpets, wall screens, the shaft, its doors, the pantry counter, the slab between floors
  'SKY', 'CARPET_BLUE', 'CARPET_GREEN', 'CARPET_ORANGE', 'SCREEN', 'SHAFT', 'ELEVATOR_DOOR', 'COUNTER', 'SLAB',
] as const;
export type TileName = (typeof TILES)[number];
export const T = Object.fromEntries(TILES.map((n, i) => [n, i])) as Record<TileName, number>;
export const COLUMNS = 6;
/** Tile size in pixels. The generated map uses 16. */
export const TILE = 16;

/** The Tiled `tilesets[0]` entry: derived from the table so adding a tile never needs a hand-edited count. */
export function tilesetMeta(): { firstgid: 1; name: 'office'; tilewidth: 16; tileheight: 16; tilecount: number; columns: number; image: 'runtime:office'; imagewidth: number; imageheight: number; margin: 0; spacing: 0 } {
  const tilecount = TILES.length - 1;
  return { firstgid: 1, name: 'office', tilewidth: 16, tileheight: 16, tilecount, columns: COLUMNS, image: 'runtime:office', imagewidth: COLUMNS * TILE, imageheight: Math.ceil(tilecount / COLUMNS) * TILE, margin: 0, spacing: 0 };
}
