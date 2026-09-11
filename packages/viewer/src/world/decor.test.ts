import { describe, it, expect } from 'vitest';
import { decorFrame, DECOR_FRAMES, DECOR_DRAW, DECOR_FRAME_NAMES, type DecorKind } from './decor.js';
import { RecordingPx } from './tiles-draw.js';

const idle = { occupied: false, working: false }, busy = { occupied: true, working: true };

describe('ambient timing', () => {
  it('plants sway 2 frames over 1.6 s', () => { expect(decorFrame('plant', 0, idle)).toBe(0); expect(decorFrame('plant', 800, idle)).toBe(1); expect(decorFrame('plant', 1600, idle)).toBe(0); });
  it('coffee steams 3 frames every 0.5 s only while someone stands at the machine', () => {
    expect(decorFrame('coffee', 0, idle)).toBeNull();
    expect([decorFrame('coffee', 0, busy), decorFrame('coffee', 500, busy), decorFrame('coffee', 1000, busy), decorFrame('coffee', 1500, busy)]).toEqual([0, 1, 2, 0]);
  });
  it('monitors glow while the desk agent works; the cooler bubbles for 400 ms every 6 s', () => {
    expect(decorFrame('monitor', 0, idle)).toBe(0); expect(decorFrame('monitor', 0, busy)).toBe(1);
    expect(decorFrame('cooler', 0, idle)).toBe(1); expect(decorFrame('cooler', 399, idle)).toBe(1); expect(decorFrame('cooler', 400, idle)).toBe(0); expect(decorFrame('cooler', 6000, idle)).toBe(1);
    expect(decorFrame('lamp', 0, idle)).toBeNull();   // lamps are the glow images of Task 10, not a decor frame
  });
});

describe('decor sheet', () => {
  it('every frame of every kind paints inside a 16×16 cell and the names cover the frame counts', () => {
    for (const kind of Object.keys(DECOR_FRAMES) as DecorKind[]) for (let f = 0; f < DECOR_FRAMES[kind]; f++) {
      const p = new RecordingPx(); DECOR_DRAW[kind](p, f);
      expect(p.count, `${kind} ${f}`).toBeGreaterThan(0); expect(p.outside(16, 16), `${kind} ${f}`).toEqual([]);
    }
    expect(DECOR_FRAME_NAMES.map((f) => f.name)).toEqual(['plant:0', 'plant:1', 'coffee:0', 'coffee:1', 'coffee:2', 'lamp:0', 'monitor:0', 'monitor:1', 'cooler:0', 'cooler:1']);
    expect(DECOR_FRAME_NAMES.at(-1)!.x).toBe(16 * 9);
  });
  it('the two plant frames differ and the two monitor frames differ', () => {
    const s = (k: DecorKind, f: number) => { const p = new RecordingPx(); DECOR_DRAW[k](p, f); return JSON.stringify(p.rects); };
    expect(s('plant', 0)).not.toBe(s('plant', 1)); expect(s('monitor', 0)).not.toBe(s('monitor', 1));
  });
});
