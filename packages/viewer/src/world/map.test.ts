import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseMap, nearestWalkable, standTile, toPx, TILE, type TiledMap } from './map.js';

const root = path.resolve(__dirname, '../../../..');
const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(root, p), 'utf8'));

const served = readJson('packages/viewer/public/office.json');
const generated = readJson('config/world/office.json');

/** desks.yaml is a flat list of `{ id: <name>, ... }` entries; read the ids without pulling in a YAML parser. */
function deskIds(): string[] {
  const text = readFileSync(path.join(root, 'config/world/desks.yaml'), 'utf8');
  return [...text.matchAll(/^\s*-?\s*\{?\s*id:\s*([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
}

interface TiledObject { name: string; type: string }
function objectNamesOfType(map: Record<string, unknown>, type: string): Set<string> {
  const layers = map.layers as { type: string; objects?: TiledObject[] }[];
  const objs = layers.filter((l) => l.type === 'objectgroup').flatMap((l) => l.objects ?? []);
  return new Set(objs.filter((o) => o.type === type).map((o) => o.name));
}

describe('office map', () => {
  it('serves the same map the generator writes', () => {
    expect(served).toEqual(generated);
  });
  it('has a desk object for every desk in desks.yaml', () => {
    const names = objectNamesOfType(served, 'desk');
    const ids = deskIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(names.has(id), id).toBe(true);
  });
});

describe('parseMap (no Phaser)', () => {
  const m = parseMap(served as unknown as TiledMap);

  it('reads the office dimensions and a collision grid where doors and chairs stay walkable', () => {
    expect(m.width).toBe(72); expect(m.height).toBe(44);
    expect(m.grid).toHaveLength(m.height);
    expect(m.grid[0]).toHaveLength(m.width);
    const door = m.anchors.door;                       // the entrance is walkable, the wall beside it is not
    expect(m.grid[30][24]).toBe(0);
    expect(m.grid[30][23]).toBe(1);
    expect(door).toBeDefined();
  });

  it('has a desk for all 12 cubicles plus the CEO cabin', () => {
    for (let i = 1; i <= 12; i++) expect(m.desks[`cubicle_${i}`], `cubicle_${i}`).toBeDefined();
    expect(m.desks.ceo_cabin).toBeDefined();
    expect(Object.keys(m.desks)).toHaveLength(13);
  });

  it('has room rectangles and every named anchor the viewer walks to', () => {
    for (const r of ['cabin', 'boardroom', 'meetingroom']) { expect(m.anchors[r]?.type, r).toBe('room'); expect(m.anchors[r].tw).toBeGreaterThan(1); expect(m.anchors[r].th).toBeGreaterThan(1); }
    for (const a of ['door', 'billboard', 'terminal', 'postoffice', 'newsstand', 'bank', 'vault', 'workshop', 'noticeboard', 'kitchen']) expect(m.anchors[a], a).toBeDefined();
    expect(m.seats.boardroom).toHaveLength(10);
    expect(m.seats.meetingroom).toHaveLength(8);
  });

  it('nearestWalkable keeps a walkable tile and steps off a wall', () => {
    const floor = { tx: 24, ty: 29 };
    expect(m.grid[floor.ty][floor.tx]).toBe(0);
    expect(nearestWalkable(m.grid, floor)).toEqual(floor);
    const wall = { tx: 4, ty: 4 };
    expect(m.grid[wall.ty][wall.tx]).toBe(1);
    const off = nearestWalkable(m.grid, wall)!;
    expect(off).not.toEqual(wall);
    expect(m.grid[off.ty][off.tx]).toBe(0);
    expect(nearestWalkable([[1]], { tx: 0, ty: 0 })).toBeNull();
  });

  it('standTile returns the tile in front of a surface, a desk by role, and null for nothing', () => {
    expect(standTile(m, 'billboard')).toEqual({ tx: Number(m.anchors.billboard.props.stand_x), ty: Number(m.anchors.billboard.props.stand_y) });
    expect(standTile(m, 'desk:cubicle_9')).toEqual(m.desks.cubicle_9);
    expect(standTile(m, 'boardroom')).toEqual({ tx: m.anchors.boardroom.tx + Math.floor(m.anchors.boardroom.tw / 2), ty: m.anchors.boardroom.ty + m.anchors.boardroom.th });
    expect(standTile(m, 'nowhere')).toBeNull();
  });

  it('toPx centres a tile', () => { expect(toPx({ tx: 2, ty: 3 })).toEqual({ x: 2 * TILE + TILE / 2, y: 3 * TILE + TILE / 2 }); });
});
