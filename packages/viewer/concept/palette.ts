/**
 * SP9 concept — the campus palette.
 *
 * One warm light at the top-left, one restrained set of materials, one calm accent per division. Every colour is a
 * `#rrggbb` string so the same table can feed canvas, Phaser tints and CSS custom properties later; nothing here
 * touches the DOM, so the palette is testable on its own.
 *
 * The rule the whole render obeys: a material is a *base* colour, and a surface is that base seen under the light —
 * `lit()` for a face turned to the top-left, `dim()` for the face turned away, `top()` for a face turned up. No
 * colour is picked by eye twice; every shade in the picture is derived from one of the bases below.
 */

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const hex2 = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');

export function hsl(h: number, s: number, l: number): string {
  const hh = ((((h % 360) + 360) % 360) / 360);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => { const u = (t + 1) % 1; if (u < 1 / 6) return p + (q - p) * 6 * u; if (u < 1 / 2) return q; if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6; return p; };
  return s === 0 ? `#${hex2(l)}${hex2(l)}${hex2(l)}` : `#${hex2(f(hh + 1 / 3))}${hex2(f(hh))}${hex2(f(hh - 1 / 3))}`;
}

export function toHsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** Lightness step, in 0–1 units. Positive lightens. */
export function shade(hex: string, dL: number): string { const c = toHsl(hex); return hsl(c.h, c.s, clamp01(c.l + dL)); }
/** Lightness step that also warms (positive hue delta) or cools it — how a single light touches a material. */
export function warm(hex: string, dL: number, dH = 0, dS = 0): string { const c = toHsl(hex); return hsl(c.h + dH, clamp01(c.s + dS), clamp01(c.l + dL)); }
/** Straight channel mix; no hue arc to run the wrong way round the wheel. */
export function mix(a: string, b: string, t: number): string {
  const u = clamp01(t), x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const ch = (sh: number): string => hex2((((x >> sh) & 255) + ((((y >> sh) & 255)) - ((x >> sh) & 255)) * u) / 255);
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp01(a)})`;
}

/** A face turned up: the light hits it flat. */
export const top = (base: string): string => warm(base, 0.07, 3, -0.01);
/** A face turned towards the light (screen-left). */
export const lit = (base: string): string => warm(base, 0.015, 2, 0);
/** A face turned away from it (screen-right). */
export const dim = (base: string): string => warm(base, -0.08, -2, 0.01);

export const MATERIAL = {
  /** the floor: a warm off-white poured plane */
  floor: '#F4EFE6',
  floorSeam: '#E4DACA',
  /** the walk-ways: the same plane, polished a step brighter */
  path: '#FBF8F2',
  slabEdge: '#D8CDBA',
  /** the perimeter: plaster and the glass curtain */
  plaster: '#EBE3D6',
  mullion: '#A9A296',
  glass: '#CFE0E4',
  /** anodised aluminium: partition rails and posts, so the accent stays a hairline and not a frame */
  rail: '#B6B9BC',
  /** walnut, for every desk and shelf */
  walnut: '#8B5E3B',
  walnutPale: '#A8814F',
  /** charcoal, for every chair */
  charcoal: '#3B4048',
  /** the screens: soft dark panels */
  screen: '#222834',
  screenInk: '#C8D2DE',
  screenDim: '#7F8B9B',
  /** planting */
  leaf: '#6E9A6C',
  leafDeep: '#4F7A55',
  leafPale: '#8FB483',
  pot: '#C08A63',
  /** paper, mugs, whiteboard */
  paper: '#FAF7F1',
  board: '#FCFBF8',
  ink: '#2C2A27',
  /** the plates labels sit on */
  plate: '#FFFFFF',
} as const;

export type AccentName = 'indigo' | 'sage' | 'amber' | 'slate' | 'neutral';

/** One calm accent per division. `rug` tints the floor, `chip` the desk plates and partition rails. */
export const ACCENT: Record<AccentName, { base: string; rug: string; chip: string; ink: string }> = {
  indigo: { base: '#6472C4', rug: '#DFE0F0', chip: '#5A68BC', ink: '#39408C' },
  sage: { base: '#7E9A80', rug: '#DEE6DC', chip: '#6F8C74', ink: '#3F5847' },
  amber: { base: '#D49A4C', rug: '#F1E4CF', chip: '#C08834', ink: '#7A5216' },
  slate: { base: '#78849A', rug: '#E0E3EA', chip: '#6B788F', ink: '#3E4757' },
  neutral: { base: '#A79C8C', rug: '#EDE7DC', chip: '#8E8577', ink: '#4E483F' },
};

/** Outfit families. Distinct silhouette + colour per role family, so a glance at the campus reads as an org. */
export const OUTFIT = {
  chief: { shirt: '#3E4657', trouser: '#2E343F' },
  advisor: { shirt: '#7E9A80', trouser: '#4A5350' },
  manager: { shirt: '#6472C4', trouser: '#3A3F55' },
  member: { shirt: '#E4DCCC', trouser: '#5A5347' },
  maker: { shirt: '#5E9AA0', trouser: '#3C4A4E' },
  seller: { shirt: '#D49A4C', trouser: '#5A4630' },
  owner: { shirt: '#C97B5A', trouser: '#4A382E' },
} as const;
export type OutfitName = keyof typeof OUTFIT;

export const HAIR = ['#2B2320', '#4A3226', '#6E4A2E', '#8C6239', '#B08549', '#7A6A62', '#D8CEC2', '#1F1B19'] as const;
export const SKIN = ['#F5D8BC', '#E5B995', '#CE9A70', '#A9714B', '#7C4E32', '#5E3828'] as const;

/**
 * The light at an hour. One record drives the whole picture: the wash over the floor, how long and how dark a
 * shadow gets, whether the windows burn and whether the desk lamps are on. Dusk paints the campus, not the sky.
 */
export interface Light {
  name: string;
  /**
   * The hour, as one multiply across the finished campus: warm where the light comes from, cool and deep where it
   * has not reached. Multiply rather than a tinted veil, because a veil lifts the blacks and the dusk then reads as
   * a filter over a daytime office instead of as evening in the room.
   */
  mulFrom: string; mulTo: string; mulAlpha: number;
  /** a warm bloom added back where the windows are */
  washFrom: string; washTo: string; washAlpha: number;
  /** the ground the campus slab floats on */
  groundFrom: string; groundTo: string;
  /** cast shadows: how far a unit of height throws, and how dark the near end is */
  shadowLen: number; shadowAlpha: number; shadowTint: string;
  /** the curtain wall, read top to bottom: upper sky, the band the sun is in, the glow at the horizon */
  skyHigh: string; sky: string; skyLow: string; glassGlow: number;
  /** the pool of light the windows lay on the floor */
  poolAlpha: number; poolTint: string;
  lamps: boolean;
  /** a cool fill in the shade, so shadows are not grey holes */
  bounce: string; bounceAlpha: number;
}

export const DAY: Light = {
  name: 'day',
  mulFrom: '#FFFDF4', mulTo: '#E6E7F2', mulAlpha: 0.5,
  washFrom: '#FFF7E4', washTo: '#ECE7F1', washAlpha: 0.1,
  groundFrom: '#141821', groundTo: '#222630',
  shadowLen: 1.15, shadowAlpha: 0.24, shadowTint: '#4B4034',
  skyHigh: '#8FB6D8', sky: '#C4DAE8', skyLow: '#EFF3F5', glassGlow: 0.12,
  poolAlpha: 0.2, poolTint: '#FFFBEF',
  lamps: false,
  bounce: '#8EA8C4', bounceAlpha: 0.05,
};

export const DUSK: Light = {
  name: 'dusk',
  mulFrom: '#FFDCA8', mulTo: '#A896BC', mulAlpha: 0.56,
  washFrom: '#FFC076', washTo: '#6B5A8E', washAlpha: 0.13,
  groundFrom: '#181425', groundTo: '#33232E',
  shadowLen: 3.0, shadowAlpha: 0.34, shadowTint: '#3A2B4A',
  skyHigh: '#6A5590', sky: '#E88742', skyLow: '#FFCE8C', glassGlow: 0.4,
  poolAlpha: 0.34, poolTint: '#FFC070',
  lamps: true,
  bounce: '#6B5C93', bounceAlpha: 0.08,
};
