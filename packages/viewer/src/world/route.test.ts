import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseMap, standTile, type TiledMap } from './map.js';
import { planRoute } from './route.js';

const root = path.resolve(__dirname, '../../../..');
const m = parseMap(JSON.parse(readFileSync(path.join(root, 'packages/viewer/public/office.json'), 'utf8')) as TiledMap);

describe('planRoute', () => {
  it('same floor is one walk leg', () => {
    expect(planRoute(m, m.desks.ceo, m.desks.advisor_skeptic)).toEqual([{ kind: 'walk', to: m.desks.advisor_skeptic }]);
    expect(planRoute(m, standTile(m, 'door')!, m.desks.ceo)).toEqual([{ kind: 'walk', to: m.desks.ceo }]);   // the street counts as F1
  });
  it('another floor is walk → portal, ride, walk → target', () => {
    const legs = planRoute(m, m.desks.coo, m.desks.backend_engineer);
    expect(legs).toEqual([
      { kind: 'walk', to: { tx: 50, ty: 13 } },
      { kind: 'ride', from: 4, to: 2 },
      { kind: 'walk', to: m.desks.backend_engineer },
    ]);
    expect(planRoute(m, m.desks.qa_lead, standTile(m, 'pantry')!)[1]).toEqual({ kind: 'ride', from: 3, to: 1 });
  });
});
