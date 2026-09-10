/**
 * The tower: four floors stacked as a cross-section, the elevator shaft on the right, the street below.
 * Pure data and painters; scripts/gen-world.ts writes what buildTower() returns. Coordinates are tiles (16 px).
 * Layout rules (docs/specs/2026-09-11-tower-engine-notes.md §1): rooms interior rows y0+1..y0+8, room
 * bottom wall with a door at y0+9, corridor y0+10..y0+12, elevator door at (50, y0+11). Desk objects sit on the
 * chair tile. Wall screens: SCREEN tiles on wallRow+1, stand at (tx+⌊tw/2⌋, wallRow+2).
 */
import { T, tilesetMeta } from '../../packages/viewer/src/world/tiles.js';

export const W = 60, H = 64, TILE = 16;
export const BUILDING = { x0: 4, x1: 54, roofY: 2, groundY: 54 } as const;
export const SHAFT = { x0: 50, x1: 54 } as const;     // wall columns; the car interior is 51..53
export const FLOOR_STRIDE = 13;
export const ENTRANCE = { x0: 46, x1: 47 } as const;  // door tiles on the ground row; the walk runs down x 46..47

export type RoomKind = 'office' | 'department' | 'meeting' | 'board' | 'pantry';
export interface SurfaceSpec { kind: string; tx: number; tw: number; label: string }
export interface RoomSpec {
  id: string; label: string; kind: RoomKind; x0: number; x1: number;   // x0/x1 are the wall columns (shared with the neighbour)
  desk?: string;                        // office: the one desk
  manager?: string;                     // department: the manager desk on row y0+3
  beside?: [string, string];            // department: two desks flanking the manager on the same row (Dev: PM, PD)
  members?: string[];                   // department: the member row y0+6, chairs y0+7, x = cx-4+2i
  surfaces?: SurfaceSpec[];             // wall screens on the room's top wall row
}
export interface FloorSpec { n: number; y0: number; label: string; color: string; carpet: number; rooms: RoomSpec[] }
export interface DeskRow { id: string; x: number; y: number; room: string; floor: number; slot: 'fixed' | 'member' }
export interface TiledProperty { name: string; type: 'int' | 'string'; value: string | number }
export interface TiledObject { id: number; name: string; type: string; x: number; y: number; width: number; height: number; properties: TiledProperty[] }
export interface TiledLayer { id: number; name: string; type: 'tilelayer' | 'objectgroup'; visible: boolean; opacity: number; x: number; y: number; width?: number; height?: number; data?: number[]; draworder?: string; objects?: TiledObject[]; properties?: { name: string; type: string; value: boolean }[] }
export interface TiledMap { type: 'map'; version: string; tiledversion: string; orientation: string; renderorder: string; width: number; height: number; tilewidth: number; tileheight: number; infinite: boolean; nextlayerid: number; nextobjectid: number; tilesets: ReturnType<typeof tilesetMeta>[]; layers: TiledLayer[]; properties: { name: string; type: string; value: string }[] }

export const TOWER: { floors: FloorSpec[] } = {
  floors: [
    { n: 1, y0: 41, label: 'Executive', color: '#7c5cbf', carpet: T.CARPET, rooms: [
      { id: 'ceo_office', label: 'CEO', kind: 'office', x0: 4, x1: 15, desk: 'ceo', surfaces: [{ kind: 'cabin', tx: 5, tw: 8, label: 'Cabin — talk to the CEO' }] },
      { id: 'meetingroom', label: 'Meeting room', kind: 'meeting', x0: 15, x1: 26 },
      { id: 'boardroom', label: 'Board room', kind: 'board', x0: 26, x1: 39, surfaces: [{ kind: 'whiteboard', tx: 28, tw: 9, label: 'Whiteboard — Plans/plan.md' }] },
      { id: 'pantry', label: 'Pantry', kind: 'pantry', x0: 39, x1: 50 },
    ] },
    { n: 2, y0: 28, label: 'Teams', color: '#3f7fd6', carpet: T.CARPET_BLUE, rooms: [
      { id: 'chro_office', label: 'CHRO', kind: 'office', x0: 4, x1: 14, desk: 'chro' },
      { id: 'research', label: 'Research', kind: 'department', x0: 14, x1: 25, manager: 'research_manager', members: ['researcher', 'research_analyst', 'data_scientist', 'intelligence_analyst', 'research_engineer'] },
      { id: 'dev', label: 'Dev', kind: 'department', x0: 25, x1: 39, manager: 'dev_manager', beside: ['product_manager', 'product_designer'], members: ['backend_engineer', 'frontend_engineer', 'fullstack_engineer', 'platform_engineer', 'sre'], surfaces: [{ kind: 'terminal', tx: 27, tw: 9, label: 'Terminal — shell output' }] },
      { id: 'sales', label: 'Sales', kind: 'department', x0: 39, x1: 50, manager: 'cso', members: ['sales_1', 'sales_2', 'sales_3', 'sales_4', 'sales_5'], surfaces: [{ kind: 'postoffice', tx: 40, tw: 9, label: 'Post office — mail & approvals' }] },
    ] },
    { n: 3, y0: 15, label: 'Assurance', color: '#3ea96f', carpet: T.CARPET_GREEN, rooms: [
      { id: 'clo_office', label: 'CLO', kind: 'office', x0: 4, x1: 14, desk: 'clo' },
      { id: 'ciso_office', label: 'CISO', kind: 'office', x0: 14, x1: 25, desk: 'ciso', surfaces: [{ kind: 'vault', tx: 16, tw: 8, label: 'Vault — open in Obsidian' }] },
      { id: 'cgo_office', label: 'CGO', kind: 'office', x0: 25, x1: 35, desk: 'cgo' },
      { id: 'qa', label: 'QA', kind: 'department', x0: 35, x1: 50, manager: 'qa_lead', members: ['qa_automation', 'qa_exploratory', 'qa_performance', 'qa_security', 'qa_release'], surfaces: [{ kind: 'workshop', tx: 37, tw: 10, label: 'Workshop — site preview & deploys' }] },
    ] },
    { n: 4, y0: 2, label: 'Chiefs', color: '#e0883a', carpet: T.CARPET_ORANGE, rooms: [
      { id: 'cto_office', label: 'CTO', kind: 'office', x0: 4, x1: 14, desk: 'cto' },
      { id: 'cmo_office', label: 'CMO', kind: 'office', x0: 14, x1: 30, desk: 'cmo', surfaces: [{ kind: 'billboard', tx: 15, tw: 7, label: 'Billboard — live browser' }, { kind: 'newsstand', tx: 23, tw: 6, label: 'Newsstand — briefs & decisions' }] },
      { id: 'coo_office', label: 'COO', kind: 'office', x0: 30, x1: 40, desk: 'coo' },
      { id: 'cfo_office', label: 'CFO', kind: 'office', x0: 40, x1: 50, desk: 'cfo', surfaces: [{ kind: 'bank', tx: 41, tw: 8, label: 'Bank — quota runway' }] },
    ] },
  ],
};

export const cxOf = (r: RoomSpec): number => Math.floor((r.x0 + r.x1) / 2);
export const portalTile = (y0: number): { tx: number; ty: number } => ({ tx: SHAFT.x0, ty: y0 + 11 });

type Props = Record<string, string | number>;

/** Three tile layers, three object lists and the desk rows, with the small drawing helpers the painters use. */
class Canvas {
  ground: number[] = new Array(W * H).fill(T.SKY);
  walls: number[] = new Array(W * H).fill(T.EMPTY);
  furniture: number[] = new Array(W * H).fill(T.EMPTY);
  objects: TiledObject[] = []; decor: TiledObject[] = []; signs: TiledObject[] = [];
  desks: DeskRow[] = [];
  private oid = 1;
  nextId(): number { return this.oid; }
  set(layer: number[], x: number, y: number, v: number): void { if (x >= 0 && y >= 0 && x < W && y < H) layer[y * W + x] = v; }
  rect(layer: number[], x0: number, y0: number, x1: number, y1: number, v: number): void { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(layer, x, y, v); }
  obj(list: TiledObject[], name: string, type: string, tx: number, ty: number, tw = 1, th = 1, props: Props = {}): void {
    list.push({ id: this.oid++, name, type, x: tx * TILE, y: ty * TILE, width: tw * TILE, height: th * TILE, properties: Object.entries(props).map(([k, v]) => ({ name: k, type: typeof v === 'number' ? 'int' : 'string', value: v })) });
  }
  desk(id: string, x: number, deskRow: number, room: string, floor: number, slot: DeskRow['slot']): void {
    this.set(this.furniture, x, deskRow, T.DESK); this.set(this.furniture, x, deskRow + 1, T.CHAIR);
    this.obj(this.objects, id, 'desk', x, deskRow + 1, 1, 1, { room, floor, slot });
    this.desks.push({ id, x, y: deskRow + 1, room, floor, slot });
  }
  seat(name: string, x: number, y: number, room: string, floor: number, extra: Props = {}): void { this.set(this.furniture, x, y, T.CHAIR); this.obj(this.objects, name, 'seat', x, y, 1, 1, { room, floor, ...extra }); }
  decorAt(kind: string, x: number, y: number, floor: number): void { this.obj(this.decor, `decor_${this.decor.length + 1}`, 'decor', x, y, 1, 1, { kind, floor }); }
}

function paintSurface(c: Canvas, s: SurfaceSpec, wallRow: number, floor: number): void {
  c.rect(c.furniture, s.tx, wallRow + 1, s.tx + s.tw - 1, wallRow + 1, T.SCREEN);
  c.obj(c.objects, s.kind, 'surface', s.tx, wallRow, s.tw, 3, { label: s.label, floor, stand_x: s.tx + Math.floor(s.tw / 2), stand_y: wallRow + 2 });
}

/** Walls, carpet, door, room object, sign and wall screens shared by every room kind. */
function paintRoomBox(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  const { y0 } = f, cx = cxOf(r);
  c.rect(c.ground, r.x0 + 1, y0 + 1, r.x1 - 1, y0 + 8, f.carpet);
  for (let y = y0 + 1; y <= y0 + 9; y++) { c.set(c.walls, r.x0, y, T.WALL); c.set(c.walls, r.x1, y, T.WALL); }
  c.rect(c.walls, r.x0, y0 + 9, r.x1, y0 + 9, T.WALL);
  c.set(c.walls, cx, y0 + 9, T.DOOR);
  c.obj(c.objects, r.id, 'room', r.x0 + 1, y0 + 1, r.x1 - r.x0 - 1, 8, { label: r.label, floor: f.n, stand_x: cx, stand_y: r.kind === 'pantry' ? y0 + 2 : y0 + 8 });
  c.obj(c.signs, `sign_${r.id}`, 'sign', cx + 1, y0 + 9, 1, 1, { room: r.id, label: r.label, floor: f.n });
  for (const s of r.surfaces ?? []) paintSurface(c, s, y0, f.n);
}

function paintOffice(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r);
  c.desk(r.desk!, cx, f.y0 + 4, r.id, f.n, 'fixed');
  c.decorAt('plant', r.x1 - 1, f.y0 + 8, f.n);
  c.decorAt('lamp', r.x0 + 1, f.y0 + 8, f.n);
}

function paintDepartment(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f;
  c.desk(r.manager!, cx, y0 + 3, r.id, f.n, 'fixed');
  if (r.beside) { c.desk(r.beside[0], cx - 3, y0 + 3, r.id, f.n, 'member'); c.desk(r.beside[1], cx + 3, y0 + 3, r.id, f.n, 'member'); }
  (r.members ?? []).forEach((id, i) => c.desk(id, cx - 4 + 2 * i, y0 + 6, r.id, f.n, 'member'));
  c.decorAt('plant', r.x1 - 1, y0 + 8, f.n);
}

function paintMeeting(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f;
  c.rect(c.furniture, cx - 2, y0 + 4, cx + 2, y0 + 5, T.TABLE);
  const seats: [number, number][] = [[cx - 2, y0 + 3], [cx, y0 + 3], [cx + 2, y0 + 3], [cx - 2, y0 + 6], [cx, y0 + 6], [cx + 2, y0 + 6], [cx - 3, y0 + 4], [cx + 3, y0 + 5]];
  seats.forEach(([x, y], i) => c.seat(`${r.id}_seat_${i + 1}`, x, y, r.id, f.n));
  c.decorAt('plant', r.x1 - 1, y0 + 8, f.n);
}

function paintBoard(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f;
  // advisors face the room from behind the table; the whiteboard's stand row (y0+2) stays clear
  c.desk('advisor_skeptic', cx - 2, y0 + 3, r.id, f.n, 'fixed');
  c.desk('advisor_investor', cx, y0 + 3, r.id, f.n, 'fixed');
  c.desk('advisor_customer', cx + 2, y0 + 3, r.id, f.n, 'fixed');
  c.rect(c.furniture, cx - 3, y0 + 5, cx + 3, y0 + 5, T.TABLE);
  const seats: [number, number][] = [[cx - 3, y0 + 6], [cx - 1, y0 + 6], [cx + 1, y0 + 6], [cx + 3, y0 + 6], [cx - 4, y0 + 4], [cx + 4, y0 + 5]];
  seats.forEach(([x, y], i) => c.seat(`${r.id}_seat_${i + 1}`, x, y, r.id, f.n));
  c.seat('owner_chair', cx, y0 + 7, r.id, f.n, { reserved: 'owner' });
  c.decorAt('plant', r.x1 - 1, y0 + 8, f.n);
}

function paintPantry(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f;
  c.rect(c.furniture, r.x0 + 1, y0 + 1, r.x1 - 1, y0 + 1, T.COUNTER);
  c.rect(c.furniture, cx - 3, y0 + 4, cx - 2, y0 + 4, T.TABLE);
  c.rect(c.furniture, cx + 2, y0 + 4, cx + 3, y0 + 4, T.TABLE);
  const seats: [number, number][] = [[cx - 3, y0 + 3], [cx - 2, y0 + 3], [cx - 3, y0 + 5], [cx - 2, y0 + 5], [cx + 2, y0 + 3], [cx + 3, y0 + 3], [cx + 2, y0 + 5], [cx + 3, y0 + 5]];
  seats.forEach(([x, y], i) => c.seat(`${r.id}_seat_${i + 1}`, x, y, r.id, f.n));
  c.decorAt('coffee', r.x1 - 1, y0 + 2, f.n);
  c.decorAt('cooler', r.x0 + 1, y0 + 2, f.n);
}

const PAINT: Record<RoomKind, (c: Canvas, r: RoomSpec, f: FloorSpec) => void> = { office: paintOffice, department: paintDepartment, meeting: paintMeeting, board: paintBoard, pantry: paintPantry };

function paintShaft(c: Canvas): void {
  c.rect(c.ground, SHAFT.x0 + 1, BUILDING.roofY + 1, SHAFT.x1 - 1, BUILDING.groundY - 1, T.FLOOR);
  c.rect(c.walls, SHAFT.x0 + 1, BUILDING.roofY + 1, SHAFT.x1 - 1, BUILDING.groundY - 1, T.SHAFT);
  for (let y = BUILDING.roofY; y <= BUILDING.groundY; y++) { c.set(c.walls, SHAFT.x0, y, T.WALL); c.set(c.walls, SHAFT.x1, y, T.WALL); }
  c.rect(c.walls, SHAFT.x0, BUILDING.roofY, SHAFT.x1, BUILDING.roofY, T.WALL_TOP);
  c.obj(c.objects, 'shaft', 'shaft', SHAFT.x0 + 1, BUILDING.roofY + 1, SHAFT.x1 - SHAFT.x0 - 1, BUILDING.groundY - BUILDING.roofY - 1, { floor: 0 });
}

function paintFloor(c: Canvas, f: FloorSpec): void {
  const { y0 } = f;
  c.rect(c.walls, BUILDING.x0, y0, SHAFT.x0, y0, f.n === 4 ? T.WALL_TOP : T.SLAB);   // roof on top, a slab between floors
  c.rect(c.ground, BUILDING.x0 + 1, y0 + 10, SHAFT.x0 - 1, y0 + 12, T.FLOOR);         // corridor
  for (let y = y0 + 1; y <= y0 + 12; y++) c.set(c.walls, BUILDING.x0, y, T.WALL);      // outer wall
  for (const r of f.rooms) PAINT[r.kind](c, r, f);
  const p = portalTile(y0);
  c.set(c.walls, p.tx, p.ty, T.ELEVATOR_DOOR);
  c.obj(c.objects, `elevator_${f.n}`, 'portal', p.tx, p.ty, 1, 1, { floor: f.n });
  c.obj(c.objects, `floor_${f.n}`, 'floor', BUILDING.x0, y0, SHAFT.x1 - BUILDING.x0 + 1, FLOOR_STRIDE + 1, { floor: f.n, label: f.label, color: f.color, portal_x: p.tx, portal_y: p.ty });
}

/** The notice board hangs on the F1 corridor wall above the corridor, opposite the board room door. */
function paintLobby(c: Canvas): void {
  paintSurface(c, { kind: 'noticeboard', tx: 34, tw: 4, label: 'Notice board — queue' }, 50, 1);
}

function paintStreet(c: Canvas): void {
  const g = BUILDING.groundY;
  c.rect(c.ground, 0, g + 1, W - 1, H - 1, T.GRASS);
  c.rect(c.ground, 0, g + 1, W - 1, g + 3, T.PATH);
  c.rect(c.ground, ENTRANCE.x0, g + 1, ENTRANCE.x1, H - 1, T.PATH);
  c.rect(c.walls, BUILDING.x0, g, SHAFT.x1, g, T.WALL);
  c.set(c.walls, ENTRANCE.x0, g, T.DOOR); c.set(c.walls, ENTRANCE.x1, g, T.DOOR);
  c.obj(c.objects, 'door', 'anchor', ENTRANCE.x0, g, 2, 1, { label: 'Entrance', floor: 1, stand_x: ENTRANCE.x1, stand_y: g + 1 });
  for (const x of [2, 11, 20, 29, 38, 56]) c.set(c.furniture, x, 60, T.TREE);
}

export function buildTower(): { map: TiledMap; desks: DeskRow[] } {
  const c = new Canvas();
  c.rect(c.ground, BUILDING.x0, BUILDING.roofY, BUILDING.x1, BUILDING.groundY, T.FLOOR);   // the building's footprint: floor under every wall, door and slab (sky blocks; a door on sky would too)
  paintShaft(c);
  for (const f of TOWER.floors) paintFloor(c, f);
  paintLobby(c);
  paintStreet(c);
  const tiles = (id: number, name: string, data: number[], collides = false): TiledLayer => ({ id, name, type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data, ...(collides ? { properties: [{ name: 'collides', type: 'bool', value: true }] } : {}) });
  const group = (id: number, name: string, objects: TiledObject[]): TiledLayer => ({ id, name, type: 'objectgroup', visible: true, opacity: 1, x: 0, y: 0, draworder: 'topdown', objects });
  const map: TiledMap = {
    type: 'map', version: '1.10', tiledversion: 'cubicle-gen', orientation: 'orthogonal', renderorder: 'right-down', width: W, height: H, tilewidth: TILE, tileheight: TILE, infinite: false, nextlayerid: 7, nextobjectid: c.nextId(),
    tilesets: [tilesetMeta()],
    layers: [tiles(1, 'ground', c.ground), tiles(2, 'walls', c.walls, true), tiles(3, 'furniture', c.furniture, true), group(4, 'objects', c.objects), group(5, 'decor', c.decor), group(6, 'signs', c.signs)],
    properties: [{ name: 'generated', type: 'string', value: 'scripts/gen-world.ts' }],
  };
  return { map, desks: c.desks };
}
