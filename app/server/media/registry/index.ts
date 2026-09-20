// The registry graphics: eight items from the HyperFrames registry, and the adapter each one is used through.
//
// The files in `items/` are exactly what `hyperframes add` wrote (see CREDITS.md and `scripts/vendor-hyperframes.ts`).
// Read as they came, not one of them can go into a film. Five are demonstrations — a whole page at 1920×1080 with a
// sample sentence written into the script, a Google Fonts link and GSAP off a CDN. Two are sub-compositions that
// reach for `#root`, which in a film is the film. And the three transitions move two placeholder boxes of their own:
// a mounted composition cannot touch its host's elements, so none of them can move a scene of ours by being mounted.
//
// So every item has an adapter, and an adapter does one of two honest things:
//
//   - it **runs the item's own code** in the film, after a short list of substitutions — our words for the sample
//     sentence, the caption band's measure for 1920 pixels, the bundled typeface for the linked one. The captions
//     and the count-up work this way: the grouping, the fitting, the easing are all still theirs.
//   - it **reads the item's motion out of its file** — the shader's constants, the tween's numbers, the overlay's
//     CSS — and writes that motion onto our own scene boxes. The transitions and the chart work this way.
//
// Every substitution and every number read is asserted: it must be found exactly as many times as expected or the
// adapter throws, naming the item. `registry.test.ts` builds every piece from the files as vendored, so an item
// reshaped upstream fails there, the day it is re-vendored, and never in a film.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapLine } from '../templates/captions.ts';
import { lightOf } from '../templates/packs.ts';

export const ITEMS = ['caption-pill-karaoke', 'caption-highlight', 'caption-kinetic-slam', 'whip-pan',
  'zoom-through-transition', 'flash-through-white', 'count-up', 'animated-bar-chart'] as const;
export type Item = (typeof ITEMS)[number];

// What an adapter hands the film: rules for the stylesheet, markup for the frame, functions for the page's script
// and moves for the one timeline. `css` and `script` are whole and identical every time the same graphic is asked
// for, so a film that uses a graphic twice can keep one copy of each.
export type Piece = { css: string; html: string; script: string; steps: string[] };

const HOME = import.meta.dirname;
const read = new Map<Item, string>();
export function itemSource(name: Item): string {
  if (!read.has(name)) read.set(name, readFileSync(join(HOME, 'items', `${name}.html`), 'utf8'));
  return read.get(name)!;
}

// --- reading a vendored file ---------------------------------------------------------------------------------------

const shapeError = (name: Item, what: string, wanted: number | string, found: number) => new Error(
  `registry item "${name}" is not the shape its adapter was written for: expected ${wanted} × ${what}, found ${found}. `
  + 'It was probably re-vendored — update server/media/registry/index.ts to match.');

// One file being made ready for a film. Every change says what it is changing and how many times it must be found.
class Surgery {
  text: string;
  private readonly name: Item;
  constructor(name: Item, text: string) { this.name = name; this.text = text; }
  swap(from: string | RegExp, to: string, what: string, times = 1): this {
    const found = typeof from === 'string' ? this.text.split(from).length - 1 : [...this.text.matchAll(new RegExp(from.source, from.flags.includes('g') ? from.flags : `${from.flags}g`))].length;
    if (found !== times) throw shapeError(this.name, what, times, found);
    this.text = typeof from === 'string' ? this.text.split(from).join(to) : this.text.replace(new RegExp(from.source, from.flags.includes('g') ? from.flags : `${from.flags}g`), () => to);
    return this;
  }
}

// A number (or a word) read out of a file, which has to be there.
function pick(name: Item, pattern: RegExp, what: string): string {
  const found = pattern.exec(itemSource(name));
  if (!found) throw shapeError(name, what, 1, 0);
  return found[1];
}
const num = (name: Item, pattern: RegExp, what: string): number => {
  const value = Number(pick(name, pattern, what));
  if (!Number.isFinite(value)) throw shapeError(name, `${what} as a number`, 1, 0);
  return value;
};

const firstStyle = (name: Item, text: string): string => {
  const found = /<style>([\s\S]*?)<\/style>/.exec(text);
  if (!found) throw shapeError(name, 'a <style> block', 1, 0);
  return found[1];
};
// The item's own script: the last one written in the page rather than linked from it.
const ownScript = (name: Item, text: string): string => {
  const found = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1);
  if (!found) throw shapeError(name, 'an inline <script>', 1, 0);
  return found[1];
};
const tidy = (css: string) => css.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
const t = (value: number) => value.toFixed(3);

// --- captions ------------------------------------------------------------------------------------------------------

// Where the film's caption band is, in the frame's own pixels, and the height the studio sets its captions at.
// That height is not the registry's: its captions are drawn for a 1080p desktop demo at about seven per cent of
// the frame, and this studio learnt from real reels that a caption under a tenth of the frame is a subtitle. So
// an item keeps every proportion its designer gave it and is scaled, whole, until its type is our size.
export type Band = { left: number; bottom: number; width: number; size: number };
export type CapTheme = { ink: string; signal: string; ground: string; display: string; body: string };
export type RegistryCaps = 'pill' | 'highlight' | 'slam';

const familyOf = (stack: string) => stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
const spokenJson = (lines: CapLine[]) => JSON.stringify(lines.flatMap((line) => line.words.map((word) => (
  { text: word.word, start: Math.round(word.at * 1000) / 1000, end: Math.round((word.at + word.seconds) * 1000) / 1000 }))));

// The band as a box the item is laid out in at its own design size and then scaled into: `k` is how much bigger our
// type is than the item's, so the box is the band's width over `k` wide and the item never knows it was scaled.
function fitted(band: Band, designType: number, ourType: number, designHeight: number, inner: string): { html: string; wide: number } {
  const k = ourType / designType;
  const wide = Math.floor(band.width / k);
  return {
    wide,
    html: `<div class="regcaps" aria-hidden="true" style="left: ${band.left}px; bottom: ${band.bottom}px; width: ${band.width}px; height: ${Math.ceil(designHeight * k)}px">`
      + `<div class="regcaps__fit" style="width: ${wide}px; height: ${designHeight}px; transform: scale(${k.toFixed(4)})">${inner}</div></div>`,
  };
}
const CAPS_CSS = '.regcaps { position: absolute; z-index: 6; pointer-events: none; }\n'
  + '.regcaps__fit { position: absolute; left: 0; bottom: 0; transform-origin: 0% 100%; }';

// What all three caption items share: a page-sized root with playback attributes on it, rules for `html` and `body`
// that would resize the film, a script that registers a timeline of its own. In a film the root is a plain box in
// the band, the page rules are gone, and the script is a function that hands its timeline to the film's.
function captionParts(name: Item, rootId: string, file: Surgery, wide: number, high: number): { css: string; markup: string; body: string } {
  file.swap(/html,\s*body\s*\{[^}]*\}/, '', 'the html, body rule')
    .swap(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*\}/, '', 'the box-sizing rule')
    .swap('1920px', `${wide}px`, 'a 1920px width on the root')
    .swap('1080px', `${high}px`, 'a 1080px height on the root')
    .swap('overflow: hidden;', 'overflow: visible;', 'overflow: hidden on the root')
    .swap(new RegExp(`<div\\s+id="${rootId}"[^>]*>`), `<div id="${rootId}">`, 'the root element with its playback attributes')
    .swap(`window.__timelines["${name}"] = tl;`, 'return tl;', 'the timeline registration');
  const markup = /<body>([\s\S]*?)<script>/.exec(file.text);
  if (!markup) throw shapeError(name, 'markup between <body> and the script', 1, 0);
  return { css: tidy(firstStyle(name, file.text)), markup: markup[1].trim(), body: ownScript(name, file.text) };
}

export function captionPiece(style: RegistryCaps, lines: CapLine[], total: number, band: Band, theme: CapTheme, mostWords = 3): Piece {
  if (!lines.length) return { css: '', html: '', script: '', steps: [] };
  const words = spokenJson(lines);
  const until = total.toFixed(2);
  let css: string; let html: string; let body: string;
  const steps: string[] = [];

  if (style === 'pill') {
    // A pill of up to two lines, the words in it darkening as they are said. Its type is set a little under the
    // studio's caption size: two lines on a plate are read as a block, and a block at full size covers the picture.
    const name: Item = 'caption-pill-karaoke';
    const high = 220;
    const box = fitted(band, 72, band.size * 0.74, high, '');
    const file = new Surgery(name, itemSource(name))
      .swap(/var TRANSCRIPT = \[[\s\S]*?\n {6}\];/, `var TRANSCRIPT = ${words};`, 'the sample transcript')
      .swap('var DURATION = 8;', `var DURATION = ${until};`, 'the duration')
      .swap('var SAFE_ZONE_WIDTH = 1400;', `var SAFE_ZONE_WIDTH = ${box.wide};`, 'the safe-zone width')
      .swap('var PILL_MAX_WIDTH = 1400;', `var PILL_MAX_WIDTH = ${box.wide};`, 'the pill width')
      // A tall frame is narrow: a long word has to be allowed to shrink further than a desktop demo ever needs.
      .swap('var MIN_FONT_SIZE = 52;', 'var MIN_FONT_SIZE = 30;', 'the smallest type size')
      .swap('var MAX_WORDS_PER_GROUP = 4;', `var MAX_WORDS_PER_GROUP = ${Math.max(1, Math.min(4, mostWords + 1))};`, 'the words in a group')
      .swap('var FONT_FAMILY = "Poppins";', `var FONT_FAMILY = ${JSON.stringify(familyOf(theme.body))};`, 'the measured typeface');
    const parts = captionParts(name, 'pill-karaoke', file, box.wide, high);
    css = new Surgery(name, parts.css)
      .swap('1600px', `${box.wide}px`, 'a 1600px safe-zone measure', 3)
      .swap('bottom: 100px;', 'bottom: 0px;', 'the safe-zone offset')
      .swap('font-family: "Poppins", Arial, sans-serif;', `font-family: ${theme.body};`, 'the Poppins stack').text
      // Ours, over theirs: the item floats its pill in the middle of a safe zone two lines high, which in a film
      // lifts a one-line pill off the line every other caption sits on and into the scene's own type above it.
      + '\n.regcaps .safe-zone, .regcaps .caption-group { align-items: flex-end; }';
    html = fitted(band, 72, band.size * 0.74, high, parts.markup).html;
    body = parts.body;
  } else if (style === 'highlight') {
    // The line in capitals with a block of the accent colour sweeping in behind the word being said.
    const name: Item = 'caption-highlight';
    const high = 210;
    const box = fitted(band, 80, band.size, high, '');
    let at = 0;
    const groups = JSON.stringify(lines.map((line) => { const pair = [at, at + line.words.length - 1]; at += line.words.length; return pair; }));
    const file = new Surgery(name, itemSource(name))
      .swap(/var WORDS = \[[\s\S]*?\n {8}\];/, `var WORDS = ${words};`, 'the sample words')
      .swap(/var RAW_GROUPS = \[[\s\S]*?\n {8}\];/, `var RAW_GROUPS = ${groups};`, 'the sample groups')
      .swap(': 8.0;', `: ${until};`, 'the end of the last group')
      .swap('"800", "Montserrat", 1620)', `"800", ${JSON.stringify(familyOf(theme.display))}, ${box.wide - 28})`, 'the fitting call')
      .swap('(function () {', 'return (function () {', 'the opening of the script');
    const parts = captionParts(name, 'highlight', file, box.wide, high);
    css = new Surgery(name, parts.css)
      .swap('bottom: 140px;', 'bottom: 0px;', 'the group offset')
      .swap('padding: 0 100px;', 'padding: 0 0px;', 'the group padding')
      .swap('font-family: "Montserrat", sans-serif;', `font-family: ${theme.display};`, 'the Montserrat stack')
      .swap('background: linear-gradient(135deg, #ff1745 0%, #df1238 100%);', `background: ${theme.signal};`, 'the red sweep')
      .swap('box-shadow: 0 12px 30px rgba(229, 20, 58, 0.32);', 'box-shadow: none;', 'the red glow').text;
    html = fitted(band, 80, band.size, high, parts.markup).html;
    body = parts.body;
    // The item sets white words on a red block. On an accent as bright as the creator pack's, white on it cannot be
    // read, so the word being said takes the ground colour for as long as the block is behind it.
    if (lightOf(theme.signal) > 0.55) {
      let order = 0;
      for (const line of lines) for (const word of line.words) {
        // It turns as the block crosses it (the item's sweep takes 0.15 s), not before: a dark word waiting for
        // its block on a dark picture is, for three frames, no word at all.
        steps.push(`tl.to("#hl-w-${order} .hl-word-text", { color: "${theme.ground}", textShadow: "none", duration: 0.09, ease: "power1.in" }, ${t(word.at + 0.06)});`);
        steps.push(`tl.to("#hl-w-${order} .hl-word-text", { color: "#ffffff", duration: 0.08, ease: "none" }, ${t(word.at + word.seconds)});`);
        order += 1;
      }
    }
  } else {
    // One word at a time, each arriving from a different side. Drawn in the band, not across the whole frame as the
    // item's demo has it: a film of ours has its own type in the middle of the frame, and two sets of words in one
    // place are read as neither.
    const name: Item = 'caption-kinetic-slam';
    const high = 250;
    const box = fitted(band, 220, band.size * 1.2, high, '');
    // Which words take the accent. A caption line names the one word it turns on — but on a narrow frame a line is
    // one word, every line turns on it, and a film where every word is the keyword has none. So one-word lines are
    // taken three at a time and the longest of the three is the one; a line of several words keeps its own.
    const marked: number[] = [];
    let at = 0;
    let run: { order: number; long: number }[] = [];
    const settle = () => { const best = [...run].sort((a, b) => b.long - a.long)[0]; if (best) marked.push(best.order); run = []; };
    for (const line of lines) {
      if (line.words.length > 1) { settle(); if (line.pop !== undefined) marked.push(at + line.pop); }
      else { if (line.pop !== undefined) run.push({ order: at, long: line.words[0].word.length }); if (run.length === 3) settle(); }
      at += line.words.length;
    }
    settle();
    // The item is drawn in Anton, which has one weight and it is a heavy one. A face with a range is set bold.
    const weight = familyOf(theme.display) === 'Studio Shout' ? '400' : '700';
    const file = new Surgery(name, itemSource(name))
      .swap(/var WORDS = \[[\s\S]*?\n {8}\];/, `var WORDS = ${words};`, 'the sample words')
      .swap(/var KEYWORDS = new Set\(\[[^\]]*\]\);[^\n]*/, `var KEYWORDS = new Set(${JSON.stringify(marked)});`, 'the sample keywords')
      .swap('220, "400", "\'Anton\', sans-serif", 1720)', `220, "${weight}", ${JSON.stringify(theme.display)}, ${box.wide - 16})`, 'the fitting call')
      .swap('el.style.color = "#FFD700";', `el.style.color = "${theme.signal}";`, 'the keyword colour')
      .swap('(function () {', 'return (function () {', 'the opening of the script');
    const parts = captionParts(name, 'kinetic-slam', file, box.wide, high);
    css = `${new Surgery(name, parts.css).swap('font-family: "Anton", sans-serif;', `font-family: ${theme.display};`, 'the Anton stack')
      .swap('font-weight: 400;', `font-weight: ${weight};`, 'the one weight').text}\n`
      // Bare white type over a photograph needs something behind it. The item has nothing; this is ours.
      + '.kt-word { text-shadow: 0 4px 22px rgba(0, 0, 0, 0.6), 0 0 3px rgba(0, 0, 0, 0.7); }';
    html = fitted(band, 220, band.size * 1.2, high, parts.markup).html;
    body = parts.body;
  }

  return {
    css: `${CAPS_CSS}\n${css}`,
    html,
    script: `function registryCaptions() {\n${body}\n}`,
    // A timeline made paused never moves inside another one; handed over unpaused, the film's own clock seeks it.
    steps: ['tl.add(registryCaptions().paused(false), 0);', ...steps],
  };
}

// --- the transitions at act breaks ---------------------------------------------------------------------------------

export type BreakKind = 'whip-pan' | 'zoom-through' | 'flash-white';
// `into` moves the arriving scene, `outOf` the leaving one, and `span` is how long the leaving one has to be kept
// on screen past the cut for its move to be seen. `lead` is how long before the cut the transition starts.
export type BreakMove = { into: string[]; outOf: string[]; span: number; lead: number; html: string; css: string };

// How long each lasts, which is ours and not the registry's. Its demos run two seconds so that the move can be
// studied; the rule for a film is a fifth to a third of a second for a whip and half a second for a dip.
export const BREAK_SECONDS: Record<BreakKind, number> = { 'whip-pan': 0.3, 'zoom-through': 0.5, 'flash-white': 0.5 };

// `from` and `to` are the two scenes' boxes; `at` is the cut; `index` is the arriving scene, which decides which way
// a whip travels; `width` is the frame's.
export function breakMove(kind: BreakKind, from: string, to: string, at: number, index: number, width: number): BreakMove {
  const seconds = BREAK_SECONDS[kind];
  if (kind === 'whip-pan') {
    // The shader slides both scenes sideways under a ten-sample directional blur. It cannot be run on a scene of
    // ours — its capture redraws flat colour and text, never a photograph — but a sideways slide under a blur that
    // is horizontal only is exactly what an SVG filter does to any element, so the same move is made on the boxes.
    const name: Item = 'whip-pan';
    const travel = num(name, /fromOff=u_progress\*([\d.]+);/, 'how far a scene travels');
    const trail = num(name, /u_progress\*(\.\d+)\*f/, 'the length of the blur trail');
    pick(name, /(p < 0\.5 \? 2 \* p \* p)/, 'the quadratic ease');
    // The shader travels one and a half frames and smears the gap with clamped edge pixels. Boxes have no edge
    // pixels to smear, so they travel one frame exactly: a continuous strip, which is what a pan is.
    const far = Math.min(1, travel) * 100;
    const way = index % 2 === 0 ? 1 : -1;
    const blur = Math.round(width * trail * 0.5);
    const filter = (box: string) => [`tl.set("${box}", { filter: "url(#regwhip)" }, ${t(at)});`, `tl.set("${box}", { filter: "none" }, ${t(at + seconds)});`];
    return {
      span: seconds, lead: 0,
      into: [
        ...filter(to),
        `tl.fromTo("${to}", { xPercent: ${far * way} }, { xPercent: 0, duration: ${seconds}, ease: "power1.inOut" }, ${t(at)});`,
        `tl.fromTo("#regwhip feGaussianBlur", { attr: { stdDeviation: "0 0" } }, { attr: { stdDeviation: "${blur} 0" }, duration: ${seconds / 2}, ease: "power1.in" }, ${t(at)});`,
        `tl.to("#regwhip feGaussianBlur", { attr: { stdDeviation: "0 0" }, duration: ${seconds / 2}, ease: "power1.out" }, ${t(at + seconds / 2)});`,
      ],
      outOf: [
        ...filter(from),
        `tl.fromTo("${from}", { xPercent: 0 }, { xPercent: ${-far * way}, duration: ${seconds}, ease: "power1.inOut" }, ${t(at)});`,
        `tl.set("${from}", { opacity: 0 }, ${t(at + seconds)});`,
      ],
      html: '<svg class="reg-defs" width="0" height="0" aria-hidden="true"><filter id="regwhip" x="-30%" y="0%" width="160%" height="100%" color-interpolation-filters="sRGB">'
        + '<feGaussianBlur in="SourceGraphic" stdDeviation="0 0" /></filter></svg>',
      css: '.reg-defs { position: absolute; width: 0; height: 0; }',
    };
  }
  if (kind === 'zoom-through') {
    // The item wipes its incoming box in from the left while the outgoing one drifts back and blurs, with a sweep
    // of light and a four-frame colour strobe over both. The numbers are read from its timeline, the two overlays'
    // rules are lifted from its stylesheet, and the whole move is run at our length rather than its 0.9 seconds.
    const name: Item = 'zoom-through-transition';
    const push = num(name, /var PUSH = ([\d.]+);/, 'the length of the push');
    const toX = num(name, /"--hf-to-x": "(-?[\d.]+)px", "--hf-to-scale"/, 'where the incoming scene starts');
    const toScale = num(name, /"--hf-to-scale": ([\d.]+) \}/, 'the incoming scale');
    // The tween's start values are written on one line and its end values one to a line: the newline is what tells them apart.
    const fromX = num(name, /"--hf-from-x": "(-?[\d.]+)px",\n\s+"--hf-from-scale"/, 'where the outgoing scene goes');
    const fromScale = num(name, /"--hf-from-scale": (0\.\d+),/, 'the outgoing scale');
    const fromBlur = num(name, /"--hf-from-blur": "([\d.]+)px",\s+duration/, 'the outgoing blur');
    const ease = pick(name, /"--hf-from-blur": "[\d.]+px",\s+duration: PUSH,\s+ease: "([^"]+)"/, 'the ease of the push');
    const sweep = num(name, /"--hf-fx-x": "110%", duration: ([\d.]+),/, 'the length of the light sweep');
    const sweepAt = num(name, /START \+ (0\.\d+),\s+\);\s+\/\/ repeat/, 'when the light sweep starts');
    const strobe = num(name, /yoyo: true,\s+duration: ([\d.]+),/, 'the length of one strobe');
    const strobes = num(name, /repeat: (\d+),\s+yoyo: true/, 'how many strobes');
    const strobeAt = num(name, /START \+ (0\.\d+),\s+\);\s+\/\/ HOLD/, 'when the strobe starts');
    const rate = seconds / push;
    const sheet = itemSource(name);
    const rule = (part: string) => {
      const found = new RegExp(`\\.hf-catalog-zoom-through-transition \\.${part} \\{([^}]*)\\}`).exec(sheet);
      if (!found) throw shapeError(name, `the .${part} rule`, 1, 0);
      return `.reg-zt .${part} {${found[1]}}`;
    };
    return {
      span: seconds, lead: 0,
      into: [
        `tl.fromTo("${to}", { clipPath: "inset(0% 100% 0% 0%)", x: ${toX}, scale: ${toScale} }, { clipPath: "inset(0% 0% 0% 0%)", x: 0, scale: 1, duration: ${seconds}, ease: "${ease}" }, ${t(at)});`,
        `tl.fromTo("#regzt", { "--hf-fx-x": "-110%" }, { "--hf-fx-x": "110%", duration: ${t(sweep * rate)}, ease: "power2.inOut" }, ${t(at + sweepAt * rate)});`,
        `tl.fromTo("#regzt", { "--hf-rgb-opacity": 0, "--hf-rgb-x": "-16px" }, { "--hf-rgb-opacity": 1, "--hf-rgb-x": "16px", repeat: ${strobes}, yoyo: true, duration: ${strobe}, ease: "steps(1)" }, ${t(at + strobeAt * rate)});`,
      ],
      outOf: [
        `tl.fromTo("${from}", { x: 0, scale: 1, filter: "blur(0px)" }, { x: ${fromX}, scale: ${fromScale}, filter: "blur(${fromBlur}px)", duration: ${seconds}, ease: "${ease}" }, ${t(at)});`,
        `tl.set("${from}", { opacity: 0 }, ${t(at + seconds)});`,
      ],
      html: '<div class="reg-zt" id="regzt" aria-hidden="true"><div class="fx"></div><div class="rgb"></div></div>',
      css: `.reg-zt { position: absolute; inset: 0; z-index: 5; overflow: hidden; pointer-events: none; }\n${tidy(rule('fx'))}\n${tidy(rule('rgb'))}`,
    };
  }
  // Through white. The shader mixes the leaving scene up to white, the arriving one down from it, and crosses the
  // two in the middle — which is, to the pixel, a sheet of white over the frame whose opacity rises, holds and
  // falls with the cut underneath it. So that is what is drawn, to the shader's own thresholds; and a sheet, unlike
  // the shader, goes over photographs, type and moving pictures alike.
  const name: Item = 'flash-through-white';
  const risen = num(name, /toWhite=smoothstep\(0\.,(\.\d+),u_progress\)/, 'where the rise to white ends');
  const falls = num(name, /fromWhite=1\.-smoothstep\((\.\d+),1\.,u_progress\)/, 'where the fall from white starts');
  const lead = seconds * falls;
  return {
    span: 0.1, lead,
    into: [
      `tl.fromTo("#regflash", { opacity: 0 }, { opacity: 1, duration: ${t(seconds * risen)}, ease: "sine.inOut" }, ${t(Math.max(0, at - lead))});`,
      `tl.to("#regflash", { opacity: 0, duration: ${t(seconds * (1 - falls))}, ease: "sine.inOut" }, ${t(at)});`,
    ],
    outOf: [],
    html: '<div class="reg-flash" id="regflash" aria-hidden="true"></div>',
    css: '.reg-flash { position: absolute; inset: 0; z-index: 5; background: #ffffff; opacity: 0; pointer-events: none; }',
  };
}

// --- the data beat -------------------------------------------------------------------------------------------------

export type DataTheme = { ink: string; quiet: string; signal: string; display: string; body: string; weight: number };

// The figure on a stat scene, run up to itself by the registry's count-up: an eased count written as one fixed
// row a frame, so any frame the renderer lands on shows the same value, and one restrained pulse as it lands. The
// item is a sub-composition that fills whatever box it is given, so it is given the box the figure used to have.
export function countUpPiece(index: number, figure: { prefix: string; end: number; suffix: string }, seconds: number, high: number, at: number, theme: DataTheme): Piece {
  const name: Item = 'count-up';
  const values = { start: 0, end: figure.end, prefix: figure.prefix, suffix: figure.suffix, accent: 'green', glow: false, exit: 'none' };
  const file = new Surgery(name, itemSource(name))
    // In a film `#root` is the film. The item's root becomes a box of its own, and its rules a class, so two
    // figures in one film share one set of rules.
    .swap('document.getElementById("root")', `document.getElementById("regcount${index}")`, 'the lookup of #root')
    .swap('#root {', '.regcount {', 'the #root rule')
    .swap(/var vars =[\s\S]*?: \{\};/, `var vars = ${JSON.stringify(values)};`, 'the reading of the variables')
    .swap('parseFloat(root.dataset.duration || "3")', seconds.toFixed(2), 'the reading of the duration')
    // The item caps its type at a third of its box, which suits a full-frame demo. Here the box is the figure's own.
    .swap('cqw, 34cqh)', 'cqw, 86cqh)', 'the cap on the type size')
    // …and at a fifth of its width, so that the figure on a full-frame demo leaves room round itself. A stat scene
    // is the figure: it is as wide as the item's own per-character measure lets it be.
    .swap('Math.min(20, 150 / characterCount)', 'Math.min(40, 150 / characterCount)', 'the cap on the type width')
    .swap('font-weight: 600;', `font-weight: ${theme.weight};`, 'a weight of 600', 2)
    // A family named in a film and not bundled with it is one the renderer goes looking for. The film hands the
    // item its display face through `--font-display`; the fallback never draws, and must not be asked for.
    .swap('var(--font-display, Inter, system-ui, sans-serif)', 'var(--font-display, sans-serif)', 'the fallback typeface')
    .swap('window.__timelines["count-up"] = tl;', 'return tl;', 'the timeline registration')
    .swap('(function () {', 'return (function () {', 'the opening of the script')
    // A timed clip inside a timed scene is hidden by the renderer on a clock that is not the scene's.
    .swap(/<div\s+id="count-up-clip"[^>]*>/, '<div class="cu-clip">', 'the clip wrapper with its playback attributes');
  const markup = /<\/style>([\s\S]*?)<script src=/.exec(file.text);
  if (!markup) throw shapeError(name, 'markup between the style and the script', 1, 0);
  const css = new Surgery(name, tidy(firstStyle(name, file.text)))
    .swap(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*\}/, '', 'the box-sizing rule').text;
  return {
    // Ours, over theirs: the item centres its figure in a frame of its own, and a scene of ours sets its type from
    // the left margin. The landing pulse grows from the same side, and nothing clips it.
    css: `.regstat { position: relative; width: 100%; flex: none; }\n${css.trim()}\n`
      + '.regstat .cu-clip { place-items: center start; overflow: visible; }\n'
      + '.regstat .cu-stage { width: auto; max-width: 100cqw; justify-content: flex-start; transform-origin: 0% 58%; overflow: visible; }',
    html: `<div class="regstat" style="height: ${Math.round(high)}px"><div class="regcount" id="regcount${index}" style="--fg: ${theme.ink}; --brand: ${theme.signal}; --font-display: ${theme.display.replace(/"/g, "'")}">`
      + `${markup[1].trim()}</div></div>`,
    script: `function registryCount${index}() {\n${ownScript(name, file.text)}\n}`,
    steps: [`tl.add(registryCount${index}().paused(false), ${t(at)});`],
  };
}

// Columns that grow, for a chart whose labels are short enough to sit under a column — years, quarters, plans. The
// item is a card of seven unlabelled sample bars under a title; what a film takes from it is the bars themselves
// (their rules, and the one custom property that grows them) at the length and ease its own integration note
// gives. The card, the title and the sample trend line stay behind: the scene has a heading, and a line drawn
// through made-up points is not data.
export type Bar = { label: string; value: number; unit: string };
// `high` is how tall the tallest column stands, `wide` how much room the row of them has, and `type` the size the
// film sets its supporting copy at — which is what a column's figure and name are, however short the columns.
export function barChartPiece(index: number, bars: Bar[], box: { high: number; wide: number; type: number }, at: number, theme: DataTheme): Piece {
  const { high } = box;
  const name: Item = 'animated-bar-chart';
  const seconds = num(name, /'--hf-grow': 1, '--hf-dash': 0, duration: ([\d.]+),/, 'the length of the growth');
  const ease = pick(name, /'--hf-dash': 0, duration: [\d.]+, ease: '([^']+)'/, 'the ease of the growth');
  const most = Math.max(...bars.map((one) => one.value), 1);
  const best = bars.findIndex((one) => one.value === most);
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const columns = `grid-template-columns: repeat(${bars.length}, 1fr)`;
  const type = Math.round(box.type);
  const gap = Math.round(type * 0.5);
  // A name is as large as its column lets the longest of them be, and never larger than the figures.
  const longest = Math.max(...bars.map((one) => one.label.length), 1);
  const named = Math.round(Math.min(type * 0.85, (box.wide / bars.length - gap) / (longest * 0.62)));
  return {
    css: `${new Surgery(name, tidy(firstStyle(name, itemSource(name)))).swap('font-family: Inter, system-ui, sans-serif;', `font-family: ${theme.body};`, 'the Inter stack').text}\n`
      // Ours, over theirs: the card is taken away so the columns stand on the film's own ground, in its own colours.
      + `.regbars.hf-catalog-animated-bar-chart { width: 100%; min-height: 0; padding: 0; border-radius: 0; background: transparent; box-shadow: none; gap: ${Math.round(type * 0.5)}px; color: ${theme.ink}; font-family: ${theme.body}; }\n`
      + `.regbars .bars { gap: ${gap}px; padding-top: ${Math.round(type * 1.5)}px; box-sizing: content-box; }\n`
      + `.regbars .bar { position: relative; background: color-mix(in srgb, ${theme.ink} 46%, transparent); }\n`
      + `.regbars .bar--most { background: ${theme.signal}; }\n`
      + `.regbars__value { position: absolute; left: -40%; right: -40%; bottom: calc(100% + ${Math.round(type * 0.28)}px); text-align: center; font-size: ${type}px; font-weight: 700; line-height: 1; white-space: nowrap; opacity: 0; font-variant-numeric: tabular-nums; }\n`
      + `.regbars__names { display: grid; text-align: center; font-size: ${named}px; font-weight: 600; color: ${theme.quiet}; white-space: nowrap; }`,
    html: `<div class="hf-catalog-animated-bar-chart regbars" id="regbars${index}" style="--hf-grow: 0">`
      + `<div class="bars" style="height: ${Math.round(high)}px; ${columns}">${bars.map((one, order) => `<span class="bar${order === best ? ' bar--most' : ''}" style="--h: ${Math.max(4, Math.round((one.value / most) * 100))}%">`
        + `<b class="regbars__value">${esc(`${Math.round(one.value)}${one.unit}`)}</b></span>`).join('')}</div>`
      + `<div class="regbars__names" style="${columns}; gap: ${gap}px">${bars.map((one) => `<span>${esc(one.label)}</span>`).join('')}</div></div>`,
    script: '',
    steps: [
      `tl.fromTo("#regbars${index}", { "--hf-grow": 0 }, { "--hf-grow": 1, duration: ${seconds}, ease: "${ease}" }, ${t(at)});`,
      // A figure is read once its column has stopped moving, never while it moves.
      `tl.fromTo("#regbars${index} .regbars__value", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out", stagger: 0.06 }, ${t(at + seconds * 0.8)});`,
    ],
  };
}
