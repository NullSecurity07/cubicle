/**
 * Pixel glyphs on a 12×12 grid, shared by the Phaser emote sheet (the ten emote names) and the HTML layer
 * (`pixelIcon` renders the same runs as inline SVG). No emoji, no icon font, no image assets (program design
 * principles). A run is [x, y, w, h, colour]; UI glyphs use `currentColor` so they follow the text colour.
 */
import type { Emote } from '../state.js';
import { PALETTE } from '../world/palette.js';

export type GlyphName = Emote | 'envelope' | 'doc' | 'chart' | 'chat' | 'close' | 'play' | 'pause' | 'sun' | 'moon' | 'chevron' | 'calendar';
export type Px = [x: number, y: number, w: number, h: number, colour: string];

const C = 'currentColor';
const A = PALETTE.amber, Z = '#9db8ff', B = '#7cc4ff', H = '#f26b6b', Y = '#ffd166', S = '#f1c9a5';
/** A "z" of size s with its top-left at (x, y): top bar, diagonal, bottom bar. */
const zee = (x: number, y: number, s: number): Px[] => [[x, y, s, 1, Z], ...Array.from({ length: s }, (_, i): Px => [x + s - 1 - i, y + 1 + i, 1, 1, Z]), [x, y + s, s, 1, Z]];

export const GLYPHS: Record<GlyphName, Px[]> = {
  '!': [[5, 1, 2, 7, '#d6493a'], [5, 9, 2, 2, '#d6493a']],
  '?': [[3, 1, 5, 1, A], [2, 2, 2, 2, A], [7, 2, 2, 3, A], [5, 5, 3, 1, A], [5, 6, 2, 2, A], [5, 9, 2, 2, A]],
  idea: [[4, 1, 4, 1, '#ffe08a'], [3, 2, 6, 4, '#ffe08a'], [4, 6, 4, 1, '#ffe08a'], [4, 8, 4, 1, '#8d93a5'], [5, 9, 2, 1, '#8d93a5'], [1, 3, 1, 1, '#fff3c4'], [10, 3, 1, 1, '#fff3c4'], [5, 0, 2, 1, '#fff3c4']],
  zzz: [...zee(1, 7, 3), ...zee(5, 4, 3), ...zee(8, 0, 3)],
  sweat: [[5, 2, 1, 2, B], [4, 4, 3, 3, B], [3, 6, 5, 3, B], [4, 9, 3, 1, B], [4, 6, 1, 2, '#d8efff']],
  heart: [[2, 2, 3, 2, H], [7, 2, 3, 2, H], [1, 4, 10, 2, H], [2, 6, 8, 1, H], [3, 7, 6, 1, H], [4, 8, 4, 1, H], [5, 9, 2, 1, H], [3, 3, 1, 1, '#ffb3b3']],
  cheer: [[5, 0, 2, 12, Y], [0, 5, 12, 2, Y], [3, 3, 6, 6, Y], [2, 2, 1, 1, Y], [9, 2, 1, 1, Y], [2, 9, 1, 1, Y], [9, 9, 1, 1, Y], [5, 5, 2, 2, '#fff3c4']],
  clipboard: [[2, 1, 8, 10, '#8a5a2b'], [3, 2, 6, 8, '#f5f5f0'], [4, 0, 4, 2, '#5b6170'], [4, 4, 4, 1, '#d6493a'], [4, 6, 4, 1, '#8d93a5'], [4, 8, 3, 1, '#8d93a5']],
  coffee: [[3, 4, 6, 6, '#f5f5f0'], [9, 5, 2, 3, '#f5f5f0'], [10, 6, 1, 1, '#0e1014'], [4, 5, 4, 1, '#6b4423'], [4, 1, 1, 2, '#cfd6e6'], [6, 0, 1, 3, '#cfd6e6']],
  wave: [[4, 3, 4, 6, S], [3, 1, 1, 3, S], [5, 0, 1, 3, S], [7, 0, 1, 3, S], [9, 2, 1, 3, S], [5, 9, 2, 2, S]],
  envelope: [[1, 2, 10, 1, C], [1, 9, 10, 1, C], [1, 3, 1, 6, C], [10, 3, 1, 6, C], [2, 3, 1, 1, C], [9, 3, 1, 1, C], [3, 4, 1, 1, C], [8, 4, 1, 1, C], [4, 5, 1, 1, C], [7, 5, 1, 1, C], [5, 6, 2, 1, C]],
  doc: [[2, 0, 6, 1, C], [2, 11, 8, 1, C], [2, 1, 1, 10, C], [9, 3, 1, 8, C], [8, 1, 1, 1, C], [9, 2, 1, 1, C], [4, 4, 4, 1, C], [4, 6, 4, 1, C], [4, 8, 3, 1, C]],
  chart: [[1, 7, 2, 4, C], [5, 4, 2, 7, C], [9, 1, 2, 10, C], [0, 11, 12, 1, C]],
  chat: [[2, 1, 8, 1, C], [1, 2, 1, 6, C], [10, 2, 1, 6, C], [2, 8, 8, 1, C], [3, 9, 1, 2, C], [4, 9, 1, 1, C]],
  close: Array.from({ length: 10 }, (_, k): Px[] => [[k + 1, k + 1, 1, 1, C], [10 - k, k + 1, 1, 1, C]]).flat(),
  play: [[3, 0, 1, 12, C], [4, 1, 1, 10, C], [5, 2, 1, 8, C], [6, 3, 1, 6, C], [7, 4, 1, 4, C], [8, 5, 1, 2, C]],
  pause: [[2, 1, 3, 10, C], [7, 1, 3, 10, C]],
  sun: [[4, 4, 4, 4, C], [5, 0, 2, 2, C], [5, 10, 2, 2, C], [0, 5, 2, 2, C], [10, 5, 2, 2, C], [2, 2, 1, 1, C], [9, 2, 1, 1, C], [2, 9, 1, 1, C], [9, 9, 1, 1, C]],
  moon: [[4, 0, 3, 1, C], [3, 1, 2, 1, C], [2, 2, 2, 1, C], [2, 3, 1, 1, C], [1, 4, 2, 4, C], [2, 8, 2, 1, C], [2, 9, 3, 1, C], [3, 10, 4, 1, C], [4, 11, 5, 1, C]],
  /** The replay date's own face. A `doc` stood in for it while there was no calendar, and a page of prose is not a
   *  date: two hanging tabs, a header rule, and three day blocks. */
  calendar: [[3, 0, 1, 2, C], [8, 0, 1, 2, C], [1, 1, 10, 1, C], [1, 11, 10, 1, C], [1, 1, 1, 11, C], [10, 1, 1, 11, C], [1, 3, 10, 1, C], [3, 5, 2, 2, C], [6, 5, 2, 2, C], [3, 8, 2, 2, C]],
  chevron: [[3, 1, 2, 1, C], [4, 2, 2, 1, C], [5, 3, 2, 1, C], [6, 4, 2, 1, C], [7, 5, 2, 2, C], [6, 7, 2, 1, C], [5, 8, 2, 1, C], [4, 9, 2, 1, C], [3, 10, 2, 1, C]],
};

const escAttr = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Inline SVG for a glyph. Crisp at any size because every run is an axis-aligned rect on the 12-unit grid. */
export function pixelIcon(name: GlyphName, opts: { size?: 12 | 16; rotate?: 0 | 90 | 180 | 270; label?: string } = {}): string {
  const runs = GLYPHS[name];
  if (!runs) throw new Error(`unknown glyph: ${String(name)}`);
  const size = opts.size ?? 12;
  const a11y = opts.label ? `role="img" aria-label="${escAttr(opts.label)}"` : 'aria-hidden="true"';
  const style = opts.rotate ? ` style="transform:rotate(${opts.rotate}deg)"` : '';
  const rects = runs.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('');
  return `<svg class="pi" width="${size}" height="${size}" viewBox="0 0 12 12" shape-rendering="crispEdges" ${a11y}${style}>${rects}</svg>`;
}
