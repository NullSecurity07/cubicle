import Phaser from 'phaser';
import type { Emote } from '../state.js';
import { TILES, T, COLUMNS, TILE, tilesetMeta } from './tiles.js';
import { DRAW, floorOfName, glowStep, GLOW_CELL, type Px, type TileName } from './tiles-draw.js';
import { roleColor, floorPalette, rolePalette, type Family } from './palette.js';
import { GLYPHS } from '../ui/icons.js';
import { DECOR_DRAW, DECOR_FRAME_NAMES, type DecorKind } from './decor.js';
import { drawSpriteSheet, drawFaceSheet, spriteOpts, spriteKey, FACE_FRAMES, FACE_SHEET_W, FACE_SHEET_H, SPRITE_W, SPRITE_H, FACE_W, FACE_H } from './sprite-draw.js';
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

/**
 * One street tile on a texture of its own, so the ground beyond the map can be a `TileSprite` rather than a flat
 * rectangle.
 *
 * The run-out (`groundBands`, backdrop.ts) covers the bottom quarter of the tower frame, and as plain fills it read
 * as a beach: the mapped pavement carries noise and a grid, and the fill beside it carried nothing. Drawn from the
 * same `DRAW` entry the tilemap uses, the join is invisible. 16 x 16 is a power of two, which is what a tiling
 * texture needs.
 */
export function makeGroundTile(scene: Phaser.Scene, name: 'PAVEMENT' | 'STREET'): string {
  const key = `ground-${name}`;
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, TILE, TILE)!;
  DRAW[name](canvasPx(tex.getContext(), 0, 0), null);
  tex.refresh();
  return key;
}

export { SPRITE_W, SPRITE_H, FACE_W, FACE_H };

/** 31-frame 16×24 body sheet per role and family, frames named by `FRAMES`. Keyed by `spriteKey` (sprite-draw.ts). */
export function makeSprite(scene: Phaser.Scene, v: { role: string; sprite?: string; family?: Family; team?: string }): string {
  const family: Family = v.family ?? 'member';
  const key = spriteKey({ ...v, family });
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

/** 10×3 soft ellipse under every standing sprite (40 % black). One texture for all; the scene never redraws it. */
export function makeShadow(scene: Phaser.Scene): string {
  const key = 'shadow';
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, 10, 3)!;
  const g = tex.getContext();
  g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(1, 0, 8, 3); g.fillRect(0, 1, 10, 1);
  tex.refresh();
  return key;
}

/** Ambient decor frames (Task 13, `world/decor.ts`): 16×16 frames side by side, named `<kind>:<frame>`. Keyed `decor`. */
export function makeDecorSheet(scene: Phaser.Scene): string {
  const key = 'decor';
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, DECOR_FRAME_NAMES.length * TILE, TILE)!;
  const g = tex.getContext();
  for (const f of DECOR_FRAME_NAMES) { const [kind, n] = f.name.split(':'); DECOR_DRAW[kind as DecorKind](canvasPx(g, f.x, 0), Number(n)); }
  tex.refresh();
  for (const f of DECOR_FRAME_NAMES) tex.add(f.name, 0, f.x, 0, TILE, TILE);
  return key;
}

/** The lamp glow: 64 × 64, tinted per floor and blended ADD by the scene. The bands are `glowStep` (tiles-draw.ts). */
export function makeLampGlow(scene: Phaser.Scene): string {
  const key = 'lamp-glow';
  if (scene.textures.exists(key)) return key;
  const size = 64, r = size / 2;
  const tex = scene.textures.createCanvas(key, size, size)!;
  const g = tex.getContext();
  g.clearRect(0, 0, size, size);
  for (let y = 0; y < size; y += GLOW_CELL) {
    for (let x = 0; x < size; x += GLOW_CELL) {
      const dx = x + GLOW_CELL / 2 - r, dy = y + GLOW_CELL / 2 - r;
      const a = glowStep(Math.hypot(dx, dy) / r);
      if (a <= 0) continue;
      g.fillStyle = `rgba(255,255,255,${a})`;
      g.fillRect(x, y, GLOW_CELL, GLOW_CELL);
    }
  }
  tex.refresh();
  return key;
}

/** A 4×h vertical gradient the scene stretches across the map behind the tower. Redrawn when the stops change. */
export function makeSky(scene: Phaser.Scene, key: string, stops: [string, string], h: number): string {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, 4, h)!;
  const g = tex.getContext();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, stops[0]); grad.addColorStop(1, stops[1]);
  g.fillStyle = grad; g.fillRect(0, 0, 4, h);
  tex.refresh();
  return key;
}
