import Phaser from 'phaser';

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

/** 16×24 walking sprite sheet per role: 4 directions × 3 frames + idle, drawn from rectangles. Keyed `sprite:<role>`. */
export function makeSprite(scene: Phaser.Scene, role: string): string {
  const key = `sprite:${role}`;
  if (scene.textures.exists(key)) return key;
  const W = 16, H = 24, frames = 12;
  const tex = scene.textures.createCanvas(key, W * frames, H)!;
  const g = tex.getContext();
  const c = Phaser.Display.Color.IntegerToColor(roleColor(role));
  const shirt = `rgb(${c.red},${c.green},${c.blue})`;
  const dark = `rgb(${Math.floor(c.red * 0.6)},${Math.floor(c.green * 0.6)},${Math.floor(c.blue * 0.6)})`;
  const skin = '#f1c9a5', hair = role === 'ceo' ? '#4a2c17' : role === 'growth' ? '#c0392b' : role === 'cto' ? '#2c3e50' : role === 'coo' ? '#6d4c41' : '#3a3a3a';
  for (let f = 0; f < frames; f++) {
    const dir = Math.floor(f / 3); // 0 down, 1 left, 2 right, 3 up
    const step = f % 3; // 0 stand, 1 left leg, 2 right leg
    const ox = f * W;
    px(g, ox + 4, 1, hair, 8, 5); px(g, ox + 4, 4, skin, 8, 6);                           // head
    if (dir !== 3) { px(g, ox + (dir === 1 ? 5 : dir === 2 ? 9 : 6), 6, '#222', 1, 1); if (dir === 0) px(g, ox + 9, 6, '#222', 1, 1); }
    px(g, ox + 3, 10, shirt, 10, 8); px(g, ox + 3, 10, dark, 10, 1);                     // body
    px(g, ox + (step === 1 ? 2 : 3), 11, skin, 1, 5); px(g, ox + (step === 2 ? 13 : 12), 11, skin, 1, 5); // arms
    px(g, ox + 4, 18, '#2b3040', 3, step === 1 ? 5 : 6); px(g, ox + 9, 18, '#2b3040', 3, step === 2 ? 5 : 6); // legs
    if (role === 'ceo') px(g, ox + 7, 11, '#c0392b', 2, 5); // tie
  }
  tex.refresh();
  for (let f = 0; f < frames; f++) tex.add(String(f), 0, f * W, 0, W, H);
  return key;
}
