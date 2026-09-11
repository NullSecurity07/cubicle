// packages/viewer/src/world/map.ts
import type Phaser from 'phaser';
import EasyStar from 'easystarjs';
import { T, TILE, TILES } from './tiles.js';

export { TILE };

export interface Tile { tx: number; ty: number }
export interface Anchor { name: string; type: string; tx: number; ty: number; tw: number; th: number; props: Record<string, string | number> }
export interface FloorInfo { n: number; y0: number; y1: number; label: string; color: string; portal: Tile }
export interface DeskInfo { tile: Tile; room: string; floor: number }
export interface DecorItem { kind: string; tile: Tile; floor: number; desk?: string }
export interface SignInfo { tile: Tile; room: string; label: string; floor: number }

/** The Tiled JSON scripts/gen-world.ts writes, as far as the viewer reads it. */
export interface TiledMap {
  width: number; height: number; tilewidth: number;
  layers: { name: string; type: string; data?: number[]; objects?: { name: string; type?: string; x?: number; y?: number; width?: number; height?: number; properties?: { name: string; value: string | number }[] }[] }[];
}

/** Everything the office needs from the map. No Phaser: parsed from the JSON, so it is unit-testable. */
export interface MapData {
  width: number; height: number;
  grid: number[][];                       // 0 walkable, 1 blocked
  anchors: Record<string, Anchor>;        // every object by name (rooms, desks, seats, surfaces, portals, decor, signs …)
  seats: Record<string, Tile[]>;          // free seats per room (reserved ones excluded)
  desks: Record<string, Tile>;            // desk id → chair tile
  floors: FloorInfo[];                    // sorted by n ascending (F1 first)
  portals: Record<number, Tile>;          // floor n → elevator door tile
  rooms: Record<string, Anchor>;          // room id → room object
  reserved: Record<string, Tile>;         // `reserved` prop → seat tile (owner → the owner's chair)
  deskInfo: Record<string, DeskInfo>;     // desk id → tile, room, floor
  decor: DecorItem[];
  signs: Record<string, SignInfo>;        // room id → sign
}

export interface World extends MapData {
  map: Phaser.Tilemaps.Tilemap;
  finder: EasyStar.js;
  findPath(from: Tile, to: Tile): Promise<Tile[] | null>;
  standTile(name: string): Tile | null;
}

const WALK_WALL = /^(DOOR|DOOR_INT|GLASS_DOOR|ELEVATOR_DOOR|ELEV_DOOR_L|ELEV_DOOR_R)$/;
const WALK_FURNITURE = /^(CHAIR|CHAIR_TASK|CHAIR_EXEC|OWNER_CHAIR|STOOL|CARPET|CARPET_BLUE|CARPET_GREEN|CARPET_ORANGE|CARPET_F[1-4]|CORRIDOR|LOBBY_FLOOR|LOBBY_FLOOR_ALT|FLOOR|FLOOR_F[1-4]|FLOOR_ALT_F[1-4]|PATH|PAVEMENT|STREET|KERB)$/;
/** A wall-layer tile a sprite may cross (doors of every kind). */
export const walkableWall = (id: number): boolean => WALK_WALL.test(TILES[id] ?? '');
/** A furniture-layer tile a sprite may stand on (seats and floor coverings; everything else is a thing). */
export const walkableFurniture = (id: number): boolean => WALK_FURNITURE.test(TILES[id] ?? '');
export const WALKABLE_WALLS = new Set(TILES.map((_, i) => i).filter(walkableWall));
export const BLOCKED_GROUND = new Set([T.SKY]);                             // ground layer: nobody walks on the sky

/** Tiled JSON → office geometry: the collision grid, the object anchors, the desks, the seats, the floors. */
export function parseMap(json: TiledMap): MapData {
  const tile = json.tilewidth || TILE;
  const tiles = (name: string): number[] => json.layers.find((l) => l.name === name && l.type === 'tilelayer')?.data ?? [];
  const ground = tiles('ground'), walls = tiles('walls'), furniture = tiles('furniture');
  const grid: number[][] = [];
  for (let y = 0; y < json.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < json.width; x++) {
      const i = y * json.width + x;
      const g = ground[i] ?? 0, w = walls[i] ?? 0, f = furniture[i] ?? 0;
      row.push(BLOCKED_GROUND.has(g) || (w > 0 && !walkableWall(w)) || (f > 0 && !walkableFurniture(f)) ? 1 : 0);
    }
    grid.push(row);
  }
  const anchors: Record<string, Anchor> = {};
  const seats: Record<string, Tile[]> = {};
  const desks: Record<string, Tile> = {};
  const floors: FloorInfo[] = [];
  const portals: Record<number, Tile> = {};
  const rooms: Record<string, Anchor> = {};
  const reserved: Record<string, Tile> = {};
  const deskInfo: Record<string, DeskInfo> = {};
  const decor: DecorItem[] = [];
  const signs: Record<string, SignInfo> = {};
  for (const o of json.layers.filter((l) => l.type === 'objectgroup').flatMap((l) => l.objects ?? [])) {
    const props: Record<string, string | number> = {};
    for (const p of o.properties ?? []) props[p.name] = p.value;
    const a: Anchor = { name: o.name, type: String(o.type ?? ''), tx: Math.round((o.x ?? 0) / tile), ty: Math.round((o.y ?? 0) / tile), tw: Math.round((o.width ?? tile) / tile), th: Math.round((o.height ?? tile) / tile), props };
    anchors[o.name] = a;
    const at: Tile = { tx: a.tx, ty: a.ty };
    const floor = Number(props.floor ?? 0);
    switch (a.type) {
      case 'seat': if (props.reserved !== undefined) reserved[String(props.reserved)] = at; else (seats[String(props.room)] ??= []).push(at); break;
      case 'desk': desks[o.name] = at; deskInfo[o.name] = { tile: at, room: String(props.room ?? ''), floor }; break;
      case 'room': rooms[o.name] = a; break;
      case 'floor': floors.push({ n: floor, y0: a.ty, y1: a.ty + a.th - 1, label: String(props.label ?? `F${floor}`), color: String(props.color ?? '#888'), portal: { tx: Number(props.portal_x), ty: Number(props.portal_y) } }); break;
      case 'portal': portals[floor] = at; break;
      case 'decor': decor.push({ kind: String(props.kind ?? ''), tile: at, floor, ...(props.desk !== undefined ? { desk: String(props.desk) } : {}) }); break;
      case 'sign': signs[String(props.room)] = { tile: at, room: String(props.room), label: String(props.label ?? ''), floor }; break;
      default: break;
    }
  }
  floors.sort((a, b) => a.n - b.n);
  return { width: json.width, height: json.height, grid, anchors, seats, desks, floors, portals, rooms, reserved, deskInfo, decor, signs };
}

/** The floor a row belongs to: the lowest-numbered floor whose rect holds it; the street is F1, the sky is the top floor. */
export function floorAt(m: Pick<MapData, 'floors'>, ty: number): number {
  for (const f of m.floors) if (ty >= f.y0 && ty <= f.y1) return f.n;
  if (!m.floors.length) return 1;
  return ty > m.floors[0].y1 ? m.floors[0].n : m.floors[m.floors.length - 1].n;
}
export function floorOf(m: Pick<MapData, 'floors'>, t: Tile): number { return floorAt(m, t.ty); }
export function portalFor(m: Pick<MapData, 'portals'>, n: number): Tile {
  const p = m.portals[n];
  if (!p) throw new Error(`no elevator door on floor ${n}`);
  return p;
}

/** Where a sprite stands for a named place: a desk, an anchor's `stand_x/stand_y`, else below its box. */
export function standTile(m: Pick<MapData, 'anchors' | 'desks'>, name: string): Tile | null {
  if (name.startsWith('desk:')) return m.desks[name.slice(5)] ?? null;
  const a = m.anchors[name];
  if (!a) return null;
  if (typeof a.props.stand_x === 'number') return { tx: Number(a.props.stand_x), ty: Number(a.props.stand_y) };
  return { tx: a.tx + Math.floor(a.tw / 2), ty: a.ty + a.th };
}

/** The nearest walkable tile within `radius` that also satisfies `ok` (findPath passes a same-floor check so a target never snaps through the slab). */
export function nearestWalkable(grid: number[][], t: Tile, radius = 4, ok: (t: Tile) => boolean = () => true): Tile | null {
  if (grid[t.ty]?.[t.tx] === 0 && ok(t)) return t;
  for (let r = 1; r <= radius; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const c = { tx: t.tx + dx, ty: t.ty + dy }; if (grid[c.ty]?.[c.tx] === 0 && ok(c)) return c; }
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
        const want = clampT(to), floor = floorAt(parsed, want.ty);
        const f = clampT(from), t = nearestWalkable(parsed.grid, want, 4, (c) => floorAt(parsed, c.ty) === floor);
        if (!t) return resolve(null);
        finder.findPath(f.tx, f.ty, t.tx, t.ty, (p) => resolve(p ? p.map((n) => ({ tx: n.x, ty: n.y })) : null));
        finder.calculate();
      });
    },
    standTile: (name) => standTile(parsed, name),
  };
}

export const toPx = (t: Tile) => ({ x: t.tx * TILE + TILE / 2, y: t.ty * TILE + TILE / 2 });
