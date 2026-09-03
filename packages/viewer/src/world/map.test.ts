import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
