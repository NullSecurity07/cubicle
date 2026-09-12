/**
 * What the elevator looks like: a steel car riding the shaft behind a door pair per floor, riders reparented into
 * the car and masked to the shaft, an amber floor digit above each door. The engine (world/elevator.ts) owns the
 * state; this only draws `setState(...)` every frame. No audio.
 */
import type Phaser from 'phaser';
import { TILE } from './map.js';
import { T } from './tiles.js';
import { OPEN_MS, type ElevatorState, type Rider } from './elevator.js';
import { PALETTE, hexToInt, shade } from './palette.js';
import { DUR, dur } from './motion.js';
import { RES, FONT } from './text.js';
import { addText } from './text-crisp.js';

export interface ElevatorViewState { carY: number; doorOpen: number; floor: number; moving: boolean; riders: string[] }
const DOOR_SLIDE_PX = 6, HALF = 8;

/** 0 closed … 1 open. Doors slide during the first and last `DUR.doorSlide` ms of a stop (scaled by reduced motion). */
export function doorOpenFor(status: ElevatorState['status'], openLeft: number, openMs = OPEN_MS): number {
  if (status !== 'open') return 0;
  const slideMs = dur(DUR.doorSlide);
  const elapsed = openMs - openLeft;
  return Math.max(0, Math.min(1, elapsed / slideMs, openLeft / slideMs));
}

/**
 * The visible slice of each door leaf at `open` (0 closed … 1 open), within the leaf's own 16 px tile.
 *
 * Both leaves retract into the jamb by narrowing their crop — the left one from its right edge, the right one
 * from its left — so they part symmetrically about the centre and neither ever leaves its tile. Sliding the
 * leaves bodily would need a pocket tile either side; the left leaf used to slide alone into the corridor and
 * the right one never moved, which reads as a glitch rather than as a door.
 */
export function doorCrop(open: number): { l: { x: number; w: number }; r: { x: number; w: number } } {
  const slide = Math.round(DOOR_SLIDE_PX * Math.max(0, Math.min(1, open)));
  return { l: { x: 0, w: HALF - slide }, r: { x: HALF + slide, w: HALF - slide } };
}

// toViewState is called every animation frame. world/elevator.ts's `step` keeps the same `riders` array reference
// while idle or moving (the common case, and the longest-lived one), so a tiny reference-keyed cache avoids
// reallocating the id list on those frames; while a door is open, `serve()` rebuilds the array every step
// regardless of whether anyone actually boards, so the cache simply misses (and repopulates) for that window.
const ridersCache = new WeakMap<Rider[], string[]>();
function ridersOf(riders: Rider[]): string[] {
  const cached = ridersCache.get(riders);
  if (cached) return cached;
  const ids = riders.map((r) => r.id);
  ridersCache.set(riders, ids);
  return ids;
}

/** A fresh view state for a caller that wants to reuse one object across frames (see `toViewState`'s `into`). */
export function emptyViewState(): ElevatorViewState { return { carY: 0, doorOpen: 0, floor: 1, moving: false, riders: [] }; }

/**
 * Map the engine state to what the view draws. Called every animation frame, so `into` lets the caller hand in
 * the object to fill: the rAF loop keeps one and allocates nothing. Omit it and you get a fresh object.
 */
export function toViewState(s: ElevatorState, tile = TILE, into?: ElevatorViewState): ElevatorViewState {
  const out = into ?? emptyViewState();
  out.carY = s.row * tile;
  out.doorOpen = doorOpenFor(s.status, s.openLeft);
  out.floor = s.floor;
  out.moving = s.status === 'moving';
  out.riders = ridersOf(s.riders);
  return out;
}

export class ElevatorView {
  readonly car: Phaser.GameObjects.Container;
  private doors: { n: number; l: Phaser.GameObjects.Image; r: Phaser.GameObjects.Image; recess: Phaser.GameObjects.Rectangle; digit: Phaser.GameObjects.Text }[] = [];
  readonly mask: Phaser.Display.Masks.GeometryMask;
  private maskShape: Phaser.GameObjects.Graphics;
  private lamp: Phaser.GameObjects.Rectangle;
  private readonly last: { doorOpen: number; floor: number; moving: boolean } = { doorOpen: -1, floor: -1, moving: false };

  constructor(private scene: Phaser.Scene, shaft: { tx: number; ty: number; tw: number; th: number }, floors: { n: number; y0: number }[]) {
    const x = shaft.tx * TILE, w = shaft.tw * TILE, carH = 3 * TILE;
    /*
     * The car, drawn about its top-centre (the scene positions the container at (52.5 * TILE, row * TILE) every
     * frame). It used to be a `steelDark` rectangle inside a shaft drawn in the same steel family, with a 2 px
     * handrail and an 8 × 2 lamp: at 4x magnification the shaft showed ladder rails, one pale line and one tan
     * slab, and the rider masked into it could not be picked out at all (visual QA C5). A cab reads as an object
     * travelling past those rails when it is lighter than the shaft, outlined, floored, and seamed down the middle
     * where its own doors meet — and when it casts a shadow onto the wall behind it.
     */
    const shadow = scene.add.rectangle(-w / 2 + 3, 4, w, carH, hexToInt(PALETTE.screenInk), 0.35).setOrigin(0);
    const body = scene.add.rectangle(-w / 2, 0, w, carH, hexToInt(PALETTE.steel)).setOrigin(0).setStrokeStyle(1, hexToInt(shade(PALETTE.steelDark, -0.18)), 1);
    const ceiling = scene.add.rectangle(-w / 2 + 1, 1, w - 2, 3, hexToInt(PALETTE.steelDark)).setOrigin(0);
    const panel = scene.add.rectangle(-w / 2 + 3, 5, w - 6, carH - 11, hexToInt(shade(PALETTE.steel, -0.07))).setOrigin(0);
    // the cab's own doors: a seam down the centre with a jamb either side, so the car reads as closed in transit
    const seamL = scene.add.rectangle(-1, 5, 1, carH - 11, hexToInt(shade(PALETTE.steel, -0.20))).setOrigin(0);
    const seamR = scene.add.rectangle(1, 5, 1, carH - 11, hexToInt(PALETTE.steelLight), 0.7).setOrigin(0);
    const floorLine = scene.add.rectangle(-w / 2 + 1, carH - 6, w - 2, 5, hexToInt(shade(PALETTE.steelDark, -0.10))).setOrigin(0);
    const kick = scene.add.rectangle(-w / 2 + 1, carH - 6, w - 2, 1, hexToInt(PALETTE.steelLight), 0.5).setOrigin(0);
    const rail = scene.add.rectangle(-w / 2 + 3, carH - 14, w - 6, 2, hexToInt(PALETTE.steelLight)).setOrigin(0);
    this.lamp = scene.add.rectangle(-5, 2, 10, 2, hexToInt(PALETTE.windowNight)).setOrigin(0);
    this.car = scene.add.container(x + w / 2, (floors[0]?.y0 ?? 0) * TILE, [shadow, body, ceiling, panel, seamL, seamR, floorLine, kick, rail, this.lamp]);
    // the car and its riders are clipped to the shaft interior
    this.maskShape = scene.add.graphics().setVisible(false);
    this.maskShape.fillStyle(0xffffff).fillRect(x, shaft.ty * TILE, w, shaft.th * TILE);   // palette-lint: ignore — a geometry mask's stencil value, not a colour
    this.mask = this.maskShape.createGeometryMask();
    this.car.setMask(this.mask);
    // a door pair and an amber digit per floor, at the elevator door tile (one tile left of the shaft); a dark
    // recess sits behind the leaves so parting them reveals a gap rather than the shaft's steel bleeding through
    for (const f of floors) {
      const dx = (shaft.tx - 1) * TILE, dy = (f.y0 + 11) * TILE;
      const recess = scene.add.rectangle(dx, dy, TILE, TILE, hexToInt(shade(PALETTE.steelDark, -0.35))).setOrigin(0).setDepth(3);
      const l = scene.add.image(dx, dy, 'office', 0).setOrigin(0).setCrop(0, 0, HALF, TILE).setDepth(4);
      const r = scene.add.image(dx, dy, 'office', 0).setOrigin(0).setCrop(HALF, 0, HALF, TILE).setDepth(4);
      const digit = addText(scene, dx + TILE / 2, dy - 2, String(f.n), { fontFamily: FONT, fontSize: `${7 * RES}px`, fontStyle: 'bold', color: PALETTE.amber }).setOrigin(0.5, 1).setScale(1 / RES).setDepth(4).setAlpha(0.5);
      this.doors.push({ n: f.n, l, r, recess, digit });
    }
    this.setDoorFrames();
  }

  /** The door images show the ELEV_DOOR_L / ELEV_DOOR_R tiles from the office tileset. */
  private setDoorFrames(): void {
    const tex = this.scene.textures.get('office');
    const cols = tex.getSourceImage().width / TILE;
    const frame = (id: number): { x: number; y: number } => ({ x: ((id - 1) % cols) * TILE, y: Math.floor((id - 1) / cols) * TILE });
    for (const d of this.doors) {
      const l = frame(T.ELEV_DOOR_L), r = frame(T.ELEV_DOOR_R);
      if (!tex.has('elev-door-l')) tex.add('elev-door-l', 0, l.x, l.y, TILE, TILE);
      if (!tex.has('elev-door-r')) tex.add('elev-door-r', 0, r.x, r.y, TILE, TILE);
      d.l.setTexture('office', 'elev-door-l').setCrop(0, 0, HALF, TILE); d.r.setTexture('office', 'elev-door-r').setCrop(HALF, 0, HALF, TILE);
    }
  }

  /** Every game object that only makes sense on the main camera (drawn as amber smudges at minimap scale otherwise). */
  ignorables(): Phaser.GameObjects.GameObject[] {
    return this.doors.flatMap((d) => [d.l, d.r, d.recess, d.digit]);
  }

  setState(s: ElevatorViewState): void {
    // Compare field by field, never by object identity: the caller reuses one view-state object across frames.
    if (this.last.doorOpen === s.doorOpen && this.last.floor === s.floor && this.last.moving === s.moving) return;
    this.last.doorOpen = s.doorOpen; this.last.floor = s.floor; this.last.moving = s.moving;
    this.lamp.setFillStyle(hexToInt(s.moving ? PALETTE.amber : PALETTE.windowNight));
    for (const d of this.doors) {
      const open = d.n === s.floor && !s.moving ? s.doorOpen : 0;   // doors are closed everywhere while the car moves
      const c = doorCrop(open);
      d.l.setCrop(c.l.x, 0, c.l.w, TILE);
      d.r.setCrop(c.r.x, 0, c.r.w, TILE);
      d.digit.setAlpha(d.n === s.floor ? 1 : 0.5);
    }
  }

  destroy(): void {
    this.car.clearMask();
    this.car.destroy();
    this.maskShape.destroy();
    this.mask.destroy();
    for (const d of this.doors) { d.l.destroy(); d.r.destroy(); d.recess.destroy(); d.digit.destroy(); }
  }
}
