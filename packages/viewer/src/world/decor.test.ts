import { describe, it, expect } from 'vitest';
import { decorFrame, plantShape, signX, signVisible, RAIL_PX, DECOR_FRAMES, DECOR_DRAW, DECOR_FRAME_NAMES, type DecorKind } from './decor.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    expect(DECOR_FRAME_NAMES.map((f) => f.name)).toEqual(['plant:0', 'plant:1', 'plant2:0', 'plant2:1', 'coffee:0', 'coffee:1', 'coffee:2', 'lamp:0', 'monitor:0', 'monitor:1', 'cooler:0', 'cooler:1']);
    expect(DECOR_FRAME_NAMES.at(-1)!.x).toBe(16 * 11);
  });
  it('the two plant frames differ and the two monitor frames differ', () => {
    const s = (k: DecorKind, f: number) => { const p = new RecordingPx(); DECOR_DRAW[k](p, f); return JSON.stringify(p.rects); };
    expect(s('plant', 0)).not.toBe(s('plant', 1)); expect(s('monitor', 0)).not.toBe(s('monitor', 1));
  });
  it('the street alternates two planter silhouettes, so no two neighbours are the same shape', () => {
    const s = (k: DecorKind) => { const p = new RecordingPx(); DECOR_DRAW[k](p, 0); return JSON.stringify(p.rects); };
    expect(s('plant')).not.toBe(s('plant2'));
    expect([10, 11, 12, 13, 14, 15].map(plantShape)).toEqual([0, 1, 0, 1, 0, 1]);
  });
});

/**
 * I9: the floor rail covers the left 44 px of the viewport, and a room whose sign anchor ended up under it read
 * "oom" (`13-stack.png`) or "O" (`05-f3.png`). The label slides right along its own wall instead, the way a map
 * label pins itself to the visible part of the feature it names.
 */
describe('a room sign slides clear of the floor rail', () => {
  // A room from tile 4 to tile 20: the anchor at 68, and the label may slide to 300 before it leaves the room.
  const ANCHOR = 68, ROOM_RIGHT = 300;
  it('sits on its anchor while the anchor is clear', () => {
    expect(signX(ANCHOR, ROOM_RIGHT, 0)).toBe(ANCHOR);
    expect(signX(ANCHOR, ROOM_RIGHT, ANCHOR)).toBe(ANCHOR);
  });
  it('slides exactly as far as the rail demands, and no further', () => {
    expect(signX(ANCHOR, ROOM_RIGHT, 120)).toBe(120);
    expect(signX(ANCHOR, ROOM_RIGHT, 299)).toBe(299);
  });
  it('never leaves the room it names, however far the camera pans', () => {
    expect(signX(ANCHOR, ROOM_RIGHT, 5000)).toBe(ROOM_RIGHT);
  });
  it('never moves at all for a room too narrow to hold its own label', () => {
    expect(signX(ANCHOR, ANCHOR - 40, 5000)).toBe(ANCHOR);   // roomRight behind the anchor: stay put
  });
  it('is shown while it cleared the rail and dropped when its room has all but left the screen', () => {
    expect(signVisible(signX(ANCHOR, ROOM_RIGHT, 120), 120)).toBe(true);
    expect(signVisible(signX(ANCHOR, ROOM_RIGHT, 0), 0)).toBe(true);
    // Panned past the room: the clamp stops at ROOM_RIGHT, which is still under the rail, so the label goes.
    expect(signVisible(signX(ANCHOR, ROOM_RIGHT, 5000), 5000)).toBe(false);
  });
  it('reads the rail width the stylesheet actually uses', () => {
    const css = readFileSync(fileURLToPath(new URL('../ui/tokens.css', import.meta.url)), 'utf8');
    expect(`--rail-w: ${RAIL_PX}px`).toBe(/--rail-w:\s*\d+px/.exec(css)?.[0]);
  });
});
