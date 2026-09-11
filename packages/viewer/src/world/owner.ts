/** The owner sits in `owner_chair` only while a board meeting is open (the owner rules the board). */
import type Phaser from 'phaser';
import type { State } from '../state.js';
import { toPx, type Tile } from './map.js';
import { frameFor } from './frames.js';

export function boardSessionOpen(meetings: State['meetings']): boolean { return Object.values(meetings).some((m) => m.open && m.room === 'board'); }

const RES = 3;
export class OwnerAvatar {
  readonly container: Phaser.GameObjects.Container;
  /** `key` is `makeOwnerSprite(scene)` (tileset.ts); passed in so this module never imports the Phaser runtime and stays testable. */
  constructor(scene: Phaser.Scene, tile: Tile, key: string) {
    const body = scene.add.sprite(0, 0, key, frameFor({ moving: false, dir: 0, step: 0, pose: 'seated' })).setOrigin(0.5, 1);
    const label = scene.add.text(0, 2, 'You', { fontFamily: 'system-ui', fontSize: `${9 * RES}px`, color: '#fff', stroke: '#000', strokeThickness: 2 * RES }).setOrigin(0.5, 0).setScale(1 / RES);
    const p = toPx(tile);
    this.container = scene.add.container(p.x, p.y + 6, [body, label]).setDepth(10 + (p.y + 6) / 10000).setVisible(false);
  }
  setVisible(on: boolean): void { if (this.container.visible !== on) this.container.setVisible(on); }
}
