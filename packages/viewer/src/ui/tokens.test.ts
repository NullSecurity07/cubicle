import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES, contrastRatio, cssVars, themeFromQuery, hexNum } from './tokens.js';
import { ZONE_TINT } from '../world/palette.js';
import { DUR } from '../world/motion.js';
import { deepen } from './rail.js';

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
    // The viewer chrome used to be four literal rgba()s in app.css and so missed this sweep entirely; it is the one
    // place the owner reads a live stream's agent, host, seq and rate, and it is dark in both themes.
    it(`${mode}: the viewer chrome's quiet text reads on the terminal background`, () => {
      expect(contrastRatio(c.termText2, c.termBg), 'termText2 on termBg').toBeGreaterThanOrEqual(4.5);
    });
    it(`${mode}: text on a zone tint reads on every deepened accent`, () => {
      for (const [id, tint] of Object.entries(ZONE_TINT)) expect(contrastRatio(c.onTint, deepen(tint)), `onTint on ${id}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${mode}: the accent as text reads on the surface the approvals pill sits on`, () => {
      // I4's ruling: the primary button keeps the amber fill and the pill yields to accent text on a surface.
      expect(contrastRatio(c.accentText, c.surface1), 'accentText on surface1').toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('css variables', () => {
  it('emits one custom property per token plus a zone and a division tint from the shared palette', () => {
    const v = cssVars('dark');
    for (const name of ['--bg', '--surface-1', '--surface-2', '--surface-3', '--hairline', '--hairline-2', '--text', '--text-2', '--text-3', '--accent', '--accent-ink', '--accent-text', '--ok', '--warn', '--bad', '--info', '--term-bg', '--term-text', '--term-prompt', '--term-text-2', '--term-line', '--term-line-2', '--on-tint', '--paper', '--glass', '--scrim', '--shadow-1', '--shadow-2', '--zone-dev', '--zone-sales', '--zone-ops', '--zone-boardroom', '--division-technology', '--division-revenue']) expect(v[name], name).toBeTruthy();
    expect(v['--zone-dev']).toBe(ZONE_TINT.dev);
    expect(v['--zone-sales']).toBe(ZONE_TINT.sales);
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

/**
 * Two timing tables held the same four numbers by hand: tokens.css for CSS transitions and world/motion.ts `DUR` for
 * Phaser tweens. `ui/notify.ts` times a CSS `var(--d-reader)` transition with `dur(DUR.reader)`, so a drift between
 * them is a coach mark that is removed before or after it has finished fading. Assert the overlap instead.
 */
describe('tokens.css against world/motion.ts', () => {
  const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
  const msOf = (name: string): number => { const m = new RegExp(`--${name}:\\s*(\\d+)ms`).exec(css); if (!m) throw new Error(`tokens.css has no --${name}`); return Number(m[1]); };
  const SHARED: [string, number][] = [['d-micro', DUR.micro], ['d-open', DUR.open], ['d-sheet', DUR.sheet], ['d-reader', DUR.reader], ['d-frame', DUR.crossfade], ['d-pulse', DUR.livePulse]];
  for (const [token, ms] of SHARED) it(`--${token} is DUR's ${ms} ms`, () => { expect(msOf(token)).toBe(ms); });
  it('reduced motion drops every duration token, the frame cross-fade included, to 1 ms', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{ :root \{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const token of ['d-micro', 'd-open', 'd-sheet', 'd-reader', 'd-frame']) expect(block, token).toMatch(new RegExp(`--${token}:\\s*1ms`));
  });
  it('keeps the dwell times out of the reduced-motion block: they are feedback, not motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{ :root \{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const token of ['t-copy', 't-toast']) expect(block).not.toContain(`--${token}`);
  });
});

/**
 * C2: `#layer` is inset by `--bar-h` at the top and `--time-h` at the bottom, and the sheet stops `--minimap-h` above
 * the viewport floor. Both numbers have to actually clear the controls they are named for at 1280 × 800, or a panel
 * slices the Live segment and buries the map — which is what the delivered screenshots showed.
 */
describe('layout tokens clear the elevation-0 controls', () => {
  const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
  const app = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8');
  const px = (name: string): number => { const m = new RegExp(`--${name}:\\s*(\\d+)px`).exec(css); if (!m) throw new Error(`tokens.css has no --${name}`); return Number(m[1]); };
  it('--time-h covers the time bar: --s1 twice plus a --hit control, plus its --s3 inset and an --s3 gap', () => {
    expect(px('time-h')).toBeGreaterThanOrEqual(px('hit') + 2 * px('s1') + px('s3'));
  });
  it('--minimap-h covers the 160 px minimap camera, its 12 px inset and the M toggle above it', () => {
    expect(px('minimap-h')).toBeGreaterThanOrEqual(12 + 160 + px('hit'));
  });
  it('#layer stops at the time bar rather than at the viewport floor', () => {
    expect(app).toMatch(/#layer \{[^}]*inset: var\(--bar-h\) 0 var\(--time-h\) var\(--rail-w\)/);
  });
  it('the sheet is padded down to --minimap-h so the map is never under it', () => {
    expect(app).toMatch(/#layer\[data-presentation="sheet"\] \{[^}]*calc\(var\(--minimap-h\) - var\(--time-h\)\)/);
  });
  it('the selected segment is filled with the accent, with no literal shadow holding its edge', () => {
    expect(app).toMatch(/\.seg\[aria-selected="true"\] \{ background: var\(--accent\); color: var\(--accent-ink\); \}/);
    expect(app).not.toContain('rgba(0,0,0,.18)');
  });
  // Pinned to its newest turn, a conversation's scrollport lands wherever the older turns fall — which was between
  // a speaker's name and their bubble in the delivered scene. The fade is the fix, and it is a claim about the CSS.
  it('a conversation fades its top edge rather than cutting a speaker off their bubble', () => {
    expect(app).toMatch(/\.thread \{[^}]*mask-image: linear-gradient\(to bottom, transparent 0, #000 var\(--s5\)\)/);
  });
  it('the decision chips are quiet: one accent, spent on the pill and the primary action', () => {
    expect(app).toMatch(/\.chip\.note, \.chip\.band, \.chip\.applying, \.chip\.sitting \{ color: var\(--text-2\); \}/);
  });
  it('the first-run card paints the level-2 scrim itself', () => {
    expect(app).toMatch(/#firstrun \{[^}]*background: var\(--scrim\)/);
  });
  it('no literal hex or rgba is left in the viewer chrome', () => {
    for (const literal of ['rgba(212,218,232', 'rgba(255,255,255,.08)', 'rgba(255,255,255,.1)', 'rgba(255,255,255,.15)', 'background: #000', 'background: #fff', 'color: #fff']) expect(app, literal).not.toContain(literal);
  });
});
