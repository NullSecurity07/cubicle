/**
 * The campus, read off the map the generator writes.
 *
 * One open plane, no floors: what the tower's `map.ts` called a floor, a portal and a slab is gone, and what is
 * left is zones, rooms, desks, seats, screens, partitions, props and walkways, all in grid cells that may be
 * fractional. Nothing here draws and nothing imports the renderer, so the whole file is unit-testable under node.
 *
 * Two coordinate systems, and only two:
 *  - **cells** — what everything in the map is in, and what `iso.ts` projects. A desk is at x 3.4, y 25.
 *  - **walk sub-cells** — the collision grid, `WALK` of them to the cell. Routing happens here and nowhere else;
 *    a path comes back as cell-space points, so the rest of the viewer never sees a sub-cell.
 */
import EasyStar from 'easystarjs';
import type { Rect } from './iso.js';
import type { AccentName } from './materials.js';
import type { Axis } from './shapes.js';

export type { Rect };

export interface Pt { x: number; y: number }

export interface Zone {
  id: string; label: string; accent: AccentName; rect: Rect;
  /** where the zone plate hangs, as a fraction of the rect */
  plate: { fx: number; fy: number };
  /** the zone rail entry, where the zone has one */
  rail: { label: string; order: number } | null;
  stand: Pt;
}

export interface Room { id: string; label: string; zone: string; accent: AccentName; rect: Rect; stand: Pt }

export interface Desk {
  id: string; room: string; zone: string; accent: AccentName;
  rect: Rect; side: 'far' | 'near'; slot: 'fixed' | 'member';
  /** where the person at this desk sits */
  seat: Pt;
  lamp: boolean; papers: boolean;
}

export interface Seat { id: string; room: string; at: Pt; facing: 'se' | 'sw' | 'ne' | 'nw'; reserved: string | null }

export interface Screen {
  kind: string; label: string; line: string; room: string; accent: AccentName;
  x: number; y: number; axis: Axis; len: number; z: number; h: number;
  face: 'screen' | 'board' | 'paper'; pier: boolean; stand: Pt;
}

export interface Partition { x: number; y: number; axis: Axis; len: number; h: number; accent: AccentName }
/**
 * A piece of dressing. `id` is `<kind>_<n>`, numbered per kind in map order — the map JSON has no stable name for a
 * prop (`prop_200` is a generator counter), and `Office/campus.md` has to be able to say `plant_7: { removed: true }`
 * in a line the owner can read.
 */
export interface PropItem { id: string; kind: string; rect: Rect; at: Pt; props: Record<string, string | number> }

/**
 * Something the owner put on the campus themselves: a browser kiosk, a document board, a sticky note, a screen of
 * the live site, or a tool station. Not in the map JSON — it comes from `Office/campus.md` through `applyLayout`.
 */
export interface Resource {
  id: string; kind: 'browser' | 'doc' | 'note' | 'site' | 'station';
  /** the middle of its footprint */ at: Pt;
  rect: Rect; label: string; zone: string; accent: AccentName;
  /** `station` only */ tool?: 'email' | 'deploy' | 'analytics' | 'memory';
  /** `doc` only: the vault path it shows */ path?: string;
  /** `note` only: what is written on it */ body?: string;
}
export interface DecorItem { kind: string; at: Pt; desk: string | null }
export interface Sign { room: string; label: string; at: Pt }

/** The Tiled-shaped JSON scripts/gen-world.ts writes, as far as the viewer reads it. */
export interface TiledMap {
  width: number; height: number; tilewidth: number;
  properties?: { name: string; value: string | number }[];
  layers: {
    name: string; type: string; width?: number; height?: number; data?: number[];
    objects?: { name: string; type?: string; x?: number; y?: number; width?: number; height?: number; properties?: { name: string; value: string | number }[] }[];
  }[];
}

export interface CampusMap {
  /** the campus, in cells */
  width: number; height: number;
  /** how thick the two back walls are, in cells */
  wall: number;
  /** sub-cells to the cell in `grid` */
  walk: number;
  /** `grid[y][x]`, 0 walkable and 1 blocked, in sub-cells */
  grid: number[][];
  zones: Zone[];
  zoneById: Record<string, Zone>;
  /** the rail's own order, Executive first */
  rail: Zone[];
  rooms: Record<string, Room>;
  desks: Record<string, Desk>;
  seats: Record<string, Seat[]>;
  reserved: Record<string, Seat>;
  screens: Record<string, Screen>;
  partitions: Partition[];
  props: PropItem[];
  /** what the owner added, keyed by id; empty until `applyLayout` has run over `Office/campus.md` */
  resources: Record<string, Resource>;
  paths: Rect[];
  decor: DecorItem[];
  signs: Record<string, Sign>;
  door: Pt;
}

const num = (v: string | number | undefined, fallback = 0): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : fallback);
const str = (v: string | number | undefined, fallback = ''): string => (v === undefined ? fallback : String(v));

/** Map JSON → campus geometry. Pure: no canvas, no DOM. */
export function parseCampus(json: TiledMap): CampusMap {
  const tile = json.tilewidth || 16;
  const mapProps: Record<string, string | number> = {};
  for (const p of json.properties ?? []) mapProps[p.name] = p.value;
  const walk = num(mapProps.walk_scale, 2);
  const wall = num(mapProps.wall, 0.55);

  const layer = json.layers.find((l) => l.name === 'blocked' && l.type === 'tilelayer');
  const gw = layer?.width ?? json.width * walk, gh = layer?.height ?? json.height * walk;
  const data = layer?.data ?? [];
  const grid: number[][] = [];
  for (let y = 0; y < gh; y++) {
    const rowOut: number[] = [];
    for (let x = 0; x < gw; x++) rowOut.push(data[y * gw + x] ? 1 : 0);
    grid.push(rowOut);
  }

  const zones: Zone[] = [];
  const rooms: Record<string, Room> = {};
  const desks: Record<string, Desk> = {};
  const seats: Record<string, Seat[]> = {};
  const reserved: Record<string, Seat> = {};
  const screens: Record<string, Screen> = {};
  const partitions: Partition[] = [];
  const props: PropItem[] = [];
  const propCount: Record<string, number> = {};
  const paths: Rect[] = [];
  const decor: DecorItem[] = [];
  const signs: Record<string, Sign> = {};
  let door: Pt = { x: json.width / 2, y: json.height - 2 };

  for (const o of json.layers.filter((l) => l.type === 'objectgroup').flatMap((l) => l.objects ?? [])) {
    const p: Record<string, string | number> = {};
    for (const q of o.properties ?? []) p[q.name] = q.value;
    const x = (o.x ?? 0) / tile, y = (o.y ?? 0) / tile;
    const w = (o.width ?? tile) / tile, h = (o.height ?? tile) / tile;
    const rect: Rect = { x0: x, y0: y, x1: x + w, y1: y + h };
    const accent = str(p.accent, 'neutral') as AccentName;
    switch (o.type) {
      case 'zone':
        zones.push({
          id: o.name, label: str(p.label, o.name), accent, rect,
          plate: { fx: num(p.plate_fx, 0.5), fy: num(p.plate_fy, 0.5) },
          rail: p.rail === undefined ? null : { label: str(p.rail), order: num(p.rail_order, 99) },
          stand: { x: num(p.stand_x, (rect.x0 + rect.x1) / 2), y: num(p.stand_y, rect.y1) },
        });
        break;
      case 'room':
        rooms[o.name] = { id: o.name, label: str(p.label, o.name), zone: str(p.zone, o.name), accent, rect, stand: { x: num(p.stand_x), y: num(p.stand_y) } };
        break;
      case 'desk':
        desks[o.name] = {
          id: o.name, room: str(p.room), zone: str(p.zone), accent, rect,
          side: p.side === 'near' ? 'near' : 'far', slot: p.slot === 'fixed' ? 'fixed' : 'member',
          seat: { x: num(p.seat_x), y: num(p.seat_y) }, lamp: num(p.lamp) === 1, papers: num(p.papers) === 1,
        };
        break;
      case 'seat': {
        const seat: Seat = { id: o.name, room: str(p.room), at: { x, y }, facing: (str(p.facing, 'se') as Seat['facing']), reserved: p.reserved === undefined ? null : str(p.reserved) };
        if (seat.reserved) reserved[seat.reserved] = seat;
        else (seats[seat.room] ??= []).push(seat);
        break;
      }
      case 'surface':
        screens[o.name] = {
          kind: o.name, label: str(p.label), line: str(p.line), room: str(p.room), accent,
          x, y, axis: p.axis === 'y' ? 'y' : 'x', len: num(p.len, 3), z: num(p.z, 0.8), h: num(p.h, 1.5),
          face: (str(p.face, 'screen') as Screen['face']), pier: num(p.pier, 1) === 1,
          stand: { x: num(p.stand_x, x), y: num(p.stand_y, y) },
        };
        break;
      case 'partition':
        partitions.push({ x, y, axis: p.axis === 'y' ? 'y' : 'x', len: num(p.len, 2), h: num(p.h, 1.38), accent });
        break;
      case 'prop': {
        const kind = str(p.kind);
        const rest: Record<string, string | number> = { ...p };
        delete rest.kind; delete rest.floor;
        propCount[kind] = (propCount[kind] ?? 0) + 1;
        props.push({ id: `${kind}_${propCount[kind]}`, kind, rect, at: { x, y }, props: rest });
        break;
      }
      case 'path': paths.push(rect); break;
      case 'decor': decor.push({ kind: str(p.kind), at: { x, y }, desk: p.desk === undefined ? null : str(p.desk) }); break;
      case 'sign': signs[str(p.room, o.name)] = { room: str(p.room, o.name), label: str(p.label), at: { x, y } }; break;
      case 'anchor': if (o.name === 'door') door = { x: num(p.stand_x, x), y: num(p.stand_y, y) }; break;
      default: break;
    }
  }

  const zoneById: Record<string, Zone> = Object.fromEntries(zones.map((z) => [z.id, z]));
  const rail = zones.filter((z) => z.rail).sort((a, b) => a.rail!.order - b.rail!.order);
  return { width: json.width, height: json.height, wall, walk, grid, zones, zoneById, rail, rooms, desks, seats, reserved, screens, partitions, props, resources: {}, paths, decor, signs, door };
}

/* -------------------------------------------------------------------------------------------------------- */
/* geometry                                                                                                  */
/* -------------------------------------------------------------------------------------------------------- */

export const inRect = (r: Rect, p: Pt): boolean => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

/** Which zone a point is in; null out on the walkways, which belong to no one. */
export function zoneAt(m: Pick<CampusMap, 'zones'>, p: Pt): Zone | null {
  for (const z of m.zones) if (inRect(z.rect, p)) return z;
  return null;
}

/** The rail entry a point falls under: its own zone's, or the nearest rail zone's when it is on a walkway. */
export function railZoneAt(m: Pick<CampusMap, 'zones' | 'rail' | 'zoneById'>, p: Pt): Zone | null {
  const z = zoneAt(m, p);
  if (z?.rail) return z;
  // the cabin and the meeting room are the executive suite's other two rooms; anything else on open floor is
  // the campus, which is the rail's own first entry and not a zone at all
  if (z && (z.id === 'ceo_office' || z.id === 'meetingroom')) return m.zoneById.boardroom ?? null;
  return null;
}

/** Is this sub-cell inside the grid and walkable? */
export function walkable(grid: number[][], gx: number, gy: number): boolean {
  return grid[gy]?.[gx] === 0;
}

/** Cell point → walk sub-cell. */
export const toWalk = (m: Pick<CampusMap, 'walk'>, p: Pt): { gx: number; gy: number } => ({ gx: Math.floor(p.x * m.walk), gy: Math.floor(p.y * m.walk) });
/** Walk sub-cell → the cell point at its middle. */
export const fromWalk = (m: Pick<CampusMap, 'walk'>, gx: number, gy: number): Pt => ({ x: (gx + 0.5) / m.walk, y: (gy + 0.5) / m.walk });

/** The nearest walkable sub-cell to a point, searching outwards; null when everything within `radius` is blocked. */
export function nearestWalkable(m: Pick<CampusMap, 'grid' | 'walk'>, p: Pt, radius = 8): { gx: number; gy: number } | null {
  const { gx, gy } = toWalk(m, p);
  if (walkable(m.grid, gx, gy)) return { gx, gy };
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walkable(m.grid, gx + dx, gy + dy)) return { gx: gx + dx, gy: gy + dy };
      }
    }
  }
  return null;
}

/**
 * Where a named place is.
 *
 * `desk:<id>` is that desk's own seat, a room or zone id is the stand point the generator chose for it (always on
 * a walkway, never inside the furniture), a screen kind is the spot beside it, and `door` is the entrance.
 */
export function standAt(m: CampusMap, name: string): Pt | null {
  if (name === 'door') return m.door;
  if (name.startsWith('desk:')) return m.desks[name.slice(5)]?.seat ?? null;
  if (m.desks[name]) return m.desks[name].seat;
  if (m.screens[name]) return m.screens[name].stand;
  // a resource is stood *at*, a half cell in front of its near edge, so nobody stands inside the kiosk
  if (m.resources[name]) { const r = m.resources[name].rect; return { x: (r.x0 + r.x1) / 2, y: r.y1 + 0.55 }; }
  if (m.rooms[name]) return m.rooms[name].stand;
  if (m.zoneById[name]) return m.zoneById[name].stand;
  return null;
}

/** The rectangle a named place occupies, for the camera to frame. */
export function rectOf(m: CampusMap, name: string): Rect | null {
  if (m.zoneById[name]) return m.zoneById[name].rect;
  if (m.rooms[name]) return m.rooms[name].rect;
  if (m.desks[name]) return m.desks[name].rect;
  if (m.resources[name]) return m.resources[name].rect;
  if (name.startsWith('desk:') && m.desks[name.slice(5)]) return m.desks[name.slice(5)].rect;
  const s = m.screens[name];
  if (s) {
    return s.axis === 'x'
      ? { x0: s.x - 1, y0: s.y - 1, x1: s.x + s.len + 1, y1: s.y + 2.4 }
      : { x0: s.x - 1, y0: s.y - 1, x1: s.x + 2.4, y1: s.y + s.len + 1 };
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------------- */
/* routing                                                                                                   */
/* -------------------------------------------------------------------------------------------------------- */

export interface Router { find(from: Pt, to: Pt): Promise<Pt[] | null> }

/**
 * A* over the walk grid, with the corners smoothed off.
 *
 * The grid is a means, not a look: a person who walks it cell by cell reads as a token on a board, which is the
 * single thing the tower's motion was criticised for. The path is simplified to its turning points before it
 * leaves here, so what the body follows is a short list of corners it can ease between.
 */
export function makeRouter(m: CampusMap): Router {
  const finder = new EasyStar.js();
  finder.setGrid(m.grid);
  finder.setAcceptableTiles([0]);
  finder.enableDiagonals();
  finder.disableCornerCutting();
  return {
    find(from, to) {
      return new Promise((resolve) => {
        const a = nearestWalkable(m, from, 10), b = nearestWalkable(m, to, 10);
        if (!a || !b) return resolve(null);
        if (a.gx === b.gx && a.gy === b.gy) return resolve([to]);
        finder.findPath(a.gx, a.gy, b.gx, b.gy, (path) => {
          if (!path) return resolve(null);
          const pts = path.map((n) => fromWalk(m, n.x, n.y));
          resolve([...simplify(pts), to]);
        });
        finder.calculate();
      });
    },
  };
}

/** Drop every point that continues the previous heading: what is left is the corners. */
export function simplify(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
