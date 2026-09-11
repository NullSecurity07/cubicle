/**
 * Ambient life from the map's `decor` objects: plant sway, coffee steam while someone stands at the machine, monitor
 * glow while the desk's agent works, a cooler bubble every 6 s. Frame-based (one Image per object, a frame swap
 * per tick, no Graphics). Signs: one text per `sign` anchor in the floor tint.
 *
 * The decor sheet's canvas texture (`makeDecorSheet`) lives in tileset.ts, appended there so it merges cleanly
 * alongside the other tileset-building tasks that touch the same file; this module stays Phaser-free.
 */
import type Phaser from 'phaser';
import { px, hline, vline, type Px } from './tiles-draw.js';
import { PALETTE, floorPalette } from './palette.js';
import { RES, signLabelStyle } from './text.js';
import { TILE, type Tile } from './map.js';
import type { AgentView } from '../state.js';

export type DecorKind = 'plant' | 'plant2' | 'coffee' | 'lamp' | 'monitor' | 'cooler';
/** Structurally plan 1's `map.ts` `DecorItem` / `SignInfo`, declared here so this module needs nothing but `TILE`/`Tile` from map.ts. */
export interface DecorSource { kind: string; tile: Tile; floor: number; desk?: string }
export interface SignSource { tile: Tile; room: string; label: string; floor: number }
export const DECOR_FRAMES: Record<DecorKind, number> = { plant: 2, plant2: 2, coffee: 3, lamp: 1, monitor: 2, cooler: 2 };
const KINDS: DecorKind[] = ['plant', 'plant2', 'coffee', 'lamp', 'monitor', 'cooler'];
export const DECOR_FRAME_NAMES: { name: string; x: number }[] = (() => { const out: { name: string; x: number }[] = []; let x = 0; for (const k of KINDS) for (let f = 0; f < DECOR_FRAMES[k]; f++) { out.push({ name: `${k}:${f}`, x }); x += TILE; } return out; })();

/** Which frame a decor object shows now; null hides it. */
export function decorFrame(kind: DecorKind, nowMs: number, ctx: { occupied: boolean; working: boolean }): number | null {
  switch (kind) {
    case 'plant': case 'plant2': return Math.floor(nowMs / 800) % 2;
    case 'coffee': return ctx.occupied ? Math.floor(nowMs / 500) % 3 : null;
    case 'monitor': return ctx.working ? 1 : 0;
    case 'cooler': return nowMs % 6000 < 400 ? 1 : 0;
    case 'lamp': return null;
  }
}

const { leaf, leafDark, leafLight, steam } = PALETTE;
/**
 * Two silhouettes, alternating along the street: a round bush and a taller, narrower shrub. Six identical blobs
 * at the same spacing read as a repeat, and the old greens were the most saturated thing in the lower third of
 * every shot — against the rule that the ground stays quiet so sprites and screens dominate.
 */
const plantRound = (p: Px, dx: number): void => { p.fill(4 + dx, 3, 8, 8, leafDark); p.fill(6 + dx, 1, 4, 4, leaf); p.fill(3, 6, 3, 3, leaf); p.fill(10 + dx, 6, 3, 3, leaf); px(p, 7 + dx, 2, leafLight, 2, 1); };
const plantTall = (p: Px, dx: number): void => { p.fill(6 + dx, 1, 5, 10, leafDark); p.fill(7 + dx, 0, 3, 5, leaf); p.fill(4, 7, 3, 4, leaf); p.fill(11 + dx, 5, 2, 4, leaf); px(p, 8 + dx, 1, leafLight, 1, 2); };
/** Which silhouette a planter uses: alternating by tile column, so neighbours never match. */
export const plantShape = (tx: number): 0 | 1 => (Math.abs(Math.round(tx)) % 2) as 0 | 1;

export const DECOR_DRAW: Record<DecorKind, (p: Px, frame: number) => void> = {
  plant: (p, f) => plantRound(p, f === 0 ? 0 : 1),
  plant2: (p, f) => plantTall(p, f === 0 ? 0 : 1),
  coffee: (p, f) => { const y = 10 - f * 3; px(p, 6, y, steam, 1, 2); px(p, 9, y - 1, steam, 1, 2); px(p, 7 + (f % 2), y - 3, steam, 1, 1); },
  lamp: (p) => { px(p, 7, 7, PALETTE.windowNight, 2, 2); },
  monitor: (p, f) => { p.fill(4, 2, 6, 4, f ? PALETTE.monitorOn : PALETTE.monitorOff); if (f) { hline(p, 5, 3, 3, PALETTE.monitorGlyph); hline(p, 5, 4, 2, PALETTE.monitorGlyph); } },
  cooler: (p, f) => { p.fill(5, 0, 6, 6, PALETTE.water); if (f) { px(p, 7, 1, PALETTE.waterLight); px(p, 9, 3, PALETTE.waterLight); } vline(p, 5, 0, 6, PALETTE.waterDark); },
};

interface DecorItem { kind: DecorKind; img: Phaser.GameObjects.Image; tile: Tile; desk: string | null; serveX0: number; serveX1: number; serveY: number }

export class DecorLayer {
  private items: DecorItem[] = [];
  private readonly byDesk = new Map<string, AgentView>();
  private deskKey: string[] = [];
  private deskOf: string[] = [];
  constructor(scene: Phaser.Scene, decor: DecorSource[]) {
    for (const d of decor) {
      // the map only ever says "plant"; which of the two silhouettes it gets is a function of where it stands
      const kind = (d.kind === 'plant' ? (plantShape(d.tile.tx) ? 'plant2' : 'plant') : d.kind) as DecorKind;
      if (!(kind in DECOR_FRAMES) || kind === 'lamp') continue;
      const img = scene.add.image(d.tile.tx * TILE, d.tile.ty * TILE - (kind === 'coffee' ? TILE : 0), 'decor', `${kind}:0`).setOrigin(0).setDepth(kind === 'monitor' ? 2.5 : 3);
      this.items.push({ kind, img, tile: d.tile, desk: d.desk ?? null, serveX0: d.tile.tx - 1, serveX1: d.tile.tx + 1, serveY: d.tile.ty + 1 });
    }
  }
  /** `sprites` = each role's current tile; `agents` = the reducer views (working state, desk). */
  update(nowMs: number, agents: Record<string, AgentView>, sprites: Record<string, Tile>): void {
    // desk → view is a per-frame Map rebuild for a mapping that only changes when someone is hired, fired or moved.
    const roles = Object.keys(agents);
    if (roles.length !== this.deskKey.length || roles.some((r, i) => r !== this.deskKey[i] || agents[r].desk !== this.deskOf[i])) {
      this.deskKey = roles; this.deskOf = roles.map((r) => agents[r].desk);
      this.byDesk.clear(); for (const v of Object.values(agents)) this.byDesk.set(v.desk, v);
    } else for (const v of Object.values(agents)) this.byDesk.set(v.desk, v);   // same set, fresh views
    const byDesk = this.byDesk;
    for (const it of this.items) {
      // a coffee machine only ever has the same handful of neighbouring tiles: compare against those, not every sprite
      const occupied = it.kind === 'coffee' && this.someoneAt(it, sprites);
      const working = it.kind === 'monitor' && !!it.desk && byDesk.get(it.desk)?.state === 'working';
      const f = decorFrame(it.kind, nowMs, { occupied, working });
      if (f === null) { if (it.img.visible) it.img.setVisible(false); continue; }
      const name = `${it.kind}:${f}`;
      if (!it.img.visible) it.img.setVisible(true);
      if (it.img.frame.name !== name) it.img.setFrame(name);
    }
  }
  /** Is anyone standing at this coffee machine? Its three serving tiles are precomputed, so this is three lookups. */
  private someoneAt(it: DecorItem, sprites: Record<string, Tile>): boolean {
    for (const k in sprites) { const t = sprites[k]; if (t.ty === it.serveY && t.tx >= it.serveX0 && t.tx <= it.serveX1) return true; }
    return false;
  }
  images(): Phaser.GameObjects.Image[] { return this.items.map((i) => i.img); }
}

/** Room labels on the sign tiles (RES 3 text in the floor's skirting colour; head ≤ 44 chars). */
export class RoomSigns {
  readonly texts: Phaser.GameObjects.Text[] = [];
  constructor(scene: Phaser.Scene, signs: Record<string, SignSource>) {
    for (const sg of Object.values(signs)) {
      const color = floorPalette(sg.floor).skirting;
      const label = (sg.label || sg.room).slice(0, 44);
      // Depth 5.5, above the wall Surfaces at 5: a screen hung on the same wall band used to clip "Board room" to
      // "Boar…". The 2 px of extra left padding is the clear band that keeps the first glyph off the screen frame.
      this.texts.push(scene.add.text(sg.tile.tx * TILE + 4, sg.tile.ty * TILE + 1, label, signLabelStyle(color)).setOrigin(0, 0).setScale(1 / RES).setDepth(5.5));
    }
  }
}
