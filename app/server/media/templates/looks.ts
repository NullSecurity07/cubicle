import type { Shape } from '../../../shared/model.ts';

// The three shapes a video can be, and how big everything in it is drawn. `scale` multiplies the whole type scale so a
// tall phone video is not the wide one with the words falling off the sides — a phone is read at arm's length, so its
// words are larger against their frame, not smaller. `lift` is how much air is left under a block: type centred on the
// middle of the frame looks low, so every block sits a little above it. `caps` is how far the captions sit off the
// bottom edge: on a phone the last fifth of the frame is under the player's own controls and the poster's thumb.
// `text` is the second scale, and it is the one that makes a phone film a phone film: the big type barely changes
// between shapes, but a line of body copy set for a screen watched across a room is unreadable held in one hand, so
// everything small grows by a third on a tall frame. `capChars` is how wide a caption line may run before it breaks —
// measured in characters, because a caption that wraps by itself leaves one word stranded on a line of its own.
export const FORMATS: Record<Shape, { width: number; height: number; scale: number; text: number; margin: number; lift: number; caps: number; capChars: number }> = {
  wide: { width: 1280, height: 720, scale: 1, text: 1, margin: 96, lift: 56, caps: 74, capChars: 34 },
  tall: { width: 720, height: 1280, scale: 0.98, text: 1.34, margin: 64, lift: 96, caps: 196, capChars: 20 },
  square: { width: 1080, height: 1080, scale: 0.94, text: 1.12, margin: 92, lift: 58, caps: 110, capChars: 26 },
};

export const LOOKS = ['clean', 'sketch', 'brand'] as const;
export type Look = (typeof LOOKS)[number];

// How fast the film moves. `calm` is the explainer: one long ease, a scene held as long as it takes to read. `punchy`
// is the reel: half the entrance, a third of the hold, a cut you feel. Nothing else about the film changes.
export const PACES = ['calm', 'punchy'] as const;
export type Pace = (typeof PACES)[number];
export const PACE: Record<Pace, { rise: number; ease: string; stagger: number; out: number; travel: number; read: number; floor: number; ceiling: number; lead: number; tail: number }> = {
  calm: { rise: 0.92, ease: 'expo.out', stagger: 0.10, out: 0.42, travel: 46, read: 2.9, floor: 2.8, ceiling: 11, lead: 0.35, tail: 0.65 },
  punchy: { rise: 0.52, ease: 'power3.out', stagger: 0.05, out: 0.22, travel: 30, read: 4.3, floor: 1.7, ceiling: 7.5, lead: 0.18, tail: 0.30 },
};

// The palette of a film. `clean` is the instrument panel: cold slate, brass, air, the type doing all the work.
// `sketch` is the notebook: paper, a blue pen, a yellow highlighter, every line drawn by hand. `brand` is neither —
// it is the product's own colours and typeface, read out of the product's code, so the film looks like the thing it
// is about. A brand with nothing readable in it falls back to `clean`.
export type Paint = { ground: string; ink: string; quiet: string; signal: string; mark: string; scrim: string; font?: string };
export const PAINT: Record<'clean' | 'sketch', Paint> = {
  clean: { ground: '#1C2530', ink: '#F2F5F8', quiet: '#93A3B4', signal: '#E8B04B', mark: '#E8B04B', scrim: '28, 37, 48' },
  sketch: { ground: '#F4F0E6', ink: '#1F1D1A', quiet: '#6B6660', signal: '#2B54C8', mark: '#FFD24A', scrim: '244, 240, 230' },
};

// A hex colour as the three numbers a scrim is written with, and how bright it is: a palette read off a product does
// not say which of its colours is the page and which is the ink, so the film works that out from the colours alone.
export function rgbOf(hex: string): [number, number, number] | null {
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex.trim());
  const full = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  if (full) return [parseInt(full[1], 16), parseInt(full[2], 16), parseInt(full[3], 16)];
  return null;
}
export const lightOf = (hex: string): number => { const rgb = rgbOf(hex); return rgb ? (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255 : 0.5; };
const mix = (hex: string, towards: [number, number, number], amount: number): string => {
  const rgb = rgbOf(hex) ?? [128, 128, 128];
  return `#${rgb.map((one, at) => Math.round(one + (towards[at] - one) * amount).toString(16).padStart(2, '0')).join('')}`;
};

// What was found in the product's own code: the colours it paints itself with and the typeface it sets itself in.
export type Brand = { colours: string[]; font?: string; fontFile?: string; name?: string };

// The product's palette made into a film's palette. The darkest colour that is dark enough becomes the ground (a film
// is watched, not read, and a bright ground on a screen is a lamp); the brightest saturated one becomes the signal.
export function paintOf(look: Look, brand?: Brand): Paint {
  if (look !== 'brand') return PAINT[look];
  const colours = (brand?.colours ?? []).map((one) => one.trim()).filter((one) => rgbOf(one));
  if (!colours.length) return PAINT.clean;
  const sorted = [...colours].sort((a, b) => lightOf(a) - lightOf(b));
  const dark = sorted.find((one) => lightOf(one) < 0.34);
  const ground = dark ?? mix(sorted[0], [16, 20, 26], 0.72);
  const bright = [...sorted].reverse().find((one) => lightOf(one) > 0.42 && one !== ground);
  const signal = bright ?? sorted.at(-1)!;
  const ink = lightOf(ground) < 0.5 ? '#F6F8FA' : '#15181C';
  const rgb = rgbOf(ground)!;
  return {
    ground, ink, signal, mark: signal,
    quiet: mix(ink, rgb, 0.42),
    scrim: rgb.join(', '),
    font: brand?.font,
  };
}

// One type scale, set once, used everywhere: display, heading, lead, body, label, and the one big number. The sizes
// are written for something watched from across a room, not read on a page: on a wide frame a heading is a fifteenth
// of the height, a title a seventh, and the one number on a stat scene is over a third of it.
export function styleSheet(shape: Shape, look: Look, brand?: Brand): string {
  const { scale, text, margin, lift, caps } = FORMATS[shape];
  const paint = paintOf(look, brand);
  const sketch = look === 'sketch';
  // A product's own typeface is used when its file could be copied out of the product; otherwise its name is asked for
  // first and the film's own face stands behind it, so a missing font is a different face, never a fallback serif.
  const family = paint.font ? `${JSON.stringify(paint.font)}, 'Studio Sans', sans-serif` : "'Studio Sans', sans-serif";
  return `
@font-face { font-family: 'Studio Sans'; src: url('vendor/inter.woff2') format('woff2-variations'); font-weight: 100 900; font-style: normal; font-display: block; }
${brand?.fontFile ? `@font-face { font-family: ${JSON.stringify(paint.font ?? 'Brand')}; src: url('vendor/${brand.fontFile}'); font-weight: 100 900; font-style: normal; font-display: block; }\n` : ''}* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; }
:root { --s: ${scale}; --t: ${(scale * text).toFixed(3)}; --margin: ${margin}px; --lift: ${lift}px; --caps: ${caps}px; --ground: ${paint.ground}; --ink: ${paint.ink}; --quiet: ${paint.quiet}; --signal: ${paint.signal}; --mark: ${paint.mark}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; color: ${paint.ink};
  font-family: ${family}; font-synthesis: none; -webkit-font-smoothing: antialiased; }
.clip { position: absolute; inset: 0; }
.marks { position: absolute; inset: 0; width: 100%; height: 100%; }
/* Every scene is the same asymmetric block: one left margin, the words stacked down it, nothing centred for its own
   sake. The block is set a little above the middle, because type centred on the middle of a frame reads as low. */
.frame { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
  padding: var(--margin) var(--margin) calc(var(--margin) + var(--lift)); gap: calc(var(--margin) * 0.32); }
.frame > * { position: relative; }
/* A title card is set on the foot of the frame instead, with the air above it, the way a poster is. */
.frame--title { justify-content: flex-end; padding-bottom: calc(var(--margin) * 1.05); }
/* A figure that size carries its own lift: the digits stand well above their line and nothing hangs below them. */
.frame--stat { padding-bottom: var(--margin); }
.display { font-size: calc(112px * var(--s)); line-height: 1.0; letter-spacing: -0.038em; font-weight: 660; max-width: 10.5em; overflow-wrap: break-word; }
.heading { font-size: calc(68px * var(--s)); line-height: 1.08; letter-spacing: -0.03em; font-weight: 630; max-width: 13.5em; overflow-wrap: break-word; }
.lead { font-size: calc(38px * var(--t)); line-height: 1.3; letter-spacing: -0.016em; font-weight: 450; max-width: 22em; overflow-wrap: break-word; }
.body { font-size: calc(34px * var(--t)); line-height: 1.32; letter-spacing: -0.012em; font-weight: 440; max-width: 20em; overflow-wrap: break-word; }
.label { font-size: calc(22px * var(--t)); line-height: 1.3; font-weight: 620; text-transform: uppercase; letter-spacing: 0.1em; }
/* The one number a stat scene carries is the scene: everything else on it is a caption to the number. */
.stat { font-size: calc(300px * var(--s)); line-height: 0.88; letter-spacing: -0.052em; font-weight: 680; color: ${sketch ? paint.ink : paint.signal};
  font-variant-numeric: tabular-nums; white-space: nowrap; }
/* The figure counts up to itself, so the digits are held to their final width and nothing beside them shifts. */
.count { display: inline-block; text-align: right; }
.quote { font-size: calc(62px * var(--s)); line-height: 1.18; letter-spacing: -0.024em; font-weight: 520; max-width: 12.5em;
  border-left: ${sketch ? 'transparent' : paint.signal} solid calc(5px * var(--s)); padding-left: calc(var(--margin) * 0.5); overflow-wrap: break-word; }
.quiet { color: ${paint.quiet}; }
/* The one piece of structure that recurs: a short measured bar that says the block ends here. Drawn by hand in the notebook. */
.rule { flex: none; width: calc(176px * var(--s)); height: calc(5px * var(--s)); transform-origin: 0 50%; background: ${sketch ? 'transparent' : paint.signal}; }
.list { list-style: none; display: flex; flex-direction: column; gap: calc(var(--margin) * 0.34); }
.list li { display: flex; align-items: baseline; gap: calc(30px * var(--t)); }
.tick { flex: none; position: relative; top: -0.3em; width: calc(34px * var(--s)); height: calc(4px * var(--s)); transform-origin: 0 50%; background: ${sketch ? 'transparent' : paint.signal}; }
/* A picture fills the frame in the clean look and is taped onto the page, with a margin, in the notebook. */
.shot { position: absolute; inset: ${sketch ? 'calc(var(--margin) * 0.72)' : '0'}; overflow: hidden; }
${sketch ? '.frame--captioned .shot { bottom: calc(var(--margin) * 2.2); }' : ''}
.shot img, .shot video { display: block; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 50%; }
.plate { position: absolute; left: 0; right: 0; bottom: 0; padding: var(--margin); padding-top: calc(var(--margin) * 1.7);
  background: ${sketch ? 'none' : `linear-gradient(to top, rgb(${paint.scrim}) 12%, rgba(${paint.scrim}, 0.74) 56%, rgba(${paint.scrim}, 0) 100%)`}; }
.frame--picture { justify-content: flex-end; padding: 0; gap: 0; }

/* A hook is the first second and a half of a reel: one line, as large as the frame will carry it, and nothing else. */
.hook { font-size: calc(132px * var(--s)); line-height: 0.98; letter-spacing: -0.042em; font-weight: 740; max-width: 9em; overflow-wrap: break-word; }
.frame--hook { justify-content: center; }
/* A call to action is a line and the place to go, set apart from it the way a button is. */
.frame--cta { justify-content: center; align-items: flex-start; }
.cta { display: inline-flex; align-items: center; gap: calc(22px * var(--s)); padding: calc(20px * var(--t)) calc(38px * var(--t));
  border-radius: 999px; background: ${paint.signal}; color: ${lightOf(paint.signal) > 0.55 ? '#14181D' : '#FFFFFF'};
  font-size: calc(34px * var(--t)); font-weight: 640; letter-spacing: -0.01em; }
/* A logo sting is the wordmark alone on the ground, with one measured line drawing itself under it. */
.frame--logo { justify-content: center; align-items: center; padding-bottom: var(--margin); }
.logo { font-size: calc(104px * var(--s)); line-height: 1; letter-spacing: -0.03em; font-weight: 700; text-align: center; }
.logo img { display: block; max-width: calc(520px * var(--s)); max-height: calc(200px * var(--s)); object-fit: contain; }
.frame--logo .lead { text-align: center; max-width: 18em; }
.frame--logo .rule { align-self: center; }
/* Before and after, side by side on a wide frame and one over the other on a tall one; the turn between them is the
   scene, so the second half is held back until the first has been read. */
.compare { display: flex; ${shape === 'tall' ? 'flex-direction: column;' : ''} gap: calc(var(--margin) * 0.5); width: 100%; align-items: stretch; }
.side { flex: 1 1 0; display: flex; flex-direction: column; gap: calc(20px * var(--s)); padding: calc(var(--margin) * 0.52);
  border-radius: calc(22px * var(--s)); border: calc(3px * var(--s)) solid ${sketch ? 'transparent' : `${paint.quiet}55`}; }
.side--after { border-color: ${sketch ? 'transparent' : paint.signal}; }
.side .label { color: ${paint.quiet}; }
.side--after .label { color: ${paint.signal}; }
.side p.body { max-width: none; font-size: calc(38px * var(--t)); line-height: 1.24; font-weight: 500; }
.side .label { font-size: calc(24px * var(--t)); }
/* A checklist is a list that says yes, so each line carries a mark rather than a bar. */
.mark { flex: none; position: relative; top: 0.06em; width: calc(40px * var(--t)); height: calc(40px * var(--t)); color: ${sketch ? paint.ink : paint.signal}; }
.mark svg { display: block; width: 100%; height: 100%; }
.list--check li { align-items: flex-start; gap: calc(26px * var(--s)); }
/* Steps are numbered, and the number is the structure: it is set in the signal colour and held to one width. */
.step { flex: none; font-size: calc(40px * var(--t)); font-weight: 700; line-height: 1.1; color: ${sketch ? paint.ink : paint.signal};
  font-variant-numeric: tabular-nums; min-width: 1.6em; }
.list--steps li { align-items: baseline; gap: calc(26px * var(--s)); }
/* A screenshot in the thing it was taken on. The mockups are drawn here, in the page, so nothing is fetched and every
   frame of the slow push into the screen is drawn rather than resampled. */
.frame--device { justify-content: center; align-items: center; gap: calc(var(--margin) * 0.44); padding-bottom: calc(var(--margin) + var(--lift) * 0.4); }
.frame--device .heading, .frame--device .lead { text-align: center; max-width: 16em; }
.device { position: relative; flex: 0 1 auto; display: flex; align-items: center; justify-content: center; }
.device__glass { position: relative; overflow: hidden; background: #0B0E12; }
.device__glass img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 0%; transform-origin: 50% 0%; }
.device--phone .device__glass { width: calc(380px * var(--s)); height: calc(786px * var(--s)); border-radius: calc(46px * var(--s));
  box-shadow: 0 0 0 calc(12px * var(--s)) #23272E, 0 0 0 calc(15px * var(--s)) #3A414B, 0 calc(40px * var(--s)) calc(80px * var(--s)) rgba(0,0,0,0.42); }
.device--phone .device__notch { position: absolute; top: calc(14px * var(--s)); left: 50%; transform: translateX(-50%);
  width: calc(118px * var(--s)); height: calc(30px * var(--s)); border-radius: 999px; background: #14171C; }
.device--laptop .device__glass { width: calc(1000px * var(--s)); height: calc(625px * var(--s)); border-radius: calc(12px * var(--s));
  box-shadow: 0 0 0 calc(13px * var(--s)) #23272E, 0 0 0 calc(16px * var(--s)) #3A414B; }
.device--laptop .device__foot { position: absolute; left: 50%; bottom: calc(-26px * var(--s)); transform: translateX(-50%);
  width: calc(1180px * var(--s)); height: calc(20px * var(--s)); border-radius: 0 0 calc(14px * var(--s)) calc(14px * var(--s));
  background: linear-gradient(#2C313A, #1B1F25); box-shadow: 0 calc(26px * var(--s)) calc(50px * var(--s)) rgba(0,0,0,0.38); }
.device--browser .device__chrome { width: calc(1060px * var(--s)); border-radius: calc(16px * var(--s)); overflow: hidden;
  box-shadow: 0 calc(34px * var(--s)) calc(74px * var(--s)) rgba(0,0,0,0.40); }
.device--browser .device__bar { display: flex; align-items: center; gap: calc(10px * var(--s)); height: calc(52px * var(--s));
  padding: 0 calc(20px * var(--s)); background: #2A2F37; }
.device--browser .device__dot { width: calc(14px * var(--s)); height: calc(14px * var(--s)); border-radius: 999px; background: #4A515C; }
.device--browser .device__pill { flex: 1; margin-left: calc(16px * var(--s)); height: calc(28px * var(--s)); border-radius: 999px;
  background: #1D2127; color: #8C95A1; font-size: calc(16px * var(--s)); line-height: calc(28px * var(--s)); padding: 0 calc(16px * var(--s)); overflow: hidden; white-space: nowrap; }
.device--browser .device__glass { width: 100%; height: calc(600px * var(--s)); border-radius: 0; }
/* A person talking to camera, or a generated clip, fills the frame and takes the words over it. */
.frame--presenter { justify-content: flex-end; padding: 0; gap: 0; }
.presenter { position: absolute; inset: 0; overflow: hidden; }
.presenter img, .presenter video { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 30%; transform-origin: 50% 30%; }

/* The captions: the line being said, word by word, held off the bottom edge by more than it looks like it needs —
   on a phone the last fifth of the frame belongs to the player, the poster's own furniture and the thumb. */
.caps { position: absolute; left: var(--margin); right: var(--margin); bottom: var(--caps); display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; pointer-events: none; }
.capline { position: absolute; bottom: 0; left: 0; right: 0; display: flex; flex-wrap: wrap; gap: 0 calc(16px * var(--s));
  align-items: baseline; justify-content: center; text-align: center; }
.capword { font-size: calc(${shape === 'tall' ? 58 : shape === 'square' ? 50 : 44}px * var(--s)); line-height: 1.16; font-weight: 720; letter-spacing: -0.018em;
  color: ${paint.ink}; ${sketch ? `text-shadow: 0 0 calc(12px * var(--s)) rgba(${paint.scrim}, 0.9);` : `text-shadow: 0 calc(3px * var(--s)) calc(18px * var(--s)) rgba(0, 0, 0, 0.55);`}
  padding: calc(2px * var(--s)) 0; }
`.trim();
}
