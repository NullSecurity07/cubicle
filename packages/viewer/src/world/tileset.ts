import Phaser from 'phaser';
import type { Mood, Emote } from '../state.js';
import { TILES, T, COLUMNS, TILE, tilesetMeta } from './tiles.js';
import { DRAW, floorOfName, type Px, type TileName } from './tiles-draw.js';
import { roleColor, floorPalette } from './palette.js';

/** Tile ids come from tiles.ts (shared with scripts/world/tower.ts). Drawn procedurally: CC0-by-construction placeholder art. */
export { TILES, T, COLUMNS, TILE, tilesetMeta };
export { roleColor };

function px(g: CanvasRenderingContext2D, x: number, y: number, c: string, w = 1, h = 1) { g.fillStyle = c; g.fillRect(x, y, w, h); }

/** A `Px` over a canvas context at a pixel offset: what every drawer paints into. */
export function canvasPx(g: CanvasRenderingContext2D, ox: number, oy: number): Px {
  return { fill(x, y, w, h, c) { g.fillStyle = c; g.fillRect(ox + x, oy + y, w, h); } };
}

/** Draws every tile in `TILES` (16 per row, 16 px) into the canvas texture `office`; id = index in TILES. */
export function makeTileset(scene: Phaser.Scene): void {
  if (scene.textures.exists('office')) return;
  const rows = Math.ceil((TILES.length - 1) / COLUMNS);
  const tex = scene.textures.createCanvas('office', COLUMNS * TILE, rows * TILE)!;
  const g = tex.getContext();
  TILES.forEach((name, id) => {
    if (name === 'EMPTY') return;
    const i = id - 1;
    const f = floorOfName(name);
    DRAW[name as Exclude<TileName, 'EMPTY'>](canvasPx(g, (i % COLUMNS) * TILE, Math.floor(i / COLUMNS) * TILE), f ? floorPalette(f) : null);
  });
  tex.refresh();
}

/** Sprite sheet frames beyond the 12 walking frames (4 directions × 3 steps). All face the viewer. */
export const POSE = { SEATED: 12, TYPING: 13, WAVE: 14, STRETCH: 15, COFFEE: 16 } as const;
export const SPRITE_W = 16, SPRITE_H = 24;

/**
 * 16×24 sprite sheet per role: 12 walking frames + seated / typing / wave / stretch / coffee poses, drawn from
 * rectangles. Faces are NOT on the body — `makeFaces` draws them as an overlay so moods can change without a
 * sheet per mood. Keyed `sprite:<role>`.
 */
export function makeSprite(scene: Phaser.Scene, role: string): string {
  const key = `sprite:${role}`;
  if (scene.textures.exists(key)) return key;
  const W = SPRITE_W, H = SPRITE_H, frames = 17;
  const tex = scene.textures.createCanvas(key, W * frames, H)!;
  const g = tex.getContext();
  const c = Phaser.Display.Color.IntegerToColor(roleColor(role));
  const shirt = `rgb(${c.red},${c.green},${c.blue})`;
  const dark = `rgb(${Math.floor(c.red * 0.6)},${Math.floor(c.green * 0.6)},${Math.floor(c.blue * 0.6)})`;
  const skin = '#f1c9a5', hair = role === 'ceo' ? '#4a2c17' : role === 'growth' ? '#c0392b' : role === 'cto' ? '#2c3e50' : role === 'coo' ? '#6d4c41' : '#3a3a3a';
  const head = (ox: number, dir: number) => { px(g, ox + 4, 1, hair, 8, 5); px(g, ox + 4, 4, skin, 8, 6); if (dir === 3) px(g, ox + 4, 4, hair, 8, 4); /* back of the head */ };
  const legs = (ox: number, step: number) => { px(g, ox + 4, 18, '#2b3040', 3, step === 1 ? 5 : 6); px(g, ox + 9, 18, '#2b3040', 3, step === 2 ? 5 : 6); };
  const torso = (ox: number) => { px(g, ox + 3, 10, shirt, 10, 8); px(g, ox + 3, 10, dark, 10, 1); if (role === 'ceo') px(g, ox + 7, 11, '#c0392b', 2, 5); };
  for (let f = 0; f < 12; f++) {
    const dir = Math.floor(f / 3); // 0 down, 1 left, 2 right, 3 up
    const step = f % 3; // 0 stand, 1 left leg, 2 right leg
    const ox = f * W;
    head(ox, dir); torso(ox);
    px(g, ox + (step === 1 ? 2 : 3), 11, skin, 1, 5); px(g, ox + (step === 2 ? 13 : 12), 11, skin, 1, 5); // arms
    legs(ox, step);
  }
  // seated: facing the viewer, forearms on the desk (drawn short), no legs visible below the chair line
  for (const [pose, variant] of [[POSE.SEATED, 0], [POSE.TYPING, 1]] as const) {
    const ox = pose * W;
    head(ox, 0); torso(ox);
    px(g, ox + 2, 15, skin, 4, 2); px(g, ox + 10, 15 - variant, skin, 4, 2); // hands forward, one lifts while typing
    px(g, ox + 4, 18, '#2b3040', 8, 3);
  }
  { const ox = POSE.WAVE * W; head(ox, 0); torso(ox); px(g, ox + 3, 11, skin, 1, 5); px(g, ox + 13, 6, skin, 1, 6); px(g, ox + 12, 5, skin, 3, 1); legs(ox, 0); }
  { const ox = POSE.STRETCH * W; head(ox, 0); torso(ox); px(g, ox + 2, 4, skin, 1, 7); px(g, ox + 13, 4, skin, 1, 7); legs(ox, 0); }
  { const ox = POSE.COFFEE * W; head(ox, 0); torso(ox); px(g, ox + 3, 11, skin, 1, 5); px(g, ox + 12, 11, skin, 1, 3); px(g, ox + 11, 9, '#f5f5f0', 3, 3); px(g, ox + 14, 10, '#f5f5f0', 1, 1); px(g, ox + 12, 8, '#cfd6e6', 1, 1); legs(ox, 0); }
  tex.refresh();
  for (let f = 0; f < frames; f++) tex.add(String(f), 0, f * W, 0, W, H);
  return key;
}

export const FACE_W = 8, FACE_H = 6;
const MOODS: Mood[] = ['neutral', 'happy', 'worried', 'puzzled', 'asleep', 'thinking'];

/**
 * Face overlay sheet (shared by every role): one 8×6 frame per mood × facing (0 down, 1 left, 2 right), plus
 * `blink:<dir>`. Drawn onto the head at (4,4) of the body frame. Keyed `faces`.
 */
export function makeFaces(scene: Phaser.Scene): string {
  const key = 'faces';
  if (scene.textures.exists(key)) return key;
  const cols = 3, rows = MOODS.length + 1;
  const tex = scene.textures.createCanvas(key, FACE_W * cols, FACE_H * rows)!;
  const g = tex.getContext();
  const eye = '#1e1e24', mouth = '#b0685a', brow = '#3a2a1a';
  const drawFace = (ox: number, oy: number, mood: Mood | 'blink', dir: 0 | 1 | 2) => {
    // eye columns relative to the head: front = 2 and 5, left profile = 1, right profile = 6
    const eyes = dir === 0 ? [2, 5] : dir === 1 ? [1] : [6];
    const mouthX = dir === 0 ? 3 : dir === 1 ? 1 : 5, mouthW = dir === 0 ? 2 : 1;
    const eyeY = mood === 'thinking' ? 1 : 2;
    for (const ex of eyes) {
      if (mood === 'asleep' || mood === 'blink') px(g, ox + ex, oy + 2, eye, 2, 1); // closed: a short line
      else if (mood === 'happy') { px(g, ox + ex, oy + 1, eye, 2, 1); } // ^ ^ raised, smiling eyes
      else px(g, ox + ex, oy + eyeY, eye, dir === 0 ? 1 : 1, 1);
    }
    if (mood === 'worried') for (const ex of eyes) px(g, ox + ex, oy + 0, brow, 2, 1);
    if (mood === 'puzzled' && dir === 0) px(g, ox + 5, oy + 0, brow, 2, 1); // one brow up
    if (mood === 'puzzled' && dir !== 0) px(g, ox + eyes[0], oy + 0, brow, 2, 1);
    if (mood === 'happy') px(g, ox + mouthX, oy + 4, mouth, mouthW + 1, 1);
    else if (mood === 'worried') px(g, ox + mouthX, oy + 4, mouth, mouthW, 1);
    else if (mood === 'puzzled') px(g, ox + mouthX + (dir === 0 ? 1 : 0), oy + 4, mouth, 1, 1);
    else if (mood === 'asleep') { /* no mouth: quiet */ }
    else px(g, ox + mouthX, oy + 4, mouth, mouthW, 1);
  };
  MOODS.forEach((mood, r) => { for (let d = 0; d < 3; d++) drawFace(d * FACE_W, r * FACE_H, mood, d as 0 | 1 | 2); });
  for (let d = 0; d < 3; d++) drawFace(d * FACE_W, MOODS.length * FACE_H, 'blink', d as 0 | 1 | 2);
  tex.refresh();
  MOODS.forEach((mood, r) => { for (let d = 0; d < 3; d++) tex.add(`${mood}:${d}`, 0, d * FACE_W, r * FACE_H, FACE_W, FACE_H); });
  for (let d = 0; d < 3; d++) tex.add(`blink:${d}`, 0, d * FACE_W, MOODS.length * FACE_H, FACE_W, FACE_H);
  return key;
}

export const EMOTE_W = 12, EMOTE_H = 12;
const EMOTES: Emote[] = ['!', '?', 'idea', 'zzz', 'sweat', 'heart', 'cheer', 'clipboard', 'coffee', 'wave'];

/** 12×12 pixel emote icons above a sprite's head (no emoji fonts needed). Keyed `emotes`, frames by Emote name. */
export function makeEmotes(scene: Phaser.Scene): string {
  const key = 'emotes';
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, EMOTE_W * EMOTES.length, EMOTE_H)!;
  const g = tex.getContext();
  const draw: Record<Emote, (ox: number) => void> = {
    '!': (ox) => { px(g, ox + 5, 1, '#d6493a', 2, 7); px(g, ox + 5, 9, '#d6493a', 2, 2); },
    '?': (ox) => { px(g, ox + 3, 1, '#e6a93c', 5, 1); px(g, ox + 2, 2, '#e6a93c', 2, 2); px(g, ox + 7, 2, '#e6a93c', 2, 3); px(g, ox + 5, 5, '#e6a93c', 3, 1); px(g, ox + 5, 6, '#e6a93c', 2, 2); px(g, ox + 5, 9, '#e6a93c', 2, 2); },
    idea: (ox) => { px(g, ox + 4, 1, '#ffe08a', 4, 1); px(g, ox + 3, 2, '#ffe08a', 6, 4); px(g, ox + 4, 6, '#ffe08a', 4, 1); px(g, ox + 4, 8, '#8d93a5', 4, 1); px(g, ox + 5, 9, '#8d93a5', 2, 1); px(g, ox + 1, 3, '#fff3c4', 1, 1); px(g, ox + 10, 3, '#fff3c4', 1, 1); px(g, ox + 5, 0, '#fff3c4', 2, 1); },
    zzz: (ox) => { const z = (x: number, y: number, s: number) => { px(g, ox + x, y, '#9db8ff', s, 1); for (let i = 0; i < s; i++) px(g, ox + x + s - 1 - i, y + 1 + i, '#9db8ff'); px(g, ox + x, y + s, '#9db8ff', s, 1); }; z(1, 7, 3); z(5, 4, 3); z(8, 0, 3); },
    sweat: (ox) => { px(g, ox + 5, 2, '#7cc4ff', 1, 2); px(g, ox + 4, 4, '#7cc4ff', 3, 3); px(g, ox + 3, 6, '#7cc4ff', 5, 3); px(g, ox + 4, 9, '#7cc4ff', 3, 1); px(g, ox + 4, 6, '#d8efff', 1, 2); },
    heart: (ox) => { px(g, ox + 2, 2, '#f26b6b', 3, 2); px(g, ox + 7, 2, '#f26b6b', 3, 2); px(g, ox + 1, 4, '#f26b6b', 10, 2); px(g, ox + 2, 6, '#f26b6b', 8, 1); px(g, ox + 3, 7, '#f26b6b', 6, 1); px(g, ox + 4, 8, '#f26b6b', 4, 1); px(g, ox + 5, 9, '#f26b6b', 2, 1); px(g, ox + 3, 3, '#ffb3b3', 1, 1); },
    cheer: (ox) => { px(g, ox + 5, 0, '#ffd166', 2, 12); px(g, ox + 0, 5, '#ffd166', 12, 2); px(g, ox + 3, 3, '#ffd166', 6, 6); px(g, ox + 2, 2, '#ffd166', 1, 1); px(g, ox + 9, 2, '#ffd166', 1, 1); px(g, ox + 2, 9, '#ffd166', 1, 1); px(g, ox + 9, 9, '#ffd166', 1, 1); px(g, ox + 5, 5, '#fff3c4', 2, 2); },
    clipboard: (ox) => { px(g, ox + 2, 1, '#8a5a2b', 8, 10); px(g, ox + 3, 2, '#f5f5f0', 6, 8); px(g, ox + 4, 0, '#5b6170', 4, 2); px(g, ox + 4, 4, '#d6493a', 4, 1); px(g, ox + 4, 6, '#8d93a5', 4, 1); px(g, ox + 4, 8, '#8d93a5', 3, 1); },
    coffee: (ox) => { px(g, ox + 3, 4, '#f5f5f0', 6, 6); px(g, ox + 9, 5, '#f5f5f0', 2, 3); px(g, ox + 10, 6, '#0e1014', 1, 1); px(g, ox + 4, 5, '#6b4423', 4, 1); px(g, ox + 4, 1, '#cfd6e6', 1, 2); px(g, ox + 6, 0, '#cfd6e6', 1, 3); },
    wave: (ox) => { px(g, ox + 4, 3, '#f1c9a5', 4, 6); px(g, ox + 3, 1, '#f1c9a5', 1, 3); px(g, ox + 5, 0, '#f1c9a5', 1, 3); px(g, ox + 7, 0, '#f1c9a5', 1, 3); px(g, ox + 9, 2, '#f1c9a5', 1, 3); px(g, ox + 5, 9, '#f1c9a5', 2, 2); },
  };
  EMOTES.forEach((e, i) => draw[e](i * EMOTE_W));
  tex.refresh();
  EMOTES.forEach((e, i) => tex.add(e, 0, i * EMOTE_W, 0, EMOTE_W, EMOTE_H));
  return key;
}
