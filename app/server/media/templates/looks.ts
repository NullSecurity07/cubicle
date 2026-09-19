import type { Shape } from '../../../shared/model.ts';
import { lightOf, PACK, paintOf, type Brand, type Pack } from './packs.ts';

export { PACK, PACKS, paintOf, rgbOf, chromaOf, cutAt, isPack, CUTS, lightOf, type Brand, type Pack, type Paint, type Cut, type PackStyle } from './packs.ts';
// The founder's word for a pack used to be a "look", and the tool still says `look`. One name, two words for it.
export type Look = Pack;
export { PACKS as LOOKS } from './packs.ts';

// The three shapes a video can be, and how big everything in it is drawn. `scale` multiplies the whole type scale so a
// tall phone video is not the wide one with the words falling off the sides — a phone is read at arm's length, so its
// words are larger against their frame, not smaller. `lift` is how much air is left under a block: type centred on the
// middle of the frame looks low, so every block sits a little above it. `caps` is how far the captions sit off the
// bottom edge: on a phone the last fifth of the frame is under the player's own controls and the poster's thumb.
// `text` is the second scale, and it is the one that makes a phone film a phone film: the big type barely changes
// between shapes, but a line of body copy set for a screen watched across a room is unreadable held in one hand, so
// everything small grows by a third on a tall frame. `capChars` is how wide a caption line may run before it breaks —
// measured in characters, because a caption that wraps by itself leaves one word stranded on a line of its own.
// `safeTop` and `safeFoot` are the platform's own furniture: on a phone feed the top of the frame carries a handle
// and the bottom carries the caption, the sound and the buttons, and anything drawn there is covered up.
export const FORMATS: Record<Shape, { width: number; height: number; scale: number; text: number; margin: number; lift: number; caps: number; capChars: number; safeTop: number; safeFoot: number }> = {
  wide: { width: 1280, height: 720, scale: 1, text: 1, margin: 96, lift: 56, caps: 74, capChars: 34, safeTop: 0, safeFoot: 0 },
  tall: { width: 720, height: 1280, scale: 0.98, text: 1.34, margin: 64, lift: 96, caps: 196, capChars: 20, safeTop: 120, safeFoot: 260 },
  square: { width: 1080, height: 1080, scale: 0.94, text: 1.12, margin: 92, lift: 58, caps: 110, capChars: 26, safeTop: 0, safeFoot: 0 },
};

// How fast the film moves. `calm` is the explainer: one long ease, a scene held as long as it takes to read. `punchy`
// is the reel: half the entrance, a third of the hold, a cut you feel. Nothing else about the film changes.
export const PACES = ['calm', 'punchy'] as const;
export type Pace = (typeof PACES)[number];
export const PACE: Record<Pace, { rise: number; ease: string; stagger: number; out: number; travel: number; read: number; floor: number; ceiling: number; lead: number; tail: number }> = {
  calm: { rise: 0.92, ease: 'expo.out', stagger: 0.10, out: 0.42, travel: 46, read: 2.9, floor: 2.8, ceiling: 11, lead: 0.35, tail: 0.65 },
  punchy: { rise: 0.52, ease: 'power3.out', stagger: 0.05, out: 0.22, travel: 30, read: 4.3, floor: 1.6, ceiling: 6, lead: 0.16, tail: 0.24 },
};

// Film grain, drawn rather than fetched: one tile of monochrome noise as an SVG, repeated over the whole frame. It is
// static, and it has to be — a grain that moved would have to be driven by something, and nothing in a film rendered
// frame by frame may depend on anything but the clock.
const GRAIN = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E\")";

// One type scale, set once, used everywhere: display, heading, lead, body, label, and the one big number. The sizes
// are written for something watched from across a room, not read on a page: on a wide frame a heading is a fifteenth
// of the height, a title a seventh, and the one number on a stat scene is over a third of it.
export function styleSheet(shape: Shape, pack: Pack, brand?: Brand): string {
  const { scale, text, margin, lift, caps, safeTop, safeFoot } = FORMATS[shape];
  const style = PACK[pack];
  const paint = paintOf(pack, brand);
  const sketch = pack === 'sketch';
  // A product's own typeface is used only when its file could be copied out of the product. Naming a face the page
  // cannot load is not a fallback, it is a lie the renderer calls out: nothing would be fetched, nothing would
  // change, and the check would carry an error about it for the rest of the film's life.
  const display = brand?.fontFile && paint.font ? `${JSON.stringify(paint.font)}, ${style.display}` : style.display;
  const body = brand?.fontFile && paint.font ? `${JSON.stringify(paint.font)}, ${style.body}` : style.body;
  const faces = style.fonts.map((one) => `@font-face { font-family: '${one.family}'; src: url('vendor/${one.file}') format('woff2'); font-weight: 100 900; font-style: normal; font-display: block; }`).join('\n');
  return `
${faces}
${brand?.fontFile ? `@font-face { font-family: ${JSON.stringify(paint.font ?? 'Brand')}; src: url('vendor/${brand.fontFile}'); font-weight: 100 900; font-style: normal; font-display: block; }\n` : ''}* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; }
:root { --s: ${scale}; --t: ${(scale * text).toFixed(3)}; --margin: ${margin}px; --lift: ${lift}px; --caps: ${caps}px;
  --safe-top: ${safeTop}px; --safe-foot: ${safeFoot}px; --radius: ${style.radius}px;
  --ground: ${paint.ground}; --ink: ${paint.ink}; --quiet: ${paint.quiet}; --signal: ${paint.signal}; --mark: ${paint.mark}; --scrim: ${paint.scrim}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; color: ${paint.ink};
  font-family: ${body}; font-synthesis: none; -webkit-font-smoothing: antialiased; }
.clip { position: absolute; inset: 0; }
/* Everything one scene is made of sits inside one box, because the move between two scenes is a move of the whole
   box: a whip pan that left the captions behind would read as a fault rather than as a cut. */
.stage { position: absolute; inset: 0; will-change: transform, opacity; }
.marks { position: absolute; inset: 0; width: 100%; height: 100%; }

/* --- Depth. Three layers nothing else touches: the picture under the words, the grain over everything, and the
   corners pulled down so the middle of the frame is where the eye goes. --- */
.bg { position: absolute; inset: 0; overflow: hidden; z-index: 0; background: ${paint.ground}; }
.bg img { display: block; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 45%; }
/* The scrim: the ground washing up from the foot of the frame and a flat hold over the whole of it, so a line of
   type is legible over a photograph whatever the photograph turns out to be. */
.bg::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(to top, rgba(${paint.scrim}, ${Math.min(0.96, style.scrim + 0.16).toFixed(2)}) 0%, rgba(${paint.scrim}, ${(style.scrim * 0.86).toFixed(2)}) 46%, rgba(${paint.scrim}, ${(style.scrim * 0.62).toFixed(2)}) 100%); }
/* No picture maker, no flat colour either: four soft lamps of the film's own colours drifting behind the words. */
.mesh { position: absolute; inset: -18%; z-index: 0; overflow: hidden; }
.blob { position: absolute; filter: blur(calc(120px * var(--s))); opacity: 0.55; }
.sweep { position: absolute; inset: -20%; mix-blend-mode: screen; }
.grain { position: absolute; inset: 0; z-index: 8; pointer-events: none; opacity: ${style.grain}; background-image: ${GRAIN}; background-size: calc(180px * var(--s)); mix-blend-mode: ${lightIsDark(paint.ground) ? 'screen' : 'multiply'}; }
.vig { position: absolute; inset: 0; z-index: 7; pointer-events: none;
  background: radial-gradient(ellipse at 50% 46%, rgba(0,0,0,0) 44%, rgba(0,0,0,${style.vignette.toFixed(2)}) 100%); }

/* Every scene is the same asymmetric block: one left margin, the words stacked down it, nothing centred for its own
   sake. The block is set a little above the middle, because type centred on the middle of a frame reads as low.
   On a phone the frame's own top and bottom belong to the platform, so the block keeps clear of both. */
.frame { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
  padding: calc(var(--margin) + var(--safe-top)) var(--margin) calc(var(--margin) + var(--lift) + var(--safe-foot) * 0.34); gap: calc(var(--margin) * 0.32); }
.frame > * { position: relative; }
/* Over a picture the words drop to the foot of the frame: that is where the scrim holds the picture down, and on a
   portrait it is the one place the type is not across somebody's face. */
.frame--onbg { justify-content: flex-end; }
/* …but in a captioned film the foot of the frame is already spoken for. A block of display type and a caption line
   a few pixels apart are read as one sentence, and then as a fault; the block stops well above the band. */
#root.has-captions .frame, #root.has-captions .frame--title, #root.has-captions .frame--stat, #root.has-captions .frame--onbg {
  padding-bottom: calc(var(--caps) + 104px * var(--s)); }
.frame--onbg.frame--stat, .frame--onbg.frame--logo { justify-content: flex-end; }
/* A title card is set on the foot of the frame instead, with the air above it, the way a poster is. */
.frame--title { justify-content: flex-end; padding-bottom: calc(var(--margin) * 1.05 + var(--safe-foot) * 0.34); }
/* A figure that size carries its own lift: the digits stand well above their line and nothing hangs below them. */
.frame--stat { padding-bottom: calc(var(--margin) + var(--safe-foot) * 0.34); }
${sketch ? '' : `.display, .heading, .hook, .lead, .body, .label, .quote, .logo, .stat, .step, .side .body { text-shadow: 0 calc(2px * var(--s)) calc(22px * var(--s)) rgba(0, 0, 0, 0.58); }`}
.display { font-family: ${display}; font-size: calc(${style.shout ? 118 : 112}px * var(--s)); line-height: ${style.shout ? 0.94 : 1.0}; letter-spacing: ${style.shout ? '-0.01em' : '-0.038em'};
  font-weight: ${style.shout ? 400 : 660}; max-width: 10.5em; overflow-wrap: break-word; ${style.shout ? 'text-transform: uppercase;' : ''} }
.heading { font-family: ${display}; font-size: calc(68px * var(--s)); line-height: ${style.shout ? 1.0 : 1.08}; letter-spacing: ${style.shout ? '-0.006em' : '-0.03em'};
  font-weight: ${style.shout ? 400 : 630}; max-width: 13.5em; overflow-wrap: break-word; ${style.shout ? 'text-transform: uppercase;' : ''} }
.lead { font-size: calc(38px * var(--t)); line-height: 1.3; letter-spacing: -0.016em; font-weight: 450; max-width: 22em; overflow-wrap: break-word; }
.body { font-size: calc(34px * var(--t)); line-height: 1.32; letter-spacing: -0.012em; font-weight: 440; max-width: 20em; overflow-wrap: break-word; }
.label { font-size: calc(22px * var(--t)); line-height: 1.3; font-weight: 620; text-transform: uppercase; letter-spacing: 0.1em; }
/* One word in a line may be the line: it takes the accent colour, and on a kinetic pack a little more size with it. */
.pop { color: ${sketch ? paint.ink : paint.signal}; }
/* The words of a display line are set one at a time so they can arrive one at a time. The box has to be inline for
   the line to break where it would have broken anyway. */
.w { display: inline-block; will-change: transform, opacity; }
/* A sweep of colour drawn behind a headline rather than under it: it grows from the left as the words land. */
.swept { position: relative; z-index: 0; }
.sweep { position: absolute; left: -0.12em; top: 0.10em; bottom: 0.08em; right: -0.12em; z-index: -1; transform-origin: 0% 50%;
  background: ${paint.signal}; border-radius: calc(6px * var(--s)); opacity: 1; }
.on-sweep { position: relative; color: ${lightOf(paint.signal) > 0.55 ? '#0E1013' : '#FFFFFF'}; text-shadow: none; }
/* The one number a stat scene carries is the scene: everything else on it is a caption to the number. */
.stat { font-family: ${display}; font-size: calc(300px * var(--s)); line-height: 0.88; letter-spacing: -0.052em; font-weight: ${style.shout ? 400 : 680}; color: ${sketch ? paint.ink : paint.signal};
  font-variant-numeric: tabular-nums; white-space: nowrap; }
/* The figure counts up to itself, so the digits are held to their final width and nothing beside them shifts. */
.count { display: inline-block; text-align: right; }
.quote { font-family: ${display}; font-size: calc(${pack === 'editorial' ? 74 : 62}px * var(--s)); line-height: 1.18; letter-spacing: -0.024em; font-weight: ${style.shout ? 400 : 520}; max-width: 12.5em;
  border-left: ${sketch ? 'transparent' : paint.signal} solid calc(5px * var(--s)); padding-left: calc(var(--margin) * 0.5); overflow-wrap: break-word; }
.quiet { color: ${paint.quiet}; }
/* The one piece of structure that recurs: a short measured bar that says the block ends here. Drawn by hand in the notebook. */
.rule { flex: none; width: calc(176px * var(--s)); height: calc(5px * var(--s)); transform-origin: 0 50%; background: ${sketch ? 'transparent' : paint.signal}; }
.list { list-style: none; display: flex; flex-direction: column; gap: calc(var(--margin) * 0.34); }
.list li { display: flex; align-items: baseline; gap: calc(30px * var(--t)); }
.tick { flex: none; position: relative; top: -0.3em; width: calc(34px * var(--s)); height: calc(4px * var(--s)); transform-origin: 0 50%; background: ${sketch ? 'transparent' : paint.signal}; }
/* A picture fills the frame in the clean look and is taped onto the page, with a margin, in the notebook. */
.shot { position: absolute; inset: ${sketch ? 'calc(var(--margin) * 0.72)' : '0'}; overflow: hidden; z-index: 1; ${sketch ? 'border-radius: var(--radius);' : ''} }
${sketch ? '.frame--captioned .shot { bottom: calc(var(--margin) * 2.2); }' : ''}
.shot img, .shot video { display: block; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 50%; }
/* A moving shot is the whole frame it plays in. It is written as an element of the film rather than of its scene —
   a <video> with its own start inside a section with one too is resolved against two clocks — so it is the one thing
   on the page that has to be placed here and nowhere else. Without this it plays at whatever size it was encoded
   at, in the corner of the frame, with the film going on underneath it. */
.reel { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; opacity: 0;
  background: ${paint.ground}; transform-origin: 50% 50%; }
/* Somebody talking: their eyes belong a third of the way down, not in the middle. */
.reel--face { object-position: 50% 26%; transform-origin: 50% 26%; }
.shot::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: ${sketch ? 'none' : `linear-gradient(to top, rgba(${paint.scrim}, 0.64) 0%, rgba(${paint.scrim}, 0.26) 44%, rgba(${paint.scrim}, 0.60) 100%)`}; }
/* The words over a picture sit at the foot of the frame — unless the film is captioned, in which case the captions
   are already there and the two would be read as one sentence. Then the plate lifts clear of them. */
.has-caps .plate { top: 0; bottom: auto; padding: calc(var(--margin) + var(--safe-top)) var(--margin) calc(var(--margin) * 1.6);
  background: ${sketch ? 'none' : `linear-gradient(to bottom, rgb(${paint.scrim}) 10%, rgba(${paint.scrim}, 0.88) 48%, rgba(${paint.scrim}, 0) 100%)`}; }
.frame--picture.has-caps { justify-content: flex-start; }
.plate { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; padding: var(--margin); padding-top: calc(var(--margin) * 1.7); padding-bottom: calc(var(--margin) + var(--safe-foot) * 0.34);
  background: ${sketch ? 'none' : `linear-gradient(to top, rgb(${paint.scrim}) 10%, rgba(${paint.scrim}, 0.88) 48%, rgba(${paint.scrim}, 0) 100%)`}; }
.frame--picture { justify-content: flex-end; padding: 0; gap: 0; }
/* The words over a picture are the scene's whole caption, so in a pack that shouts they are set like one rather than
   like a footnote: a line of body copy under a photograph reads as a stray subtitle. */
${style.shout ? `.plate .lead { font-family: ${display}; font-size: calc(54px * var(--s)); line-height: 1.06; font-weight: 400; letter-spacing: -0.006em; text-transform: uppercase; max-width: 13em; }` : ''}

/* A hook is the first second and a half of a reel: one line, as large as the frame will carry it, and nothing else. */
.hook { font-family: ${display}; font-size: calc(${style.shout ? 146 : 132}px * var(--s)); line-height: ${style.shout ? 0.92 : 0.98}; letter-spacing: ${style.shout ? '-0.012em' : '-0.042em'};
  font-weight: ${style.shout ? 400 : 740}; max-width: 9em; overflow-wrap: break-word; ${style.shout ? 'text-transform: uppercase;' : ''} }
.frame--hook { justify-content: center; }
/* An emoji or a mark set beside a line, at the size of a line: the one thing in a reel that is not type. */
.icon { font-size: calc(64px * var(--t)); line-height: 1; }
/* A call to action is a line and the place to go, set apart from it the way a button is. */
.frame--cta { justify-content: center; align-items: flex-start; }
.cta { display: inline-flex; align-items: center; gap: calc(22px * var(--s)); padding: calc(20px * var(--t)) calc(38px * var(--t));
  border-radius: 999px; background: ${paint.signal}; color: ${lightOf(paint.signal) > 0.55 ? '#14181D' : '#FFFFFF'};
  font-size: calc(34px * var(--t)); font-weight: 640; letter-spacing: -0.01em; }
/* A logo sting is the wordmark alone on the ground, with one measured line drawing itself under it. */
.frame--logo { justify-content: center; align-items: center; padding-bottom: var(--margin); }
.logo { font-family: ${display}; font-size: calc(104px * var(--s)); line-height: 1; letter-spacing: -0.03em; font-weight: ${style.shout ? 400 : 700}; text-align: center; }
.logo img { display: block; max-width: calc(520px * var(--s)); max-height: calc(200px * var(--s)); object-fit: contain; }
.frame--logo .lead { text-align: center; max-width: 18em; }
.frame--logo .rule { align-self: center; }
/* Before and after, side by side on a wide frame and one over the other on a tall one; the turn between them is the
   scene, so the second half is held back until the first has been read. */
.compare { display: flex; ${shape === 'tall' ? 'flex-direction: column;' : ''} gap: calc(var(--margin) * 0.5); width: 100%; align-items: stretch; }
.side { flex: 1 1 0; display: flex; flex-direction: column; gap: calc(20px * var(--s)); padding: calc(var(--margin) * 0.52);
  border-radius: var(--radius); border: calc(3px * var(--s)) solid ${sketch ? 'transparent' : `${paint.quiet}55`}; background: rgba(${paint.scrim}, ${sketch ? '0' : '0.78'}); backdrop-filter: blur(calc(6px * var(--s))); }
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
/* A screenshot in the thing it was taken on, and the thing it was taken on is the scene: the mockup takes most of
   the frame's width, its words sit over it on a chip rather than under it in a caption, and the shot pushes slowly
   into the screen so a still page has somewhere to go. The mockups are drawn here, in the page, so nothing is
   fetched and every frame of the push is drawn rather than resampled.
   The variable --devroom is the height the frame needs for all that is not the device; captions claim their own. */
:root { --devroom: calc(78px + var(--safe-top) + var(--safe-foot) * 0.5); }
#root.has-captions { --devroom: calc(var(--caps) + 80px + var(--safe-top)); }
.frame--device { justify-content: center; align-items: center; gap: 0; padding: 0; overflow: visible; }
.device { position: relative; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
/* The floor: a soft shadow pooled under the device and a faint wash of the ground rising past it. */
.device::after { content: ''; position: absolute; left: 50%; bottom: calc(-26px * var(--s)); transform: translateX(-50%);
  width: 108%; height: calc(54px * var(--s)); border-radius: 50%; background: rgba(0, 0, 0, ${sketch ? '0.14' : '0.42'}); filter: blur(calc(26px * var(--s))); z-index: -1; }
.frame--device::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 34%; pointer-events: none;
  background: linear-gradient(to top, rgba(${paint.scrim}, ${sketch ? '0' : '0.55'}) 0%, rgba(${paint.scrim}, 0) 100%); }
.device__glass { position: relative; overflow: hidden; background: #0B0E12; }
.device__glass img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 0%; transform-origin: 50% 30%; }
/* A phone is bound by the frame's height; a laptop and a browser by its width, then cut back if that would not fit. */
.device--phone .device__glass { height: min(calc(100vh - var(--devroom)), calc(78vw * 2.067)); aspect-ratio: 9 / 18.6; width: auto;
  border-radius: calc(46px * var(--s));
  box-shadow: 0 0 0 calc(12px * var(--s)) #23272E, 0 0 0 calc(15px * var(--s)) #3A414B, 0 calc(34px * var(--s)) calc(70px * var(--s)) rgba(0,0,0,0.44); }
.device--phone .device__notch { position: absolute; top: calc(14px * var(--s)); left: 50%; transform: translateX(-50%);
  width: calc(118px * var(--s)); height: calc(30px * var(--s)); border-radius: 999px; background: #14171C; }
.device--laptop .device__glass { width: min(84vw, calc((100vh - var(--devroom)) * 1.6)); aspect-ratio: 16 / 10; height: auto;
  border-radius: calc(12px * var(--s));
  box-shadow: 0 0 0 calc(13px * var(--s)) #23272E, 0 0 0 calc(16px * var(--s)) #3A414B; }
.device--laptop .device__foot { position: absolute; left: 50%; bottom: calc(-22px * var(--s)); transform: translateX(-50%);
  width: 104%; height: calc(18px * var(--s)); border-radius: 0 0 calc(14px * var(--s)) calc(14px * var(--s));
  background: linear-gradient(#2C313A, #1B1F25); }
.device--browser .device__chrome { width: fit-content; max-width: 86vw; border-radius: calc(16px * var(--s)); overflow: hidden;
  box-shadow: 0 calc(34px * var(--s)) calc(74px * var(--s)) rgba(0,0,0,0.40); }
.device--browser .device__bar { display: flex; align-items: center; gap: calc(10px * var(--s)); height: calc(52px * var(--s));
  padding: 0 calc(20px * var(--s)); background: #2A2F37; }
.device--browser .device__dot { flex: none; width: calc(14px * var(--s)); height: calc(14px * var(--s)); border-radius: 999px; background: #4A515C; }
.device--browser .device__pill { flex: 1; margin-left: calc(16px * var(--s)); height: calc(28px * var(--s)); border-radius: 999px;
  background: #1D2127; color: #8C95A1; font-size: calc(16px * var(--s)); line-height: calc(28px * var(--s)); padding: 0 calc(16px * var(--s)); overflow: hidden; white-space: nowrap; }
.device--browser .device__glass { height: min(calc(86vw / 1.739), calc(100vh - var(--devroom) - calc(52px * var(--s)))); aspect-ratio: 16 / 9.2; width: auto; border-radius: 0; }
/* The scene's words go on the device, not under it: one small chip in the corner of the frame, out of the way of
   whatever the screenshot is showing. */
/* The chip sits in the floor under the device, where the ground is darkest and nothing is happening — except in a
   captioned film, where the foot of the frame is already spoken for and it goes to the head instead. */
.chip { position: absolute; bottom: calc(var(--margin) * 0.5 + var(--safe-foot) * 0.34); left: calc(var(--margin) * 0.62); z-index: 5;
  padding: calc(10px * var(--t)) calc(20px * var(--t)); border-radius: 999px;
  background: rgba(${paint.scrim}, ${sketch ? '0.86' : '0.82'}); backdrop-filter: blur(calc(8px * var(--s)));
  border: 1px solid ${paint.quiet}44; color: ${paint.ink};
  font-size: calc(26px * var(--t)); font-weight: 600; letter-spacing: -0.008em; max-width: 72%; }
#root.has-captions .chip { top: calc(var(--margin) * 0.55 + var(--safe-top)); bottom: auto; }
/* A person talking to camera, or a generated clip, fills the frame and takes the words over it. */
.frame--presenter { justify-content: flex-end; padding: 0; gap: 0; }
.presenter { position: absolute; inset: 0; overflow: hidden; z-index: 1; }
.presenter img, .presenter video { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 30%; transform-origin: 50% 30%; }

/* How far through the film a viewer is, drawn as one hairline across the foot of the frame. A reel earns this: it is
   the one thing that makes somebody stay for the last two seconds. */
.progress { position: absolute; left: 0; bottom: 0; height: calc(7px * var(--s)); width: 100%; z-index: 9;
  transform-origin: 0 50%; background: ${paint.signal}; opacity: 0.92; }

/* The captions: the line being said, word by word, held off the bottom edge by more than it looks like it needs —
   on a phone the last fifth of the frame belongs to the player, the poster's own furniture and the thumb. */
.caps { position: absolute; left: var(--margin); right: var(--margin); bottom: var(--caps); z-index: 6; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; pointer-events: none; }
.capline { position: absolute; bottom: 0; left: 0; right: 0; display: flex; flex-wrap: wrap; gap: 0 calc(16px * var(--s));
  align-items: baseline; justify-content: center; text-align: center; }
.capword { font-family: ${style.shout ? display : body}; font-size: calc(${shape === 'tall' ? 58 : shape === 'square' ? 50 : 44}px * var(--s)); line-height: 1.16; font-weight: ${style.shout ? 400 : 720}; letter-spacing: -0.018em;
  color: ${paint.ink}; ${style.shout ? 'text-transform: uppercase;' : ''} ${sketch ? `text-shadow: 0 0 calc(12px * var(--s)) rgba(${paint.scrim}, 0.9);` : `text-shadow: 0 calc(3px * var(--s)) calc(18px * var(--s)) rgba(0, 0, 0, 0.62);`}
  padding: calc(2px * var(--s)) 0; }
.capword.pop { color: ${sketch ? paint.ink : paint.signal}; }
`.trim();
}

// Grain is light on a dark ground and dark on a light one, or it is a grey haze over the picture rather than film.
const lightIsDark = (hex: string) => lightOf(hex) < 0.5;
