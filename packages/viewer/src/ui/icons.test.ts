import { describe, it, expect } from 'vitest';
import { GLYPHS, pixelIcon, type GlyphName } from './icons.js';
import type { Emote } from '../state.js';

const EMOTES: Emote[] = ['!', '?', 'idea', 'zzz', 'sweat', 'heart', 'cheer', 'clipboard', 'coffee', 'wave'];
const UI: GlyphName[] = ['envelope', 'doc', 'chart', 'chat', 'close', 'play', 'pause', 'sun', 'moon', 'chevron', 'calendar'];

describe('pixel glyphs', () => {
  it('has a glyph for every emote the reducer can raise and every UI icon', () => {
    for (const n of [...EMOTES, ...UI]) expect(GLYPHS[n].length, n).toBeGreaterThan(0);
    expect(Object.keys(GLYPHS).sort()).toEqual([...EMOTES, ...UI].sort());
  });
  it('every run stays inside the 12×12 cell', () => {
    for (const [name, runs] of Object.entries(GLYPHS)) for (const [x, y, w, h] of runs) {
      expect(w, name).toBeGreaterThan(0); expect(h, name).toBeGreaterThan(0);
      expect(x, name).toBeGreaterThanOrEqual(0); expect(y, name).toBeGreaterThanOrEqual(0);
      expect(x + w, name).toBeLessThanOrEqual(12); expect(y + h, name).toBeLessThanOrEqual(12);
    }
  });
  it('emote glyphs carry their own colours; UI glyphs follow the text colour', () => {
    for (const n of EMOTES) for (const run of GLYPHS[n]) expect(run[4]).toMatch(/^#[0-9a-f]{6}$/);
    for (const n of UI) for (const run of GLYPHS[n]) expect(run[4]).toBe('currentColor');
  });
  it('renders one crisp rect per run, sized, rotated and labelled as asked', () => {
    const svg = pixelIcon('close', { label: 'Close <x>' });
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('viewBox="0 0 12 12"');
    expect(svg).toContain('role="img" aria-label="Close &lt;x&gt;"');
    expect((svg.match(/<rect /g) ?? []).length).toBe(GLYPHS.close.length);
    expect(pixelIcon('chevron')).toContain('aria-hidden="true"');
    expect(pixelIcon('chevron', { rotate: 180 })).toContain('rotate(180deg)');
    expect(pixelIcon('doc', { size: 16 })).toContain('width="16" height="16"');
  });
  it('refuses an unknown name instead of drawing nothing', () => { expect(() => pixelIcon('sparkle' as GlyphName)).toThrow(/unknown glyph/); });
});
