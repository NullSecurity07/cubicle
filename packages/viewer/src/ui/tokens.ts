/**
 * The single palette source for the HTML layer and Phaser (visual notes §1 "Consistency"). `applyTheme` writes every
 * semantic token as a CSS custom property on <html>; Phaser code reads the same hex strings through `THEMES` and
 * `hexNum`. Floor colours come from world/palette.ts so carpet, sign, floor tab and minimap tick share one hue.
 */
import { floorPalette, PALETTE } from '../world/palette.js';

export type ThemeMode = 'dark' | 'light';

export interface ThemeColors {
  bg: string; surface1: string; surface2: string; surface3: string;
  text: string; text2: string; text3: string;
  /** the one accent: fills (pill, selected segment, LIVE) */
  accent: string;
  /** text placed on an accent fill */
  accentInk: string;
  /** the accent used as text on a surface (dark: amber itself; light: a darker amber that still reads) */
  accentText: string;
  ok: string; warn: string; bad: string; info: string;
  /** the terminal is dark in both themes */
  termBg: string; termText: string; termPrompt: string;
}
export interface ThemeMaterials { hairline: string; hairline2: string; glass: string; scrim: string; shadow1: string; shadow2: string }
export interface Theme { colors: ThemeColors; materials: ThemeMaterials }

export const THEMES: Record<ThemeMode, Theme> = {
  dark: {
    colors: { bg: '#0e1014', surface1: '#151820', surface2: '#1b1f2a', surface3: '#232838', text: '#e7e9ee', text2: '#a3a9ba', text3: '#8f95a5', accent: PALETTE.amber, accentInk: PALETTE.amberInk, accentText: PALETTE.amber, ok: '#5cbf6c', warn: PALETTE.amber, bad: '#f0655a', info: '#7aa2f7', termBg: '#0b0d11', termText: '#d4dae8', termPrompt: PALETTE.amber },
    materials: { hairline: 'rgba(255,255,255,.08)', hairline2: 'rgba(255,255,255,.14)', glass: 'rgba(21,24,32,.72)', scrim: 'rgba(6,8,12,.4)', shadow1: '0 8px 24px rgba(0,0,0,.28)', shadow2: '0 24px 64px rgba(0,0,0,.5)' },
  },
  light: {
    colors: { bg: '#f4f5f8', surface1: '#ffffff', surface2: '#f2f3f6', surface3: '#e9ebf0', text: '#1b1e26', text2: '#4d5361', text3: '#5f6573', accent: PALETTE.amber, accentInk: PALETTE.amberInk, accentText: '#8a5a00', ok: '#1f7a33', warn: '#8a5a00', bad: '#b3261e', info: '#2b5fc7', termBg: '#0b0d11', termText: '#d4dae8', termPrompt: PALETTE.amber },
    materials: { hairline: 'rgba(0,0,0,.08)', hairline2: 'rgba(0,0,0,.14)', glass: 'rgba(255,255,255,.72)', scrim: 'rgba(20,24,32,.25)', shadow1: '0 8px 24px rgba(0,0,0,.12)', shadow2: '0 24px 64px rgba(0,0,0,.22)' },
  },
};

const VAR_NAMES: Record<keyof ThemeColors | keyof ThemeMaterials, string> = {
  bg: '--bg', surface1: '--surface-1', surface2: '--surface-2', surface3: '--surface-3', text: '--text', text2: '--text-2', text3: '--text-3',
  accent: '--accent', accentInk: '--accent-ink', accentText: '--accent-text', ok: '--ok', warn: '--warn', bad: '--bad', info: '--info',
  termBg: '--term-bg', termText: '--term-text', termPrompt: '--term-prompt',
  hairline: '--hairline', hairline2: '--hairline-2', glass: '--glass', scrim: '--scrim', shadow1: '--shadow-1', shadow2: '--shadow-2',
};

/** Every custom property the stylesheets read, for one theme. */
export function cssVars(mode: ThemeMode): Record<string, string> {
  const t = THEMES[mode];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...t.colors, ...t.materials })) out[VAR_NAMES[k as keyof typeof VAR_NAMES]] = v;
  for (const n of [1, 2, 3, 4]) out[`--floor-${n}`] = floorPalette(n).tab;
  return out;
}

/** `?theme=light|dark` overrides the OS preference for the session; anything else follows the system. */
export function themeFromQuery(search: string): ThemeMode | 'system' {
  const t = new URLSearchParams(search).get('theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

let active: ThemeMode = 'dark';
let systemWatch: (() => void) | null = null;

export function currentTheme(): ThemeMode { return active; }

/** Apply a theme now; `'system'` follows `prefers-color-scheme` and keeps following it. Returns the mode applied. */
export function applyTheme(mode: ThemeMode | 'system'): ThemeMode {
  if (systemWatch) { systemWatch(); systemWatch = null; }
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  const resolve = (): ThemeMode => (mode === 'system' ? (mq?.matches ? 'light' : 'dark') : mode);
  const set = (): void => {
    active = resolve();
    const root = document.documentElement;
    root.dataset.theme = active;
    root.style.colorScheme = active;
    for (const [k, v] of Object.entries(cssVars(active))) root.style.setProperty(k, v);
  };
  set();
  if (mode === 'system' && mq) { mq.addEventListener('change', set); systemWatch = () => mq.removeEventListener('change', set); }
  return active;
}

/** `#rrggbb` → the number Phaser wants. */
export const hexNum = (hex: string): number => parseInt(hex.slice(1), 16);

function luminance(hex: string): number {
  const n = hexNum(hex);
  const ch = (v: number): number => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colours (order does not matter). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
