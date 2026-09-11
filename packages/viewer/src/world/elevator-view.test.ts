// packages/viewer/src/world/elevator-view.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { doorOpenFor, doorCrop, toViewState, emptyViewState } from './elevator-view.js';
import type { ElevatorState } from './elevator.js';
import { withMotion } from './motion.js';

const st = (o: Partial<ElevatorState> = {}): ElevatorState => ({ floor: 1, row: 51, dir: 0, status: 'idle', openLeft: 0, waiting: [], riders: [], ...o });

afterEach(() => withMotion(1));   // doorOpenFor reads the shared MOTION.scale; never leak a scale change to another test

describe('door opening', () => {
  it('is closed while idle or moving, slides open then closed around a stop', () => {
    expect(doorOpenFor('idle', 0)).toBe(0); expect(doorOpenFor('moving', 0)).toBe(0);
    expect(doorOpenFor('open', 800, 800)).toBe(0);            // the stop just began
    expect(doorOpenFor('open', 725, 800)).toBeCloseTo(0.5);    // 75 ms in
    expect(doorOpenFor('open', 400, 800)).toBe(1);             // fully open
    expect(doorOpenFor('open', 75, 800)).toBeCloseTo(0.5);     // closing
    expect(doorOpenFor('open', 0, 800)).toBe(0);
  });

  it('honours reduced motion: the slide collapses to ~1 ms so the door still opens, just without decoration', () => {
    withMotion(0);
    expect(doorOpenFor('open', 800, 800)).toBe(0);   // the stop just began: still closed
    expect(doorOpenFor('open', 750, 800)).toBe(1);   // 50 ms later — long past a 1 ms slide — fully open already
  });
});

describe('toViewState', () => {
  it('maps the engine state to pixels, flags and rider ids', () => {
    const v = toViewState(st({ row: 38.5, status: 'moving', dir: -1, floor: 2, riders: [{ id: 'coo', from: 4, to: 2 }] }));
    expect(v).toEqual({ carY: 38.5 * 16, doorOpen: 0, floor: 2, moving: true, riders: ['coo'] });
    expect(toViewState(st({ status: 'open', openLeft: 400 })).doorOpen).toBe(1);
  });

  it('reuses the same riders array when the engine state reused the same riders reference (cheap per-frame polling)', () => {
    const riders = [{ id: 'coo', from: 4, to: 2 }];
    const a = toViewState(st({ riders }));
    const b = toViewState(st({ riders }));   // a fresh ElevatorState each frame, but the same `riders` array — the common case
    expect(a.riders).toBe(b.riders);
    const c = toViewState(st({ riders: [{ id: 'coo', from: 4, to: 2 }] }));   // a genuinely different array still maps correctly
    expect(c.riders).toEqual(['coo']);
    expect(c.riders).not.toBe(a.riders);
  });
});

describe('door leaves', () => {
  it('parts both leaves symmetrically: equal visible widths at every opening, and a closed pair covers the tile', () => {
    for (const open of [0, 0.25, 0.5, 0.75, 1]) {
      const c = doorCrop(open);
      expect(c.l.w, `open ${open}`).toBe(c.r.w);
      expect(c.l.x).toBe(0);
      expect(c.r.x + c.r.w).toBe(16);          // the right leaf never leaves its own tile
      expect(c.l.w + c.r.w).toBe(16 - 2 * Math.round(6 * open));   // the gap grows from the centre, both sides
    }
    expect(doorCrop(0)).toEqual({ l: { x: 0, w: 8 }, r: { x: 8, w: 8 } });   // closed: the whole tile is door
    expect(doorCrop(1)).toEqual({ l: { x: 0, w: 2 }, r: { x: 14, w: 2 } });  // open: a 12 px gap onto the recess
  });
  it('clamps a nonsense opening rather than inverting a leaf', () => {
    expect(doorCrop(-1)).toEqual(doorCrop(0));
    expect(doorCrop(9)).toEqual(doorCrop(1));
  });
});

describe('toViewState into a reused object', () => {
  it('fills the caller\'s object so the per-frame loop allocates nothing', () => {
    const into = emptyViewState();
    const a = toViewState(st({ row: 20, status: 'moving', floor: 3 }), 16, into);
    expect(a).toBe(into);
    expect(a).toEqual({ carY: 320, doorOpen: 0, floor: 3, moving: true, riders: [] });
    const b = toViewState(st({ row: 51, status: 'idle', floor: 1 }), 16, into);
    expect(b).toBe(into);
    expect(b.floor).toBe(1);   // every field is rewritten, never left stale from the previous frame
    expect(b.moving).toBe(false);
    expect(b.carY).toBe(51 * 16);
  });
});
