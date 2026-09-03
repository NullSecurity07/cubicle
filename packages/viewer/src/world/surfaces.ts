import Phaser from 'phaser';
import type { World, Anchor } from './map.js';
import { TILE } from './tileset.js';
import type { State } from '../state.js';
import { headlineFor, cut } from './headlines.js';

export type SurfaceKind = 'billboard' | 'terminal' | 'postoffice' | 'newsstand' | 'bank' | 'vault' | 'workshop' | 'whiteboard' | 'noticeboard' | 'cabin';

const PAD = 6;
const HEAD_PX = 10, LINE_PX = 8, LINE_H = 10, HEAD_H = 14;
const CHAR_W = 0.62; // generous glyph width as a fraction of the font size, so a cut line never reaches the box edge
const RES = 3; // text is rasterised at 3× so it stays crisp when the camera zooms in
const NARROW = 40; // inner width below which a screen shows only its short form (a count or a word)

/**
 * A place on the map that shows a glanceable preview of one stream (spec §10 "Surface") and opens the HTML
 * layer on click. Text is a head line plus a few short lines, wrapped to the box and cropped to it, so a long
 * plan or brief can never spill over the walls: the full content lives in the drawer / document modal.
 */
export class Surface {
  readonly container: Phaser.GameObjects.Container;
  private bg: Phaser.GameObjects.Rectangle;
  private head: Phaser.GameObjects.Text;
  private text: Phaser.GameObjects.Text;
  private image: Phaser.GameObjects.Image | null = null;
  private bars: Phaser.GameObjects.Graphics;
  private badge: Phaser.GameObjects.Text;
  private lastKey = '';
  private readonly innerW: number;
  private readonly innerH: number;
  private readonly inset: number;

  constructor(private scene: Phaser.Scene, world: World, public readonly kind: SurfaceKind, public readonly anchor: Anchor, onClick: (k: SurfaceKind) => void) {
    // The whiteboard preview hangs on the corridor wall just above the board room (rows ty-2..ty-1), clear of the cabin.
    const x = anchor.tx * TILE, y = kind === 'whiteboard' ? (anchor.ty - 2) * TILE : anchor.ty * TILE;
    const w = anchor.tw * TILE, h = kind === 'whiteboard' ? TILE * 2 : Math.max(TILE * 2, (anchor.th - 1) * TILE);
    this.inset = anchor.type === 'surface' && anchor.th > 1 ? 4 : 0;
    this.innerW = w - this.inset * 2 - PAD * 2;
    this.innerH = h - this.inset - PAD;
    this.bg = scene.add.rectangle(w / 2, h / 2 + this.inset, w - this.inset * 2, h - this.inset, 0x0b0d11, 0.94).setStrokeStyle(1, 0x3a4050, 1);
    // Crisp text under camera zoom: rasterise at RES× the size and scale the object down by 1/RES.
    this.head = scene.add.text(this.inset + PAD, this.inset + 4, '', { fontFamily: 'system-ui, sans-serif', fontSize: `${HEAD_PX * RES}px`, fontStyle: 'bold', color: '#f3f5f9' }).setOrigin(0, 0).setScale(1 / RES);
    this.text = scene.add.text(this.inset + PAD, this.inset + 4 + HEAD_H, '', { fontFamily: 'system-ui, sans-serif', fontSize: `${LINE_PX * RES}px`, color: '#b9c2d6', lineSpacing: (LINE_H - LINE_PX - 2) * RES }).setOrigin(0, 0).setScale(1 / RES);
    this.bars = scene.add.graphics();
    this.badge = scene.add.text(w - this.inset - 3, this.inset + 3, '', { fontFamily: 'system-ui, sans-serif', fontSize: `${8 * RES}px`, fontStyle: 'bold', color: '#2a1f08', backgroundColor: '#e6a93c', padding: { x: 3 * RES, y: RES } }).setOrigin(1, 0).setScale(1 / RES).setVisible(false);
    const title = scene.add.text(w / 2, -9, String(anchor.props.label ?? kind).split('—')[0].trim(), { fontFamily: 'system-ui, sans-serif', fontSize: `${8 * RES}px`, color: '#ffe9a8', stroke: '#000', strokeThickness: 2 * RES }).setOrigin(0.5, 1).setScale(1 / RES);
    this.container = scene.add.container(x, y, [this.bg, this.head, this.text, this.bars, this.badge, title]).setDepth(5);
    this.bg.setInteractive({ useHandCursor: true }).on('pointerdown', () => onClick(kind));
  }

  private setImage(dataUrlOrKey: string | null): void {
    if (!dataUrlOrKey) { this.image?.setVisible(false); return; }
    const key = `surface:${this.kind}`;
    const w = this.bg.width - 4, h = this.bg.height - 4;
    const apply = () => {
      if (!this.image) { this.image = this.scene.add.image(this.bg.x, this.bg.y, key).setDepth(6); this.container.addAt(this.image, 1); }
      else this.image.setTexture(key);
      this.image.setDisplaySize(w, h).setVisible(true);
      this.text.setVisible(false);
      this.head.setVisible(false);
    };
    if (dataUrlOrKey === this.lastKey) return;
    this.lastKey = dataUrlOrKey;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.scene.textures.addBase64(key, dataUrlOrKey);
    this.scene.textures.once(`addtexture-${key}`, apply);
  }

  /** Head + lines, limited to what fits: the box height decides how many lines survive, the crop guarantees the rest. */
  private setHeadline(head: string, lines: string[]): void {
    this.image?.setVisible(false);
    const maxLines = Math.max(0, Math.floor((this.innerH - HEAD_H) / LINE_H));
    const headChars = Math.floor(this.innerW / (HEAD_PX * CHAR_W)), lineChars = Math.floor(this.innerW / (LINE_PX * CHAR_W));
    // Crop after every setText: Phaser clamps a crop to the frame that existed when it was set.
    this.head.setVisible(true).setText(cut(head, headChars)).setCrop(0, 0, this.innerW * RES, HEAD_H * RES);
    this.text.setVisible(true).setText(lines.slice(0, maxLines).map((l) => cut(l, lineChars)).join('\n')).setCrop(0, 0, this.innerW * RES, Math.max(0, maxLines * LINE_H + 2) * RES);
  }

  render(s: State, frames: Record<string, string>): void {
    const hl = headlineFor(this.kind, s);
    this.badge.setText(hl.badge ?? '').setVisible(!!hl.badge);
    if (this.kind === 'billboard') {
      const active = Object.values(s.surfaces).filter((x) => x.streamKind === 'browser').sort((a, b) => Number(b.active) - Number(a.active));
      const data = active[0] ? frames[active[0].streamId] : undefined;
      if (data) this.setImage(data); else this.setHeadline(hl.head, hl.lines);
      return;
    }
    if (this.kind === 'bank') {
      this.bars.clear();
      const rows = s.quota.filter((q) => q.limits.rpd > 0).slice(0, Math.max(0, Math.floor((this.innerH - HEAD_H) / LINE_H)));
      if (!rows.length) { this.setHeadline(hl.head, ['Set rpm/rpd in providers.yaml']); return; }
      const labelW = Math.floor(this.innerW * 0.42), x0 = this.inset + PAD + labelW + 4, w = this.innerW - labelW - 4;
      this.setHeadline(hl.head, hl.lines.map((l) => cut(l, Math.floor(labelW / (LINE_PX * CHAR_W)))));
      const y0 = this.inset + 4 + HEAD_H;
      rows.forEach((q, i) => {
        const pct = Math.min(1, q.rpd_used / q.limits.rpd);
        const y = y0 + i * LINE_H + 2;
        this.bars.fillStyle(0x2a2e37, 1).fillRect(x0, y, w, 6);
        this.bars.fillStyle(pct > 0.9 ? 0xd6493a : pct > 0.6 ? 0xe6a93c : 0x4cae5c, 1).fillRect(x0, y, w * (1 - pct), 6);
      });
      return;
    }
    if (this.innerW < NARROW) { this.setHeadline(hl.short ?? hl.head.split(' ')[0], []); return; }
    this.setHeadline(hl.head, hl.lines);
  }
}
