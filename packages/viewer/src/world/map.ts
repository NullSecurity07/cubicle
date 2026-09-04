import type Phaser from 'phaser';
import EasyStar from 'easystarjs';

/** Tile size in pixels. The generated map uses 16 (scripts/gen-world.ts). */
export const TILE = 16;

export interface Tile { tx: number; ty: number }
export interface Anchor { name: string; type: string; tx: number; ty: number; tw: number; th: number; props: Record<string, string | number> }

/** The Tiled JSON scripts/gen-world.ts writes, as far as the viewer reads it. */
export interface TiledMap {
  width: number; height: number; tilewidth: number;
  layers: { name: string; type: string; data?: number[]; objects?: { name: string; type?: string; x?: number; y?: number; width?: number; height?: number; properties?: { name: string; value: string | number }[] }[] }[];
}

/** Everything the office needs from the map. No Phaser: parsed from the JSON, so it is unit-testable. */
export interface MapData {
  width: number; height: number;
  grid: number[][];                 // 0 walkable, 1 blocked
  anchors: Record<string, Anchor>;
  seats: Record<string, Tile[]>;
  desks: Record<string, Tile>;
}

export interface World extends MapData {
  map: Phaser.Tilemaps.Tilemap;
  finder: EasyStar.js;
  findPath(from: Tile, to: Tile): Promise<Tile[] | null>;
  standTile(name: string): Tile | null;
}

const DOOR = 6;                              // walls layer: a door is walkable
const WALKABLE_FURNITURE = new Set([8, 14]); // furniture layer: chairs and carpet are walkable

/** Tiled JSON → office geometry: the collision grid, the object anchors, the desks and the meeting seats. */
export function parseMap(json: TiledMap): MapData {
  const tile = json.tilewidth || TILE;
  const tiles = (name: string): number[] => json.layers.find((l) => l.name === name && l.type === 'tilelayer')?.data ?? [];
  const walls = tiles('walls'), furniture = tiles('furniture');
  const grid: number[][] = [];
  for (let y = 0; y < json.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < json.width; x++) {
      const i = y * json.width + x;
      const w = walls[i] ?? 0, f = furniture[i] ?? 0;
      row.push((w > 0 && w !== DOOR) || (f > 0 && !WALKABLE_FURNITURE.has(f)) ? 1 : 0);
    }
    grid.push(row);
  }
  const anchors: Record<string, Anchor> = {};
  const seats: Record<string, Tile[]> = {};
  const desks: Record<string, Tile> = {};
  for (const o of json.layers.filter((l) => l.type === 'objectgroup').flatMap((l) => l.objects ?? [])) {
    const props: Record<string, string | number> = {};
    for (const p of o.properties ?? []) props[p.name] = p.value;
    const a: Anchor = { name: o.name, type: String(o.type ?? ''), tx: Math.round((o.x ?? 0) / tile), ty: Math.round((o.y ?? 0) / tile), tw: Math.round((o.width ?? tile) / tile), th: Math.round((o.height ?? tile) / tile), props };
    anchors[o.name] = a;
    if (a.type === 'seat') (seats[String(props.room)] ??= []).push({ tx: a.tx, ty: a.ty });
    if (a.type === 'desk') desks[o.name] = { tx: a.tx, ty: a.ty };
  }
  return { width: json.width, height: json.height, grid, anchors, seats, desks };
}

/** Where a sprite stands for a named place: a desk, an anchor's `stand_x/stand_y`, else below its box. */
export function standTile(m: Pick<MapData, 'anchors' | 'desks'>, name: string): Tile | null {
  if (name.startsWith('desk:')) return m.desks[name.slice(5)] ?? null;
  const a = m.anchors[name];
  if (!a) return null;
  if (typeof a.props.stand_x === 'number') return { tx: Number(a.props.stand_x), ty: Number(a.props.stand_y) };
  return { tx: a.tx + Math.floor(a.tw / 2), ty: a.ty + a.th };
}

export function nearestWalkable(grid: number[][], t: Tile, radius = 4): Tile | null {
  if (grid[t.ty]?.[t.tx] === 0) return t;
  for (let r = 1; r <= radius; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = t.tx + dx, y = t.ty + dy; if (grid[y]?.[x] === 0) return { tx: x, ty: y }; }
  return null;
}

export function buildWorld(scene: Phaser.Scene, mapKey = 'office'): World {
  const map = scene.make.tilemap({ key: mapKey });
  const tiles = map.addTilesetImage('office', 'office', TILE, TILE, 0, 0)!;
  const ground = map.createLayer('ground', tiles, 0, 0)!;
  const walls = map.createLayer('walls', tiles, 0, 0)!;
  const furniture = map.createLayer('furniture', tiles, 0, 0)!;
  ground.setDepth(0); walls.setDepth(1); furniture.setDepth(2);
  // The same JSON Phaser rendered is the one the geometry comes from, so the two can never disagree.
  const cached = scene.cache.tilemap.get(mapKey) as { data?: TiledMap } | undefined;
  if (!cached?.data) throw new Error(`office map "${mapKey}" is not in the tilemap cache`);
  const parsed = parseMap(cached.data);
  const finder = new EasyStar.js();
  finder.setGrid(parsed.grid);
  finder.setAcceptableTiles([0]);
  finder.enableDiagonals();
  finder.disableCornerCutting();
  return {
    ...parsed, map, finder,
    findPath(from, to) {
      return new Promise((resolve) => {
        const clampT = (t: Tile): Tile => ({ tx: Math.max(0, Math.min(parsed.width - 1, t.tx)), ty: Math.max(0, Math.min(parsed.height - 1, t.ty)) });
        const f = clampT(from), t = nearestWalkable(parsed.grid, clampT(to));
        if (!t) return resolve(null);
        finder.findPath(f.tx, f.ty, t.tx, t.ty, (p) => resolve(p ? p.map((n) => ({ tx: n.x, ty: n.y })) : null));
        finder.calculate();
      });
    },
    standTile: (name) => standTile(parsed, name),
  };
}

export const toPx = (t: Tile) => ({ x: t.tx * TILE + TILE / 2, y: t.ty * TILE + TILE / 2 });
