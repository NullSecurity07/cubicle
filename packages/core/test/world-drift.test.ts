/**
 * The three generated world files must match what `scripts/world/campus.ts` builds today.
 *
 * `gen-world.ts` has promised since it was written that "they must not drift", and nothing ran the comparison:
 * a spec edit that was never regenerated, or a hand edit of `office.json`, would have shipped an office the
 * daemon and the viewer disagreed about — the daemon reads `config/world/desks.yaml` for desks, the viewer
 * serves its own copy of `office.json`, and the generator is the only thing that keeps the three in step.
 *
 * Compared as text, not as parsed objects: the checked-in files are what is served and read, so key order and
 * number formatting are part of the contract. The fix when this fails is one command:
 *   node --import tsx/esm --conditions=development scripts/gen-world.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildCampus, desksYaml } from '../../../scripts/world/campus.js';
import { repoRoot } from '../src/template.js';

const read = (rel: string): string => readFileSync(path.join(repoRoot(), rel), 'utf8');

describe('generated world files', () => {
  const { map, desks } = buildCampus();
  const json = JSON.stringify(map);

  it('config/world/office.json is what the generator builds', () => {
    expect(read('config/world/office.json')).toBe(json);
  });

  it("packages/viewer/public/office.json is the same copy", () => {
    expect(read('packages/viewer/public/office.json')).toBe(json);
  });

  it('config/world/desks.yaml is what the generator builds', () => {
    expect(read('config/world/desks.yaml')).toBe(desksYaml(desks));
  });

  it('every desk row names a desk object on the map', () => {
    const ids = new Set(map.layers.flatMap((l) => l.objects ?? []).filter((o) => o.type === 'desk').map((o) => o.name));
    expect(desks.map((d) => d.id).filter((id) => !ids.has(id))).toEqual([]);
  });
});
