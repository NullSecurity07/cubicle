import Phaser from 'phaser';
import type { Mood, Emote } from '../state.js';

/** Tile ids must match scripts/gen-world.ts `T`. Drawn procedurally: CC0-by-construction placeholder art. */
export const TILE = 16;
export const TILES = ['EMPTY', 'GRASS', 'PATH', 'FLOOR', 'WALL', 'WALL_TOP', 'DOOR', 'DESK', 'CHAIR', 'TABLE', 'WHITEBOARD', 'PLANT', 'KITCHEN', 'NOTICE', 'CARPET', 'WINDOW', 'TREE', 'BENCH', 'SIGN'] as const;
export const COLUMNS = 6;

function px(g: CanvasRenderingContext2D, x: number, y: number, c: string, w = 1, h = 1) { g.fillStyle = c; g.fillRect(x, y, w, h); }
function noise(g: CanvasRenderingContext2D, ox: number, oy: number, colors: string[], n: number, seed: number) { let s = seed; for (let i = 0; i < n; i++) { s = (s * 9301 + 49297) % 233280; const x = s % TILE; s = (s * 9301 + 49297) % 233280; const y = s % TILE; px(g, ox + x, oy + y, colors[i % colors.length]); } }

/** Draws the 18-tile tileset (6 columns × 3 rows, 16 px) into a canvas texture named `office`. */
export function makeTileset(scene: Phaser.Scene): void {
  if (scene.textures.exists('office')) return;
  const rows = Math.ceil((TILES.length - 1) / COLUMNS);
  const tex = scene.textures.createCanvas('office', COLUMNS * TILE, rows * TILE)!;
  const g = tex.getContext();
  const draw = (id: number, fn: (ox: number, oy: number) => void) => { const i = id - 1; fn((i % COLUMNS) * TILE, Math.floor(i / COLUMNS) * TILE); };
  draw(1, (x, y) => { px(g, x, y, '#4f8a3b', TILE, TILE); noise(g, x, y, ['#5a9a44', '#457a33', '#63a34c'], 26, 7); });
  draw(2, (x, y) => { px(g, x, y, '#a89f91', TILE, TILE); noise(g, x, y, ['#b5ac9e', '#9a9184'], 18, 3); px(g, x, y + 15, '#8f877b', TILE, 1); });
  draw(3, (x, y) => { px(g, x, y, '#cfc7b8', TILE, TILE); px(g, x, y, '#dcd4c5', TILE, 1); px(g, x, y, '#dcd4c5', 1, TILE); px(g, x + 8, y, '#c3bbac', 1, TILE); px(g, x, y + 8, '#c3bbac', TILE, 1); });
  draw(4, (x, y) => { px(g, x, y, '#5b6170', TILE, TILE); for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) px(g, x + c * 8 + (r % 2 ? 4 : 0), y + r * 4, '#6b7282', 7, 3); px(g, x, y + 15, '#3d4250', TILE, 1); });
  draw(5, (x, y) => { px(g, x, y, '#7c8394', TILE, TILE); px(g, x, y + 12, '#5b6170', TILE, 4); px(g, x, y, '#98a0b2', TILE, 2); });
  draw(6, (x, y) => { px(g, x, y, '#cfc7b8', TILE, TILE); px(g, x + 3, y + 1, '#8a5a2b', 10, 15); px(g, x + 4, y + 2, '#a56d36', 8, 13); px(g, x + 10, y + 8, '#f2d16b', 2, 2); });
  draw(7, (x, y) => { px(g, x, y, '#cfc7b8', TILE, TILE); px(g, x + 1, y + 4, '#8a5a2b', 14, 9); px(g, x + 1, y + 4, '#a56d36', 14, 2); px(g, x + 3, y + 6, '#2b2f3a', 6, 5); px(g, x + 4, y + 7, '#5ad1ff', 4, 3); px(g, x + 11, y + 8, '#e8e8e8', 3, 2); });
  draw(8, (x, y) => { px(g, x, y, '#cfc7b8', TILE, TILE); px(g, x + 4, y + 4, '#3b4a8a', 8, 8); px(g, x + 4, y + 2, '#2f3c73', 8, 3); px(g, x + 4, y + 12, '#2f3c73', 2, 3); px(g, x + 10, y + 12, '#2f3c73', 2, 3); });
  draw(9, (x, y) => { px(g, x, y, '#b9b2a4', TILE, TILE); px(g, x, y + 3, '#7a4f25', TILE, 10); px(g, x, y + 3, '#95602d', TILE, 2); });
  draw(10, (x, y) => { px(g, x, y, '#cfc7b8', TILE, TILE); px(g, x + 1, y + 2, '#2b2f3a', 14, 11); px(g, x + 2, y + 3, '#f5f5f0', 12, 9); px(g, x + 3, y + 5, '#d33', 6, 1); px(g, x + 3, y + 7, '#36c', 8, 1); px(g, x + 3, y + 9, '#393', 4, 1); });
  draw(11, (x, y) => { px(g, x, y, '#cfc7b8', TILE, TILE); px(g, x + 6, y + 10, '#8a5a2b', 4, 5); px(g, x + 4, y + 3, '#2f7d32', 8, 8); px(g, x + 6, y + 1, '#43a047', 4, 4); px(g, x + 3, y + 6, '#43a047', 3, 3); px(g, x + 10, y + 6, '#43a047', 3, 3); });
  draw(12, (x, y) => { px(g, x, y, '#dcd4c5', TILE, TILE); px(g, x, y + 4, '#9aa5b1', TILE, 10); px(g, x, y + 4, '#c4ccd4', TILE, 2); px(g, x + 2, y + 8, '#3a3f4a', 5, 4); px(g, x + 9, y + 7, '#2a6fdb', 5, 1); });
  draw(13, (x, y) => { px(g, x, y, '#cfc7b8', TILE, TILE); px(g, x + 1, y + 1, '#8a5a2b', 14, 13); px(g, x + 2, y + 2, '#c9a56e', 12, 11); px(g, x + 3, y + 3, '#fff', 4, 5); px(g, x + 9, y + 4, '#ffe08a', 4, 4); px(g, x + 4, y + 9, '#9ad0ff', 5, 3); });
  draw(14, (x, y) => { px(g, x, y, '#6b3f63', TILE, TILE); noise(g, x, y, ['#75476d', '#613859'], 20, 11); });
  draw(15, (x, y) => { px(g, x, y, '#5b6170', TILE, TILE); px(g, x + 2, y + 2, '#a9d6ff', 12, 10); px(g, x + 7, y + 2, '#5b6170', 2, 10); px(g, x + 2, y + 6, '#5b6170', 12, 2); px(g, x, y + 15, '#3d4250', TILE, 1); });
  draw(16, (x, y) => { px(g, x, y, '#4f8a3b', TILE, TILE); px(g, x + 7, y + 10, '#6b4423', 3, 6); px(g, x + 2, y + 2, '#2e6b2a', 12, 10); px(g, x + 4, y + 0, '#3b8a35', 8, 4); px(g, x + 3, y + 5, '#4caf50', 3, 3); });
  draw(17, (x, y) => { px(g, x, y, '#a89f91', TILE, TILE); px(g, x + 1, y + 6, '#7a4f25', 14, 4); px(g, x + 2, y + 10, '#5a3a1a', 2, 4); px(g, x + 12, y + 10, '#5a3a1a', 2, 4); });
  draw(18, (x, y) => { px(g, x, y, '#4f8a3b', TILE, TILE); px(g, x + 7, y + 6, '#6b4423', 2, 10); px(g, x + 2, y + 2, '#f2d16b', 12, 6); px(g, x + 3, y + 3, '#2b2f3a', 10, 1); px(g, x + 3, y + 5, '#2b2f3a', 7, 1); });
  tex.refresh();
}

/** Palette per role (deterministic for unknown roles from the name). */
export function roleColor(role: string): number {
  const known: Record<string, number> = { ceo: 0xf2c14e, cto: 0x4e9af2, engineer: 0x4ed3a3, growth: 0xf26b6b, coo: 0xb98ef2 };
  if (known[role]) return known[role];
  let h = 0; for (const ch of role) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Phaser.Display.Color.HSLToColor((h % 360) / 360, 0.55, 0.6).color;
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
