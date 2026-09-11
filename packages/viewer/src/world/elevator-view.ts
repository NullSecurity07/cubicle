/**
 * What the elevator looks like: a steel car riding the shaft behind a door pair per floor, riders reparented into
 * the car and masked to the shaft, an amber floor digit above each door. The engine (world/elevator.ts) owns the
 * state; this only draws `setState(...)` every frame. No audio.
 */
import type Phaser from 'phaser';
import { TILE } from './map.js';
import { T } from './tiles.js';
import { OPEN_MS, type ElevatorState } from './elevator.js';
import { PALETTE, hexToInt } from './palette.js';

export interface ElevatorViewState { carY: number; doorOpen: number; floor: number; moving: boolean; riders: string[] }
const SLIDE_MS = 150, DOOR_SLIDE_PX = 6, RES = 3;

/** 0 closed … 1 open. Doors slide during the first and last 150 ms of a stop. */
export function doorOpenFor(status: ElevatorState['status'], openLeft: number, openMs = OPEN_MS): number {
  if (status !== 'open') return 0;
  const elapsed = openMs - openLeft;
  return Math.max(0, Math.min(1, elapsed / SLIDE_MS, openLeft / SLIDE_MS));
}

export function toViewState(s: ElevatorState, tile = TILE): ElevatorViewState {
  return { carY: s.row * tile, doorOpen: doorOpenFor(s.status, s.openLeft), floor: s.floor, moving: s.status === 'moving', riders: s.riders.map((r) => r.id) };
}

export class ElevatorView {
  readonly car: Phaser.GameObjects.Container;
  private doors: { n: number; l: Phaser.GameObjects.Image; r: Phaser.GameObjects.Image; x: number; digit: Phaser.GameObjects.Text }[] = [];
  readonly mask: Phaser.Display.Masks.GeometryMask;
  private maskShape: Phaser.GameObjects.Graphics;
  private lamp: Phaser.GameObjects.Rectangle;
  private last: ElevatorViewState | null = null;

  constructor(private scene: Phaser.Scene, shaft: { tx: number; ty: number; tw: number; th: number }, floors: { n: number; y0: number }[]) {
    const x = shaft.tx * TILE, w = shaft.tw * TILE, carH = 3 * TILE;
    // the car, drawn about its top-centre (the scene positions the container at (52.5 * TILE, row * TILE) every frame):
    // steel back wall, a handrail, a ceiling lamp; riders are placed on it by AgentSprite.attachTo()
    const back = scene.add.rectangle(-w / 2, 0, w, carH, hexToInt(PALETTE.steelDark)).setOrigin(0);
    const rail = scene.add.rectangle(-w / 2 + 2, carH - 12, w - 4, 2, hexToInt(PALETTE.steelLight)).setOrigin(0);
    this.lamp = scene.add.rectangle(-4, 1, 8, 2, hexToInt(PALETTE.windowNight)).setOrigin(0);
    this.car = scene.add.container(x + w / 2, (floors[0]?.y0 ?? 0) * TILE, [back, rail, this.lamp]);
    // the car and its riders are clipped to the shaft interior
    this.maskShape = scene.add.graphics().setVisible(false);
    this.maskShape.fillStyle(0xffffff).fillRect(x, shaft.ty * TILE, w, shaft.th * TILE);
    this.mask = this.maskShape.createGeometryMask();
    this.car.setMask(this.mask);
    // a door pair and an amber digit per floor, at the elevator door tile (one tile left of the shaft)
    for (const f of floors) {
      const dx = (shaft.tx - 1) * TILE, dy = (f.y0 + 11) * TILE;
      const l = scene.add.image(dx, dy, 'office', 0).setOrigin(0).setCrop(0, 0, 8, TILE).setDepth(4);
      const r = scene.add.image(dx, dy, 'office', 0).setOrigin(0).setCrop(8, 0, 8, TILE).setDepth(4);
      const digit = scene.add.text(dx + TILE / 2, dy - 2, String(f.n), { fontFamily: 'system-ui, sans-serif', fontSize: `${7 * RES}px`, fontStyle: 'bold', color: PALETTE.amber }).setOrigin(0.5, 1).setScale(1 / RES).setDepth(4).setAlpha(0.5);
      this.doors.push({ n: f.n, l, r, x: dx, digit });
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
      d.l.setTexture('office', 'elev-door-l').setCrop(0, 0, 8, TILE); d.r.setTexture('office', 'elev-door-r').setCrop(8, 0, 8, TILE);
    }
  }

  setState(s: ElevatorViewState): void {
    if (this.last && this.last.carY === s.carY && this.last.doorOpen === s.doorOpen && this.last.floor === s.floor && this.last.moving === s.moving) return;
    this.last = s;
    this.lamp.setFillStyle(hexToInt(s.moving ? PALETTE.amber : PALETTE.windowNight));
    for (const d of this.doors) {
      const open = d.n === s.floor && !s.moving ? s.doorOpen : 0;   // doors are closed everywhere while the car moves
      d.l.x = d.x - Math.round(DOOR_SLIDE_PX * open); d.r.x = d.x + Math.round(DOOR_SLIDE_PX * open);
      d.digit.setAlpha(d.n === s.floor ? 1 : 0.5);
    }
  }

  destroy(): void { this.car.destroy(); this.maskShape.destroy(); for (const d of this.doors) { d.l.destroy(); d.r.destroy(); d.digit.destroy(); } }
}
