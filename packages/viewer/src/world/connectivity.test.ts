import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseMap, standTile, floorAt, type TiledMap, type Tile } from './map.js';
import { ROOM_IDS, SURFACE_IDS } from './tower.fixture.js';

const root = path.resolve(__dirname, '../../../..');
const m = parseMap(JSON.parse(readFileSync(path.join(root, 'packages/viewer/public/office.json'), 'utf8')) as TiledMap);

/** Tiles reachable from `start` by 4-neighbour moves over walkable tiles (stricter than EasyStar's diagonals). */
function reach(start: Tile): Set<string> {
  const key = (t: Tile) => `${t.tx},${t.ty}`;
  const seen = new Set<string>([key(start)]);
  const queue: Tile[] = [start];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { tx: t.tx + dx, ty: t.ty + dy };
      if (m.grid[n.ty]?.[n.tx] !== 0 || seen.has(key(n))) continue;
      seen.add(key(n)); queue.push(n);
    }
  }
  return seen;
}
const has = (set: Set<string>, t: Tile) => set.has(`${t.tx},${t.ty}`);

describe('every floor is one connected region reached from its elevator door', () => {
  for (const f of m.floors) {
    it(`floor ${f.n}: every desk chair, seat, surface stand and room stand is reachable; no other floor's portal is`, () => {
      const r = reach(f.portal);
      for (const [id, d] of Object.entries(m.deskInfo)) if (d.floor === f.n) expect(has(r, d.tile), `desk ${id}`).toBe(true);
      for (const [room, list] of Object.entries(m.seats)) if (Number(m.rooms[room].props.floor) === f.n) for (const s of list) expect(has(r, s), `seat in ${room}`).toBe(true);
      for (const s of SURFACE_IDS) if (Number(m.anchors[s].props.floor) === f.n) expect(has(r, standTile(m, s)!), `stand ${s}`).toBe(true);
      for (const room of ROOM_IDS) if (Number(m.rooms[room].props.floor) === f.n) expect(has(r, standTile(m, room)!), `room stand ${room}`).toBe(true);
      if (f.n === 1) expect(has(r, m.reserved.owner)).toBe(true);
      for (const g of m.floors) if (g.n !== f.n) expect(has(r, g.portal), `portal of floor ${g.n} from floor ${f.n}`).toBe(false);
      for (const t of r) { const ty = Number(t.split(',')[1]); if (ty < 55) expect(floorAt(m, ty), `tile ${t} reached from floor ${f.n}`).toBe(f.n); }
    });
  }
  it('the street door stand reaches the F1 elevator door and nothing above it', () => {
    const r = reach(standTile(m, 'door')!);
    expect(has(r, m.portals[1])).toBe(true);
    expect(has(r, m.portals[2])).toBe(false);
    expect(has(r, m.desks.ceo)).toBe(true);
  });
});
