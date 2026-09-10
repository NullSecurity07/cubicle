import { describe, it, expect } from 'vitest';
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
