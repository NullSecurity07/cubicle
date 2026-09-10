/**
 * The one palette. Phaser reads it directly; plan 3's ui/tokens.ts turns the same numbers into CSS variables.
 * Pure: no Phaser, no DOM. Every colour is a `#rrggbb` string; `hexToInt` converts for Phaser tints.
 */
export type Family = 'chief' | 'advisor' | 'manager' | 'member' | 'owner';
export interface FloorPalette { n: 1 | 2 | 3 | 4; hue: number; carpet: string; carpetAlt: string; skirting: string; lamp: string; tab: string; floor: string; floorAlt: string; speckle: string }
export interface RolePalette { shirt: string; shirtDark: string; accent: string; hair: string; skin: string; trousers: string; ring: string }

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const hex2 = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');

/** HSL (0–360, 0–1, 0–1) → `#rrggbb`. */
export function hsl(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number): number => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return s === 0 ? `#${hex2(l)}${hex2(l)}${hex2(l)}` : `#${hex2(f(hh + 1 / 3))}${hex2(f(hh))}${hex2(f(hh - 1 / 3))}`;
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** Lighten (dL > 0) or darken (dL < 0) by a lightness delta in 0–1 units. */
export function shade(hex: string, dL: number): string { const c = hexToHsl(hex); return hsl(c.h, c.s, clamp01(c.l + dL)); }
export function hexToInt(hex: string): number { return parseInt(hex.slice(1), 16); }
export function hashOf(s: string): number { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }

export const PALETTE = {
  concrete: '#8b8f99', concreteDark: '#6f7480', concreteLight: '#a6aab3',
  wallFace: '#d9d6cf', wallCap: '#b9b6ae',
  wood: '#8a5a2b', woodLight: '#a56d36', woodDark: '#5f3c19',
  steel: '#9aa3ad', steelLight: '#c5ccd4', steelDark: '#5d656f',
  glassFill: 'rgba(170,210,255,0.35)', glassFrame: '#7a8594', glassStreak: 'rgba(255,255,255,0.45)',
  amber: '#e6a93c', amberInk: '#2a1f08',
  marble: '#e8e4dc', marbleAlt: '#d6d1c7',
  asphalt: '#3a3d44', kerb: '#b8b3a8', pavement: '#a89f91',
  screenBg: '#0b0d11', screenFrame: '#3a4050', screenText: '#f3f5f9', screenMuted: '#b9c2d6',
  dusk: '#3b2a4a', night: '#0a1030',
  sky: { day: ['#9ec7ee', '#dfeaf5'], dusk: ['#f0a36b', '#6a4c8a'], night: ['#0b1026', '#1b2140'] },
  windowDay: '#a9d6ff', windowDusk: '#f3b884', windowNight: '#ffe08a',
  skin: ['#f1c9a5', '#d9a577', '#b07a4e', '#6e4a30'],
  hair: ['#2b2118', '#4a2c17', '#6d4c41', '#c0392b', '#d9b26a', '#3a3a3a'],
  trousers: { chief: '#23262e', manager: '#2b3040', member: '#2b3040', advisor: '#3b3a45', owner: '#1f2229' },
  owner: '#2b2f3a',
} as const;

const FLOOR_HUES: Record<1 | 2 | 3 | 4, { hue: number; carpetS: number; carpetL: number; skirt: [number, number]; lamp: [number, number]; tab: [number, number]; floor: string; floorAlt: string; speckle: string }> = {
  1: { hue: 272, carpetS: 0.22, carpetL: 0.58, skirt: [0.40, 0.40], lamp: [0.60, 0.70], tab: [0.55, 0.55], floor: '#5a3d27', floorAlt: '#6b4a30', speckle: '#4a3120' },   // dark plank + purple runner
  2: { hue: 216, carpetS: 0.24, carpetL: 0.60, skirt: [0.45, 0.42], lamp: [0.60, 0.72], tab: [0.60, 0.55], floor: '#c9a878', floorAlt: '#d6b98a', speckle: '#b5925f' },   // light oak + blue carpet tiles
  3: { hue: 150, carpetS: 0.20, carpetL: 0.58, skirt: [0.40, 0.36], lamp: [0.55, 0.68], tab: [0.50, 0.45], floor: '#c4c2bb', floorAlt: '#cfcdc6', speckle: '#b0aea6' },   // pale concrete + green carpet
  4: { hue: 30, carpetS: 0.30, carpetL: 0.62, skirt: [0.55, 0.44], lamp: [0.70, 0.72], tab: [0.75, 0.55], floor: '#d8d2c8', floorAlt: '#e0dbd2', speckle: '#8c8f99' },   // terrazzo speckle + orange rugs
};

export function floorPalette(n: number): FloorPalette {
  const k = (Math.max(1, Math.min(4, Math.round(n))) as 1 | 2 | 3 | 4);
  const f = FLOOR_HUES[k];
  return { n: k, hue: f.hue, carpet: hsl(f.hue, f.carpetS, f.carpetL), carpetAlt: hsl(f.hue, f.carpetS, f.carpetL - 0.04), skirting: hsl(f.hue, f.skirt[0], f.skirt[1]), lamp: hsl(f.hue, f.lamp[0], f.lamp[1]), tab: hsl(f.hue, f.tab[0], f.tab[1]), floor: f.floor, floorAlt: f.floorAlt, speckle: f.speckle };
}

/** chief: title starts with "Chief" or the role is the CEO; advisor: on the board; manager: leads a team; else member. */
export function familyOf(role: string, o: { title?: string; team?: string; isLead?: boolean }): Exclude<Family, 'owner'> {
  if (role === 'ceo' || /^chief\b/i.test(o.title ?? '')) return 'chief';
  if (o.team === 'board') return 'advisor';
  if (o.isLead) return 'manager';
  return 'member';
}

const RING_OVERRIDES: Record<string, string> = { ceo: '#f2c14e', cto: '#4e9af2', coo: '#b98ef2' };
const FAMILY_SL: Record<Family, { s: number; l: number }> = { chief: { s: 0.55, l: 0.42 }, manager: { s: 0.55, l: 0.52 }, member: { s: 0.55, l: 0.60 }, advisor: { s: 0.35, l: 0.50 }, owner: { s: 0, l: 0.2 } };

/** Shirt hue snapped to a 12-hue wheel; saturation/lightness by family; hair and skin by hash. */
export function rolePalette(role: string, family: Family): RolePalette {
  const h = hashOf(role);
  const hue = Math.round((h % 360) / 30) * 30;
  const { s, l } = FAMILY_SL[family];
  const shirt = family === 'owner' ? PALETTE.owner : hsl(hue, s, l);
  const ring = RING_OVERRIDES[role] ?? hsl(hue, 0.55, 0.6);
  const accent = role === 'ceo' ? '#c0392b' : hsl((hue + 180) % 360, 0.6, 0.5);
  return { shirt, shirtDark: shade(shirt, -0.16), accent, hair: PALETTE.hair[(h >>> 8) % PALETTE.hair.length], skin: PALETTE.skin[(h >>> 16) % PALETTE.skin.length], trousers: PALETTE.trousers[family], ring };
}

/** Phaser tint per role: the ring colour (known overrides preserved). The family only changes the shirt, never the ring. */
export function roleColor(role: string): number { return hexToInt(rolePalette(role, 'member').ring); }
