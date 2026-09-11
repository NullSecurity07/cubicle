import { describe, it, expect } from 'vitest';
import { RecordingPx } from './tiles-draw.js';
import { drawSpriteFrame, drawSpriteSheet, drawFaceSheet, spriteOpts, FACE_FRAMES, FACE_SHEET_W, FACE_SHEET_H, SPRITE_W, SPRITE_H, type SpriteOpts } from './sprite-draw.js';
import { rolePalette, type Family } from './palette.js';
import { FRAMES } from './frames.js';

const opts: SpriteOpts = { headset: false, hairShape: 0, hoodie: true };
const sig = (name: string, family: Family, o: SpriteOpts = opts) => { const p = new RecordingPx(); drawSpriteFrame(p, name, rolePalette('sre', family), family, o); return p; };

describe('sprite frames', () => {
  it('every frame of every family paints inside its 16×24 cell', () => {
    for (const family of ['chief', 'manager', 'member', 'advisor', 'owner'] as Family[]) for (const name of FRAMES) {
      const p = sig(name, family);
      expect(p.count, `${family} ${name}`).toBeGreaterThan(0);
      expect(p.outside(SPRITE_W, SPRITE_H), `${family} ${name}`).toEqual([]);
    }
  });
  it('families and walk steps differ; sit_side frames mirror', () => {
    const s = (n: string, f: Family) => JSON.stringify(sig(n, f).rects);
    expect(s('idle:0', 'chief')).not.toBe(s('idle:0', 'member'));
    expect(s('idle:0', 'manager')).not.toBe(s('idle:0', 'advisor'));
    expect(s('walk:0:0', 'member')).not.toBe(s('walk:0:1', 'member'));
    expect(s('walk:0:0', 'member')).not.toBe(s('walk:0:2', 'member'));
    expect(s('pose:sit_side_l', 'member')).not.toBe(s('pose:sit_side_r', 'member'));
    expect(s('pose:typing_a', 'member')).not.toBe(s('pose:typing_b', 'member'));
  });
  it('the owner wears the charcoal turtleneck; a headset and a hood add pixels', () => {
    expect(sig('idle:0', 'owner').rects.some((r) => r.c === '#2b2f3a')).toBe(true);
    expect(sig('idle:0', 'member', { ...opts, headset: true }).count).toBeGreaterThan(sig('idle:0', 'member').count);
    expect(JSON.stringify(sig('idle:0', 'member', { ...opts, hoodie: false }).rects)).not.toBe(JSON.stringify(sig('idle:0', 'member').rects));
  });
  it('the sheet places frame i at x = 16 i', () => {
    const p = new RecordingPx(); drawSpriteSheet(p, rolePalette('cto', 'chief'), 'chief', opts);
    expect(p.outside(SPRITE_W * FRAMES.length, SPRITE_H)).toEqual([]);
    expect(p.rects.some((r) => r.x >= 16 * 30)).toBe(true);
  });
  it('spriteOpts: sales members get a headset, options are deterministic', () => {
    expect(spriteOpts('sales_1', 'sales').headset).toBe(true);
    expect(spriteOpts('sre', 'dev').headset).toBe(false);
    expect(spriteOpts('sre', 'dev')).toEqual(spriteOpts('sre', 'dev'));
  });
});

describe('face sheet', () => {
  it('lays out 7 moods × 4 variants × 3 directions and paints each inside its 8×6 cell', () => {
    expect(FACE_FRAMES).toHaveLength(7 * 4 * 3);
    expect(FACE_SHEET_W).toBe(24); expect(FACE_SHEET_H).toBe(168);
    const names = new Set(FACE_FRAMES.map((f) => f.name));
    for (const n of ['neutral:0', 'happy:2:talk', 'worried:1:g', 'asleep:0:talk:g', 'blink:2', 'thinking:0:talk']) expect(names.has(n), n).toBe(true);
    const p = new RecordingPx(); drawFaceSheet(p);
    for (const f of FACE_FRAMES) {
      const inCell = p.rects.filter((r) => r.x >= f.x && r.y >= f.y && r.x + r.w <= f.x + 8 && r.y + r.h <= f.y + 6);
      const touching = p.rects.filter((r) => r.x < f.x + 8 && r.x + r.w > f.x && r.y < f.y + 6 && r.y + r.h > f.y);
      expect(touching.length, f.name).toBe(inCell.length);   // nothing crosses a cell edge
      expect(inCell.length, f.name).toBeGreaterThan(0);
    }
  });
  it('the talk variant changes the mouth and glasses add pixels', () => {
    const p = new RecordingPx(); drawFaceSheet(p);
    const cell = (n: string) => { const f = FACE_FRAMES.find((x) => x.name === n)!; return p.rects.filter((r) => r.x >= f.x && r.y >= f.y && r.x + r.w <= f.x + 8 && r.y + r.h <= f.y + 6).map((r) => ({ ...r, x: r.x - f.x, y: r.y - f.y })); };
    expect(JSON.stringify(cell('neutral:0:talk'))).not.toBe(JSON.stringify(cell('neutral:0')));
    expect(cell('neutral:0:g').length).toBeGreaterThan(cell('neutral:0').length);
  });
});
