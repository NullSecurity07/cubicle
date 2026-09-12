/**
 * In-world text, drawn as pixel type.
 *
 * A Phaser `Text` rasterises through the platform font rasteriser, which anti-aliases: at the sizes this office
 * uses (7–10 px) every stem carries two columns of grey, and the camera's integer zoom then magnifies the grey
 * along with the ink. `addText` creates the object and hooks its `updateText`, so every re-render is followed by
 * `snapPixels` — the glyph run is flattened to the style's own colours and re-uploaded. The result is a bitmap
 * font generated at runtime from the system stack: no image assets, and the checklist's "uniform pixel blocks".
 *
 * The hook is tolerant on purpose: the unit tests stand a recording stub in for the scene (no canvas, no texture),
 * and a stub simply keeps the plain object it always had.
 */
import type Phaser from 'phaser';
import { rgbOf, snapPixels, type TextStyle } from './text.js';

/** A Phaser Text, structurally: enough to flatten its canvas without importing Phaser at runtime. */
interface CrispText {
  canvas?: HTMLCanvasElement;
  context?: CanvasRenderingContext2D;
  texture?: { refresh?: () => unknown };
  updateText?: () => unknown;
}

/** Which colours a style can put on the canvas: what a flattened pixel is allowed to be. */
export function stylePalette(style: TextStyle): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const c of [style.color, style.stroke, style.backgroundColor]) { const rgb = rgbOf(c); if (rgb) out.push(rgb); }
  return out;
}

/** Flatten one already-rendered Text canvas in place and re-upload it. Safe to call on a stub. */
export function flatten(obj: CrispText, palette: readonly (readonly [number, number, number])[]): void {
  const { canvas, context } = obj;
  if (!canvas || !context || !canvas.width || !canvas.height || !palette.length) return;
  const img = context.getImageData(0, 0, canvas.width, canvas.height);
  snapPixels(img.data, palette);
  context.putImageData(img, 0, 0);
  obj.texture?.refresh?.();
}

/**
 * `scene.add.text` with the flattening hook installed. Call it everywhere in-world lettering is created; the HTML
 * overlay is real text in a real layout engine and wants none of this.
 */
export function addText(scene: Phaser.Scene, x: number, y: number, text: string | string[], style: TextStyle): Phaser.GameObjects.Text {
  const t = scene.add.text(x, y, text, style as Phaser.Types.GameObjects.Text.TextStyle);
  const obj = t as unknown as CrispText;
  const palette = stylePalette(style);
  const original = obj.updateText;
  if (typeof original === 'function' && palette.length) {
    obj.updateText = function patched(this: CrispText): unknown {
      const r = original.call(this);
      flatten(this, palette);
      return r;
    };
    obj.updateText!();
  }
  return t;
}
