import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SURFACES, registerSurface } from './surface-registry.js';
import { headlineFor } from './headlines.js';
import { viewFor, type Ctx } from '../ui/content.js';
import { emptyState } from '../state.js';

/** Captured before the registration test adds one, so the two tests do not depend on their order. */
const REGISTERED = Object.keys(SURFACES);
const ctx: Ctx = { frames: {}, tokenQuery: '', vaultName: '' };

interface TiledObject { name: string; type: string }
const map = JSON.parse(readFileSync(path.resolve(__dirname, '../../public/office.json'), 'utf8')) as { layers: { type: string; objects?: TiledObject[] }[] };
const objects = map.layers.filter((l) => l.type === 'objectgroup').flatMap((l) => l.objects ?? []);
const namesOfType = (type: string): Set<string> => new Set(objects.filter((o) => o.type === type).map((o) => o.name));

describe('surface registry', () => {
  it('every surface anchor in the map has a registry entry and vice versa', () => {
    const anchors = namesOfType('surface');
    expect(anchors.size).toBeGreaterThan(0);
    for (const a of anchors) expect(SURFACES[a], a).toBeDefined();
    const placeable = new Set([...anchors, ...namesOfType('room')]);
    for (const k of REGISTERED) expect(placeable.has(k), k).toBe(true);
  });

  it('registering a new surface needs no other change', () => {
    registerSurface({ kind: 'test', streamKind: 'markdown', streamId: () => 'x', headline: () => ({ head: 'h', lines: [] }), view: () => ({ mode: 'doc', title: 't', html: '' }) });
    expect(headlineFor('test', emptyState()).head).toBe('h');
    expect(viewFor('test', emptyState(), ctx).title).toBe('t');
    delete SURFACES.test;
  });

  it('each entry names the stream it is bound to', () => {
    for (const k of REGISTERED) {
      expect(SURFACES[k].kind, k).toBe(k);
      expect(typeof SURFACES[k].streamId(emptyState()), k).toBe('string');
    }
    expect(SURFACES.whiteboard.streamId(emptyState())).toBe('Plans/plan.md');
  });
});
