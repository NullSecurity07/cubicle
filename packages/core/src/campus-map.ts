/**
 * The campus, read off the map the generator writes — the data half, shared by the daemon and the viewer.
 *
 * This file was the top of `packages/viewer/src/world/campus.ts` and moved here when the daemon had to read the
 * same map: the office layout the owner drags (`Office/campus.md`) is validated against desks, zones and blocked
 * cells, and a second parser would be a second answer to "is that spot free". The viewer's `campus.ts` keeps its
 * name and re-exports every symbol below, so nothing in the office had to change its imports.
 *
 * **It must stay dependency-free.** The viewer bundles it for the browser, which is why it is reachable as
 * `@cubicle/core/campus` and imports nothing — no zod, no yaml, no node builtins. Routing (EasyStar) stays in
 * the viewer, where the only caller is.
 *
 * Two coordinate systems, and only two:
 *  - **cells** — what everything in the map is in, and what the viewer's `iso.ts` projects. A desk is at x 3.4, y 25.
 *  - **walk sub-cells** — the collision grid, `walk` of them to the cell. A path comes back in cell space, so
 *    nothing above routing ever sees a sub-cell.
 */

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Pt { x: number; y: number }
export type AccentName = 'indigo' | 'sage' | 'amber' | 'slate' | 'neutral';
export type Axis = 'x' | 'y';

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
export interface PropItem { id: string; kind: string; rect: Rect; at: Pt; props: Record<string, string | number> }
export interface DecorItem { kind: string; at: Pt; desk: string | null }
export interface Sign { room: string; label: string; at: Pt }

/** The Tiled-shaped JSON scripts/gen-world.ts writes, as far as anything here reads it. */
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
  paths: Rect[];
  decor: DecorItem[];
  signs: Record<string, Sign>;
  door: Pt;
  /** What the owner put on the floor, from `Office/campus.md`; empty until `applyLayout` has run. */
  resources: Record<string, ResourceNode>;
}

const num = (v: string | number | undefined, fallback = 0): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : fallback);
const str = (v: string | number | undefined, fallback = ''): string => (v === undefined ? fallback : String(v));

/** Map JSON → campus geometry. Pure: no canvas, no DOM, no filesystem. */
export function parseCampusMap(json: TiledMap): CampusMap {
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
        // Numbered per kind in map order — `plant_1`, `plant_2` — not by the object's own name: the map JSON has
        // no stable name for a prop (`prop_200` is a generator counter), and `Office/campus.md` has to be able to
        // say `plant_7: { removed: true }` in a line the owner can read.
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
  return { width: json.width, height: json.height, wall, walk, grid, zones, zoneById, rail, rooms, desks, seats, reserved, screens, partitions, props, paths, decor, signs, door, resources: {} };
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
  if (m.rooms[name]) return m.rooms[name].stand;
  if (m.zoneById[name]) return m.zoneById[name].stand;
  return null;
}

/** The rectangle a named place occupies, for the camera to frame. */
export function rectOf(m: CampusMap, name: string): Rect | null {
  if (m.zoneById[name]) return m.zoneById[name].rect;
  if (m.rooms[name]) return m.rooms[name].rect;
  if (m.desks[name]) return m.desks[name].rect;
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
/* the owner's layout                                                                                        */
/* -------------------------------------------------------------------------------------------------------- */

/**
 * `Office/campus.md` in the shape the office and the daemon both read. The zod schema that validates the note
 * is `OfficeLayout` in `layout.ts`; it parses to exactly this, and this is what the browser gets, so the
 * schema's dependencies stay on the daemon's side of the wire.
 */
export interface LayoutNode {
  /** set on a resource the owner added; absent on a desk, a zone or a prop that was only moved */
  kind?: ResourceKind;
  x?: number; y?: number;
  /** a zone rect's size; a desk keeps the size the campus gave it */
  w?: number; d?: number;
  zone?: string;
  label?: string;
  body?: string;
  path?: string;
  /** a station's tool family */
  tool?: string;
  removed?: boolean;
}

export interface LayoutConnection { from: string; to: string; kind: 'peer' | 'access' }

export interface CampusLayout {
  version: number;
  /** only what differs from the template, keyed by node id */
  nodes: Record<string, LayoutNode>;
  connections: LayoutConnection[];
}

export type ResourceKind = 'browser' | 'doc' | 'note' | 'site' | 'station';
export const RESOURCE_KINDS: ResourceKind[] = ['browser', 'doc', 'note', 'site', 'station'];

/**
 * A thing the owner put on the floor: a browser kiosk, a document board, a sticky note, the site, a station.
 *
 * `rect` and `accent` are derived, not stored: the note says where a thing is and what it is, and how much floor
 * it takes and what colour it wears follow from that. They are on the node rather than recomputed by each reader
 * because "is that spot free" has to have one answer — the daemon refusing a drop the office drew as legal is the
 * same bug as two parsers.
 */
export interface ResourceNode {
  id: string; kind: ResourceKind; at: Pt;
  /** the footprint it stands on, centred on `at` */
  rect: Rect;
  /** the zone it stands in — named by the note, or the zone its middle falls in */
  zone: string | null;
  /** that zone's accent, so a thing in Sales wears Sales' colour */
  accent: AccentName;
  label: string; body: string; path: string;
  /** a station's family; `''` for everything else */
  tool: string;
}

/**
 * How much floor each kind takes, in cells.
 *
 * Fixed per kind rather than stored in the note: a sticky note the owner could stretch to the size of the Sales
 * floor is a drawing tool, and the office is not one. The note stores where a thing is; what it is decides the rest.
 */
export const RESOURCE_SIZE: Record<ResourceKind, { w: number; d: number }> = {
  browser: { w: 1.6, d: 1.0 },
  doc: { w: 1.8, d: 0.7 },
  note: { w: 1.0, d: 0.8 },
  site: { w: 2.0, d: 0.8 },
  station: { w: 1.4, d: 1.0 },
};

/** The footprint a resource of this kind occupies, centred on `at`. */
export function resourceRect(kind: ResourceKind, at: Pt): Rect {
  const s = RESOURCE_SIZE[kind];
  return { x0: at.x - s.w / 2, y0: at.y - s.d / 2, x1: at.x + s.w / 2, y1: at.y + s.d / 2 };
}

export const RESOURCE_LABEL: Record<ResourceKind, string> = { browser: 'Browser', doc: 'Document', note: 'Note', site: 'Site', station: 'Tool' };
/**
 * What each station's plate says.
 *
 * The browser family's station is "Web", not "Browser": a browser *kiosk* is one of the five things the owner
 * can put on the floor, and a campus with a kiosk labelled Browser beside a station labelled Browser is a campus
 * telling the owner that two different objects are the same thing.
 */
export const STATION_LABEL: Record<StationFamily, string> = { browser: 'Web', email: 'Email', deploy: 'Deploy', analytics: 'Analytics', memory: 'Memory' };

/**
 * What a thing the owner added is called when the note does not say — the name on its plate in the office and in
 * the note's own body, so the two never call the same thing two things.
 */
export function labelOfNode(kind: ResourceKind, n: Pick<LayoutNode, 'label' | 'path' | 'body' | 'tool'>): string {
  if (n.label) return n.label;
  if (kind === 'station' && n.tool && (STATION_FAMILIES as readonly string[]).includes(n.tool)) return STATION_LABEL[n.tool as StationFamily];
  if (kind === 'doc' && n.path) return n.path.split('/').pop()!.replace(/\.md$/, '');
  if (kind === 'note' && n.body) {
    const line = n.body.split('\n').find((l) => l.trim())?.trim() ?? '';
    return line.length > 28 ? `${line.slice(0, 27)}…` : line || RESOURCE_LABEL.note;
  }
  return RESOURCE_LABEL[kind];
}

/**
 * The tool stations, and the natural screen each one is placed beside on migration.
 *
 * One station per family, so `station_email` is both the id and the answer to "is there an email station on
 * this campus": a second one would make "connected to that station" two questions with two answers.
 */
export const STATION_FAMILIES = ['browser', 'email', 'deploy', 'analytics', 'memory'] as const;
export type StationFamily = (typeof STATION_FAMILIES)[number];
export const STATION_SCREEN: Record<StationFamily, string> = {
  browser: 'workshop', email: 'postoffice', deploy: 'terminal', analytics: 'newsstand', memory: 'vault',
};
export const stationId = (family: StationFamily): string => `station_${family}`;
export const isStationId = (id: string): boolean => STATION_FAMILIES.some((f) => stationId(f) === id);

/**
 * The station family a tool belongs to, or null when the tool is not something the office has a station for.
 *
 * `site.*` counts as `deploy`: putting the site on the campus is the deploy family's own screen (the workshop
 * shows the preview and the deploys). `skills.*` is the company's memory — save, load, search — which is what
 * the spec's "memory recall/save" is called in this codebase.
 */
export function stationFor(tool: string): StationFamily | null {
  switch (tool.split('.')[0]) {
    case 'browser': return 'browser';
    case 'email': return 'email';
    case 'deploy': case 'site': return 'deploy';
    case 'analytics': return 'analytics';
    case 'skills': case 'memory': return 'memory';
    default: return null;
  }
}

/** Is there a line between these two, either way round? A connection has no direction to the company. */
export function connected(layout: Pick<CampusLayout, 'connections'> | null | undefined, a: string, b: string): boolean {
  if (!layout) return false;
  return layout.connections.some((c) => (c.from === a && c.to === b) || (c.from === b && c.to === a));
}

/** Every node this one is wired to, either way round. */
export function connectionsOf(layout: Pick<CampusLayout, 'connections'>, id: string): LayoutConnection[] {
  return layout.connections.filter((c) => c.from === id || c.to === id);
}

export const EMPTY_LAYOUT: CampusLayout = { version: 1, nodes: {}, connections: [] };

/**
 * No zone may be made smaller than this, in cells.
 *
 * The office's reason is that below it a zone's four corner handles sit on top of each other and it cannot be
 * dragged back out again; the daemon's is that the same is true of a zone typed that small in Obsidian. One
 * number, so the note and the office cannot disagree about what a zone is.
 */
export const MIN_ZONE = 3;

const translateRect = (r: Rect, dx: number, dy: number): Rect => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });

/** Paint a rectangle into a walk grid, the same rounding the generator used. Mutates `grid`. */
export function paintRect(grid: number[][], walk: number, r: Rect, v: 0 | 1): void {
  const gh = grid.length, gw = grid[0]?.length ?? 0;
  const x0 = Math.max(0, Math.floor(r.x0 * walk)), x1 = Math.min(gw - 1, Math.floor(r.x1 * walk - 1e-6));
  const y0 = Math.max(0, Math.floor(r.y0 * walk)), y1 = Math.min(gh - 1, Math.floor(r.y1 * walk - 1e-6));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y][x] = v;
}

/**
 * The campus as the owner left it: the template map with their moves, removals and additions on top.
 *
 * Pure — it copies what it changes and never touches `map` — so the office can run it on every `layout.changed`
 * and the daemon on every write, and both get the same office. An empty layout returns the map unchanged.
 *
 * A zone that *moved* carries its desks: dragging the Revenue floor is one gesture, and the owner means the
 * desks in it, not an empty plate sliding off its row. A desk with an override of its own is left where the
 * override puts it, so the two never fight. Resizing a zone moves nothing.
 *
 * The collision grid follows the desks, and only the desks: a desk is the campus's big obstacle, and leaving
 * its old cells blocked would have people walking round furniture that is not there any more. Notes, boards
 * and stations are things you stand at, so they block nothing.
 */
export function applyLayout(map: CampusMap, layout: CampusLayout | null | undefined): CampusMap {
  const nodes = layout?.nodes ?? {};
  const ids = Object.keys(nodes);
  if (!ids.length) return map;

  const desks: Record<string, Desk> = { ...map.desks };
  const zones: Zone[] = map.zones.slice();
  let props: PropItem[] = map.props.slice();
  const resources: Record<string, ResourceNode> = { ...map.resources };
  const grid = map.grid.map((row) => row.slice());
  let gridTouched = false;

  // 1. zones first: a zone that moves takes the desks standing in it along, and a desk's own override wins.
  const carried: { was: Rect; dx: number; dy: number }[] = [];
  for (const [id, n] of Object.entries(nodes)) {
    const at = zones.findIndex((z) => z.id === id);
    if (at < 0) continue;
    const z = zones[at];
    if (n.removed) { zones.splice(at, 1); continue; }
    const x0 = n.x ?? z.rect.x0, y0 = n.y ?? z.rect.y0;
    const w = Math.max(MIN_ZONE, n.w ?? z.rect.x1 - z.rect.x0), d = Math.max(MIN_ZONE, n.d ?? z.rect.y1 - z.rect.y0);
    const dx = x0 - z.rect.x0, dy = y0 - z.rect.y0;
    if (dx || dy) carried.push({ was: z.rect, dx, dy });
    zones[at] = { ...z, rect: { x0, y0, x1: x0 + w, y1: y0 + d }, stand: { x: z.stand.x + dx, y: z.stand.y + dy } };
  }

  // 2. desks: an override moves the desk and the seat with it; the desk keeps the size the campus gave it.
  for (const d of Object.values(map.desks)) {
    const n = nodes[d.id];
    const carry = n?.x === undefined && n?.y === undefined ? carried.find((c) => inRect(c.was, { x: d.rect.x0, y: d.rect.y0 })) : undefined;
    if (!n && !carry) continue;
    if (n?.removed) {
      delete desks[d.id];
      paintRect(grid, map.walk, d.rect, 0); gridTouched = true;
      continue;
    }
    const dx = carry ? carry.dx : (n?.x ?? d.rect.x0) - d.rect.x0;
    const dy = carry ? carry.dy : (n?.y ?? d.rect.y0) - d.rect.y0;
    if (!dx && !dy) continue;
    desks[d.id] = { ...d, rect: translateRect(d.rect, dx, dy), seat: { x: d.seat.x + dx, y: d.seat.y + dy } };
    paintRect(grid, map.walk, d.rect, 0);
    paintRect(grid, map.walk, desks[d.id].rect, 1);
    gridTouched = true;
  }

  // 3. props: the plant the owner took out, and the one they pushed against the wall.
  props = props.flatMap((p) => {
    const n = nodes[p.id];
    if (!n) return [p];
    if (n.removed) return [];
    const dx = (n.x ?? p.at.x) - p.at.x, dy = (n.y ?? p.at.y) - p.at.y;
    return dx || dy ? [{ ...p, at: { x: p.at.x + dx, y: p.at.y + dy }, rect: translateRect(p.rect, dx, dy) }] : [p];
  });

  const zoneById: Record<string, Zone> = Object.fromEntries(zones.map((z) => [z.id, z]));

  // 4. what the owner added: everything with a `kind`. The zone comes from the note when it names one and from
  // the floor the thing stands on when it does not — zones may have moved in step 1, so this reads the new ones.
  for (const [id, n] of Object.entries(nodes)) {
    // Total, because this runs on what came back over the wire as well as on what the daemon validated: a line
    // that makes no sense is skipped on its own and the rest of the office still draws.
    if (!n.kind || n.removed || !RESOURCE_KINDS.includes(n.kind)) continue;
    if (n.x === undefined || n.y === undefined) continue;
    // A station is one of the five families, and its id says which — `station_email` is the email station. A
    // station that is neither is nothing the office could draw, so it is skipped with the rest of the junk.
    const family = n.kind !== 'station' ? '' : (STATION_FAMILIES as readonly string[]).includes(n.tool ?? '')
      ? n.tool! : STATION_FAMILIES.find((f) => stationId(f) === id) ?? '';
    if (n.kind === 'station' && !family) continue;
    const at = { x: n.x ?? 0, y: n.y ?? 0 };
    const zone = (n.zone && zoneById[n.zone] ? n.zone : zoneAt({ zones }, at)?.id) ?? null;
    resources[id] = {
      id, kind: n.kind, at, rect: resourceRect(n.kind, at), zone,
      accent: (zone && zoneById[zone]?.accent) || 'neutral',
      label: labelOfNode(n.kind, { ...n, tool: family || n.tool }), body: n.body ?? '', path: n.path ?? '', tool: family,
    };
    // A thing on the floor is on the floor: without this an agent walks straight through the kiosk the owner has
    // just put in front of them, and the office reads as a diagram again.
    paintRect(grid, map.walk, resources[id].rect, 1); gridTouched = true;
  }

  return {
    ...map, desks, zones, zoneById, props, resources,
    rail: zones.filter((z) => z.rail).sort((a, b) => a.rail!.order - b.rail!.order),
    grid: gridTouched ? grid : map.grid,
  };
}
