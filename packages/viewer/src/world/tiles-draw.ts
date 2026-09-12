/**
 * Every tile as a pure drawer over `Px` in 16×16 local coordinates. `makeTileset` (tileset.ts) supplies a canvas-backed
 * Px; the tests supply a recording one. Light comes from the top-left: `bevel` gives furniture a 1 px lighter top and a
 * 1 px darker bottom/right. No black outlines on tiles.
 */
import type { TILES } from './tiles.js';
import { PALETTE, shade, floorPalette, type FloorPalette } from './palette.js';

export interface Px { fill(x: number, y: number, w: number, h: number, c: string): void }
export type TileName = typeof TILES[number];
export type Drawer = (p: Px, pal: FloorPalette | null) => void;

export class RecordingPx implements Px {
  rects: { x: number; y: number; w: number; h: number; c: string }[] = [];
  fill(x: number, y: number, w: number, h: number, c: string): void { this.rects.push({ x, y, w, h, c }); }
  get count(): number { return this.rects.length; }
  /** Rects that leave a w×h cell (a tile is 16×16, a sprite frame 16×24). */
  outside(w: number, h: number): typeof this.rects { return this.rects.filter((r) => r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h || r.w <= 0 || r.h <= 0); }
}

export const px = (p: Px, x: number, y: number, c: string, w = 1, h = 1): void => p.fill(x, y, w, h, c);
export const hline = (p: Px, x: number, y: number, w: number, c: string): void => p.fill(x, y, w, 1, c);
export const vline = (p: Px, x: number, y: number, h: number, c: string): void => p.fill(x, y, 1, h, c);
/** Deterministic scatter of single pixels (LCG) inside a 16×16 cell. */
export function noise(p: Px, colors: string[], n: number, seed: number): void { let s = seed; for (let i = 0; i < n; i++) { s = (s * 9301 + 49297) % 233280; const x = s % 16; s = (s * 9301 + 49297) % 233280; const y = s % 16; p.fill(x, y, 1, 1, colors[i % colors.length]); } }
/** Base fill, then a lighter top edge and darker bottom + right edges (light from the top-left). */
export function bevel(p: Px, x: number, y: number, w: number, h: number, base: string): void { p.fill(x, y, w, h, base); p.fill(x, y, w, 1, shade(base, 0.10)); p.fill(x, y + h - 1, w, 1, shade(base, -0.12)); p.fill(x + w - 1, y, 1, h, shade(base, -0.12)); }
export function checker(p: Px, x: number, y: number, w: number, h: number, a: string, b: string, size: number): void { for (let yy = 0; yy < h; yy += size) for (let xx = 0; xx < w; xx += size) p.fill(x + xx, y + yy, Math.min(size, w - xx), Math.min(size, h - yy), ((xx / size + yy / size) % 2 === 0) ? a : b); }
/** `n` single pixels of colour `c` scattered over the rect, deterministic by seed. */
export function dither(p: Px, x: number, y: number, w: number, h: number, c: string, n: number, seed: number): void { let s = seed; for (let i = 0; i < n; i++) { s = (s * 9301 + 49297) % 233280; const dx = s % w; s = (s * 9301 + 49297) % 233280; const dy = s % h; p.fill(x + dx, y + dy, 1, 1, c); } }
export function floorOfName(name: string): 1 | 2 | 3 | 4 | null { const m = /_F([1-4])$/.exec(name); return m ? (Number(m[1]) as 1 | 2 | 3 | 4) : null; }

const P = PALETTE;
const full = (p: Px, c: string): void => p.fill(0, 0, 16, 16, c);
const pal = (f: FloorPalette | null, n: number): FloorPalette => f ?? floorPalette(n);

// Materials shared by several drawers.
const plank = (p: Px, f: FloorPalette): void => { full(p, f.floor); hline(p, 0, 7, 16, shade(f.floor, -0.06)); hline(p, 0, 15, 16, shade(f.floor, -0.06)); vline(p, 5, 0, 8, shade(f.floor, -0.05)); vline(p, 11, 8, 8, shade(f.floor, -0.05)); dither(p, 0, 0, 16, 16, f.floorAlt, 6, f.n); };
const oak = (p: Px, f: FloorPalette): void => { full(p, f.floor); for (let y = 0; y < 16; y += 4) hline(p, 0, y + 3, 16, shade(f.floor, -0.05)); vline(p, 8, 0, 4, shade(f.floor, -0.05)); vline(p, 3, 8, 4, shade(f.floor, -0.05)); dither(p, 0, 0, 16, 16, f.floorAlt, 8, f.n); };
const concrete = (p: Px, f: FloorPalette): void => { full(p, f.floor); noise(p, [f.floorAlt, f.speckle], 14, f.n * 7); hline(p, 0, 15, 16, shade(f.floor, -0.04)); vline(p, 15, 0, 16, shade(f.floor, -0.04)); };
const terrazzo = (p: Px, f: FloorPalette): void => { full(p, f.floor); noise(p, [f.speckle, f.floorAlt, P.concreteDark, '#d9c2a3'], 22, f.n * 11); };
const FLOOR_STYLE: Record<1 | 2 | 3 | 4, (p: Px, f: FloorPalette) => void> = { 1: plank, 2: oak, 3: concrete, 4: terrazzo };
const carpet = (p: Px, f: FloorPalette): void => { if (f.n === 2) { checker(p, 0, 0, 16, 16, f.carpet, f.carpetAlt, 8); return; } full(p, f.carpet); noise(p, [f.carpetAlt, shade(f.carpet, 0.04)], 20, f.n * 13); };
const wallFace = (p: Px, f: FloorPalette): void => { full(p, P.wallFace); hline(p, 0, 0, 16, P.wallCap); hline(p, 0, 1, 16, shade(P.wallFace, 0.04)); p.fill(0, 14, 16, 2, f.skirting); };
const glassFrame = (p: Px, x: number, y: number, w: number, h: number): void => { p.fill(x, y, w, h, P.glassFill); hline(p, x, y, w, P.glassFrame); hline(p, x, y + h - 1, w, P.glassFrame); vline(p, x, y, h, P.glassFrame); vline(p, x + w - 1, y, h, P.glassFrame); };
const windowTile = (p: Px, glow: string, dark: boolean): void => { full(p, P.concreteDark); p.fill(2, 2, 12, 11, glow); vline(p, 7, 2, 11, P.concreteDark); hline(p, 2, 7, 12, P.concreteDark); if (!dark) vline(p, 3, 3, 3, P.glassStreak); hline(p, 0, 14, 16, P.concreteLight); hline(p, 0, 15, 16, P.concrete); };
const deskTop = (p: Px, left: boolean, exec: boolean): void => { const wood = exec ? P.woodDark : P.wood, light = exec ? P.wood : P.woodLight; bevel(p, left ? 1 : 0, 5, 15, 8, wood); hline(p, left ? 2 : 0, 6, 13, light); if (left) { p.fill(4, 2, 6, 4, '#2b2f3a'); p.fill(5, 3, 4, 2, '#5ad1ff'); p.fill(6, 6, 2, 1, '#2b2f3a'); } else { p.fill(3, 8, 5, 2, '#e8e8e8'); p.fill(10, 7, 3, 3, exec ? P.amber : '#c9d1d9'); } p.fill(left ? 2 : 12, 13, 2, 3, wood); };
const chair = (p: Px, seat: string, back: string, wide: boolean): void => { p.fill(wide ? 3 : 4, 2, wide ? 10 : 8, 4, back); p.fill(wide ? 3 : 4, 6, wide ? 10 : 8, 6, seat); hline(p, wide ? 3 : 4, 6, wide ? 10 : 8, shade(seat, 0.1)); p.fill(5, 12, 2, 3, '#2f3c73'); p.fill(9, 12, 2, 3, '#2f3c73'); };
const tableTop = (p: Px, edges: { t?: boolean; b?: boolean; l?: boolean; r?: boolean }): void => { full(p, P.woodLight); if (edges.t) hline(p, 0, 0, 16, shade(P.woodLight, 0.1)); if (edges.b) { p.fill(0, 13, 16, 3, P.woodDark); hline(p, 0, 13, 16, P.wood); } if (edges.l) vline(p, 0, 0, 16, shade(P.woodLight, 0.08)); if (edges.r) vline(p, 15, 0, 16, P.wood); };
const counter = (p: Px, l: boolean, r: boolean): void => { bevel(p, l ? 1 : 0, 3, 16 - (l ? 1 : 0) - (r ? 1 : 0), 6, P.steelLight); p.fill(l ? 1 : 0, 9, 16 - (l ? 1 : 0) - (r ? 1 : 0), 6, P.wood); hline(p, 0, 15, 16, P.woodDark); };
const bezel = (p: Px, l: boolean, r: boolean): void => { full(p, P.screenFrame); p.fill(l ? 2 : 0, 2, 16 - (l ? 2 : 0) - (r ? 2 : 0), 12, P.screenBg); hline(p, l ? 2 : 0, 2, 16 - (l ? 2 : 0) - (r ? 2 : 0), shade(P.screenFrame, 0.1)); if (l) vline(p, 0, 0, 16, shade(P.screenFrame, 0.12)); if (r) vline(p, 15, 0, 16, shade(P.screenFrame, -0.12)); };

export const DRAW: Record<Exclude<TileName, 'EMPTY'>, Drawer> = {
  // --- legacy ids 1–18 (drawn as before, still used by the old fixtures) ---
  GRASS: (p) => { full(p, '#4f8a3b'); noise(p, ['#5a9a44', '#457a33', '#63a34c'], 26, 7); },
  PATH: (p) => { full(p, P.pavement); noise(p, ['#b5ac9e', '#9a9184'], 18, 3); hline(p, 0, 15, 16, '#8f877b'); },
  FLOOR: (p) => { full(p, '#cfc7b8'); hline(p, 0, 0, 16, '#dcd4c5'); vline(p, 0, 0, 16, '#dcd4c5'); vline(p, 8, 0, 16, '#c3bbac'); hline(p, 0, 8, 16, '#c3bbac'); },
  WALL: (p) => { full(p, '#5b6170'); for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) { const x = c * 8 + (r % 2 ? 4 : 0); p.fill(x, r * 4, Math.min(7, 16 - x), 3, '#6b7282'); } hline(p, 0, 15, 16, '#3d4250'); },
  WALL_TOP: (p) => { full(p, '#7c8394'); p.fill(0, 12, 16, 4, '#5b6170'); p.fill(0, 0, 16, 2, '#98a0b2'); },
  DOOR: (p) => { full(p, '#cfc7b8'); p.fill(3, 1, 10, 15, P.wood); p.fill(4, 2, 8, 13, P.woodLight); p.fill(10, 8, 2, 2, '#f2d16b'); },
  DESK: (p) => { full(p, '#cfc7b8'); p.fill(1, 4, 14, 9, P.wood); p.fill(1, 4, 14, 2, P.woodLight); p.fill(3, 6, 6, 5, '#2b2f3a'); p.fill(4, 7, 4, 3, '#5ad1ff'); p.fill(11, 8, 3, 2, '#e8e8e8'); },
  CHAIR: (p) => { full(p, '#cfc7b8'); p.fill(4, 4, 8, 8, '#3b4a8a'); p.fill(4, 2, 8, 3, '#2f3c73'); p.fill(4, 12, 2, 3, '#2f3c73'); p.fill(10, 12, 2, 3, '#2f3c73'); },
  TABLE: (p) => { full(p, '#b9b2a4'); p.fill(0, 3, 16, 10, '#7a4f25'); p.fill(0, 3, 16, 2, '#95602d'); },
  WHITEBOARD: (p) => { full(p, '#cfc7b8'); p.fill(1, 2, 14, 11, '#2b2f3a'); p.fill(2, 3, 12, 9, '#f5f5f0'); hline(p, 3, 5, 6, '#d33'); hline(p, 3, 7, 8, '#36c'); hline(p, 3, 9, 4, '#393'); },
  PLANT: (p) => { full(p, '#cfc7b8'); p.fill(6, 10, 4, 5, P.wood); p.fill(4, 3, 8, 8, '#2f7d32'); p.fill(6, 1, 4, 4, '#43a047'); p.fill(3, 6, 3, 3, '#43a047'); p.fill(10, 6, 3, 3, '#43a047'); },
  KITCHEN: (p) => { full(p, '#dcd4c5'); p.fill(0, 4, 16, 10, '#9aa5b1'); p.fill(0, 4, 16, 2, '#c4ccd4'); p.fill(2, 8, 5, 4, '#3a3f4a'); hline(p, 9, 7, 5, '#2a6fdb'); },
  NOTICE: (p) => { full(p, '#cfc7b8'); p.fill(1, 1, 14, 13, P.wood); p.fill(2, 2, 12, 11, '#c9a56e'); p.fill(3, 3, 4, 5, '#fff'); p.fill(9, 4, 4, 4, '#ffe08a'); p.fill(4, 9, 5, 3, '#9ad0ff'); },
  CARPET: (p) => { full(p, '#6b3f63'); noise(p, ['#75476d', '#613859'], 20, 11); },
  WINDOW: (p) => { full(p, '#5b6170'); p.fill(2, 2, 12, 10, '#a9d6ff'); vline(p, 7, 2, 10, '#5b6170'); vline(p, 8, 2, 10, '#5b6170'); hline(p, 2, 6, 12, '#5b6170'); hline(p, 2, 7, 12, '#5b6170'); hline(p, 0, 15, 16, '#3d4250'); },
  TREE: (p) => { full(p, '#4f8a3b'); p.fill(7, 10, 3, 6, '#6b4423'); p.fill(2, 2, 12, 10, '#2e6b2a'); p.fill(4, 0, 8, 4, '#3b8a35'); p.fill(3, 5, 3, 3, '#4caf50'); },
  BENCH: (p) => { full(p, P.pavement); p.fill(1, 6, 14, 4, '#7a4f25'); p.fill(2, 10, 2, 4, '#5a3a1a'); p.fill(12, 10, 2, 4, '#5a3a1a'); },
  SIGN: (p) => { full(p, '#4f8a3b'); p.fill(7, 6, 2, 10, '#6b4423'); p.fill(2, 2, 12, 6, '#f2d16b'); hline(p, 3, 3, 10, '#2b2f3a'); hline(p, 3, 5, 7, '#2b2f3a'); },
  // --- plan 1's minimum set (19–27), drawn with the tower materials ---
  // Paints nothing: the sky is the scene's own gradient Image (world/tileset.ts makeSky), drawn behind the map at
  // depth -1. A SKY ground tile only needs to be transparent so that image shows through above the roof and
  // beside the tower; the id still exists for walkability (BLOCKED_GROUND) and the map generator's default fill.
  SKY: () => {},
  CARPET_BLUE: (p) => carpet(p, floorPalette(2)),
  CARPET_GREEN: (p) => carpet(p, floorPalette(3)),
  CARPET_ORANGE: (p) => carpet(p, floorPalette(4)),
  SCREEN: (p) => bezel(p, false, false),
  SHAFT: (p) => { full(p, P.steelDark); vline(p, 0, 0, 16, P.concreteDark); vline(p, 15, 0, 16, P.concreteDark); for (let y = 0; y < 16; y += 4) hline(p, 1, y, 14, shade(P.steelDark, -0.05)); },
  ELEVATOR_DOOR: (p) => { full(p, P.steel); vline(p, 7, 0, 16, P.steelDark); vline(p, 8, 0, 16, P.steelDark); hline(p, 0, 0, 16, P.steelLight); hline(p, 0, 15, 16, P.steelDark); },
  COUNTER: (p) => counter(p, false, false),
  SLAB: (p) => { full(p, P.concrete); hline(p, 0, 0, 16, P.concreteLight); hline(p, 0, 15, 16, P.concreteDark); dither(p, 0, 1, 16, 14, P.concreteDark, 5, 3); },
  // --- exterior ---
  STREET: (p) => { full(p, P.asphalt); noise(p, [shade(P.asphalt, 0.04), shade(P.asphalt, -0.03)], 16, 5); },
  KERB: (p) => { full(p, P.asphalt); p.fill(0, 0, 16, 5, P.kerb); hline(p, 0, 5, 16, shade(P.kerb, -0.15)); },
  PAVEMENT: (p) => { full(p, P.pavement); noise(p, ['#b5ac9e', '#9a9184'], 12, 3); hline(p, 0, 7, 16, '#9a9184'); vline(p, 7, 0, 16, '#9a9184'); },
  FACADE: (p) => { full(p, P.concrete); noise(p, [P.concreteLight, P.concreteDark], 10, 9); hline(p, 0, 15, 16, P.concreteDark); },
  FACADE_EDGE: (p) => { full(p, P.concrete); vline(p, 0, 0, 16, P.concreteLight); vline(p, 1, 0, 16, P.concreteLight); vline(p, 15, 0, 16, P.concreteDark); },
  LOBBY_FLOOR: (p) => { checker(p, 0, 0, 16, 16, P.marble, P.marbleAlt, 8); dither(p, 0, 0, 16, 16, shade(P.marble, -0.06), 4, 2); },
  LOBBY_FLOOR_ALT: (p) => { checker(p, 0, 0, 16, 16, P.marbleAlt, P.marble, 8); dither(p, 0, 0, 16, 16, shade(P.marble, -0.06), 4, 4); },
  ROOF_EDGE: (p) => { full(p, P.sky.day[0]); p.fill(0, 10, 16, 6, P.concreteLight); hline(p, 0, 10, 16, '#ffffff'); hline(p, 0, 15, 16, P.concrete); },
  // --- per-floor materials ---
  FLOOR_F1: (p, f) => FLOOR_STYLE[1](p, pal(f, 1)), FLOOR_F2: (p, f) => FLOOR_STYLE[2](p, pal(f, 2)), FLOOR_F3: (p, f) => FLOOR_STYLE[3](p, pal(f, 3)), FLOOR_F4: (p, f) => FLOOR_STYLE[4](p, pal(f, 4)),
  FLOOR_ALT_F1: (p, f) => { const q = pal(f, 1); FLOOR_STYLE[1](p, q); dither(p, 0, 0, 16, 16, shade(q.floor, 0.06), 5, 21); },
  FLOOR_ALT_F2: (p, f) => { const q = pal(f, 2); FLOOR_STYLE[2](p, q); dither(p, 0, 0, 16, 16, shade(q.floor, -0.06), 5, 22); },
  FLOOR_ALT_F3: (p, f) => { const q = pal(f, 3); FLOOR_STYLE[3](p, q); dither(p, 0, 0, 16, 16, shade(q.floor, -0.05), 5, 23); },
  FLOOR_ALT_F4: (p, f) => { const q = pal(f, 4); FLOOR_STYLE[4](p, q); dither(p, 0, 0, 16, 16, '#b8865b', 5, 24); },
  CARPET_F1: (p, f) => carpet(p, pal(f, 1)), CARPET_F2: (p, f) => carpet(p, pal(f, 2)), CARPET_F3: (p, f) => carpet(p, pal(f, 3)), CARPET_F4: (p, f) => carpet(p, pal(f, 4)),
  WALL_F1: (p, f) => wallFace(p, pal(f, 1)), WALL_F2: (p, f) => wallFace(p, pal(f, 2)), WALL_F3: (p, f) => wallFace(p, pal(f, 3)), WALL_F4: (p, f) => wallFace(p, pal(f, 4)),
  SIGN_F1: (p, f) => { const q = pal(f, 1); full(p, P.wallFace); bevel(p, 1, 4, 14, 8, q.skirting); }, SIGN_F2: (p, f) => { const q = pal(f, 2); full(p, P.wallFace); bevel(p, 1, 4, 14, 8, q.skirting); },
  SIGN_F3: (p, f) => { const q = pal(f, 3); full(p, P.wallFace); bevel(p, 1, 4, 14, 8, q.skirting); }, SIGN_F4: (p, f) => { const q = pal(f, 4); full(p, P.wallFace); bevel(p, 1, 4, 14, 8, q.skirting); },
  // --- structure ---
  WALL_TOP_INT: (p) => { full(p, P.wallCap); hline(p, 0, 0, 16, shade(P.wallCap, 0.08)); p.fill(0, 12, 16, 4, P.wallFace); hline(p, 0, 15, 16, shade(P.wallFace, -0.08)); },
  CORRIDOR: (p) => { full(p, '#cfc9be'); vline(p, 7, 0, 16, '#c3bdb1'); hline(p, 0, 7, 16, '#c3bdb1'); dither(p, 0, 0, 16, 16, '#d8d2c6', 4, 6); },
  GLASS_V: (p) => glassFrame(p, 6, 0, 4, 16),
  GLASS_H: (p) => glassFrame(p, 0, 6, 16, 4),
  GLASS_CORNER: (p) => { glassFrame(p, 6, 6, 10, 4); glassFrame(p, 6, 6, 4, 10); },
  GLASS_DOOR: (p) => { glassFrame(p, 0, 6, 16, 4); p.fill(7, 6, 2, 4, P.steelLight); px(p, 3, 8, P.amber); },
  DOOR_INT: (p) => { full(p, P.wallFace); p.fill(3, 0, 10, 16, P.wood); p.fill(4, 1, 8, 14, P.woodLight); px(p, 10, 8, '#f2d16b', 2, 2); },
  WINDOW_DAY: (p) => windowTile(p, P.windowDay, false),
  WINDOW_DUSK: (p) => windowTile(p, P.windowDusk, false),
  WINDOW_NIGHT: (p) => windowTile(p, P.windowNight, true),
  // --- elevator ---
  ELEV_SHAFT: (p) => { full(p, P.steelDark); vline(p, 0, 0, 16, P.concreteDark); vline(p, 15, 0, 16, P.concreteDark); for (let y = 0; y < 16; y += 4) hline(p, 1, y, 14, shade(P.steelDark, -0.05)); },
  ELEV_RAIL: (p) => { full(p, P.steelDark); vline(p, 3, 0, 16, P.steel); vline(p, 12, 0, 16, P.steel); for (let y = 2; y < 16; y += 4) { hline(p, 2, y, 3, P.steelLight); hline(p, 11, y, 3, P.steelLight); } },
  ELEV_DOOR_L: (p) => { full(p, P.steel); hline(p, 0, 0, 16, P.steelLight); vline(p, 14, 0, 16, P.steelDark); vline(p, 15, 0, 16, P.steelDark); hline(p, 0, 15, 16, P.steelDark); vline(p, 2, 2, 12, P.steelLight); },
  ELEV_DOOR_R: (p) => { full(p, P.steel); hline(p, 0, 0, 16, P.steelLight); vline(p, 0, 0, 16, P.steelDark); vline(p, 1, 0, 16, P.steelDark); hline(p, 0, 15, 16, P.steelDark); vline(p, 13, 2, 12, P.steelLight); },
  ELEV_FRAME: (p) => { full(p, P.wallFace); p.fill(0, 0, 16, 3, P.steelDark); p.fill(2, 1, 12, 1, P.steel); p.fill(6, 4, 4, 3, P.amberInk); },
  ELEV_CALL: (p) => { full(p, P.wallFace); bevel(p, 5, 5, 6, 8, P.steelLight); px(p, 7, 7, P.amber, 2, 1); px(p, 7, 10, P.steelDark, 2, 1); p.fill(0, 14, 16, 2, P.wallCap); },
  // --- desks and chairs ---
  DESK_L: (p) => deskTop(p, true, false), DESK_R: (p) => deskTop(p, false, false),
  DESK_EXEC_L: (p) => deskTop(p, true, true), DESK_EXEC_R: (p) => deskTop(p, false, true),
  CHAIR_TASK: (p) => chair(p, '#3b4a8a', '#2f3c73', false),
  CHAIR_EXEC: (p) => chair(p, '#3a2f2a', '#2a221e', true),
  // Chrome on the headrest, not amber: `#e6a93c` is the attention accent, and a gold chair in the board room read
  // as something asking to be looked at (visual QA M7).
  OWNER_CHAIR: (p) => { chair(p, '#3a2f2a', '#2a221e', true); hline(p, 5, 3, 6, P.steelLight); px(p, 5, 4, P.steel, 6, 1); },
  // --- board table (2 rows × 3 columns) ---
  BT_TL: (p) => tableTop(p, { t: true, l: true }), BT_TM: (p) => tableTop(p, { t: true }), BT_TR: (p) => tableTop(p, { t: true, r: true }),
  BT_BL: (p) => tableTop(p, { b: true, l: true }), BT_BM: (p) => tableTop(p, { b: true }), BT_BR: (p) => tableTop(p, { b: true, r: true }),
  // --- pantry ---
  COUNTER_L: (p) => counter(p, true, false), COUNTER_M: (p) => counter(p, false, false), COUNTER_R: (p) => counter(p, false, true),
  COFFEE_MACHINE: (p) => { counter(p, false, false); bevel(p, 4, 1, 8, 9, P.steelDark); p.fill(6, 3, 4, 2, '#5ad1ff'); p.fill(5, 7, 6, 2, '#f5f5f0'); px(p, 10, 2, P.amber); },
  FRIDGE: (p) => { bevel(p, 2, 0, 12, 16, P.steelLight); hline(p, 3, 6, 10, P.steel); vline(p, 12, 2, 3, P.steelDark); vline(p, 12, 8, 6, P.steelDark); },
  CAFE_TABLE: (p) => { full(p, '#cfc9be'); bevel(p, 1, 3, 14, 8, P.woodLight); p.fill(7, 11, 2, 4, P.steelDark); p.fill(5, 14, 6, 1, P.steelDark); },
  STOOL: (p) => { full(p, '#cfc9be'); bevel(p, 5, 5, 6, 5, P.wood); p.fill(7, 10, 2, 5, P.steelDark); },
  WATER_COOLER: (p) => { full(p, '#cfc9be'); bevel(p, 5, 0, 6, 6, '#9ad0ff'); bevel(p, 4, 6, 8, 9, P.steelLight); px(p, 6, 9, '#2a6fdb'); px(p, 9, 9, '#d6493a'); },
  // --- props ---
  PLANT_TALL_T: (p) => { p.fill(4, 2, 8, 12, '#2f7d32'); p.fill(6, 0, 4, 5, '#43a047'); p.fill(2, 6, 3, 4, '#43a047'); p.fill(11, 5, 3, 4, '#43a047'); px(p, 5, 3, '#66bb6a', 2, 1); },
  PLANT_TALL_B: (p) => { p.fill(3, 0, 10, 6, '#2f7d32'); p.fill(2, 2, 3, 3, '#43a047'); p.fill(11, 1, 3, 3, '#43a047'); bevel(p, 5, 7, 6, 8, '#a56d36'); hline(p, 5, 7, 6, '#c9a56e'); },
  PLANT_SMALL: (p) => { p.fill(5, 5, 6, 5, '#2f7d32'); p.fill(4, 3, 3, 3, '#43a047'); p.fill(9, 3, 3, 3, '#43a047'); bevel(p, 5, 10, 6, 5, '#a56d36'); },
  BOOKSHELF_T: (p) => { bevel(p, 1, 0, 14, 16, P.woodDark); p.fill(2, 2, 12, 5, '#3a2a1a'); const c = ['#d6493a', '#2a6fdb', '#4cae5c', '#e6a93c', '#9aa3ad']; for (let i = 0; i < 5; i++) p.fill(3 + i * 2, 2, 2, 5, c[i]); p.fill(2, 9, 12, 5, '#3a2a1a'); for (let i = 0; i < 4; i++) p.fill(3 + i * 3, 9, 2, 5, c[(i + 2) % 5]); },
  BOOKSHELF_B: (p) => { bevel(p, 1, 0, 14, 16, P.woodDark); p.fill(2, 1, 12, 5, '#3a2a1a'); const c = ['#4cae5c', '#9aa3ad', '#d6493a', '#2a6fdb']; for (let i = 0; i < 4; i++) p.fill(3 + i * 3, 1, 2, 5, c[i]); p.fill(2, 8, 12, 6, '#3a2a1a'); p.fill(4, 9, 8, 4, '#c9a56e'); },
  FILING: (p) => { bevel(p, 3, 0, 10, 16, P.steel); hline(p, 4, 5, 8, P.steelDark); hline(p, 4, 10, 8, P.steelDark); px(p, 7, 2, P.steelDark, 2, 1); px(p, 7, 7, P.steelDark, 2, 1); px(p, 7, 12, P.steelDark, 2, 1); },
  LAMP_FLOOR: (p) => { p.fill(4, 0, 8, 5, '#f3e6c4'); hline(p, 4, 4, 8, '#d9c79c'); p.fill(7, 5, 2, 9, P.steelDark); p.fill(5, 14, 6, 2, P.steelDark); },
  RACK_T: (p) => { bevel(p, 2, 0, 12, 16, '#23262e'); for (let y = 2; y < 15; y += 3) { hline(p, 3, y, 10, '#3a3f4a'); px(p, 4, y + 1, '#4cae5c'); px(p, 6, y + 1, '#2a6fdb'); } },
  RACK_B: (p) => { bevel(p, 2, 0, 12, 16, '#23262e'); for (let y = 1; y < 12; y += 3) { hline(p, 3, y, 10, '#3a3f4a'); px(p, 4, y + 1, '#4cae5c'); px(p, 12, y + 1, P.amber); } p.fill(2, 13, 12, 3, '#1b1f2a'); },
  SAFE_DOOR: (p) => { bevel(p, 1, 0, 14, 16, P.steelDark); p.fill(3, 2, 10, 12, P.steel); p.fill(6, 5, 4, 4, P.steelDark); px(p, 7, 6, P.steelLight, 2, 2); vline(p, 12, 4, 8, P.amber); },
  SCREEN_BEZEL: (p) => bezel(p, false, false), SCREEN_BEZEL_L: (p) => bezel(p, true, false), SCREEN_BEZEL_R: (p) => bezel(p, false, true),
  // --- the seating corner of a one-person office ---
  // A wool rug: a weave that tiles seamlessly, so a 4 × 3 patch of it reads as one rug rather than as twelve mats.
  RUG: (p) => { full(p, '#b9ae96'); for (let y = 0; y < 16; y += 2) hline(p, 0, y, 16, '#c7bda6'); for (let x = 1; x < 16; x += 4) vline(p, x, 0, 16, '#ad9f85'); dither(p, 0, 0, 16, 16, '#d3cab6', 10, 5); },
  SOFA_L: (p) => sofa(p, true, false), SOFA_R: (p) => sofa(p, false, true),
  SIDE_TABLE: (p) => { bevel(p, 2, 4, 12, 7, P.woodLight); p.fill(3, 11, 2, 4, P.woodDark); p.fill(11, 11, 2, 4, P.woodDark); p.fill(5, 2, 6, 3, '#c9d6e2'); px(p, 6, 3, '#6f8ea8', 4, 1); },
};

/** One half of a two-tile sofa: a back along the top, a seat cushion, and an arm on the outer edge. */
function sofa(p: Px, left: boolean, right: boolean): void {
  const body = '#55617a', backTop = shade(body, 0.10), cushion = '#6b7893', shadow = shade(body, -0.14);
  p.fill(0, 2, 16, 5, body); hline(p, 0, 2, 16, backTop);
  p.fill(0, 7, 16, 7, cushion); hline(p, 0, 7, 16, shade(cushion, 0.08)); hline(p, 0, 13, 16, shadow);
  if (left) { p.fill(0, 4, 3, 10, body); hline(p, 0, 4, 3, backTop); }
  if (right) { p.fill(13, 4, 3, 10, body); hline(p, 13, 4, 3, backTop); vline(p, 15, 4, 10, shadow); }
  if (!left) vline(p, 0, 7, 7, shade(cushion, -0.06));
  p.fill(left ? 3 : 0, 14, left || right ? 13 : 16, 2, shade(body, -0.25));
}
