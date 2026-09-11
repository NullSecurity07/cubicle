import { describe, it, expect } from 'vitest';
import { Latch } from './latch.js';

/**
 * This is the gate in front of `setStyle` and `setDepth` in `world/agents.ts`. Those calls sit on the per-frame
 * path for every sprite, so what matters is that a *second* frame carrying the same value issues nothing.
 */
describe('Latch', () => {
  it('fires the first time and then only on a change', () => {
    const l = new Latch();
    expect(l.changed('browser')).toBe(true);    // frame 1: the icon has to be styled once
    expect(l.changed('browser')).toBe(false);   // frame 2, same tool: no setStyle, no canvas re-render
    expect(l.changed('browser')).toBe(false);
    expect(l.changed('terminal')).toBe(true);   // the tool actually changed
    expect(l.changed('terminal')).toBe(false);
    expect(l.changed('browser')).toBe(true);    // and back again
  });

  it('counts a whole run of identical frames as one call', () => {
    const l = new Latch();
    let calls = 0;
    for (let frame = 0; frame < 600; frame++) if (l.changed('doc')) calls++;
    expect(calls).toBe(1);   // 600 frames of a sprite holding one tool: one setStyle, not 600
  });

  it('treats the first undefined or empty value as a change, not as "already set"', () => {
    const l = new Latch<string | undefined>();
    expect(l.changed(undefined)).toBe(true);
    expect(l.changed(undefined)).toBe(false);
    const e = new Latch();
    expect(e.changed('')).toBe(true);
    expect(e.changed('')).toBe(false);
  });

  it('compares numbers by value, NaN included, for the depth guard', () => {
    const l = new Latch<number>();
    expect(l.changed(10.0042)).toBe(true);
    expect(l.changed(10.0042)).toBe(false);   // a sprite that did not move does not dirty the display list
    expect(l.changed(10.0043)).toBe(true);
    const n = new Latch<number>();
    expect(n.changed(NaN)).toBe(true);
    expect(n.changed(NaN)).toBe(false);
  });

  it('forgets on reset', () => {
    const l = new Latch();
    l.changed('a');
    l.reset();
    expect(l.changed('a')).toBe(true);
  });
});
