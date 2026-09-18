import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCampus, walkable, type CampusMap } from './campus.js';
import {
  type CampusLayout, MIN_ZONE, RESOURCE_SIZE, anchorOf, applyLayout, asLayout, connected, connectionKind, edgeEnds,
  edgeId, emptyLayout, labelOfNode, liveConnections, nextResourceId, occupiedBy, removeNode, resourceRect, snap,
  snapPt, withConnection, withNode, withoutConnection,
} from './layout.js';

const MAP: CampusMap = parseCampus(JSON.parse(readFileSync(fileURLToPath(new URL('../../../../config/world/office.json', import.meta.url)), 'utf8')));
const layout = (over: Partial<CampusLayout>): CampusLayout => ({ ...emptyLayout(), ...over });

describe('the campus parser gives every prop a readable id', () => {
  it('numbers each kind from 1 in map order', () => {
    const plants = MAP.props.filter((p) => p.kind === 'plant');
    expect(plants.length).toBeGreaterThan(5);
    expect(plants.map((p) => p.id).slice(0, 3)).toEqual(['plant_1', 'plant_2', 'plant_3']);
    expect(new Set(MAP.props.map((p) => p.id)).size).toBe(MAP.props.length);
  });
  it('starts with no resources at all', () => { expect(MAP.resources).toEqual({}); });
});

describe('applyLayout', () => {
  it('is the identity on an empty note', () => { expect(applyLayout(MAP, emptyLayout())).toBe(MAP); });

  it('moves a desk, its seat and its footprint together', () => {
    const before = MAP.desks.cto;
    const dx = 2, dy = -1.5;
    const m = applyLayout(MAP, layout({ nodes: { cto: { x: before.rect.x0 + dx, y: before.rect.y0 + dy } } }));
    const after = m.desks.cto;
    expect(after.rect.x0).toBeCloseTo(before.rect.x0 + dx);
    expect(after.rect.y1).toBeCloseTo(before.rect.y1 + dy);
    expect(after.rect.x1 - after.rect.x0).toBeCloseTo(before.rect.x1 - before.rect.x0);
    expect(after.seat.x).toBeCloseTo(before.seat.x + dx);
    expect(after.seat.y).toBeCloseTo(before.seat.y + dy);
    // the base map is untouched
    expect(MAP.desks.cto.rect.x0).toBe(before.rect.x0);
  });

  it('keeps the desk on its own division when it moves', () => {
    const m = applyLayout(MAP, layout({ nodes: { cto: { x: 20, y: 20 } } }));
    expect(m.desks.cto.accent).toBe(MAP.desks.cto.accent);
    expect(m.desks.cto.zone).toBe(MAP.desks.cto.zone);
  });

  it('takes a removed desk and a removed prop off the campus', () => {
    const m = applyLayout(MAP, layout({ nodes: { cto: { removed: true }, plant_1: { removed: true } } }));
    expect(m.desks.cto).toBeUndefined();
    expect(m.props.some((p) => p.id === 'plant_1')).toBe(false);
    expect(m.props.length).toBe(MAP.props.length - 1);
  });

  it('moves and resizes a zone, and carries its stand point with it', () => {
    const z = MAP.zoneById.sales;
    const m = applyLayout(MAP, layout({ nodes: { sales: { x: z.rect.x0 + 1, y: z.rect.y0, w: 14, d: 10 } } }));
    expect(m.zoneById.sales.rect).toEqual({ x0: z.rect.x0 + 1, y0: z.rect.y0, x1: z.rect.x0 + 1 + 14, y1: z.rect.y0 + 10 });
    expect(m.zoneById.sales.stand.x).toBeCloseTo(z.stand.x + 1);
    // the zone list and the rail hand back the same objects, so the rail cannot show a stale rectangle
    expect(m.zones.find((q) => q.id === 'sales')).toBe(m.zoneById.sales);
    expect(m.rail.find((q) => q.id === 'sales')).toBe(m.zoneById.sales);
  });

  it('will not let a zone be dragged smaller than the handles', () => {
    const m = applyLayout(MAP, layout({ nodes: { sales: { w: 0.2, d: -4 } } }));
    const r = m.zoneById.sales.rect;
    expect(r.x1 - r.x0).toBe(MIN_ZONE);
    expect(r.y1 - r.y0).toBe(MIN_ZONE);
  });

  it('adds what the owner put down, centred on the point they dropped it', () => {
    const m = applyLayout(MAP, layout({ nodes: { browser_1: { kind: 'browser', x: 22.5, y: 14, zone: 'qa' } } }));
    const r = m.resources.browser_1;
    expect(r.kind).toBe('browser');
    expect(r.at).toEqual({ x: 22.5, y: 14 });
    expect(r.rect.x1 - r.rect.x0).toBeCloseTo(RESOURCE_SIZE.browser.w);
    expect((r.rect.x0 + r.rect.x1) / 2).toBeCloseTo(22.5);
    expect(r.zone).toBe('qa');
    expect(r.label).toBe('Browser');
  });

  it('reads the zone off the floor when the note does not say', () => {
    const sales = MAP.zoneById.sales.rect;
    const m = applyLayout(MAP, layout({ nodes: { note_1: { kind: 'note', x: (sales.x0 + sales.x1) / 2, y: (sales.y0 + sales.y1) / 2 } } }));
    expect(m.resources.note_1.zone).toBe('sales');
    expect(m.resources.note_1.accent).toBe('amber');
  });

  it('names a document after its note and a sticky after its first line', () => {
    expect(labelOfNode('doc', { path: 'Plans/plan.md' })).toBe('plan');
    expect(labelOfNode('note', { body: 'Ask CFO about runway\nand the burn' })).toBe('Ask CFO about runway');
    expect(labelOfNode('station', { tool: 'email' })).toBe('Email');
    expect(labelOfNode('note', { label: 'Mine' })).toBe('Mine');
    expect(labelOfNode('site', {})).toBe('Site');
  });

  it('skips the lines it cannot make sense of and keeps the rest', () => {
    const m = applyLayout(MAP, layout({
      nodes: {
        nobody_at_all: { x: 4, y: 4 },                       // names nothing
        half: { kind: 'note', x: 4 },                         // no y
        bare: { kind: 'station', x: 10, y: 10 },              // a station with no tool
        wrong: { kind: 'teleporter' as never, x: 10, y: 10 }, // not a kind we have
        note_9: { kind: 'note', x: 20, y: 20 },               // good
      },
    }));
    expect(Object.keys(m.resources)).toEqual(['note_9']);
  });

  it('makes a station of a tool family, with its own id', () => {
    const m = applyLayout(MAP, layout({ nodes: { station_email: { kind: 'station', tool: 'email', x: 44, y: 24 } } }));
    expect(m.resources.station_email.tool).toBe('email');
    expect(m.resources.station_email.label).toBe('Email');
    expect(nextResourceId(emptyLayout(), 'station', 'deploy')).toBe('station_deploy');
  });

  it('blocks the floor under what it adds and frees the floor a desk left', () => {
    const d = MAP.desks.cto;
    const inside = { x: (d.rect.x0 + d.rect.x1) / 2, y: (d.rect.y0 + d.rect.y1) / 2 };
    expect(walkable(MAP.grid, Math.floor(inside.x * MAP.walk), Math.floor(inside.y * MAP.walk))).toBe(false);
    const m = applyLayout(MAP, layout({ nodes: { cto: { removed: true } } }));
    expect(walkable(m.grid, Math.floor(inside.x * MAP.walk), Math.floor(inside.y * MAP.walk))).toBe(true);
    expect(MAP.grid[Math.floor(inside.y * MAP.walk)][Math.floor(inside.x * MAP.walk)]).toBe(1);   // the base is untouched

    // a kiosk dropped on an open walkway makes that walkway impassable
    const open = { x: 24, y: 21 };
    const gx = Math.floor(open.x * MAP.walk), gy = Math.floor(open.y * MAP.walk);
    expect(walkable(MAP.grid, gx, gy)).toBe(true);
    const k = applyLayout(MAP, layout({ nodes: { browser_1: { kind: 'browser', x: open.x, y: open.y } } }));
    expect(walkable(k.grid, gx, gy)).toBe(false);
  });

  it('does not unblock the cell a desk moved one step onto', () => {
    const d = MAP.desks.cto;
    const m = applyLayout(MAP, layout({ nodes: { cto: { x: d.rect.x0 + 0.5, y: d.rect.y0 } } }));
    const mid = { x: (m.desks.cto.rect.x0 + m.desks.cto.rect.x1) / 2, y: (m.desks.cto.rect.y0 + m.desks.cto.rect.y1) / 2 };
    expect(walkable(m.grid, Math.floor(mid.x * m.walk), Math.floor(mid.y * m.walk))).toBe(false);
  });
});

describe('asLayout', () => {
  it('keeps the shape and drops everything else', () => {
    const l = asLayout({ version: 1, nodes: { a: { x: 1 }, b: 'nope' }, connections: [{ from: 'a', to: 'b', kind: 'peer' }, { from: 'a', kind: 'peer' }, 7, { from: 'a', to: 'b', kind: 'friend' }] });
    expect(l.nodes).toEqual({ a: { x: 1 } });
    expect(l.connections).toEqual([{ from: 'a', to: 'b', kind: 'peer' }]);
  });
  it('makes an empty layout out of nothing at all', () => {
    expect(asLayout(undefined)).toEqual(emptyLayout());
    expect(asLayout(null).connections).toEqual([]);
  });
});

describe('anchors and hit geometry', () => {
  it('finds a desk, a zone, a prop and a resource, and nothing else', () => {
    const m = applyLayout(MAP, layout({ nodes: { note_1: { kind: 'note', x: 20, y: 20 } } }));
    expect(anchorOf(m, 'cto')?.kind).toBe('desk');
    expect(anchorOf(m, 'sales')?.kind).toBe('zone');
    expect(anchorOf(m, 'plant_1')?.kind).toBe('prop');
    expect(anchorOf(m, 'note_1')?.kind).toBe('resource');
    expect(anchorOf(m, 'nothing')).toBeNull();
  });
  it('snaps to half a cell', () => {
    expect(snap(3.2)).toBe(3);
    expect(snap(3.3)).toBe(3.5);
    expect(snap(-0.26)).toBe(-0.5);
    expect(snapPt({ x: 3.26, y: 9.76 })).toEqual({ x: 3.5, y: 10 });
    expect(snapPt({ x: 3.26, y: 9.74 })).toEqual({ x: 3.5, y: 9.5 });
  });
  it('calls a spot taken when a desk, a resource or the wall is in it', () => {
    const d = MAP.desks.cto;
    expect(occupiedBy(MAP, d.rect)).toBe('cto');
    expect(occupiedBy(MAP, d.rect, 'cto')).toBeNull();
    expect(occupiedBy(MAP, { x0: -2, y0: 4, x1: 0, y1: 5 })).toBe('the wall');
    expect(occupiedBy(MAP, { x0: MAP.width - 0.5, y0: 4, x1: MAP.width + 2, y1: 5 })).toBe('the wall');
    const m = applyLayout(MAP, layout({ nodes: { note_1: { kind: 'note', x: 24, y: 21 } } }));
    expect(occupiedBy(m, resourceRect('browser', { x: 24, y: 21 }))).toBe('note_1');
    expect(occupiedBy(m, resourceRect('browser', { x: 24, y: 21 }), 'note_1')).toBeNull();
  });
});

describe('connections', () => {
  const m = applyLayout(MAP, layout({ nodes: { browser_1: { kind: 'browser', x: 22.5, y: 14 } } }));
  it('knows what a line between two things would mean', () => {
    expect(connectionKind(m, 'cto', 'backend_engineer')).toBe('peer');
    expect(connectionKind(m, 'cto', 'browser_1')).toBe('access');
    expect(connectionKind(m, 'browser_1', 'cto')).toBe('access');
    expect(connectionKind(m, 'cto', 'cto')).toBeNull();
    expect(connectionKind(m, 'sales', 'cto')).toBeNull();          // a zone is not wired to anything
    expect(connectionKind(m, 'browser_1', 'browser_1')).toBeNull();
  });
  it('adds a line once, in either direction, with the desk as the from of an access', () => {
    let l = withConnection(emptyLayout(), m, 'cto', 'backend_engineer');
    expect(l.connections).toEqual([{ from: 'cto', to: 'backend_engineer', kind: 'peer' }]);
    expect(withConnection(l, m, 'backend_engineer', 'cto')).toBe(l);
    l = withConnection(l, m, 'browser_1', 'cto');
    expect(l.connections[1]).toEqual({ from: 'cto', to: 'browser_1', kind: 'access' });
    expect(withConnection(l, m, 'sales', 'cto')).toBe(l);
  });
  it('reads a line in either direction and cuts it from either end', () => {
    const l = withConnection(emptyLayout(), m, 'cto', 'backend_engineer');
    expect(connected(l, 'backend_engineer', 'cto')).toBe(true);
    expect(withoutConnection(l, 'backend_engineer', 'cto').connections).toEqual([]);
    expect(withoutConnection(l, 'cto', 'ceo')).toBe(l);
  });
  it('draws only the lines whose two ends are still there, once each', () => {
    const l = layout({ connections: [
      { from: 'cto', to: 'backend_engineer', kind: 'peer' },
      { from: 'backend_engineer', to: 'cto', kind: 'peer' },
      { from: 'cto', to: 'a_ghost', kind: 'peer' },
    ] });
    expect(liveConnections(m, l)).toEqual([{ from: 'cto', to: 'backend_engineer', kind: 'peer' }]);
  });
  it('gives a line one id from either end', () => {
    expect(edgeId('cto', 'ceo')).toBe(edgeId('ceo', 'cto'));
    expect(edgeEnds(edgeId('cto', 'ceo'))).toEqual(['ceo', 'cto']);
    expect(edgeEnds('cto')).toBeNull();
  });
});

describe('writing the note', () => {
  const m = applyLayout(MAP, layout({ nodes: { note_1: { kind: 'note', x: 20, y: 20 } } }));
  it('merges a patch and clears an override outright', () => {
    const l = withNode(withNode(emptyLayout(), 'cto', { x: 4 }), 'cto', { y: 5 });
    expect(l.nodes.cto).toEqual({ x: 4, y: 5 });
    expect(withNode(l, 'cto', null).nodes.cto).toBeUndefined();
  });
  it('marks a template desk away but deletes a thing the owner added', () => {
    const l = layout({ nodes: { note_1: { kind: 'note', x: 20, y: 20 } }, connections: [{ from: 'cto', to: 'note_1', kind: 'access' }, { from: 'cto', to: 'ceo', kind: 'peer' }] });
    const gone = removeNode(l, m, 'note_1');
    expect(gone.nodes.note_1).toBeUndefined();
    expect(gone.connections).toEqual([{ from: 'cto', to: 'ceo', kind: 'peer' }]);
    expect(removeNode(l, m, 'cto').nodes.cto).toEqual({ removed: true });
    expect(removeNode(l, m, 'cto').connections).toEqual([]);
  });
  it('picks the next free id of a kind', () => {
    expect(nextResourceId(emptyLayout(), 'note')).toBe('note_1');
    expect(nextResourceId(layout({ nodes: { note_1: {}, note_2: {} } }), 'note')).toBe('note_3');
  });
});
