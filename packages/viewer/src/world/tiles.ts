/**
 * Tile names and ids shared by the world generator (scripts/world/tower.ts) and the viewer's runtime tileset
 * (tileset.ts). No Phaser here: the generator runs under node and the map tests never load the renderer.
 * Ids are 1-based in Tiled (0 = empty). Append new names at the end; never renumber an existing one.
 */
export const TILES = [
  'EMPTY', 'GRASS', 'PATH', 'FLOOR', 'WALL', 'WALL_TOP', 'DOOR', 'DESK', 'CHAIR', 'TABLE', 'WHITEBOARD', 'PLANT', 'KITCHEN', 'NOTICE', 'CARPET', 'WINDOW', 'TREE', 'BENCH', 'SIGN',
  // tower (2026-09-11): sky above the roof, per-floor carpets, wall screens, the shaft, its doors, the pantry counter, the slab between floors
  'SKY', 'CARPET_BLUE', 'CARPET_GREEN', 'CARPET_ORANGE', 'SCREEN', 'SHAFT', 'ELEVATOR_DOOR', 'COUNTER', 'SLAB',
  // --- appended by the visual layer (ids 28+); never reorder ---
  'STREET', 'KERB', 'PAVEMENT', 'FACADE', 'FACADE_EDGE', 'LOBBY_FLOOR', 'LOBBY_FLOOR_ALT', 'ROOF_EDGE',
  'FLOOR_F1', 'FLOOR_F2', 'FLOOR_F3', 'FLOOR_F4', 'FLOOR_ALT_F1', 'FLOOR_ALT_F2', 'FLOOR_ALT_F3', 'FLOOR_ALT_F4',
  'CARPET_F1', 'CARPET_F2', 'CARPET_F3', 'CARPET_F4', 'WALL_F1', 'WALL_F2', 'WALL_F3', 'WALL_F4', 'SIGN_F1', 'SIGN_F2', 'SIGN_F3', 'SIGN_F4',
  'WALL_TOP_INT', 'CORRIDOR', 'GLASS_V', 'GLASS_H', 'GLASS_CORNER', 'GLASS_DOOR', 'DOOR_INT', 'WINDOW_DAY', 'WINDOW_DUSK', 'WINDOW_NIGHT',
  'ELEV_SHAFT', 'ELEV_RAIL', 'ELEV_DOOR_L', 'ELEV_DOOR_R', 'ELEV_FRAME', 'ELEV_CALL',
  'DESK_L', 'DESK_R', 'DESK_EXEC_L', 'DESK_EXEC_R', 'CHAIR_TASK', 'CHAIR_EXEC', 'OWNER_CHAIR',
  'BT_TL', 'BT_TM', 'BT_TR', 'BT_BL', 'BT_BM', 'BT_BR',
  'COUNTER_L', 'COUNTER_M', 'COUNTER_R', 'COFFEE_MACHINE', 'FRIDGE', 'CAFE_TABLE', 'STOOL', 'WATER_COOLER',
  'PLANT_TALL_T', 'PLANT_TALL_B', 'PLANT_SMALL', 'BOOKSHELF_T', 'BOOKSHELF_B', 'FILING', 'LAMP_FLOOR', 'RACK_T', 'RACK_B', 'SAFE_DOOR', 'SCREEN_BEZEL', 'SCREEN_BEZEL_L', 'SCREEN_BEZEL_R',
  // the chief offices' seating corner (visual QA I6): a rug, a two-tile sofa and a side table, so no room is bare carpet
  'RUG', 'SOFA_L', 'SOFA_R', 'SIDE_TABLE',
] as const;
export type TileName = (typeof TILES)[number];
export const T = Object.fromEntries(TILES.map((n, i) => [n, i])) as Record<TileName, number>;
export const COLUMNS = 16;
/** Tile size in pixels. The generated map uses 16. */
export const TILE = 16;

/** The Tiled `tilesets[0]` entry: derived from the table so adding a tile never needs a hand-edited count. */
export function tilesetMeta(): { firstgid: 1; name: 'office'; tilewidth: 16; tileheight: 16; tilecount: number; columns: number; image: 'runtime:office'; imagewidth: number; imageheight: number; margin: 0; spacing: 0 } {
  const tilecount = TILES.length - 1;
  return { firstgid: 1, name: 'office', tilewidth: 16, tileheight: 16, tilecount, columns: COLUMNS, image: 'runtime:office', imagewidth: COLUMNS * TILE, imageheight: Math.ceil(tilecount / COLUMNS) * TILE, margin: 0, spacing: 0 };
}
