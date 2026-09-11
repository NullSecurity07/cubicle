import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE, floorPalette, familyOf, rolePalette, roleColor, hsl, hexToHsl, shade, hexToInt } from './palette.js';

describe('colour maths', () => {
  it('hsl → hex → hsl round-trips within rounding', () => {
    const hex = hsl(272, 0.22, 0.58);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    const back = hexToHsl(hex);
    expect(Math.abs(back.h - 272)).toBeLessThan(2);
    expect(Math.abs(back.s - 0.22)).toBeLessThan(0.02);
    expect(Math.abs(back.l - 0.58)).toBeLessThan(0.02);
  });
  it('shade moves lightness and clamps at the ends', () => {
    expect(hexToHsl(shade('#808080', 0.1)).l).toBeGreaterThan(hexToHsl('#808080').l);
    expect(shade('#ffffff', 0.5)).toBe('#ffffff');
    expect(shade('#000000', -0.5)).toBe('#000000');
  });
  it('hexToInt parses the accent', () => { expect(hexToInt('#e6a93c')).toBe(0xe6a93c); expect(PALETTE.amber).toBe('#e6a93c'); });
});

describe('floor palettes', () => {
  it('four floors, hues 272/216/150/30, carpet saturation ≤ 30 %, tabs ≥ 50 %', () => {
    const hues = [1, 2, 3, 4].map((n) => floorPalette(n).hue);
    expect(hues).toEqual([272, 216, 150, 30]);
    for (const n of [1, 2, 3, 4]) {
      const p = floorPalette(n);
      expect(hexToHsl(p.carpet).s).toBeLessThanOrEqual(0.31);
      expect(hexToHsl(p.tab).s).toBeGreaterThanOrEqual(0.49);
      expect(p.carpet).not.toBe(p.carpetAlt);
      expect(p.floor).not.toBe(p.floorAlt);
    }
  });
  it('hues stay well apart (the notes\' 216 → 272 gap is 56°) and out-of-range floors clamp', () => {
    const hues = [1, 2, 3, 4].map((n) => floorPalette(n).hue).sort((a, b) => a - b);
    for (let i = 1; i < hues.length; i++) expect(hues[i] - hues[i - 1]).toBeGreaterThanOrEqual(50);
    expect(floorPalette(0).n).toBe(1); expect(floorPalette(9).n).toBe(4);
  });
});

describe('families and role palettes', () => {
  it('familyOf follows title, team and leadership', () => {
    expect(familyOf('ceo', {})).toBe('chief');
    expect(familyOf('cfo', { title: 'Chief Financial Officer', team: 'revenue', isLead: true })).toBe('chief');
    expect(familyOf('advisor_investor', { title: 'Investor', team: 'board' })).toBe('advisor');
    expect(familyOf('dev_manager', { title: 'Engineering Manager', team: 'dev', isLead: true })).toBe('manager');
    expect(familyOf('backend_engineer', { title: 'Backend Engineer', team: 'dev' })).toBe('member');
  });
  it('role palettes are deterministic, snapped to a 12-hue wheel, and lighter for members than chiefs', () => {
    const a = rolePalette('backend_engineer', 'member'), b = rolePalette('backend_engineer', 'member');
    expect(a).toEqual(b);
    expect(hexToHsl(a.shirt).h % 30).toBeLessThan(1.5);
    expect(hexToHsl(rolePalette('cto', 'chief').shirt).l).toBeLessThan(hexToHsl(rolePalette('sre', 'member').shirt).l);
    expect(hexToHsl(rolePalette('advisor_skeptic', 'advisor').shirt).s).toBeLessThan(0.4);
    expect(rolePalette('ceo', 'chief').accent).toBe('#c0392b');           // the CEO keeps the red tie
    expect(rolePalette('owner', 'owner').shirt).toBe('#2b2f3a');           // charcoal turtleneck
    for (const k of ['shirt', 'shirtDark', 'accent', 'hair', 'skin', 'trousers', 'ring'] as const) expect(a[k]).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('roleColor keeps the three known overrides and equals the ring', () => {
    expect(roleColor('ceo')).toBe(0xf2c14e); expect(roleColor('cto')).toBe(0x4e9af2); expect(roleColor('coo')).toBe(0xb98ef2);
    expect(roleColor('qa_lead')).toBe(hexToInt(rolePalette('qa_lead', 'manager').ring));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// One palette drives Phaser and CSS (the spec's consistency rule). This is the lint that keeps it true: no colour
// literal may appear in `world/` or `scenes/` outside the palette itself and the two pixel drawers, which paint
// from palettes handed to them. Three raw ambers and about thirty other hexes had drifted out of the table.
// ---------------------------------------------------------------------------------------------------------------
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['world/palette.ts', 'world/tiles-draw.ts', 'world/sprite-draw.ts']);

function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(SRC, dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(dir, r);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [`${dir}/${r}`] : [];
  });
}

describe('one palette', () => {
  it('has no colour literal outside palette.ts and the two pixel drawers', () => {
    const offenders: string[] = [];
    for (const file of [...walk('world'), ...walk('scenes')]) {
      if (ALLOWED.has(file)) continue;
      readFileSync(join(SRC, file), 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('palette-lint: ignore')) return;
        if (/0x[0-9a-fA-F]{6}\b/.test(line) || /#[0-9a-fA-F]{6}\b/.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('carries the tokens the sweep needed, and keeps amber for attention only', () => {
    for (const k of ['screenText', 'screenInk', 'labelInk', 'labelStroke', 'barTrack', 'good', 'warn', 'bad', 'minimapBg', 'leaf', 'leafDark', 'bubbleFill', 'bubbleActionFill'] as const) {
      expect(PALETTE[k], k).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.values(PALETTE.tool)).toHaveLength(6);
    for (const c of Object.values(PALETTE.tool)) expect(c, `tool ${c}`).not.toBe(PALETTE.amber);
    expect(PALETTE.screenText).not.toBe('#ffe9a8');   // the pale amber that was on all eight screen titles
  });

  it("desaturated the street planting into the tower's range", () => {
    // #43a047 was S 0.41 at L 0.46: the most saturated thing in the lower third of every shot, against the rule
    // that the ground stays quiet so sprites and screens dominate.
    expect(hexToHsl(PALETTE.leaf).s).toBeLessThan(0.4);
    expect(hexToHsl(PALETTE.leafDark).l).toBeLessThan(hexToHsl(PALETTE.leaf).l);
    expect(hexToHsl(PALETTE.leafLight).l).toBeGreaterThan(hexToHsl(PALETTE.leaf).l);
  });
});
