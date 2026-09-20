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
// bottom edge. `text` is the second scale, and it is the one that makes a phone film a phone film: the big type barely
// changes between shapes, but a line of body copy set for a screen watched across a room is unreadable held in one
// hand, so everything small grows by a third on a tall frame. `capChars` is how wide a caption line may run before it
// breaks — measured in characters, because a caption that wraps by itself leaves one word stranded on a line of its own.
//
// `safeTop`, `safeFoot` and `safeRight` are the platform's own furniture, and they are not guesses. On a 1080×1920
// phone feed the top 250 px carry a handle and a back arrow, the bottom 510 px carry the caption, the sound, the
// follow button and the poster's own name, and the right-hand 140 px carry the column of buttons a thumb reaches
// for. TikTok took another twenty pixels off the right in January 2026, Reels another fifty off the bottom in late
// 2025, and Shorts grew its subscribe button by a third. Anything drawn in those strips is covered up.
//
// Our tall frame is 720×1280, which is that canvas at two thirds, so every one of those numbers is scaled by the
// same two thirds and nothing is rounded down. `safeArea()` below is the assertion: the block, the captions and
// every graphic have to sit inside it, and a test holds the stylesheet to it.
export const SAFE_1080 = { top: 250, foot: 510, right: 140 };
export const FORMATS: Record<Shape, { width: number; height: number; scale: number; text: number; margin: number; lift: number; caps: number; capChars: number; safeTop: number; safeFoot: number; safeRight: number }> = {
  wide: { width: 1280, height: 720, scale: 1, text: 1, margin: 96, lift: 56, caps: 118, capChars: 18, safeTop: 0, safeFoot: 0, safeRight: 0 },
  tall: { width: 720, height: 1280, scale: 0.98, text: 1.34, margin: 64, lift: 96, caps: 420, capChars: 11, safeTop: 167, safeFoot: 340, safeRight: 94 },
  square: { width: 1080, height: 1080, scale: 0.94, text: 1.12, margin: 92, lift: 58, caps: 356, capChars: 14, safeTop: 0, safeFoot: 0, safeRight: 0 },
};

// The rectangle everything a viewer has to read must sit inside, in the frame's own pixels. Nothing outside it is
// covered up on a screen — it is covered up in the feed, which is the only place these films are watched.
export const safeArea = (shape: Shape): { x: number; y: number; width: number; height: number } => {
  const { width, height, safeTop, safeFoot, safeRight, margin } = FORMATS[shape];
  return {
    x: margin, y: safeTop + margin * 0.5,
    width: width - margin - safeRight - margin * 0.5,
    height: height - safeTop - safeFoot - margin,
  };
};

// How fast the film moves. `calm` is the explainer: one long ease, a scene held as long as it takes to read. `punchy`
// is the reel: half the entrance, a third of the hold, a cut you feel. Nothing else about the film changes.
export const PACES = ['calm', 'punchy'] as const;
export type Pace = (typeof PACES)[number];
export const PACE: Record<Pace, { rise: number; ease: string; stagger: number; out: number; travel: number; read: number; floor: number; ceiling: number; lead: number; tail: number }> = {
  calm: { rise: 0.92, ease: 'expo.out', stagger: 0.10, out: 0.42, travel: 46, read: 2.9, floor: 2.8, ceiling: 11, lead: 0.35, tail: 0.65 },
  punchy: { rise: 0.52, ease: 'power3.out', stagger: 0.05, out: 0.22, travel: 30, read: 4.3, floor: 1.6, ceiling: 6, lead: 0.16, tail: 0.24 },
};

// The type scale, and the floors under it.
//
// A film is not a page. Everything on it is read once, at a glance, on a phone held at arm's length or on a screen
// across a room, and the sizes that survive that are far larger than any web design would use. The three proof
// films failed exactly here: "type is small serif lost in the frame", "bullet text is tiny", "a tiny CTA pill" —
// every one of them a line set at two per cent of the frame's height, which at feed-thumbnail size is nothing.
//
// So the scale has floors, stated as a share of the frame's height and enforced rather than intended:
//
//   - a **headline** — the one line a scene is about — is at least eight per cent of the frame on a wide film and
//     six on a tall one, where the frame is taller and the type is read closer;
//   - a **support line** — a lead, a bullet, a step, a button — is at least three point two per cent;
//   - **nothing at all** is under two point six per cent. An eyebrow that small is decoration, not writing.
//
// A pack may set anything larger. Nothing may set anything smaller, and `typeScale` is where that is true rather
// than hoped for: every size in the stylesheet below comes out of it, and a test holds it to these numbers.
export const TYPE_FLOOR = {
  headline: { wide: 0.080, tall: 0.060, square: 0.065 } as Record<Shape, number>,
  // A title card is not a headline, it is the film announcing itself, and the long-form register leans on it the
  // way a reel leans on its captions. Nine per cent of the frame is where a serif display line stops being a
  // heading and starts being a title.
  title: 0.090,
  support: 0.032,
  least: 0.026,
};

export type TypeScale = {
  hook: number; display: number; heading: number; quote: number; stat: number; titleCard: number;
  lead: number; body: number; step: number; cta: number; icon: number; sideBody: number;
  label: number; chip: number; sideLabel: number; mark: number;
  hookCaps: number; displayCaps: number; headingCaps: number; statCaps: number;
};

// Every size in the film, in whole pixels of its own frame, with the floors already applied.
// Whether this pack sets its display line in a serif. The two that do lean on it — the editorial look and the
// long-form documentary register — and a serif has to be set larger and heavier than a sans to hold the same
// weight over a photograph.
export const isSerif = (pack: Pack): boolean => PACK[pack].display.includes('Studio Serif');

export function typeScale(shape: Shape, pack: Pack): TypeScale {
  const { height, scale, text } = FORMATS[shape];
  const style = PACK[pack];
  const s = scale;
  const t = scale * text;
  // The floors are shares of the picture a viewer actually sees. A letterboxed film gives an eleventh of its
  // frame to two black bars, so a line set at six per cent of the frame is five and a half per cent of the
  // picture — and it is the picture the eye measures it against. The floors are taken against the visible band.
  const seen = height * (1 - 2 * (style.format?.letterbox ?? 0));
  const head = seen * TYPE_FLOOR.headline[shape];
  const support = seen * TYPE_FLOOR.support;
  const least = seen * TYPE_FLOOR.least;
  // A serif carries a twelfth more size than the sans it is measured against: its cap height is smaller and its
  // stems are thinner, so at the same em it reads two sizes down over a photograph.
  const display = isSerif(pack) ? 1.08 : 1;
  const at = (px: number, floor: number) => Math.round(Math.max(px, floor));
  return {
    hook: at((style.shout ? 146 : 132) * s * display, head),
    display: at((style.shout ? 118 : 112) * s * display, head),
    titleCard: at((style.shout ? 118 : 112) * s * display, seen * TYPE_FLOOR.title),
    heading: at(68 * s * display, head),
    quote: at((pack === 'editorial' || pack === 'documentary' ? 74 : 62) * s * display, head),
    stat: Math.round(300 * s),
    lead: at(38 * t, support),
    body: at(34 * t, support),
    step: at(40 * t, support),
    cta: at(34 * t, support),
    icon: at(64 * t, support),
    sideBody: at(38 * t, support),
    label: at(22 * t, least),
    chip: at(26 * t, least),
    sideLabel: at(24 * t, least),
    mark: at(40 * t, support),
    // A captioned film has two kinds of type on it and the caption band is a tenth of the frame, so the big type
    // comes down to make room — down to the floor and no further. A headline that has gone under the floor to
    // clear the captions is a headline nobody reads, which is the trade that was quietly being made.
    hookCaps: at((style.shout ? 112 : 102) * s, head),
    displayCaps: at((style.shout ? 94 : 90) * s, head),
    headingCaps: at(58 * s, head),
    statCaps: Math.round(224 * s),
  };
}

// One type scale, set once, used everywhere: display, heading, lead, body, label, and the one big number. The sizes
// are written for something watched from across a room, not read on a page: on a wide frame a heading is a fifteenth
// of the height, a title a seventh, and the one number on a stat scene is over a third of it.
export function styleSheet(shape: Shape, pack: Pack, brand?: Brand): string {
  const { height, scale, text, margin, lift, caps, safeTop, safeFoot, safeRight } = FORMATS[shape];
  const style = PACK[pack];
  const paint = paintOf(pack, brand);
  const sketch = pack === 'sketch';
  // Whether this pack's display face is a serif, which changes how heavily it has to be set over a photograph.
  const serif = isSerif(pack);
  // What this pack declares as its format, if anything. Almost none of them do.
  const grade = style.format?.grade;
  const bars = style.format?.letterbox ?? 0;
  // Every size in the film, floored. Nothing below writes a number of its own.
  const type = typeScale(shape, pack);
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
  --safe-top: ${safeTop}px; --safe-foot: ${safeFoot}px; --safe-right: ${safeRight}px; --radius: ${style.radius}px;
  --ground: ${paint.ground}; --ink: ${paint.ink}; --quiet: ${paint.quiet}; --signal: ${paint.signal}; --mark: ${paint.mark}; --scrim: ${paint.scrim}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; color: ${paint.ink};
  font-family: ${body}; font-synthesis: none; -webkit-font-smoothing: antialiased; }
.clip { position: absolute; inset: 0; }
/* Everything one scene is made of sits inside one box, because the move between two scenes is a move of the whole
   box: a whip pan that left the captions behind would read as a fault rather than as a cut. */
.stage { position: absolute; inset: 0; will-change: transform, opacity; }
.marks { position: absolute; inset: 0; width: 100%; height: 100%; }

/* --- Depth. One layer, and it is a picture: the photograph under the words. There is no grain over the frame and
   no vignette pulling the corners down, and there used to be both, on every film this studio made. The founder's
   word for that was "obvious filter", and the research says the same thing in more words: heavy contrast, crushed
   blacks, a strong vignette and visible grain are what generated video looks like, and the test is whether the
   viewer notices the effect before the story. A grade belongs to a pack that declares one as its format, it is
   applied to the pictures and never to the type, and it is identical on every film in that series. --- */
.bg { position: absolute; inset: 0; overflow: hidden; z-index: 0; background: ${paint.ground}; }
.bg img { display: block; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 45%; }
/* The scrim: the ground washing up from the foot of the frame and a flat hold over the whole of it, so a line of
   type is legible over a photograph whatever the photograph turns out to be.

   How hard it holds is the --hold variable, and it is a number measured off the picture itself — the brightness where the
   words really sit, turned into the contrast ratio the words would really have, solved for the lightest wash
   that clears four and a half to one. The pack's own number is the fallback, for a machine with nothing able to
   look at a picture. One number for every photograph in a film is how a white wall came back with body copy
   floating on it and a whole reel came back near-black. */
.bg { --hold: ${style.scrim.toFixed(2)}; }
.bg::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(to top, rgba(${paint.scrim}, min(0.96, calc(var(--hold) + 0.16))) 0%, rgba(${paint.scrim}, calc(var(--hold) * 0.86)) 46%, rgba(${paint.scrim}, calc(var(--hold) * 0.62)) 100%); }
/* No picture maker, no flat colour either: four soft lamps of the film's own colours drifting behind the words. */
.mesh { position: absolute; inset: -18%; z-index: 0; overflow: hidden; }
.blob { position: absolute; filter: blur(calc(120px * var(--s))); opacity: 0.55; }
/* One band of light lying across the lamps. It used to be called .sweep, which is also the name of the block of
   accent colour drawn behind a headline — two completely different things sharing a selector, so each took half of
   the other's rules. The headline block inherited the screen blend mode, and inside a scene being blurred out
   on a cut that blends against the whole frame: a full-frame acid wash, one frame long, at several of the cuts in
   a real reel. They have their own names now. */
/* One band of light lying across the lamps. It used to be called .sweep, which is also the name of the block of
   accent colour drawn behind a headline — two different things sharing a selector, so each took half of the
   other's rules. And it used to blend in screen mode, which is worse than it sounds: a scene with no photograph
   falls back to these lamps, and on the frames where one scene is leaving while the next arrives the leaving
   scene's green lamps screened over the arriving scene's photograph. A full-frame acid wash, one frame long, at
   several of the cuts in a real reel. It is a band of light. It does not need a blend mode. */
.glint { position: absolute; inset: -20%; opacity: 0.7; }
/* This pack's declared grade, where it has one: a measured, bounded tune applied to the moving and still
   pictures only. The type sits above it and is never graded, because graded type is a filter over a film rather
   than a look in it.

   The --raise variable goes in front of it. A grade is a house look and is identical on every film in the series, so a
   photograph that came back too dark to read a subject out of is lifted rather than ungraded — which is the
   difference between "the grade is too heavy" and "that picture was dark". It is measured, per picture, and it
   is 1 whenever nothing needed lifting. */
.bg img, .shot img, .shot video, .reel, .device__glass img { filter: brightness(var(--raise, 1))${grade ? ` ${grade}` : ''}; }
${bars ? `/* Letterbox as a fixed format, identical for the whole render: two bars, not a transition, not an effect. */
.bar { position: absolute; left: 0; right: 0; height: ${(bars * 100).toFixed(2)}%; z-index: 9; background: #000; pointer-events: none; }
.bar--top { top: 0; } .bar--foot { bottom: 0; }` : ''}

/* Every scene is the same asymmetric block: one left margin, the words stacked down it, nothing centred for its own
   sake. The block is set a little above the middle, because type centred on the middle of a frame reads as low.
   On a phone the frame's own top and bottom belong to the platform, so the block keeps clear of both. */
.frame { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
  padding: calc(var(--margin) + var(--safe-top)) calc(var(--margin) + var(--safe-right)) calc(var(--margin) + var(--lift) + var(--safe-foot)) var(--margin);
  gap: calc(var(--margin) * 0.32); }
.frame > * { position: relative; }
/* Over a picture the words drop to the foot of the frame: that is where the scrim holds the picture down, and on a
   portrait it is the one place the type is not across somebody's face. */
.frame--onbg { justify-content: flex-end; }
/* …but in a captioned film the foot of the frame is already spoken for. A block of display type and a caption line
   a few pixels apart are read as one sentence, and then as a fault; the block stops well above the band. */
#root.has-captions .frame, #root.has-captions .frame--title, #root.has-captions .frame--stat, #root.has-captions .frame--onbg {
  padding-bottom: calc(var(--caps) + 132px * var(--s)); }
/* A captioned film has two kinds of type on it, and the caption band is a tenth of the frame high. A display line
   set for a frame with nothing else on it overflows its box in both directions and lands on top of the words being
   said — which is what a real reel came back as: the hook and the caption written over each other. So in a
   captioned film the big type comes down, and the block is cut off rather than allowed to spill into the band. */
#root.has-captions .frame { overflow: hidden; }
#root.has-captions .hook { font-size: ${type.hookCaps}px; }
#root.has-captions .display { font-size: ${type.displayCaps}px; }
#root.has-captions .heading { font-size: ${type.headingCaps}px; }
#root.has-captions .stat { font-size: ${type.statCaps}px; }
.frame--onbg.frame--stat, .frame--onbg.frame--logo { justify-content: flex-end; }
/* A title card is set on the foot of the frame instead, with the air above it, the way a poster is — and it is
   the one line in the film that is larger than a headline, because it is the film announcing itself. */
.frame--title { justify-content: flex-end; padding-bottom: calc(var(--margin) * 1.05 + var(--safe-foot)); }
.frame--title .display, #root.has-captions .frame--title .display { font-size: ${type.titleCard}px; }
/* A figure that size carries its own lift: the digits stand well above their line and nothing hangs below them. */
.frame--stat { padding-bottom: calc(var(--margin) + var(--safe-foot)); }
${sketch ? '' : `.display, .heading, .hook, .lead, .body, .label, .quote, .logo, .stat, .step, .side .body { text-shadow: 0 calc(2px * var(--s)) calc(22px * var(--s)) rgba(0, 0, 0, 0.58); }`}
.display { font-family: ${display}; font-size: ${type.display}px; line-height: ${style.shout ? 0.94 : 1.0}; letter-spacing: ${style.shout ? '-0.01em' : '-0.038em'};
  font-weight: ${style.shout ? 400 : 660}; max-width: 10.5em; overflow-wrap: break-word; ${style.shout ? 'text-transform: uppercase;' : ''} }
${serif ? `/* A serif display line over a photograph is the thinnest thing in this studio: its stems are a third the
   width of the sans at the same size and its cap height is smaller, so it reads two sizes down and it disappears
   into a busy picture. Every size in the scale is already a twelfth larger for it; this is the shadow, which has
   to be a real one rather than a hint. */
.display, .heading, .hook, .quote, .logo, .plate .lead { text-shadow: 0 calc(2px * var(--s)) calc(18px * var(--s)) rgba(0, 0, 0, 0.74), 0 0 calc(3px * var(--s)) rgba(0, 0, 0, 0.55); }` : ''}
.heading { font-family: ${display}; font-size: ${type.heading}px; line-height: ${style.shout ? 1.0 : 1.08}; letter-spacing: ${style.shout ? '-0.006em' : '-0.03em'};
  font-weight: ${style.shout ? 400 : 630}; max-width: 13.5em; overflow-wrap: break-word; ${style.shout ? 'text-transform: uppercase;' : ''} }
.lead { font-size: ${type.lead}px; line-height: 1.3; letter-spacing: -0.016em; font-weight: 450; max-width: 22em; overflow-wrap: break-word; }
.body { font-size: ${type.body}px; line-height: 1.32; letter-spacing: -0.012em; font-weight: 440; max-width: 20em; overflow-wrap: break-word; }
.label { font-size: ${type.label}px; line-height: 1.3; font-weight: 620; text-transform: uppercase; letter-spacing: 0.1em; }
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
.stat { font-family: ${display}; font-size: ${type.stat}px; line-height: 0.88; letter-spacing: -0.052em; font-weight: ${style.shout ? 400 : 680}; color: ${sketch ? paint.ink : paint.signal};
  font-variant-numeric: tabular-nums; white-space: nowrap; }
/* The figure counts up to itself, so the digits are held to their final width and nothing beside them shifts. */
.count { display: inline-block; text-align: right; }
.quote { font-family: ${display}; font-size: ${type.quote}px; line-height: 1.18; letter-spacing: -0.024em; font-weight: ${style.shout ? 400 : 520}; max-width: 12.5em;
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
.shot { --hold: ${style.scrim.toFixed(2)}; }
.shot::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: ${sketch ? 'none' : `linear-gradient(to top, rgba(${paint.scrim}, min(0.94, calc(var(--hold) + 0.22))) 0%, rgba(${paint.scrim}, calc(var(--hold) * 0.5)) 44%, rgba(${paint.scrim}, min(0.9, calc(var(--hold) + 0.18))) 100%)`}; }
/* The words over a picture sit at the foot of the frame — unless the film is captioned, in which case the captions
   are already there and the two would be read as one sentence. Then the plate lifts clear of them. */
.has-caps .plate { top: 0; bottom: auto; padding: calc(var(--margin) + var(--safe-top)) var(--margin) calc(var(--margin) * 1.6);
  background: ${sketch ? 'none' : `linear-gradient(to bottom, rgb(${paint.scrim}) 10%, rgba(${paint.scrim}, 0.88) 48%, rgba(${paint.scrim}, 0) 100%)`}; }
.frame--picture.has-caps { justify-content: flex-start; }
.plate { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; padding: var(--margin); padding-top: calc(var(--margin) * 1.7); padding-bottom: calc(var(--margin) + var(--safe-foot));
  background: ${sketch ? 'none' : `linear-gradient(to top, rgb(${paint.scrim}) 10%, rgba(${paint.scrim}, 0.88) 48%, rgba(${paint.scrim}, 0) 100%)`}; }
.frame--picture { justify-content: flex-end; padding: 0; gap: 0; }
/* The words over a picture are the scene's whole caption, so in a pack that shouts they are set like one rather than
   like a footnote: a line of body copy under a photograph reads as a stray subtitle. */
${style.shout ? `.plate .lead { font-family: ${display}; font-size: ${Math.max(type.lead, Math.round(54 * scale))}px; line-height: 1.06; font-weight: 400; letter-spacing: -0.006em; text-transform: uppercase; max-width: 13em; }` : ''}

/* A hook is the first second and a half of a reel: one line, as large as the frame will carry it, and nothing else. */
.hook { font-family: ${display}; font-size: ${type.hook}px; line-height: ${style.shout ? 0.92 : 0.98}; letter-spacing: ${style.shout ? '-0.012em' : '-0.042em'};
  font-weight: ${style.shout ? 400 : 740}; max-width: 9em; overflow-wrap: break-word; ${style.shout ? 'text-transform: uppercase;' : ''} }
.frame--hook { justify-content: center; }
/* An emoji or a mark set beside a line, at the size of a line: the one thing in a reel that is not type. */
.icon { font-size: ${type.icon}px; line-height: 1; }
/* A call to action is a line and the place to go, set apart from it the way a button is. */
.frame--cta { justify-content: center; align-items: flex-start; }
.cta { display: inline-flex; align-items: center; gap: calc(22px * var(--s)); padding: calc(20px * var(--t)) calc(38px * var(--t));
  border-radius: 999px; background: ${paint.signal}; color: ${lightOf(paint.signal) > 0.55 ? '#14181D' : '#FFFFFF'};
  font-size: ${type.cta}px; font-weight: 640; letter-spacing: -0.01em; }
/* A logo sting is the wordmark alone on the ground, with one measured line drawing itself under it. */
.frame--logo { justify-content: center; align-items: center; padding-bottom: var(--margin); }
.logo { font-family: ${display}; font-size: ${Math.max(type.heading, Math.round(104 * scale))}px; line-height: 1; letter-spacing: -0.03em; font-weight: ${style.shout ? 400 : 700}; text-align: center; }
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
.side p.body { max-width: none; font-size: ${type.sideBody}px; line-height: 1.24; font-weight: 500; }
.side .label { font-size: ${type.sideLabel}px; }
/* A chart: the one graphic a film of numbers actually needs, drawn in the page so every frame of it is drawn
   rather than resampled. Horizontal bars, because a horizontal bar works on a phone held upright and a column
   chart does not: the label reads along the line rather than under it, and the figure sits at the end where the
   eye already is. Nothing here is a picture of a chart — a picture model cannot draw one, and a film that asks
   for one gets fake lettering. */
.chart { display: flex; flex-direction: column; gap: calc(var(--margin) * 0.38); width: 100%; }
/* The label and the figure sit on a line of their own above the bar, and the bar gets the whole width. Side by
   side they do not: a display figure is fifty pixels tall on a phone, so a value column wide enough to hold one
   leaves the bar a third of the frame and every bar reads as the same short pill. */
.chart__row { display: flex; flex-direction: column; gap: calc(var(--margin) * 0.14); width: 100%; }
.chart__head { display: flex; align-items: baseline; justify-content: space-between; gap: calc(var(--margin) * 0.3); }
.chart__name { font-size: ${type.body}px; line-height: 1.15; font-weight: 540; letter-spacing: -0.012em; }
.chart__track { position: relative; width: 100%; height: ${Math.round(type.body * 0.72)}px; border-radius: 999px;
  background: rgba(${paint.scrim}, 0.62); overflow: hidden; }
.chart__fill { position: absolute; inset: 0; transform-origin: 0% 50%; border-radius: 999px;
  background: ${sketch ? paint.ink : paint.signal}; }
/* The bar is the accent and the figure is information, so the figure is set in the ink. Set in the accent too it
   was the same colour as the thing it labelled and, over a background carrying that accent, the render's own
   contrast check measured it at 2.89 against a floor of 3. */
.chart__value { flex: none; font-family: ${display};
  font-size: ${type.step}px; line-height: 1; font-weight: ${style.shout ? 400 : 700}; letter-spacing: -0.02em;
  color: ${paint.ink}; font-variant-numeric: tabular-nums; }
/* A checklist is a list that says yes, so each line carries a mark rather than a bar. */
.mark { flex: none; position: relative; top: 0.06em; width: ${type.mark}px; height: ${type.mark}px; color: ${sketch ? paint.ink : paint.signal}; }
.mark svg { display: block; width: 100%; height: 100%; }
.list--check li { align-items: flex-start; gap: calc(26px * var(--s)); }
/* Steps are numbered, and the number is the structure: it is set in the signal colour and held to one width. */
.step { flex: none; font-size: ${type.step}px; font-weight: 700; line-height: 1.1; color: ${sketch ? paint.ink : paint.signal};
  font-variant-numeric: tabular-nums; min-width: 1.6em; }
.list--steps li { align-items: baseline; gap: calc(26px * var(--s)); }
/* A screenshot in the thing it was taken on, and the thing it was taken on is the scene: the mockup takes most of
   the frame's width, its words sit over it on a chip rather than under it in a caption, and the shot pushes slowly
   into the screen so a still page has somewhere to go. The mockups are drawn here, in the page, so nothing is
   fetched and every frame of the push is drawn rather than resampled.
   The variable --devroom is the height the frame needs for all that is not the device; captions claim their own. */
:root { --devroom: calc(78px + var(--safe-top) + var(--safe-foot)); }
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
.chip { position: absolute; bottom: calc(var(--margin) * 0.5 + var(--safe-foot)); left: calc(var(--margin) * 0.62); z-index: 5;
  padding: calc(10px * var(--t)) calc(20px * var(--t)); border-radius: 999px;
  background: rgba(${paint.scrim}, ${sketch ? '0.86' : '0.82'}); backdrop-filter: blur(calc(8px * var(--s)));
  border: 1px solid ${paint.quiet}44; color: ${paint.ink};
  font-size: ${type.chip}px; font-weight: 600; letter-spacing: -0.008em; max-width: 72%; }
#root.has-captions .chip { top: calc(var(--margin) * 0.55 + var(--safe-top)); bottom: auto; }
/* A person talking to camera, or a generated clip, fills the frame and takes the words over it. */
.frame--presenter { justify-content: flex-end; padding: 0; gap: 0; }
.presenter { position: absolute; inset: 0; overflow: hidden; z-index: 1; }
.presenter img, .presenter video { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 30%; transform-origin: 50% 30%; }

/* How far through the film a viewer is, drawn as one hairline across the foot of the frame. A reel earns this: it is
   the one thing that makes somebody stay for the last two seconds. */
.progress { position: absolute; left: 0; bottom: var(--safe-foot); height: calc(7px * var(--s)); width: 100%; z-index: 9;
  transform-origin: 0 50%; background: ${paint.signal}; opacity: 0.92; }

/* The captions: the line being said, word by word, held off the bottom edge by more than it looks like it needs —
   on a phone the last fifth of the frame belongs to the player, the poster's own furniture and the thumb. */
.caps { position: absolute; left: var(--margin); right: calc(var(--margin) + var(--safe-right)); bottom: var(--caps); z-index: 6; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; pointer-events: none; }
.capline { position: absolute; bottom: 0; left: 0; right: 0; display: flex; flex-wrap: nowrap; gap: 0 calc(14px * var(--s));
  align-items: baseline; justify-content: center; text-align: center; white-space: nowrap; }
/* The size is the whole of why captions work, and it was wrong: a tenth to a seventh of the frame's height, set in
   the display face, in capitals, with a real black stroke around it rather than a soft shadow. The old 58px on a
   1280-high frame was four and a half per cent — a subtitle, read rather than watched, and invisible at the size a
   feed thumbnail is. paint-order puts the stroke behind the letterform so it thickens the outline instead of
   eating the inside of the type. */
.capline { font-size: calc(${Math.round(height * 0.108)}px * var(--s)); }
.capword { font-family: ${display}; font-size: inherit; line-height: 1.04; font-weight: ${style.shout ? 400 : 800}; letter-spacing: -0.02em;
  color: ${paint.ink}; text-transform: uppercase; padding: calc(2px * var(--s)) 0;
  -webkit-text-stroke: calc(${Math.max(3, Math.round(height * 0.0045))}px * var(--s)) #000000; paint-order: stroke fill;
  text-shadow: 0 calc(3px * var(--s)) calc(16px * var(--s)) rgba(0, 0, 0, 0.55); }
.capword.pop { color: ${sketch ? paint.ink : paint.signal}; }
`.trim();
}

