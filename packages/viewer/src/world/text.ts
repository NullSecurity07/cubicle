/**
 * In-world text: one rasterisation factor, one font stack, one label style, one visibility rule.
 *
 * Five modules each declared their own `RES = 3` and two of them copy-pasted the name-label style; two different
 * font stacks were in use. Pure — no Phaser, no DOM — so the zoom rule below is a unit test rather than a shot.
 */
import { PALETTE } from './palette.js';
import { cut } from '../ui/headlines.js';

/**
 * In-world text is rasterised once, at the size it occupies in the world, and the camera's integer zoom is what
 * enlarges it — one world pixel becomes a `zoom × zoom` block of screen pixels under Phaser's nearest-neighbour
 * filtering (`pixelArt: true`), so every glyph is uniform pixel blocks at zoom 1, 2, 3 and 4 alike.
 *
 * It used to be 3: a glyph was rasterised at 3× and drawn at 1/3, so the effective raster ratio was `zoom / 3` —
 * 0.33 at zoom 1, 0.67 at zoom 2, 1.33 at zoom 4. Every zoom but 3 resampled the raster and fringed the stems.
 * The rasteriser's own anti-aliasing is then flattened to 1-bit by `snapPixels` (world/text-crisp.ts), which is
 * what turns a system font into a runtime bitmap font — no image assets, no half-pixel blur.
 */
export const RES = 1;
/** The one UI stack, with real fallbacks (headless and minimal systems have neither `system-ui` nor emoji). */
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** The one monospace stack, for tool glyphs and anything that must not reflow between glyphs. */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** A Phaser text style, declared structurally so this module needs no Phaser types. */
export interface TextStyle {
  fontFamily: string; fontSize: string; color: string;
  fontStyle?: string; stroke?: string; strokeThickness?: number;
  backgroundColor?: string; padding?: { x: number; y: number }; lineSpacing?: number;
  wordWrap?: { width: number }; align?: string;
}

/**
 * Below this zoom in-world lettering — room signs, screen headlines, screen captions — is drawn at less than one
 * screen pixel per world pixel, which is a smear whatever the rasteriser does. The tower fit (zoom 0.5) is a shot
 * of a building, not of its paperwork: the lettering is hidden there and every screen still reads as lit glass.
 */
export const WORLD_TEXT_MIN_ZOOM = 1;
export function worldTextVisible(zoom: number): boolean { return zoom >= WORLD_TEXT_MIN_ZOOM - 1e-6; }

/**
 * Flatten a rasterised glyph run to 1-bit: every pixel is either transparent or one of the style's own colours,
 * so a nearest-neighbour upscale by an integer zoom produces uniform blocks instead of grey fringes.
 *
 * `data` is RGBA from a 2D canvas, mutated in place. A pixel below `alphaCut` coverage is dropped; the rest are
 * snapped to the nearest candidate colour (fill, stroke, background), which is what keeps a white-on-black label
 * readable rather than turning its anti-aliased rim into a muddy halo.
 */
export function snapPixels(data: Uint8ClampedArray, palette: readonly (readonly [number, number, number])[], alphaCut = 110): void {
  if (!palette.length) return;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < alphaCut) { data[i + 3] = 0; continue; }
    let best = 0, bestD = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const c = palette[p];
      const d = (data[i] - c[0]) ** 2 + (data[i + 1] - c[1]) ** 2 + (data[i + 2] - c[2]) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    data[i] = palette[best][0]; data[i + 1] = palette[best][1]; data[i + 2] = palette[best][2]; data[i + 3] = 255;
  }
}

/** `#rrggbb` → `[r, g, b]`; anything else (a keyword, an `rgba()`) is not a candidate colour and returns null. */
export function rgbOf(colour: string | undefined): [number, number, number] | null {
  if (!colour || !/^#[0-9a-f]{6}$/i.test(colour)) return null;
  const n = parseInt(colour.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A screen's caption plate lives in the tile row above the screen it names — one row, so every veil edge that has
 * to clear it stays on the tile grid rather than cutting a hard line across the middle of a floor tile.
 *
 * The focus veil needs this: a plate hangs above its screen, which puts it on the slab of the floor above, so a
 * band cut on the floor boundary dimmed every focused floor's own captions and lit the captions of the floor
 * below — a lit label glued to an unlit screen (visual QA R-C1). Both bands move up by a row, so a screen and its
 * plate always share a side. The plate itself (a 7 px face plus a pixel of padding) is shorter than the row, and
 * hangs from its bottom edge so it sits on the bezel.
 */
export const CAPTION_BAND = 16;
/** The plate's own type and padding; `world/surfaces.ts` builds the plate from these. */
export const CAPTION_FONT_PX = 7, CAPTION_PAD_Y = 1;
/** What actually has to fit inside `CAPTION_BAND`: the face, its padding, and the row Phaser's text box adds. */
export const CAPTION_PLATE_H = CAPTION_FONT_PX + CAPTION_PAD_Y * 2 + 2;

/** Below this zoom a name label is a smear across the desks rather than a name, so it is not drawn (ruling F1). */
export const NAME_LABEL_ZOOM = 2;
/** How tall a name reads on screen, in screen pixels, at every zoom it is shown at. */
export const NAME_LABEL_PX = 9;

/** The name under a sprite: white, black-stroked, rasterised at RES. Shared by agents and the owner's avatar. */
export function nameLabelStyle(px = NAME_LABEL_PX): TextStyle {
  return { fontFamily: FONT, fontSize: `${px * RES}px`, color: PALETTE.labelInk, stroke: PALETTE.labelStroke, strokeThickness: 2 * RES };
}

/** A room sign: the floor's skirting colour behind white 7 px text. */
export function signLabelStyle(background: string, px = 7): TextStyle {
  return { fontFamily: FONT, fontSize: `${px * RES}px`, fontStyle: '600', color: PALETTE.labelInk, backgroundColor: background, padding: { x: 2 * RES, y: RES } };
}

/**
 * Screen-space constant: the scale at which `NAME_LABEL_PX * RES` pixels of rasterised glyph land as exactly
 * `NAME_LABEL_PX` pixels on screen, whatever the camera zoom. A label is a child of the sprite container, which
 * the camera zoom scales, so the label has to divide it back out — otherwise it is 36 px tall at zoom 4 and
 * dominates the room.
 */
export function nameLabelScale(zoom: number): number { return 1 / (RES * Math.max(1e-6, zoom)); }

/** Two tiles: the horizontal pitch between neighbouring desks, and so the width one name may claim. */
export const DESK_PITCH_PX = 32;
/** Average glyph advance as a fraction of the font size — generous, so a name never quite reaches its neighbour. */
export const LABEL_CHAR_W = 0.55;

/**
 * How many characters of a name fit between two neighbouring desks at this zoom. The label is screen-space
 * constant while the desks are not, so zooming in genuinely reveals more of the name: 12 characters at
 * zoom 2, 19 at zoom 3, 25 at zoom 4. Without this, a row of "Intelligence Analyst"-length names at zoom 2 runs
 * into its neighbours and the row is no more readable than the smear it replaced.
 */
export function nameLabelChars(zoom: number): number { return Math.max(4, Math.floor((DESK_PITCH_PX * zoom) / (NAME_LABEL_PX * LABEL_CHAR_W))); }

/**
 * What a row of desk labels says at `chars` columns.
 *
 * Sibling roles share a head — the QA room is six names that all begin "QA ", Dev has a Product Manager beside a
 * Product Designer, Research has a Manager, an Analyst and an Engineer that all begin "Research" — and a plain cut
 * turned each of those rooms into a column of the same truncated prefix. The group is what a glance already knows
 * from the room sign above the desks; the word after it is what tells the desks apart.
 *
 * Two passes, in the order the visual QA (I1) asked for:
 *  1. whatever leading words the whole room shares are dropped, once any one name needs a cut — a length rule
 *     (the old `GROUP_TAG_MAX = 3`) rescued "QA " and nothing else, and left "Research" and "Product" behind;
 *  2. names that still collide after the cut drop the words that *those* names share, so "Product Manager" and
 *     "Product Designer" end as "Manager" and "Designer" while the rest of the room keeps its full name.
 * A name that fits, in a room with nothing to disambiguate, is never touched.
 */
const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
/** How many leading whole words every one of `names` shares, never all of the shortest name. */
export function sharedLeadingWords(names: string[]): number {
  if (names.length < 2) return 0;
  const ws = names.map(words);
  const limit = Math.min(...ws.map((w) => w.length)) - 1;   // never strip a name down to nothing
  let k = 0;
  while (k < limit && ws.every((w) => w[k] === ws[0][k])) k++;
  return k;
}
const drop = (name: string, k: number): string => (k > 0 ? words(name).slice(k).join(' ') || name.trim() : name.trim());

export function groupLabels(names: string[], chars: number | null): string[] {
  const full = names.map((n) => n.trim());
  if (chars === null) return full;
  const tight = full.some((n) => n.length > chars);
  const k = tight ? sharedLeadingWords(full) : 0;
  const kept = full.map((n) => drop(n, k));
  const labels = kept.map((n) => cut(n, chars));
  // second pass: only the names that still land on the same label lose the words they share with each other
  const seen = new Map<string, number[]>();
  labels.forEach((l, i) => { const at = seen.get(l); if (at) at.push(i); else seen.set(l, [i]); });
  for (const idx of seen.values()) {
    if (idx.length < 2) continue;
    const k2 = sharedLeadingWords(idx.map((i) => kept[i]));
    if (k2 > 0) for (const i of idx) labels[i] = cut(drop(kept[i], k2), chars);
  }
  return labels;
}

/** One member of the row: `siblings` is every display name at the desks of the same room, this one included. */
export function nameLabelText(display: string, chars: number | null, siblings: readonly string[] = []): string {
  const name = display.trim();
  if (chars === null) return name;
  const group = siblings.length > 1 ? [...siblings] : [name];
  const at = group.indexOf(name);
  if (at < 0) return cut(name, chars);
  return groupLabels(group, chars)[at];
}

/** `chars: null` means no limit — the one sprite the pointer is on, or the one the panel is open for, shows its whole name. */
export interface LabelView { visible: boolean; scale: number; chars: number | null }

/**
 * Ruling F1: a name label is hidden below zoom 2, and drawn screen-space constant at zoom >= 2 or whenever the
 * sprite is hovered or selected — pointing at someone is how you ask who they are, at any zoom.
 */
export function nameLabelView(zoom: number, o: { hover?: boolean; selected?: boolean } = {}): LabelView {
  const singled = !!o.hover || !!o.selected;
  return { visible: singled || zoom >= NAME_LABEL_ZOOM, scale: nameLabelScale(zoom), chars: singled ? null : nameLabelChars(zoom) };
}
