import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SURFACES, registerSurface, chartBars, headlineFor, viewFor } from './surfaces.js';
import type { Ctx } from './content.js';
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
    for (const k of REGISTERED) { expect(anchors.has(k), `${k} is a surface object`).toBe(true); expect('anchorAdjust' in SURFACES[k], `${k} has no anchorAdjust`).toBe(false); }
  });

  it('registering a new surface needs no other change', () => {
    try {
      registerSurface({ kind: 'test', streamKind: 'markdown', streamId: () => 'x', headline: () => ({ head: 'h', lines: [] }), view: () => ({ mode: 'doc', title: 't', html: '' }) });
      expect(headlineFor('test', emptyState()).head).toBe('h');
      expect(viewFor('test', emptyState(), ctx).title).toBe('t');
    } finally {
      delete SURFACES.test;   // a failing assertion must not leak the fake entry into the next test
    }
  });

  it('a chart surface draws the bars its own entry supplies, not the bank quota', () => {
    const s = emptyState();
    s.quota = [{ provider: 'gemini', model: 'gemini-3.5-flash', rpm_used: 0, rpd_used: 7, tpm_used: 0, cooling_until: null, limits: { rpm: 0, rpd: 100, tpm: 0 } }];
    try {
      registerSurface({ kind: 'test', streamKind: 'chart', streamId: () => 'disk', bars: () => [{ label: 'disk', used: 3, limit: 4 }, { label: 'unmetered', used: 9, limit: 0 }], headline: () => ({ head: 'h', lines: [] }), view: () => ({ mode: 'doc', title: 't', html: '' }) });
      expect(chartBars(SURFACES.test, s, 7)).toEqual([{ label: 'disk', used: 3, limit: 4 }]);
      expect(chartBars(SURFACES.bank, s, 7)).toEqual([{ label: 'gemini-3.5-flash', used: 7, limit: 100 }]);
    } finally {
      delete SURFACES.test;
    }
  });

  it('each entry names the stream it is bound to', () => {
    for (const k of REGISTERED) {
      expect(SURFACES[k].kind, k).toBe(k);
      expect(typeof SURFACES[k].streamId(emptyState()), k).toBe('string');
    }
    expect(SURFACES.whiteboard.streamId(emptyState())).toBe('Plans/plan.md');
  });
});
