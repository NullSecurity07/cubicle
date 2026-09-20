import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capLines, wordTimes } from '../templates/captions.ts';
import { barChartPiece, BREAK_SECONDS, breakMove, captionPiece, countUpPiece, ITEMS, itemSource, type BreakKind, type RegistryCaps } from './index.ts';

const HOME = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(HOME, 'manifest.json'), 'utf8')) as { licence: string; items: { name: string; file: string; sha256: string }[] };
const words = wordTimes([{ text: 'Every founder ships faster with a studio.', seconds: 2.6 }, { text: 'Professional films, no timeline.', seconds: 2.2 }]);
const lines = capLines(words, 11, 3, ['studio']);
const band = { left: 64, bottom: 420, width: 498, size: 135 };
const theme = { ink: '#FFFFFF', signal: '#D6FF3E', ground: '#0C0D12', display: "'Studio Shout', 'Studio Sans', sans-serif", body: "'Studio Sans', sans-serif" };
const data = { ...theme, quiet: '#AEB3C4', weight: 400 };
const parses = (script: string) => expect(() => new Function(script)).not.toThrow();
// Nothing fetched — and no typeface named that is not bundled with the films, because the renderer resolves any
// family it sees named and not declared, and for one it does not know it goes to the network.
const offline = (text: string) => {
  expect(text).not.toMatch(/https?:\/\/|fonts\.googleapis|jsdelivr/);
  expect(text).not.toMatch(/\b(Inter|Poppins|Montserrat|Anton|Lato|Bebas Neue|Space Mono|JetBrains Mono)\b/);
};

describe('the vendored registry items', () => {
  it('are the set the adapters know, under the licence the credits name', () => {
    expect(manifest.items.map((one) => one.name).sort()).toEqual([...ITEMS].sort());
    expect(manifest.licence).toBe('Apache-2.0');
    expect(readFileSync(join(HOME, 'CREDITS.md'), 'utf8')).toContain('Apache License 2.0');
  });
  it('are byte for byte what the CLI wrote — nobody has edited one by hand', () => {
    for (const one of manifest.items) {
      expect(createHash('sha256').update(readFileSync(join(HOME, 'items', one.file))).digest('hex'), one.name).toBe(one.sha256);
    }
  });
});

describe('registry captions', () => {
  for (const style of ['pill', 'highlight', 'slam'] as RegistryCaps[]) {
    it(`${style}: runs the item's own script on the film's words, in the band, with nothing fetched`, () => {
      const piece = captionPiece(style, lines, 4.8, band, theme, 3);
      parses(piece.script);
      offline(piece.css + piece.html + piece.script);
      expect(piece.script).toContain('"text":"founder"');
      expect(piece.script).not.toContain('HyperFrames');
      expect(piece.script).toContain('return tl;');
      expect(piece.script).not.toContain('window.__timelines[');
      // A composition id or a clip clock on the box would have the renderer treat it as a film of its own.
      expect(piece.html).not.toMatch(/data-composition-id|data-start|data-duration/);
      expect(piece.html).toContain('left: 64px; bottom: 420px; width: 498px');
      // Nothing that would resize or restyle the film around it.
      expect(piece.css).not.toMatch(/html,\s*body|1920px|1080px|Poppins|Montserrat|"Anton"/);
      expect(piece.steps[0]).toBe('tl.add(registryCaptions().paused(false), 0);');
    });
  }
  it('is scaled whole so its type is the studio\'s size, not a desktop demo\'s', () => {
    const scale = (html: string) => Number(/scale\(([\d.]+)\)/.exec(html)![1]);
    expect(scale(captionPiece('highlight', lines, 4.8, band, theme).html)).toBeCloseTo(135 / 80, 3);
    expect(scale(captionPiece('slam', lines, 4.8, band, theme).html)).toBeCloseTo((135 * 1.2) / 220, 3);
  });
  it('highlight: a bright accent turns the word being said dark, a deep one leaves it white', () => {
    expect(captionPiece('highlight', lines, 4.8, band, theme).steps.some((step) => step.includes('color: "#0C0D12"'))).toBe(true);
    expect(captionPiece('highlight', lines, 4.8, band, { ...theme, signal: '#2B54C8' }).steps).toHaveLength(1);
    expect(captionPiece('highlight', lines, 4.8, band, theme).css).toContain('background: #D6FF3E;');
  });
  it('slam: a line of several words keeps the word it turns on; one-word lines share one accent between three', () => {
    const several = capLines(words, 40, 3, ['studio']);
    const marked = several.flatMap((line, at) => (line.pop === undefined ? [] : [several.slice(0, at).reduce((sum, one) => sum + one.words.length, 0) + line.pop]));
    expect(captionPiece('slam', several, 4.8, band, theme).script).toContain(`new Set(${JSON.stringify(marked)})`);
    // A narrow frame: every line is one word, and every one of them would have been the keyword.
    const single = capLines(words, 4, 1);
    expect(single.every((line) => line.words.length === 1)).toBe(true);
    const accents = JSON.parse(/new Set\((\[[^\]]*\])\)/.exec(captionPiece('slam', single, 4.8, band, theme).script)![1]) as number[];
    expect(accents.length).toBeGreaterThan(0);
    expect(accents.length).toBeLessThanOrEqual(Math.ceil(single.length / 3));
  });
  it('slam: Anton keeps its one weight, a face with a range is set bold', () => {
    expect(captionPiece('slam', lines, 4.8, band, theme).css).toContain('font-weight: 400;');
    const tech = captionPiece('slam', lines, 4.8, band, { ...theme, display: "'Studio Tech', 'Studio Sans', sans-serif" });
    expect(tech.css).toContain('font-weight: 700;');
    expect(tech.script).toContain('220, "700",');
  });
  it('no words, no captions', () => {
    expect(captionPiece('pill', [], 4.8, band, theme)).toEqual({ css: '', html: '', script: '', steps: [] });
  });
});

describe('registry transitions', () => {
  for (const kind of Object.keys(BREAK_SECONDS) as BreakKind[]) {
    it(`${kind}: reads its motion from the vendored file and moves the two scenes`, () => {
      const move = breakMove(kind, '#g2', '#g3', 7.5, 3, 1280);
      offline(move.css + move.html);
      for (const step of [...move.into, ...move.outOf]) parses(`const tl = null; (() => { ${step} });`);
      expect(move.into.length).toBeGreaterThan(0);
      expect(move.span).toBeLessThanOrEqual(0.5);
    });
  }
  it('whip-pan: one frame of travel, sideways blur only, alternating direction', () => {
    const odd = breakMove('whip-pan', '#g2', '#g3', 7.5, 3, 1280);
    const even = breakMove('whip-pan', '#g3', '#g4', 9, 4, 1280);
    expect(odd.into.join('\n')).toContain('xPercent: -100');
    expect(even.into.join('\n')).toContain('xPercent: 100');
    expect(odd.into.join('\n')).toContain('stdDeviation: "51 0"');
    expect(odd.outOf.at(-1)).toContain('opacity: 0');
  });
  it('zoom-through: the item\'s own numbers at our length, and its two overlays', () => {
    const move = breakMove('zoom-through', '#g2', '#g3', 7.5, 3, 1280);
    expect(move.into[0]).toContain('x: 60, scale: 1.04');
    expect(move.into[0]).toContain('ease: "power3.inOut"');
    expect(move.outOf[0]).toContain('x: -70, scale: 0.96, filter: "blur(5px)"');
    expect(move.css).toContain('mix-blend-mode: screen');
    expect(move.css).toContain('.reg-zt .rgb');
    expect(move.into[2]).toContain('repeat: 3');
  });
  it('flash-white: white is full on the cut itself, to the shader\'s thresholds', () => {
    const move = breakMove('flash-white', '#g2', '#g3', 7.5, 3, 1280);
    expect(move.lead).toBeCloseTo(0.25, 5);
    expect(move.into[0]).toContain('duration: 0.225');
    expect(move.into[0]).toMatch(/, 7\.250\);$/);
    expect(move.into[1]).toMatch(/opacity: 0, duration: 0\.250.*, 7\.500\);$/);
  });
});

describe('registry data graphics', () => {
  it('count-up: the item\'s script, on a box of its own, counting to the figure', () => {
    const piece = countUpPiece(4, { prefix: '', end: 87, suffix: '%' }, 3.4, 240, 9.2, data);
    parses(piece.script);
    offline(piece.css + piece.html + piece.script);
    expect(piece.script).toContain('"end":87');
    expect(piece.script).toContain('getElementById("regcount4")');
    expect(piece.script).not.toContain('getElementById("root")');
    expect(piece.css).not.toContain('#root');
    expect(piece.html).not.toMatch(/data-start|data-duration|class="(?:[^"]* )?clip[ "]/);
    expect(piece.steps).toEqual(['tl.add(registryCount4().paused(false), 9.200);']);
  });
  it('bar chart: the item\'s bars and growth, the tallest in the accent, every column named and valued', () => {
    const piece = barChartPiece(2, [{ label: '2023', value: 12, unit: 'k' }, { label: '2024', value: 30, unit: 'k' }, { label: '2025', value: 48, unit: 'k' }], { high: 300, wide: 1088, type: 34 }, 5, data);
    offline(piece.css + piece.html);
    expect(piece.html.match(/class="bar[ "]/g)).toHaveLength(3);
    expect(piece.html).toContain('class="bar bar--most" style="--h: 100%"');
    expect(piece.html).toContain('>48k<');
    expect(piece.html).toContain('<span>2024</span>');
    // Figures at the size the film sets its supporting copy, however short the columns; names no larger.
    expect(piece.css).toContain('font-size: 34px; font-weight: 700;');
    expect(piece.css).toContain('font-size: 29px; font-weight: 600;');
    // Seven long names in a narrow row are set as small as their columns need, not run into each other.
    const tight = barChartPiece(2, 'abcdefg'.split('').map((one, at) => ({ label: `Plan ${one}`, value: at + 1, unit: '' })), { high: 200, wide: 498, type: 46 }, 5, data);
    expect(Number(/font-size: (\d+)px; font-weight: 600;/.exec(tight.css)![1])).toBeLessThanOrEqual(15);
    expect(piece.css).toContain('height: calc(var(--h) * var(--hf-grow, 1));');
    expect(piece.steps[0]).toBe('tl.fromTo("#regbars2", { "--hf-grow": 0 }, { "--hf-grow": 1, duration: 1.2, ease: "power3.out" }, 5.000);');
  });
  it('every item has been read by something', () => {
    for (const name of ITEMS) expect(itemSource(name).length).toBeGreaterThan(1000);
  });
});
