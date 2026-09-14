import { describe, it, expect } from 'vitest';
import { railHtml, deepen, deepChanges, type ZoneInfo } from './rail.js';
import { contrastRatio } from './tokens.js';
import { ZONE_TINT, zoneTint } from '../world/palette.js';

const summary: ZoneInfo[] = [
  { id: 'boardroom', label: 'Executive', accent: 'slate', color: zoneTint('boardroom'), agents: [{ role: 'ceo', color: '#6B788F', state: 'working' }], meetings: 1 },
  { id: 'pantry', label: 'Pantry', accent: 'neutral', color: zoneTint('pantry'), agents: [], meetings: 0 },
  { id: 'dev', label: 'Dev', accent: 'indigo', color: zoneTint('dev'), agents: [
    { role: 'a', color: '#111111', state: 'working' }, { role: 'b', color: '#222222', state: 'talking' },
    { role: 'c', color: '#333333', state: 'walking' }, { role: 'd', color: '#444444', state: 'working' },
    { role: 'e', color: '#555555', state: 'idle_at_desk' },
  ], meetings: 0 },
  { id: 'qa', label: 'QA', accent: 'indigo', color: zoneTint('qa'), agents: [], meetings: 0 },
  { id: 'research', label: 'Research', accent: 'indigo', color: zoneTint('research'), agents: [], meetings: 0 },
  { id: 'sales', label: 'Sales', accent: 'amber', color: zoneTint('sales'), agents: [], meetings: 0 },
  { id: 'ops', label: 'Ops', accent: 'sage', color: zoneTint('ops'), agents: [], meetings: 0 },
];

describe('the zone rail', () => {
  it('puts Campus first, then the seven zones in the spec’s order, and marks the current one', () => {
    const html = railHtml(summary, 'dev', { ops: ['Operations'], dev: ['Technology'] });
    const order = [...html.matchAll(/data-zone="([a-z_]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['campus', 'boardroom', 'pantry', 'dev', 'qa', 'research', 'sales', 'ops']);
    expect(html).toContain('data-zone="dev" style="--zone:#6472C4" aria-current="true"');
    expect(html).toContain('data-zone="campus" aria-current="false"');
  });
  it('shows at most three activity dots per zone, only for people doing something', () => {
    const html = railHtml(summary, 'campus', {});
    const dev = html.slice(html.indexOf('data-zone="dev"'), html.indexOf('data-zone="qa"'));
    expect((dev.match(/<i style="background:#/g) ?? []).length).toBe(3);
    const qa = html.slice(html.indexOf('data-zone="qa"'), html.indexOf('data-zone="research"'));
    expect(qa).not.toContain('<i style="background:');
  });
  it('the tooltip names the divisions in the zone and the key that reaches it', () => {
    const html = railHtml(summary, 'campus', { ops: ['Operations'] });
    expect(html).toContain('title="Ops: Operations (7)"');
    expect(html).toContain('title="Executive (1)"');
    expect(html).toContain('aria-label="Executive, 1 active, 1 meeting"');
  });
  it('escapes labels', () => { expect(railHtml([{ ...summary[0], label: '<b>' }], 'campus', {})).not.toContain('<b>'); });
});

describe('the current tab reads on every zone colour', () => {
  it('deepens each zone tint until white text reaches 4.5:1', () => {
    for (const z of summary) expect(contrastRatio('#ffffff', deepen(z.color)), z.label).toBeGreaterThanOrEqual(4.5);
    for (const [id, tint] of Object.entries(ZONE_TINT)) expect(contrastRatio('#ffffff', deepen(tint)), id).toBeGreaterThanOrEqual(4.5);
  });
  it('the raw tints it replaces would not have passed', () => {
    expect(contrastRatio('#ffffff', zoneTint('sales'))).toBeLessThan(4.5);
  });
});

/** `update()` runs twice a second off the rAF loop; a beat that changes nothing must write nothing. */
describe('the rail writes a zone fill only when it moves', () => {
  it('reports every zone the first time and nothing on an unchanged beat', () => {
    const first = deepChanges({}, summary);
    expect(Object.keys(first).sort()).toEqual(['boardroom', 'dev', 'ops', 'pantry', 'qa', 'research', 'sales']);
    expect(first.sales).toBe(deepen(zoneTint('sales')));
    expect(deepChanges(first, summary)).toEqual({});
  });
  it('reports just the zone whose tint changed, and one it has never seen', () => {
    const prev = deepChanges({}, summary);
    const repainted = summary.map((z) => (z.id === 'qa' ? { ...z, color: '#123456' } : z));
    expect(deepChanges(prev, repainted)).toEqual({ qa: deepen('#123456') });
    expect(deepChanges(prev, [...summary, { id: 'lounge', color: '#654321' }])).toEqual({ lounge: deepen('#654321') });
  });
});
