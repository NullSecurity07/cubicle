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

describe('the whiteboard panel shows the pressure test as its own line', () => {
  it('labels it, and keeps the flaws as the bullets', () => {
    const s = { ...emptyState(), now: Date.parse('2026-09-12T09:00:01.000Z'), plan: '# Plan', board: { id: 'm1', subject: 'idea' as const, title: 'Meal kits', verdict: 'return' as const, findings: ['the payer is not the user'], pressure: 'PIVOT REQUIRED', rubric: '7/10 — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1', at: '2026-09-12T09:00:00.000Z' } };
    const html = SURFACES.whiteboard.view(s, ctx).html;
    expect(html).toContain('Pressure test: PIVOT REQUIRED · rubric 7/10');
    expect(html).toContain('<li>the payer is not the user</li>');
    // The rubric appears once, as a labelled line — not also as a bullet among the flaws.
    expect(html.match(/7\/10/g)).toHaveLength(1);
  });

  it('a plan pre-mortem shows no pressure-test line at all', () => {
    const s = { ...emptyState(), now: Date.parse('2026-09-12T09:00:01.000Z'), plan: '# Plan', board: { id: 'm2', subject: 'plan' as const, title: "this cycle's plan", verdict: 'pass' as const, findings: ['watch the free tier'], pressure: '', rubric: '', at: '2026-09-12T09:00:00.000Z' } };
    const html = SURFACES.whiteboard.view(s, ctx).html;
    expect(html).not.toContain('Pressure test');
    expect(html).toContain('<li>watch the free tier</li>');
  });
});

describe('the whiteboard panel is a panel, not the wall', () => {
  const at = '2026-09-12T09:00:00.000Z';
  const now = Date.parse('2026-09-12T09:00:01.000Z');

  it('an open session still names what the board is sitting on', () => {
    // The title is the one thing the panel shows while the board sits, and it carries no bullet marker.
    const s = { ...emptyState(), now, plan: '# Plan', board: { id: 'm1', subject: 'idea' as const, title: 'Meal kits for nurseries', verdict: null, findings: [], pressure: '', rubric: '', at } };
    const html = SURFACES.whiteboard.view(s, ctx).html;
    expect(html).toContain('The board is sitting');
    expect(html).toContain('<li>Meal kits for nurseries</li>');
  });

  it('shows every flaw the board raised, even when the wall had room for two', () => {
    // `boardHeadline` spends one of its three lines on the verdict word; the panel writes that line itself and
    // must not inherit the wall's budget, or the third flaw would silently fall off.
    const findings = ['the payer is not the user', 'no van before 7am', 'the margin is 4%'];
    const s = { ...emptyState(), now, plan: '# Plan', board: { id: 'm1', subject: 'idea' as const, title: 'Meal kits', verdict: 'return' as const, findings, pressure: 'PIVOT REQUIRED', rubric: '7/10', at } };
    const html = SURFACES.whiteboard.view(s, ctx).html;
    for (const f of findings) expect(html, f).toContain(`<li>${f}</li>`);
    expect(html).toContain('Pressure test: PIVOT REQUIRED · rubric 7/10');
  });

  it('shows a flaw in full, where the wall clips it to forty characters', () => {
    const long = 'nobody has priced the delivery van, the driver or the 6am shift that the whole margin depends on';
    const s = { ...emptyState(), now, plan: '# Plan', board: { id: 'm1', subject: 'plan' as const, title: "this cycle's plan", verdict: 'pass' as const, findings: [long], pressure: '', rubric: '', at } };
    expect(SURFACES.whiteboard.view(s, ctx).html).toContain(`<li>${long}</li>`);
  });
});
