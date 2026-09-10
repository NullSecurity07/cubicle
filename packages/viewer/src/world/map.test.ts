// packages/viewer/src/world/map.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMap, nearestWalkable, standTile, toPx, TILE, type TiledMap } from './map.js';
import { DESK_IDS, ROOM_IDS, SURFACE_IDS } from './tower.fixture.js';

const root = path.resolve(__dirname, '../../../..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
const served = JSON.parse(read('packages/viewer/public/office.json')) as Record<string, unknown>;
const generated = JSON.parse(read('config/world/office.json')) as Record<string, unknown>;

/** desks.yaml rows without a YAML parser: `- { id: x, x: 1, y: 2, room: r, floor: 1, slot: fixed }`. */
function deskRows(): { id: string; x: number; y: number; room: string; floor: number; slot: string }[] {
  return [...read('config/world/desks.yaml').matchAll(/^\s*-\s*\{\s*id:\s*(\w+),\s*x:\s*(\d+),\s*y:\s*(\d+),\s*room:\s*(\w+),\s*floor:\s*(\d),\s*slot:\s*(\w+)\s*\}/gm)]
    .map((m) => ({ id: m[1], x: Number(m[2]), y: Number(m[3]), room: m[4], floor: Number(m[5]), slot: m[6] }));
}

describe('generated office artifacts', () => {
  // Regenerating into a temp directory is what makes this catch a stale commit: the generator is the source of
  // truth, so the committed bytes (both JSON copies and desks.yaml) are compared against a fresh run.
  it('all three committed artifacts equal what the generator writes today', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-world-'));
    try {
      execFileSync(process.execPath, ['--import', 'tsx/esm', path.join(root, 'scripts/gen-world.ts'), '--out', dir], { cwd: root, stdio: 'pipe' });
      const fresh = JSON.parse(readFileSync(path.join(dir, 'packages/viewer/public/office.json'), 'utf8'));
      expect(served).toEqual(fresh);
      expect(generated).toEqual(fresh);
      expect(read('config/world/desks.yaml')).toBe(readFileSync(path.join(dir, 'config/world/desks.yaml'), 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
  it('desks.yaml has the 38 desks with room, floor and slot, matching the desk objects', () => {
    const rows = deskRows();
    expect(rows.map((r) => r.id)).toEqual(DESK_IDS);
    const m = parseMap(served as unknown as TiledMap);
    for (const r of rows) { expect(m.desks[r.id], r.id).toEqual({ tx: r.x, ty: r.y }); expect(m.anchors[r.id].props, r.id).toMatchObject({ room: r.room, floor: r.floor, slot: r.slot }); }
    expect(rows.filter((r) => r.slot === 'member')).toHaveLength(22);
    expect(rows.filter((r) => r.slot === 'fixed')).toHaveLength(16);
  });
});

describe('parseMap (no Phaser)', () => {
  const m = parseMap(served as unknown as TiledMap);

  it('reads the tower dimensions and a collision grid where doors, elevator doors and chairs stay walkable', () => {
    expect(m.width).toBe(60); expect(m.height).toBe(64);
    expect(m.grid).toHaveLength(64); expect(m.grid[0]).toHaveLength(60);
    expect(m.grid[54][46]).toBe(0); expect(m.grid[54][45]).toBe(1);   // entrance door vs the wall beside it
    expect(m.grid[52][50]).toBe(0); expect(m.grid[52][51]).toBe(1);   // F1 elevator door vs the shaft
    expect(m.grid[46][9]).toBe(0); expect(m.grid[45][9]).toBe(1);     // the CEO's chair vs the desk
    expect(m.grid[10][2]).toBe(1); expect(m.grid[1][30]).toBe(1);     // sky beside and above the building blocks
    expect(m.grid[56][2]).toBe(0);                                    // the street does not
    expect(m.anchors.door).toBeDefined();
  });
  it('has the 38 desks, 16 rooms with a floor, the ten surfaces and every anchor the viewer walks to', () => {
    expect(Object.keys(m.desks).sort()).toEqual([...DESK_IDS].sort());
    for (const r of ROOM_IDS) { expect(m.anchors[r]?.type, r).toBe('room'); expect(typeof m.anchors[r].props.floor, r).toBe('number'); }
    for (const s of [...SURFACE_IDS, 'door', 'shaft', 'elevator_1', 'elevator_2', 'elevator_3', 'elevator_4']) expect(m.anchors[s], s).toBeDefined();
    expect(m.seats.boardroom).toHaveLength(6); expect(m.seats.meetingroom).toHaveLength(8); expect(m.seats.pantry).toHaveLength(8);
    expect(m.anchors.kitchen).toBeUndefined();
  });
  it('nearestWalkable keeps a walkable tile and steps off a wall', () => {
    const floor = { tx: 20, ty: 52 };
    expect(m.grid[floor.ty][floor.tx]).toBe(0);
    expect(nearestWalkable(m.grid, floor)).toEqual(floor);
    const wall = { tx: 4, ty: 45 };
    expect(m.grid[wall.ty][wall.tx]).toBe(1);
    const off = nearestWalkable(m.grid, wall)!;
    expect(off).not.toEqual(wall); expect(m.grid[off.ty][off.tx]).toBe(0);
    expect(nearestWalkable([[1]], { tx: 0, ty: 0 })).toBeNull();
  });
  it('standTile returns the tile in front of a surface, a desk by desk id, a room stand, and null for nothing', () => {
    expect(standTile(m, 'billboard')).toEqual({ tx: 18, ty: 4 });
    expect(standTile(m, 'desk:qa_lead')).toEqual(m.desks.qa_lead);
    expect(standTile(m, 'boardroom')).toEqual({ tx: 32, ty: 49 });
    expect(standTile(m, 'pantry')).toEqual({ tx: 44, ty: 43 });
    expect(standTile(m, 'door')).toEqual({ tx: 47, ty: 55 });
    expect(standTile(m, 'nowhere')).toBeNull();
  });
  it('toPx centres a tile', () => { expect(toPx({ tx: 2, ty: 3 })).toEqual({ x: 2 * TILE + TILE / 2, y: 3 * TILE + TILE / 2 }); });
});
