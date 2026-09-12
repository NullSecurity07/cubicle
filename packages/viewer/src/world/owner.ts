/** The owner sits in `owner_chair` only while a board meeting is open (the owner rules the board). */
import type Phaser from 'phaser';
import type { State } from '../state.js';
import { toPx, type Tile } from './map.js';
import { frameFor, faceFrame } from './frames.js';
import { SPRITE_H } from './sprite-draw.js';
import { RES, nameLabelStyle, nameLabelView } from './text.js';
import { addText } from './text-crisp.js';
import { Latch } from './latch.js';
import { BOARD_SESSION_MAX_MS } from '../ui/board.js';

/**
 * The owner sits only while the board really is sitting. `now` is passed so a session whose `meeting.closed`
 * was lost — a kill, a crash, a dropped socket between the open and the close — stops seating the owner after
 * `BOARD_SESSION_MAX_MS`, instead of leaving them in the chair until the next session opens. The reducer ages
 * the same state off the event log; this is the renderer's own clock saying the same thing.
 */
export function boardSessionOpen(meetings: State['meetings'], now = Date.now()): boolean {
  return Object.values(meetings).some((m) => m.open && m.room === 'board' && now - Date.parse(m.at) <= BOARD_SESSION_MAX_MS);
}

export class OwnerAvatar {
  readonly container: Phaser.GameObjects.Container;
  private readonly label: Phaser.GameObjects.Text;
  private readonly labelLatch = new Latch<number>();
  /** `key` is `makeOwnerSprite(scene)` (tileset.ts); passed in so this module never imports the Phaser runtime and stays testable. */
  /** `ink` is the floor's skirting colour: the owner's plate is the same object every other name plate is. */
  constructor(scene: Phaser.Scene, tile: Tile, key: string, faces = 'faces', ink?: string) {
    const body = scene.add.sprite(0, 0, key, frameFor({ moving: false, dir: 0, step: 0, pose: 'seated' })).setOrigin(0.5, 1);
    // The owner had no face overlay at all, so "You" was a dark silhouette in the board chair while everyone at the
    // table had eyes (visual QA I9). It is the same shared sheet every sprite uses, at the same offset.
    const face = scene.add.image(-4, -SPRITE_H + 4, faces, faceFrame('neutral', 0, {})).setOrigin(0, 0);
    this.label = addText(scene, 0, 2, 'You', nameLabelStyle(undefined, ink)).setOrigin(0.5, 0).setScale(1 / RES).setVisible(false);
    const p = toPx(tile);
    this.container = scene.add.container(p.x, p.y + 6, [body, face, this.label]).setDepth(10 + (p.y + 6) / 10000).setVisible(false);
  }
  setVisible(on: boolean): void { if (this.container.visible !== on) this.container.setVisible(on); }
  /** The owner's name follows the same rule as everyone else's (ruling F1): hidden below zoom 2, screen-space constant above. */
  setZoom(zoom: number): void {
    if (!this.labelLatch.changed(zoom)) return;
    const v = nameLabelView(zoom);
    this.label.setVisible(v.visible).setScale(v.scale);   // "You" fits any budget
  }
}
