import Phaser from 'phaser';
import type { Emote } from '../state.js';
import { TILES, T, COLUMNS, TILE, tilesetMeta } from './tiles.js';
import { DRAW, floorOfName, type Px, type TileName } from './tiles-draw.js';
import { roleColor, floorPalette, rolePalette, type Family } from './palette.js';
import { GLYPHS } from '../ui/icons.js';
import { drawSpriteSheet, drawFaceSheet, spriteOpts, FACE_FRAMES, FACE_SHEET_W, FACE_SHEET_H, SPRITE_W, SPRITE_H, FACE_W, FACE_H } from './sprite-draw.js';
import { FRAMES } from './frames.js';

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

export { SPRITE_W, SPRITE_H, FACE_W, FACE_H };

/** 31-frame 16×24 body sheet per role and family, frames named by `FRAMES`. Keyed `sprite:<sprite>:<family>`. */
export function makeSprite(scene: Phaser.Scene, v: { role: string; sprite?: string; family?: Family; team?: string }): string {
  const family: Family = v.family ?? 'member';
  const key = `sprite:${v.sprite || v.role}:${family}`;
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, SPRITE_W * FRAMES.length, SPRITE_H)!;
  drawSpriteSheet(canvasPx(tex.getContext(), 0, 0), rolePalette(v.role, family), family, spriteOpts(v.role, v.team));
  tex.refresh();
  FRAMES.forEach((name, i) => tex.add(name, 0, i * SPRITE_W, 0, SPRITE_W, SPRITE_H));
  return key;
}

/** The owner's avatar: charcoal turtleneck, no ring. Keyed `sprite:owner`. */
export function makeOwnerSprite(scene: Phaser.Scene): string {
  const key = 'sprite:owner';
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, SPRITE_W * FRAMES.length, SPRITE_H)!;
  drawSpriteSheet(canvasPx(tex.getContext(), 0, 0), rolePalette('owner', 'owner'), 'owner', { headset: false, hairShape: 0, hoodie: false });
  tex.refresh();
  FRAMES.forEach((name, i) => tex.add(name, 0, i * SPRITE_W, 0, SPRITE_W, SPRITE_H));
  return key;
}

/** Shared face overlay sheet: `<mood>:<dir>[:talk][:g]` and `blink:<dir>` variants. Keyed `faces`. */
export function makeFaces(scene: Phaser.Scene): string {
  const key = 'faces';
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, FACE_SHEET_W, FACE_SHEET_H)!;
  drawFaceSheet(canvasPx(tex.getContext(), 0, 0));
  tex.refresh();
  for (const f of FACE_FRAMES) tex.add(f.name, 0, f.x, f.y, FACE_W, FACE_H);
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
  EMOTES.forEach((e, i) => { for (const [x, y, w, h, c] of GLYPHS[e]) px(g, i * EMOTE_W + x, y, c, w, h); });
  tex.refresh();
  EMOTES.forEach((e, i) => tex.add(e, 0, i * EMOTE_W, 0, EMOTE_W, EMOTE_H));
  return key;
}
