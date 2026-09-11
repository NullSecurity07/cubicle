import { describe, it, expect } from 'vitest';
import { railHtml, deepen, floorDeep, type FloorInfo } from './rail.js';
import { contrastRatio } from './tokens.js';
import { floorPalette } from '../world/palette.js';

const summary: FloorInfo[] = [
  { floor: 1, label: 'Executive', color: '#8d6bb3', agents: [{ role: 'ceo', color: '#e03030', state: 'working' }], meetings: 0 },
  { floor: 2, label: 'Departments', color: '#5a86c8', agents: [{ role: 'a', color: '#111111', state: 'working' }, { role: 'b', color: '#222222', state: 'talking' }, { role: 'c', color: '#333333', state: 'walking' }, { role: 'd', color: '#444444', state: 'working' }, { role: 'e', color: '#555555', state: 'idle_at_desk' }], meetings: 0 },
  { floor: 3, label: 'Assurance', color: '#4f9a72', agents: [], meetings: 0 },
  { floor: 4, label: 'Leadership', color: '#d9863a', agents: [{ role: 'cto', color: '#666666', state: 'idle_at_desk' }], meetings: 1 },
];

describe('floor rail', () => {
  it('lists F4 down to F1 then the lobby, marks the current floor, colours the bar per floor', () => {
    const html = railHtml(summary, 2, false, { 4: ['Technology', 'Revenue'], 2: ['Dev', 'Sales'] });
    const order = [...html.matchAll(/data-floor="(\d)"/g)].map((m) => m[1]);
    expect(order).toEqual(['4', '3', '2', '1', '0']);
    expect(html).toContain('data-floor="2" style="--floor:#5a86c8" aria-current="true"');
    expect(html).toContain('data-floor="4" style="--floor:#d9863a" aria-current="false"');
    expect(html).toContain('class="tab lobby"');
  });
  it('shows at most three activity dots per floor, only for agents doing something', () => {
    const html = railHtml(summary, 1, false, {});
    const f2 = html.slice(html.indexOf('data-floor="2"'), html.indexOf('data-floor="1"'));
    expect((f2.match(/<i style="background:#/g) ?? []).length).toBe(3);
    const f4 = html.slice(html.indexOf('data-floor="4"'), html.indexOf('data-floor="3"'));
    expect(f4).not.toContain('<i style="background:');
  });
  it('the tooltip names the divisions on the floor; the lobby is current when the camera sits in the F1 corridor', () => {
    const html = railHtml(summary, 1, true, { 4: ['Technology', 'Revenue'] });
    expect(html).toContain('title="F4 Leadership: Technology, Revenue"');
    expect(html).toContain('title="F3 Assurance"');
    expect(html).toContain('data-floor="0" aria-current="true"');
    expect(html).toContain('data-floor="1" style="--floor:#8d6bb3" aria-current="false"');
  });
  it('escapes labels', () => { expect(railHtml([{ ...summary[0], label: '<b>' }], 1, false, {})).not.toContain('<b>'); });
});

// The ruling on Task 6's report: white on the raw F4 orange is ~3:1. The current tab fills with `deepen(tint)`
// instead, which Rail publishes as `--floor-<n>-deep`; white on it must clear 4.5:1 on every floor.
describe('the current tab reads on every floor colour', () => {
  it('deepens each floor tint until white text reaches 4.5:1', () => {
    for (const f of summary) expect(contrastRatio('#ffffff', deepen(f.color)), `F${f.floor} ${f.label}`).toBeGreaterThanOrEqual(4.5);
    for (const n of [1, 2, 3, 4]) expect(contrastRatio('#ffffff', floorDeep(n)), `palette F${n}`).toBeGreaterThanOrEqual(4.5);
  });
  it('the raw tints it replaces would not have passed', () => {
    expect(contrastRatio('#ffffff', floorPalette(4).tab)).toBeLessThan(4.5);
    expect(floorDeep(4)).toBe(deepen(floorPalette(4).tab));
  });
});
