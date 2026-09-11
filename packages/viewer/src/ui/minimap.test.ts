import { describe, it, expect } from 'vitest';
import { tickLayout, minimapPointToWorld } from './minimap.js';

describe('minimap chrome', () => {
  it('lays four equal floor ticks from F4 at the top to F1 at the bottom, in floor colours', () => {
    const ticks = tickLayout(104, { 1: '#a', 2: '#b', 3: '#c', 4: '#d' });
    expect(ticks.map((t) => t.floor)).toEqual([4, 3, 2, 1]);
    expect(ticks[0]).toEqual({ floor: 4, top: 0, height: 26, color: '#d' });
    expect(ticks[3]).toEqual({ floor: 1, top: 78, height: 26, color: '#a' });
  });
  it('maps a click in the minimap to the world point under it', () => {
    expect(minimapPointToWorld(60, 65, { scrollX: 64, scrollY: 32, zoom: 0.125 })).toEqual({ x: 544, y: 552 });
  });
});
