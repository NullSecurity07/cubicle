import type Phaser from 'phaser';
import type { Anchor } from './map.js';
import { TILE } from './tiles.js';
import type { State } from '../state.js';
import { cut } from '../ui/headlines.js';
import type { SurfaceDef } from '../ui/surfaces.js';
import { chartBars, headlineFor } from '../ui/surfaces.js';
import { DUR, EASE, dur, motionOff } from './motion.js';
import { PALETTE, hexToInt } from './palette.js';
import { RES, FONT, CAPTION_FONT_PX, CAPTION_PAD_Y } from './text.js';
import { addText } from './text-crisp.js';

/** Text margin inside the glass: wider at the sides, where there is room, than top and bottom, where there is not. */
const PAD_X = 5, PAD_Y = 2;
/** How far the bezel stands proud of the glass on every side, and how far the wall shadow falls below it. */
const BEZEL = 2, SEAT = 2;
const HEAD_PX = 10, LINE_PX = 8, LINE_H = 9, HEAD_H = 12;
/**
 * The platform rasteriser's natural line box for an 8 px face is about 11 px, which is two more than the 9 px the
 * layout above budgets: three lines then ran past the glass and the third was sliced in half. `lineSpacing` is
 * added to the line box, so a negative value is what pulls the pitch back onto the grid.
 */
const LINE_SPACING = -3;
const CHAR_W = 0.56; // generous glyph width as a fraction of the font size, so a cut line never reaches the box edge
const NARROW = 40; // inner width below which a screen shows only its short form (a count or a word)
/** How far the glass is set in from the anchor's top and sides, so the bezel lands on the map's bezel tiles. */
const INSET = 4;
/**
 * What a screen shows when its own type is too small to read (the tower elevation, `worldTextVisible`).
 *
 * The glass is near-black, so turning the lettering off left the whole-building view dotted with ten featureless
 * slabs — the highest-contrast objects in a pastel building, and the eye goes to them first and finds nothing
 * (visual QA R2-I2). Only the Bank read, because its content is drawn bars rather than type. So every screen
 * draws what the Bank draws: a lit title bar for the head, and a row per line it is carrying, ragged like text.
 * A screen with nothing to say is a title bar alone, which is what "recedes" means here.
 */
export const MARK_BAR_H = 3;
export const MARK_ROW_W = [0.78, 0.6, 0.44] as const;
export function markRows(lines: number): readonly number[] { return MARK_ROW_W.slice(0, Math.max(0, Math.min(MARK_ROW_W.length, lines))); }

/**
 * The geometry of one screen, from its map anchor alone — pure, so the line budget is a unit test rather than a
 * screenshot. The anchor is three tiles tall (the wall row and the two room rows under it, `paintSurface` in
 * scripts/world/tower.ts) and the glass used to claim only `(th - 1)` of them: 32 px, of which 22 were usable,
 * of which the head ate 14 — so `maxLines` came out 0 and every sub-line the registry wrote was discarded before
 * it reached the wall. At the anchor's full height a three-tile screen carries a head and three lines.
 */
export function screenBox(anchor: { tw: number; th: number; type?: string }): {
  w: number; h: number; inset: number; innerW: number; innerH: number; maxLines: number; headChars: number; lineChars: number;
} {
  const w = anchor.tw * TILE, h = Math.max(TILE * 2, anchor.th * TILE);
  const inset = anchor.type === 'surface' && anchor.th > 1 ? INSET : 0;
  const innerW = w - inset * 2 - PAD_X * 2;
  const innerH = h - inset - PAD_Y * 2;
  return {
    w, h, inset, innerW, innerH,
    maxLines: Math.max(0, Math.floor((innerH - HEAD_H) / LINE_H)),
    headChars: Math.max(1, Math.floor(innerW / (HEAD_PX * CHAR_W))),
    lineChars: Math.max(1, Math.floor(innerW / (LINE_PX * CHAR_W))),
  };
}

/**
 * A place on the map that shows a glanceable preview of one stream (spec §10 "Surface") and opens the HTML
 * layer on click. Text is a head line plus a few short lines, wrapped to the box and cropped to it, so a long
 * plan or brief can never spill over the walls: the full content lives in the drawer / document modal.
 */
export class Surface {
  readonly container: Phaser.GameObjects.Container;
  private bg: Phaser.GameObjects.Rectangle;
  private bezel: Phaser.GameObjects.Rectangle;
  private seat: Phaser.GameObjects.Rectangle;
  private lit: Phaser.GameObjects.Rectangle;
  private head: Phaser.GameObjects.Text;
  private text: Phaser.GameObjects.Text;
  private image: Phaser.GameObjects.Image | null = null;
  private bars: Phaser.GameObjects.Graphics;
  /** The tower-elevation stand-in for the head and the lines: `markRows`. */
  private mark: Phaser.GameObjects.Graphics;
  private markLines = 0;
  /** False while the screen is showing a chart or a browser frame, which read at any size on their own. */
  private marksApply = true;
  private markSig = '';
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
  private readonly maxLines: number;
  private readonly headChars: number;
  private readonly lineChars: number;
  /** The caption plate; hidden with the head and the lines at the tower elevation. */
  private plate!: Phaser.GameObjects.Text;
  private letteringOn = true;
  private wantHead = false;
  private wantText = false;

  constructor(private scene: Phaser.Scene, public readonly def: SurfaceDef, public readonly anchor: Anchor, onClick: (kind: string) => void) {
    // The anchor is the registry's box for this surface: the map rectangle, or the wall its entry picked out of a room.
    const x = anchor.tx * TILE, y = anchor.ty * TILE;
    const box = screenBox(anchor);
    const { w, h } = box;
    this.inset = box.inset; this.innerW = box.innerW; this.innerH = box.innerH;
    this.maxLines = box.maxLines; this.headChars = box.headChars; this.lineChars = box.lineChars;
    // A screen is a mounted object. The glass sits inside a bezel, a lit line runs along the bezel's top edge, and a
    // shadow falls below it onto the wall — without them a wall screen is a pure-black slab floating free of the room
    // (harshest in the light theme, where the wall behind it is pale).
    const gw = w - this.inset * 2, gh = h - this.inset, gx = w / 2, gy = this.inset + gh / 2;
    this.seat = scene.add.rectangle(gx, gy + BEZEL + SEAT / 2, gw + BEZEL * 2, gh + BEZEL * 2, hexToInt(PALETTE.screenBezelEdge), 0.45);
    this.bezel = scene.add.rectangle(gx, gy, gw + BEZEL * 2, gh + BEZEL * 2, hexToInt(PALETTE.screenBezel), 1).setStrokeStyle(1, hexToInt(PALETTE.screenBezelEdge), 1);
    this.lit = scene.add.rectangle(gx, gy - gh / 2 - BEZEL + 0.5, gw + BEZEL * 2 - 2, 1, hexToInt(PALETTE.screenBezelLit), 0.9);
    this.bg = scene.add.rectangle(gx, gy, gw, gh, hexToInt(PALETTE.screenBg), 0.98).setStrokeStyle(1, hexToInt(PALETTE.screenFrame), 1);
    // One rasterisation per world pixel, flattened to 1-bit: the camera's integer zoom is what enlarges the glyphs.
    this.head = addText(scene, this.inset + PAD_X, this.inset + PAD_Y, '', { fontFamily: FONT, fontSize: `${HEAD_PX * RES}px`, fontStyle: 'bold', color: PALETTE.screenText }).setOrigin(0, 0).setScale(1 / RES);
    this.text = addText(scene, this.inset + PAD_X, this.inset + PAD_Y + HEAD_H, '', { fontFamily: FONT, fontSize: `${LINE_PX * RES}px`, color: PALETTE.screenMuted, lineSpacing: LINE_SPACING * RES }).setOrigin(0, 0).setScale(1 / RES);
    this.bars = scene.add.graphics();
    this.mark = scene.add.graphics().setVisible(false);
    this.badge = addText(scene, w - this.inset - 3, this.inset + 2, '', { fontFamily: FONT, fontSize: `${8 * RES}px`, fontStyle: 'bold', color: PALETTE.amberInk, backgroundColor: PALETTE.amber, padding: { x: 3 * RES, y: RES } }).setOrigin(1, 0).setScale(1 / RES).setVisible(false);
    this.wipe = scene.add.rectangle(this.inset, this.inset, 3, h - this.inset, hexToInt(PALETTE.wipe), 0.35).setOrigin(0).setVisible(false);
    this.live = addText(scene, this.inset + 3, this.inset + 2, 'LIVE', { fontFamily: FONT, fontSize: `${7 * RES}px`, fontStyle: 'bold', color: PALETTE.amberInk, backgroundColor: PALETTE.amber, padding: { x: 2 * RES, y: RES } }).setOrigin(0, 0).setScale(1 / RES).setVisible(false);
    this.caret = scene.add.rectangle(0, 0, 4, LINE_PX - 1, hexToInt(PALETTE.amber), 1).setOrigin(0, 0).setVisible(false);
    // The LIVE badge breathes — but an endless yoyo under reduced motion would strobe at frame rate, so there the
    // badge simply sits at full alpha and no tween is created at all (nothing to leak on teardown either).
    if (motionOff()) this.live.setAlpha(1);
    else this.liveTween = scene.tweens.add({ targets: this.live, alpha: 0.6, duration: dur(DUR.livePulse), yoyo: true, repeat: -1, ease: EASE.sine });
    // The caption names the object. It used to be stroked text floating on the wall — and, for the notice board,
    // on the lobby carpet 40 px from the screen it names. On its own plate it is a mounted label: the checklist's
    // "no text is drawn outside a bezel" holds for captions too.
    const caption = String(anchor.props.label ?? def.kind).split('—')[0].trim();
    this.plate = addText(scene, w / 2, -1, caption, { fontFamily: FONT, fontSize: `${CAPTION_FONT_PX * RES}px`, fontStyle: 'bold', color: PALETTE.screenText, backgroundColor: PALETTE.screenBezel, padding: { x: 3 * RES, y: CAPTION_PAD_Y * RES } }).setOrigin(0.5, 1).setScale(1 / RES);
    this.container = scene.add.container(x, y, [this.seat, this.bezel, this.lit, this.bg, this.head, this.text, this.bars, this.mark, this.badge, this.wipe, this.live, this.caret, this.plate]).setDepth(5);
    this.bg.setInteractive({ useHandCursor: true }).on('pointerdown', () => onClick(def.kind));
  }

  /** Lettering off at the tower elevation (world/text.ts `worldTextVisible`): glass, bezel and badge stay. */
  setLettering(on: boolean): void {
    if (on === this.letteringOn) return;
    this.letteringOn = on;
    this.applyLettering();
  }
  private applyLettering(): void {
    this.head.setVisible(this.letteringOn && this.wantHead);
    this.text.setVisible(this.letteringOn && this.wantText);
    this.plate.setVisible(this.letteringOn);
    this.drawMark();
  }

  /**
   * The screen's state as marks rather than as type, for the elevation where type is a smear (R2-I2). A lit title
   * bar in the kind's own colour, then a ragged row per line the screen is carrying — the shape of a headline,
   * not a picture of one.
   */
  private drawMark(): void {
    // `applyLettering` runs on every content write, which is every frame; a Graphics rebuild per screen per frame
    // is work for nothing while nothing has changed.
    const sig = `${this.letteringOn}|${this.marksApply}|${this.markLines}`;
    if (sig === this.markSig) return;
    this.markSig = sig;
    this.mark.clear();
    // A chart already draws its content as marks — the Bank is the one screen that read at this elevation before
    // any of this — and a browser frame is a picture, which reads at any size. Neither needs a stand-in.
    const apply = !this.letteringOn && this.marksApply;
    this.mark.setVisible(apply);
    if (!apply) return;
    const colour = hexToInt(PALETTE.surfaceMark[this.def.kind] ?? PALETTE.screenMuted);
    const x = this.inset + PAD_X, y = this.inset + PAD_Y, w = this.innerW;
    this.mark.fillStyle(colour, 1).fillRect(x, y + 2, w, MARK_BAR_H);
    markRows(this.markLines).forEach((frac, i) => {
      this.mark.fillStyle(colour, 0.45).fillRect(x, y + HEAD_H + i * LINE_H, Math.max(4, Math.round(w * frac)), 2);
    });
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
      // Above the glass, never above index 0 — the bezel and its shadow are below the glass, and an image dropped
      // there would be painted over by the still-opaque glass rectangle.
      const oldIndex = this.container.getIndex(old ?? this.bg);
      this.container.addAt(img, oldIndex + 1);
      this.image = img;
      this.scene.tweens.add({ targets: img, alpha: 1, duration: dur(DUR.crossfade), onComplete: () => { old?.destroy(); } });
      this.wantHead = false; this.wantText = false;
      this.marksApply = false;
      this.applyLettering();
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
    const kept = lines.slice(0, this.maxLines).map((l) => cut(l, this.lineChars));
    this.wantHead = true; this.wantText = kept.length > 0;
    this.markLines = kept.length;
    this.marksApply = true;
    // Crop after every setText: Phaser clamps a crop to the frame that existed when it was set.
    this.head.setText(cut(head, this.headChars)).setCrop(0, 0, this.innerW * RES, HEAD_H * RES);
    this.text.setText(kept.join('\n')).setCrop(0, 0, this.innerW * RES, Math.max(0, this.innerH - HEAD_H) * RES);
    this.applyLettering();
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
      const rows = chartBars(this.def, s, this.maxLines);
      if (!rows.length) { this.setHeadline(hl.head, hl.lines); return; }
      const labelW = Math.floor(this.innerW * 0.42), x0 = this.inset + PAD_X + labelW + 4, w = this.innerW - labelW - 4;
      this.setHeadline(hl.head, rows.map((b) => cut(b.label, Math.floor(labelW / (LINE_PX * CHAR_W)))));
      this.marksApply = false;   // the bars are the marks
      this.drawMark();
      const y0 = this.inset + PAD_Y + HEAD_H;
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
    // The caret blinks — unless reduced motion is on, where a 530 ms strobe is exactly what the preference asks
    // us not to draw. It then simply stays lit, which is what `app.css` already does for the HTML terminal.
    this.caret.setVisible(running && (motionOff() || Math.floor(nowMs / 530) % 2 === 0));
    if (running) {
      const lines = hl.lines.length;
      this.caret.setPosition(this.inset + PAD_X + Math.min(this.innerW - 4, this.text.width / RES + 1), this.inset + PAD_Y + HEAD_H + Math.max(0, lines - 1) * LINE_H + 1);
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
