/**
 * The one palette. Phaser reads it directly; plan 3's ui/tokens.ts turns the same numbers into CSS variables.
 * Pure: no Phaser, no DOM. Every colour is a `#rrggbb` string; `hexToInt` converts for Phaser tints.
 */
export type Family = 'chief' | 'advisor' | 'manager' | 'member' | 'owner';
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
/**
 * Blend two `#rrggbb` colours channel by channel.
 *
 * The sky used to blend through HSL along the shorter hue arc, and the shorter arc from dusk (hue 25°) to night
 * (hue 228°) runs backwards through 352° and 300°: every evening the sky turned crimson, then magenta, before it
 * reached navy (visual QA C2). There is no hue path between an orange horizon and a navy one that is not a lie;
 * a straight line between the two colours is, and the palette carries an explicit evening stop so the line passes
 * through the violet a real dusk has.
 */
export function mixHex(a: string, b: string, t: number): string {
  const u = Math.max(0, Math.min(1, t));
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const ch = (sh: number): string => hex2((((x >> sh) & 255) + ((((y >> sh) & 255)) - ((x >> sh) & 255)) * u) / 255);
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
export function hashOf(s: string): number { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }

export const PALETTE = {
  concrete: '#8b8f99', concreteDark: '#6f7480', concreteLight: '#a6aab3',
  wallFace: '#d9d6cf', wallCap: '#b9b6ae',
  wood: '#8a5a2b', woodLight: '#a56d36', woodDark: '#5f3c19',
  steel: '#9aa3ad', steelLight: '#c5ccd4', steelDark: '#5d656f',
  glassFill: 'rgba(170,210,255,0.35)', glassFrame: '#7a8594', glassStreak: 'rgba(255,255,255,0.45)',
  amber: '#e6a93c', amberInk: '#2a1f08',
  marble: '#e8e4dc', marbleAlt: '#d6d1c7',
  /* The road is lifted three steps from `#3a3d44`. Under the focus veil that value came out rgb(32,36,57) — the
     darkest thing in six delivered scenes by a wide margin, so the bottom sixth of every floor shot read as the
     canvas running out rather than as a street (visual QA R2-M5). */
  asphalt: '#54585f', kerb: '#b8b3a8', pavement: '#a89f91',
  screenBg: '#0b0d11', screenFrame: '#3a4050', screenText: '#f3f5f9', screenMuted: '#b9c2d6', screenInk: '#000000',
  /* A wall screen is a mounted object, not a hole in the wall: a bezel around the glass, a lit top edge, and a
     shadow under it so it seats. Without these the screens read as pure-black slabs floating free of the room. */
  screenBezel: '#2b3040', screenBezelEdge: '#171b24', screenBezelLit: '#454c60',
  /** status colours for meters and badges: never amber unless the meter is actually asking for attention */
  good: '#4cae5c', warn: '#e0a030', bad: '#c0392b', barTrack: '#2a2e37',
  wipe: '#ffffff',
  glassLit: '#5ad1ff', minimapBg: '#0e1014',
  /**
   * What is in the sky besides the gradient. The sun is a pale warm white, not the amber `#e6a93c`: amber is the
   * one colour this product spends on attention (the elevator digits, the LIVE badge, the caret, badge counts),
   * and a sun in it made the day sky look like it was asking to be clicked (visual QA R-M6).
   */
  sun: '#fff3d2', sunRim: '#f6dfa8', moon: '#e4e8f2', moonRim: '#a8b1c6', crater: '#c9d0e0',
  labelInk: '#ffffff', labelStroke: '#000000',
  /** the letter-badge behind a sprite's current tool: one colour per tool family, never amber */
  tool: { browser: '#2a6fdb', terminal: '#2b2f3a', envelope: '#c0392b', doc: '#7a5c2e', chart: '#2e7d32', chat: '#6a3fb0' },
  /**
   * What a wall screen shows at the tower elevation, where its own words are drawn at half a screen pixel per
   * world pixel and hidden. Ten near-black slabs read as screens that failed to load rather than as screens too
   * small to read (visual QA R2-I2), so each draws a lit title bar and a row per line it is carrying, in a colour
   * its kind implies. None of them is the accent: amber stays the chrome's action colour.
   */
  surfaceMark: {
    terminal: '#5ad1ff', billboard: '#2a6fdb', bank: '#4cae5c', vault: '#b98ef2', whiteboard: '#e8e4dc',
    noticeboard: '#6a3fb0', workshop: '#4e9af2', postoffice: '#c0392b', cabin: '#3fb8a6', newsstand: '#9aa3ad',
  } as Record<string, string>,
  bubbleFill: '#ffffff', bubbleInk: '#111111',
  bubbleThoughtFill: '#f4f6fa', bubbleThoughtStroke: '#9aa3b5', bubbleThoughtInk: '#4b5160',
  bubbleActionFill: '#1b1f2a', bubbleActionStroke: '#343a48', bubbleActionInk: '#e7e9ee',
  /** street planting: two greens desaturated into the tower's range so six planters stop shouting over the sprites */
  leaf: '#6f9f6a', leafDark: '#4d7a4c', leafLight: '#8ab585',
  monitorOff: '#1b1f2a', monitorOn: '#5ad1ff', monitorGlyph: '#ffffff',
  water: '#9ad0ff', waterLight: '#e6f4ff', waterDark: '#7cb8e8',
  steam: 'rgba(255,255,255,0.7)',
  /**
   * The two colours the day/night tint ramps through. `duskWarm` is new: the tint used to go straight to the
   * violet `dusk`, so at 19:00 — the hour the sky is at its warmest of the whole day — the building came out
   * 87 % of noon and slightly *cooler*, and `09c-tower-dusk` showed a noon building under a sunset (visual QA
   * R2-I4). A sunset throws warm light on what it falls on. Early dusk and dawn are warm; the violet arrives by
   * half past eight, with the sky.
   */
  duskWarm: '#6b3a22', dusk: '#3b2a4a', night: '#0a1030',
  /* [zenith, horizon]. Warm low and cool high, at every hour: the dusk pair used to be the other way round, which
     put a flat orange slab across the top of four scenes. `evening` is the stop between dusk and night — without
     it any blend from an orange horizon to a navy one passes through mud or through red. */
  sky: { day: ['#9ec7ee', '#dfeaf5'], dusk: ['#6a4c8a', '#f0a36b'], evening: ['#332a5c', '#7a5c93'], night: ['#0b1026', '#1b2140'] },
  windowDay: '#a9d6ff', windowDusk: '#f3b884', windowNight: '#ffe08a',
  skin: ['#f1c9a5', '#d9a577', '#b07a4e', '#6e4a30'],
  hair: ['#2b2118', '#4a2c17', '#6d4c41', '#c0392b', '#d9b26a', '#3a3a3a'],
  trousers: { chief: '#23262e', manager: '#2b3040', member: '#2b3040', advisor: '#3b3a45', owner: '#1f2229' },
  owner: '#2b2f3a',
} as const;

/**
 * The tint a zone shows in the chrome: its own accent from the campus palette, so the rail tab, the minimap rug
 * and the desk chips in that zone are all one colour. There are only four accents and eleven zones — Dev, QA and
 * Research share indigo because they are one division — so the rail's own labels do the telling apart.
 */
export const ZONE_TINT: Record<string, string> = {
  boardroom: '#78849A', ceo_office: '#78849A', meetingroom: '#78849A',
  ops: '#7E9A80', pantry: '#A79C8C', lobby: '#A79C8C', lounge: '#A79C8C',
  research: '#6472C4', dev: '#6472C4', qa: '#6472C4', sales: '#D49A4C',
};
export const zoneTint = (id: string): string => ZONE_TINT[id] ?? '#A79C8C';

/** The same four accents, keyed by the division a team belongs to — what the Org sheet groups by. */
export const DIVISION_TINT: Record<string, string> = {
  executive: '#78849A', board: '#78849A', technology: '#6472C4', revenue: '#D49A4C',
  operations: '#7E9A80', security: '#7E9A80', other: '#A79C8C',
};
export const divisionTint = (id: string): string => DIVISION_TINT[id] ?? DIVISION_TINT.other;

/** chief: title starts with "Chief" or the role is the CEO; advisor: on the board; manager: leads a team; else member. */
export function familyOf(role: string, o: { title?: string; team?: string; isLead?: boolean }): Exclude<Family, 'owner'> {
  if (role === 'ceo' || /^chief\b/i.test(o.title ?? '')) return 'chief';
  if (o.team === 'board') return 'advisor';
  if (o.isLead) return 'manager';
  return 'member';
}

/**
 * Ring colours that are fixed rather than hashed. The CEO's used to be `#f2c14e`, which is the amber family the
 * palette reserves for attention: in `08-board` the CEO alone carried a gold disc among blue and purple ones and
 * read as the thing asking to be looked at (visual QA M7/R-M1). Teal says "this one is different" without
 * borrowing the accent.
 */
const RING_OVERRIDES: Record<string, string> = { ceo: '#3fb8a6', cto: '#4e9af2', coo: '#b98ef2' };
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
