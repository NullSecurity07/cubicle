import { describe, it, expect } from 'vitest';
import { buildTower, TOWER, cxOf, W, H } from '../../../../scripts/world/tower.js';
import { parseMap, type TiledMap } from './map.js';
import { DESK_IDS, ROOM_IDS, SURFACE_IDS } from './tower.fixture.js';
import { T } from './tiles.js';

const built = buildTower();
const m = parseMap(built.map as unknown as TiledMap);
const objs = built.map.layers.filter((l) => l.type === 'objectgroup').flatMap((l) => l.objects ?? []);
const named = (type: string) => objs.filter((o) => o.type === type).map((o) => o.name);
const prop = (o: { properties?: { name: string; value: string | number }[] }, k: string) => o.properties?.find((p) => p.name === k)?.value;

describe('buildTower', () => {
  it('is 60×64 with the four floors at y0 = 41, 28, 15, 2', () => {
    expect(built.map.width).toBe(W); expect(built.map.height).toBe(H); expect(W).toBe(60); expect(H).toBe(64);
    expect(TOWER.floors.map((f) => f.y0)).toEqual([41, 28, 15, 2]);
    expect(named('floor')).toEqual(['floor_1', 'floor_2', 'floor_3', 'floor_4']);
  });
  it('has exactly the 38 desks, in generation order, and the desks list matches the desk objects', () => {
    expect(named('desk')).toEqual(DESK_IDS);
    expect(built.desks.map((d) => d.id)).toEqual(DESK_IDS);
    for (const d of built.desks) expect(m.desks[d.id], d.id).toEqual({ tx: d.x, ty: d.y });
    expect(built.desks.filter((d) => d.slot === 'member').map((d) => d.id)).toEqual(['researcher', 'research_analyst', 'data_scientist', 'intelligence_analyst', 'research_engineer', 'product_manager', 'product_designer', 'backend_engineer', 'frontend_engineer', 'fullstack_engineer', 'platform_engineer', 'sre', 'sales_1', 'sales_2', 'sales_3', 'sales_4', 'sales_5', 'qa_automation', 'qa_exploratory', 'qa_performance', 'qa_security', 'qa_release']);
  });
  it('places the spot-checked desks on their chair tiles', () => {
    expect(m.desks.ceo).toEqual({ tx: 9, ty: 46 });
    expect(m.desks.cmo).toEqual({ tx: 22, ty: 7 });
    expect(m.desks.cfo).toEqual({ tx: 45, ty: 7 });
    expect(m.desks.ciso).toEqual({ tx: 19, ty: 20 });
    expect(m.desks.qa_lead).toEqual({ tx: 42, ty: 19 });
    expect(m.desks.qa_automation).toEqual({ tx: 38, ty: 22 });
    expect(m.desks.research_manager).toEqual({ tx: 19, ty: 32 });
    expect(m.desks.researcher).toEqual({ tx: 15, ty: 35 });
    expect(m.desks.dev_manager).toEqual({ tx: 32, ty: 32 });
    expect(m.desks.product_manager).toEqual({ tx: 29, ty: 32 });
    expect(m.desks.product_designer).toEqual({ tx: 35, ty: 32 });
    expect(m.desks.backend_engineer).toEqual({ tx: 28, ty: 35 });
    expect(m.desks.cso).toEqual({ tx: 44, ty: 32 });
    expect(m.desks.sales_1).toEqual({ tx: 40, ty: 35 });
    expect(m.desks.advisor_skeptic).toEqual({ tx: 30, ty: 45 });
    expect(m.desks.advisor_investor).toEqual({ tx: 32, ty: 45 });
    expect(m.desks.advisor_customer).toEqual({ tx: 34, ty: 45 });
  });
  it('has 16 rooms with a floor, ten surfaces, four portals, the shaft, the door', () => {
    expect(named('room').sort()).toEqual([...ROOM_IDS].sort());
    for (const r of ROOM_IDS) { const a = m.anchors[r]; expect(a.type, r).toBe('room'); expect(typeof a.props.floor, r).toBe('number'); expect(a.tw).toBeGreaterThan(1); expect(a.th).toBe(8); }
    expect(named('surface').sort()).toEqual([...SURFACE_IDS].sort());
    for (const s of SURFACE_IDS) expect(m.anchors[s].th, s).toBe(3);
    expect(named('portal')).toEqual(['elevator_1', 'elevator_2', 'elevator_3', 'elevator_4']);
    expect(m.anchors.elevator_1).toMatchObject({ tx: 50, ty: 52 }); expect(m.anchors.elevator_4).toMatchObject({ tx: 50, ty: 13 });
    expect(m.anchors.shaft).toMatchObject({ tx: 51, ty: 3, tw: 3, th: 51 });
    expect(m.anchors.door).toMatchObject({ tx: 46, ty: 54, tw: 2, th: 1 });
    expect(objs.every((o) => typeof prop(o, 'floor') === 'number')).toBe(true);
  });
  it('seats: boardroom 6, meetingroom 8, pantry 8; the owner chair is a reserved seat', () => {
    expect(m.seats.boardroom).toHaveLength(6); expect(m.seats.meetingroom).toHaveLength(8); expect(m.seats.pantry).toHaveLength(8);
    const owner = objs.find((o) => o.name === 'owner_chair')!;
    expect(owner.type).toBe('seat'); expect(prop(owner, 'reserved')).toBe('owner'); expect(owner.x / 16).toBe(32); expect(owner.y / 16).toBe(47);
    expect(m.seats.boardroom).not.toContainEqual({ tx: 32, ty: 47 });   // the owner's own chair, at the table's near edge (R2-M9)
  });
  it('walkability: portals and entrance doors walkable, shaft and screens blocked, every chair, seat and stand walkable', () => {
    for (const ty of [13, 26, 39, 52]) { expect(m.grid[ty][50], `portal row ${ty}`).toBe(0); expect(m.grid[ty][51], `shaft row ${ty}`).toBe(1); }
    expect(m.grid[54][46]).toBe(0); expect(m.grid[54][47]).toBe(0); expect(m.grid[54][45]).toBe(1);
    expect(m.grid[42][30]).toBe(1); // whiteboard SCREEN tile
    for (const d of built.desks) expect(m.grid[d.y][d.x], `chair ${d.id}`).toBe(0);
    for (const list of Object.values(m.seats)) for (const s of list) expect(m.grid[s.ty][s.tx]).toBe(0);
    for (const s of [...SURFACE_IDS, ...ROOM_IDS, 'door']) { const a = m.anchors[s]; expect(m.grid[Number(a.props.stand_y)][Number(a.props.stand_x)], `stand ${s}`).toBe(0); }
    expect(cxOf(TOWER.floors[0].rooms[2])).toBe(32); // boardroom
  });
  it("a member desk never overwrites the room's own wall column: research's and sales's first member desk has no left half", () => {
    const walls = built.map.layers.find((l) => l.name === 'walls')!.data!;
    const at = (x: number, y: number) => walls[y * W + x];
    expect(at(14, 34)).toBe(T.GLASS_V); // research.x0, shared with chro_office's glass partition — a wall column, not a desk
    expect(at(39, 34)).toBe(T.GLASS_V); // sales.x0, shared with dev's glass partition
    expect(m.desks.researcher).toEqual({ tx: 15, ty: 35 });
    expect(m.desks.sales_1).toEqual({ tx: 40, ty: 35 });
  });
  it('decor and sign layers exist with a sign per room', () => {
    expect(named('sign').sort()).toEqual(ROOM_IDS.map((r) => `sign_${r}`).sort());
    expect(named('decor').length).toBeGreaterThan(10);
    expect(new Set(objs.filter((o) => o.type === 'decor').map((o) => prop(o, 'kind')))).toEqual(new Set(['plant', 'lamp', 'coffee', 'cooler', 'monitor']));
    expect(built.map.tilesets[0].tilecount).toBeGreaterThanOrEqual(27);
  });
});
