// packages/viewer/src/world/elevator-view.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { doorOpenFor, toViewState } from './elevator-view.js';
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
