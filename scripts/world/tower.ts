/**
 * The tower: four floors stacked as a cross-section, the elevator shaft on the right, the street below.
 * Pure data and painters; scripts/gen-world.ts writes what buildTower() returns. Coordinates are tiles (16 px).
 * Layout rules (docs/specs/2026-09-11-tower-engine-notes.md §1): rooms interior rows y0+1..y0+8, room
 * bottom wall with a door at y0+9, corridor y0+10..y0+12, elevator door at (50, y0+11). Desk objects sit on the
 * chair tile. Wall screens: SCREEN tiles on wallRow+1, stand at (tx+⌊tw/2⌋, wallRow+2).
 */
import { T, tilesetMeta } from '../../packages/viewer/src/world/tiles.js';
import { floorPalette } from '../../packages/viewer/src/world/palette.js';

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
    { n: 1, y0: 41, label: 'Executive', color: floorPalette(1).tab, carpet: T.CARPET, rooms: [
      { id: 'ceo_office', label: 'CEO', kind: 'office', x0: 4, x1: 15, desk: 'ceo', surfaces: [{ kind: 'cabin', tx: 5, tw: 8, label: 'Cabin — talk to the CEO' }] },
      { id: 'meetingroom', label: 'Meeting room', kind: 'meeting', x0: 15, x1: 26 },
      { id: 'boardroom', label: 'Board room', kind: 'board', x0: 26, x1: 39, surfaces: [{ kind: 'whiteboard', tx: 28, tw: 9, label: 'Whiteboard — Plans/plan.md' }] },
      { id: 'pantry', label: 'Pantry', kind: 'pantry', x0: 39, x1: 50 },
    ] },
    { n: 2, y0: 28, label: 'Teams', color: floorPalette(2).tab, carpet: T.CARPET_BLUE, rooms: [
      { id: 'chro_office', label: 'CHRO', kind: 'office', x0: 4, x1: 14, desk: 'chro' },
      { id: 'research', label: 'Research', kind: 'department', x0: 14, x1: 25, manager: 'research_manager', members: ['researcher', 'research_analyst', 'data_scientist', 'intelligence_analyst', 'research_engineer'] },
      { id: 'dev', label: 'Dev', kind: 'department', x0: 25, x1: 39, manager: 'dev_manager', beside: ['product_manager', 'product_designer'], members: ['backend_engineer', 'frontend_engineer', 'fullstack_engineer', 'platform_engineer', 'sre'], surfaces: [{ kind: 'terminal', tx: 27, tw: 9, label: 'Terminal — shell output' }] },
      { id: 'sales', label: 'Sales', kind: 'department', x0: 39, x1: 50, manager: 'cso', members: ['sales_1', 'sales_2', 'sales_3', 'sales_4', 'sales_5'], surfaces: [{ kind: 'postoffice', tx: 40, tw: 9, label: 'Post office — mail & approvals' }] },
    ] },
    { n: 3, y0: 15, label: 'Assurance', color: floorPalette(3).tab, carpet: T.CARPET_GREEN, rooms: [
      { id: 'clo_office', label: 'CLO', kind: 'office', x0: 4, x1: 14, desk: 'clo' },
      { id: 'ciso_office', label: 'CISO', kind: 'office', x0: 14, x1: 25, desk: 'ciso', surfaces: [{ kind: 'vault', tx: 16, tw: 8, label: 'Vault — open in Obsidian' }] },
      { id: 'cgo_office', label: 'CGO', kind: 'office', x0: 25, x1: 35, desk: 'cgo' },
      { id: 'qa', label: 'QA', kind: 'department', x0: 35, x1: 50, manager: 'qa_lead', members: ['qa_automation', 'qa_exploratory', 'qa_performance', 'qa_security', 'qa_release'], surfaces: [{ kind: 'workshop', tx: 37, tw: 10, label: 'Workshop — site preview & deploys' }] },
    ] },
    { n: 4, y0: 2, label: 'Chiefs', color: floorPalette(4).tab, carpet: T.CARPET_ORANGE, rooms: [
      { id: 'cto_office', label: 'CTO', kind: 'office', x0: 4, x1: 14, desk: 'cto' },
      { id: 'cmo_office', label: 'CMO', kind: 'office', x0: 14, x1: 30, desk: 'cmo', surfaces: [{ kind: 'billboard', tx: 15, tw: 7, label: 'Billboard — live browser' }, { kind: 'newsstand', tx: 23, tw: 6, label: 'Newsstand — briefs & decisions' }] },
      { id: 'coo_office', label: 'COO', kind: 'office', x0: 30, x1: 40, desk: 'coo' },
      { id: 'cfo_office', label: 'CFO', kind: 'office', x0: 40, x1: 50, desk: 'cfo', surfaces: [{ kind: 'bank', tx: 41, tw: 8, label: 'Bank — cash and runway' }] },
    ] },
  ],
};

export const cxOf = (r: RoomSpec): number => Math.floor((r.x0 + r.x1) / 2);
export const portalTile = (y0: number): { tx: number; ty: number } => ({ tx: SHAFT.x0, ty: y0 + 11 });

/** Which ids paint floor `n`. The visual layer draws them from floorPalette(n); the painter only chooses names. */
export function materials(n: 1 | 2 | 3 | 4) {
  const f = (name: string) => (T as Record<string, number>)[`${name}_F${n}`];
  return { floor: f('FLOOR'), floorAlt: f('FLOOR_ALT'), carpet: f('CARPET'), wall: f('WALL'), sign: f('SIGN') };
}

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
  /** Object + desk-row registration on the chair tile (deskRow + 1). The caller paints the desk/chair tiles itself
   * (a fixed desk is DESK_EXEC_L/R + CHAIR_EXEC, a member desk DESK_L/R + CHAIR_TASK) so the richer furniture shows. */
  desk(id: string, x: number, deskRow: number, room: string, floor: number, slot: DeskRow['slot']): void {
    this.obj(this.objects, id, 'desk', x, deskRow + 1, 1, 1, { room, floor, slot });
    this.desks.push({ id, x, y: deskRow + 1, room, floor, slot });
  }
  seat(name: string, x: number, y: number, room: string, floor: number, extra: Props = {}, tile: number = T.CHAIR): void { this.set(this.furniture, x, y, tile); this.obj(this.objects, name, 'seat', x, y, 1, 1, { room, floor, ...extra }); }
  decorAt(kind: string, x: number, y: number, floor: number, extra: Props = {}): void { this.obj(this.decor, `decor_${this.decor.length + 1}`, 'decor', x, y, 1, 1, { kind, floor, ...extra }); }
}

function paintSurface(c: Canvas, s: SurfaceSpec, wallRow: number, floor: number): void {
  for (let x = s.tx; x < s.tx + s.tw; x++) c.set(c.furniture, x, wallRow + 1, x === s.tx ? T.SCREEN_BEZEL_L : x === s.tx + s.tw - 1 ? T.SCREEN_BEZEL_R : T.SCREEN_BEZEL);
  c.obj(c.objects, s.kind, 'surface', s.tx, wallRow, s.tw, 3, { label: s.label, floor, stand_x: s.tx + Math.floor(s.tw / 2), stand_y: wallRow + 2 });
}

/** Floor material, carpet, back-wall windows, the glass partition to the next room, the door, the sign tile,
 * the room/sign objects and the wall screens — shared by every room kind. */
function paintRoomBox(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  const { y0 } = f, cx = cxOf(r), m = materials(f.n as 1 | 2 | 3 | 4);
  for (let y = y0 + 1; y <= y0 + 8; y++) for (let x = r.x0 + 1; x <= r.x1 - 1; x++) c.set(c.ground, x, y, (x + y) % 5 === 0 ? m.floorAlt : m.floor);
  c.rect(c.ground, r.x0 + 2, y0 + 3, r.x1 - 2, y0 + 7, m.carpet);
  const underSurface = (x: number) => (r.surfaces ?? []).some((s) => x >= s.tx && x < s.tx + s.tw);
  for (let x = r.x0 + 1; x <= r.x1 - 1; x++) {
    const isWindow = x >= r.x0 + 2 && (x - (r.x0 + 2)) % 4 === 0 && !underSurface(x);
    c.set(c.walls, x, y0, isWindow ? T.WINDOW_DAY : m.wall);
  }
  if (r.x1 !== SHAFT.x0) {
    c.rect(c.walls, r.x1, y0 + 1, r.x1, y0 + 8, T.GLASS_V);
    c.set(c.walls, r.x1, y0 + 1, T.GLASS_CORNER);
  }
  c.rect(c.walls, r.x0, y0 + 9, r.x1, y0 + 9, T.WALL_TOP_INT);
  c.set(c.walls, cx, y0 + 9, T.DOOR_INT);
  c.set(c.furniture, cx + 1, y0 + 9, m.sign);
  c.obj(c.objects, r.id, 'room', r.x0 + 1, y0 + 1, r.x1 - r.x0 - 1, 8, { label: r.label, floor: f.n, stand_x: cx, stand_y: r.kind === 'pantry' ? y0 + 2 : y0 + 8 });
  c.obj(c.signs, `sign_${r.id}`, 'sign', cx + 1, y0 + 9, 1, 1, { room: r.id, label: r.label, floor: f.n });
  c.decorAt('lamp', cx, y0 + 1, f.n);
  for (const s of r.surfaces ?? []) paintSurface(c, s, y0, f.n);
}

/**
 * A one-person office: the desk on the centre line, and a seating corner in the three rows below it.
 *
 * The chiefs' rooms are ten to sixteen tiles wide and used to hold one desk, one chair and a filing cabinet — a
 * third of `05-f3` and `06-f4` was bare carpet (visual QA I6). The lower rows are the only ones that are always
 * free (a screen owns y0..y0+2, the desk y0+4..y0+5), and the centre column stays clear because it is the walk
 * from the door at y0+9 to the chair at y0+5.
 */
function paintOffice(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f, F = c.furniture;
  c.set(F, cx - 1, y0 + 4, T.DESK_EXEC_L); c.set(F, cx, y0 + 4, T.DESK_EXEC_R); c.set(F, cx, y0 + 5, T.CHAIR_EXEC);
  c.set(F, r.x0 + 2, y0 + 1, T.BOOKSHELF_T); c.set(F, r.x0 + 2, y0 + 2, T.BOOKSHELF_B);
  c.set(F, r.x1 - 2, y0 + 1, T.PLANT_TALL_T); c.set(F, r.x1 - 2, y0 + 2, T.PLANT_TALL_B);
  c.set(F, r.x1 - 2, y0 + 4, T.FILING);
  // left of the walk: a rug, a two-tile sofa facing the room, and a side table where the room is wide enough
  const l0 = r.x0 + 2, l1 = cx - 2, r0 = cx + 2, r1 = r.x1 - 2;
  c.rect(c.ground, l0, y0 + 6, Math.min(l1, l0 + 3), y0 + 8, T.RUG);
  c.set(F, l0, y0 + 7, T.SOFA_L); c.set(F, l0 + 1, y0 + 7, T.SOFA_R);
  if (l0 + 3 <= l1) c.set(F, l0 + 3, y0 + 7, T.SIDE_TABLE);
  // right of the walk: a planter, and a second bookcase in the wide rooms
  c.set(F, r1, y0 + 7, T.PLANT_SMALL);
  c.decorAt('plant', r1, y0 + 7, f.n);
  if (r1 - 2 >= r0) { c.set(F, r1 - 2, y0 + 7, T.BOOKSHELF_T); c.set(F, r1 - 2, y0 + 8, T.BOOKSHELF_B); }
  if (r.id === 'ceo_office') c.set(F, r.x0 + 2, y0 + 5, T.LAMP_FLOOR);
  if (r.id === 'ciso_office') c.set(F, r.x1 - 2, y0 + 2, T.SAFE_DOOR);
  c.decorAt('plant', r.x1 - 2, y0 + 2, f.n);
  c.desk(r.desk!, cx, y0 + 4, r.id, f.n, 'fixed');
}

function paintDepartment(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f, F = c.furniture;
  // A desk's left half is only painted when its column is strictly inside the room; a desk whose left half would
  // land on the room's own wall column (research's and sales's first member sit one step from x0) instead paints
  // just the DESK_R half on the chair column, so it never overwrites the wall/glass tile paintRoomBox already put there.
  const twoTile = (id: string, x: number, deskRow: number, slot: DeskRow['slot']): void => {
    if (x - 1 > r.x0 && x - 1 < r.x1) { c.set(F, x - 1, deskRow, T.DESK_L); c.decorAt('monitor', x - 1, deskRow, f.n, { desk: id }); }
    c.set(F, x, deskRow, T.DESK_R); c.set(F, x, deskRow + 1, T.CHAIR_TASK);
    c.desk(id, x, deskRow, r.id, f.n, slot);
  };
  twoTile(r.manager!, cx, y0 + 3, 'fixed');
  if (r.beside) { twoTile(r.beside[0], cx - 3, y0 + 3, 'member'); twoTile(r.beside[1], cx + 3, y0 + 3, 'member'); }
  (r.members ?? []).forEach((id, i) => twoTile(id, cx - 4 + 2 * i, y0 + 6, 'member'));
  if (r.id === 'dev') { c.set(F, r.x1 - 2, y0 + 1, T.RACK_T); c.set(F, r.x1 - 2, y0 + 2, T.RACK_B); }
  c.set(F, r.x0 + 1, y0 + 8, T.PLANT_SMALL);
  c.decorAt('plant', r.x0 + 1, y0 + 8, f.n);
}

function paintMeeting(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f, F = c.furniture;
  for (let x = cx - 2; x <= cx + 2; x++) {
    c.set(F, x, y0 + 4, x === cx - 2 ? T.BT_TL : x === cx + 2 ? T.BT_TR : T.BT_TM);
    c.set(F, x, y0 + 5, x === cx - 2 ? T.BT_BL : x === cx + 2 ? T.BT_BR : T.BT_BM);
  }
  const seats: [number, number][] = [[cx - 2, y0 + 3], [cx, y0 + 3], [cx + 2, y0 + 3], [cx - 2, y0 + 6], [cx, y0 + 6], [cx + 2, y0 + 6], [cx - 3, y0 + 4], [cx + 3, y0 + 5]];
  seats.forEach(([x, y], i) => c.seat(`${r.id}_seat_${i + 1}`, x, y, r.id, f.n, {}, T.CHAIR_TASK));
}

function paintBoard(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f, F = c.furniture;
  // advisors face the room from behind the table; the whiteboard's stand tile (cx, y0+2) stays clear, so the
  // desk/chair row keeps plan 1's y0+3/y0+4, and the table keeps plan 1's single row (y0+5) rather than the
  // meeting room's two-row shape — there is no free row to grow it into without moving the whiteboard stand,
  // the front-facing seats or the owner chair.
  const advisors: [string, number][] = [['advisor_skeptic', cx - 2], ['advisor_investor', cx], ['advisor_customer', cx + 2]];
  for (const [id, x] of advisors) {
    c.set(F, x - 1, y0 + 3, T.DESK_EXEC_L); c.set(F, x, y0 + 3, T.DESK_EXEC_R); c.set(F, x, y0 + 4, T.CHAIR_EXEC);
    c.desk(id, x, y0 + 3, r.id, f.n, 'fixed');
  }
  for (let x = cx - 3; x <= cx + 3; x++) c.set(F, x, y0 + 5, x === cx - 3 ? T.BT_TL : x === cx + 3 ? T.BT_TR : T.BT_TM);
  const seats: [number, number][] = [[cx - 3, y0 + 6], [cx - 1, y0 + 6], [cx + 1, y0 + 6], [cx + 3, y0 + 6], [cx - 4, y0 + 4], [cx + 4, y0 + 5]];
  seats.forEach(([x, y], i) => c.seat(`${r.id}_seat_${i + 1}`, x, y, r.id, f.n, {}, T.CHAIR_TASK));
  c.seat('owner_chair', cx, y0 + 7, r.id, f.n, { reserved: 'owner' }, T.OWNER_CHAIR);
  c.set(F, r.x0 + 1, y0 + 1, T.PLANT_TALL_T); c.set(F, r.x0 + 1, y0 + 2, T.PLANT_TALL_B);
  c.set(F, r.x1 - 1, y0 + 1, T.PLANT_TALL_T); c.set(F, r.x1 - 1, y0 + 2, T.PLANT_TALL_B);
  c.decorAt('plant', r.x0 + 1, y0 + 2, f.n); c.decorAt('plant', r.x1 - 1, y0 + 2, f.n);
}

function paintPantry(c: Canvas, r: RoomSpec, f: FloorSpec): void {
  paintRoomBox(c, r, f);
  const cx = cxOf(r), { y0 } = f, F = c.furniture;
  for (let x = r.x0 + 1; x <= r.x1 - 1; x++) c.set(F, x, y0 + 1, x === r.x0 + 1 ? T.COUNTER_L : x === r.x1 - 1 ? T.COUNTER_R : T.COUNTER_M);
  c.set(F, cx, y0 + 1, T.COFFEE_MACHINE);
  c.set(F, r.x1 - 2, y0 + 1, T.FRIDGE);
  c.set(F, r.x1 - 1, y0 + 2, T.WATER_COOLER);
  c.rect(F, cx - 3, y0 + 4, cx - 2, y0 + 4, T.CAFE_TABLE);
  c.rect(F, cx + 2, y0 + 4, cx + 3, y0 + 4, T.CAFE_TABLE);
  const seats: [number, number][] = [[cx - 3, y0 + 3], [cx - 2, y0 + 3], [cx - 3, y0 + 5], [cx - 2, y0 + 5], [cx + 2, y0 + 3], [cx + 3, y0 + 3], [cx + 2, y0 + 5], [cx + 3, y0 + 5]];
  seats.forEach(([x, y], i) => c.seat(`${r.id}_seat_${i + 1}`, x, y, r.id, f.n, {}, T.STOOL));
  c.decorAt('coffee', cx, y0 + 1, f.n);
  c.decorAt('cooler', r.x1 - 1, y0 + 2, f.n);
}

const PAINT: Record<RoomKind, (c: Canvas, r: RoomSpec, f: FloorSpec) => void> = { office: paintOffice, department: paintDepartment, meeting: paintMeeting, board: paintBoard, pantry: paintPantry };

function paintShaft(c: Canvas): void {
  c.rect(c.ground, SHAFT.x0 + 1, BUILDING.roofY + 1, SHAFT.x1 - 1, BUILDING.groundY - 1, T.FLOOR);
  for (let y = BUILDING.roofY + 1; y <= BUILDING.groundY - 1; y++) {
    c.set(c.walls, SHAFT.x0 + 1, y, T.ELEV_RAIL); c.set(c.walls, SHAFT.x1 - 1, y, T.ELEV_RAIL);
    c.set(c.walls, SHAFT.x0 + 2, y, T.ELEV_SHAFT);
  }
  for (let y = BUILDING.roofY; y <= BUILDING.groundY; y++) { c.set(c.walls, SHAFT.x0, y, T.WALL); c.set(c.walls, SHAFT.x1, y, T.WALL); }
  c.rect(c.walls, SHAFT.x0, BUILDING.roofY, SHAFT.x1, BUILDING.roofY, T.WALL_TOP);
  c.obj(c.objects, 'shaft', 'shaft', SHAFT.x0 + 1, BUILDING.roofY + 1, SHAFT.x1 - SHAFT.x0 - 1, BUILDING.groundY - BUILDING.roofY - 1, { floor: 0 });
}

function paintFloor(c: Canvas, f: FloorSpec): void {
  const { y0 } = f;
  c.rect(c.walls, BUILDING.x0, y0, SHAFT.x0, y0, f.n === 4 ? T.WALL_TOP : T.SLAB);   // roof on top, a slab between floors
  if (f.n === 1) {                                                                    // F1's corridor is the ground-floor lobby
    for (let y = y0 + 10; y <= y0 + 12; y++) for (let x = BUILDING.x0 + 1; x <= SHAFT.x0 - 1; x++) c.set(c.ground, x, y, (x + y) % 2 === 1 ? T.LOBBY_FLOOR_ALT : T.LOBBY_FLOOR);
  } else {
    c.rect(c.ground, BUILDING.x0 + 1, y0 + 10, SHAFT.x0 - 1, y0 + 12, T.CORRIDOR);
  }
  for (let y = y0 + 1; y <= y0 + 12; y++) c.set(c.walls, BUILDING.x0, y, T.WALL);      // outer wall
  for (const r of f.rooms) PAINT[r.kind](c, r, f);
  const p = portalTile(y0);
  c.set(c.walls, p.tx, p.ty, T.ELEV_DOOR_L);
  c.set(c.furniture, SHAFT.x0, y0 + 10, T.ELEV_FRAME);
  c.set(c.furniture, SHAFT.x0 - 1, y0 + 10, T.ELEV_CALL);
  c.obj(c.objects, `elevator_${f.n}`, 'portal', p.tx, p.ty, 1, 1, { floor: f.n });
  c.obj(c.objects, `floor_${f.n}`, 'floor', BUILDING.x0, y0, SHAFT.x1 - BUILDING.x0 + 1, FLOOR_STRIDE + 1, { floor: f.n, label: f.label, color: f.color, portal_x: p.tx, portal_y: p.ty });
}

/**
 * The notice board hangs on the F1 corridor wall above the corridor, opposite the board room door.
 *
 * It starts at column 37, not 34: the board room's sign plate is drawn from column 33 rightwards and ran straight
 * under the old anchor, so the sign was half-eaten in every F1 frame (visual QA I4). Seven tiles rather than four,
 * so "Queue empty" and a job line fit the glass instead of being cut to "Queue…" (I3). The pantry's sign sits at
 * column 45, which the right edge at 43 clears.
 */
function paintLobby(c: Canvas): void {
  paintSurface(c, { kind: 'noticeboard', tx: 37, tw: 7, label: 'Notice board — the queue' }, 50, 1);
}

function paintStreet(c: Canvas): void {
  const g = BUILDING.groundY;
  c.rect(c.ground, 0, g + 1, W - 1, g + 1, T.KERB);
  c.rect(c.ground, 0, g + 2, W - 1, g + 3, T.STREET);
  c.rect(c.ground, 0, g + 4, W - 1, H - 1, T.PAVEMENT);
  c.rect(c.ground, ENTRANCE.x0, g + 1, ENTRANCE.x1, H - 1, T.PAVEMENT);   // the walk crosses the kerb and street as pavement
  c.rect(c.walls, BUILDING.x0, g, SHAFT.x1, g, T.WALL);
  c.set(c.walls, ENTRANCE.x0, g, T.GLASS_DOOR); c.set(c.walls, ENTRANCE.x1, g, T.GLASS_DOOR);
  c.obj(c.objects, 'door', 'anchor', ENTRANCE.x0, g, 2, 1, { label: 'Entrance', floor: 1, stand_x: ENTRANCE.x1, stand_y: g + 1 });
  for (const x of [2, 11, 20, 29, 38, 56]) c.set(c.furniture, x, 60, T.TREE);
}

/** The building's outer skin, painted last so it wins over the per-floor walls beneath it: facade edges on the two
 * outer columns, the roof cap, and the ground-level facade (except the entrance, which stays glass). */
function paintFacade(c: Canvas): void {
  for (let y = BUILDING.roofY; y <= BUILDING.groundY; y++) { c.set(c.walls, BUILDING.x0, y, T.FACADE_EDGE); c.set(c.walls, BUILDING.x1, y, T.FACADE_EDGE); }
  c.rect(c.walls, BUILDING.x0, BUILDING.roofY, BUILDING.x1, BUILDING.roofY, T.ROOF_EDGE);
  c.rect(c.walls, BUILDING.x0, BUILDING.groundY, BUILDING.x1, BUILDING.groundY, T.FACADE);
  c.set(c.walls, ENTRANCE.x0, BUILDING.groundY, T.GLASS_DOOR); c.set(c.walls, ENTRANCE.x1, BUILDING.groundY, T.GLASS_DOOR);
}

export function buildTower(): { map: TiledMap; desks: DeskRow[] } {
  const c = new Canvas();
  c.rect(c.ground, BUILDING.x0, BUILDING.roofY, BUILDING.x1, BUILDING.groundY, T.FLOOR);   // the building's footprint: floor under every wall, door and slab (sky blocks; a door on sky would too)
  paintShaft(c);
  for (const f of TOWER.floors) paintFloor(c, f);
  paintLobby(c);
  paintStreet(c);
  paintFacade(c);
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
