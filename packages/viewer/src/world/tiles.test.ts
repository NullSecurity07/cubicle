import { describe, it, expect } from 'vitest';
import { TILES, T, COLUMNS, tilesetMeta } from './tiles.js';
import { DRAW, RecordingPx, floorOfName, bevel, checker, dither, glowStep, GLOW_CELL, GLOW_STEPS, type TileName } from './tiles-draw.js';
import { floorPalette } from './palette.js';

describe('tile table', () => {
  it('keeps ids 1–18 exactly as the v1 map used them', () => {
    const v1 = ['EMPTY', 'GRASS', 'PATH', 'FLOOR', 'WALL', 'WALL_TOP', 'DOOR', 'DESK', 'CHAIR', 'TABLE', 'WHITEBOARD', 'PLANT', 'KITCHEN', 'NOTICE', 'CARPET', 'WINDOW', 'TREE', 'BENCH', 'SIGN'];
    expect([...TILES.slice(0, 19)]).toEqual(v1);
    expect(T.EMPTY).toBe(0); expect(T.DOOR).toBe(6); expect(T.CHAIR).toBe(8); expect(T.CARPET).toBe(14); expect(T.SIGN).toBe(18);
  });
  it('appends the tower tiles after SIGN in the agreed order', () => {
    expect(T.SKY).toBe(19); expect(T.CARPET_BLUE).toBe(20); expect(T.CARPET_GREEN).toBe(21); expect(T.CARPET_ORANGE).toBe(22);
    expect(T.SCREEN).toBe(23); expect(T.SHAFT).toBe(24); expect(T.ELEVATOR_DOOR).toBe(25); expect(T.COUNTER).toBe(26); expect(T.SLAB).toBe(27);
    expect(new Set(TILES).size).toBe(TILES.length); // no duplicate names
  });
  it('tileset metadata follows the table, so the JSON never hand-syncs a count', () => {
    const m = tilesetMeta();
    expect(m.tilecount).toBe(TILES.length - 1);
    expect(m.columns).toBe(COLUMNS);
    expect(m.imagewidth).toBe(COLUMNS * 16);
    expect(m.imageheight).toBe(Math.ceil((TILES.length - 1) / COLUMNS) * 16);
    expect(m).toMatchObject({ firstgid: 1, name: 'office', tilewidth: 16, tileheight: 16, image: 'runtime:office', margin: 0, spacing: 0 });
  });
});

const names = TILES.filter((n) => n !== 'EMPTY') as Exclude<TileName, 'EMPTY'>[];
const palFor = (n: string) => { const f = floorOfName(n); return f ? floorPalette(f) : null; };

describe('tile table (visual layer)', () => {
  it('keeps ids 1–27 where plan 1 left them and appends the rest', () => {
    expect(T.GRASS).toBe(1); expect(T.SIGN).toBe(18); expect(T.SKY).toBe(19); expect(T.SLAB).toBe(27);
    expect(T.STREET).toBe(28); expect(T.SCREEN_BEZEL_R).toBe(105); expect(T.CROSSING).toBe(TILES.length - 1);
    expect(T.SIDE_TABLE).toBe(109);   // appended, never reordered: every id a shipped map holds stays where it was
    expect(new Set(TILES).size).toBe(TILES.length);
    expect(COLUMNS).toBe(16);
  });
  it('has a drawer for every tile but EMPTY', () => { for (const n of names) expect(typeof DRAW[n], n).toBe('function'); });
});

describe('drawers', () => {
  it('paint at least one pixel and never leave the 16×16 cell', () => {
    for (const n of names) {
      if (n === 'SKY') continue; // SKY paints nothing on purpose: the scene's gradient Image shows through it
      const p = new RecordingPx();
      DRAW[n](p, palFor(n));
      expect(p.count, n).toBeGreaterThan(0);
      expect(p.outside(16, 16), n).toEqual([]);
    }
  });
  it('per-floor variants differ from each other', () => {
    for (const base of ['FLOOR', 'FLOOR_ALT', 'CARPET', 'WALL', 'SIGN']) {
      const sigs = [1, 2, 3, 4].map((f) => { const p = new RecordingPx(); DRAW[`${base}_F${f}` as Exclude<TileName, 'EMPTY'>](p, floorPalette(f)); return JSON.stringify(p.rects); });
      expect(new Set(sigs).size, base).toBe(4);
    }
  });
  it('window tiles differ by hour bucket; elevator door halves mirror', () => {
    const sig = (n: Exclude<TileName, 'EMPTY'>) => { const p = new RecordingPx(); DRAW[n](p, null); return JSON.stringify(p.rects); };
    expect(new Set([sig('WINDOW_DAY'), sig('WINDOW_DUSK'), sig('WINDOW_NIGHT')]).size).toBe(3);
    expect(sig('ELEV_DOOR_L')).not.toBe(sig('ELEV_DOOR_R'));
  });
  it('floorOfName reads the suffix', () => { expect(floorOfName('CARPET_F3')).toBe(3); expect(floorOfName('CARPET')).toBeNull(); expect(floorOfName('WALL_TOP_INT')).toBeNull(); });
});

describe('helpers', () => {
  it('bevel paints the base, a lighter top edge and darker bottom/right edges', () => {
    const p = new RecordingPx(); bevel(p, 2, 2, 8, 6, '#808080');
    expect(p.rects[0]).toEqual({ x: 2, y: 2, w: 8, h: 6, c: '#808080' });
    expect(p.rects.length).toBe(4);
    expect(p.rects[1].y).toBe(2); expect(p.rects[2].y).toBe(7); expect(p.rects[3].x).toBe(9);
  });
  it('checker alternates and dither is deterministic', () => {
    const p = new RecordingPx(); checker(p, 0, 0, 16, 16, '#111111', '#222222', 8);
    expect(p.rects.map((r) => r.c)).toEqual(['#111111', '#222222', '#222222', '#111111']);
    const a = new RecordingPx(), b = new RecordingPx(); dither(a, 0, 0, 16, 16, '#333333', 10, 5); dither(b, 0, 0, 16, 16, '#333333', 10, 5);
    expect(a.rects).toEqual(b.rects); expect(a.rects).toHaveLength(10);
  });
});


/**
 * Visual QA R-I7: the lamp glow was a continuous radial gradient — the one soft object left once the type became
 * pixel blocks, and the brightest thing in `08-board` outside the top bar.
 */
describe('the lamp glow is stepped, not a bloom', () => {
  it('is a small number of hard bands, each dimmer than the last', () => {
    expect(GLOW_STEPS.length).toBeGreaterThanOrEqual(3);
    expect(GLOW_STEPS.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < GLOW_STEPS.length; i++) expect(GLOW_STEPS[i]).toBeLessThan(GLOW_STEPS[i - 1]);
  });
  it('never outshines a screen headline: the brightest band is well under full white', () => {
    expect(GLOW_STEPS[0]).toBeLessThan(0.4);
  });
  it('holds each band flat, and stops at the edge', () => {
    expect(glowStep(0)).toBe(GLOW_STEPS[0]);
    expect(glowStep(0.2)).toBe(GLOW_STEPS[0]);           // flat inside the band, not a ramp
    expect(glowStep(0.26)).toBe(GLOW_STEPS[1]);
    expect(glowStep(0.99)).toBe(GLOW_STEPS[GLOW_STEPS.length - 1]);
    expect(glowStep(1)).toBe(0);
    expect(glowStep(2)).toBe(0);
  });
  it('quantises onto a cell that is a whole number of pixels, so the bands land on the grid', () => {
    expect(GLOW_CELL).toBe(Math.round(GLOW_CELL));
    expect(64 % GLOW_CELL).toBe(0);
  });
});
