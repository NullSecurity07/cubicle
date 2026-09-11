/**
 * In-world text: one rasterisation factor, one font stack, one label style, one visibility rule.
 *
 * Five modules each declared their own `RES = 3` and two of them copy-pasted the name-label style; two different
 * font stacks were in use. Pure — no Phaser, no DOM — so the zoom rule below is a unit test rather than a shot.
 */
import { PALETTE } from './palette.js';

/** Text is rasterised at 3× the size it is drawn at, then scaled back down, so it stays crisp under camera zoom. */
export const RES = 3;
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

/** `chars: null` means no limit — the one sprite the pointer is on, or the one the panel is open for, shows its whole name. */
export interface LabelView { visible: boolean; scale: number; chars: number | null }

/**
 * Ruling F1: a name label is hidden below zoom 2, and drawn screen-space constant at zoom ≥ 2 or whenever the
 * sprite is hovered or selected — pointing at someone is how you ask who they are, at any zoom.
 */
export function nameLabelView(zoom: number, o: { hover?: boolean; selected?: boolean } = {}): LabelView {
  const singled = !!o.hover || !!o.selected;
  return { visible: singled || zoom >= NAME_LABEL_ZOOM, scale: nameLabelScale(zoom), chars: singled ? null : nameLabelChars(zoom) };
}
