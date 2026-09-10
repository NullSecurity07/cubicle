import { describe, it, expect } from 'vitest';
import { TILES, T, COLUMNS, tilesetMeta } from './tiles.js';

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
