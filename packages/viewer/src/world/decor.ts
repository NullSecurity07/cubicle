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
import { TILE, type Tile } from './map.js';
import type { AgentView } from '../state.js';

export type DecorKind = 'plant' | 'coffee' | 'lamp' | 'monitor' | 'cooler';
/** Structurally plan 1's `map.ts` `DecorItem` / `SignInfo`, declared here so this module needs nothing but `TILE`/`Tile` from map.ts. */
export interface DecorSource { kind: string; tile: Tile; floor: number; desk?: string }
export interface SignSource { tile: Tile; room: string; label: string; floor: number }
export const DECOR_FRAMES: Record<DecorKind, number> = { plant: 2, coffee: 3, lamp: 1, monitor: 2, cooler: 2 };
const KINDS: DecorKind[] = ['plant', 'coffee', 'lamp', 'monitor', 'cooler'];
export const DECOR_FRAME_NAMES: { name: string; x: number }[] = (() => { const out: { name: string; x: number }[] = []; let x = 0; for (const k of KINDS) for (let f = 0; f < DECOR_FRAMES[k]; f++) { out.push({ name: `${k}:${f}`, x }); x += TILE; } return out; })();

/** Which frame a decor object shows now; null hides it. */
export function decorFrame(kind: DecorKind, nowMs: number, ctx: { occupied: boolean; working: boolean }): number | null {
  switch (kind) {
    case 'plant': return Math.floor(nowMs / 800) % 2;
    case 'coffee': return ctx.occupied ? Math.floor(nowMs / 500) % 3 : null;
    case 'monitor': return ctx.working ? 1 : 0;
    case 'cooler': return nowMs % 6000 < 400 ? 1 : 0;
    case 'lamp': return null;
  }
}

const leaf = '#43a047', leafDark = '#2f7d32', steam = 'rgba(255,255,255,0.7)';
export const DECOR_DRAW: Record<DecorKind, (p: Px, frame: number) => void> = {
  plant: (p, f) => { const dx = f === 0 ? 0 : 1; p.fill(4 + dx, 3, 8, 8, leafDark); p.fill(6 + dx, 1, 4, 4, leaf); p.fill(3, 6, 3, 3, leaf); p.fill(10 + dx, 6, 3, 3, leaf); px(p, 7 + dx, 2, '#66bb6a', 2, 1); },
  coffee: (p, f) => { const y = 10 - f * 3; px(p, 6, y, steam, 1, 2); px(p, 9, y - 1, steam, 1, 2); px(p, 7 + (f % 2), y - 3, steam, 1, 1); },
  lamp: (p) => { px(p, 7, 7, PALETTE.windowNight, 2, 2); },
  monitor: (p, f) => { p.fill(4, 2, 6, 4, f ? '#5ad1ff' : '#1b1f2a'); if (f) { hline(p, 5, 3, 3, '#ffffff'); hline(p, 5, 4, 2, '#ffffff'); } },
  cooler: (p, f) => { p.fill(5, 0, 6, 6, '#9ad0ff'); if (f) { px(p, 7, 1, '#e6f4ff'); px(p, 9, 3, '#e6f4ff'); } vline(p, 5, 0, 6, '#7cb8e8'); },
};

interface DecorItem { kind: DecorKind; img: Phaser.GameObjects.Image; tile: Tile; desk: string | null }

export class DecorLayer {
  private items: DecorItem[] = [];
  constructor(scene: Phaser.Scene, decor: DecorSource[]) {
    for (const d of decor) {
      const kind = d.kind as DecorKind;
      if (!(kind in DECOR_FRAMES) || kind === 'lamp') continue;
      const img = scene.add.image(d.tile.tx * TILE, d.tile.ty * TILE - (kind === 'coffee' ? TILE : 0), 'decor', `${kind}:0`).setOrigin(0).setDepth(kind === 'monitor' ? 2.5 : 3);
      this.items.push({ kind, img, tile: d.tile, desk: d.desk ?? null });
    }
  }
  /** `sprites` = each role's current tile; `agents` = the reducer views (working state, desk). */
  update(nowMs: number, agents: Record<string, AgentView>, sprites: Record<string, Tile>): void {
    const byDesk = new Map<string, AgentView>(); for (const v of Object.values(agents)) byDesk.set(v.desk, v);
    for (const it of this.items) {
      const occupied = it.kind === 'coffee' && Object.values(sprites).some((t) => Math.abs(t.tx - it.tile.tx) <= 1 && t.ty === it.tile.ty + 1);
      const working = it.kind === 'monitor' && !!it.desk && byDesk.get(it.desk)?.state === 'working';
      const f = decorFrame(it.kind, nowMs, { occupied, working });
      if (f === null) { if (it.img.visible) it.img.setVisible(false); continue; }
      const name = `${it.kind}:${f}`;
      if (!it.img.visible) it.img.setVisible(true);
      if (it.img.frame.name !== name) it.img.setFrame(name);
    }
  }
  images(): Phaser.GameObjects.Image[] { return this.items.map((i) => i.img); }
}

const RES = 3;
/** Room labels on the sign tiles (RES 3 text in the floor's skirting colour; head ≤ 44 chars). */
export class RoomSigns {
  readonly texts: Phaser.GameObjects.Text[] = [];
  constructor(scene: Phaser.Scene, signs: Record<string, SignSource>) {
    for (const sg of Object.values(signs)) {
      const color = floorPalette(sg.floor).skirting;
      const label = (sg.label || sg.room).slice(0, 44);
      this.texts.push(scene.add.text(sg.tile.tx * TILE + 2, sg.tile.ty * TILE + 1, label, { fontFamily: 'system-ui, sans-serif', fontSize: `${7 * RES}px`, fontStyle: '600', color: '#ffffff', backgroundColor: color, padding: { x: 2 * RES, y: RES } }).setOrigin(0, 0).setScale(1 / RES).setDepth(4));
    }
  }
}
