/**
 * The campus palette.
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
  /** pure white and pure black: highlights, rims, the shadow a plate casts */
  white: '#FFFFFF', black: '#000000',
  /** the ink a bubble is set in, and the quieter ink a thought is */
  bubbleInk: '#25231F', thoughtInk: '#5A5348', actionInk: '#F2EEE6', actionFill: '#1D1B18',
  /** small objects on a desk or a counter */
  keyboard: '#D9D4CB', mug: '#E8E1D4', mugWarm: '#C9805E', mugPale: '#EFE9DD',
  kettle: '#9BA3AD', jar: '#D9C59B', stone: '#E7E0D2', stoneTop: '#F3EDE1', file: '#D9CFBE',
  /** a monitor's lit bezel, the green of a passing test, the cool glow a screen throws */
  monitorLit: '#8A929C', pass: '#8FD6A0', screenGlow: '#8FB4E8', glassLens: '#DCE8F0', spectacle: '#2E3238',
  /** eyes, and the warm rim a dusk lays along a shoulder */
  eye: '#2A2320', rimDusk: '#FFD9A8',
  /** lamp shades, lit and unlit, and the pool they throw */
  shadeOn: '#F2E3C4', shadeOff: '#D8D2C6', shadeOnWarm: '#E4CE9E', shadeOffWarm: '#BEB8AC',
  floorShadeOn: '#F6E7C6', floorShadeOff: '#E6D0A8', lamp: '#FFC878', lampDeep: '#FFB661',
  /** the noticeboard's cork-coloured paper */
  notice: '#E9DFC8',
  /** the bloom over the ground: warm at dusk, cool by day, and the city's own at night */
  bloomDusk: '#FF9E52', bloomDay: '#8FB4D8', bloomNight: '#3A4A86',
  /** the one accent the chrome spends on attention — a live stream's pulse, and nothing else in the world */
  attention: '#E6A93C',
  /** the shade that seats a live frame into its bezel */
  frameShade: '#0A0C12',
  /** a failed job's badge, and someone who has gone offline */
  bad: '#C0392B', offline: '#6B6558',
} as const;

/** The letter-chip over someone's head while a tool is running: one colour per family, and never the accent. */
export const TOOL = {
  browser: '#3C6BC4', terminal: '#3B4048', envelope: '#B4553F', doc: '#8B5E3B', chart: '#4F7A55', chat: '#6A5BA8',
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

/**
 * Which accent a division wears, and which a zone wears. These two tables are the only place the campus decides
 * that Technology is indigo — the name plate over a person, the rug under a zone, the rail tab and the Org sheet
 * all read them, so none of them can drift from the others.
 *
 * Dev, QA and Research share indigo because they are one division; the pantry, lobby and lounge are neutral
 * because they belong to nobody. That is five colours over eleven zones, not four: the four division accents plus
 * the neutral the shared rooms wear.
 */
export const DIVISION_ACCENT: Record<string, AccentName> = {
  executive: 'slate', board: 'slate', technology: 'indigo', revenue: 'amber',
  operations: 'sage', security: 'sage', other: 'neutral',
};
export const ZONE_ACCENT: Record<string, AccentName> = {
  boardroom: 'slate', ceo_office: 'slate', meetingroom: 'slate', ops: 'sage',
  pantry: 'neutral', lobby: 'neutral', lounge: 'neutral',
  research: 'indigo', dev: 'indigo', qa: 'indigo', sales: 'amber',
};
export const accentOfDivision = (id: string): AccentName => DIVISION_ACCENT[id] ?? 'neutral';
export const accentOfZone = (id: string): AccentName => ZONE_ACCENT[id] ?? 'neutral';
/** The chip a division's people wear on their name plate, and the dot they are on the minimap. */
export const divisionChip = (id: string): string => ACCENT[accentOfDivision(id)].chip;
/** The chip a zone's desk plates and rail tab wear. */
export const zoneChip = (accent: AccentName): string => ACCENT[accent].chip;

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

/**
 * Night. The campus is lit from inside now: the multiply goes deep and cool, the windows are dark glass with the
 * city behind them, and the only warm things in the frame are the desk lamps and the screens. Shadows shorten and
 * soften, because the light is overhead and local rather than raking in from one window wall.
 */
export const NIGHT: Light = {
  name: 'night',
  // Deep enough to *be* night. At `#8E90B4` over 0.62 the off-white floor came back at 177 — a daylight office
  // behind a blue filter, with the lamps invisible against it, which is what the first campus night render showed
  // (visual QA S9-4). These numbers put the floor between 106 near the windows and 68 away from them, so the desk
  // lamps and the screens are the only lit things in the frame, which is the whole point of the hour.
  mulFrom: '#5C5F86', mulTo: '#2E3050', mulAlpha: 0.88,
  washFrom: '#5A6AA8', washTo: '#2A2E4A', washAlpha: 0.1,
  groundFrom: '#080A12', groundTo: '#12131E',
  shadowLen: 0.85, shadowAlpha: 0.3, shadowTint: '#12121F',
  skyHigh: '#0A0E22', sky: '#15193A', skyLow: '#2A2E55', glassGlow: 0.18,
  poolAlpha: 0.06, poolTint: '#7C8CC8',
  lamps: true,
  bounce: '#7E8CC0', bounceAlpha: 0.06,
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


/** Every stop the hour ramps through, in order. */
const RAMP: { at: number; light: Light }[] = [
  { at: 0, light: NIGHT }, { at: 6.5, light: NIGHT }, { at: 8.5, light: DAY },
  { at: 16.5, light: DAY }, { at: 19, light: DUSK }, { at: 21, light: NIGHT }, { at: 24, light: NIGHT },
];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * The light at an hour, as one record.
 *
 * Every field is interpolated, colours included, so 18:20 is not "day" and not "dusk" but the campus twenty
 * minutes before the sunset it is heading into. The tower's three buckets made the office change palette in one
 * frame at a boundary nobody could see coming; a ramp is what an office at a window actually does.
 */
export function lightAt(hour: number): Light {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < RAMP.length - 2 && RAMP[i + 1].at <= h) i++;
  const a = RAMP[i], b = RAMP[i + 1];
  const t = b.at === a.at ? 0 : Math.max(0, Math.min(1, (h - a.at) / (b.at - a.at)));
  if (t <= 0) return a.light;
  if (t >= 1) return b.light;
  const A = a.light, B = b.light;
  const c = (k: 'mulFrom' | 'mulTo' | 'washFrom' | 'washTo' | 'groundFrom' | 'groundTo' | 'shadowTint' | 'skyHigh' | 'sky' | 'skyLow' | 'poolTint' | 'bounce'): string => mix(A[k], B[k], t);
  const n = (k: 'mulAlpha' | 'washAlpha' | 'shadowLen' | 'shadowAlpha' | 'glassGlow' | 'poolAlpha' | 'bounceAlpha'): number => lerp(A[k], B[k], t);
  return {
    name: t < 0.5 ? A.name : B.name,
    mulFrom: c('mulFrom'), mulTo: c('mulTo'), mulAlpha: n('mulAlpha'),
    washFrom: c('washFrom'), washTo: c('washTo'), washAlpha: n('washAlpha'),
    groundFrom: c('groundFrom'), groundTo: c('groundTo'),
    shadowLen: n('shadowLen'), shadowAlpha: n('shadowAlpha'), shadowTint: c('shadowTint'),
    skyHigh: c('skyHigh'), sky: c('sky'), skyLow: c('skyLow'), glassGlow: n('glassGlow'),
    poolAlpha: n('poolAlpha'), poolTint: c('poolTint'),
    // Lamps come on with the dusk rather than at a stroke of the clock, and they are the one thing that cannot be
    // half on: the ramp turns them on as soon as either end of the step wants them and the sun is past its best.
    lamps: A.lamps || B.lamps ? (A.lamps ? true : t > 0.25) : false,
    bounce: c('bounce'), bounceAlpha: n('bounceAlpha'),
  };
}

/** WCAG relative luminance of a `#rrggbb`, 0 black to 1 white. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** WCAG 2.1 contrast between two `#rrggbb`. The campus's own, so the palette can be held to it under test. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The floor, as it actually is at this hour.
 *
 * `paintHour` lays one multiply over the whole campus, so the off-white the floor is made of is not the colour
 * anything on the floor is seen against: at midnight it is a dark blue-grey, and a line drawn dark enough to read
 * at noon disappears into it. Taken at the far end of the multiply's gradient — the part of the floor furthest
 * from the light — because that is where anything drawn on it has the least to work with.
 */
export function floorAt(light: Light): string {
  const n = parseInt(MATERIAL.floor.slice(1), 16), m = parseInt(light.mulTo.slice(1), 16);
  const ch = (sh: number): number => { const f = (n >> sh) & 255, t = (f * ((m >> sh) & 255)) / 255; return f + (t - f) * light.mulAlpha; };
  return `#${hex2(ch(16) / 255)}${hex2(ch(8) / 255)}${hex2(ch(0) / 255)}`;
}

/**
 * The ink that reads on the floor at this hour: the campus's own dark by day and dusk, white once the office is
 * lit from inside. Everything the owner is meant to be able to *use* rather than look at — a selected line's
 * casing, a port's rim — is drawn in it, over the hour rather than under it, so it holds at 3:1 at every hour.
 * `ui/tokens.test.ts` asserts exactly that.
 */
export const onFloorInk = (light: Light): string => (luminance(floorAt(light)) > 0.2 ? MATERIAL.ink : MATERIAL.white);

/** How strongly the desk lamps and screens burn at this hour: 0 by day, 1 after dark. */
export function lampStrength(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 8.5 && h < 17) return 0;
  if (h >= 17 && h < 19) return (h - 17) / 2;
  if (h >= 19 || h < 6) return 1;
  if (h >= 6 && h < 8.5) return 1 - (h - 6) / 2.5;
  return 1;
}
