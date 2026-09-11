import { describe, it, expect } from 'vitest';
import { THEMES, contrastRatio, cssVars, themeFromQuery, hexNum } from './tokens.js';
import { floorPalette } from '../world/palette.js';

const SURFACES = ['bg', 'surface1', 'surface2', 'surface3'] as const;
const TEXTS = ['text', 'text2', 'text3'] as const;
const CHIPS = ['ok', 'warn', 'bad', 'info', 'accentText'] as const;

describe('contrast (WCAG 2.1)', () => {
  it('computes the reference ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
  for (const mode of ['dark', 'light'] as const) {
    const c = THEMES[mode].colors;
    it(`${mode}: every text token on every surface is at least 4.5:1`, () => {
      for (const t of TEXTS) for (const s of SURFACES) expect(contrastRatio(c[t], c[s]), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${mode}: every chip colour on every surface is at least 3:1`, () => {
      for (const k of CHIPS) for (const s of ['surface1', 'surface2', 'surface3'] as const) expect(contrastRatio(c[k], c[s]), `${k} on ${s}`).toBeGreaterThanOrEqual(3);
    });
    it(`${mode}: accent ink on the accent is at least 4.5:1`, () => { expect(contrastRatio(c.accentInk, c.accent)).toBeGreaterThanOrEqual(4.5); });
    it(`${mode}: terminal text and prompt read on the terminal background`, () => {
      expect(contrastRatio(c.termText, c.termBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.termPrompt, c.termBg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('css variables', () => {
  it('emits one custom property per token plus the four floor tabs from the shared palette', () => {
    const v = cssVars('dark');
    for (const name of ['--bg', '--surface-1', '--surface-2', '--surface-3', '--hairline', '--hairline-2', '--text', '--text-2', '--text-3', '--accent', '--accent-ink', '--accent-text', '--ok', '--warn', '--bad', '--info', '--term-bg', '--term-text', '--term-prompt', '--glass', '--scrim', '--shadow-1', '--shadow-2', '--floor-1', '--floor-2', '--floor-3', '--floor-4']) expect(v[name], name).toBeTruthy();
    expect(v['--floor-1']).toBe(floorPalette(1).tab);
    expect(v['--floor-4']).toBe(floorPalette(4).tab);
    expect(cssVars('light')['--text']).not.toBe(v['--text']);
  });
  it('reads ?theme= and falls back to system', () => {
    expect(themeFromQuery('?theme=light')).toBe('light');
    expect(themeFromQuery('?token=x&theme=dark')).toBe('dark');
    expect(themeFromQuery('?theme=blue')).toBe('system');
    expect(themeFromQuery('')).toBe('system');
  });
  it('converts hex for Phaser', () => { expect(hexNum('#e6a93c')).toBe(0xe6a93c); expect(hexNum('#0e1014')).toBe(0x0e1014); });
});
