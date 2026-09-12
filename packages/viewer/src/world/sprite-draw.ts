/**
 * Pure drawers for the 16×24 body sheet (31 named frames, see frames.ts) and the 8×6 face overlay sheet.
 * Bodies are outlined in their own darkest colour; faces have no outline. Light from the top-left as for tiles.
 */
import { px, hline, vline, type Px } from './tiles-draw.js';
import { hashOf, hexToHsl, hsl, PALETTE, type RolePalette, type Family } from './palette.js';
import { FRAMES } from './frames.js';
import type { Mood } from '../state.js';

export const SPRITE_W = 16, SPRITE_H = 24;
export const FACE_W = 8, FACE_H = 6;
export interface SpriteOpts { headset: boolean; hairShape: 0 | 1 | 2 | 3; hoodie: boolean }

export function spriteOpts(role: string, team?: string): SpriteOpts { const h = hashOf(role); return { headset: team === 'sales', hairShape: ((h >>> 4) % 4) as 0 | 1 | 2 | 3, hoodie: ((h >>> 2) & 1) === 1 }; }
export const offset = (p: Px, ox: number, oy: number): Px => ({ fill: (x, y, w, h, c) => p.fill(ox + x, oy + y, w, h, c) });

/** The darkest shade of `hex`, floored so a sprite outline never renders pure black (binding rule: own darkest colour, never black). */
function outlineOf(hex: string): string { const c = hexToHsl(hex); return hsl(c.h, c.s, Math.max(0.06, c.l - 0.2)); }

/** A rect with a 1 px outline, clipped to the frame so the outline never leaves the cell. */
function outlined(p: Px, x: number, y: number, w: number, h: number, c: string, o: string): void {
  const x0 = Math.max(0, x - 1), y0 = Math.max(0, y - 1), x1 = Math.min(SPRITE_W, x + w + 1), y1 = Math.min(SPRITE_H, y + h + 1);
  p.fill(x0, y0, x1 - x0, y1 - y0, o); p.fill(x, y, w, h, c);
}

type Dir = 0 | 1 | 2 | 3;
interface Body { pal: RolePalette; family: Family; opts: SpriteOpts; o: string }

function head(p: Px, b: Body, dir: Dir, dy = 0): void {
  const { hair, skin } = b.pal;
  outlined(p, 4, 1 + dy, 8, 9, skin, b.o);
  p.fill(4, 1 + dy, 8, 4, hair);
  if (b.opts.hairShape === 1) { vline(p, 4, 5 + dy, 3, hair); vline(p, 11, 5 + dy, 3, hair); }          // long
  if (b.opts.hairShape === 2) px(p, 6, 1 + dy, skin);                                                  // parting
  if (b.opts.hairShape === 3) p.fill(6, 0 + dy, 4, 1, hair);                                          // bun / cap
  if (dir === 3) p.fill(4, 1 + dy, 8, 6, hair);                                                       // back of the head
  if (b.opts.headset) { hline(p, 4, 2 + dy, 8, '#23262e'); if (dir !== 3) p.fill(dir === 1 ? 11 : 3, 6 + dy, 2, 1, '#23262e'); }
}

function torso(p: Px, b: Body, dy = 0): void {
  const { shirt, shirtDark, accent, skin } = b.pal;
  const y = 10 + dy;
  switch (b.family) {
    case 'chief': outlined(p, 2, y, 12, 8, shirtDark, b.o); p.fill(6, y, 4, 4, shirt); px(p, 6, y + 1, shirtDark); px(p, 9, y + 1, shirtDark); p.fill(7, y + 1, 2, 5, accent); break;   // blazer, lapel V, tie
    case 'manager': outlined(p, 3, y, 10, 8, shirt, b.o); hline(p, 3, y, 10, shirtDark); vline(p, 7, y, 5, accent); break;                                                       // shirt, lanyard
    // Four advisor silhouettes, picked by the same hash that picks hair: three cardigans side by side at one table
    // read as one person drawn three times (visual QA I9), and an advisor is the only family seen as a row.
    case 'advisor': {
      outlined(p, 3, y, 10, 8, shirt, b.o);
      switch (b.opts.hairShape) {
        case 1: hline(p, 3, y, 10, shirtDark); p.fill(5, y - 1, 6, 2, accent); px(p, 9, y + 1, accent, 1, 4); break;   // scarf over the shoulders
        case 2: p.fill(6, y, 4, 5, shirtDark); px(p, 4, y, shirtDark, 2, 3); px(p, 10, y, shirtDark, 2, 3); break;    // open jacket, wide lapels
        case 3: hline(p, 3, y, 10, shirtDark); p.fill(7, y + 1, 2, 6, accent); p.fill(6, y, 4, 1, shirtDark); break;   // collar and tie
        default: vline(p, 7, y + 1, 6, shirtDark); px(p, 7, y + 2, accent); px(p, 7, y + 5, accent); break;            // cardigan, buttons
      }
      break;
    }
    case 'owner': outlined(p, 3, y, 10, 8, PALETTE.owner, b.o); p.fill(5, y - 1, 6, 1, PALETTE.owner); break;                                                                    // turtleneck collar
    default: outlined(p, 3, y, 10, 8, shirt, b.o); if (b.opts.hoodie) { px(p, 3, y - 1, shirtDark, 2, 1); px(p, 11, y - 1, shirtDark, 2, 1); hline(p, 5, y + 5, 6, shirtDark); } else hline(p, 3, y, 10, shirtDark); break;   // hoodie (hood bump, pocket) or t-shirt
  }
  if (b.family === 'manager') { px(p, 2, y + 4, skin, 1, 2); px(p, 13, y + 4, skin, 1, 2); }   // rolled sleeves
}

function arms(p: Px, b: Body, step: number, dir: Dir, dy = 0): void {
  const { skin } = b.pal;
  const l = step === 1 ? 1 : 2, r = step === 3 ? 14 : 13;
  if (dir !== 2) p.fill(l, 11 + dy, 1, 5, skin);
  if (dir !== 1) p.fill(r, 11 + dy, 1, 5, skin);
}
function legs(p: Px, b: Body, step: number): void {
  const t = b.pal.trousers;
  outlined(p, 4, 18, 3, step === 0 ? 5 : 6, t, b.o); outlined(p, 9, 18, 3, step === 2 ? 5 : 6, t, b.o);
  if (step === 1 || step === 3) p.fill(6, 22, 4, 1, t);   // pass: feet together
}
/**
 * A seated lower half: a thigh, two shins with a gap, and a shoe row — the shape `legs()` already draws standing.
 *
 * It used to be one 8 x 3 outlined slab plus a 3 x 3 foot block, both in the family's trousers under a dark
 * outline, so four advisors at one table each carried a featureless dark rectangle where a person's legs should
 * be (visual QA R-I5). `x` is the left edge of the thigh; the knees face the way the sprite is turned.
 */
function sitLegs(p: Px, b: Body, x: number): void {
  // A step lighter than the standing trousers. At 1 x a seated figure is 6 px of leg under a 1 px outline on every
  // side, so at the family's own `#3b3a45` there was more outline than trouser and the lower half went back to
  // reading as one dark block (visual QA R2-M2). Standing legs are 6 px tall and keep the darker value.
  const c = hexToHsl(b.pal.trousers), t = hsl(c.h, c.s, Math.min(0.6, c.l + 0.10)), shoe = outlineOf(b.pal.trousers);
  outlined(p, x, 18, 8, 2, t, b.o);                 // thigh, along the seat
  // Three wide with two of outline between them, which is exactly the proportion `legs()` reads as two legs at
  // this size. Two-wide shins were tried first: a 1 px outline each side left more outline than trouser, and the
  // whole lower half went back to being one dark block.
  outlined(p, x, 20, 3, 3, t, b.o);                 // near shin
  outlined(p, x + 5, 20, 3, 3, t, b.o);             // far shin, with a gap between them
  p.fill(x, 22, 3, 1, shoe); p.fill(x + 5, 22, 3, 1, shoe);
}
function seatedBase(p: Px, b: Body): void { head(p, b, 0); torso(p, b); outlined(p, 4, 18, 8, 3, b.pal.trousers, b.o); }
const cup = (p: Px, x: number, y: number): void => { p.fill(x, y, 3, 3, '#f5f5f0'); px(p, x + 3, y + 1, '#f5f5f0'); px(p, x + 1, y - 1, '#cfd6e6'); };

/** One named frame at (0,0) of `p`. Unknown names draw `idle:0`. */
export function drawSpriteFrame(p: Px, name: string, pal: RolePalette, family: Family, opts: SpriteOpts): void {
  const b: Body = { pal, family, opts, o: outlineOf(pal.shirtDark) };
  const dy = family === 'advisor' ? 1 : 0;
  const [kind, a, s] = name.split(':');
  if (kind === 'walk') { const dir = Number(a) as Dir, step = Number(s); head(p, b, dir, dy); torso(p, b, dy); arms(p, b, step, dir, dy); legs(p, b, step); return; }
  if (kind === 'idle') { const dir = Number(a) as Dir; head(p, b, dir, dy); torso(p, b, dy); arms(p, b, 0, dir, dy); legs(p, b, 0); return; }
  const { skin } = pal;
  switch (a) {
    case 'seated': seatedBase(p, b); p.fill(2, 15, 4, 2, skin); p.fill(10, 15, 4, 2, skin); return;
    case 'typing_a': seatedBase(p, b); p.fill(2, 15, 4, 2, skin); p.fill(10, 14, 4, 2, skin); return;
    case 'typing_b': seatedBase(p, b); p.fill(2, 14, 4, 2, skin); p.fill(10, 15, 4, 2, skin); return;
    case 'read': seatedBase(p, b); p.fill(5, 12, 6, 5, '#f5f5f0'); hline(p, 6, 13, 4, '#8d93a5'); hline(p, 6, 15, 3, '#8d93a5'); p.fill(3, 14, 2, 2, skin); p.fill(11, 14, 2, 2, skin); return;
    case 'phone': seatedBase(p, b); p.fill(2, 15, 4, 2, skin); p.fill(11, 6, 2, 4, skin); p.fill(12, 4, 2, 5, '#23262e'); return;
    case 'coffee': head(p, b, 0, dy); torso(p, b, dy); p.fill(3, 11 + dy, 1, 5, skin); p.fill(12, 11 + dy, 1, 3, skin); cup(p, 11, 9 + dy); legs(p, b, 0); return;
    case 'wave': head(p, b, 0, dy); torso(p, b, dy); p.fill(3, 11 + dy, 1, 5, skin); p.fill(13, 6 + dy, 1, 6, skin); p.fill(12, 5 + dy, 3, 1, skin); legs(p, b, 0); return;
    case 'stretch': head(p, b, 0, dy); torso(p, b, dy); p.fill(2, 4 + dy, 1, 7, skin); p.fill(13, 4 + dy, 1, 7, skin); legs(p, b, 0); return;
    case 'ride': head(p, b, 0, dy); torso(p, b, dy); p.fill(2, 11 + dy, 1, 5, skin); p.fill(13, 11 + dy, 1, 4, skin); px(p, 13, 15 + dy, PALETTE.steelLight); legs(p, b, 1); return;
    case 'sit_side_l': head(p, b, 1, dy); torso(p, b, dy); p.fill(3, 12 + dy, 1, 4, skin); sitLegs(p, b, 1); return;
    case 'sit_side_r': head(p, b, 2, dy); torso(p, b, dy); p.fill(12, 12 + dy, 1, 4, skin); sitLegs(p, b, 7); return;
    default: head(p, b, 0, dy); torso(p, b, dy); arms(p, b, 0, 0, dy); legs(p, b, 0);
  }
}

/** The whole sheet: frame i at x = 16 i, in FRAMES order. */
export function drawSpriteSheet(p: Px, pal: RolePalette, family: Family, opts: SpriteOpts): void { FRAMES.forEach((name, i) => drawSpriteFrame(offset(p, i * SPRITE_W, 0), name, pal, family, opts)); }

// ---- faces ----
export const MOODS: Mood[] = ['neutral', 'happy', 'worried', 'puzzled', 'asleep', 'thinking'];
export const FACE_VARIANTS = [{ talk: false, glasses: false, suffix: '' }, { talk: true, glasses: false, suffix: ':talk' }, { talk: false, glasses: true, suffix: ':g' }, { talk: true, glasses: true, suffix: ':talk:g' }] as const;
const FACE_ROWS: (Mood | 'blink')[] = [...MOODS, 'blink'];
export const FACE_SHEET_W = 3 * FACE_W, FACE_SHEET_H = FACE_ROWS.length * FACE_VARIANTS.length * FACE_H;
/** Sheet layout: row = mood × variant, column = direction 0/1/2. */
export const FACE_FRAMES: { name: string; x: number; y: number }[] = FACE_ROWS.flatMap((mood, r) => FACE_VARIANTS.flatMap((v, vi) => [0, 1, 2].map((d) => ({ name: `${mood}:${d}${v.suffix}`, x: d * FACE_W, y: (r * FACE_VARIANTS.length + vi) * FACE_H }))));

function drawFace(p: Px, mood: Mood | 'blink', dir: 0 | 1 | 2, talk: boolean, glasses: boolean): void {
  const eye = '#1b1f2a', mouth = '#7a3b2e', brow = '#3a2a1a', glass = '#5d656f', glassLit = '#c5ccd4';
  const eyes = dir === 0 ? [1, 5] : dir === 1 ? [0, 3] : [4, 7];
  const mouthX = dir === 0 ? 3 : dir === 1 ? 1 : 5, mouthW = dir === 0 ? 2 : 1;
  const eyeY = mood === 'thinking' ? 1 : 2;
  const ew = (ex: number): number => Math.min(2, FACE_W - ex);   // a 2 px eye never crosses the cell edge (dir 2 has an eye at x 7)
  for (const ex of eyes) {
    if (mood === 'asleep' || mood === 'blink') px(p, ex, 2, eye, ew(ex), 1);
    else if (mood === 'happy') px(p, ex, 1, eye, ew(ex), 1);
    else px(p, ex, eyeY, eye);
  }
  if (mood === 'worried') for (const ex of eyes) px(p, ex, 0, brow, ew(ex), 1);
  if (mood === 'puzzled') px(p, dir === 0 ? 5 : eyes[0], 0, brow, 2, 1);
  if (talk) px(p, mouthX, 4, mouth, 2, 2);
  else if (mood === 'happy') px(p, mouthX, 4, mouth, mouthW + 1, 1);
  else if (mood === 'puzzled') px(p, mouthX + (dir === 0 ? 1 : 0), 4, mouth);
  else if (mood !== 'asleep') px(p, mouthX, 4, mouth, mouthW, 1);
  /*
   * Spectacles: a rim either side of each eye and a bridge between the lenses, with a lit pixel on the top-left
   * of the near lens. The old overlay painted a solid bar right across the eye band, so the three advisors had no
   * eyes at all — "three masked men" in the visual QA (I9). The eye pixel itself is never covered.
   */
  if (glasses) {
    for (const ex of eyes) {
      if (ex > 0) px(p, ex - 1, eyeY, glass);
      if (ex + 1 < FACE_W) px(p, ex + 1, eyeY, glass);
    }
    const l = Math.min(eyes[0], eyes[1]) + 2, r = Math.max(eyes[0], eyes[1]) - 1;
    if (r > l) px(p, l, eyeY, glass, r - l, 1);
    if (eyes[0] > 0 && eyeY > 0) px(p, eyes[0] - 1, eyeY - 1, glassLit);
  }
}

export function drawFaceSheet(p: Px): void {
  for (const f of FACE_FRAMES) { const [mood, d, ...rest] = f.name.split(':'); drawFace(offset(p, f.x, f.y), mood as Mood | 'blink', Number(d) as 0 | 1 | 2, rest.includes('talk'), rest.includes('g')); }
}

/**
 * The texture key for a sprite sheet. It must name everything the sheet is drawn from — the sheet uses
 * `rolePalette(role, family)` and `spriteOpts(role, team)`, so two roles that share a `sprite` value would
 * otherwise collide and whichever was rasterised first would win, non-deterministically by construction order.
 */
export function spriteKey(v: { role: string; sprite?: string; family?: string; team?: string }): string {
  return `sprite:${v.sprite || v.role}:${v.role}:${v.team ?? ''}:${v.family ?? 'member'}`;
}
