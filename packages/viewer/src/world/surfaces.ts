import type Phaser from 'phaser';
import type { Anchor } from './map.js';
import { TILE } from './tiles.js';
import type { State } from '../state.js';
import { cut } from '../ui/headlines.js';
import type { SurfaceDef } from '../ui/surfaces.js';
import { chartBars, headlineFor } from '../ui/surfaces.js';
import { DUR, EASE, dur, motionOff } from './motion.js';
import { PALETTE, hexToInt } from './palette.js';
import { RES, FONT } from './text.js';

const PAD = 6;
const HEAD_PX = 10, LINE_PX = 8, LINE_H = 10, HEAD_H = 14;
const CHAR_W = 0.62; // generous glyph width as a fraction of the font size, so a cut line never reaches the box edge
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
  private wipe: Phaser.GameObjects.Rectangle;
  private live: Phaser.GameObjects.Text;
  private caret: Phaser.GameObjects.Rectangle;
  private liveTween: Phaser.Tweens.Tween | null = null;
  private lastSig = '';
  private frameSeq = 0;
  private lastKey = '';
  private readonly innerW: number;
  private readonly innerH: number;
  private readonly inset: number;

  constructor(private scene: Phaser.Scene, public readonly def: SurfaceDef, public readonly anchor: Anchor, onClick: (kind: string) => void) {
    // The anchor is the registry's box for this surface: the map rectangle, or the wall its entry picked out of a room.
    const x = anchor.tx * TILE, y = anchor.ty * TILE;
    const w = anchor.tw * TILE, h = Math.max(TILE * 2, (anchor.th - 1) * TILE);
    this.inset = anchor.type === 'surface' && anchor.th > 1 ? 4 : 0;
    this.innerW = w - this.inset * 2 - PAD * 2;
    this.innerH = h - this.inset - PAD;
    this.bg = scene.add.rectangle(w / 2, h / 2 + this.inset, w - this.inset * 2, h - this.inset, hexToInt(PALETTE.screenBg), 0.98).setStrokeStyle(1, hexToInt(PALETTE.screenFrame), 1);
    // Crisp text under camera zoom: rasterise at RES× the size and scale the object down by 1/RES.
    this.head = scene.add.text(this.inset + PAD, this.inset + 4, '', { fontFamily: FONT, fontSize: `${HEAD_PX * RES}px`, fontStyle: 'bold', color: PALETTE.screenText }).setOrigin(0, 0).setScale(1 / RES);
    this.text = scene.add.text(this.inset + PAD, this.inset + 4 + HEAD_H, '', { fontFamily: FONT, fontSize: `${LINE_PX * RES}px`, color: PALETTE.screenMuted, lineSpacing: (LINE_H - LINE_PX - 2) * RES }).setOrigin(0, 0).setScale(1 / RES);
    this.bars = scene.add.graphics();
    this.badge = scene.add.text(w - this.inset - 3, this.inset + 3, '', { fontFamily: FONT, fontSize: `${8 * RES}px`, fontStyle: 'bold', color: PALETTE.amberInk, backgroundColor: PALETTE.amber, padding: { x: 3 * RES, y: RES } }).setOrigin(1, 0).setScale(1 / RES).setVisible(false);
    this.wipe = scene.add.rectangle(this.inset, this.inset, 3, h - this.inset, hexToInt(PALETTE.wipe), 0.35).setOrigin(0).setVisible(false);
    this.live = scene.add.text(this.inset + 3, this.inset + 3, 'LIVE', { fontFamily: FONT, fontSize: `${7 * RES}px`, fontStyle: 'bold', color: PALETTE.amberInk, backgroundColor: PALETTE.amber, padding: { x: 2 * RES, y: RES } }).setOrigin(0, 0).setScale(1 / RES).setVisible(false);
    this.caret = scene.add.rectangle(0, 0, 4, LINE_PX, hexToInt(PALETTE.amber), 1).setOrigin(0, 0).setVisible(false);
    // The LIVE badge breathes — but an endless yoyo under reduced motion would strobe at frame rate, so there the
    // badge simply sits at full alpha and no tween is created at all (nothing to leak on teardown either).
    if (motionOff()) this.live.setAlpha(1);
    else this.liveTween = scene.tweens.add({ targets: this.live, alpha: 0.6, duration: dur(DUR.livePulse), yoyo: true, repeat: -1, ease: EASE.sine });
    const title = scene.add.text(w / 2, -9, String(anchor.props.label ?? def.kind).split('—')[0].trim(), { fontFamily: FONT, fontSize: `${8 * RES}px`, color: PALETTE.screenText, stroke: PALETTE.screenInk, strokeThickness: 2 * RES }).setOrigin(0.5, 1).setScale(1 / RES);
    this.container = scene.add.container(x, y, [this.bg, this.head, this.text, this.bars, this.badge, this.wipe, this.live, this.caret, title]).setDepth(5);
    this.bg.setInteractive({ useHandCursor: true }).on('pointerdown', () => onClick(def.kind));
  }

  private setImage(dataUrlOrKey: string | null): void {
    if (!dataUrlOrKey) { this.image?.setVisible(false); return; }
    if (dataUrlOrKey === this.lastKey) return;
    this.lastKey = dataUrlOrKey;
    // Alternate texture keys so the old frame keeps its pixels on screen while the new one loads and cross-fades in.
    this.frameSeq = (this.frameSeq + 1) % 2;
    const key = `surface:${this.def.kind}:${this.frameSeq}`;
    const w = this.bg.width - 4, h = this.bg.height - 4;
    const apply = () => {
      const img = this.scene.add.image(this.bg.x, this.bg.y, key).setDisplaySize(w, h).setAlpha(0);
      // Render order in the container is list order (later index = on top). The new frame must sit directly
      // above the old one — never below it — or the still-opaque old frame paints over the fade-in and the
      // swap reads as a hard cut instead of a cross-fade. head/text/bars/badge/wipe/live/caret/title all stay
      // above both images (they're hidden instead, below, when an image is showing).
      const old = this.image;
      const oldIndex = old ? this.container.getIndex(old) : 0;
      this.container.addAt(img, oldIndex + 1);
      this.image = img;
      this.scene.tweens.add({ targets: img, alpha: 1, duration: dur(DUR.crossfade), onComplete: () => { old?.destroy(); } });
      this.text.setVisible(false); this.head.setVisible(false);
      this.wipeOnChange(`i|${key}|${this.lastKey}`);
    };
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.scene.textures.addBase64(key, dataUrlOrKey);
    this.scene.textures.once(`addtexture-${key}`, apply);
  }

  /** 120 ms light bar sweeping left → right: the screen visibly changed. */
  private wipeOnChange(sig: string): void {
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    if (this.scene.game.loop.frame < 30) return;   // no wipes while the office is still loading
    this.wipe.setVisible(true).setX(this.inset).setAlpha(0.35);
    this.scene.tweens.add({ targets: this.wipe, x: this.bg.width - this.inset, alpha: 0, duration: dur(DUR.wipe), ease: EASE.out, onComplete: () => this.wipe.setVisible(false) });
  }

  /** Head + lines, limited to what fits: the box height decides how many lines survive, the crop guarantees the rest. */
  private setHeadline(head: string, lines: string[]): void {
    this.wipeOnChange(`t|${head}|${lines.join('\n')}`);
    this.image?.setVisible(false);
    const maxLines = Math.max(0, Math.floor((this.innerH - HEAD_H) / LINE_H));
    const headChars = Math.floor(this.innerW / (HEAD_PX * CHAR_W)), lineChars = Math.floor(this.innerW / (LINE_PX * CHAR_W));
    // Crop after every setText: Phaser clamps a crop to the frame that existed when it was set.
    this.head.setVisible(true).setText(cut(head, headChars)).setCrop(0, 0, this.innerW * RES, HEAD_H * RES);
    this.text.setVisible(true).setText(lines.slice(0, maxLines).map((l) => cut(l, lineChars)).join('\n')).setCrop(0, 0, this.innerW * RES, Math.max(0, maxLines * LINE_H + 2) * RES);
  }

  render(s: State, frames: Record<string, string>, nowMs: number): void {
    const hl = headlineFor(this.def.kind, s);
    const live = this.def.streamKind === 'browser' && !!s.surfaces[this.def.streamId(s)]?.active;
    this.live.setVisible(live);
    this.badge.setText(hl.badge ?? '').setVisible(!!hl.badge);
    // How a surface draws follows its stream kind, not its name: an image stream shows its latest frame …
    if (this.def.streamKind === 'browser') {
      const data = frames[this.def.streamId(s)];
      if (data) this.setImage(data); else this.setHeadline(hl.head, hl.lines);
      return;
    }
    // … and a chart stream draws a runway bar per row its own entry supplies. Nothing here knows what the rows
    // mean: the labels and the numbers come from `def.bars`, so a second chart surface draws its own data.
    if (this.def.streamKind === 'chart') {
      this.bars.clear();
      const rows = chartBars(this.def, s, Math.floor((this.innerH - HEAD_H) / LINE_H));
      if (!rows.length) { this.setHeadline(hl.head, hl.lines); return; }
      const labelW = Math.floor(this.innerW * 0.42), x0 = this.inset + PAD + labelW + 4, w = this.innerW - labelW - 4;
      this.setHeadline(hl.head, rows.map((b) => cut(b.label, Math.floor(labelW / (LINE_PX * CHAR_W)))));
      const y0 = this.inset + 4 + HEAD_H;
      rows.forEach((b, i) => {
        const pct = Math.min(1, b.used / b.limit);
        const y = y0 + i * LINE_H + 2;
        this.bars.fillStyle(hexToInt(PALETTE.barTrack), 1).fillRect(x0, y, w, 6);
        this.bars.fillStyle(hexToInt(pct > 0.9 ? PALETTE.bad : pct > 0.6 ? PALETTE.amber : PALETTE.good), 1).fillRect(x0, y, w * (1 - pct), 6);
      });
      return;
    }
    if (this.innerW < NARROW) { this.setHeadline(hl.short ?? hl.head.split(' ')[0], []); return; }
    this.setHeadline(hl.head, hl.lines);
    const running = this.def.streamKind === 'terminal' && Object.values(s.agents).some((a) => a.tool === 'terminal');
    this.caret.setVisible(running && Math.floor(nowMs / 530) % 2 === 0);
    if (running) {
      const lines = hl.lines.length;
      this.caret.setPosition(this.inset + PAD + Math.min(this.innerW - 4, this.text.width / RES + 1), this.inset + 4 + HEAD_H + Math.max(0, lines - 1) * LINE_H + 1);
    }
  }

  /**
   * A scene restart must not leave this surface's forever-tween running against a destroyed Text, nor its two
   * base64 frame textures in the global texture manager — they are keyed by kind, so they would be re-added
   * (and accumulate) on every restart.
   */
  destroy(): void {
    this.liveTween?.remove();
    this.liveTween = null;
    this.scene.tweens.killTweensOf([this.live, this.wipe, this.bg]);
    for (const seq of [0, 1]) { const key = `surface:${this.def.kind}:${seq}`; if (this.scene.textures.exists(key)) this.scene.textures.remove(key); }
    this.image?.destroy();
    this.image = null;
    this.container.destroy();
  }
}
